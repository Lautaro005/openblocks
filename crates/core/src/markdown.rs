//! What OpenBlocks needs to know about a Markdown file without a full parser: the YAML frontmatter
//! (as page properties), `[[wikilinks]]` and `![[embeds]]`, `#tags`, and rewriting links when a page
//! moves. Everything stays Obsidian-compatible.

use serde_json::{Map, Value};

/// A note split in frontmatter and body.
#[derive(Debug, Clone, Default)]
pub struct Parsed {
    /// Properties in file order. Values are strings, numbers, booleans or lists of strings.
    pub props: Vec<(String, Value)>,
    /// The frontmatter text as it is in the file (without the `---` lines).
    pub raw_front: Option<String>,
    /// True when the frontmatter has structure we do not edit (nested maps): it is kept as is.
    pub complex: bool,
    pub body: String,
}

pub fn split(text: &str) -> Parsed {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut p = Parsed::default();
    let Some(rest) = t.strip_prefix("---") else {
        p.body = t.to_string();
        return p;
    };
    let rest = match rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
    {
        Some(r) => r,
        None => {
            p.body = t.to_string();
            return p;
        }
    };
    // Find the closing `---` line.
    let mut off = 0usize;
    let mut end = None;
    for line in rest.split_inclusive('\n') {
        let l = line.trim_end_matches(['\n', '\r']);
        if l == "---" || l == "..." {
            end = Some((off, off + line.len()));
            break;
        }
        off += line.len();
    }
    let Some((fm_end, body_start)) = end else {
        p.body = t.to_string();
        return p;
    };
    let fm = &rest[..fm_end];
    p.raw_front = Some(fm.to_string());
    let (props, complex) = parse_yaml(fm);
    p.props = props;
    p.complex = complex;
    let body = &rest[body_start..];
    p.body = body.strip_prefix('\n').unwrap_or(body).to_string();
    p
}

fn parse_scalar(v: &str) -> Value {
    let v = v.trim();
    if v.is_empty() || v == "~" || v == "null" {
        return Value::String(String::new());
    }
    if (v.starts_with('"') && v.ends_with('"') && v.len() >= 2)
        || (v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2)
    {
        if v.starts_with('"') {
            if let Ok(Value::String(s)) = serde_json::from_str::<Value>(v) {
                return Value::String(s);
            }
        }
        return Value::String(v[1..v.len() - 1].replace("''", "'"));
    }
    if v.starts_with('[') && v.ends_with(']') {
        let inner = &v[1..v.len() - 1];
        let items: Vec<Value> = split_inline_list(inner)
            .into_iter()
            .filter(|s| !s.is_empty())
            .map(|s| match parse_scalar(&s) {
                Value::String(s) => Value::String(s),
                other => Value::String(other.to_string()),
            })
            .collect();
        return Value::Array(items);
    }
    match v {
        "true" | "True" | "yes" => return Value::Bool(true),
        "false" | "False" | "no" => return Value::Bool(false),
        _ => {}
    }
    if let Ok(n) = v.parse::<i64>() {
        return Value::from(n);
    }
    if v.contains('.') {
        if let Ok(f) = v.parse::<f64>() {
            if f.is_finite() {
                return Value::from(f);
            }
        }
    }
    Value::String(v.to_string())
}

