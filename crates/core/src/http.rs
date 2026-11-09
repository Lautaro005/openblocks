//! The local server the UI talks to (`127.0.0.1:47880`). It serves the app itself and a JSON API.
//! It only answers on loopback, checks the Host header (no DNS rebinding) and requires the
//! `X-OpenBlocks: 1` header on every request that changes something (no cross-site requests).

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::{BroadcastStream, UnboundedReceiverStream};
use tokio_stream::StreamExt;

use crate::vault::Vault;
use crate::{ai, artifact, family, preview, search, settings, sheet, sys, util, AppState, Shared};

#[derive(rust_embed::RustEmbed)]
#[folder = "../../apps/desktop/dist"]
struct Ui;

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(StatusCode::BAD_REQUEST, e.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError(StatusCode::BAD_REQUEST, e.to_string())
    }
}

type R<T = Json<Value>> = Result<T, ApiError>;

fn vault(st: &AppState) -> Result<Arc<Vault>, ApiError> {
    st.vault()
        .ok_or_else(|| ApiError(StatusCode::CONFLICT, "no hay un vault abierto".into()))
}

fn ok() -> R {
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PathQ {
    path: String,
    q: String,
    id: String,
    folder: String,
    name: String,
    limit: Option<usize>,
    refresh: bool,
    download: bool,
    theme: String,
}

// ---------- guard ----------

async fn guard(State(port): State<u16>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let allowed = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ];
    if !allowed.iter().any(|a| a == host) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    let m = req.method().clone();
    if m != Method::GET && m != Method::HEAD && m != Method::OPTIONS {
        let marked = req
            .headers()
            .get("x-openblocks")
            .and_then(|v| v.to_str().ok())
            == Some("1");
        if !marked {
            return (StatusCode::FORBIDDEN, "missing X-OpenBlocks header").into_response();
        }
    }
    let mut r = next.run(req).await;
    let h = r.headers_mut();
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert("referrer-policy", "no-referrer".parse().unwrap());
    r
}

// ---------- static UI ----------

async fn ui(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let file = Ui::get(path).or_else(|| {
        if path.contains('.') {
            None
        } else {
            Ui::get("index.html")
        }
    });
    match file {
        Some(f) => {
            let mime = mime_guess::from_path(if Ui::get(path).is_some() {
                path
            } else {
                "index.html"
            })
            .first_or_octet_stream();
            let cache = if path.starts_with("assets/") || path.starts_with("fonts/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_string()),
                    (header::CACHE_CONTROL, cache.to_string()),
                ],
                f.data.into_owned(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ---------- status, settings, vaults ----------

async fn status(State(st): State<Shared>) -> Json<Value> {
    let v = st.vault();
    let s = st.settings.read().unwrap();
    Json(json!({
        "app": "openblocks",
        "version": crate::VERSION,
        "vault": v.as_ref().map(|v| json!({"path": v.root, "name": v.name(), "stats": v.stats()})),
        "onboarded": s.onboarded,
        "english": s.english(),
        "platform": std::env::consts::OS,
    }))
}

async fn get_settings(State(st): State<Shared>) -> Json<Value> {
    Json(st.settings.read().unwrap().public())
}

async fn put_settings(State(st): State<Shared>, Json(patch): Json<Value>) -> R {
    let mut s = st.settings.write().unwrap();
    s.merge(&patch);
    settings::save(&s);
    Ok(Json(s.public()))
}

async fn pick(State(st): State<Shared>) -> R {
    let prompt = {
        let s = st.settings.read().unwrap();
        settings::tr(&s, "Elegí la carpeta del vault", "Choose the vault folder").to_string()
    };
    let p = tokio::task::spawn_blocking(move || crate::pick_folder(&prompt))
        .await
        .unwrap_or(None);
    Ok(Json(json!({"path": p})))
}

#[derive(Deserialize)]
struct OpenVault {
    path: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    guide: bool,
}

async fn open_vault(State(st): State<Shared>, Json(b): Json<OpenVault>) -> R {
    let p = util::expand(b.path.trim());
    if p.as_os_str().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "elegí una carpeta".into(),
        ));
    }
    let st2 = st.clone();
    let v = tokio::task::spawn_blocking(move || st2.open_vault(&p, b.name, b.guide))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))??;
    {
        let mut s = st.settings.write().unwrap();
        s.onboarded = true;
        settings::save(&s);
    }
    Ok(Json(
        json!({"path": v.root, "name": v.name(), "stats": v.stats()}),
    ))
}

