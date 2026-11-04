//! Importing from other apps. Today: Notion, two ways that end in the same place.
//!
//! - **Token** (`notion_api`): the user pastes an internal integration token and OpenBlocks reads
//!   every page and database the integration can see, with typed properties and files.
//! - **Export** (`notion_zip`): the user drops Notion's own "Markdown & CSV" export (the `.zip`, the
//!   parts inside it, or the folder Safari unzips) and OpenBlocks cleans it up.
//!
//! Both write into one new folder of the vault (`Notion`, or `Notion 2`…), turn databases into
//! database folders (one page per row, properties in the frontmatter), rewrite the links between
//! pages as `[[wikilinks]]` and keep images and files next to the pages that use them.
//! Only one import runs at a time; the UI polls [`status`].

pub mod notion_api;
pub mod notion_zip;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};

use crate::vault::{clean_name, Vault};
use crate::{markdown, Event, Shared};

#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub running: bool,
    pub finished: bool,
    pub cancelled: bool,
    /// "token" | "export"
    pub source: String,
    /// What it is doing right now, for the UI ("Buscando páginas", "Escribiendo"...).
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub pages: usize,
    pub databases: usize,
    pub files: usize,
    /// The vault folder everything went into.
    pub folder: Option<String>,
    pub error: Option<String>,
    /// Things that could not be brought over (a file that would not download, a page without access).
    pub warnings: Vec<String>,
}

fn job() -> &'static Mutex<Status> {
    static J: OnceLock<Mutex<Status>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(Status::default()))
}

static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn status() -> Status {
    job().lock().unwrap().clone()
}

pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

pub(crate) fn cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

pub(crate) fn set(f: impl FnOnce(&mut Status)) {
    f(&mut job().lock().unwrap());
}

pub(crate) fn phase(p: &str, total: usize) {
    set(|s| {
        s.phase = p.to_string();
        s.done = 0;
        s.total = total;
    });
}

pub(crate) fn tick() {
    set(|s| s.done += 1);
}

pub(crate) fn warn(w: String) {
    set(|s| {
        if s.warnings.len() < 200 {
            s.warnings.push(w);
        }
    });
}

/// Marks the job as started. Fails if another import is running.
fn begin(source: &str) -> Result<()> {
    let mut s = job().lock().unwrap();
    if s.running {
        anyhow::bail!("ya hay una importación en curso");
    }
    *s = Status {
        running: true,
        source: source.into(),
        ..Default::default()
    };
    CANCEL.store(false, Ordering::SeqCst);
    Ok(())
}

fn end(st: &Shared, v: &Vault, r: Result<()>) {
    // A failed import that wrote nothing leaves no empty folder behind.
    let s = status();
    if r.is_err() && s.pages == 0 && s.files == 0 {
        if let Some(f) = &s.folder {
            if let Ok(abs) = v.abs(f) {
                let _ = std::fs::remove_dir_all(abs);
            }
            let pre = format!("{f}/");
            v.config
                .write()
                .unwrap()
                .databases
                .retain(|k, _| k != f && !k.starts_with(&pre));
            v.save_config();
            set(|s| s.folder = None);
        }
    }
    v.reindex();
    let _ = st.events.send(Event::Tree);
    set(|s| {
        s.running = false;
        s.finished = true;
        s.cancelled = cancelled();
        if let Err(e) = r {
            if !s.cancelled {
                s.error = Some(e.to_string());
            }
        }
        s.phase.clear();
    });
}

/// Imports with an integration token, in the background.
pub fn start_token(st: Shared, token: String, folder: String) -> Result<()> {
    let v = st
        .vault()
        .ok_or_else(|| anyhow::anyhow!("no hay un vault abierto"))?;
    let es = lang_es(&st);
    let token = token.trim().to_string();
    if token.len() < 20 || token.contains(char::is_whitespace) {
        anyhow::bail!("ese token no parece de Notion (empieza con ntn_ o secret_)");
    }
    begin("token")?;
    tokio::spawn(async move {
        let r = async {
            let mut out = Out::new(v.clone(), &folder, es)?;
            notion_api::run(&token, &mut out).await?;
            out.finish();
            Ok(())
        }
        .await;
        end(&st, &v, r);
    });
    Ok(())
}

