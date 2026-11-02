//! The vault: a plain folder of Markdown pages, subfolders and any other files the user drops in.
//! OpenBlocks keeps its own things in `<vault>/.openblocks/` (config, page history, trash), so the
//! folder stays a normal Obsidian-compatible vault.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::markdown;
use crate::util;

pub const META_DIR: &str = ".openblocks";
const SKIP_DIRS: &[&str] = &[
    META_DIR,
    ".obsidian",
    ".git",
    ".trash",
    "node_modules",
    ".DS_Store",
];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct VaultConfig {
    pub name: String,
    pub created: u64,
    /// Pages pinned to the top of the sidebar.
    pub favorites: Vec<String>,
    /// Folders shown as a database, with their view settings.
    pub databases: HashMap<String, Value>,
    /// Folders the user collapsed in the tree.
    pub collapsed: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct NoteMeta {
    pub title: String,
    pub mtime: u64,
    pub size: u64,
    /// Link targets as written (wikilinks and Markdown links).
    pub links: Vec<String>,
    pub tags: Vec<String>,
    pub props: Vec<(String, Value)>,
    /// Lowercase plain text, for search.
    pub text: String,
}

#[derive(Default)]
pub struct Index {
    pub notes: HashMap<String, NoteMeta>,
    /// Every non-note file (attachments), by relative path.
    pub files: HashSet<String>,
}

pub struct Vault {
    pub root: PathBuf,
    pub config: RwLock<VaultConfig>,
    pub index: RwLock<Index>,
    /// Files OpenBlocks just wrote, so the watcher can tell our writes from other programs'.
    recent: Mutex<HashMap<PathBuf, Instant>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    /// "folder" | "page" | "file"
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
}

pub fn is_note(p: &str) -> bool {
    let l = p.to_ascii_lowercase();
    l.ends_with(".md") || l.ends_with(".markdown")
}

/// `folder/Page.md` → `Page`
pub fn stem(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rfind('.') {
        Some(i) if is_note(name) => name[..i].to_string(),
        _ => name.to_string(),
    }
}

fn parent_of(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Characters that are not allowed in file names on some system, or that break wikilinks.
pub fn clean_name(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let t = t.trim().trim_matches('.').trim().to_string();
    if t.is_empty() {
        "Sin título".into()
    } else {
        util::clip(&t, 120).trim_end_matches('…').to_string()
    }
}

fn mtime_of(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn meta_from(rel: &str, text: &str, mtime: u64) -> NoteMeta {
    let p = markdown::split(text);
    let mut links: Vec<String> = markdown::wikilinks(&p.body)
        .into_iter()
        .map(|l| l.target)
        .collect();
    links.extend(markdown::md_links(&p.body));
    let tags = markdown::tags(&p.body, &p.props);
    let mut text_l = stem(rel).to_lowercase();
    text_l.push('\n');
    text_l.push_str(&markdown::plain(&p.body).to_lowercase());
    NoteMeta {
        title: stem(rel),
        mtime,
        size: text.len() as u64,
        links,
        tags,
        props: p.props,
        text: text_l,
    }
}

impl Vault {
    /// A vault with no folder, for calls that need the type but never touch disk.
    pub fn empty() -> Vault {
        Vault {
            root: PathBuf::new(),
            config: RwLock::new(VaultConfig::default()),
            index: RwLock::new(Index::default()),
            recent: Mutex::new(HashMap::new()),
        }
    }

    /// Opens a folder as a vault, creating it (and its first page) if needed.
    pub fn open(root: &Path, name: Option<String>, guide: bool) -> Result<Vault> {
        let root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()?.join(root)
        };
        std::fs::create_dir_all(&root)
            .with_context(|| format!("no puedo crear {}", root.display()))?;
        let root = root.canonicalize().unwrap_or(root);
        let meta = root.join(META_DIR);
        std::fs::create_dir_all(&meta)?;
        let cfg_path = meta.join("config.json");
        let mut cfg: VaultConfig = std::fs::read_to_string(&cfg_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let fresh = cfg.created == 0;
        if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
            cfg.name = n.trim().to_string();
        }
        if cfg.name.is_empty() {
            cfg.name = root
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Vault".into());
        }
        if fresh {
            cfg.created = util::now();
        }
        let v = Vault {
            root,
            config: RwLock::new(cfg),
            index: RwLock::new(Index::default()),
            recent: Mutex::new(HashMap::new()),
        };
        v.save_config();
        v.reindex();
        if fresh && guide && v.index.read().unwrap().notes.is_empty() {
            let _ = v.write_raw("Bienvenida.md", GUIDE);
            v.reindex_one("Bienvenida.md");
        }
        Ok(v)
    }

    pub fn name(&self) -> String {
        self.config.read().unwrap().name.clone()
    }

    pub fn save_config(&self) {
        let p = self.root.join(META_DIR).join("config.json");
        if let Ok(s) = serde_json::to_string_pretty(&*self.config.read().unwrap()) {
            let _ = std::fs::write(p, s);
        }
    }

    /// A safe absolute path for a vault-relative one. Refuses `..`, absolute paths and our meta dir.
    pub fn abs(&self, rel: &str) -> Result<PathBuf> {
        let rel = rel.trim().trim_start_matches(['/', '\\']);
        let p = Path::new(rel);
        for c in p.components() {
            match c {
                Component::Normal(s) => {
                    if s == META_DIR {
                        bail!("ruta reservada");
                    }
                }
                Component::CurDir => {}
                _ => bail!("ruta inválida: {rel}"),
            }
        }
        Ok(self.root.join(p))
    }

    /// Relative path with forward slashes.
    pub fn rel(&self, abs: &Path) -> Option<String> {
        let r = abs.strip_prefix(&self.root).ok()?;
        let s = r.to_string_lossy().replace('\\', "/");
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    fn skip(name: &str) -> bool {
        SKIP_DIRS.contains(&name) || name.starts_with('.')
    }

    pub fn reindex(&self) {
        let mut idx = Index::default();
        for e in walkdir::WalkDir::new(&self.root)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Self::skip(&e.file_name().to_string_lossy()))
            .flatten()
        {
            if !e.file_type().is_file() {
                continue;
            }
            let Some(rel) = self.rel(e.path()) else {
                continue;
            };
            if is_note(&rel) {
                if let Ok(t) = std::fs::read_to_string(e.path()) {
                    idx.notes
                        .insert(rel.clone(), meta_from(&rel, &t, mtime_of(e.path())));
                }
            } else {
                idx.files.insert(rel);
            }
        }
        *self.index.write().unwrap() = idx;
    }

    /// Refreshes one entry after it changed on disk (or drops it if it is gone).
    pub fn reindex_one(&self, rel: &str) {
        let Ok(abs) = self.abs(rel) else { return };
        let mut idx = self.index.write().unwrap();
        if abs.is_file() {
            if is_note(rel) {
                if let Ok(t) = std::fs::read_to_string(&abs) {
                    idx.notes
                        .insert(rel.to_string(), meta_from(rel, &t, mtime_of(&abs)));
                }
            } else {
                idx.files.insert(rel.to_string());
            }
        } else {
            idx.notes.remove(rel);
            idx.files.remove(rel);
            let pre = format!("{rel}/");
            idx.notes.retain(|k, _| !k.starts_with(&pre));
            idx.files.retain(|k| !k.starts_with(&pre));
        }
    }

    pub fn mark_written(&self, abs: &Path) {
        let mut r = self.recent.lock().unwrap();
        r.retain(|_, t| t.elapsed() < Duration::from_secs(5));
        r.insert(abs.to_path_buf(), Instant::now());
    }

    pub fn wrote_recently(&self, abs: &Path) -> bool {
        self.recent
            .lock()
            .unwrap()
            .get(abs)
            .is_some_and(|t| t.elapsed() < Duration::from_millis(2500))
    }

    /// Writes a file atomically (temp file + rename).
    pub fn write_raw(&self, rel: &str, content: &str) -> Result<u64> {
        let abs = self.abs(rel)?;
        if let Some(d) = abs.parent() {
            std::fs::create_dir_all(d)?;
        }
        let tmp = abs.with_file_name(format!(
            ".{}.ob-tmp",
            abs.file_name().unwrap_or_default().to_string_lossy()
        ));
        self.mark_written(&abs);
        std::fs::write(&tmp, content)?;
        std::fs::rename(&tmp, &abs)?;
        Ok(mtime_of(&abs))
    }

    // ---------- tree ----------

    pub fn tree(&self) -> Vec<TreeNode> {
        self.tree_of(&self.root, "")
    }

    fn tree_of(&self, dir: &Path, rel: &str) -> Vec<TreeNode> {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return vec![];
        };
        let mut folders = vec![];
        let mut items = vec![];
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if Self::skip(&name) || name.ends_with(".ob-tmp") {
                continue;
            }
            let path = join_rel(rel, &name);
            let ft = match e.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            if ft.is_dir() {
                let children = self.tree_of(&e.path(), &path);
                folders.push(TreeNode {
                    name,
                    path,
                    kind: "folder",
                    children: Some(children),
                    ext: None,
                });
            } else if is_note(&name) {
                items.push(TreeNode {
                    name: stem(&name),
                    path,
                    kind: "page",
                    children: None,
                    ext: None,
                });
            } else {
                let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
                items.push(TreeNode {
                    name,
                    path,
                    kind: "file",
                    children: None,
                    ext,
                });
            }
        }
        let key = |n: &TreeNode| n.name.to_lowercase();
        folders.sort_by_key(key);
        items.sort_by(|a, b| {
            (a.kind != "page")
                .cmp(&(b.kind != "page"))
                .then_with(|| key(a).cmp(&key(b)))
        });
        folders.extend(items);
        folders
    }

    // ---------- pages ----------

    pub fn read_page(&self, rel: &str) -> Result<Value> {
        let abs = self.abs(rel)?;
        let text = std::fs::read_to_string(&abs).with_context(|| format!("no encuentro {rel}"))?;
        let p = markdown::split(&text);
        Ok(json!({
            "path": rel,
            "title": stem(rel),
            "folder": parent_of(rel),
            "body": p.body,
            "props": p.props.iter().map(|(k, v)| json!({"key": k, "value": v})).collect::<Vec<_>>(),
            "complex": p.complex,
            "mtime": mtime_of(&abs),
        }))
    }

    /// Saves a page from the editor. Takes a history snapshot first (throttled).
    pub fn save_page(
        &self,
        rel: &str,
        body: &str,
        props: Option<&[(String, Value)]>,
        reason: &str,
    ) -> Result<u64> {
        let abs = self.abs(rel)?;
        let old = std::fs::read_to_string(&abs).ok();
        let (raw_front, complex, old_props) = match &old {
            Some(t) => {
                let p = markdown::split(t);
                (p.raw_front, p.complex, p.props)
            }
            None => (None, false, vec![]),
        };
        let props = props.map(|p| p.to_vec()).unwrap_or(old_props);
        let text = markdown::join(&props, raw_front.as_deref(), complex, body);
        if old.as_deref() == Some(text.as_str()) {
            return Ok(mtime_of(&abs));
        }
        if let Some(o) = &old {
            if reason != "none" {
                self.snapshot(rel, o, reason);
            }
        }
        let m = self.write_raw(rel, &text)?;
        self.reindex_one(rel);
        Ok(m)
    }

    /// Sets (or with `None` removes) one property of a page.
    pub fn set_prop(&self, rel: &str, key: &str, value: Option<Value>) -> Result<()> {
        let abs = self.abs(rel)?;
        let text = std::fs::read_to_string(&abs)?;
        let mut p = markdown::split(&text);
        if p.complex {
            bail!("las propiedades de esta página tienen un formato que OpenBlocks no edita");
        }
        match value {
            Some(v) => match p.props.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = v,
                None => p.props.push((key.to_string(), v)),
            },
            None => p.props.retain(|(k, _)| k != key),
        }
        self.save_page(rel, &p.body, Some(&p.props), "props")?;
        Ok(())
    }

    /// A free file name in `dir` for `title` (adds " 2", " 3"…).
    pub fn free_name(&self, dir: &str, base: &str, ext: &str) -> Result<String> {
        let base = clean_name(base);
        for n in 1..1000 {
            let name = if n == 1 {
                format!("{base}{ext}")
            } else {
                format!("{base} {n}{ext}")
            };
            let rel = join_rel(dir, &name);
            if !self.abs(&rel)?.exists() {
                return Ok(rel);
            }
        }
        bail!("demasiados archivos con ese nombre")
    }

    pub fn create_page(&self, folder: &str, title: &str, body: &str) -> Result<String> {
        let rel = self.free_name(folder.trim_matches('/'), title, ".md")?;
        self.write_raw(&rel, body)?;
        self.reindex_one(&rel);
        Ok(rel)
    }

    pub fn create_folder(&self, rel: &str) -> Result<String> {
        let parent = parent_of(rel);
        let name = clean_name(rel.rsplit('/').next().unwrap_or(rel));
        let mut target = join_rel(parent, &name);
        let mut n = 2;
        while self.abs(&target)?.exists() {
            target = join_rel(parent, &format!("{name} {n}"));
            n += 1;
        }
        std::fs::create_dir_all(self.abs(&target)?)?;
        Ok(target)
    }

    /// Moves or renames a page, file or folder and fixes every link that pointed to it.
    pub fn move_entry(&self, from: &str, to: &str) -> Result<(String, usize)> {
        let src = self.abs(from)?;
        if !src.exists() {
            bail!("no existe {from}");
        }
        let mut to = to.trim_matches('/').to_string();
        if src.is_file() && is_note(from) && !is_note(&to) {
            to.push_str(".md");
        }
        if to == from {
            return Ok((to, 0));
        }
        let dst = self.abs(&to)?;
        if dst.exists() && !from.eq_ignore_ascii_case(&to) {
            bail!("ya existe {to}");
        }
        if src.is_dir() && dst.starts_with(&src) {
            bail!("no se puede mover una carpeta adentro de sí misma");
        }
        if let Some(d) = dst.parent() {
            std::fs::create_dir_all(d)?;
        }
        // Which notes move, old rel → new rel.
        let moved: Vec<(String, String)> = if src.is_dir() {
            let pre = format!("{from}/");
            let idx = self.index.read().unwrap();
            idx.notes
                .keys()
                .chain(idx.files.iter())
                .filter(|k| k.starts_with(&pre))
                .map(|k| (k.clone(), format!("{to}/{}", &k[pre.len()..])))
                .collect()
        } else {
            vec![(from.to_string(), to.clone())]
        };
        self.mark_written(&src);
        self.mark_written(&dst);
        std::fs::rename(&src, &dst)?;
        // History follows the page.
        for (o, n) in &moved {
            let ho = self.history_dir(o);
            if ho.exists() {
                let hn = self.history_dir(n);
                let _ = std::fs::create_dir_all(hn.parent().unwrap_or(&hn));
                let _ = std::fs::rename(ho, hn);
            }
        }
        self.reindex();
        let fixed = self.fix_links(&moved);
        {
            let mut cfg = self.config.write().unwrap();
            for (o, n) in &moved {
                for f in cfg.favorites.iter_mut() {
                    if f == o {
                        *f = n.clone();
                    }
                }
            }
        }
        self.save_config();
        Ok((to, fixed))
    }

    fn fix_links(&self, moved: &[(String, String)]) -> usize {
        let mut fixed = 0;
        let names: HashMap<String, usize> = {
            let idx = self.index.read().unwrap();
            let mut m = HashMap::new();
            for k in idx.notes.keys().chain(idx.files.iter()) {
                *m.entry(stem(k).to_lowercase()).or_insert(0) += 1;
            }
            m
        };
        let notes: Vec<String> = self.index.read().unwrap().notes.keys().cloned().collect();
        for (o, n) in moved {
            let old_stem = stem(o);
            let new_stem = stem(n);
            let o_noext = o.strip_suffix(".md").unwrap_or(o).to_string();
            let n_noext = n.strip_suffix(".md").unwrap_or(n).to_string();
            let is_file = !is_note(o);
            let old_forms: Vec<String> = if is_file {
                vec![o.clone(), o.rsplit('/').next().unwrap_or(o).to_string()]
            } else {
                vec![o_noext.clone(), o.clone(), old_stem.clone()]
            };
            let unique = names.get(&new_stem.to_lowercase()).copied().unwrap_or(0) <= 1;
            let new_target = if is_file {
                if unique {
                    n.rsplit('/').next().unwrap_or(n).to_string()
                } else {
                    n.clone()
                }
            } else if unique {
                new_stem.clone()
            } else {
                n_noext.clone()
            };
            if old_forms
                .iter()
                .all(|f| f.eq_ignore_ascii_case(&new_target))
            {
                continue;
            }
            for rel in &notes {
                let Ok(abs) = self.abs(rel) else { continue };
                let Ok(text) = std::fs::read_to_string(&abs) else {
                    continue;
                };
                if let Some(t) = markdown::rewrite_links(&text, &old_forms, &new_target) {
                    if self.write_raw(rel, &t).is_ok() {
                        self.reindex_one(rel);
                        fixed += 1;
                    }
                }
            }
        }
        fixed
    }

    // ---------- links ----------

    /// Which note or file a link target points to (Obsidian rules: path, then shortest by name).
    pub fn resolve(&self, target: &str) -> Option<String> {
        let t = target.trim().trim_start_matches("./").replace('\\', "/");
        if t.is_empty() {
            return None;
        }
        let tl = t.to_lowercase();
        let idx = self.index.read().unwrap();
        let with_md = if is_note(&tl) {
            tl.clone()
        } else {
            format!("{tl}.md")
        };
        let mut best: Option<&String> = None;
        for k in idx.notes.keys() {
            let kl = k.to_lowercase();
            if kl == with_md {
                return Some(k.clone());
            }
            if (kl.ends_with(&format!("/{with_md}")) || kl == with_md)
                && best.is_none_or(|b| k.len() < b.len())
            {
                best = Some(k);
            }
        }
        if let Some(b) = best {
            return Some(b.clone());
        }
        for k in idx.files.iter() {
            let kl = k.to_lowercase();
            if (kl == tl || kl.ends_with(&format!("/{tl}")))
                && best.is_none_or(|b| k.len() < b.len())
            {
                best = Some(k);
            }
        }
        best.cloned()
    }

    /// Notes that link here, and notes that mention the title without linking.
    pub fn backlinks(&self, rel: &str) -> Value {
        let idx = self.index.read().unwrap();
        let title = stem(rel);
        let tl = title.to_lowercase();
        let mut linked = vec![];
        let mut unlinked = vec![];
        let targets: Vec<(String, Vec<String>)> = idx
            .notes
            .iter()
            .map(|(k, m)| (k.clone(), m.links.clone()))
            .collect();
        drop(idx);
        for (k, links) in targets {
            if k == rel {
                continue;
            }
            let links_here = links
                .iter()
                .any(|l| self.resolve(l).as_deref() == Some(rel));
            let idx = self.index.read().unwrap();
            let Some(m) = idx.notes.get(&k) else { continue };
            if links_here {
                linked.push(json!({"path": k, "title": m.title, "snippet": snippet(&m.text, &tl)}));
            } else if tl.chars().count() >= 3 && contains_word(&m.text, &tl) {
                unlinked
                    .push(json!({"path": k, "title": m.title, "snippet": snippet(&m.text, &tl)}));
            }
        }
        json!({"linked": linked, "unlinked": unlinked})
    }

    pub fn graph(&self) -> Value {
        let idx = self.index.read().unwrap();
        let keys: Vec<(String, Vec<String>, Vec<String>)> = idx
            .notes
            .iter()
            .map(|(k, m)| (k.clone(), m.links.clone(), m.tags.clone()))
            .collect();
        drop(idx);
        let mut nodes = vec![];
        let mut edges = vec![];
        let mut ghosts: HashSet<String> = HashSet::new();
        for (k, links, tags) in &keys {
            nodes.push(json!({"id": k, "title": stem(k), "tags": tags, "folder": parent_of(k)}));
            let mut seen = HashSet::new();
            for l in links {
                match self.resolve(l) {
                    Some(t) if is_note(&t) => {
                        if t != *k && seen.insert(t.clone()) {
                            edges.push(json!([k, t]));
                        }
                    }
                    Some(_) => {}
                    None => {
                        let g = format!("?{}", l.to_lowercase());
                        if seen.insert(g.clone()) {
                            ghosts.insert(l.clone());
                            edges.push(json!([k, g]));
                        }
                    }
                }
            }
        }
        for g in ghosts {
            nodes.push(json!({"id": format!("?{}", g.to_lowercase()), "title": g, "ghost": true}));
        }
        json!({"nodes": nodes, "edges": edges})
    }

    pub fn tags(&self) -> Vec<Value> {
        let idx = self.index.read().unwrap();
        let mut m: HashMap<String, Vec<String>> = HashMap::new();
        for (k, n) in &idx.notes {
            for t in &n.tags {
                m.entry(t.clone()).or_default().push(k.clone());
            }
        }
        let mut v: Vec<Value> = m
            .into_iter()
            .map(|(t, pages)| json!({"tag": t, "count": pages.len(), "pages": pages}))
            .collect();
        v.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()));
        v
    }

    // ---------- database view ----------

    /// Pages of a folder as rows, with the union of their properties as columns.
    pub fn database(&self, folder: &str) -> Value {
        let idx = self.index.read().unwrap();
        let pre = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };
        let mut cols: Vec<String> = vec![];
        let mut rows = vec![];
        let mut keys: Vec<&String> = idx
            .notes
            .keys()
            .filter(|k| k.starts_with(&pre) && !k[pre.len()..].contains('/'))
            .collect();
        keys.sort_by_key(|k| k.to_lowercase());
        for k in keys {
            let m = &idx.notes[k];
            for (c, _) in &m.props {
                if !cols.contains(c) {
                    cols.push(c.clone());
                }
            }
            rows.push(json!({
                "path": k, "title": m.title, "mtime": m.mtime,
                "props": markdown::props_to_map(&m.props),
            }));
        }
        let view = self
            .config
            .read()
            .unwrap()
            .databases
            .get(folder)
            .cloned()
            .unwrap_or(Value::Null);
        json!({"folder": folder, "columns": cols, "rows": rows, "view": view})
    }

    // ---------- history ----------

    fn history_dir(&self, rel: &str) -> PathBuf {
        let safe: String = rel
            .chars()
            .map(|c| if c == '/' || c == '\\' { '~' } else { c })
            .collect();
        self.root.join(META_DIR).join("history").join(safe)
    }

    /// Keeps a copy of the previous version. Edits from the editor are throttled to one copy every
    /// ten minutes; agent edits and restores always keep one.
    pub fn snapshot(&self, rel: &str, content: &str, reason: &str) {
        let dir = self.history_dir(rel);
        let _ = std::fs::create_dir_all(&dir);
        let mut list: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|r| r.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        list.sort();
        if reason == "edit" || reason == "props" {
            if let Some(last) = list.last() {
                let age = util::now().saturating_sub(mtime_of(last));
                if age < 600 {
                    return;
                }
            }
        }
        let name = format!("{}_{}.md", util::stamp(), reason.replace(['/', '\\'], ""));
        if std::fs::write(dir.join(&name), content).is_ok() {
            list.push(dir.join(name));
        }
        while list.len() > 60 {
            let _ = std::fs::remove_file(list.remove(0));
        }
    }

    pub fn history(&self, rel: &str) -> Vec<Value> {
        let dir = self.history_dir(rel);
        let mut v: Vec<Value> = std::fs::read_dir(&dir)
            .map(|r| {
                r.flatten()
                    .filter_map(|e| {
                        let n = e.file_name().to_string_lossy().into_owned();
                        let (stamp, reason) = n.trim_end_matches(".md").split_once('_')?;
                        Some(json!({"id": n, "stamp": stamp, "reason": reason,
                                    "size": e.metadata().map(|m| m.len()).unwrap_or(0)}))
                    })
                    .collect()
            })
            .unwrap_or_default();
        v.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
        v
    }

    pub fn history_version(&self, rel: &str, id: &str) -> Result<String> {
        if id.contains(['/', '\\']) || id.contains("..") {
            bail!("versión inválida");
        }
        Ok(std::fs::read_to_string(self.history_dir(rel).join(id))?)
    }

    pub fn restore_version(&self, rel: &str, id: &str) -> Result<()> {
        let text = self.history_version(rel, id)?;
        let abs = self.abs(rel)?;
        if let Ok(cur) = std::fs::read_to_string(&abs) {
            self.snapshot(rel, &cur, "restore");
        }
        self.write_raw(rel, &text)?;
        self.reindex_one(rel);
        Ok(())
    }

    // ---------- trash ----------

    fn trash_dir(&self) -> PathBuf {
        self.root.join(META_DIR).join("trash")
    }

    /// Moves a page, file or folder to the vault's trash (it can be restored).
    pub fn trash(&self, rel: &str) -> Result<String> {
        let abs = self.abs(rel)?;
        if !abs.exists() {
            bail!("no existe {rel}");
        }
        let dir = self.trash_dir();
        std::fs::create_dir_all(&dir)?;
        let enc = percent_encoding::utf8_percent_encode(rel, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
        let id = format!("{}__{}", util::now_ms(), enc);
        let dst = dir.join(&id);
        self.mark_written(&abs);
        std::fs::rename(&abs, &dst)?;
        self.reindex_one(rel);
        let mut cfg = self.config.write().unwrap();
        cfg.favorites
            .retain(|f| f != rel && !f.starts_with(&format!("{rel}/")));
        drop(cfg);
        self.save_config();
        Ok(id)
    }

    pub fn trash_list(&self) -> Vec<Value> {
        let mut v: Vec<Value> = std::fs::read_dir(self.trash_dir())
            .map(|r| {
                r.flatten()
                    .filter_map(|e| {
                        let n = e.file_name().to_string_lossy().into_owned();
                        let (ts, enc) = n.split_once("__")?;
                        let path = percent_encoding::percent_decode_str(enc)
                            .decode_utf8_lossy()
                            .into_owned();
                        Some(json!({"id": n, "path": path, "name": stem(&path),
                                    "deleted": ts.parse::<u64>().unwrap_or(0) / 1000,
                                    "folder": e.path().is_dir()}))
                    })
                    .collect()
            })
            .unwrap_or_default();
        v.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
        v
    }

    pub fn restore_trash(&self, id: &str) -> Result<String> {
        if id.contains(['/', '\\']) || id.contains("..") {
            bail!("id inválido");
        }
        let src = self.trash_dir().join(id);
        let (_, enc) = id.split_once("__").context("id inválido")?;
        let mut rel = percent_encoding::percent_decode_str(enc)
            .decode_utf8_lossy()
            .into_owned();
        if self.abs(&rel)?.exists() {
            let (dir, name) = (parent_of(&rel).to_string(), stem(&rel));
            let ext = if is_note(&rel) {
                ".md".to_string()
            } else {
                rel.rsplit_once('.')
                    .map(|(_, e)| format!(".{e}"))
                    .unwrap_or_default()
            };
            rel = self.free_name(&dir, &format!("{name} (restaurada)"), &ext)?;
        }
        let dst = self.abs(&rel)?;
        if let Some(d) = dst.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::rename(src, &dst)?;
        self.reindex();
        Ok(rel)
    }

    /// Deletes everything in the trash for good.
    pub fn empty_trash(&self) -> Result<usize> {
        let mut n = 0;
        for e in std::fs::read_dir(self.trash_dir())?.flatten() {
            let p = e.path();
            let r = if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
            if r.is_ok() {
                n += 1;
            }
        }
        Ok(n)
    }

    // ---------- files ----------

    /// Saves an uploaded file next to the page (in an `attachments` folder) and returns its path.
    pub fn save_upload(&self, folder: &str, name: &str, data: &[u8]) -> Result<String> {
        let name = clean_name(name.rsplit(['/', '\\']).next().unwrap_or(name));
        let (base, ext) = match name.rsplit_once('.') {
            Some((b, e)) if !b.is_empty() => (b.to_string(), format!(".{e}")),
            _ => (name.clone(), String::new()),
        };
        let dir = join_rel(folder.trim_matches('/'), "attachments");
        let rel = self.free_name(&dir, &base, &ext)?;
        let abs = self.abs(&rel)?;
        if let Some(d) = abs.parent() {
            std::fs::create_dir_all(d)?;
        }
        self.mark_written(&abs);
        std::fs::write(&abs, data)?;
        self.reindex_one(&rel);
        Ok(rel)
    }

    /// Writes a file at a vault path (parents are created).
    pub fn write_bytes(&self, rel: &str, data: &[u8]) -> Result<()> {
        let abs = self.abs(rel)?;
        if let Some(d) = abs.parent() {
            std::fs::create_dir_all(d)?;
        }
        self.mark_written(&abs);
        std::fs::write(&abs, data)?;
        self.reindex_one(rel);
        Ok(())
    }

    // ---------- daily notes and templates ----------

    pub fn daily(&self, folder: &str, date: &str) -> Result<String> {
        let rel = join_rel(folder.trim_matches('/'), &format!("{date}.md"));
        if !self.abs(&rel)?.exists() {
            self.write_raw(&rel, "")?;
            self.reindex_one(&rel);
        }
        Ok(rel)
    }

    pub fn templates(&self, folder: &str) -> Vec<Value> {
        let pre = format!("{}/", folder.trim_matches('/'));
        let idx = self.index.read().unwrap();
        let mut v: Vec<Value> = idx
            .notes
            .keys()
            .filter(|k| k.starts_with(&pre))
            .map(|k| json!({"path": k, "title": stem(k)}))
            .collect();
        v.sort_by(|a, b| a["title"].as_str().cmp(&b["title"].as_str()));
        v
    }

    /// Fills `{{title}}`, `{{date}}` and `{{time}}` in a template.
    pub fn render_template(&self, tpl: &str, title: &str) -> Result<String> {
        let text = std::fs::read_to_string(self.abs(tpl)?)?;
        let now = chrono::Local::now();
        Ok(text
            .replace("{{title}}", title)
            .replace("{{date}}", &now.format("%Y-%m-%d").to_string())
            .replace("{{time}}", &now.format("%H:%M").to_string()))
    }

    pub fn recent(&self, n: usize) -> Vec<Value> {
        let idx = self.index.read().unwrap();
        let mut v: Vec<(&String, &NoteMeta)> = idx.notes.iter().collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1.mtime));
        v.into_iter()
            .take(n)
            .map(|(k, m)| json!({"path": k, "title": m.title, "mtime": m.mtime, "folder": parent_of(k)}))
            .collect()
    }

    pub fn stats(&self) -> Value {
        let idx = self.index.read().unwrap();
        let words: usize = idx
            .notes
            .values()
            .map(|m| m.text.split_whitespace().count())
            .sum();
        json!({"pages": idx.notes.len(), "files": idx.files.len(), "words": words})
    }
}

