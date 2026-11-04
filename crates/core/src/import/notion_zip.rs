//! Notion's own export ("Markdown & CSV", with subpages), as a `.zip`, the `Part-N.zip` files inside
//! it, or the folder a browser unzipped.
//!
//! What the export looks like and what we do with it:
//! - `Page 1a2b…(32 hex).md` plus a `Page 1a2b…/` folder with its subpages and images → the ids go
//!   away; a page with subpages becomes a folder with the page inside.
//! - `Tasks 1a2b….csv` (and `Tasks 1a2b…_all.csv`) plus a `Tasks 1a2b…/` folder with one page per
//!   row → a database folder; each row page gets its properties as frontmatter (typed: dates,
//!   checkboxes, numbers, lists, relations as links) instead of the `Key: value` lines Notion writes.
//! - Links between pages (`[Other](Other%20…id.md)`, `notion.so/…id` URLs) → `[[wikilinks]]`;
//!   images and files → embeds (`![[…]]`).
//! - `<aside>` callouts → `> [!note]` callouts. The `# Title` line Notion repeats goes away.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::notion_api::id_in;
use super::{callout_kind, embed, iso_date, phase, tick, warn, wikilink, Out};

pub fn run(paths: &[PathBuf], out: &mut Out) -> Result<()> {
    let (src, tmp) = prepare(paths)?;
    let r = convert(&src, out);
    if let Some(t) = tmp {
        let _ = std::fs::remove_dir_all(t);
    }
    r
}

// ---------- unzipping ----------

