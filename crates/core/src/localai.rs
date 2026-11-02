//! Local models, run with llama.cpp's `llama-server`:
//!
//! - **Gemma 4** (with its vision file): reads images and scanned PDFs for the agents, and is a chat
//!   model that works with nothing else installed.
//! - **EmbeddingGemma 2** (with its vision file): puts images and text in one vector space, so the
//!   agents can find images in the vault by what they show.
//!
//! When Lumina is installed, its `llama-server` and its Gemma 4 are used as they are (nothing is
//! copied or downloaded twice). What is missing is downloaded to `~/.openblocks/models`. Lumina keeps
//! EmbeddingGemma 2 as ONNX for its text search, which llama.cpp can't load, so OpenBlocks downloads
//! the GGUF build (with its image encoder).

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use futures::StreamExt;
use serde_json::{json, Value};

use crate::util;

pub const LLAMA_BUILD: &str = "b11823";

// ---------- where things are ----------

pub fn lumina_data() -> PathBuf {
    std::env::var("LUMINA_DATA")
        .map(|p| util::expand(&p))
        .unwrap_or_else(|_| util::user_home().join(".lumina").join("data"))
}

fn ours(id: &str) -> PathBuf {
    util::home_dir().join("models").join(id)
}

fn complete(dir: &Path) -> bool {
    dir.join(".complete").exists()
}

#[derive(Clone, Debug)]
pub struct Item {
    pub id: &'static str,
    pub label: &'static str,
    pub size: u64,
    /// (url, file name in the item's folder)
    pub files: Vec<(String, String)>,
    /// The download is an archive to extract (llama.cpp).
    pub archive: bool,
    /// Lumina keeps the same item (same files) under this path.
    pub lumina: Option<PathBuf>,
}

fn hf(repo: &str, file: &str) -> (String, String) {
    (
        format!("https://huggingface.co/{repo}/resolve/main/{file}"),
        file.to_string(),
    )
}

fn llama_asset() -> Option<String> {
    let arm = matches!(std::env::consts::ARCH, "aarch64" | "arm64");
    let b = LLAMA_BUILD;
    match std::env::consts::OS {
        "macos" => Some(format!(
            "llama-{b}-bin-macos-{}.tar.gz",
            if arm { "arm64" } else { "x64" }
        )),
        "linux" => Some(format!(
            "llama-{b}-bin-ubuntu-{}.tar.gz",
            if arm { "arm64" } else { "x64" }
        )),
        "windows" => Some(format!(
            "llama-{b}-bin-win-cpu-{}.zip",
            if arm { "arm64" } else { "x64" }
        )),
        _ => None,
    }
}

const GEMMAS: &[(&str, &str, u64, u64)] = &[
    // (key, name, model bytes, vision bytes)
    ("e2b", "E2B", 2_841_481_184, 557_368_064),
    ("e4b", "E4B", 4_590_807_392, 559_874_816),
    ("12b", "12B", 7_219_673_216, 158_987_648),
];

pub fn items() -> Vec<Item> {
    let ld = lumina_data();
    let mut v = vec![];
    if let Some(asset) = llama_asset() {
        v.push(Item {
            id: "llama-server",
            label: "llama.cpp",
            size: 16_000_000,
            files: vec![(
                format!(
                    "https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/{asset}"
                ),
                asset,
            )],
            archive: true,
            lumina: Some(ld.join("bin").join("llama-server")),
        });
    }
    for (key, name, size, vsize) in GEMMAS {
        let repo = format!("ggml-org/gemma-4-{name}-it-GGUF");
        v.push(Item {
            id: leak(format!("gemma-4-{key}")),
            label: leak(format!("Gemma 4 {name}")),
            size: *size,
            files: vec![hf(&repo, &format!("gemma-4-{name}-it-Q4_0.gguf"))],
            archive: false,
            lumina: Some(ld.join("models").join(format!("gemma-4-{key}"))),
        });
        v.push(Item {
            id: leak(format!("gemma-4-{key}-vision")),
            label: leak(format!("Gemma 4 {name} · visión")),
            size: *vsize,
            files: vec![hf(&repo, &format!("mmproj-gemma-4-{name}-it-Q8_0.gguf"))],
            archive: false,
            lumina: None,
        });
    }
    v.push(Item {
        id: "embeddinggemma-2",
        label: "EmbeddingGemma 2",
        size: 309_855_456 + 554_821_056,
        files: vec![
            hf(
                "ggml-org/embeddinggemma-2-GGUF",
                "embeddinggemma-2-Q8_0.gguf",
            ),
            hf(
                "ggml-org/embeddinggemma-2-GGUF",
                "mmproj-embeddinggemma-2-Q8_0.gguf",
            ),
        ],
        archive: false,
        lumina: None,
    });
    v
}