async fn vaults(State(st): State<Shared>) -> Json<Value> {
    let s = st.settings.read().unwrap();
    let list: Vec<Value> = s
        .vaults
        .iter()
        .map(|v| json!({"path": v.path, "name": v.name, "opened": v.opened, "exists": v.path.is_dir()}))
        .collect();
    Json(json!(list))
}

async fn rename_vault(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let name = b["name"].as_str().unwrap_or("").trim().to_string();
    if !name.is_empty() {
        v.config.write().unwrap().name = name.clone();
        v.save_config();
        let mut s = st.settings.write().unwrap();
        s.remember_vault(&v.root, &name);
        settings::save(&s);
    }
    ok()
}

// ---------- tree and pages ----------

async fn tree(State(st): State<Shared>) -> R {
    let v = vault(&st)?;
    let cfg = v.config.read().unwrap().clone();
    Ok(Json(
        json!({"tree": v.tree(), "favorites": cfg.favorites, "collapsed": cfg.collapsed, "databases": cfg.databases.keys().collect::<Vec<_>>()}),
    ))
}

async fn get_page(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    Ok(Json(v.read_page(&q.path)?))
}

#[derive(Deserialize)]
struct SavePage {
    path: String,
    body: String,
    #[serde(default)]
    props: Option<Vec<Value>>,
    #[serde(default)]
    base: Option<u64>,
}

async fn save_page(State(st): State<Shared>, Json(b): Json<SavePage>) -> R {
    let v = vault(&st)?;
    // Refuse to overwrite a newer version written by another program.
    if let Some(base) = b.base {
        if let Ok(cur) = v.read_page(&b.path) {
            let m = cur["mtime"].as_u64().unwrap_or(0);
            if m > base + 1 && cur["body"].as_str() != Some(b.body.as_str()) {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "la página cambió afuera de OpenBlocks".into(),
                ));
            }
        }
    }
    let props: Option<Vec<(String, Value)>> = b.props.map(|ps| {
        ps.into_iter()
            .filter_map(|p| Some((p["key"].as_str()?.trim().to_string(), p["value"].clone())))
            .filter(|(k, _)| !k.is_empty())
            .collect()
    });
    let m = v.save_page(&b.path, &b.body, props.as_deref(), "edit")?;
    Ok(Json(json!({"mtime": m})))
}

async fn create_page(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let folder = b["folder"].as_str().unwrap_or("");
    let title = b["title"].as_str().unwrap_or("Sin título");
    let mut body = b["body"].as_str().unwrap_or("").to_string();
    if let Some(tpl) = b["template"].as_str().filter(|t| !t.is_empty()) {
        // A template that was deleted or moved gives a blank page instead of an error.
        if let Ok(t) = v.render_template(tpl, title) {
            body = t;
        }
    }
    let p = v.create_page(folder, title, &body)?;
    let _ = st.events.send(crate::Event::Tree);
    Ok(Json(json!({"path": p})))
}

async fn create_folder(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let p = v.create_folder(b["path"].as_str().unwrap_or("Nueva carpeta"))?;
    Ok(Json(json!({"path": p})))
}

async fn move_entry(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let from = b["from"].as_str().unwrap_or("").to_string();
    let to = b["to"].as_str().unwrap_or("").to_string();
    let (p, fixed) = tokio::task::spawn_blocking(move || v.move_entry(&from, &to))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))??;
    Ok(Json(json!({"path": p, "fixed": fixed})))
}

async fn trash_entry(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    vault(&st)?.trash(&q.path)?;
    ok()
}

async fn trash_list(State(st): State<Shared>) -> R {
    Ok(Json(json!(vault(&st)?.trash_list())))
}

async fn trash_restore(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let p = vault(&st)?.restore_trash(b["id"].as_str().unwrap_or(""))?;
    Ok(Json(json!({"path": p})))
}

async fn trash_empty(State(st): State<Shared>) -> R {
    let n = vault(&st)?.empty_trash()?;
    Ok(Json(json!({"deleted": n})))
}

async fn set_prop(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let val = if b["remove"].as_bool().unwrap_or(false) {
        None
    } else {
        Some(b["value"].clone())
    };
    v.set_prop(
        b["path"].as_str().unwrap_or(""),
        b["key"].as_str().unwrap_or(""),
        val,
    )?;
    ok()
}

async fn favorite(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let p = b["path"].as_str().unwrap_or("").to_string();
    let on = b["on"].as_bool().unwrap_or(true);
    {
        let mut c = v.config.write().unwrap();
        c.favorites.retain(|f| f != &p);
        if on {
            c.favorites.push(p);
        }
    }
    v.save_config();
    ok()
}