fn prepare(paths: &[PathBuf]) -> Result<(PathBuf, Option<PathBuf>)> {
    if paths.len() == 1 && paths[0].is_dir() {
        return Ok((paths[0].clone(), None));
    }
    let tmp = std::env::temp_dir().join(format!("openblocks-notion-{}", crate::util::new_id()));
    std::fs::create_dir_all(&tmp)?;
    let r = (|| {
        for p in paths {
            if p.is_dir() {
                bail!("elegí los .zip de la exportación o una sola carpeta");
            }
            unzip(p, &tmp)?;
        }
        // Big exports come as a zip of zips (`…-Part-1.zip`, `…-Part-2.zip`).
        for _ in 0..3 {
            let inner: Vec<PathBuf> = list(&tmp).into_iter().filter(|p| p.is_file()).collect();
            if inner.is_empty() || !inner.iter().all(|p| ext_of(p) == "zip") {
                break;
            }
            for z in inner {
                unzip(&z, &tmp)?;
                let _ = std::fs::remove_file(&z);
            }
        }
        Ok(())
    })();
    if let Err(e) = r {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    Ok((tmp.clone(), Some(tmp)))
}

fn unzip(zip: &Path, to: &Path) -> Result<()> {
    let f =
        std::fs::File::open(zip).with_context(|| format!("no puedo abrir {}", zip.display()))?;
    let mut a = zip::ZipArchive::new(f).context("ese archivo no es un .zip válido")?;
    phase("Descomprimiendo", a.len());
    for i in 0..a.len() {
        if super::cancelled() {
            bail!("cancelado");
        }
        let mut e = a.by_index(i)?;
        // `enclosed_name` refuses `..` and absolute paths (no writing outside the folder).
        let Some(rel) = e.enclosed_name() else {
            continue;
        };
        if rel.components().any(|c| {
            let s = c.as_os_str().to_string_lossy();
            s == "__MACOSX" || s == ".DS_Store"
        }) {
            continue;
        }
        let dest = to.join(rel);
        if e.is_dir() {
            std::fs::create_dir_all(&dest)?;
        } else {
            if let Some(d) = dest.parent() {
                std::fs::create_dir_all(d)?;
            }
            let mut w = std::fs::File::create(&dest)?;
            std::io::copy(&mut e, &mut w)?;
        }
        tick();
    }
    Ok(())
}

fn list(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = name_of(p);
                    !(n.starts_with('.') || n == "__MACOSX")
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn name_of(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// `Page 1a2b….md` → (`Page`, Some(id)). Also handles `_all.csv` and names without an id.
pub fn split_id(stem: &str) -> (String, Option<String>) {
    let s = stem.strip_suffix("_all").unwrap_or(stem);
    let b = s.as_bytes();
    if b.len() >= 33 {
        let (head, tail) = s.split_at(s.len() - 32);
        if tail.chars().all(|c| c.is_ascii_hexdigit())
            && (head.ends_with(' ') || head.ends_with('_'))
        {
            let base = head[..head.len() - 1].trim().to_string();
            return (base, Some(tail.to_lowercase()));
        }
    }
    (s.trim().to_string(), None)
}

// ---------- mapping the export to the vault ----------

struct Db {
    columns: Vec<String>,
    kinds: Vec<Kind>,
    rows: Vec<Vec<String>>,
    by_title: HashMap<String, Vec<usize>>,
    used: HashSet<usize>,
    folder: String,
    /// The export folder the row pages are in (relative to the export root).
    old_dir: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Text,
    Bool,
    Number,
    Date,
    List,
    Links,
}

struct PageJob {
    src: PathBuf,
    old_dir: String,
    rel: String,
    title: String,
    db: Option<usize>,
}

#[derive(Default)]
struct Map {
    /// Old relative path (lowercase) → new vault path. Databases' `.csv` map to their folder.
    paths: HashMap<String, String>,
    /// Notion id → new vault path.
    ids: HashMap<String, String>,
    folders: HashSet<String>,
    pages: Vec<PageJob>,
    copies: Vec<(PathBuf, String)>,
    dbs: Vec<Db>,
}

fn join(a: &str, b: &str) -> String {
    if a.is_empty() {
        b.to_string()
    } else {
        format!("{a}/{b}")
    }
}

fn convert(src: &Path, out: &mut Out) -> Result<()> {
    // Skip wrapper folders (`Export-…/`, a lone `Private & Shared/`).
    let mut root = src.to_path_buf();
    for _ in 0..4 {
        let items = list(&root);
        if items.len() == 1 && items[0].is_dir() {
            root = items[0].clone();
        } else {
            break;
        }
    }
    let items = list(&root);
    if !items
        .iter()
        .any(|p| p.is_dir() || matches!(ext_of(p).as_str(), "md" | "csv"))
    {
        bail!("no encuentro páginas en la exportación: en Notion elegí «Markdown & CSV» con subpáginas");
    }
    phase("Leyendo la exportación", 0);
    let mut m = Map::default();
    let top = out.root.clone();
    walk(&root, "", &top, None, out, &mut m)?;

    // Pages.
    phase("Convirtiendo páginas", m.pages.len());
    let jobs = std::mem::take(&mut m.pages);
    for j in &jobs {
        if super::cancelled() {
            bail!("cancelado");
        }
        match std::fs::read_to_string(&j.src) {
            Ok(text) => {
                let (props, body) = page(&text, j, &mut m);
                if let Err(e) = out.page(&j.rel, &props, &body) {
                    warn(format!("{}: {e}", j.title));
                }
            }
            Err(e) => warn(format!("{}: {e}", j.title)),
        }
        tick();
    }

    // Rows that have no page of their own in the export.
    for di in 0..m.dbs.len() {
        let free: Vec<usize> = (0..m.dbs[di].rows.len())
            .filter(|i| !m.dbs[di].used.contains(i))
            .collect();
        for i in free {
            let title = m.dbs[di].rows[i].first().cloned().unwrap_or_default();
            let title = if title.trim().is_empty() {
                out.untitled().to_string()
            } else {
                title
            };
            let folder = m.dbs[di].folder.clone();
            let rel = out.reserve(&folder, &title, ".md");
            let props = row_props(&m, di, Some(i), &HashMap::new());
            out.page(&rel, &props, "")?;
        }
    }

    // Images and other files.
    phase("Copiando archivos", m.copies.len());
    for (src, rel) in &m.copies {
        if super::cancelled() {
            bail!("cancelado");
        }
        if let Err(e) = out.copy(rel, src) {
            warn(format!("{}: {e}", name_of(src)));
        }
        tick();
    }
    Ok(())
}

/// Maps one export folder into `new_dir`, recursively.
fn walk(
    dir: &Path,
    old_rel: &str,
    new_dir: &str,
    db: Option<usize>,
    out: &mut Out,
    m: &mut Map,
) -> Result<()> {
    let items = list(dir);
    let dirs: HashMap<String, PathBuf> = items
        .iter()
        .filter(|p| p.is_dir())
        .map(|p| (name_of(p), p.clone()))
        .collect();
    let mut paired: HashSet<String> = HashSet::new();

    // Databases first, so their folders claim their names.
    let mut csvs: Vec<&PathBuf> = items
        .iter()
        .filter(|p| p.is_file() && ext_of(p) == "csv")
        .collect();
    // Prefer `X_all.csv` (every row) over `X.csv` (the rows of the saved view).
    csvs.sort_by_key(|p| !name_of(p).ends_with("_all.csv"));
    let mut done_db: HashMap<String, usize> = HashMap::new();
    for csv in csvs {
        let stem = name_of(csv);
        let stem = stem.trim_end_matches(".csv");
        let key = stem.strip_suffix("_all").unwrap_or(stem).to_string();
        let old = join(old_rel, &name_of(csv)).to_lowercase();
        if let Some(&di) = done_db.get(&key) {
            m.paths.insert(old, m.dbs[di].folder.clone());
            continue;
        }
        let (base, id) = split_id(stem);
        let text = std::fs::read_to_string(csv).unwrap_or_default();
        let table = parse_csv(&text);
        let (head, rows) = match table.split_first() {
            Some((h, r)) => (h.clone(), r.to_vec()),
            None => (vec!["Name".into()], vec![]),
        };
        let folder = out.reserve(new_dir, &base, "");
        let columns: Vec<String> = head.iter().skip(1).cloned().collect();
        out.database(&folder, &columns)?;
        let kinds = (1..head.len())
            .map(|c| {
                infer(
                    &head[c],
                    rows.iter().filter_map(|r| r.get(c)).map(|s| s.as_str()),
                )
            })
            .collect();
        let mut by_title: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, r) in rows.iter().enumerate() {
            by_title
                .entry(r.first().cloned().unwrap_or_default().trim().to_lowercase())
                .or_default()
                .push(i);
        }
        let di = m.dbs.len();
        m.dbs.push(Db {
            columns,
            kinds,
            rows,
            by_title,
            used: HashSet::new(),
            folder: folder.clone(),
            old_dir: join(old_rel, &key),
        });
        done_db.insert(key.clone(), di);
        m.paths.insert(old, folder.clone());
        m.folders.insert(folder.clone());
        if let Some(id) = id {
            m.ids.insert(id, folder.clone());
        }
        if let Some(d) = dirs.get(&key) {
            paired.insert(key.clone());
            walk(d, &join(old_rel, &key), &folder, Some(di), out, m)?;
        }
    }

    for p in items.iter().filter(|p| p.is_file()) {
        let name = name_of(p);
        let ext = ext_of(p);
        if ext == "csv" {
            continue;
        }
        let old = join(old_rel, &name);
        if ext == "md" {
            let stem = name[..name.len() - 3].to_string();
            let (base, id) = split_id(&stem);
            let base = if base.is_empty() {
                out.untitled().to_string()
            } else {
                base
            };
            let kids = dirs.get(&stem).filter(|_| !paired.contains(&stem)).cloned();
            let rel = match (&kids, db) {
                (Some(_), None) => {
                    let f = out.reserve(new_dir, &base, "");
                    m.folders.insert(f.clone());
                    let rel = out.reserve(&f, &base, ".md");
                    walk(
                        kids.as_ref().unwrap(),
                        &join(old_rel, &stem),
                        &f,
                        None,
                        out,
                        m,
                    )?;
                    rel
                }
                (Some(_), Some(_)) => {
                    // A database row keeps its place in the database; its subpages go beside it.
                    let rel = out.reserve(new_dir, &base, ".md");
                    let f = out.reserve(new_dir, &base, "");
                    m.folders.insert(f.clone());
                    walk(
                        kids.as_ref().unwrap(),
                        &join(old_rel, &stem),
                        &f,
                        None,
                        out,
                        m,
                    )?;
                    rel
                }
                (None, _) => out.reserve(new_dir, &base, ".md"),
            };
            if kids.is_some() {
                paired.insert(stem.clone());
            }
            m.paths.insert(old.to_lowercase(), rel.clone());
            if let Some(id) = id {
                m.ids.insert(id, rel.clone());
            }
            m.pages.push(PageJob {
                src: p.clone(),
                old_dir: old_rel.to_string(),
                rel,
                title: base,
                db,
            });
        } else {
            let rel = out.reserve_file(new_dir, &name);
            m.paths.insert(old.to_lowercase(), rel.clone());
            m.copies.push((p.clone(), rel));
        }
    }

    // Folders with no page of their own (attachments, or a page Notion left without a file).
    for (name, d) in &dirs {
        if paired.contains(name) {
            continue;
        }
        let (base, id) = split_id(name);
        let f = out.reserve(new_dir, &base, "");
        m.folders.insert(f.clone());
        if let Some(id) = id {
            m.ids.entry(id).or_insert_with(|| f.clone());
        }
        walk(d, &join(old_rel, name), &f, None, out, m)?;
    }
    Ok(())
}

// ---------- pages ----------

fn page(text: &str, j: &PageJob, m: &mut Map) -> (Vec<(String, Value)>, String) {
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n");
    let mut lines: Vec<&str> = text.lines().collect();
    // Notion repeats the title as `# Title` on the first line.
    if let Some(i) = lines.iter().position(|l| !l.trim().is_empty()) {
        if lines[i].starts_with("# ") {
            lines.drain(..=i);
        }
    }
    let mut props = vec![];
    if let Some(di) = j.db {
        // `Key: value` lines right under the title, for the database's columns.
        let cols: HashSet<String> = m.dbs[di].columns.iter().map(|c| c.to_lowercase()).collect();
        let mut found: HashMap<String, String> = HashMap::new();
        let mut i = 0;
        let mut last_prop = 0;
        while i < lines.len() {
            let l = lines[i].trim();
            if l.is_empty() {
                i += 1;
                continue;
            }
            match l.split_once(": ") {
                Some((k, v)) if cols.contains(&k.trim().to_lowercase()) => {
                    found.insert(k.trim().to_lowercase(), rewrite(v.trim(), &j.old_dir, m));
                    i += 1;
                    last_prop = i;
                }
                _ => break,
            }
        }
        lines.drain(..last_prop);
        let row = pick_row(&mut m.dbs[di], &j.title);
        props = row_props(m, di, row, &found);
    }
    let body = asides(&lines.join("\n"));
    let body = rewrite(&body, &j.old_dir, m);
    (props, body)
}

fn pick_row(db: &mut Db, title: &str) -> Option<usize> {
    let t = title.trim().to_lowercase();
    let mut pick = db
        .by_title
        .get(&t)
        .and_then(|v| v.iter().find(|i| !db.used.contains(i)).copied());
    if pick.is_none() && t.len() >= 20 {
        // Notion shortens long file names: match the start.
        pick = db
            .by_title
            .iter()
            .filter(|(k, _)| k.starts_with(&t))
            .flat_map(|(_, v)| v.iter().copied())
            .find(|i| !db.used.contains(i));
    }
    if let Some(i) = pick {
        db.used.insert(i);
    }
    pick
}

/// Properties of a row from its page's own lines (`found`, already link-rewritten) or its CSV row.
fn row_props(
    m: &Map,
    di: usize,
    row: Option<usize>,
    found: &HashMap<String, String>,
) -> Vec<(String, Value)> {
    let db = &m.dbs[di];
    let mut v = vec![];
    for (c, col) in db.columns.iter().enumerate() {
        let raw = match found.get(&col.to_lowercase()) {
            Some(s) => s.clone(),
            None => row
                .and_then(|r| db.rows[r].get(c + 1))
                .map(|s| rewrite(s, &db.old_dir, m))
                .unwrap_or_default(),
        };
        v.push((col.clone(), typed(&raw, db.kinds[c], m)));
    }
    v
}

fn typed(s: &str, k: Kind, m: &Map) -> Value {
    let s = s.trim();
    if s.is_empty() {
        return if matches!(k, Kind::List | Kind::Links) {
            json!([])
        } else {
            json!("")
        };
    }
    match k {
        Kind::Bool => json!(matches!(s, "Yes" | "Sí" | "Si" | "true" | "True")),
        Kind::Number => s
            .parse::<f64>()
            .ok()
            .and_then(|n| {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    Some(json!(n as i64))
                } else {
                    serde_json::Number::from_f64(n).map(Value::Number)
                }
            })
            .unwrap_or_else(|| json!(s)),
        Kind::Date => {
            let start = s.split('→').next().unwrap_or(s);
            json!(iso_date(start).unwrap_or_else(|| s.to_string()))
        }
        Kind::List => json!(s
            .split(", ")
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
            .collect::<Vec<_>>()),
        Kind::Links => json!(links_in(s, m)),
        Kind::Text => json!(s),
    }
}

/// The pages a relation cell points to, as wikilinks (`Title (https://www.notion.so/…id)` or
/// already rewritten `[[…]]`).
fn links_in(s: &str, m: &Map) -> Vec<String> {
    let mut v = vec![];
    let mut rest = s;
    while let Some(i) = rest.find("[[") {
        let Some(j) = rest[i..].find("]]") else { break };
        v.push(rest[i..i + j + 2].to_string());
        rest = &rest[i + j + 2..];
    }
    if !v.is_empty() {
        return v;
    }
    for part in split_relations(s) {
        let (title, url) = match part.rfind(" (") {
            Some(i) if part.ends_with(')') => (&part[..i], &part[i + 2..part.len() - 1]),
            _ => (part.as_str(), ""),
        };
        match id_in(url).and_then(|id| m.ids.get(&id)) {
            Some(rel) => v.push(wikilink(rel, title)),
            None if !title.trim().is_empty() => v.push(title.trim().to_string()),
            None => {}
        }
    }
    v
}

/// Splits `A (url), B (url)` on the commas between items (not the ones inside titles).
fn split_relations(s: &str) -> Vec<String> {
    let mut v = vec![];
    let mut cur = String::new();
    let mut depth = 0;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth <= 0 && chars.get(i + 1) == Some(&' ') => {
                v.push(std::mem::take(&mut cur).trim().to_string());
                i += 2;
                continue;
            }
            _ => {}
        }
        cur.push(c);
        i += 1;
    }
    if !cur.trim().is_empty() {
        v.push(cur.trim().to_string());
    }
    v
}

