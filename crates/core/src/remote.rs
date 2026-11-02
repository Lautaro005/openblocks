//! Remote access: the MCP server by URL, published with a Cloudflare tunnel (the same design as
//! brain). Agents that run in the cloud (Claude.ai, ChatGPT, Manus…) or on another computer connect
//! with a URL.
//!
//! - A second local listener on `127.0.0.1:47890` serves MCP over streamable HTTP (JSON responses)
//!   and nothing else.
//! - `cloudflared` publishes that port. "quick" mode needs no account (a `*.trycloudflare.com` URL
//!   that changes each time); "named" mode uses a tunnel of the user's Cloudflare account (tunnel
//!   token + their hostname) with a fixed URL.
//!
//! Security: the URL carries a secret token (`https://…/<token>/mcp`); without it every request
//! gets 404. `Authorization: Bearer <token>` on `/mcp` works too. Regenerating the token cuts the old
//! URL at once. Read-only mode hides and refuses every tool that changes the vault. The config lives
//! in `~/.openblocks/remote.json` (0600). `cloudflared` comes from Cloudflare's GitHub release and is
//! checked against the SHA256 Cloudflare publishes.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;

use crate::mcp_server::McpServer;
use crate::{util, Shared};

pub fn port() -> u16 {
    std::env::var("OPENBLOCKS_REMOTE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(47890)
}

const CF_RELEASES: &str = "https://github.com/cloudflare/cloudflared/releases";
const CF_API: &str = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub token: String,
    pub enabled: bool,
    pub read_only: bool,
    /// "quick" | "named"
    pub mode: String,
    pub hostname: String,
    pub tunnel_token: String,
    pub keep_awake: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            token: String::new(),
            enabled: false,
            read_only: false,
            mode: "quick".into(),
            hostname: String::new(),
            tunnel_token: String::new(),
            keep_awake: true,
        }
    }
}

fn config_path() -> PathBuf {
    util::home_dir().join("remote.json")
}

fn new_token() -> String {
    let mut b = [0u8; 24];
    if getrandom(&mut b).is_err() {
        // Fall back to time + address entropy; still unguessable enough for a URL secret.
        let seed = format!("{}{:p}{}", util::now_ms(), &b, std::process::id());
        b.copy_from_slice(&sha2::Sha256::digest(seed.as_bytes())[..24]);
    }
    b.iter()
        .map(|x| {
            const A: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            A[*x as usize % A.len()] as char
        })
        .collect()
}

fn getrandom(buf: &mut [u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")?.read_exact(buf)
    }
    #[cfg(not(unix))]
    {
        // Windows: hash several high-resolution clocks and the process id.
        let mut h = sha2::Sha256::new();
        for _ in 0..64 {
            h.update(format!("{:?}{}", std::time::Instant::now(), util::now_ms()));
        }
        h.update(std::process::id().to_le_bytes());
        let d = h.finalize();
        buf.copy_from_slice(&d[..buf.len()]);
        Ok(())
    }
}

pub fn load() -> Config {
    let mut c: Config = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if c.token.is_empty() {
        c.token = new_token();
        let _ = save(&c);
    }
    c
}

fn save(c: &Config) -> Result<()> {
    let p = config_path();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(c)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

// ---------- runtime ----------

#[derive(Default)]
struct Rt {
    tunnel: Option<tokio::process::Child>,
    awake: Option<tokio::process::Child>,
    url: Option<String>,
    logs: VecDeque<String>,
    error: String,
    listening: bool,
    /// Bumped on every start/stop, so an old supervisor loop knows it must end.
    generation: u64,
    installing: bool,
}

fn rt() -> &'static Mutex<Rt> {
    static R: OnceLock<Mutex<Rt>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Rt::default()))
}

/// The MCP server behind the URL, kept between requests and rebuilt when the vaults or the
/// read-only setting change.
type McpCache = tokio::sync::Mutex<Option<(String, Arc<McpServer>)>>;

fn mcp_cache() -> &'static McpCache {
    static C: OnceLock<McpCache> = OnceLock::new();
    C.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn log(line: impl Into<String>) {
    let mut r = rt().lock().unwrap();
    r.logs.push_back(line.into());
    while r.logs.len() > 200 {
        r.logs.pop_front();
    }
}

pub fn cloudflared_path() -> Option<PathBuf> {
    if let Some(p) = util::which("cloudflared") {
        return Some(p);
    }
    let p = local_bin();
    p.exists().then_some(p)
}

fn local_bin() -> PathBuf {
    util::home_dir().join("bin").join(if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    })
}