fn split_inline_list(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut q: Option<char> = None;
    for c in s.chars() {
        match (q, c) {
            (None, '"' | '\'') => {
                q = Some(c);
                cur.push(c)
            }
            (Some(x), c) if c == x => {
                q = None;
                cur.push(c)
            }
            (None, ',') => {
                out.push(cur.trim().to_string());
                cur.clear()
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// A flat YAML reader: `key: value`, inline lists and block lists. Anything else marks it complex.
fn parse_yaml(fm: &str) -> (Vec<(String, Value)>, bool) {
    let mut props: Vec<(String, Value)> = vec![];
    let mut complex = false;
    for line in fm.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let tl = line.trim();
        if indented || tl.starts_with("- ") || tl == "-" {
            if let Some(item) = tl
                .strip_prefix("- ")
                .or(if tl == "-" { Some("") } else { None })
            {
                if let Some((_, last)) = props.last_mut() {
                    let v = match parse_scalar(item) {
                        Value::String(s) => s,
                        o => o.to_string(),
                    };
                    match last {
                        Value::Array(a) => a.push(Value::String(v)),
                        Value::String(s) if s.is_empty() => {
                            *last = Value::Array(vec![Value::String(v)])
                        }
                        _ => complex = true,
                    }
                    continue;
                }
            }
            complex = true;
            continue;
        }
        let Some((k, v)) = tl.split_once(':') else {
            complex = true;
            continue;
        };
        let k = k.trim().trim_matches('"').to_string();
        if v.trim() == "|" || v.trim() == ">" {
            complex = true;
        }
        props.push((k, parse_scalar(v)));
    }
    (props, complex)
}

fn needs_quotes(s: &str) -> bool {
    s.is_empty()
        || s.contains(": ")
        || s.contains(" #")
        || s.starts_with([
            '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`', '-', '?',
            ',',
        ])
        || s.ends_with(':')
        || s.trim() != s
        || matches!(
            s,
            "true" | "false" | "yes" | "no" | "null" | "~" | "True" | "False"
        )
        || s.parse::<f64>().is_ok()
        || s.contains('\n')
}

fn yaml_str(s: &str) -> String {
    if needs_quotes(s) {
        serde_json::to_string(s).unwrap_or_default()
    } else {
        s.to_string()
    }
}

pub fn write_yaml(props: &[(String, Value)]) -> String {
    let mut o = String::new();
    for (k, v) in props {
        let key = if k.contains(':') || k.contains(' ') && k.trim() != k {
            serde_json::to_string(k).unwrap_or_default()
        } else {
            k.clone()
        };
        match v {
            Value::Array(items) => {
                if items.is_empty() {
                    o.push_str(&format!("{key}: []\n"));
                } else {
                    o.push_str(&format!("{key}:\n"));
                    for it in items {
                        let s = it
                            .as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| it.to_string());
                        o.push_str(&format!("  - {}\n", yaml_str(&s)));
                    }
                }
            }
            Value::Bool(b) => o.push_str(&format!("{key}: {b}\n")),
            Value::Number(n) => o.push_str(&format!("{key}: {n}\n")),
            Value::Null => o.push_str(&format!("{key}:\n")),
            Value::String(s) if s.is_empty() => o.push_str(&format!("{key}:\n")),
            Value::String(s) => o.push_str(&format!("{key}: {}\n", yaml_str(s))),
            Value::Object(_) => o.push_str(&format!("{key}: {}\n", yaml_str(&v.to_string()))),
        }
    }
    o
}

/// Puts a note back together. With `complex` frontmatter the original text is kept.
pub fn join(
    props: &[(String, Value)],
    raw_front: Option<&str>,
    complex: bool,
    body: &str,
) -> String {
    let body = body.trim_start_matches('\n');
    let fm = if complex {
        raw_front.map(|s| s.to_string())
    } else if props.is_empty() {
        None
    } else {
        Some(write_yaml(props))
    };
    match fm {
        Some(f) => {
            let f = if f.ends_with('\n') {
                f
            } else {
                format!("{f}\n")
            };
            format!("---\n{f}---\n\n{body}")
        }
        None => body.to_string(),
    }
}

pub fn props_to_map(props: &[(String, Value)]) -> Map<String, Value> {
    props.iter().cloned().collect()
}

/// A `[[target#heading|alias]]` found in a note.
#[derive(Debug, Clone, PartialEq)]
pub struct WikiLink {
    pub target: String,
    pub embed: bool,
    /// Byte range of the whole `[[…]]` (with the `!` for embeds).
    pub start: usize,
    pub end: usize,
}

/// Ranges of fenced code blocks and inline code, which never hold links or tags.
fn code_ranges(s: &str) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut off = 0;
    let mut fence: Option<(usize, String)> = None;
    for line in s.split_inclusive('\n') {
        let t = line.trim_start();
        let marker = if t.starts_with("```") {
            Some("```")
        } else if t.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        match (&fence, marker) {
            (None, Some(m)) => fence = Some((off, m.to_string())),
            (Some((st, m)), Some(m2)) if m == m2 => {
                out.push((*st, off + line.len()));
                fence = None;
            }
            _ => {}
        }
        off += line.len();
    }
    if let Some((st, _)) = fence {
        out.push((st, s.len()));
    }
    // inline code
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'`' && !out.iter().any(|(a, z)| i >= *a && i < *z) {
            if let Some(j) = s[i + 1..].find('`') {
                let z = i + 1 + j + 1;
                if !s[i..z].contains('\n') {
                    out.push((i, z));
                    i = z;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

fn in_ranges(r: &[(usize, usize)], i: usize) -> bool {
    r.iter().any(|(a, z)| i >= *a && i < *z)
}

pub fn wikilinks(s: &str) -> Vec<WikiLink> {
    let code = code_ranges(s);
    let mut out = vec![];
    let mut i = 0;
    while let Some(j) = s[i..].find("[[") {
        let st = i + j;
        let Some(k) = s[st + 2..].find("]]") else {
            break;
        };
        let inner = &s[st + 2..st + 2 + k];
        let end = st + 2 + k + 2;
        if !inner.contains('\n') && !inner.is_empty() && !in_ranges(&code, st) {
            let embed = st > 0 && s.as_bytes()[st - 1] == b'!';
            let target = inner
                .split('|')
                .next()
                .unwrap_or("")
                .split('#')
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            out.push(WikiLink {
                target,
                embed,
                start: if embed { st - 1 } else { st },
                end,
            });
        }
        i = end.min(s.len());
    }
    out
}

/// Targets of `[text](path.md)` links to local notes.
pub fn md_links(s: &str) -> Vec<String> {
    let code = code_ranges(s);
    let mut out = vec![];
    let mut i = 0;
    while let Some(j) = s[i..].find("](") {
        let st = i + j + 2;
        let Some(k) = s[st..].find(')') else { break };
        let url = &s[st..st + k];
        if !in_ranges(&code, st)
            && !url.contains("://")
            && !url.starts_with('#')
            && !url.starts_with("mailto:")
            && url.to_ascii_lowercase().ends_with(".md")
        {
            let dec = percent_encoding::percent_decode_str(url)
                .decode_utf8_lossy()
                .to_string();
            out.push(dec.trim_start_matches("./").to_string());
        }
        i = st + k;
    }
    out
}

/// `#tags` in the body (not headings, not inside code) plus the `tags` property.
pub fn tags(body: &str, props: &[(String, Value)]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let code = code_ranges(body);
    let b = body.as_bytes();
    for (i, c) in body.char_indices() {
        if c != '#' || in_ranges(&code, i) {
            continue;
        }
        let prev_ok = i == 0 || (b[i - 1] as char).is_whitespace() || b[i - 1] == b'(';
        if !prev_ok {
            continue;
        }
        let rest = &body[i + 1..];
        let tag: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
            .collect();
        if tag.is_empty() || tag.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let t = tag.to_lowercase();
        if !out.contains(&t) {
            out.push(t);
        }
    }
    for (k, v) in props {
        if k.eq_ignore_ascii_case("tags") || k.eq_ignore_ascii_case("tag") {
            let items: Vec<String> = match v {
                Value::Array(a) => a
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect(),
                Value::String(s) => s.split([',', ' ']).map(|x| x.to_string()).collect(),
                _ => vec![],
            };
            for t in items {
                let t = t.trim().trim_start_matches('#').to_lowercase();
                if !t.is_empty() && !out.contains(&t) {
                    out.push(t);
                }
            }
        }
    }
    out
}

/// Rewrites every link whose target is one of `old` (compared case-insensitively) to `new`.
/// Headings and aliases (`#h`, `|alias`) are kept.
pub fn rewrite_links(s: &str, old: &[String], new: &str) -> Option<String> {
    let olds: Vec<String> = old.iter().map(|o| o.to_lowercase()).collect();
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    let mut changed = false;
    for l in wikilinks(s) {
        if !olds.contains(&l.target.to_lowercase()) {
            continue;
        }
        let open = if l.embed { l.start + 3 } else { l.start + 2 };
        let inner = &s[open..l.end - 2];
        let tail_at = inner.find(['#', '|']).unwrap_or(inner.len());
        out.push_str(&s[last..open]);
        out.push_str(new);
        out.push_str(&inner[tail_at..]);
        out.push_str("]]");
        last = l.end;
        changed = true;
    }
    if !changed {
        return None;
    }
    out.push_str(&s[last..]);
    Some(out)
}

/// First `# Heading` of a body, if any (used for search snippets and agents).
pub fn first_heading(body: &str) -> Option<String> {
    body.lines()
        .find_map(|l| l.strip_prefix("# ").map(|h| h.trim().to_string()))
}

/// Body text without Markdown noise, for search and snippets.
pub fn plain(body: &str) -> String {
    let mut o = String::with_capacity(body.len());
    for line in body.lines() {
        let l = line
            .trim_start()
            .trim_start_matches('#')
            .trim_start_matches("> ")
            .trim_start_matches("- [ ] ")
            .trim_start_matches("- [x] ")
            .trim_start_matches("- ")
            .trim_start_matches("* ");
        if l.starts_with("```") || l.starts_with("---") {
            continue;
        }
        for c in l.chars() {
            if !matches!(c, '*' | '_' | '`' | '=' | '~') {
                o.push(c);
            }
        }
        o.push('\n');
    }
    o.replace("[[", "").replace("]]", "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_round_trip() {
        let t = "---\ntitle: Hola\ntags:\n  - a\n  - b\nstatus: \"in: progress\"\ndone: true\nn: 3\n---\n\n# Body\n";
        let p = split(t);
        assert!(!p.complex);
        assert_eq!(p.props.len(), 5);
        assert_eq!(p.props[1].1, serde_json::json!(["a", "b"]));
        assert_eq!(p.props[2].1, serde_json::json!("in: progress"));
        assert_eq!(p.body, "# Body\n");
        let back = join(&p.props, p.raw_front.as_deref(), p.complex, &p.body);
        assert_eq!(split(&back).props, p.props);
    }

    #[test]
    fn complex_frontmatter_is_kept() {
        let t = "---\na:\n  b: 1\n---\nx";
        let p = split(t);
        assert!(p.complex);
        assert!(join(&p.props, p.raw_front.as_deref(), true, &p.body).contains("  b: 1"));
    }

    #[test]
    fn links_and_tags() {
        let s = "See [[Page One#h|alias]] and ![[img.png]] `[[no]]` #tag #2024 [x](sub/Other%20Note.md)\n```\n[[nope]] #nope\n```";
        let l = wikilinks(s);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].target, "Page One");
        assert!(l[1].embed);
        assert_eq!(md_links(s), vec!["sub/Other Note.md"]);
        assert_eq!(tags(s, &[]), vec!["tag"]);
    }

    #[test]
    fn rewrite() {
        let s = "[[Old]] [[old#h|x]] ![[Old]] [[Other]]";
        let r = rewrite_links(s, &["old".into()], "New").unwrap();
        assert_eq!(r, "[[New]] [[New#h|x]] ![[New]] [[Other]]");
    }
}