async fn collapsed(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let list: Vec<String> = b["collapsed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(|s| s.to_string()))
        .collect();
    v.config.write().unwrap().collapsed = list;
    v.save_config();
    ok()
}

// ---------- links, search, graph ----------

async fn search_h(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    Ok(Json(json!(search::search(&v, &q.q, q.limit.unwrap_or(40)))))
}

async fn titles(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    Ok(Json(json!(search::titles(&v, &q.q, q.limit.unwrap_or(12)))))
}

async fn folder_get(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    Ok(Json(vault(&st)?.folder_listing(&q.path)?))
}

async fn folder_view(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    v.set_folder_view(b["path"].as_str().unwrap_or(""), b["view"].clone());
    ok()
}

async fn resolve(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    if let Some(p) = v.resolve(&q.q) {
        let kind = if crate::vault::is_note(&p) {
            "page"
        } else {
            "file"
        };
        return Ok(Json(json!({"path": p, "kind": kind})));
    }
    // A link to a folder (a database imported from Notion, say) opens the folder.
    let t = q.q.trim().trim_matches('/');
    if !t.is_empty() && v.abs(t).map(|p| p.is_dir()).unwrap_or(false) {
        return Ok(Json(json!({"path": t, "kind": "folder"})));
    }
    Ok(Json(json!({"path": null})))
}

async fn backlinks(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    Ok(Json(vault(&st)?.backlinks(&q.path)))
}

async fn graph(State(st): State<Shared>) -> R {
    Ok(Json(vault(&st)?.graph()))
}

async fn tags(State(st): State<Shared>) -> R {
    Ok(Json(json!(vault(&st)?.tags())))
}

async fn recent(State(st): State<Shared>) -> R {
    Ok(Json(json!(vault(&st)?.recent(12))))
}

async fn database(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    Ok(Json(vault(&st)?.database(&q.folder)))
}

async fn database_view(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let folder = b["folder"].as_str().unwrap_or("").to_string();
    {
        let mut c = v.config.write().unwrap();
        if b["remove"].as_bool().unwrap_or(false) {
            c.databases.remove(&folder);
        } else {
            c.databases.insert(folder, b["view"].clone());
        }
    }
    v.save_config();
    ok()
}

// ---------- history ----------

async fn history(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    Ok(Json(json!(vault(&st)?.history(&q.path))))
}

async fn history_version(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let t = vault(&st)?.history_version(&q.path, &q.id)?;
    let p = crate::markdown::split(&t);
    Ok(Json(json!({"text": t, "body": p.body})))
}

async fn history_restore(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    vault(&st)?.restore_version(
        b["path"].as_str().unwrap_or(""),
        b["id"].as_str().unwrap_or(""),
    )?;
    ok()
}

// ---------- files ----------

async fn upload(State(st): State<Shared>, Query(q): Query<PathQ>, body: Bytes) -> R {
    let v = vault(&st)?;
    let p = v.save_upload(&q.folder, &q.name, &body)?;
    Ok(Json(json!({"path": p, "size": body.len()})))
}

async fn file(
    State(st): State<Shared>,
    Query(q): Query<PathQ>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let v = vault(&st)?;
    let abs = v.abs(&q.path)?;
    let meta = tokio::fs::metadata(&abs).await?;
    let len = meta.len();
    let mime = mime_guess::from_path(&abs)
        .first_or_octet_stream()
        .to_string();
    // HTML and SVG from the vault could run scripts; serve them as plain text / sandboxed.
    let mime = if mime.contains("html") {
        "text/plain; charset=utf-8".to_string()
    } else {
        mime
    };
    let mut extra: Vec<(header::HeaderName, String)> = vec![
        (header::CONTENT_TYPE, mime),
        (header::ACCEPT_RANGES, "bytes".into()),
        (header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'".into()),
        (header::CACHE_CONTROL, "no-cache".into()),
    ];
    if q.download {
        let name = abs
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        extra.push((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", name.replace('"', "")),
        ));
    }
    // Byte ranges, so audio and video can seek.
    if let Some(range) = headers
        .get(header::RANGE)
        .and_then(|r| r.to_str().ok())
        .and_then(|r| r.strip_prefix("bytes="))
    {
        let (a, b) = range.split_once('-').unwrap_or((range, ""));
        let start: u64 = a.parse().unwrap_or(0);
        let end: u64 = b
            .parse()
            .unwrap_or(len.saturating_sub(1))
            .min(len.saturating_sub(1));
        if start <= end && end < len {
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            let mut f = tokio::fs::File::open(&abs).await?;
            f.seek(std::io::SeekFrom::Start(start)).await?;
            let mut buf = vec![0u8; (end - start + 1).min(8 * 1024 * 1024) as usize];
            f.read_exact(&mut buf).await?;
            let real_end = start + buf.len() as u64 - 1;
            let mut resp = (StatusCode::PARTIAL_CONTENT, buf).into_response();
            for (k, val) in extra {
                resp.headers_mut().insert(k, val.parse().unwrap());
            }
            resp.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes {start}-{real_end}/{len}").parse().unwrap(),
            );
            return Ok(resp);
        }
    }
    let data = tokio::fs::read(&abs).await?;
    let mut resp = data.into_response();
    for (k, val) in extra {
        resp.headers_mut().insert(k, val.parse().unwrap());
    }
    Ok(resp)
}

async fn preview_h(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    let abs = v.abs(&q.path)?;
    let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
    let r = tokio::task::spawn_blocking(move || preview::preview(&abs))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))??;
    let mut r = r;
    r["size"] = json!(size);
    Ok(Json(r))
}