/// What the Settings card shows (no tunnel token, only whether there is one).
pub fn public() -> Value {
    let c = load();
    let r = rt().lock().unwrap();
    let base = if c.mode == "named" && !c.hostname.is_empty() {
        r.url
            .clone()
            .or_else(|| r.tunnel.as_ref().map(|_| format!("https://{}", c.hostname)))
    } else {
        r.url.clone()
    };
    json!({
        "enabled": c.enabled,
        "read_only": c.read_only,
        "mode": c.mode,
        "hostname": c.hostname,
        "has_tunnel_token": !c.tunnel_token.is_empty(),
        "keep_awake": c.keep_awake,
        "port": port(),
        "token": c.token,
        "base_url": base,
        "url": base.as_ref().map(|b| format!("{}/{}/mcp", b.trim_end_matches('/'), c.token)),
        "local_url": format!("http://127.0.0.1:{}/{}/mcp", port(), c.token),
        "cloudflared": cloudflared_path(),
        "installing": r.installing,
        "running": r.tunnel.is_some(),
        "listening": r.listening,
        "error": r.error,
        "logs": r.logs.iter().rev().take(12).rev().cloned().collect::<Vec<_>>(),
    })
}

fn valid_hostname(h: &str) -> bool {
    let labels: Vec<&str> = h.split('.').collect();
    h.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                && !l.starts_with('-')
                && !l.ends_with('-')
        })
}

/// Applies a change from Settings and starts, stops or restarts what is needed.
pub async fn configure(st: &Shared, body: &Value) -> Result<Value> {
    let mut c = load();
    let before = c.clone();
    if let Some(v) = body.get("read_only").and_then(|v| v.as_bool()) {
        c.read_only = v;
    }
    if let Some(v) = body.get("keep_awake").and_then(|v| v.as_bool()) {
        c.keep_awake = v;
    }
    if let Some(m) = body.get("mode").and_then(|v| v.as_str()) {
        if m != "quick" && m != "named" {
            bail!("modo desconocido");
        }
        c.mode = m.into();
    }
    if let Some(h) = body.get("hostname").and_then(|v| v.as_str()) {
        let h = h
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_lowercase();
        if !h.is_empty() && !valid_hostname(&h) {
            bail!("ese dominio no es válido");
        }
        c.hostname = h;
    }
    if let Some(t) = body
        .get("tunnel_token")
        .and_then(|v| v.as_str())
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
    {
        // Cloudflare shows "cloudflared service install <token>": accept the whole command.
        let t = t.split_whitespace().last().unwrap_or(t);
        if t.len() < 20
            || !t
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-=+/.".contains(c))
        {
            bail!("ese token de túnel no es válido");
        }
        c.tunnel_token = t.into();
    }
    if let Some(v) = body.get("enabled").and_then(|v| v.as_bool()) {
        c.enabled = v;
    }
    if c.enabled && c.mode == "named" && (c.hostname.is_empty() || c.tunnel_token.is_empty()) {
        bail!("para un túnel con nombre hacen falta el dominio y el token del túnel");
    }
    save(&c)?;
    let restart = c.enabled
        && (!before.enabled
            || before.mode != c.mode
            || before.hostname != c.hostname
            || before.tunnel_token != c.tunnel_token
            || before.keep_awake != c.keep_awake);
    if !c.enabled && before.enabled {
        stop().await;
    } else if restart {
        start(st.clone()).await?;
    }
    if before.read_only != c.read_only {
        *mcp_cache().lock().await = None;
    }
    Ok(public())
}

pub fn regenerate() -> Result<Value> {
    let mut c = load();
    c.token = new_token();
    save(&c)?;
    Ok(public())
}

/// Starts the remote MCP listener and the tunnel when remote access is on (at app start).
pub fn start_if_enabled(st: Shared) {
    if load().enabled {
        tokio::spawn(async move {
            if let Err(e) = start(st).await {
                rt().lock().unwrap().error = e.to_string();
            }
        });
    }
}

pub async fn start(st: Shared) -> Result<()> {
    stop().await;
    listen(st).await?;
    let exe = cloudflared_path()
        .ok_or_else(|| anyhow!("falta cloudflared: tocá «Instalar cloudflared»"))?;
    let generation = {
        let mut r = rt().lock().unwrap();
        r.generation += 1;
        r.error.clear();
        r.url = None;
        r.generation
    };
    let c = load();
    if c.keep_awake {
        keep_awake();
    }
    tokio::spawn(supervise(exe, generation));
    Ok(())
}

pub async fn stop() {
    let (tunnel, awake) = {
        let mut r = rt().lock().unwrap();
        r.generation += 1;
        r.url = None;
        (r.tunnel.take(), r.awake.take())
    };
    for c in [tunnel, awake].into_iter().flatten() {
        let mut c = c;
        let _ = c.kill().await;
    }
}