/// Imports a Notion export (zip files or an unzipped folder), in the background.
pub fn start_export(
    st: Shared,
    paths: Vec<std::path::PathBuf>,
    folder: String,
    temp: bool,
) -> Result<()> {
    let v = st
        .vault()
        .ok_or_else(|| anyhow::anyhow!("no hay un vault abierto"))?;
    if paths.is_empty() {
        anyhow::bail!("elegí el archivo .zip que exportaste de Notion");
    }
    for p in &paths {
        if !p.exists() {
            anyhow::bail!("no encuentro {}", p.display());
        }
    }
    let es = lang_es(&st);
    begin("export")?;
    tokio::task::spawn_blocking(move || {
        let r = (|| {
            let mut out = Out::new(v.clone(), &folder, es)?;
            notion_zip::run(&paths, &mut out)?;
            out.finish();
            Ok(())
        })();
        if temp {
            // An uploaded export lives alone in its own temporary folder.
            for p in &paths {
                match p.parent() {
                    Some(d) => {
                        let _ = std::fs::remove_dir_all(d);
                    }
                    None => {
                        let _ = std::fs::remove_file(p);
                    }
                }
            }
        }
        end(&st, &v, r);
    });
    Ok(())
}

fn lang_es(st: &Shared) -> bool {
    crate::settings::tr(&st.settings.read().unwrap(), "es", "en") == "es"
}

/// Where an import writes: a fresh folder of the vault, with names kept unique.
pub struct Out {
    pub v: Arc<Vault>,
    /// Write the few words an import adds ("Untitled") in Spanish.
    pub es: bool,
    /// The vault folder the import goes into.
    pub root: String,
    used: HashSet<String>,
}

impl Out {
    fn new(v: Arc<Vault>, name: &str, es: bool) -> Result<Out> {
        let base = clean_name(if name.trim().is_empty() {
            "Notion"
        } else {
            name.trim()
        });
        let mut out = Out {
            v,
            es,
            root: String::new(),
            used: HashSet::new(),
        };
        out.root = out.reserve("", &base, "");
        std::fs::create_dir_all(out.v.abs(&out.root)?)?;
        set(|s| s.folder = Some(out.root.clone()));
        Ok(out)
    }

    /// A free `dir/base{ext}` (also among names handed out earlier in this import). With an empty
    /// `ext` it is a folder name.
    pub fn reserve(&mut self, dir: &str, base: &str, ext: &str) -> String {
        let base = clean_name(base);
        let join = |n: &str| {
            if dir.is_empty() {
                n.to_string()
            } else {
                format!("{dir}/{n}")
            }
        };
        let mut i = 1;
        loop {
            let name = if i == 1 {
                format!("{base}{ext}")
            } else {
                format!("{base} {i}{ext}")
            };
            let rel = join(&name);
            let key = rel.to_lowercase();
            let on_disk = self.v.abs(&rel).map(|p| p.exists()).unwrap_or(true);
            if !self.used.contains(&key) && !on_disk {
                self.used.insert(key);
                return rel;
            }
            i += 1;
        }
    }

    /// A free file name inside `dir`, keeping the extension of `name`.
    pub fn reserve_file(&mut self, dir: &str, name: &str) -> String {
        let name = clean_name(name);
        let (b, e) = match name.rsplit_once('.') {
            Some((b, e)) if !b.is_empty() && e.len() <= 8 => (b.to_string(), format!(".{e}")),
            _ => (name.clone(), String::new()),
        };
        self.reserve(dir, &b, &e)
    }

    pub fn page(&mut self, rel: &str, props: &[(String, Value)], body: &str) -> Result<()> {
        let body = tidy(body);
        let text = markdown::join(props, None, false, &body);
        self.v.write_raw(rel, &text)?;
        set(|s| s.pages += 1);
        Ok(())
    }

    pub fn bytes(&mut self, rel: &str, data: &[u8]) -> Result<()> {
        let abs = self.v.abs(rel)?;
        if let Some(d) = abs.parent() {
            std::fs::create_dir_all(d)?;
        }
        self.v.mark_written(&abs);
        std::fs::write(&abs, data)?;
        set(|s| s.files += 1);
        Ok(())
    }

    pub fn copy(&mut self, rel: &str, src: &Path) -> Result<()> {
        let abs = self.v.abs(rel)?;
        if let Some(d) = abs.parent() {
            std::fs::create_dir_all(d)?;
        }
        self.v.mark_written(&abs);
        std::fs::copy(src, &abs)?;
        set(|s| s.files += 1);
        Ok(())
    }

    pub fn folder(&mut self, rel: &str) -> Result<()> {
        std::fs::create_dir_all(self.v.abs(rel)?)?;
        Ok(())
    }