// ---------- artifacts and spreadsheets ----------

/// An HTML artifact as a page of its own, sandboxed, with its linked spreadsheets as data.
async fn artifact_page(
    State(st): State<Shared>,
    Query(q): Query<PathQ>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let v = vault(&st)?;
    let abs = v.abs(&q.path)?;
    let html = tokio::fs::read_to_string(&abs).await?;
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1")
        .to_string();
    let rel = q.path.clone();
    let theme = q.theme.clone();
    let page = tokio::task::spawn_blocking(move || artifact::render(&v, &rel, &html, &theme))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let mut r = page.into_response();
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        "text/html; charset=utf-8".parse().unwrap(),
    );
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        artifact::csp(&host)
            .parse()
            .map_err(|_| anyhow::anyhow!("csp"))?,
    );
    Ok(r)
}

/// The spreadsheets an artifact uses, and where each one is in the vault.
async fn artifact_info(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    let html = std::fs::read_to_string(v.abs(&q.path)?)?;
    let sources: Vec<Value> = artifact::data_sources(&html)
        .into_iter()
        .map(|s| {
            let path = artifact::resolve_source(&v, &q.path, &s);
            json!({"name": s, "path": path})
        })
        .collect();
    Ok(Json(json!({"sources": sources})))
}

/// Changes which spreadsheets an artifact uses (its `openblocks-data` meta tag).
async fn artifact_data(
    State(st): State<Shared>,
    Query(q): Query<PathQ>,
    Json(b): Json<Value>,
) -> R {
    let v = vault(&st)?;
    let html = std::fs::read_to_string(v.abs(&q.path)?)?;
    let sources: Vec<String> = b["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();
    let out = artifact::set_data_sources(&html, &sources);
    v.snapshot(&q.path, &html, "edit");
    v.write_raw(&q.path, &out)?;
    let _ = st.events.send(crate::Event::Changed {
        paths: vec![q.path.clone()],
    });
    Ok(Json(json!({"ok": true, "text": out})))
}

async fn sheet_get(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    let abs = v.abs(&q.path)?;
    let r = tokio::task::spawn_blocking(move || sheet::read(&abs))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))??;
    let mut r = r;
    r["writable"] = json!(sheet::can_write(&v.abs(&q.path)?));
    Ok(Json(r))
}

#[derive(Deserialize)]
struct SheetBody {
    sheets: Vec<sheet::SheetIn>,
}

async fn sheet_put(
    State(st): State<Shared>,
    Query(q): Query<PathQ>,
    Json(b): Json<SheetBody>,
) -> R {
    let v = vault(&st)?;
    let abs = v.abs(&q.path)?;
    let bytes = sheet::encode(&abs, &b.sheets)?;
    v.write_bytes(&q.path, &bytes)?;
    let _ = st.events.send(crate::Event::Changed {
        paths: vec![q.path.clone()],
    });
    Ok(Json(json!({"ok": true, "size": bytes.len()})))
}

/// Text files the app edits in place (an artifact's code). Pages go through /api/page.
const TEXT_EXT: &[&str] = &[
    "html", "htm", "css", "js", "mjs", "json", "txt", "svg", "csv", "tsv", "xml", "yaml", "yml",
];