/// Keeps cloudflared running while remote access is on: when it exits (the computer slept, the
/// network dropped), it is opened again.
async fn supervise(exe: PathBuf, generation: u64) {
    let mut wait = 2;
    loop {
        if rt().lock().unwrap().generation != generation || !load().enabled {
            return;
        }
        let c = load();
        let mut cmd = util::tokio_command(&exe);
        cmd.args(["tunnel", "--no-autoupdate"]);
        if c.mode == "named" {
            cmd.arg("run").env("TUNNEL_TOKEN", &c.tunnel_token);
        } else {
            cmd.args(["--url", &format!("http://127.0.0.1:{}", port())]);
        }
        cmd.stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(ch) => ch,
            Err(e) => {
                rt().lock().unwrap().error = format!("no pude abrir cloudflared: {e}");
                return;
            }
        };
        let stderr = child.stderr.take();
        let stale = {
            let mut r = rt().lock().unwrap();
            if r.generation != generation {
                // A newer start or a stop happened while this one was opening; dropping the
                // child kills it.
                true
            } else {
                r.tunnel = Some(child);
                false
            }
        };
        if stale {
            return;
        }
        log("[openblocks] cloudflared abierto");
        if let Some(err) = stderr {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if let Some(u) = quick_url(&l) {
                    rt().lock().unwrap().url = Some(u);
                    wait = 2;
                }
                if l.contains("Registered tunnel connection") && c.mode == "named" {
                    rt().lock().unwrap().url = Some(format!("https://{}", c.hostname));
                    wait = 2;
                }
                // Never keep the token in the log.
                log(l.replace(&c.token, "•••"));
            }
        }
        let child = rt().lock().unwrap().tunnel.take();
        if let Some(mut ch) = child {
            let _ = ch.wait().await;
        }
        if rt().lock().unwrap().generation != generation {
            return;
        }
        rt().lock().unwrap().url = None;
        log(format!(
            "[openblocks] cloudflared se cerró; lo vuelvo a abrir en {wait} s"
        ));
        tokio::time::sleep(Duration::from_secs(wait)).await;
        wait = (wait * 2).min(60);
    }
}

fn quick_url(line: &str) -> Option<String> {
    let i = line.find("https://")?;
    let rest = &line[i..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let u = &rest[..end];
    (u.ends_with(".trycloudflare.com") && !u.contains("api.trycloudflare.com"))
        .then(|| u.to_string())
}

fn keep_awake() {
    let pid = std::process::id().to_string();
    let child = if cfg!(target_os = "macos") {
        util::tokio_command("caffeinate")
            .args(["-i", "-w", &pid])
            .kill_on_drop(true)
            .spawn()
            .ok()
    } else if cfg!(target_os = "linux") && util::which("systemd-inhibit").is_some() {
        util::tokio_command("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=OpenBlocks",
                "--why=Remote MCP access",
                "sleep",
                "infinity",
            ])
            .kill_on_drop(true)
            .spawn()
            .ok()
    } else {
        None
    };
    rt().lock().unwrap().awake = child;
}

// ---------- the MCP listener ----------

async fn listen(st: Shared) -> Result<()> {
    if rt().lock().unwrap().listening {
        return Ok(());
    }
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port()))
        .await
        .with_context(|| format!("el puerto {} está ocupado", port()))?;
    rt().lock().unwrap().listening = true;
    let app = axum::Router::new()
        .fallback(handle)
        .layer(axum::extract::DefaultBodyLimit::max(8 * 1024 * 1024))
        .with_state(st);
    tokio::spawn(async move {
        let _ = axum::serve(l, app).await;
        rt().lock().unwrap().listening = false;
    });
    Ok(())
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

