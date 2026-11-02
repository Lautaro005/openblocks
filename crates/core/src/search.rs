//! Full-text search over the in-memory index. Every term has to match (title, text or tags);
//! titles weigh more. On a laptop this answers in a few milliseconds for thousands of pages.

use serde_json::{json, Value};

use crate::vault::{snippet, stem, Vault};

pub fn search(v: &Vault, q: &str, limit: usize) -> Vec<Value> {
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return v.recent(limit);
    }
    let (tag_terms, terms): (Vec<String>, Vec<String>) = q
        .split_whitespace()
        .map(|s| s.to_string())
        .partition(|t| t.starts_with('#') && t.len() > 1);
    let idx = v.index.read().unwrap();
    let mut hits: Vec<(f32, Value)> = vec![];
    for (k, m) in &idx.notes {
        if !tag_terms.iter().all(|t| {
            m.tags
                .iter()
                .any(|x| x == &t[1..] || x.starts_with(&format!("{}/", &t[1..])))
        }) {
            continue;
        }
        let title = m.title.to_lowercase();
        let mut score = 0f32;
        let mut ok = true;
        for t in &terms {
            let in_title = title.contains(t.as_str());
            let n = m.text.matches(t.as_str()).count();
            if !in_title && n == 0 && !k.to_lowercase().contains(t.as_str()) {
                ok = false;
                break;
            }
            if title == *t {
                score += 40.0;
            } else if title.starts_with(t.as_str()) {
                score += 20.0;
            } else if in_title {
                score += 10.0;
            }
            score += (n as f32).ln_1p() * 2.0;
        }
        if !ok {
            continue;
        }
        if terms.is_empty() {
            score = 1.0;
        }
        // Recent pages first among equals.
        score += (m.mtime as f32 / 1e10).min(0.5);
        let first = terms.first().map(|s| s.as_str()).unwrap_or("");
        hits.push((
            score,
            json!({"path": k, "title": m.title, "kind": "page", "snippet": snippet(&m.text, first), "tags": m.tags}),
        ));
    }
    if tag_terms.is_empty() {
        for f in &idx.files {
            let name = f.rsplit('/').next().unwrap_or(f).to_lowercase();
            if !terms.is_empty() && terms.iter().all(|t| name.contains(t.as_str())) {
                hits.push((
                    5.0,
                    json!({"path": f, "title": stem(f), "kind": "file", "snippet": f}),
                ));
            }
        }
    }
    hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    hits.into_iter().take(limit).map(|(_, v)| v).collect()
}

/// Pages whose title starts with or contains `q`, for the `[[` suggestion and the quick switcher.
pub fn titles(v: &Vault, q: &str, limit: usize) -> Vec<Value> {
    let q = q.trim().to_lowercase();
    let idx = v.index.read().unwrap();
    let mut out: Vec<(u8, u64, Value)> = vec![];
    for (k, m) in &idx.notes {
        let t = m.title.to_lowercase();
        let rank = if q.is_empty() {
            2
        } else if t == q {
            0
        } else if t.starts_with(&q) {
            1
        } else if t.contains(&q) || k.to_lowercase().contains(&q) {
            2
        } else {
            continue;
        };
        out.push((
            rank,
            u64::MAX - m.mtime,
            json!({"path": k, "title": m.title, "kind": "page"}),
        ));
    }
    for f in &idx.files {
        let n = f.rsplit('/').next().unwrap_or(f).to_lowercase();
        if !q.is_empty() && n.contains(&q) {
            out.push((
                3,
                0,
                json!({"path": f, "title": f.rsplit('/').next().unwrap_or(f), "kind": "file"}),
            ));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out.into_iter().take(limit).map(|x| x.2).collect()
}