fn leak(s: String) -> &'static str {
    // A handful of ids, built once per call to items(); interned so they are &'static.
    static POOL: OnceLock<Mutex<Vec<&'static str>>> = OnceLock::new();
    let pool = POOL.get_or_init(|| Mutex::new(vec![]));
    let mut p = pool.lock().unwrap();
    if let Some(x) = p.iter().find(|x| **x == s) {
        return x;
    }
    let x: &'static str = Box::leak(s.into_boxed_str());
    p.push(x);
    x
}

fn item(id: &str) -> Option<Item> {
    items().into_iter().find(|i| i.id == id)
}

/// Where an item is installed and who installed it ("lumina" or "openblocks").
pub fn locate(id: &str) -> Option<(PathBuf, &'static str)> {
    let it = item(id)?;
    if let Some(l) = it.lumina.filter(|d| complete(d)) {
        return Some((l, "lumina"));
    }
    let d = ours(id);
    complete(&d).then_some((d, "openblocks"))
}

fn find_file(dir: &Path, pred: &dyn Fn(&str) -> bool) -> Option<PathBuf> {
    walkdir::WalkDir::new(dir)
        .max_depth(3)
        .into_iter()
        .flatten()
        .find(|e| e.file_type().is_file() && pred(&e.file_name().to_string_lossy()))
        .map(|e| e.into_path())
}

fn llama_bin() -> Option<PathBuf> {
    let (dir, _) = locate("llama-server")?;
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    find_file(&dir, &|n| n == name)
}

/// The Gemma 4 to use: the one Lumina is set to, else any installed (smallest first).
fn gemma_key() -> Option<&'static str> {
    let lumina_choice = std::fs::read_to_string(lumina_data().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["builtin_model"].as_str().map(|s| s.to_string()));
    let keys = ["e2b", "e4b", "12b"];
    if let Some(c) = lumina_choice {
        if let Some(k) = keys
            .iter()
            .find(|k| c == format!("gemma-4-{k}") && locate(&c).is_some())
        {
            return Some(k);
        }
    }
    keys.into_iter()
        .find(|k| locate(&format!("gemma-4-{k}")).is_some())
}

fn gguf_in(id: &str, mmproj: bool) -> Option<PathBuf> {
    let (dir, _) = locate(id)?;
    find_file(&dir, &|n| {
        n.ends_with(".gguf") && n.starts_with("mmproj") == mmproj
    })
}

pub struct Paths {
    pub bin: PathBuf,
    pub model: PathBuf,
    pub mmproj: Option<PathBuf>,
}

/// Gemma 4 for chat; `vision` also asks for its vision file.
fn gemma_paths(vision: bool) -> Option<Paths> {
    let key = gemma_key()?;
    let model = gguf_in(&format!("gemma-4-{key}"), false)?;
    let mmproj = gguf_in(&format!("gemma-4-{key}-vision"), true);
    if vision && mmproj.is_none() {
        return None;
    }
    Some(Paths {
        bin: llama_bin()?,
        model,
        mmproj,
    })
}

fn embed_paths() -> Option<Paths> {
    Some(Paths {
        bin: llama_bin()?,
        model: gguf_in("embeddinggemma-2", false)?,
        mmproj: Some(gguf_in("embeddinggemma-2", true)?),
    })
}

pub fn chat_ready() -> bool {
    gemma_paths(false).is_some()
}

pub fn vision_ready() -> bool {
    gemma_paths(true).is_some()
}

pub fn embed_ready() -> bool {
    embed_paths().is_some()
}

/// The Gemma 4 chat model id for the model picker, when it can run.
pub fn chat_model() -> Option<(String, String)> {
    let key = gemma_key()?;
    llama_bin()?;
    let name = GEMMAS
        .iter()
        .find(|g| g.0 == key)
        .map(|g| g.1)
        .unwrap_or(key);
    Some((format!("local:gemma-4-{key}"), format!("Gemma 4 {name}")))
}

