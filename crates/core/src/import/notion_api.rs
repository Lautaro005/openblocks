//! Notion through its API, with an internal integration token.
//!
//! 1. `search` lists every page and database the integration can see (database rows too; each
//!    database is also queried so no row is missed). Pages that live inside a block (a toggle, a
//!    column) are walked up to the page that holds them.
//! 2. Every page gets its place: a page with subpages becomes a folder with the page inside, a
//!    database becomes a database folder with one page per row.
//! 3. Each page's blocks are read and written as Markdown; Notion-hosted files are downloaded
//!    right away (their links expire after an hour) into an `attachments` folder.
//!
//! Notion allows about three requests per second, so calls are spaced and 429s wait as asked.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use futures::future::BoxFuture;
use futures::StreamExt;
use reqwest::Method;
use serde_json::{json, Value};

use super::{callout_kind, embed, phase, set, short_iso, tick, warn, wikilink, Out};

const NOTION_VERSION: &str = "2022-06-28";

fn base() -> String {
    std::env::var("OPENBLOCKS_NOTION_API").unwrap_or_else(|_| "https://api.notion.com".into())
}

/// Notion ids without dashes, lowercase.
fn nid(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '-')
        .collect::<String>()
        .to_lowercase()
}

/// The 32-hex id at the end of a Notion URL or path, if any.
pub fn id_in(s: &str) -> Option<String> {
    let s = s.split(['?', '#']).next().unwrap_or(s);
    let tail: String = s
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let id = nid(&tail);
    if id.len() >= 32 {
        Some(id[id.len() - 32..].to_string())
    } else {
        None
    }
}

struct Api {
    http: reqwest::Client,
    files: reqwest::Client,
    token: String,
    base: String,
    gate: tokio::sync::Mutex<Instant>,
}

impl Api {
    async fn call(&self, m: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut tries: u32 = 0;
        loop {
            if super::cancelled() {
                bail!("cancelado");
            }
            {
                let mut g = self.gate.lock().await;
                let next = *g + Duration::from_millis(340);
                let now = Instant::now();
                if next > now {
                    tokio::time::sleep(next - now).await;
                }
                *g = Instant::now();
            }
            let mut r = self
                .http
                .request(m.clone(), format!("{}{}", self.base, path))
                .bearer_auth(&self.token)
                .header("Notion-Version", NOTION_VERSION);
            if let Some(b) = body {
                r = r.json(b);
            }
            let resp = match r.send().await {
                Ok(x) => x,
                Err(e) => {
                    tries += 1;
                    if tries > 4 {
                        bail!("no puedo conectar con Notion: {e}");
                    }
                    tokio::time::sleep(Duration::from_secs(1 << tries)).await;
                    continue;
                }
            };
            let code = resp.status();
            if code.as_u16() == 429 || code.is_server_error() {
                tries += 1;
                if tries > 6 {
                    bail!("Notion no responde ({code})");
                }
                let wait = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .unwrap_or(1 << tries.min(5));
                tokio::time::sleep(Duration::from_secs(wait.clamp(1, 60))).await;
                continue;
            }
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            if code.as_u16() == 401 {
                bail!("Notion rechazó el token: revisá que esté bien copiado");
            }
            if !code.is_success() {
                bail!("{}", v["message"].as_str().unwrap_or(code.as_str()));
            }
            return Ok(v);
        }
    }