/// What kind of values a column holds, from its values.
fn infer<'a>(name: &str, vals: impl Iterator<Item = &'a str>) -> Kind {
    let vals: Vec<&str> = vals.map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let n = name.to_lowercase();
    if vals.is_empty() {
        return if n.contains("tag") || n.contains("etiqueta") {
            Kind::List
        } else {
            Kind::Text
        };
    }
    if vals.iter().all(|v| matches!(*v, "Yes" | "No")) {
        return Kind::Bool;
    }
    if vals.iter().all(|v| v.parse::<f64>().is_ok()) {
        return Kind::Number;
    }
    if vals
        .iter()
        .all(|v| iso_date(v.split('→').next().unwrap_or(v)).is_some())
    {
        return Kind::Date;
    }
    let notion_link = |v: &&str| v.contains("notion.so/") || v.contains(".md)") || v.contains("[[");
    if vals.iter().all(notion_link) {
        return Kind::Links;
    }
    if n.contains("tag") || n.contains("etiqueta") || n.contains("categor") || n.contains("label") {
        return Kind::List;
    }
    // Multi-selects: short items separated by ", " that repeat across rows.
    let mut seen: HashMap<&str, usize> = HashMap::new();
    let mut multi = false;
    for v in &vals {
        let items: Vec<&str> = v.split(", ").collect();
        if items.len() > 1 {
            multi = true;
        }
        for it in items {
            if it.len() > 30 || it.split_whitespace().count() > 3 || it.ends_with('.') {
                return Kind::Text;
            }
            *seen.entry(it).or_default() += 1;
        }
    }
    if multi && seen.values().any(|c| *c > 1) {
        Kind::List
    } else {
        Kind::Text
    }
}

