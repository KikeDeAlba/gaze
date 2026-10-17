use std::env;
use std::path::PathBuf;

pub fn home() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
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
    env_path("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local/share")).join("gaze")
}

pub fn db_path() -> PathBuf {
    env_path("GAZE_DB_PATH").unwrap_or_else(|| data_dir().join("gaze.db"))
}

pub fn socket_path() -> PathBuf {
    env_path("GAZE_SOCKET").unwrap_or_else(|| data_dir().join("gaze.sock"))
}

pub fn config_dir() -> PathBuf {
    env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config"))
}

pub fn config_path() -> PathBuf {
    env_path("GAZE_CONFIG").unwrap_or_else(|| config_dir().join("gaze/config.toml"))
}

pub fn cache_dir() -> PathBuf {
    env_path("GAZE_CACHE_DIR").unwrap_or_else(|| env_path("XDG_CACHE_HOME").unwrap_or_else(|| home().join(".cache")).join("gaze"))
}

pub fn harvest_log() -> PathBuf {
    data_dir().join("harvest.log")
}

pub fn serve_log() -> PathBuf {
    data_dir().join("serve.log")
}

pub fn registry_dir() -> PathBuf {
    env_path("KIT_REGISTRY_DIR").unwrap_or_else(|| config_dir().join("kikedealba/tools.d"))
}

pub fn bita_config() -> PathBuf {
    env_path("BITA_CONFIG_PATH").unwrap_or_else(|| config_dir().join("bita/config.json"))
}

pub fn inkwell_docs() -> PathBuf {
    env_path("INKWELL_DOCS_DIR").unwrap_or_else(|| home().join(".local/share/inkwell/docs"))
}

pub fn inkwell_db() -> PathBuf {
    env_path("INKWELL_DB_PATH").unwrap_or_else(|| home().join(".local/share/inkwell/inkwell.db"))
}

pub fn claude_projects() -> PathBuf {
    home().join(".claude/projects")
}

pub fn launch_agent() -> PathBuf {
    home().join("Library/LaunchAgents").join(format!("{}.plist", crate::daemon::LABEL))
}