async fn handle(axum::extract::State(st): axum::extract::State<Shared>, req: Request) -> Response {
    let c = load();
    let path = req.uri().path().to_string();
    let tok = c.token.as_bytes();
    let seg_ok = {
        let p = path.trim_start_matches('/');
        let (seg, rest) = p.split_once('/').unwrap_or((p, ""));
        ct_eq(seg.as_bytes(), tok) && rest == "mcp"
    };
    let bearer_ok = path == "/mcp"
        && req
            .headers()
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| {
                h.strip_prefix("Bearer ")
                    .or_else(|| h.strip_prefix("bearer "))
            })
            .is_some_and(|t| ct_eq(t.trim().as_bytes(), tok));
    if !(seg_ok || bearer_ok) || tok.is_empty() {
        return not_found();
    }
    match *req.method() {
        Method::POST => {}
        Method::DELETE => return StatusCode::OK.into_response(),
        // No server-to-client stream: answers come back in the POST.
        _ => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
    let body = match axum::body::to_bytes(req.into_body(), 8 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    rpc(st, body, c.read_only).await
}

async fn server(st: &Shared, read_only: bool) -> Result<Arc<McpServer>> {
    let s = st.settings.read().unwrap().clone();
    let key = format!(
        "{}|{}|{}|{:?}",
        read_only,
        s.mcp_scope,
        s.last_vault
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        s.vaults.iter().map(|v| &v.path).collect::<Vec<_>>()
    );
    let mut cache = mcp_cache().lock().await;
    if let Some((k, srv)) = cache.as_ref() {
        if *k == key {
            return Ok(srv.clone());
        }
    }
    let srv = Arc::new(
        tokio::task::spawn_blocking(move || McpServer::from_settings(s, read_only)).await??,
    );
    *cache = Some((key, srv.clone()));
    Ok(srv)
}

async fn rpc(st: Shared, body: Bytes, read_only: bool) -> Response {
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}}),
            ),
        )
            .into_response();
    };
    let srv = match server(&st, read_only).await {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32000, "message": e.to_string()}})),
            )
                .into_response()
        }
    };
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    if let Some(batch) = msg.as_array() {
        let mut out = vec![];
        for m in batch {
            if let Some(r) = srv.handle(m).await {
                out.push(r);
            }
        }
        if out.is_empty() {
            return StatusCode::ACCEPTED.into_response();
        }
        return (headers, axum::Json(Value::Array(out))).into_response();
    }
    match srv.handle(&msg).await {
        Some(r) => (headers, axum::Json(r)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

// ---------- installing cloudflared ----------

fn asset() -> Result<&'static str> {
    let arm = matches!(std::env::consts::ARCH, "aarch64" | "arm64");
    Ok(match std::env::consts::OS {
        "macos" if arm => "cloudflared-darwin-arm64.tgz",
        "macos" => "cloudflared-darwin-amd64.tgz",
        // Windows on ARM runs the x64 build.
        "windows" => "cloudflared-windows-amd64.exe",
        "linux" if arm => "cloudflared-linux-arm64",
        "linux" if std::env::consts::ARCH == "arm" => "cloudflared-linux-arm",
        "linux" => "cloudflared-linux-amd64",
        os => bail!("cloudflared no tiene build para {os}"),
    })
}

/// Cloudflare publishes the SHA256 of each file in the release notes.
async fn expected_sha(asset: &str) -> Option<String> {
    let c = crate::web::client();
    let pat = format!("{asset}:");
    let bodies = [c
        .get(CF_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?
        .json::<Value>()
        .await
        .ok()
        .and_then(|v| v["body"].as_str().map(|s| s.to_string()))];
    for b in bodies.into_iter().flatten() {
        if let Some(i) = b.find(&pat) {
            let hex: String = b[i + pat.len()..]
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_hexdigit())
                .collect();
            if hex.len() == 64 {
                return Some(hex.to_lowercase());
            }
        }
    }
    None
}

pub fn install_start() {
    {
        let mut r = rt().lock().unwrap();
        if r.installing {
            return;
        }
        r.installing = true;
        r.error.clear();
    }
    tokio::spawn(async {
        let res = install().await;
        let mut r = rt().lock().unwrap();
        r.installing = false;
        if let Err(e) = res {
            r.error = format!("no pude instalar cloudflared: {e}");
        }
    });
}

async fn install() -> Result<PathBuf> {
    let asset = asset()?;
    let expected = expected_sha(asset)
        .await
        .ok_or_else(|| anyhow!("no encontré el SHA256 publicado por Cloudflare"))?;
    let bytes = crate::web::client()
        .get(format!("{CF_RELEASES}/latest/download/{asset}"))
        .timeout(Duration::from_secs(300))
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let outer = hex(&sha2::Sha256::digest(&bytes));
    let dest = local_bin();
    std::fs::create_dir_all(dest.parent().unwrap())?;
    let bin = if asset.ends_with(".tgz") {
        // For the macOS .tgz Cloudflare publishes the SHA256 of the binary inside: accept either.
        let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes.to_vec()));
        let mut t = tar::Archive::new(gz);
        let mut found = None;
        for e in t.entries()? {
            let mut e = e?;
            if e.path()?.file_name().is_some_and(|n| n == "cloudflared") {
                let mut v = vec![];
                std::io::Read::read_to_end(&mut e, &mut v)?;
                found = Some(v);
                break;
            }
        }
        let inner = found.ok_or_else(|| anyhow!("el .tgz no trae cloudflared"))?;
        if expected != outer && expected != hex(&sha2::Sha256::digest(&inner)) {
            bail!("el SHA256 no coincide");
        }
        inner
    } else {
        if expected != outer {
            bail!("el SHA256 no coincide");
        }
        bytes.to_vec()
    };
    let part = dest.with_extension("part");
    std::fs::write(&part, bin)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&part, &dest)?;
    log(format!(
        "[openblocks] cloudflared instalado en {}",
        dest.display()
    ));
    Ok(dest)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