/// `<aside>💡 text</aside>` → `> [!tip]` callouts.
fn asides(s: &str) -> String {
    let mut o: Vec<String> = vec![];
    let mut lines = s.lines().peekable();
    while let Some(l) = lines.next() {
        let t = l.trim();
        if !t.starts_with("<aside>") {
            o.push(l.to_string());
            continue;
        }
        let mut inner = vec![t.trim_start_matches("<aside>").to_string()];
        let mut closed = inner[0].contains("</aside>");
        while !closed {
            let Some(n) = lines.next() else { break };
            closed = n.contains("</aside>");
            inner.push(n.to_string());
        }
        let text = inner.join("\n").replace("</aside>", "");
        let text = text.trim();
        let first = text.chars().next().unwrap_or(' ');
        let (kind, text) = if !first.is_alphanumeric() && !first.is_ascii() {
            let end = text.find(char::is_whitespace).unwrap_or(text.len());
            let icon = &text[..end];
            let kind = callout_kind(icon);
            if kind == "note" {
                ("note", text.to_string())
            } else {
                (kind, text[end..].trim_start().to_string())
            }
        } else {
            ("note", text.to_string())
        };
        o.push(format!("> [!{kind}]"));
        for x in text.lines() {
            o.push(if x.trim().is_empty() {
                ">".into()
            } else {
                format!("> {x}")
            });
        }
        o.push(String::new());
    }
    o.join("\n")
}

