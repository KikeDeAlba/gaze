use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::paths;

pub const DIMS: usize = 384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Query,
    Passage,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Query => "query",
            Mode::Passage => "passage",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value == "query" { Mode::Query } else { Mode::Passage }
    }
}

pub trait Embedder: Send + Sync {
    fn embed(&self, texts: &[String], mode: Mode) -> Result<Vec<Vec<f32>>>;
}

pub fn prefixed(text: &str, mode: Mode) -> String {
    format!("{}: {}", mode.as_str(), text)
}

pub fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    v
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_blob(bytes: &[u8]) -> Vec<f32> {
    bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect()
}

pub struct FakeEmbedder;

impl Embedder for FakeEmbedder {
    fn embed(&self, texts: &[String], _mode: Mode) -> Result<Vec<Vec<f32>>> {
        Ok(texts
            .iter()
            .map(|text| {
                let mut v = vec![0f32; DIMS];
                for term in crate::text::terms(text) {
                    let mut h: u64 = 1469598103934665603;
                    for b in term.bytes() {
                        h ^= b as u64;
                        h = h.wrapping_mul(1099511628211);
                    }
                    v[(h % DIMS as u64) as usize] += 1.0;
                }
                v[DIMS - 1] += 0.01;
                normalize(v)
            })
            .collect())
    }
}

pub struct LocalModel {
    model: Mutex<fastembed::TextEmbedding>,
}

impl LocalModel {
    pub fn load() -> Result<Self> {
        let cache = paths::cache_dir().join("models");
        std::fs::create_dir_all(&cache).ok();
        let options = fastembed::TextInitOptions::new(fastembed::EmbeddingModel::MultilingualE5Small).with_cache_dir(cache).with_show_download_progress(false);
        let model = fastembed::TextEmbedding::try_new(options).map_err(|e| anyhow!("model load failed: {e}"))?;
        Ok(Self { model: Mutex::new(model) })
    }
}

impl Embedder for LocalModel {
    fn embed(&self, texts: &[String], mode: Mode) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let inputs: Vec<String> = texts.iter().map(|t| prefixed(t, mode)).collect();
        let mut model = self.model.lock().map_err(|_| anyhow!("model lock poisoned"))?;
        let out = model.embed(&inputs, Some(32)).map_err(|e| anyhow!("embedding failed: {e}"))?;
        Ok(out.into_iter().map(normalize).collect())
    }
}

pub fn socket_alive(path: &Path) -> bool {
    crate::ipc::alive(path)
}

pub fn socket_request(path: &Path, request: &Value, timeout: Duration) -> Result<Value> {
    let mut line = serde_json::to_vec(request)?;
    line.push(b'\n');
    let response = crate::ipc::request(path, &line, timeout).with_context(|| format!("connect {}", path.display()))?;
    let value: Value = serde_json::from_str(&response).context("daemon response")?;
    if value["ok"] != json!(true) {
        return Err(anyhow!("daemon error: {}", value["error"].as_str().unwrap_or("unknown")));
    }
    Ok(value)
}

pub const SOCKET_BATCH: usize = 32;

pub struct SocketEmbedder {
    pub path: PathBuf,
    pub timeout: Duration,
}

impl Embedder for SocketEmbedder {
    fn embed(&self, texts: &[String], mode: Mode) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut vectors = Vec::with_capacity(texts.len());
        for batch in texts.chunks(SOCKET_BATCH) {
            let response = socket_request(&self.path, &json!({"op": "embed", "mode": mode.as_str(), "texts": batch}), self.timeout)?;
            let got: Vec<Vec<f32>> = serde_json::from_value(response["vectors"].clone())?;
            if got.len() != batch.len() {
                return Err(anyhow!("daemon returned {} vectors for {} texts", got.len(), batch.len()));
            }
            vectors.extend(got);
        }
        Ok(vectors)
    }
}

pub struct AutoEmbedder {
    socket: PathBuf,
    allow_local: bool,
    timeout: Duration,
    local: OnceLock<std::result::Result<LocalModel, String>>,
}

impl AutoEmbedder {
    pub fn new(allow_local: bool) -> Self {
        Self { socket: paths::socket_path(), allow_local, timeout: Duration::from_secs(120), local: OnceLock::new() }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

pub fn fake_requested() -> bool {
    std::env::var("GAZE_EMBEDDER").map(|v| v == "fake").unwrap_or(false)
}

impl Embedder for AutoEmbedder {
    fn embed(&self, texts: &[String], mode: Mode) -> Result<Vec<Vec<f32>>> {
        if fake_requested() {
            return FakeEmbedder.embed(texts, mode);
        }
        if let Some(Ok(local)) = self.local.get() {
            return local.embed(texts, mode);
        }
        let remote = SocketEmbedder { path: self.socket.clone(), timeout: self.timeout };
        match remote.embed(texts, mode) {
            Ok(v) => Ok(v),
            Err(socket_error) => {
                if !self.allow_local {
                    return Err(socket_error);
                }
                match self.local.get_or_init(|| LocalModel::load().map_err(|e| format!("{e:#}"))) {
                    Ok(local) => local.embed(texts, mode),
                    Err(message) => Err(anyhow!("{message}")),
                }
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn socket_embedder_sends_batches_of_32() {
        use std::io::{BufReader, Write};
        let dir = tempfile::tempdir().unwrap();
        let endpoint = dir.path().join("e.sock");
        let listener = crate::ipc::bind(&endpoint).unwrap();
        let server = std::thread::spawn(move || {
            let mut sizes = Vec::new();
            for _ in 0..3 {
                let stream = listener.accept().unwrap();
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                crate::ipc::read_line_capped(&mut reader, &mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                let count = request["texts"].as_array().unwrap().len();
                sizes.push(count);
                let vectors = vec![vec![0.5f32; 4]; count];
                reader.get_mut().write_all(format!("{}\n", json!({"ok": true, "vectors": vectors})).as_bytes()).unwrap();
            }
            sizes
        });
        let texts: Vec<String> = (0..70).map(|i| format!("t{i}")).collect();
        let vectors = SocketEmbedder { path: endpoint, timeout: Duration::from_secs(5) }.embed(&texts, Mode::Passage).unwrap();
        assert_eq!(vectors.len(), 70);
        assert_eq!(server.join().unwrap(), [32, 32, 6]);
    }
}