    /// Every result of a paginated endpoint.
    async fn all(&self, m: Method, path: &str, body: Value) -> Result<Vec<Value>> {
        let mut out = vec![];
        let mut cursor: Option<String> = None;
        loop {
            let v = if m == Method::GET {
                let sep = if path.contains('?') { '&' } else { '?' };
                let p = match &cursor {
                    Some(c) => format!("{path}{sep}page_size=100&start_cursor={c}"),
                    None => format!("{path}{sep}page_size=100"),
                };
                self.call(Method::GET, &p, None).await?
            } else {
                let mut b = if body.is_object() {
                    body.clone()
                } else {
                    json!({})
                };
                b["page_size"] = json!(100);
                if let Some(c) = &cursor {
                    b["start_cursor"] = json!(c);
                }
                self.call(m.clone(), path, Some(&b)).await?
            };
            if let Some(a) = v["results"].as_array() {
                out.extend(a.iter().cloned());
            }
            match (v["has_more"].as_bool(), v["next_cursor"].as_str()) {
                (Some(true), Some(c)) => cursor = Some(c.to_string()),
                _ => break,
            }
        }
        Ok(out)
    }

    /// A block's children, with their own children inside (synced blocks read their original).
    fn tree(&self, id: String, depth: usize) -> BoxFuture<'_, Result<Vec<Block>>> {
        Box::pin(async move {
            let list = self
                .all(
                    Method::GET,
                    &format!("/v1/blocks/{id}/children"),
                    Value::Null,
                )
                .await?;
            let mut out = vec![];
            for b in list {
                let t = b["type"].as_str().unwrap_or("").to_string();
                let from = (t == "synced_block")
                    .then(|| b["synced_block"]["synced_from"]["block_id"].as_str())
                    .flatten()
                    .map(String::from);
                let has = b["has_children"].as_bool() == Some(true) || from.is_some();
                let mut kids = vec![];
                if has && depth < 12 && t != "child_page" && t != "child_database" {
                    let kid = from.unwrap_or_else(|| b["id"].as_str().unwrap_or("").to_string());
                    match self.tree(kid, depth + 1).await {
                        Ok(k) => kids = k,
                        Err(e) if super::cancelled() => return Err(e),
                        Err(e) => warn(format!("un bloque no se pudo leer: {e}")),
                    }
                }
                out.push(Block { v: b, kids });
            }
            Ok(out)
        })
    }
}

struct Block {
    v: Value,
    kids: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq)]
enum Up {
    Root,
    Page(String),
    Db(String),
    Block(String),
}

fn up_of(o: &Value) -> Up {
    let p = &o["parent"];
    let id = |k: &str| nid(p[k].as_str().unwrap_or(""));
    match p["type"].as_str().unwrap_or("") {
        "page_id" => Up::Page(id("page_id")),
        "database_id" => Up::Db(id("database_id")),
        "data_source_id" => Up::Db(nid(p["database_id"].as_str().unwrap_or(""))),
        "block_id" => Up::Block(id("block_id")),
        _ => Up::Root,
    }
}

fn plain(rt: &Value) -> String {
    rt.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["plain_text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn title_of(o: &Value, untitled: &str) -> String {
    let t = if o["object"] == "database" {
        plain(&o["title"])
    } else {
        o["properties"]
            .as_object()
            .and_then(|m| m.values().find(|p| p["type"] == "title"))
            .map(|p| plain(&p["title"]))
            .unwrap_or_default()
    };
    let t = t.trim().replace('\n', " ");
    if t.is_empty() {
        untitled.into()
    } else {
        t
    }
}

struct Node {
    obj: Value,
    db: bool,
    title: String,
    up: Up,
    /// The page's `.md` (or the database's folder).
    rel: String,
    /// Where this page's files go.
    attach: String,
    kids: Vec<String>,
}

struct Cx<'a> {
    nodes: &'a HashMap<String, Node>,
    attach: String,
    downloads: Vec<(String, String)>,
}

impl Cx<'_> {
    fn link(&self, id: &str, text: &str) -> Option<String> {
        self.nodes.get(&nid(id)).map(|n| {
            wikilink(
                &n.rel,
                if text.trim().is_empty() {
                    &n.title
                } else {
                    text
                },
            )
        })
    }
}