async fn text_put(State(st): State<Shared>, Query(q): Query<PathQ>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let ext = q
        .path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !TEXT_EXT.contains(&ext.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "este tipo de archivo no se edita como texto".into(),
        ));
    }
    let text = b["text"].as_str().unwrap_or("");
    if let Ok(before) = std::fs::read_to_string(v.abs(&q.path)?) {
        v.snapshot(&q.path, &before, "edit");
    }
    v.write_raw(&q.path, text)?;
    v.reindex_one(&q.path);
    let _ = st.events.send(crate::Event::Changed {
        paths: vec![q.path.clone()],
    });
    Ok(Json(json!({"ok": true})))
}

/// New artifact (`kind: "html"`) or spreadsheet (`kind: "xlsx"`) in a folder.
async fn file_create(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let folder = b["folder"].as_str().unwrap_or("").trim().trim_matches('/');
    let name = crate::vault::clean_name(b["name"].as_str().unwrap_or("").trim());
    let kind = b["kind"].as_str().unwrap_or("html");
    let sources: Vec<String> = b["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(String::from))
        .collect();
    let rel = match kind {
        "xlsx" => {
            let base = if name.is_empty() {
                "Planilla".to_string()
            } else {
                name
            };
            let rel = v.free_name(folder, &base, ".xlsx")?;
            let sheets = vec![sheet::SheetIn {
                name: "Hoja1".into(),
                rows: vec![vec![json!("Nombre"), json!("Valor")]],
                formulas: Default::default(),
            }];
            v.write_bytes(&rel, &sheet::encode(Path::new(&rel), &sheets)?)?;
            rel
        }
        _ => {
            let base = if name.is_empty() {
                "Artefacto".to_string()
            } else {
                name
            };
            let rel = v.free_name(folder, &base, ".html")?;
            v.write_raw(&rel, &artifact::template(&base, &sources))?;
            v.reindex_one(&rel);
            rel
        }
    };
    let _ = st.events.send(crate::Event::Tree);
    Ok(Json(json!({"path": rel})))
}

/// The window's zoom (Settings → Appearance, ⌘+ / ⌘-).
async fn zoom_h(Json(b): Json<Value>) -> R {
    let f = b["factor"].as_f64().unwrap_or(1.0);
    Ok(Json(json!({"native": crate::zoom(f)})))
}

async fn open_h(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    if let Some(url) = b["url"].as_str() {
        sys::open_url(url)?;
        return ok();
    }
    let v = vault(&st)?;
    let rel = b["path"].as_str().unwrap_or("");
    let abs = if rel.is_empty() {
        v.root.clone()
    } else {
        v.abs(rel)?
    };
    if b["reveal"].as_bool().unwrap_or(false) {
        sys::reveal(&abs)?;
    } else {
        sys::open_path(&abs)?;
    }
    ok()
}

async fn daily(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    let folder = st.settings.read().unwrap().daily_folder.clone();
    let date = if q.name.is_empty() {
        util::today()
    } else {
        q.name.clone()
    };
    let p = v.daily(&folder, &date)?;
    Ok(Json(json!({"path": p})))
}

async fn templates(State(st): State<Shared>) -> R {
    let v = vault(&st)?;
    let folder = st.settings.read().unwrap().templates_folder.clone();
    Ok(Json(json!(v.templates(&folder))))
}

// ---------- events ----------

async fn events(State(st): State<Shared>) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = st.events.subscribe();
    let s = BroadcastStream::new(rx)
        .filter_map(|e| e.ok())
        .map(|e| Ok(SseEvent::default().data(serde_json::to_string(&e).unwrap_or_default())));
    Sse::new(s).keep_alive(KeepAlive::default())
}

// ---------- AI ----------

async fn ai_models(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    Ok(Json(json!(ai::models(&st, q.refresh).await)))
}

fn sse_from(
    rx: tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let s = UnboundedReceiverStream::new(rx).map(|v| Ok(SseEvent::default().data(v.to_string())));
    Sse::new(s).keep_alive(KeepAlive::default())
}

async fn ai_send(
    State(st): State<Shared>,
    Json(req): Json<ai::SendReq>,
) -> Result<Response, ApiError> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    ai::send(st, req, tx).await?;
    Ok(sse_from(rx).into_response())
}

async fn ai_inline(State(st): State<Shared>, Json(b): Json<Value>) -> Result<Response, ApiError> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let tx2 = tx.clone();
    tokio::spawn(async move {
        let r = ai::inline(
            st,
            b["action"].as_str().unwrap_or(""),
            b["text"].as_str().unwrap_or(""),
            b["extra"].as_str().unwrap_or(""),
            b["model"].as_str().unwrap_or(""),
            tx2.clone(),
        )
        .await;
        if let Err(e) = r {
            let _ = tx2.send(json!({"kind": "error", "text": e.to_string()}));
        }
        let _ = tx2.send(json!({"kind": "done"}));
    });
    drop(tx);
    Ok(sse_from(rx).into_response())
}

