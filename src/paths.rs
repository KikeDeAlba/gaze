use std::env;
use std::path::PathBuf;

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

pub struct Dirs<F: Fn(&str) -> Option<PathBuf>> {
    pub windows: bool,
    pub var: F,
}

impl<F: Fn(&str) -> Option<PathBuf>> Dirs<F> {
    pub fn home(&self) -> PathBuf {
        (self.var)("HOME").or_else(|| (self.var)("USERPROFILE")).unwrap_or_else(|| PathBuf::from(if self.windows { r"C:\" } else { "/" }))
    }

    pub fn config_home(&self) -> PathBuf {
        if self.windows {
            return (self.var)("APPDATA").unwrap_or_else(|| self.home().join("AppData").join("Roaming"));
        }
        (self.var)("XDG_CONFIG_HOME").unwrap_or_else(|| self.home().join(".config"))
    }

    pub fn data_home(&self) -> PathBuf {
        if self.windows {
            return (self.var)("LOCALAPPDATA").unwrap_or_else(|| self.home().join("AppData").join("Local"));
        }
        (self.var)("XDG_DATA_HOME").unwrap_or_else(|| self.home().join(".local").join("share"))
    }

    pub fn cache_home(&self) -> PathBuf {
        if self.windows {
            return self.data_home().join("gaze").join("cache");
        }
        (self.var)("XDG_CACHE_HOME").unwrap_or_else(|| self.home().join(".cache")).join("gaze")
    }
}

fn dirs() -> Dirs<fn(&str) -> Option<PathBuf>> {
    Dirs { windows: cfg!(windows), var: env_path }
}

pub fn home() -> PathBuf {
    dirs().home()
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = env_path("GAZE_DATA_DIR") {
        return dir;
    }
    if let Some(db) = env_path("GAZE_DB_PATH")
        && let Some(parent) = db.parent()
    {
        return parent.to_path_buf();
    }
    dirs().data_home().join("gaze")
}

pub fn db_path() -> PathBuf {
    env_path("GAZE_DB_PATH").unwrap_or_else(|| data_dir().join("gaze.db"))
}

pub fn default_pipe(user: Option<String>) -> PathBuf {
    let user: String = user.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    PathBuf::from(if user.is_empty() { r"\\.\pipe\gaze".to_string() } else { format!(r"\\.\pipe\gaze-{}", user.to_ascii_lowercase()) })
}

pub fn socket_path() -> PathBuf {
    if let Some(path) = env_path("GAZE_SOCKET") {
        return path;
    }
    if cfg!(windows) {
        return default_pipe(env::var("USERNAME").ok());
    }
    data_dir().join("gaze.sock")
}

pub fn config_dir() -> PathBuf {
    dirs().config_home()
}

pub fn config_path() -> PathBuf {
    env_path("GAZE_CONFIG").unwrap_or_else(|| config_dir().join("gaze").join("config.toml"))
}

pub fn cache_dir() -> PathBuf {
    env_path("GAZE_CACHE_DIR").unwrap_or_else(|| dirs().cache_home())
}

pub fn harvest_log() -> PathBuf {
    data_dir().join("harvest.log")
}

pub fn serve_log() -> PathBuf {
    data_dir().join("serve.log")
}

pub fn registry_dir() -> PathBuf {
    env_path("KIT_REGISTRY_DIR").unwrap_or_else(|| config_dir().join("kikedealba").join("tools.d"))
}

pub fn bita_config() -> PathBuf {
    env_path("BITA_CONFIG_PATH").unwrap_or_else(|| config_dir().join("bita").join("config.json"))
}

fn inkwell_dir() -> PathBuf {
    if cfg!(windows) { dirs().data_home().join("inkwell") } else { home().join(".local").join("share").join("inkwell") }
}

pub fn inkwell_docs() -> PathBuf {
    env_path("INKWELL_DOCS_DIR").unwrap_or_else(|| inkwell_dir().join("docs"))
}

pub fn inkwell_db() -> PathBuf {
    env_path("INKWELL_DB_PATH").unwrap_or_else(|| inkwell_dir().join("inkwell.db"))
}

pub fn claude_projects() -> PathBuf {
    home().join(".claude").join("projects")
}

pub fn launch_agent() -> PathBuf {
    home().join("Library/LaunchAgents").join(format!("{}.plist", crate::daemon::LABEL))
}

pub fn systemd_unit() -> PathBuf {
    config_dir().join("systemd").join("user").join(crate::daemon::SYSTEMD_UNIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(windows: bool, vars: &[(&str, &str)]) -> Dirs<impl Fn(&str) -> Option<PathBuf>> {
        let map: HashMap<String, PathBuf> = vars.iter().map(|(k, v)| (k.to_string(), PathBuf::from(v))).collect();
        Dirs { windows, var: move |name: &str| map.get(name).cloned() }
    }

    #[test]
    fn home_falls_back_to_userprofile() {
        assert_eq!(with(true, &[("USERPROFILE", r"C:\Users\kike")]).home(), PathBuf::from(r"C:\Users\kike"));
        assert_eq!(with(false, &[("HOME", "/home/kike"), ("USERPROFILE", "x")]).home(), PathBuf::from("/home/kike"));
    }

    #[test]
    fn windows_uses_appdata_and_localappdata() {
        let dirs = with(true, &[("USERPROFILE", r"C:\Users\kike"), ("APPDATA", r"C:\Roaming"), ("LOCALAPPDATA", r"C:\Local"), ("XDG_CONFIG_HOME", "/x")]);
        assert_eq!(dirs.config_home(), PathBuf::from(r"C:\Roaming"));
        assert_eq!(dirs.data_home(), PathBuf::from(r"C:\Local"));
        assert_eq!(dirs.cache_home(), PathBuf::from(r"C:\Local").join("gaze").join("cache"));
        let bare = with(true, &[("USERPROFILE", r"C:\Users\kike")]);
        assert_eq!(bare.config_home(), PathBuf::from(r"C:\Users\kike").join("AppData").join("Roaming"));
        assert_eq!(bare.data_home(), PathBuf::from(r"C:\Users\kike").join("AppData").join("Local"));
    }

    #[test]
    fn unix_honours_xdg() {
        let dirs = with(false, &[("HOME", "/home/kike"), ("XDG_DATA_HOME", "/data"), ("APPDATA", "/nope")]);
        assert_eq!(dirs.data_home(), PathBuf::from("/data"));
        assert_eq!(dirs.config_home(), PathBuf::from("/home/kike/.config"));
        assert_eq!(dirs.cache_home(), PathBuf::from("/home/kike/.cache/gaze"));
    }

    #[test]
    fn pipe_name_is_per_user() {
        assert_eq!(default_pipe(Some("Kike Alba".into())), PathBuf::from(r"\\.\pipe\gaze-kikealba"));
        assert_eq!(default_pipe(None), PathBuf::from(r"\\.\pipe\gaze"));
    }
}