const EMBEDDABLE: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "pdf", "mp4", "mov", "webm", "m4v",
    "mp3", "wav", "m4a", "ogg",
];

/// Rewrites Markdown links and images that point into the export (or to notion.so pages).
fn rewrite(s: &str, old_dir: &str, m: &Map) -> String {
    let mut o = String::with_capacity(s.len());
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        let img = b[i] == '!' && b.get(i + 1) == Some(&'[');
        if b[i] != '[' && !img {
            o.push(b[i]);
            i += 1;
            continue;
        }
        let start = if img { i + 1 } else { i };
        // [text](href) with balanced parentheses in the href.
        let Some(close) = (start + 1..b.len()).find(|&k| b[k] == ']' || b[k] == '\n') else {
            o.push(b[i]);
            i += 1;
            continue;
        };
        if b[close] != ']' || b.get(close + 1) != Some(&'(') || b.get(start + 1) == Some(&'[') {
            o.push(b[i]);
            i += 1;
            continue;
        }
        let mut depth = 0;
        let mut end = None;
        for (k, c) in b.iter().enumerate().skip(close + 1) {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(k);
                        break;
                    }
                }
                '\n' => break,
                _ => {}
            }
        }
        let Some(end) = end else {
            o.push(b[i]);
            i += 1;
            continue;
        };
        let text: String = b[start + 1..close].iter().collect();
        let href: String = b[close + 2..end].iter().collect();
        let raw: String = b[i..=end].iter().collect();
        o.push_str(&link(&text, href.trim(), img, old_dir, m).unwrap_or(raw));
        i = end + 1;
    }
    o
}