async fn ai_stop(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    if let Some(c) = st
        .ai
        .running
        .lock()
        .unwrap()
        .get(b["chat"].as_str().unwrap_or(""))
    {
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    ok()
}

async fn ai_chats(State(st): State<Shared>) -> R {
    let v = vault(&st)?;
    Ok(Json(json!(ai::list_chats(&v))))
}

async fn ai_chat(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    let c = ai::load_chat(&v, &q.id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no existe".into()))?;
    let running = st.ai.running.lock().unwrap().contains_key(&c.id);
    let mut val = serde_json::to_value(c).unwrap_or(Value::Null);
    val["running"] = json!(running);
    Ok(Json(val))
}

async fn ai_chat_delete(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let v = vault(&st)?;
    ai::delete_chat(&v, &q.id)?;
    ok()
}

/// Undo of an agent change: restore the version saved before an edit, trash what it created, move
/// back what it moved, restore what it deleted.
async fn ai_undo(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let path = b["path"].as_str().unwrap_or("");
    match b["action"].as_str().unwrap_or("") {
        "create" | "folder" => {
            v.trash(path)?;
        }
        "move" => {
            let from = b["from"].as_str().unwrap_or("");
            v.move_entry(path, from)?;
        }
        "delete" => {
            v.restore_trash(b["trash"].as_str().unwrap_or(""))?;
        }
        // A file the agent wrote over: the new one goes to the trash, the old one comes back.
        "replace" => {
            v.trash(path)?;
            v.restore_trash(b["trash"].as_str().unwrap_or(""))?;
        }
        _ => {
            let id = b["version"].as_str().unwrap_or("");
            if id.is_empty() {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "no hay una versión anterior".into(),
                ));
            }
            v.restore_version(path, id)?;
        }
    }
    ok()
}

/// A file attached in the chat (kept in `.openblocks/chat-files`, not in the vault's pages).
async fn ai_attach(State(st): State<Shared>, Query(q): Query<PathQ>, body: Bytes) -> R {
    let v = vault(&st)?;
    if body.len() > 64 * 1024 * 1024 {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "el archivo pesa más de 64 MB".into(),
        ));
    }
    let name = q.name.clone();
    let r = tokio::task::spawn_blocking(move || ai::save_attachment(&v, &name, &body))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))??;
    Ok(Json(r))
}

// ---------- family ----------

async fn family_status(State(st): State<Shared>) -> R {
    let s = st.settings.read().unwrap().clone();
    Ok(Json(family::status(&s).await))
}

async fn family_open(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let s = st.settings.read().unwrap().clone();
    family::open_app(b["id"].as_str().unwrap_or(""), &s)?;
    ok()
}

async fn family_brain_save(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let v = vault(&st)?;
    let path = b["path"].as_str().unwrap_or("").to_string();
    let page = v.read_page(&path)?;
    let title = page["title"].as_str().unwrap_or("").to_string();
    let body = page["body"].as_str().unwrap_or("").to_string();
    let name = v.name();
    let r = tokio::task::spawn_blocking(move || family::brain_save(&title, &name, &body))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))??;
    Ok(Json(json!({"path": r})))
}

async fn family_search(State(st): State<Shared>, Query(q): Query<PathQ>) -> R {
    let s = st.settings.read().unwrap().clone();
    let r = match q.name.as_str() {
        "brain" => family::brain_search(&s, &q.q, 8).await?,
        "lumina" => family::lumina_search(&s, &q.q, 8).await?,
        _ => return Err(ApiError(StatusCode::BAD_REQUEST, "app desconocida".into())),
    };
    Ok(Json(json!(r)))
}

async fn family_workstudio(Json(b): Json<Value>) -> R {
    family::workstudio_register(b["on"].as_bool().unwrap_or(true))?;
    ok()
}

// ---------- updates ----------

async fn update_check() -> R {
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        crate::REPO
    );
    let r = crate::web::client()
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await;
    let latest = match r {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().and_then(|v| {
            v["tag_name"]
                .as_str()
                .map(|s| s.trim_start_matches('v').to_string())
        }),
        _ => None,
    };
    let newer = latest
        .as_deref()
        .is_some_and(|l| version_gt(l, crate::VERSION));
    Ok(Json(
        json!({"current": crate::VERSION, "latest": latest, "update": newer}),
    ))
}

fn version_gt(a: &str, b: &str) -> bool {
    let p = |s: &str| -> Vec<u64> { s.split(['.', '-']).filter_map(|x| x.parse().ok()).collect() };
    p(a) > p(b)
}

