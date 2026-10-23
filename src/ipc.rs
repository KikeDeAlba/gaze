use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);

pub fn pipe_name(endpoint: &Path) -> String {
    let raw = endpoint.to_string_lossy();
    if raw.starts_with(r"\\.\pipe\") {
        return raw.into_owned();
    }
    let slug: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    format!(r"\\.\pipe\gaze-{}", slug.trim_matches('-'))
}

fn exchange<S: Read + Write>(stream: S, line: &[u8]) -> io::Result<String> {
    let mut reader = BufReader::new(stream);
    reader.get_mut().write_all(line)?;
    reader.get_mut().flush()?;
    let mut response = String::new();
    reader.read_line(&mut response)?;
    Ok(response)
}

#[cfg(unix)]
mod imp {
    use super::*;
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
        if let Some(parent) = endpoint.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if endpoint.exists() {
            std::fs::remove_file(endpoint)?;
        }
        UnixListener::bind(endpoint).map(Listener)
    }

    impl Listener {
        pub fn accept(&self) -> io::Result<Stream> {
            self.0.accept().map(|(stream, _)| stream)
        }
    }

    pub fn cleanup(endpoint: &Path) {
        let _ = std::fs::remove_file(endpoint);
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use interprocess::ConnectWaitMode;
    use interprocess::os::windows::named_pipe::{DuplexPipeStream, PipeListener, PipeListenerOptions, pipe_mode};
    use std::sync::mpsc;

    pub type Stream = DuplexPipeStream<pipe_mode::Bytes>;

    pub struct Listener(PipeListener<pipe_mode::Bytes, pipe_mode::Bytes>);

    const ERROR_PIPE_BUSY: i32 = 231;

    pub fn alive(endpoint: &Path) -> bool {
        match Stream::connect_by_path_with_wait_mode(pipe_name(endpoint).as_str(), ConnectWaitMode::Timeout(Duration::from_millis(200))) {
            Ok(_) => true,
            Err(error) => error.raw_os_error() == Some(ERROR_PIPE_BUSY),
        }
    }

    pub fn connect(endpoint: &Path, timeout: Duration) -> io::Result<Stream> {
        Stream::connect_by_path_with_wait_mode(pipe_name(endpoint).as_str(), ConnectWaitMode::Timeout(timeout.min(CONNECT_TIMEOUT)))
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

    pub fn bind(endpoint: &Path) -> io::Result<Listener> {
        let name = pipe_name(endpoint);
        PipeListenerOptions::new().path(name.as_str()).accept_remote(false).create_duplex::<pipe_mode::Bytes>().map(Listener)
    }

    impl Listener {
        pub fn accept(&self) -> io::Result<Stream> {
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

    #[cfg(unix)]
    #[test]
    fn round_trips_a_line_over_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let endpoint = dir.path().join("t.sock");
        std::fs::write(&endpoint, b"stale").unwrap();
        let listener = bind(&endpoint).unwrap();
        let server = std::thread::spawn(move || {
            let stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
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