// ---------- downloads ----------

#[derive(Clone, Default, serde::Serialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    pub running: bool,
    pub error: String,
}

fn progress() -> &'static Mutex<HashMap<String, Progress>> {
    static P: OnceLock<Mutex<HashMap<String, Progress>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What the Settings card shows.
pub fn status() -> Value {
    let key = gemma_key().unwrap_or("e2b");
    let want = [
        ("llama-server", "engine"),
        (leak(format!("gemma-4-{key}")), "chat"),
        (leak(format!("gemma-4-{key}-vision")), "vision"),
        ("embeddinggemma-2", "embed"),
    ];
    let prog = progress().lock().unwrap().clone();
    let rows: Vec<Value> = want
        .iter()
        .filter_map(|(id, role)| {
            let it = item(id)?;
            let loc = locate(id);
            Some(json!({
                "id": id, "role": role, "label": it.label, "size": it.size,
                "installed": loc.is_some(),
                "source": loc.as_ref().map(|l| l.1),
                "progress": prog.get(*id),
            }))
        })
        .collect();
    json!({
        "items": rows,
        "chat": chat_ready(),
        "vision": vision_ready(),
        "embed": embed_ready(),
        "lumina": lumina_data().join("models").is_dir(),
    })
}

/// Starts downloading an item (and llama.cpp, if it is missing). Returns at once.
pub fn download(id: &str) -> Result<()> {
    let it = item(id).ok_or_else(|| anyhow!("no existe {id}"))?;
    let mut ids = vec![it.id];
    if it.id != "llama-server" && locate("llama-server").is_none() {
        ids.insert(0, "llama-server");
    }
    for id in ids {
        if locate(id).is_some() {
            continue;
        }
        {
            let mut p = progress().lock().unwrap();
            if p.get(id).is_some_and(|x| x.running) {
                continue;
            }
            p.insert(
                id.to_string(),
                Progress {
                    running: true,
                    ..Default::default()
                },
            );
        }
        let id = id.to_string();
        tokio::spawn(async move {
            let r = fetch(&id).await;
            let mut p = progress().lock().unwrap();
            let e = p.entry(id).or_default();
            e.running = false;
            if let Err(err) = r {
                e.error = err.to_string();
            }
        });
    }
    Ok(())
}

async fn fetch(id: &str) -> Result<()> {
    let it = item(id).ok_or_else(|| anyhow!("no existe {id}"))?;
    let dir = ours(id);
    std::fs::create_dir_all(&dir)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()?;
    {
        let mut p = progress().lock().unwrap();
        p.entry(id.to_string()).or_default().total = it.size;
    }
    for (url, name) in &it.files {
        let dest = dir.join(name);
        if dest.exists() {
            let have = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            progress()
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_default()
                .done += have;
            continue;
        }
        let part = dir.join(format!("{name}.part"));
        let r = client.get(url).send().await?;
        if !r.status().is_success() {
            bail!("{} respondió {}", url, r.status());
        }
        let mut f = tokio::fs::File::create(&part).await?;
        let mut s = r.bytes_stream();
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = s.next().await {
            let c = chunk?;
            f.write_all(&c).await?;
            progress()
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_default()
                .done += c.len() as u64;
        }
        f.flush().await?;
        drop(f);
        std::fs::rename(&part, &dest)?;
        if it.archive {
            let d = dir.clone();
            let a = dest.clone();
            tokio::task::spawn_blocking(move || extract(&a, &d)).await??;
            let _ = std::fs::remove_file(&dest);
        }
    }
    std::fs::write(dir.join(".complete"), util::now().to_string())?;
    Ok(())
}