/// Runs the installer again (the same one-liner the user installed with) in the background.
async fn update_run() -> R {
    let cmd = if cfg!(windows) {
        format!(
            "irm https://raw.githubusercontent.com/{}/main/install.ps1 | iex",
            crate::REPO
        )
    } else {
        format!(
            "curl -fsSL https://raw.githubusercontent.com/{}/main/install.sh | sh -s -- --restart",
            crate::REPO
        )
    };
    let mut c = if cfg!(windows) {
        let mut c = util::command("powershell");
        c.args(["-NoProfile", "-Command", &cmd]);
        c
    } else {
        let mut c = util::command("sh");
        c.args(["-c", &cmd]);
        c
    };
    let log = util::home_dir().join("update.log");
    if let Ok(f) = std::fs::File::create(&log) {
        if let Ok(f2) = f.try_clone() {
            c.stdout(f).stderr(f2);
        }
    }
    c.spawn()?;
    ok()
}

// ---------- import ----------

async fn import_status() -> R {
    Ok(Json(json!(crate::import::status())))
}

async fn import_cancel() -> R {
    crate::import::cancel();
    ok()
}

async fn import_token(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    crate::import::start_token(
        st,
        b["token"].as_str().unwrap_or("").to_string(),
        b["folder"].as_str().unwrap_or("").to_string(),
    )?;
    ok()
}

async fn import_export(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let paths: Vec<std::path::PathBuf> = b["paths"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str())
                .map(util::expand)
                .collect()
        })
        .unwrap_or_default();
    crate::import::start_export(
        st,
        paths,
        b["folder"].as_str().unwrap_or("").to_string(),
        false,
    )?;
    ok()
}

/// A dropped export, streamed to a temporary file (exports can be gigabytes), then imported.
async fn import_upload(
    State(st): State<Shared>,
    Query(q): Query<PathQ>,
    body: axum::body::Body,
) -> R {
    use tokio::io::AsyncWriteExt;
    let dir = std::env::temp_dir().join(format!("openblocks-upload-{}", util::new_id()));
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join("notion-export.zip");
    let mut f = tokio::fs::File::create(&path).await?;
    let mut s = body.into_data_stream();
    while let Some(chunk) = s.next().await {
        let chunk = chunk.map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
        f.write_all(&chunk).await?;
    }
    f.flush().await?;
    drop(f);
    let r = crate::import::start_export(st, vec![path.clone()], q.folder.clone(), true);
    if r.is_err() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    r?;
    ok()
}

async fn import_pick(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    let folder = b["kind"] == "folder";
    let prompt = {
        let s = st.settings.read().unwrap();
        if folder {
            settings::tr(
                &s,
                "Elegí la carpeta de la exportación de Notion",
                "Choose the Notion export folder",
            )
        } else {
            settings::tr(
                &s,
                "Elegí el .zip que exportaste de Notion",
                "Choose the .zip you exported from Notion",
            )
        }
        .to_string()
    };
    let kind = if folder {
        crate::Pick::Folder
    } else {
        crate::Pick::Zips
    };
    let p = tokio::task::spawn_blocking(move || crate::pick(&prompt, kind))
        .await
        .unwrap_or(None);
    Ok(Json(json!({"paths": p.unwrap_or_default()})))
}

async fn quit() -> R {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        crate::localai::shutdown().await;
        crate::remote::stop().await;
        std::process::exit(0);
    });
    ok()
}

// ---------- remote MCP and local models ----------

async fn remote_get() -> R {
    Ok(Json(crate::remote::public()))
}

async fn remote_put(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    Ok(Json(crate::remote::configure(&st, &b).await?))
}

async fn remote_token() -> R {
    Ok(Json(crate::remote::regenerate()?))
}

async fn remote_install() -> R {
    crate::remote::install_start();
    ok()
}

async fn remote_reconnect(State(st): State<Shared>) -> R {
    crate::remote::start(st).await?;
    Ok(Json(crate::remote::public()))
}

async fn local_get() -> R {
    Ok(Json(crate::localai::status()))
}

async fn local_download(State(st): State<Shared>, Json(b): Json<Value>) -> R {
    crate::localai::download(b["id"].as_str().unwrap_or(""))?;
    // The model list changes when the download ends; forget the cached one.
    *st.ai.models_cache_reset() = None;
    ok()
}