pub async fn run(token: &str, out: &mut Out) -> Result<()> {
    let api = Api {
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?,
        files: reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()?,
        token: token.to_string(),
        base: base(),
        gate: tokio::sync::Mutex::new(Instant::now() - Duration::from_secs(1)),
    };

    // 1. Everything the integration can see.
    phase("Buscando páginas en Notion", 0);
    let found = api.all(Method::POST, "/v1/search", json!({})).await?;
    let mut nodes: HashMap<String, Node> = HashMap::new();
    let untitled = out.untitled();
    let add = |nodes: &mut HashMap<String, Node>, o: Value| {
        if o["archived"] == true || o["in_trash"] == true {
            return;
        }
        let kind = o["object"].as_str().unwrap_or("");
        if kind != "page" && kind != "database" {
            return;
        }
        let id = nid(o["id"].as_str().unwrap_or(""));
        if id.is_empty() || nodes.contains_key(&id) {
            return;
        }
        nodes.insert(
            id,
            Node {
                db: kind == "database",
                title: title_of(&o, untitled),
                up: up_of(&o),
                obj: o,
                rel: String::new(),
                attach: String::new(),
                kids: vec![],
            },
        );
    };
    for o in found {
        add(&mut nodes, o);
    }
    if nodes.is_empty() {
        bail!("la integración no ve ninguna página: en Notion, abrí la integración → Acceso y elegí las páginas a compartir");
    }
    set(|s| s.total = nodes.len());
    let dbs: Vec<String> = nodes
        .iter()
        .filter(|(_, n)| n.db)
        .map(|(k, _)| k.clone())
        .collect();
    for id in dbs {
        match api
            .all(
                Method::POST,
                &format!("/v1/databases/{id}/query"),
                json!({}),
            )
            .await
        {
            Ok(rows) => {
                for r in rows {
                    add(&mut nodes, r);
                }
            }
            Err(e) if super::cancelled() => return Err(e),
            Err(e) => warn(format!("no pude leer las filas de una base de datos: {e}")),
        }
    }

    // Pages inside blocks: walk up to the page or database that holds the block.
    let mut cache: HashMap<String, Up> = HashMap::new();
    let ids: Vec<String> = nodes.keys().cloned().collect();
    for id in ids {
        let Up::Block(b) = nodes[&id].up.clone() else {
            continue;
        };
        let mut cur = b;
        let mut seen = vec![];
        let up = loop {
            if let Some(u) = cache.get(&cur) {
                break u.clone();
            }
            if seen.len() > 30 {
                break Up::Root;
            }
            seen.push(cur.clone());
            match api
                .call(Method::GET, &format!("/v1/blocks/{cur}"), None)
                .await
            {
                Ok(v) => match up_of(&v) {
                    Up::Block(next) => cur = next,
                    u => break u,
                },
                Err(e) if super::cancelled() => return Err(e),
                Err(_) => break Up::Root,
            }
        };
        for s in seen {
            cache.insert(s, up.clone());
        }
        nodes.get_mut(&id).unwrap().up = up;
    }

    // 2. The tree and every page's place.
    let ids: Vec<String> = nodes.keys().cloned().collect();
    let mut roots = vec![];
    for id in &ids {
        let parent = match &nodes[id].up {
            Up::Page(p) | Up::Db(p) if nodes.contains_key(p) && p != id => Some(p.clone()),
            _ => None,
        };
        match parent {
            Some(p) => nodes.get_mut(&p).unwrap().kids.push(id.clone()),
            None => roots.push(id.clone()),
        }
    }
    let by_title = |nodes: &HashMap<String, Node>, v: &mut Vec<String>| {
        v.sort_by_key(|k| (nodes[k].title.to_lowercase(), k.clone()));
    };
    by_title(&nodes, &mut roots);
    for id in &ids {
        let mut k = nodes[id].kids.clone();
        by_title(&nodes, &mut k);
        nodes.get_mut(id).unwrap().kids = k;
    }
    let root = out.root.clone();
    let mut stack: Vec<(String, String, bool)> = roots
        .into_iter()
        .rev()
        .map(|id| (id, root.clone(), false))
        .collect();
    let mut guard = 0;
    while let Some((id, dir, row)) = stack.pop() {
        guard += 1;
        if guard > 200_000 {
            break;
        }
        let (db, title, kids) = {
            let n = &nodes[&id];
            (n.db, n.title.clone(), n.kids.clone())
        };
        let (rel, child_dir, attach) = if db {
            let f = out.reserve(&dir, &title, "");
            let columns: Vec<String> = nodes[&id].obj["properties"]
                .as_object()
                .map(|m| {
                    m.iter()
                        .filter(|(_, p)| p["type"] != "title")
                        .map(|(k, _)| k.clone())
                        .collect()
                })
                .unwrap_or_default();
            out.database(&f, &columns)?;
            (f.clone(), f.clone(), format!("{f}/attachments"))
        } else if row {
            let rel = out.reserve(&dir, &title, ".md");
            let cd = if kids.is_empty() {
                dir.clone()
            } else {
                out.reserve(&dir, &title, "")
            };
            (rel, cd, format!("{dir}/attachments"))
        } else if kids.is_empty() {
            (
                out.reserve(&dir, &title, ".md"),
                dir.clone(),
                format!("{dir}/attachments"),
            )
        } else {
            let f = out.reserve(&dir, &title, "");
            let rel = out.reserve(&f, &title, ".md");
            (rel, f.clone(), format!("{f}/attachments"))
        };
        {
            let n = nodes.get_mut(&id).unwrap();
            n.rel = rel;
            n.attach = attach;
        }
        for k in kids.into_iter().rev() {
            stack.push((k, child_dir.clone(), db));
        }
    }

    // 3. Contents.
    let mut pages: Vec<String> = nodes
        .iter()
        .filter(|(_, n)| !n.db && !n.rel.is_empty())
        .map(|(k, _)| k.clone())
        .collect();
    pages.sort_by_key(|k| nodes[k].rel.clone());
    phase("Copiando páginas", pages.len());
    let api_ref = &api;
    let mut stream = futures::stream::iter(pages.clone())
        .map(|id| async move {
            let r = api_ref.tree(id.clone(), 0).await;
            (id, r)
        })
        .buffered(3);
    while let Some((id, blocks)) = stream.next().await {
        if super::cancelled() {
            bail!("cancelado");
        }
        let n = &nodes[&id];
        let blocks = match blocks {
            Ok(b) => b,
            Err(e) => {
                if super::cancelled() {
                    return Err(e);
                }
                warn(format!("{}: {e}", n.title));
                vec![]
            }
        };
        let mut cx = Cx {
            nodes: &nodes,
            attach: n.attach.clone(),
            downloads: vec![],
        };
        let props = if matches!(n.up, Up::Db(ref d) if nodes.contains_key(d)) {
            props(&n.obj, out, &mut cx)
        } else {
            vec![]
        };
        let body = render(&blocks, out, &mut cx);
        for (url, rel) in std::mem::take(&mut cx.downloads) {
            if let Err(e) = download(&api.files, &url, out, &rel).await {
                warn(format!("{}: no se pudo bajar un archivo ({e})", n.title));
            }
        }
        if let Err(e) = out.page(&n.rel, &props, &body) {
            warn(format!("{}: {e}", n.title));
        }
        tick();
    }
    Ok(())
}