fn link(text: &str, href: &str, img: bool, old_dir: &str, m: &Map) -> Option<String> {
    let href = href.trim_matches(['<', '>']);
    let lower = href.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        if !(lower.contains("notion.so/") || lower.contains("notion.site/")) {
            return None;
        }
        let rel = m.ids.get(&id_in(href)?)?;
        return Some(wikilink(rel, text));
    }
    if lower.starts_with('#') || lower.starts_with("mailto:") || lower.contains("://") {
        return None;
    }
    let path = href.split(['#', '?']).next().unwrap_or(href);
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8_lossy()
        .into_owned();
    let full = normalize(&join(old_dir, &decoded))?;
    let rel = m.paths.get(&full.to_lowercase())?;
    let ext = rel
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    if m.folders.contains(rel) || ext == "md" {
        return Some(wikilink(rel, text));
    }
    if img || EMBEDDABLE.contains(&ext.as_str()) {
        return Some(embed(rel));
    }
    Some(format!(
        "[[{rel}|{}]]",
        text.replace(['[', ']', '|'], " ").trim()
    ))
}

/// `a/b/../c` → `a/c`; `None` if it climbs out of the export.
fn normalize(p: &str) -> Option<String> {
    let mut v: Vec<&str> = vec![];
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                v.pop()?;
            }
            c => v.push(c),
        }
    }
    Some(v.join("/"))
}