    /// Shows a folder as a database (a table; a board when it has a status-like column).
    pub fn database(&mut self, rel: &str, columns: &[String]) -> Result<()> {
        self.folder(rel)?;
        let status = columns.iter().find(|c| {
            matches!(
                c.to_lowercase().as_str(),
                "status" | "estado" | "stage" | "etapa"
            )
        });
        let mut view = json!({"layout": "table"});
        if let Some(c) = status {
            view["groupBy"] = json!(c);
        }
        self.v
            .config
            .write()
            .unwrap()
            .databases
            .insert(rel.to_string(), view);
        set(|s| s.databases += 1);
        Ok(())
    }

    pub fn untitled(&self) -> &'static str {
        if self.es {
            "Sin título"
        } else {
            "Untitled"
        }
    }

    fn finish(&mut self) {
        self.v.save_config();
    }
}

/// Collapses runs of blank lines and trims the ends.
fn tidy(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut blank = 0;
    for l in s.trim_matches('\n').lines() {
        let l = l.trim_end();
        if l.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        o.push_str(l);
        o.push('\n');
    }
    o
}

/// `a/b/Page.md` → `a/b/Page` (how a wikilink names a page).
pub fn link_target(rel: &str) -> String {
    rel.strip_suffix(".md").unwrap_or(rel).to_string()
}

/// A wikilink to a vault path that shows `text`.
pub fn wikilink(rel: &str, text: &str) -> String {
    let target = link_target(rel);
    let text = text.replace(['[', ']', '|'], " ").trim().to_string();
    let last = target.rsplit('/').next().unwrap_or(&target);
    if text.is_empty() || text == target || (text == last && !target.contains('/')) {
        format!("[[{target}]]")
    } else {
        format!("[[{target}|{text}]]")
    }
}

/// An embed (`![[...]]`) of a vault file.
pub fn embed(rel: &str) -> String {
    format!("![[{rel}]]")
}

/// Callout kind for a Notion callout icon.
pub fn callout_kind(icon: &str) -> &'static str {
    match icon.trim_matches('\u{fe0f}') {
        "💡" => "tip",
        "⚠" | "🚧" | "🔥" => "warning",
        "❗" | "‼" | "📌" => "important",
        "ℹ" | "📘" | "📝" => "info",
        "✅" | "✔" => "success",
        "❌" | "🚫" | "⛔" | "🛑" => "danger",
        "❓" | "🤔" => "question",
        _ => "note",
    }
}

/// Dates Notion writes in exports ("November 3, 2026", "November 3, 2026 10:30 AM", "2026/11/03")
/// in the ISO form OpenBlocks shows as a date.
pub fn iso_date(s: &str) -> Option<String> {
    use chrono::{NaiveDate, NaiveDateTime};
    let s = s.trim().trim_start_matches('@').trim();
    if s.is_empty() || s.len() > 40 {
        return None;
    }
    let s = s
        .replace(" (GMT", "\u{0}")
        .split('\u{0}')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    for f in [
        "%B %d, %Y %I:%M %p",
        "%b %d, %Y %I:%M %p",
        "%Y/%m/%d %H:%M",
        "%Y-%m-%d %H:%M",
        "%d/%m/%Y %H:%M",
    ] {
        if let Ok(d) = NaiveDateTime::parse_from_str(&s, f) {
            return Some(d.format("%Y-%m-%dT%H:%M").to_string());
        }
    }
    for f in ["%B %d, %Y", "%b %d, %Y", "%Y/%m/%d", "%Y-%m-%d", "%d/%m/%Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(&s, f) {
            return Some(d.format("%Y-%m-%d").to_string());
        }
    }
    None
}

/// ISO date-times from the API (`2026-11-03T10:30:00.000-03:00`) as OpenBlocks writes them.
pub fn short_iso(s: &str) -> String {
    if s.len() >= 16 && s.as_bytes()[10] == b'T' {
        if s[11..].starts_with("00:00:00") {
            return s[..10].to_string();
        }
        return s[..16].to_string();
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(iso_date("November 3, 2026").as_deref(), Some("2026-11-03"));
        assert_eq!(
            iso_date("@March 14, 2024 9:05 PM").as_deref(),
            Some("2024-03-14T21:05")
        );
        assert_eq!(iso_date("2024/03/14").as_deref(), Some("2024-03-14"));
        assert_eq!(iso_date("hola"), None);
        assert_eq!(
            short_iso("2026-11-03T10:30:00.000-03:00"),
            "2026-11-03T10:30"
        );
        assert_eq!(short_iso("2026-11-03"), "2026-11-03");
    }

    #[test]
    fn links() {
        assert_eq!(
            wikilink("Notion/A/Page.md", "Page"),
            "[[Notion/A/Page|Page]]"
        );
        assert_eq!(wikilink("Page.md", "Page"), "[[Page]]");
        assert_eq!(embed("Notion/a/img.png"), "![[Notion/a/img.png]]");
    }
}
