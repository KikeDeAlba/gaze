use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
pub const SERVER_READ_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_LINE: u64 = 1024 * 1024;

pub fn pipe_name(endpoint: &Path) -> String {
    let raw = endpoint.to_string_lossy();
    if raw.starts_with(r"\\.\pipe\") {
        return raw.into_owned();
    }
    let slug: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    format!(r"\\.\pipe\gaze-{}", slug.trim_matches('-'))
}

pub fn read_line_capped<R: BufRead>(reader: &mut R, line: &mut String) -> io::Result<usize> {
    let read = reader.by_ref().take(MAX_LINE + 1).read_line(line)?;
    if read as u64 > MAX_LINE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("line over {MAX_LINE} bytes")));
    }
    Ok(read)
}

fn exchange<S: Read + Write>(stream: S, line: &[u8]) -> io::Result<String> {
    let mut reader = BufReader::new(stream);
    reader.get_mut().write_all(line)?;
    reader.get_mut().flush()?;
    let mut response = String::new();
    read_line_capped(&mut reader, &mut response)?;
    Ok(response)
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub type Stream = UnixStream;

    pub struct Listener(UnixListener);

    pub fn alive(endpoint: &Path) -> bool {
        UnixStream::connect(endpoint).is_ok()
    }

    pub fn connect(endpoint: &Path, timeout: Duration) -> io::Result<Stream> {
        let stream = UnixStream::connect(endpoint)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        Ok(stream)
    }

    pub fn request(endpoint: &Path, line: &[u8], timeout: Duration) -> io::Result<String> {
        exchange(connect(endpoint, timeout)?, line)
    }

    pub fn bind(endpoint: &Path) -> io::Result<Listener> {
        if let Some(parent) = endpoint.parent().filter(|p| !p.as_os_str().is_empty()) {
            let fresh = !parent.exists();
            std::fs::create_dir_all(parent)?;
            if fresh || parent == crate::paths::data_dir() {
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        if endpoint.exists() {
            std::fs::remove_file(endpoint)?;
        }
        let listener = UnixListener::bind(endpoint)?;
        std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;
        Ok(Listener(listener))
    }

    impl Listener {
        pub fn accept(&self) -> io::Result<Stream> {
            let (stream, _) = self.0.accept()?;
            stream.set_read_timeout(Some(SERVER_READ_TIMEOUT))?;
            Ok(stream)
        }
    }

    pub fn cleanup(endpoint: &Path) {
        let _ = std::fs::remove_file(endpoint);
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use interprocess::os::windows::named_pipe::{DuplexPipeStream, PipeListener, PipeListenerOptions, pipe_mode};
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use std::fs::File;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::sync::mpsc;
    use std::time::Instant;
    use widestring::U16CString;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{EqualSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
    use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    pub type Stream = File;

    pub struct Listener(PipeListener<pipe_mode::Bytes, pipe_mode::Bytes>);

    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_PIPE_BUSY: i32 = 231;

    struct TokenSid(Vec<u64>);

    impl TokenSid {
        fn of_process(process: HANDLE) -> io::Result<Self> {
            let mut token: HANDLE = std::ptr::null_mut();
            if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut needed = 0u32;
            unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
            let ok = unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), (buffer.len() * 8) as u32, &mut needed) };
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(token) };
            if ok == 0 {
                return Err(error);
            }
            Ok(Self(buffer))
        }

        fn current() -> io::Result<Self> {
            Self::of_process(unsafe { GetCurrentProcess() })
        }

        fn sid(&self) -> *mut core::ffi::c_void {
            unsafe { (*(self.0.as_ptr() as *const TOKEN_USER)).User.Sid }
        }

        fn to_sddl(&self) -> io::Result<String> {
            let mut raw: *mut u16 = std::ptr::null_mut();
            if unsafe { ConvertSidToStringSidW(self.sid(), &mut raw) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let text = unsafe { widestring::U16CStr::from_ptr_str(raw) }.to_string_lossy();
            unsafe { LocalFree(raw.cast()) };
            Ok(text)
        }

        fn same_as(&self, other: &TokenSid) -> bool {
            unsafe { EqualSid(self.sid(), other.sid()) != 0 }
        }
    }

    fn server_is_ours(file: &File) -> io::Result<bool> {
        let mut pid = 0u32;
        if unsafe { GetNamedPipeServerProcessId(file.as_raw_handle() as HANDLE, &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let server = TokenSid::of_process(process);
        unsafe { CloseHandle(process) };
        Ok(server?.same_as(&TokenSid::current()?))
    }

    fn open(name: &str) -> io::Result<File> {
        std::fs::OpenOptions::new().read(true).write(true).security_qos_flags(SECURITY_IDENTIFICATION).open(name)
    }

    pub fn connect(endpoint: &Path, timeout: Duration) -> io::Result<Stream> {
        let name = pipe_name(endpoint);
        let wide = U16CString::from_str(&name).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let deadline = Instant::now() + timeout.min(CONNECT_TIMEOUT);
        let file = loop {
            match open(&name) {
                Ok(file) => break file,
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() || unsafe { WaitNamedPipeW(wide.as_ptr(), left.as_millis().max(1) as u32) } == 0 {
                        return Err(io::Error::new(io::ErrorKind::TimedOut, format!("{name} is busy")));
                    }
                }
                Err(error) => return Err(error),
            }
        };
        if !server_is_ours(&file)? {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{name} is served by a process of another user; refusing to talk to it")));
        }
        Ok(file)
    }

    pub fn alive(endpoint: &Path) -> bool {
        match connect(endpoint, Duration::from_millis(200)) {
            Ok(_) => true,
            Err(error) => error.kind() == io::ErrorKind::TimedOut,
        }
    }

    pub fn request(endpoint: &Path, line: &[u8], timeout: Duration) -> io::Result<String> {
        let endpoint = endpoint.to_path_buf();
        let line = line.to_vec();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(connect(&endpoint, timeout).and_then(|stream| exchange(stream, &line)));
        });
        receiver.recv_timeout(timeout).map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "named pipe request timed out"))?
    }

    pub fn sddl_for(user_sid: &str) -> String {
        format!("D:P(A;;GA;;;SY)(A;;GA;;;{user_sid})")
    }

    pub fn bind(endpoint: &Path) -> io::Result<Listener> {
        let name = pipe_name(endpoint);
        let sddl = U16CString::from_str(sddl_for(&TokenSid::current()?.to_sddl()?)).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let mut options = PipeListenerOptions::new().path(name.as_str()).accept_remote(false);
        options.security_descriptor = Some(SecurityDescriptor::deserialize(&sddl)?);
        options.create_duplex::<pipe_mode::Bytes>().map(Listener).map_err(|error| match error.raw_os_error() {
            Some(ERROR_ACCESS_DENIED) | Some(ERROR_PIPE_BUSY) => io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("{name} already exists and belongs to another process; stop it or set GAZE_SOCKET to another pipe name"),
            ),
            _ => error,
        })
    }

    impl Listener {
        pub fn accept(&self) -> io::Result<DuplexPipeStream<pipe_mode::Bytes>> {
            self.0.accept()
        }
    }

    pub fn cleanup(_endpoint: &Path) {}
}