pub fn router(st: Shared, port: u16) -> Router {
    let api = Router::new()
        .route("/api/status", get(status))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/pick-folder", post(pick))
        .route("/api/vault/open", post(open_vault))
        .route("/api/vault/rename", post(rename_vault))
        .route("/api/vaults", get(vaults))
        .route("/api/tree", get(tree))
        .route("/api/page", get(get_page).put(save_page))
        .route("/api/page/create", post(create_page))
        .route("/api/folder", post(create_folder).get(folder_get))
        .route("/api/folder/view", put(folder_view))
        .route("/api/move", post(move_entry))
        .route("/api/entry", delete(trash_entry))
        .route("/api/trash", get(trash_list).delete(trash_empty))
        .route("/api/trash/restore", post(trash_restore))
        .route("/api/property", put(set_prop))
        .route("/api/favorite", post(favorite))
        .route("/api/collapsed", post(collapsed))
        .route("/api/search", get(search_h))
        .route("/api/titles", get(titles))
        .route("/api/resolve", get(resolve))
        .route("/api/backlinks", get(backlinks))
        .route("/api/graph", get(graph))
        .route("/api/tags", get(tags))
        .route("/api/recent", get(recent))
        .route("/api/database", get(database).put(database_view))
        .route("/api/history", get(history))
        .route("/api/history/version", get(history_version))
        .route("/api/history/restore", post(history_restore))
        .route("/api/upload", post(upload))
        .route("/api/file", get(file))
        .route("/api/preview", get(preview_h))
        .route("/api/artifact", get(artifact_page))
        .route("/api/artifact/info", get(artifact_info))
        .route("/api/artifact/data", put(artifact_data))
        .route("/api/sheet", get(sheet_get).put(sheet_put))
        .route("/api/text", put(text_put))
        .route("/api/file/create", post(file_create))
        .route("/api/zoom", post(zoom_h))
        .route("/api/open", post(open_h))
        .route("/api/daily", post(daily))
        .route("/api/templates", get(templates))
        .route("/api/events", get(events))
        .route("/api/ai/models", get(ai_models))
        .route("/api/ai/send", post(ai_send))
        .route("/api/ai/inline", post(ai_inline))
        .route("/api/ai/stop", post(ai_stop))
        .route("/api/ai/chats", get(ai_chats))
        .route("/api/ai/chat", get(ai_chat).delete(ai_chat_delete))
        .route("/api/ai/undo", post(ai_undo))
        .route("/api/ai/attach", post(ai_attach))
        .route("/api/family", get(family_status))
        .route("/api/family/open", post(family_open))
        .route("/api/family/brain/save", post(family_brain_save))
        .route("/api/family/search", get(family_search))
        .route("/api/family/workstudio", post(family_workstudio))
        .route("/api/update", get(update_check).post(update_run))
        .route("/api/quit", post(quit))
        .route("/api/remote", get(remote_get).put(remote_put))
        .route("/api/remote/token", post(remote_token))
        .route("/api/remote/install", post(remote_install))
        .route("/api/remote/reconnect", post(remote_reconnect))
        .route("/api/local", get(local_get))
        .route("/api/local/download", post(local_download))
        .route("/api/import", get(import_status))
        .route("/api/import/cancel", post(import_cancel))
        .route("/api/import/pick", post(import_pick))
        .route("/api/import/notion/token", post(import_token))
        .route("/api/import/notion/export", post(import_export))
        .route("/api/import/notion/upload", post(import_upload))
        .with_state(st);
    api.fallback(ui)
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(port, guard))
}

/// Binds the server. Returns the port it ended up on (another free one if `port` is taken by
/// something that is not OpenBlocks).
pub async fn bind(port: u16) -> anyhow::Result<(tokio::net::TcpListener, u16)> {
    for p in [port, 0] {
        if let Ok(l) = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], p))).await {
            let real = l.local_addr()?.port();
            return Ok((l, real));
        }
    }
    anyhow::bail!("no free port")
}

pub async fn serve(st: Shared, listener: tokio::net::TcpListener, port: u16) -> anyhow::Result<()> {
    crate::localai::cleanup_stale();
    crate::remote::start_if_enabled(st.clone());
    axum::serve(listener, router(st, port))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    crate::localai::shutdown().await;
    crate::remote::stop().await;
    Ok(())
}

/// Is an OpenBlocks server already answering on this port?
pub async fn running_on(port: u16) -> bool {
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .no_proxy()
        .build();
    let Ok(c) = c else { return false };
    match c
        .get(format!("http://127.0.0.1:{port}/api/status"))
        .send()
        .await
    {
        Ok(r) => r
            .text()
            .await
            .map(|t| t.contains("\"openblocks\""))
            .unwrap_or(false),
        Err(_) => false,
    }
}