fn extract(archive: &Path, dir: &Path) -> Result<()> {
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        let mut z = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
        z.extract(dir)?;
    } else {
        let gz = flate2::read::GzDecoder::new(std::fs::File::open(archive)?);
        let mut t = tar::Archive::new(gz);
        t.set_preserve_permissions(true);
        t.unpack(dir)?;
    }
    #[cfg(unix)]
    if let Some(b) = find_file(dir, &|n| n == "llama-server") {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&b, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

// ---------- llama-server processes ----------

struct Proc {
    child: tokio::process::Child,
    port: u16,
    last: Instant,
    model: PathBuf,
}

fn procs() -> &'static tokio::sync::Mutex<HashMap<&'static str, Proc>> {
    static P: OnceLock<tokio::sync::Mutex<HashMap<&'static str, Proc>>> = OnceLock::new();
    P.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn pids_file() -> PathBuf {
    util::home_dir().join(format!("llama-{}.pids", std::process::id()))
}

fn alive(pid: &str) -> bool {
    if cfg!(windows) {
        util::command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(pid))
            .unwrap_or(false)
    } else {
        util::command("kill")
            .args(["-0", pid])
            .status()
            .is_ok_and(|s| s.success())
    }
}

/// Stops llama-server processes left behind by an OpenBlocks process that is gone (it was killed).
pub fn cleanup_stale() {
    let Ok(rd) = std::fs::read_dir(util::home_dir()) else {
        return;
    };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let Some(owner) = n
            .strip_prefix("llama-")
            .and_then(|x| x.strip_suffix(".pids"))
        else {
            continue;
        };
        if owner == std::process::id().to_string() || alive(owner) {
            continue;
        }
        if let Ok(t) = std::fs::read_to_string(e.path()) {
            for pid in t.split_whitespace() {
                if cfg!(windows) {
                    let _ = util::command("taskkill").args(["/PID", pid, "/F"]).output();
                } else {
                    let _ = util::command("kill").arg(pid).output();
                }
            }
        }
        let _ = std::fs::remove_file(e.path());
    }
}

async fn write_pids() {
    let p = procs().lock().await;
    let ids: Vec<String> = p
        .values()
        .filter_map(|x| x.child.id())
        .map(|i| i.to_string())
        .collect();
    if ids.is_empty() {
        let _ = std::fs::remove_file(pids_file());
    } else {
        let _ = std::fs::write(pids_file(), ids.join(" "));
    }
}

/// Stops every llama-server this app started.
pub async fn shutdown() {
    let mut p = procs().lock().await;
    for (_, mut x) in p.drain() {
        let _ = x.child.kill().await;
    }
    let _ = std::fs::remove_file(pids_file());
}

fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap_or_default()
}

/// A running llama-server for `role` ("chat" or "embed"); started on first use, stopped after 10
/// minutes without use.
async fn ensure(role: &'static str) -> Result<u16> {
    let paths = match role {
        "embed" => embed_paths().ok_or_else(|| {
            anyhow!("EmbeddingGemma 2 no está instalado (Ajustes → IA → Modelos locales)")
        })?,
        _ => gemma_paths(true)
            .or_else(|| gemma_paths(false))
            .ok_or_else(|| anyhow!("Gemma 4 no está instalado (Ajustes → IA → Modelos locales)"))?,
    };
    let mut p = procs().lock().await;
    if let Some(x) = p.get_mut(role) {
        if x.model == paths.model && matches!(x.child.try_wait(), Ok(None)) {
            x.last = Instant::now();
            return Ok(x.port);
        }
        let _ = x.child.kill().await;
        p.remove(role);
    }
    let port = free_port()?;
    let mut cmd = util::tokio_command(&paths.bin);
    cmd.arg("-m").arg(&paths.model);
    if let Some(m) = &paths.mmproj {
        cmd.arg("--mmproj").arg(m);
    }
    cmd.args([
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "-np",
        "1",
    ]);
    if role == "embed" {
        cmd.args(["--embedding", "-c", "8192"]);
    } else {
        cmd.args(["--jinja", "-c", "16384"]);
    }
    if let Some(d) = paths.bin.parent() {
        cmd.current_dir(d);
    }
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let child = cmd.spawn().context("no pude abrir llama-server")?;
    p.insert(
        role,
        Proc {
            child,
            port,
            last: Instant::now(),
            model: paths.model.clone(),
        },
    );
    drop(p);
    write_pids().await;
    reaper();
    let url = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    loop {
        if let Ok(r) = http().get(&url).send().await {
            if r.status().is_success() {
                return Ok(port);
            }
        }
        {
            let mut p = procs().lock().await;
            if let Some(x) = p.get_mut(role) {
                if !matches!(x.child.try_wait(), Ok(None)) {
                    p.remove(role);
                    bail!("llama-server se cerró al cargar el modelo (¿falta memoria?)");
                }
            }
        }
        if started.elapsed() > Duration::from_secs(180) {
            bail!("llama-server tardó demasiado en cargar el modelo");
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

fn reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let mut p = procs().lock().await;
            let idle: Vec<&'static str> = p
                .iter()
                .filter(|(_, x)| x.last.elapsed() > Duration::from_secs(600))
                .map(|(k, _)| *k)
                .collect();
            for k in idle {
                if let Some(mut x) = p.remove(k) {
                    let _ = x.child.kill().await;
                }
            }
            drop(p);
            write_pids().await;
        }
    });
}