pub use imp::{Listener, Stream, alive, bind, cleanup, connect, request};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_stable_and_prefixed() {
        assert_eq!(pipe_name(Path::new(r"\\.\pipe\gaze-kike")), r"\\.\pipe\gaze-kike");
        assert_eq!(pipe_name(Path::new(r"C:\Users\Kike\gaze.sock")), r"\\.\pipe\gaze-c--users-kike-gaze-sock");
    }

    #[test]
    fn lines_over_the_cap_are_rejected() {
        let big = vec![b'a'; MAX_LINE as usize + 10];
        let mut reader = BufReader::new(&big[..]);
        let mut line = String::new();
        assert_eq!(read_line_capped(&mut reader, &mut line).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let mut ok = BufReader::new(&b"hola\nmundo\n"[..]);
        let mut first = String::new();
        read_line_capped(&mut ok, &mut first).unwrap();
        assert_eq!(first, "hola\n");
    }

    #[cfg(unix)]
    #[test]
    fn round_trips_a_line_over_a_private_socket() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let endpoint = dir.path().join("run/t.sock");
        let listener = bind(&endpoint).unwrap();
        drop(listener);
        std::fs::remove_file(&endpoint).unwrap();
        std::fs::write(&endpoint, b"stale").unwrap();
        let listener = bind(&endpoint).unwrap();
        assert_eq!(std::fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(endpoint.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        let server = std::thread::spawn(move || {
            let stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            read_line_capped(&mut reader, &mut line).unwrap();
            reader.get_mut().write_all(format!("echo {line}").as_bytes()).unwrap();
        });
        let response = request(&endpoint, b"hola\n", Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        assert_eq!(response, "echo hola\n");
        assert!(!alive(&dir.path().join("missing.sock")));
        cleanup(&endpoint);
        assert!(!endpoint.exists());
    }
}
