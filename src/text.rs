use regex::Regex;
use std::collections::BTreeSet;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

pub const CHUNK_TOKENS: usize = 400;

static WIKILINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]").unwrap());
static ISSUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b([A-Z][A-Z0-9]+-\d+)\b").unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}_]+").unwrap());

const ISSUE_DENYLIST: [&str; 14] = ["UTF", "SHA", "AES", "ISO", "RFC", "HTTP", "TLS", "ES", "X", "MD", "P", "T", "GPT", "CVE"];

const STOPWORDS: &[&str] = &[
    "a", "al", "algo", "ante", "como", "con", "cual", "cuando", "de", "del", "desde", "donde", "el", "ella", "en", "entre", "es", "esa", "ese", "eso", "esta",
    "este", "esto", "estos", "fue", "ha", "hay", "la", "las", "le", "lo", "los", "mas", "me", "mi", "muy", "no", "nos", "o", "otra", "otro", "para", "pero",
    "por", "que", "se", "si", "sin", "sobre", "su", "sus", "tambien", "te", "tu", "un", "una", "uno", "y", "ya", "yo", "puedes", "hacer", "haz", "dame",
    "quiero", "the", "and", "for", "with", "this", "that", "from", "into", "what", "how", "why", "is", "are", "was", "be", "to", "of", "in", "on", "it", "an",
    "or", "as", "at", "by", "we", "you", "can", "do", "please",
];

pub fn estimate_tokens(text: &str) -> usize {
    (text.chars().count() * 2).div_ceil(7)
}

pub fn fold(value: &str) -> String {
    value.nfd().filter(|c| !is_combining_mark(*c)).collect::<String>().to_lowercase()
}

pub fn slugify(value: &str) -> String {
    let folded = fold(value);
    let mut out = String::with_capacity(folded.len());
    let mut dash = false;
    for c in folded.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

pub fn wikilinks(body: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    WIKILINK
        .captures_iter(body)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|t| !t.is_empty() && seen.insert(t.to_lowercase()))
        .collect()
}

pub fn issue_keys(text: &str) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for c in ISSUE.captures_iter(text) {
        let key = &c[1];
        let prefix = key.split('-').next().unwrap_or_default();
        if !ISSUE_DENYLIST.contains(&prefix) {
            keys.insert(key.to_string());
        }
    }
    keys.into_iter().collect()
}

pub fn terms(text: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    WORD.find_iter(&fold(text))
        .map(|m| m.as_str().to_string())
        .filter(|w| w.chars().count() >= 3 && !STOPWORDS.contains(&w.as_str()))
        .filter(|w| seen.insert(w.clone()))
        .collect()
}

pub fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    if let Some(space) = out.rfind(' ')
        && space > max / 2
    {
        out.truncate(space);
    }
    out.push('…');
    out
}

pub fn strip_markdown_line(line: &str) -> String {
    line.trim().trim_start_matches('#').trim_start_matches(['-', '*', '>']).trim().replace("**", "").replace('`', "")
}

pub fn derive_title(body: &str) -> String {
    let line = body.lines().map(strip_markdown_line).find(|l| !l.is_empty()).unwrap_or_default();
    let sentence = line.split(". ").next().unwrap_or(&line).to_string();
    truncate(&sentence, 80)
}

pub fn first_line_summary(body: &str, title: &str, max: usize) -> String {
    let folded_title = fold(title);
    let usable = |raw: &&str| {
        let t = raw.trim();
        !t.is_empty() && !t.starts_with('#') && !t.starts_with('|') && !t.starts_with("---") && !t.starts_with("```")
    };
    let line = body.lines().filter(usable).map(strip_markdown_line).find(|l| !l.is_empty() && fold(l) != folded_title).unwrap_or_default();
    truncate(&one_line(&line), max)
}