async fn touch(role: &'static str) {
    if let Some(x) = procs().lock().await.get_mut(role) {
        x.last = Instant::now();
    }
}

/// Base URL of the OpenAI-compatible API of the local Gemma 4 (started if needed).
pub async fn chat_base() -> Result<String> {
    let port = ensure("chat").await?;
    Ok(format!("http://127.0.0.1:{port}/v1"))
}

// ---------- images ----------

const IMAGE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic",
];

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| IMAGE_EXT.contains(&e.as_str()))
}

/// An image as a PNG the models read well: transparency on white, at most `max` pixels a side.
pub fn normalize_image(bytes: &[u8], max: u32) -> Result<Vec<u8>> {
    let img = image::load_from_memory(bytes).context("no pude abrir la imagen")?;
    let img = if img.width() > max || img.height() > max {
        img.resize(max, max, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let rgba = img.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    let mut out = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgb8(rgb).write_to(&mut out, image::ImageFormat::Png)?;
    Ok(out.into_inner())
}

fn b64(bytes: &[u8]) -> String {
    use std::fmt::Write;
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        let _ = s.write_char(T[(n >> 18) as usize & 63] as char);
        let _ = s.write_char(T[(n >> 12) as usize & 63] as char);
        let _ = s.write_char(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        let _ = s.write_char(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    s
}

const READ_PROMPT: &str = "Transcribe all the text in this image exactly, keeping its line breaks (tables as Markdown tables). Then write a line that starts with \"Image:\" and describe in one or two sentences what the image shows. If there is no text, write only the description. Use the language of the text in the image.";

/// Text and a short description of an image, read by Gemma 4.
pub async fn read_image(bytes: &[u8]) -> Result<String> {
    let png = {
        let b = bytes.to_vec();
        tokio::task::spawn_blocking(move || normalize_image(&b, 1600)).await??
    };
    let port = ensure("chat").await?;
    let body = json!({
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": READ_PROMPT},
            {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{}", b64(&png))}}
        ]}],
        "max_tokens": 2000,
        "temperature": 0,
    });
    let r: Value = http()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    touch("chat").await;
    r["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| {
            anyhow!(
                "Gemma no devolvió texto: {}",
                util::clip(&r.to_string(), 200)
            )
        })
}

fn cache_key(path: &Path) -> String {
    let m = std::fs::metadata(path).ok();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    m.as_ref().map(|m| m.len()).hash(&mut h);
    m.and_then(|m| m.modified().ok())
        .map(|t| format!("{t:?}"))
        .hash(&mut h);
    format!("{:016x}", h.finish())
}

fn cache_dir() -> PathBuf {
    util::home_dir().join("vision-cache")
}

/// Images of a scanned PDF's pages (JPEG streams and plain bitmaps; JBIG2 and CCITT scans are
/// not supported). Runs in a child process, like the PDF text, so a broken file can't take the app
/// down.
async fn pdf_page_images(path: &Path) -> Result<Vec<Vec<u8>>> {
    let out_dir = std::env::temp_dir().join(format!("openblocks-pdf-{}", util::new_id()));
    std::fs::create_dir_all(&out_dir)?;
    let exe = std::env::current_exe()?;
    let ours = exe
        .file_stem()
        .is_some_and(|s| s.to_string_lossy().to_lowercase().starts_with("openblocks"));
    if ours {
        let st = util::tokio_command(&exe)
            .arg("__pdf-images")
            .arg(path)
            .arg(&out_dir)
            .output()
            .await?;
        if !st.status.success() {
            let _ = std::fs::remove_dir_all(&out_dir);
            bail!("no pude sacar las imágenes del PDF");
        }
    } else {
        pdf_images_here(path, &out_dir)?;
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&out_dir)?
        .flatten()
        .map(|e| e.path())
        .collect();
    files.sort();
    let imgs = files.iter().filter_map(|f| std::fs::read(f).ok()).collect();
    let _ = std::fs::remove_dir_all(&out_dir);
    Ok(imgs)
}

/// `openblocks __pdf-images <pdf> <dir>`: writes the biggest image of each page (up to 30 pages).
pub fn pdf_images_here(path: &Path, out: &Path) -> Result<()> {
    let doc = lopdf::Document::load_mem(&std::fs::read(path)?)?;
    for (n, (_, page)) in doc.get_pages().into_iter().take(30).enumerate() {
        let Ok(imgs) = doc.get_page_images(page) else {
            continue;
        };
        let Some(img) = imgs.iter().max_by_key(|i| i.width * i.height) else {
            continue;
        };
        let filters = img.filters.clone().unwrap_or_default();
        let bytes = if filters.iter().any(|f| f == "DCTDecode") {
            img.content.to_vec()
        } else {
            let raw = if filters.iter().any(|f| f == "FlateDecode") {
                let mut d = flate2::read::ZlibDecoder::new(img.content);
                let mut v = vec![];
                std::io::Read::read_to_end(&mut d, &mut v)?;
                v
            } else if filters.is_empty() {
                img.content.to_vec()
            } else {
                continue;
            };
            let (w, h) = (img.width as u32, img.height as u32);
            let bpc = img.bits_per_component.unwrap_or(8);
            let cs = img.color_space.clone().unwrap_or_default();
            let dynimg = match (cs.as_str(), bpc) {
                ("DeviceRGB", 8) => {
                    image::RgbImage::from_raw(w, h, raw).map(image::DynamicImage::ImageRgb8)
                }
                ("DeviceGray", 8) => {
                    image::GrayImage::from_raw(w, h, raw).map(image::DynamicImage::ImageLuma8)
                }
                ("DeviceGray", 1) => {
                    let row = w.div_ceil(8) as usize;
                    let mut g = image::GrayImage::new(w, h);
                    for y in 0..h {
                        for x in 0..w {
                            let byte = raw
                                .get(y as usize * row + (x / 8) as usize)
                                .copied()
                                .unwrap_or(255);
                            let bit = (byte >> (7 - (x % 8))) & 1;
                            g.put_pixel(x, y, image::Luma([if bit == 1 { 255 } else { 0 }]));
                        }
                    }
                    Some(image::DynamicImage::ImageLuma8(g))
                }
                _ => None,
            };
            let Some(d) = dynimg else { continue };
            let mut c = std::io::Cursor::new(vec![]);
            d.write_to(&mut c, image::ImageFormat::Png)?;
            c.into_inner()
        };
        std::fs::write(out.join(format!("{n:03}.img")), bytes)?;
    }
    Ok(())
}

/// The text of any file for the agents. Pages, office files and PDFs with text are read directly;
/// images and scanned PDFs are read by Gemma 4 when it is installed (results are cached).
pub async fn file_text(path: &Path) -> Result<String> {
    let p = path.to_path_buf();
    let direct = tokio::task::spawn_blocking(move || crate::preview::text_of(&p))
        .await?
        .unwrap_or_default();
    let is_pdf = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    let scanned = is_pdf && direct.split_whitespace().count() < 20;
    if !(is_image(path) || scanned) {
        return Ok(direct);
    }
    let cache = cache_dir().join(format!("{}.txt", cache_key(path)));
    if let Ok(t) = std::fs::read_to_string(&cache) {
        return Ok(t);
    }
    if !vision_ready() {
        if !direct.trim().is_empty() {
            return Ok(direct);
        }
        bail!("para leer imágenes y PDFs escaneados, instalá la visión local de Gemma 4 en Ajustes → IA → Modelos locales");
    }
    let text = if is_image(path) {
        read_image(&std::fs::read(path)?).await?
    } else {
        let pages = pdf_page_images(path).await?;
        if pages.is_empty() {
            if !direct.trim().is_empty() {
                return Ok(direct);
            }
            bail!("este PDF no tiene texto ni imágenes que pueda leer");
        }
        let mut all = String::new();
        for (i, img) in pages.iter().enumerate() {
            let t = read_image(img).await.unwrap_or_default();
            all.push_str(&format!("## Página {}\n\n{}\n\n", i + 1, t.trim()));
        }
        all
    };
    let _ = std::fs::create_dir_all(cache_dir());
    let _ = std::fs::write(&cache, &text);
    Ok(text)
}

// ---------- embeddings (EmbeddingGemma 2) ----------

fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    v.iter_mut().for_each(|x| *x /= n);
    v
}

