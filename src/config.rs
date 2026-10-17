use serde::{Deserialize, Serialize};
use std::fs;

use crate::paths;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub search: SearchConfig,
    pub hooks: HookConfig,
    pub harvest: HarvestConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchConfig {
    pub dedupe_threshold: f32,
    pub replace_threshold: f32,
    pub similar_threshold: f32,
    pub similar_neighbors: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HookConfig {
    pub rules_tokens: usize,
    pub prompt_tokens: usize,
    pub prompt_max: usize,
    pub prompt_min_chars: usize,
    pub prompt_threshold: f32,
    pub prompt_margin: f32,
    pub prompt_lexical_threshold: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HarvestConfig {
    pub enabled: bool,
    pub model: String,
    pub max_chars: usize,
    pub min_chars: usize,
    pub max_items: usize,
    pub timeout_seconds: u64,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self { dedupe_threshold: 0.94, replace_threshold: 0.97, similar_threshold: 0.91, similar_neighbors: 5 }
    }
}

impl Default for HookConfig {
    fn default() -> Self {
        Self {
            rules_tokens: 300,
            prompt_tokens: 150,
            prompt_max: 3,
            prompt_min_chars: 20,
            prompt_threshold: 0.84,
            prompt_margin: 0.03,
            prompt_lexical_threshold: 0.75,
        }
    }
}

impl Default for HarvestConfig {
    fn default() -> Self {
        Self { enabled: true, model: "haiku".into(), max_chars: 40_000, min_chars: 600, max_items: 8, timeout_seconds: 240 }
    }
}

impl Config {
    pub fn load() -> Self {
        fs::read_to_string(paths::config_path()).ok().and_then(|raw| toml::from_str(&raw).ok()).unwrap_or_default()
    }

    pub fn render_default() -> String {
        toml::to_string_pretty(&Config::default()).unwrap_or_default()
    }
}