/// A small RFC 4180 reader (quotes, doubled quotes, newlines inside quotes).
fn parse_csv(s: &str) -> Vec<Vec<String>> {
    let s = s.strip_prefix('\u{feff}').unwrap_or(s);
    let mut rows = vec![];
    let mut row = vec![];
    let mut cell = String::new();
    let mut q = false;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if q {
            match c {
                '"' if it.peek() == Some(&'"') => {
                    cell.push('"');
                    it.next();
                }
                '"' => q = false,
                c => cell.push(c),
            }
            continue;
        }
        match c {
            '"' => q = true,
            ',' => row.push(std::mem::take(&mut cell)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
            }
            c => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_in_names() {
        assert_eq!(
            split_id("My Page 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"),
            (
                "My Page".into(),
                Some("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d".into())
            )
        );
        assert_eq!(
            split_id("Tasks 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d_all"),
            (
                "Tasks".into(),
                Some("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d".into())
            )
        );
        assert_eq!(split_id("image"), ("image".into(), None));
    }

    #[test]
    fn csv() {
        let t = parse_csv("\u{feff}Name,Notes\nA,\"x, \"\"y\"\"\nz\"\nB,\n");
        assert_eq!(
            t,
            vec![
                vec!["Name", "Notes"],
                vec!["A", "x, \"y\"\nz"],
                vec!["B", ""]
            ]
        );
    }

    #[test]
    fn kinds() {
        assert_eq!(infer("Done", ["Yes", "No"].into_iter()), Kind::Bool);
        assert_eq!(
            infer("Due", ["March 3, 2024", "April 1, 2024"].into_iter()),
            Kind::Date
        );
        assert_eq!(infer("Tags", ["a, b", "b"].into_iter()), Kind::List);
        assert_eq!(
            infer("Kind", ["Work, Home", "Home"].into_iter()),
            Kind::List
        );
        assert_eq!(
            infer("Notes", ["Bought milk, then left.", "ok"].into_iter()),
            Kind::Text
        );
        assert_eq!(infer("Points", ["3", "4.5"].into_iter()), Kind::Number);
    }

    #[test]
    fn callouts() {
        assert_eq!(asides("<aside>\n💡 Idea\n\n</aside>"), "> [!tip]\n> Idea\n");
        assert_eq!(asides("<aside>🐱 Gato</aside>"), "> [!note]\n> 🐱 Gato\n");
    }

    #[test]
    fn relations() {
        assert_eq!(
            split_relations("A (x, y) (https://n/1), B (https://n/2)"),
            vec!["A (x, y) (https://n/1)", "B (https://n/2)"]
        );
    }
}