fn first_vec(r: &Value) -> Option<Vec<f32>> {
    let e = if r.is_array() {
        &r[0]["embedding"]
    } else {
        &r["data"][0]["embedding"]
    };
    let e = if e[0].is_array() { &e[0] } else { e };
    e.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_f64())
                .map(|x| x as f32)
                .collect()
        })
        .filter(|v: &Vec<f32>| !v.is_empty())
}

pub async fn embed_text(text: &str) -> Result<Vec<f32>> {
    let port = ensure("embed").await?;
    let r: Value = http()
        .post(format!("http://127.0.0.1:{port}/v1/embeddings"))
        .json(&json!({"input": [text]}))
        .send()
        .await?
        .json()
        .await?;
    touch("embed").await;
    first_vec(&r)
        .map(unit)
        .ok_or_else(|| anyhow!("EmbeddingGemma no devolvió un vector"))
}

pub async fn embed_image(bytes: &[u8]) -> Result<Vec<f32>> {
    let png = {
        let b = bytes.to_vec();
        tokio::task::spawn_blocking(move || normalize_image(&b, 896)).await??
    };
    let port = ensure("embed").await?;
    let marker: Value = http()
        .get(format!("http://127.0.0.1:{port}/props"))
        .send()
        .await?
        .json()
        .await?;
    let marker = marker["media_marker"].as_str().unwrap_or("<__media__>");
    let r: Value = http()
        .post(format!("http://127.0.0.1:{port}/embeddings"))
        .json(&json!({"content": [{"prompt_string": marker, "multimodal_data": [b64(&png)]}]}))
        .send()
        .await?
        .json()
        .await?;
    touch("embed").await;
    first_vec(&r)
        .map(unit)
        .ok_or_else(|| anyhow!("EmbeddingGemma no devolvió un vector para la imagen"))
}