pub fn chunk(title: &str, body: &str) -> Vec<String> {
    let max_chars = CHUNK_TOKENS * 7 / 2;
    let mut pieces: Vec<String> = Vec::new();
    for paragraph in body.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if paragraph.chars().count() <= max_chars {
            pieces.push(paragraph.to_string());
            continue;
        }
        let mut current = String::new();
        for sentence in paragraph.split_inclusive(['.', '\n']) {
            if current.chars().count() + sentence.chars().count() > max_chars && !current.is_empty() {
                pieces.push(std::mem::take(&mut current));
            }
            if sentence.chars().count() > max_chars {
                let chars: Vec<char> = sentence.chars().collect();
                for window in chars.chunks(max_chars) {
                    pieces.push(window.iter().collect());
                }
            } else {
                current.push_str(sentence);
            }
        }
        if !current.trim().is_empty() {
            pieces.push(current);
        }
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut current = format!("{}\n\n", title.trim());
    let mut has_body = false;
    for piece in pieces {
        if has_body && current.chars().count() + piece.chars().count() + 2 > max_chars {
            chunks.push(current.trim().to_string());
            current = String::new();
            has_body = false;
        }
        if has_body {
            current.push_str("\n\n");
        }
        current.push_str(piece.trim());
        has_body = true;
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }
    chunks
}

pub fn snippet(text: &str, query_terms: &[String], max: usize) -> String {
    let flat = one_line(text);
    let folded = fold(&flat);
    let chars: Vec<char> = flat.chars().collect();
    let folded_chars: Vec<char> = folded.chars().collect();
    let hit = query_terms
        .iter()
        .filter_map(|t| {
            let byte = folded.find(t.as_str())?;
            Some(folded[..byte].chars().count())
        })
        .min();
    let start = match hit {
        Some(pos) if folded_chars.len() == chars.len() && pos > max / 4 => pos - max / 4,
        _ => 0,
    };
    let window: String = chars.iter().skip(start).collect();
    let prefix = if start > 0 { "…" } else { "" };
    truncate(&format!("{prefix}{window}"), max)
}

pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn short_id() -> String {
    let id = ulid::Ulid::new().to_string().to_lowercase();
    id[4..14].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_inkwell() {
        assert_eq!(slugify("Daily's"), "daily-s");
        assert_eq!(slugify("DP Personalization"), "dp-personalization");
        assert_eq!(slugify("Remediación de Seguridad 2026"), "remediacion-de-seguridad-2026");
    }

    #[test]
    fn wikilinks_are_unique_and_trimmed() {
        let links = wikilinks("ver [[Auth flow]] y [[auth flow|alias]] y [[ Deploy #sec ]] pero no [x]");
        assert_eq!(links, vec!["Auth flow", "Deploy"]);
    }

    #[test]
    fn issue_keys_skip_encodings() {
        assert_eq!(issue_keys("DD-1905 y UTF-8 y ZIP-16, SHA-256"), vec!["DD-1905", "ZIP-16"]);
    }

    #[test]
    fn chunks_respect_budget_and_carry_title() {
        let paragraph = "palabra ".repeat(300);
        let body = format!("{paragraph}\n\n{paragraph}\n\ncorto");
        let chunks = chunk("Titulo", &body);
        assert!(chunks.len() >= 2);
        assert!(chunks[0].starts_with("Titulo"));
        for c in &chunks {
            assert!(estimate_tokens(c) <= CHUNK_TOKENS + 10, "chunk too big: {}", estimate_tokens(c));
        }
        assert_eq!(chunk("Solo", "").len(), 1);
    }

    #[test]
    fn snippet_is_bounded_and_centered() {
        let text = format!("{} la base de datos usa postgres {}", "x ".repeat(200), "y ".repeat(200));
        let s = snippet(&text, &["postgres".into()], 200);
        assert!(s.chars().count() <= 200);
        assert!(s.contains("postgres"));
    }

    #[test]
    fn terms_drop_stopwords_and_accents() {
        assert_eq!(terms("¿Cómo se despliega la API de pagos?"), vec!["despliega", "api", "pagos"]);
    }
}