pub fn contains_word(hay: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(i) = hay[from..].find(needle) {
        let st = from + i;
        let en = st + needle.len();
        let before = hay[..st]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after = hay[en..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        if before && after {
            return true;
        }
        from = en;
    }
    false
}

/// A short excerpt of `text` around the first `needle`.
pub fn snippet(text: &str, needle: &str) -> String {
    let body = text.split_once('\n').map(|(_, b)| b).unwrap_or(text);
    let Some(i) = body.find(needle) else {
        return util::clip(body.trim(), 160);
    };
    let mut st = i.saturating_sub(70);
    while !body.is_char_boundary(st) {
        st -= 1;
    }
    let mut en = (i + needle.len() + 90).min(body.len());
    while !body.is_char_boundary(en) {
        en += 1;
    }
    let s = body[st..en].replace('\n', " ");
    format!(
        "{}{}{}",
        if st > 0 { "…" } else { "" },
        s.trim(),
        if en < body.len() { "…" } else { "" }
    )
}

const GUIDE: &str = r#"Este es tu vault. Cada página es un archivo Markdown en tu carpeta: podés abrirlo con cualquier editor, con Obsidian o sincronizarlo como quieras.

## Para empezar

- Escribí `/` para insertar un bloque: títulos, tareas, tablas, código, notas destacadas, desplegables o archivos.
- Escribí `[[` para enlazar otra página. Si no existe, se crea al abrir el enlace.
- Arrastrá archivos a la página para adjuntarlos. PDF, Word, Excel, PowerPoint, CSV e imágenes se ven al costado.
- Seleccioná texto para darle formato o pedirle algo a la IA.

## Atajos

| Acción | Atajo |
| --- | --- |
| Buscar o ejecutar un comando | ⌘K |
| Nueva página | ⌘N |
| Preguntarle a la IA | ⌘J |
| Nota del día | ⌘D |
| Mostrar u ocultar la barra lateral | ⌘\ |

> [!tip] Tu IA, tus modelos
> El chat usa los modelos que ya tenés: Ollama, LM Studio, Claude Code, Codex, tus claves de API o un agente de OpenCue. Nada sale de tu equipo si elegís un modelo local.

- [ ] Crear tu primera página
- [ ] Probar el menú `/`
- [ ] Abrir el chat con ⌘J
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_move_fix_links_and_trash() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path(), Some("Test".into()), false).unwrap();
        let a = v
            .create_page("", "Alpha", "Links to [[Beta]] and [[Beta#x|b]].")
            .unwrap();
        let b = v
            .create_page("notes", "Beta", "Back to [[Alpha]].")
            .unwrap();
        assert_eq!(v.resolve("beta").as_deref(), Some(b.as_str()));
        assert_eq!(v.backlinks(&b)["linked"].as_array().unwrap().len(), 1);
        let (nb, fixed) = v.move_entry(&b, "notes/Gamma").unwrap();
        assert_eq!(nb, "notes/Gamma.md");
        assert_eq!(fixed, 1);
        let ta = std::fs::read_to_string(v.abs(&a).unwrap()).unwrap();
        assert!(ta.contains("[[Gamma]]") && ta.contains("[[Gamma#x|b]]"));
        v.trash(&a).unwrap();
        assert!(v.resolve("Alpha").is_none());
        let t = v.trash_list();
        assert_eq!(t.len(), 1);
        let back = v.restore_trash(t[0]["id"].as_str().unwrap()).unwrap();
        assert_eq!(back, "Alpha.md");
    }

    #[test]
    fn refuses_escaping_paths() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path(), None, false).unwrap();
        assert!(v.abs("../x").is_err());
        assert!(v.abs(".openblocks/config.json").is_err());
        assert!(v.abs("/etc/passwd").is_ok_and(|p| p.starts_with(&v.root)));
    }

    #[test]
    fn history_and_props() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path(), None, false).unwrap();
        let p = v.create_page("", "P", "one").unwrap();
        v.save_page(&p, "two", None, "ai").unwrap();
        assert_eq!(v.history(&p).len(), 1);
        v.set_prop(&p, "status", Some(json!("done"))).unwrap();
        let page = v.read_page(&p).unwrap();
        assert_eq!(page["body"], "two");
        assert_eq!(page["props"][0]["value"], "done");
    }
}