/// Images of the vault ranked by how well they match `query`. The vectors are kept in
/// `.openblocks/image-index.json`, so each image is embedded once.
pub async fn find_images(
    v: &Arc<crate::vault::Vault>,
    query: &str,
    k: usize,
) -> Result<Vec<(String, f32)>> {
    let index_path = v.root.join(crate::vault::META_DIR).join("image-index.json");
    let mut index: HashMap<String, (u64, Vec<f32>)> = std::fs::read_to_string(&index_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let files: Vec<String> = {
        let idx = v.index.read().unwrap();
        idx.files
            .iter()
            .filter(|f| is_image(Path::new(f.as_str())))
            .cloned()
            .collect()
    };
    let mut changed = false;
    let mut budget = 150;
    for f in &files {
        let abs = v.abs(f)?;
        let m = std::fs::metadata(&abs)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if index.get(f).is_some_and(|(mt, _)| *mt == m) {
            continue;
        }
        if budget == 0 {
            break;
        }
        budget -= 1;
        if let Ok(bytes) = std::fs::read(&abs) {
            if let Ok(vec) = embed_image(&bytes).await {
                index.insert(f.clone(), (m, vec));
                changed = true;
            }
        }
    }
    index.retain(|k, _| files.contains(k));
    if changed {
        let _ = std::fs::write(&index_path, serde_json::to_string(&index)?);
    }
    let q = embed_text(&format!("task: search result | query: {query}")).await?;
    let mut hits: Vec<(String, f32)> = index
        .iter()
        .map(|(p, (_, vec))| {
            (
                p.clone(),
                vec.iter().zip(&q).map(|(a, b)| a * b).sum::<f32>(),
            )
        })
        .collect();
    hits.sort_by(|a, b| b.1.total_cmp(&a.1));
    hits.truncate(k);
    Ok(hits)
}