async fn download(c: &reqwest::Client, url: &str, out: &mut Out, rel: &str) -> Result<()> {
    let mut r = c.get(url).send().await?.error_for_status()?;
    let abs = out.v.abs(rel)?;
    if let Some(d) = abs.parent() {
        std::fs::create_dir_all(d)?;
    }
    out.v.mark_written(&abs);
    let mut f = std::fs::File::create(&abs)?;
    use std::io::Write;
    while let Some(chunk) = r.chunk().await? {
        f.write_all(&chunk)?;
    }
    set(|s| s.files += 1);
    Ok(())
}

/// A file name for a Notion-hosted file: its `name`, or the last part of the URL path.
fn file_name(d: &Value, url: &str) -> String {
    if let Some(n) = d["name"].as_str().filter(|n| !n.trim().is_empty()) {
        return n.to_string();
    }
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last = path.rsplit('/').next().unwrap_or("archivo");
    percent_encoding::percent_decode_str(last)
        .decode_utf8_lossy()
        .into_owned()
}

/// Rich text as Markdown: marks, links, mentions and inline equations.
fn rich(rt: &Value, cx: &Cx) -> String {
    let Some(a) = rt.as_array() else {
        return String::new();
    };
    let mut o = String::new();
    for x in a {
        let pt = x["plain_text"].as_str().unwrap_or("");
        let an = &x["annotations"];
        let (s, marks) = match x["type"].as_str().unwrap_or("") {
            "text" => {
                let content = x["text"]["content"].as_str().unwrap_or(pt).to_string();
                match x["text"]["link"]["url"].as_str() {
                    Some(u) => {
                        let internal = u.starts_with('/') || u.contains("notion.so/");
                        match id_in(u)
                            .filter(|_| internal)
                            .and_then(|id| cx.link(&id, &content))
                        {
                            Some(l) => (l, true),
                            None if u.starts_with('/') => (content, true),
                            None => (format!("[{}]({})", content.trim(), u), true),
                        }
                    }
                    None => (content, true),
                }
            }
            "mention" => {
                let m = &x["mention"];
                match m["type"].as_str().unwrap_or("") {
                    "page" => (
                        cx.link(m["page"]["id"].as_str().unwrap_or(""), pt)
                            .unwrap_or_else(|| pt.to_string()),
                        false,
                    ),
                    "database" => (
                        cx.link(m["database"]["id"].as_str().unwrap_or(""), pt)
                            .unwrap_or_else(|| pt.to_string()),
                        false,
                    ),
                    "date" => {
                        let d = &m["date"];
                        let mut s = short_iso(d["start"].as_str().unwrap_or(pt));
                        if let Some(e) = d["end"].as_str() {
                            s = format!("{s} → {}", short_iso(e));
                        }
                        (s, true)
                    }
                    "user" => (format!("@{}", pt.trim_start_matches('@')), true),
                    "link_preview" | "link_mention" => {
                        let u = m[m["type"].as_str().unwrap_or("")]["url"]
                            .as_str()
                            .or(m["link_mention"]["href"].as_str())
                            .unwrap_or(pt);
                        (format!("[{}]({u})", pt.trim()), false)
                    }
                    _ => (pt.to_string(), true),
                }
            }
            "equation" => (
                format!("${}$", x["equation"]["expression"].as_str().unwrap_or(pt)),
                false,
            ),
            _ => (pt.to_string(), true),
        };
        o.push_str(&if marks { mark(&s, an) } else { s });
    }
    o
}

/// Wraps text in Markdown marks, keeping spaces outside them (`** a **` is not bold).
fn mark(s: &str, an: &Value) -> String {
    let core = s.trim();
    if core.is_empty() {
        return s.to_string();
    }
    let lead = &s[..s.len() - s.trim_start().len()];
    let trail = &s[s.trim_end().len()..];
    let mut c = core.to_string();
    if an["code"] == true {
        c = format!("`{c}`");
    }
    if an["bold"] == true {
        c = format!("**{c}**");
    }
    if an["italic"] == true {
        c = format!("*{c}*");
    }
    if an["strikethrough"] == true {
        c = format!("~~{c}~~");
    }
    if an["color"]
        .as_str()
        .is_some_and(|x| x.ends_with("_background"))
    {
        c = format!("=={c}==");
    }
    format!("{lead}{c}{trail}")
}

fn indent(s: &str, pad: &str) -> String {
    s.lines()
        .map(|l| {
            if l.is_empty() {
                String::new()
            } else {
                format!("{pad}{l}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `text` as the first line of a list item whose other lines are indented under it.
fn item(marker: &str, text: &str, kids: &str) -> String {
    let pad = " ".repeat(marker.chars().count());
    let mut lines = text.lines();
    let mut o = format!("{marker}{}", lines.next().unwrap_or(""));
    for l in lines {
        o.push('\n');
        o.push_str(&pad);
        o.push_str(l);
    }
    if !kids.trim().is_empty() {
        o.push('\n');
        o.push_str(&indent(kids, &pad));
    }
    o
}

fn quoted(s: &str) -> String {
    s.lines()
        .map(|l| {
            if l.is_empty() {
                ">".to_string()
            } else {
                format!("> {l}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn details(summary: &str, kids: &str) -> String {
    format!(
        "<details>\n<summary>{}</summary>\n\n{}\n\n</details>",
        summary.replace('\n', " "),
        kids.trim_matches('\n')
    )
}

fn render(bs: &[Block], out: &mut Out, cx: &mut Cx) -> String {
    let mut parts: Vec<(bool, String)> = vec![];
    let mut num = 0;
    for b in bs {
        let t = b.v["type"].as_str().unwrap_or("");
        if t != "numbered_list_item" {
            num = 0;
        }
        let d = &b.v[t];
        let text = rich(&d["rich_text"], cx);
        let kids = if b.kids.is_empty() || t == "table" {
            String::new()
        } else {
            render(&b.kids, out, cx)
        };
        let (list, s) = match t {
            "paragraph" => (
                false,
                if kids.is_empty() {
                    text
                } else {
                    format!("{text}\n\n{kids}")
                },
            ),
            "heading_1" | "heading_2" | "heading_3" => {
                let h = &"###"[..t.as_bytes()[8] as usize - b'0' as usize];
                if d["is_toggleable"] == true && !kids.is_empty() {
                    (false, details(&text, &kids))
                } else {
                    (false, format!("{h} {text}\n\n{kids}"))
                }
            }
            "bulleted_list_item" => (true, item("- ", &text, &kids)),
            "numbered_list_item" => {
                num += 1;
                (true, item(&format!("{num}. "), &text, &kids))
            }
            "to_do" => {
                let x = if d["checked"] == true { "x" } else { " " };
                (true, item(&format!("- [{x}] "), &text, &kids))
            }
            "toggle" => (false, details(&text, &kids)),
            "quote" => (false, quoted(format!("{text}\n{kids}").trim_end())),
            "callout" => {
                let icon = d["icon"]["emoji"].as_str().unwrap_or("");
                let kind = callout_kind(icon);
                let first = if kind == "note" && !icon.is_empty() {
                    format!("{icon} {text}")
                } else {
                    text
                };
                let inner = format!("{first}\n{kids}");
                (false, format!("> [!{kind}]\n{}", quoted(inner.trim_end())))
            }
            "code" => {
                let lang = d["language"].as_str().unwrap_or("");
                let lang = if lang == "plain text" { "" } else { lang };
                (false, format!("```{lang}\n{}\n```", plain(&d["rich_text"])))
            }
            "equation" => (
                false,
                format!("$$\n{}\n$$", d["expression"].as_str().unwrap_or("")),
            ),
            "divider" => (false, "---".into()),
            "table" => (false, table(b, d, cx)),
            "image" | "file" | "pdf" | "video" | "audio" => (false, media(t, d, out, cx)),
            "bookmark" | "embed" | "link_preview" => {
                let u = d["url"].as_str().unwrap_or("");
                let cap = plain(&d["caption"]);
                let label = if cap.trim().is_empty() { u } else { cap.trim() };
                (
                    false,
                    if u.is_empty() {
                        String::new()
                    } else {
                        format!("[{label}]({u})")
                    },
                )
            }
            "child_page" | "child_database" => {
                let title = d["title"].as_str().unwrap_or("");
                let id = b.v["id"].as_str().unwrap_or("");
                (
                    false,
                    cx.link(id, title).unwrap_or_else(|| title.to_string()),
                )
            }
            "link_to_page" => {
                let id = d["page_id"]
                    .as_str()
                    .or(d["database_id"].as_str())
                    .unwrap_or("");
                (false, cx.link(id, "").unwrap_or_default())
            }
            "table_of_contents" | "breadcrumb" | "template" | "unsupported" => (false, kids),
            _ => (
                false,
                if text.is_empty() {
                    kids
                } else {
                    format!("{text}\n\n{kids}")
                },
            ),
        };
        let s = s.trim_end().to_string();
        if !s.is_empty() || t == "paragraph" {
            parts.push((list, s));
        }
    }
    let mut o = String::new();
    for (i, (list, s)) in parts.iter().enumerate() {
        if i > 0 {
            let tight = *list && parts[i - 1].0;
            o.push_str(if tight { "\n" } else { "\n\n" });
        }
        o.push_str(s);
    }
    o
}

fn table(b: &Block, d: &Value, cx: &Cx) -> String {
    let rows: Vec<Vec<String>> = b
        .kids
        .iter()
        .filter(|r| r.v["type"] == "table_row")
        .map(|r| {
            r.v["table_row"]["cells"]
                .as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .map(|c| rich(c, cx).replace('|', "\\|").replace('\n', " "))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    let w = d["table_width"]
        .as_u64()
        .map(|w| w as usize)
        .unwrap_or_else(|| rows.iter().map(|r| r.len()).max().unwrap_or(1))
        .max(1);
    if rows.is_empty() {
        return String::new();
    }
    let line = |r: &[String]| {
        let mut cells: Vec<String> = r.to_vec();
        cells.resize(w, String::new());
        format!("| {} |", cells.join(" | "))
    };
    let (head, rest): (Vec<String>, &[Vec<String>]) = if d["has_column_header"] == true {
        (rows[0].clone(), &rows[1..])
    } else {
        (vec![String::new(); w], &rows[..])
    };
    let mut o = vec![line(&head), format!("|{}", " --- |".repeat(w))];
    for r in rest {
        o.push(line(r));
    }
    o.join("\n")
}

fn media(t: &str, d: &Value, out: &mut Out, cx: &mut Cx) -> String {
    let cap = plain(&d["caption"]);
    let cap = cap.trim();
    let url = d["external"]["url"]
        .as_str()
        .or(d["file"]["url"].as_str())
        .unwrap_or("");
    if url.is_empty() {
        return String::new();
    }
    let hosted = d["type"] == "file" || d["type"] == "file_upload";
    let s = if hosted {
        let rel = out.reserve_file(&cx.attach, &file_name(d, url));
        cx.downloads.push((url.to_string(), rel.clone()));
        embed(&rel)
    } else if t == "image" {
        format!("![{cap}]({url})")
    } else {
        let label = if cap.is_empty() { url } else { cap };
        format!("[{label}]({url})")
    };
    if hosted && !cap.is_empty() {
        format!("{s}\n{cap}")
    } else {
        s
    }
}

/// A database row's properties, for the frontmatter.
fn props(o: &Value, out: &mut Out, cx: &mut Cx) -> Vec<(String, Value)> {
    let mut v = vec![];
    let Some(m) = o["properties"].as_object() else {
        return v;
    };
    for (k, p) in m {
        let t = p["type"].as_str().unwrap_or("");
        if t == "title" {
            continue;
        }
        if t == "date" {
            let start = p["date"]["start"].as_str().map(short_iso);
            v.push((k.clone(), json!(start.unwrap_or_default())));
            if let Some(e) = p["date"]["end"].as_str() {
                let end = if out.es { "fin" } else { "end" };
                v.push((format!("{k} ({end})"), json!(short_iso(e))));
            }
            continue;
        }
        let val = match t {
            "files" => json!(p["files"]
                .as_array()
                .map(|a| a
                    .iter()
                    .filter_map(|f| {
                        let url = f["external"]["url"]
                            .as_str()
                            .or(f["file"]["url"].as_str())?;
                        if f["type"] == "external" {
                            return Some(url.to_string());
                        }
                        let rel = out.reserve_file(&cx.attach, &file_name(f, url));
                        cx.downloads.push((url.to_string(), rel.clone()));
                        Some(format!("[[{rel}]]"))
                    })
                    .collect::<Vec<_>>())
                .unwrap_or_default()),
            "relation" => json!(p["relation"]
                .as_array()
                .map(|a| a
                    .iter()
                    .filter_map(|r| cx.link(r["id"].as_str()?, ""))
                    .collect::<Vec<_>>())
                .unwrap_or_default()),
            _ => value(p),
        };
        v.push((k.clone(), val));
    }
    v
}

/// A property value as JSON for the frontmatter (scalars and lists of strings).
fn value(p: &Value) -> Value {
    let t = p["type"].as_str().unwrap_or("");
    let x = &p[t];
    let name = |x: &Value| x["name"].as_str().unwrap_or("").to_string();
    let v = match t {
        "rich_text" | "title" => json!(plain(x)),
        "number" => x.clone(),
        "select" | "status" => json!(name(x)),
        "multi_select" => json!(x
            .as_array()
            .map(|a| a.iter().map(name).collect::<Vec<_>>())
            .unwrap_or_default()),
        "checkbox" => json!(x == true),
        "url" | "email" | "phone_number" => json!(x.as_str().unwrap_or("")),
        "people" => json!(x
            .as_array()
            .map(|a| a
                .iter()
                .map(name)
                .filter(|n| !n.is_empty())
                .collect::<Vec<_>>())
            .unwrap_or_default()),
        "created_by" | "last_edited_by" => json!(name(x)),
        "created_time" | "last_edited_time" => json!(short_iso(x.as_str().unwrap_or(""))),
        "date" => json!(x["start"].as_str().map(short_iso).unwrap_or_default()),
        "unique_id" => {
            let n = x["number"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_default();
            match x["prefix"].as_str() {
                Some(pre) if !pre.is_empty() => json!(format!("{pre}-{n}")),
                _ => json!(n),
            }
        }
        "verification" => json!(x["state"].as_str().unwrap_or("")),
        "formula" => match x["type"].as_str().unwrap_or("") {
            "string" => json!(x["string"].as_str().unwrap_or("")),
            "number" => x["number"].clone(),
            "boolean" => json!(x["boolean"] == true),
            "date" => json!(x["date"]["start"]
                .as_str()
                .map(short_iso)
                .unwrap_or_default()),
            _ => json!(""),
        },
        "rollup" => match x["type"].as_str().unwrap_or("") {
            "number" => x["number"].clone(),
            "date" => json!(x["date"]["start"]
                .as_str()
                .map(short_iso)
                .unwrap_or_default()),
            "array" => {
                let items: Vec<String> = x["array"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|i| match value(i) {
                                Value::String(s) => s,
                                Value::Array(l) => l
                                    .iter()
                                    .filter_map(|v| v.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", "),
                                Value::Null => String::new(),
                                o => o.to_string(),
                            })
                            .filter(|s| !s.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                json!(items)
            }
            _ => json!(""),
        },
        _ => json!(""),
    };
    if v.is_null() {
        json!("")
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(
            id_in("https://www.notion.so/My-Page-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?pvs=21")
                .as_deref(),
            Some("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d")
        );
        assert_eq!(
            id_in("/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d").as_deref(),
            Some("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d")
        );
        assert_eq!(id_in("https://example.com/abc"), None);
    }

    #[test]
    fn marks_keep_spaces_outside() {
        let an = json!({"bold": true});
        assert_eq!(mark("hola ", &an), "**hola** ");
        assert_eq!(mark(" ", &an), " ");
    }
}
