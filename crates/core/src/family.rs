//! The WorkStudio family: brain (memory), Lumina (meetings), OpenCue (agents) and AI WorkStudio
//! (the workspace that joins them). OpenBlocks uses each one the way the others already do: through
//! its local port, its command and its MCP server, without copying code or touching its data.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::mcp_client::McpClient;
use crate::settings::Settings;
use crate::util;

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()
        .unwrap_or_default()
}

fn loopback(url: &str) -> bool {
    url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
        || url.starts_with("http://[::1]:")
}

async fn alive(url: &str) -> Option<Value> {
    let r = reqwest::Client::builder()
        .timeout(Duration::from_millis(1200))
        .no_proxy()
        .build()
        .ok()?
        .get(url)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json::<Value>().await.ok().or(Some(json!({})))
}

pub fn brain_home() -> PathBuf {
    std::env::var("BRAIN_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| util::user_home().join(".brain"))
}

pub fn lumina_home() -> PathBuf {
    std::env::var("LUMINA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| util::user_home().join(".lumina"))
}

pub fn opencue_db() -> PathBuf {
    if let Ok(h) = std::env::var("OPENCUE_HOME") {
        return PathBuf::from(h).join("opencue.db");
    }
    let h = util::user_home();
    if cfg!(target_os = "macos") {
        h.join("Library/Application Support/opencue/opencue.db")
    } else if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| h.join("AppData/Roaming"))
            .join("opencue/data/opencue.db")
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| h.join(".local/share"))
            .join("opencue/opencue.db")
    }
}

fn workstudio_app() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        for d in [
            "/Applications",
            &format!("{}/Applications", util::user_home().display()),
        ] {
            let p = PathBuf::from(d).join("AI WorkStudio.app");
            if p.exists() {
                return Some(p);
            }
        }
    }
    util::which("workstudio")
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub face: String,
    pub model: String,
}

/// OpenCue agents, read-only from its database. Empty when OpenCue is not installed.
pub fn opencue_agents() -> Vec<Agent> {
    let db = opencue_db();
    if !db.exists() {
        return vec![];
    }
    let Ok(c) =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return vec![];
    };
    let _ = c.busy_timeout(Duration::from_secs(2));
    // The face column was renamed in OpenCue 0.2; read whichever exists.
    let face_col = ["avatar_face", "avatar_emoji"]
        .into_iter()
        .find(|col| {
            c.prepare(&format!("SELECT {col} FROM agents LIMIT 0"))
                .is_ok()
        })
        .unwrap_or("''");
    let sql = format!(
        "SELECT id, name, {face_col}, COALESCE(model, '') FROM agents ORDER BY name COLLATE NOCASE"
    );
    let Ok(mut st) = c.prepare(&sql) else {
        return vec![];
    };
    st.query_map([], |r| {
        Ok(Agent {
            id: r.get::<_, String>(0)?,
            name: r.get::<_, String>(1)?,
            face: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            model: r.get::<_, String>(3).unwrap_or_default(),
        })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

/// What OpenBlocks needs to run an OpenCue agent itself: its model and provider, and who it is
/// (instructions, soul, memory). Read-only from OpenCue's files.
#[derive(Clone, Debug, Default)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub model: String,
    /// OpenCue provider kind: claude_cli, codex_cli, ollama, lmstudio, anthropic, openai…
    pub provider: String,
    pub base_url: String,
    pub instructions: String,
    pub soul: String,
    pub memory: String,
}

pub fn opencue_profile(name: &str) -> Option<AgentProfile> {
    let db = opencue_db();
    let c = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .ok()?;
    let _ = c.busy_timeout(Duration::from_secs(2));
    let mut p = c
        .query_row(
            "SELECT a.id, a.name, COALESCE(a.model, ''), COALESCE(p.kind, ''), COALESCE(p.base_url, ''), COALESCE(p.default_model, '')
             FROM agents a LEFT JOIN providers p ON p.id = a.provider_id
             WHERE a.name = ?1 COLLATE NOCASE OR a.id = ?1 LIMIT 1",
            [name],
            |r| {
                let mut model: String = r.get(2)?;
                let default_model: String = r.get(5)?;
                if model.is_empty() {
                    model = default_model;
                }
                Ok(AgentProfile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    model,
                    provider: r.get(3)?,
                    base_url: r.get(4)?,
                    ..Default::default()
                })
            },
        )
        .ok()?;
    let root = db.parent()?.to_path_buf();
    let read = |f: PathBuf| {
        std::fs::read_to_string(f)
            .map(|s| util::clip(s.trim(), 6000))
            .unwrap_or_default()
    };
    let dir = root.join("agents").join(&p.id);
    p.instructions = read(dir.join("INSTRUCTIONS.md"));
    p.soul = read(dir.join("SOUL.md"));
    let mut memory = read(dir.join("MEMORY.md"));
    let global = read(root.join("memory").join("GLOBAL.md"));
    if !global.is_empty() {
        if !memory.is_empty() {
            memory.push_str("\n\n");
        }
        memory.push_str(&global);
    }
    p.memory = memory;
    Some(p)
}

pub async fn status(s: &Settings) -> Value {
    let brain_url = s.family.brain_url.trim_end_matches('/').to_string();
    let lumina_url = s.family.lumina_url.trim_end_matches('/').to_string();
    let (bu, lu) = (
        format!("{brain_url}/api/version"),
        format!("{lumina_url}/api/status"),
    );
    let (b, l) = tokio::join!(alive(&bu), alive(&lu));
    let agents = opencue_agents();
    let ws_dir = util::user_home().join(".workstudio");
    let ws_registered = std::fs::read_to_string(ws_dir.join("apps.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| {
            v["apps"]
                .as_array()
                .map(|a| a.iter().any(|x| x["id"] == "openblocks"))
        })
        .unwrap_or(false);
    json!({
        "brain": {
            "installed": brain_home().join("server.py").exists(),
            "running": b.is_some(),
            "version": b.as_ref().and_then(|v| v["current"].as_str().map(|s| s.to_string()))
                .or_else(|| std::fs::read_to_string(brain_home().join("VERSION")).ok().map(|s| s.trim().to_string())),
            "enabled": s.family.brain,
            "url": brain_url,
            "install": "curl -fsSL https://raw.githubusercontent.com/Lautaro005/brain/main/install.sh | bash",
        },
        "lumina": {
            "installed": lumina_home().exists() || util::which("lumina").is_some(),
            "running": l.is_some(),
            "version": l.as_ref().and_then(|v| v["version"].as_str().map(|s| s.to_string())),
            "enabled": s.family.lumina,
            "url": lumina_url,
            "install": "curl -fsSL https://lautaro005.github.io/lumina/install.sh | sh",
        },
        "opencue": {
            "installed": opencue_db().exists() || util::which("opencue").is_some(),
            "running": process_running("opencue"),
            "agents": agents,
            "enabled": s.family.opencue,
            "install": "curl -fsSL https://lautaro005.github.io/opencue/install.sh | sh",
        },
        "workstudio": {
            "installed": workstudio_app().is_some() || ws_dir.exists(),
            "running": process_running("workstudio"),
            "registered": ws_registered,
            "enabled": s.family.workstudio,
            "install": "curl -fsSL https://raw.githubusercontent.com/Lautaro005/workstudio/main/install.sh | sh",
        },
    })
}

pub fn process_running(name: &str) -> bool {
    if cfg!(windows) {
        util::command("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {name}.exe"), "/NH"])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .to_lowercase()
                    .contains(name)
            })
            .unwrap_or(false)
    } else {
        util::command("pgrep")
            .args(["-ix", name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Opens one of the family apps.
pub fn open_app(id: &str, s: &Settings) -> Result<()> {
    match id {
        "brain" => crate::sys::open_url(&format!("{}/", s.family.brain_url.trim_end_matches('/')))?,
        "lumina" => {
            crate::sys::open_url(&format!("{}/", s.family.lumina_url.trim_end_matches('/')))?
        }
        "opencue" => launch("OpenCue", "opencue")?,
        "workstudio" => launch("AI WorkStudio", "workstudio")?,
        _ => bail!("app desconocida"),
    }
    Ok(())
}

fn launch(mac_name: &str, cli: &str) -> Result<()> {
    if cfg!(target_os = "macos")
        && util::command("open")
            .args(["-a", mac_name])
            .status()
            .is_ok_and(|s| s.success())
    {
        return Ok(());
    }
    let bin = util::which(cli).ok_or_else(|| anyhow!("{mac_name} no está instalada"))?;
    util::command(bin).spawn()?;
    Ok(())
}

// ---------- brain ----------

pub async fn brain_search(s: &Settings, q: &str, k: usize) -> Result<Vec<Value>> {
    let url = format!("{}/api/search", s.family.brain_url.trim_end_matches('/'));
    if !loopback(&url) {
        bail!("brain solo se usa en 127.0.0.1");
    }
    let r: Value = http()
        .post(url)
        .header("X-Brain", "1")
        .json(&json!({"query": q, "top_k": k.clamp(1, 20)}))
        .send()
        .await
        .map_err(|_| anyhow!("brain no está abierto"))?
        .json()
        .await?;
    if r["ok"] == false {
        bail!(
            "brain: {}",
            r["detail"].as_str().unwrap_or("falló la búsqueda")
        );
    }
    Ok(r["hits"].as_array().cloned().unwrap_or_default())
}

fn uv() -> String {
    util::which("uv")
        .or_else(|| {
            let p = util::user_home().join(".local/bin/uv");
            p.exists().then_some(p)
        })
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "uv".into())
}

/// Saves a page into brain's vault (`knowledge/openblocks-<name>.md`) through brain's own MCP tool,
/// so it lands in brain's history like any other write.
pub fn brain_save(title: &str, vault_name: &str, body: &str) -> Result<String> {
    let home = brain_home();
    if !home.join("server.py").exists() {
        bail!("brain no está instalado");
    }
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let path = format!(
        "knowledge/openblocks-{}.md",
        if slug.is_empty() {
            "pagina".into()
        } else {
            slug
        }
    );
    let content = format!(
        "---\ntitle: {}\ndescription: Página de OpenBlocks ({vault_name})\ntags: [openblocks]\nsource: openblocks\n---\n\n{}",
        serde_json::to_string(title).unwrap_or_default(),
        body.trim()
    );
    let c = McpClient::start(
        &uv(),
        &[
            "run".into(),
            "--directory".into(),
            home.to_string_lossy().into_owned(),
            "python".into(),
            "server.py".into(),
        ],
        Some(&home),
    )?;
    let r = c.call_text(
        "write_file",
        json!({"path": path, "content": content}),
        Duration::from_secs(90),
    )?;
    if r.starts_with("ERROR") || r.to_lowercase().starts_with("error") {
        bail!(r);
    }
    Ok(path)
}

// ---------- Lumina ----------

pub async fn lumina_search(s: &Settings, q: &str, k: usize) -> Result<Vec<Value>> {
    let url = format!("{}/api/search", s.family.lumina_url.trim_end_matches('/'));
    if !loopback(&url) {
        bail!("Lumina solo se usa en 127.0.0.1");
    }
    let r = http()
        .get(url)
        .query(&[
            ("q", q.chars().take(500).collect::<String>()),
            ("k", k.clamp(1, 20).to_string()),
            ("scope", "all".into()),
        ])
        .send()
        .await
        .map_err(|_| anyhow!("Lumina no está abierta"))?;
    if r.status().as_u16() == 409 {
        bail!("Lumina todavía no tiene su modelo de búsqueda");
    }
    if !r.status().is_success() {
        bail!("Lumina respondió {}", r.status());
    }
    let hits: Vec<Value> = r.json().await?;
    Ok(hits
        .into_iter()
        .map(|h| {
            json!({"text": util::clip(h["text"].as_str().unwrap_or(""), 1500), "title": h["title"],
                   "kind": h["collection"], "date": h["date"], "path": h["path"]})
        })
        .collect())
}

// ---------- OpenCue ----------

/// Sends a message to an OpenCue agent and returns its reply. OpenCue delivers it from another of
/// the user's agents (an agent cannot message itself); the OpenCue app does the work, so it is
/// opened if needed.
pub fn opencue_send(agent_name: &str, message: &str) -> Result<String> {
    let agents = opencue_agents();
    let target = agents
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case(agent_name) || a.id == agent_name)
        .ok_or_else(|| anyhow!("no encontré el agente {agent_name} en OpenCue"))?;
    let from = agents.iter().find(|a| a.id != target.id).ok_or_else(|| {
        anyhow!("OpenCue necesita al menos dos agentes para recibir mensajes de otras apps")
    })?;
    if !process_running("opencue") {
        let _ = launch("OpenCue", "opencue");
        std::thread::sleep(Duration::from_secs(4));
    }
    let cli = util::which("opencue")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "opencue".into());
    let c = McpClient::start(
        &cli,
        &["mcp-serve".into(), "--agent".into(), from.id.clone()],
        None,
    )?;
    let text = c.call_text(
        "send_to_agent",
        json!({"agent": target.name, "message": message}),
        Duration::from_secs(1800),
    )?;
    let prefix = format!("[{}]:", target.name);
    Ok(text
        .trim()
        .strip_prefix(&prefix)
        .unwrap_or(text.trim())
        .trim()
        .to_string())
}

// ---------- AI WorkStudio ----------

/// The catalog entry WorkStudio reads from `~/.workstudio/apps.json` (its documented file for apps
/// that are not in its built-in catalog). With it, OpenBlocks shows up in WorkStudio's home, opens
/// inside it, and its tools join WorkStudio's single MCP server as `openblocks__*`.
pub fn workstudio_entry() -> Value {
    json!({
        "id": "openblocks",
        "name": "OpenBlocks",
        "tagline": "Tus notas en bloques, en tu carpeta",
        "tagline_en": "Block notes in your own folder",
        "description": "Editor por bloques al estilo de Notion sobre un vault Markdown local como Obsidian: páginas, carpetas, archivos con vista previa, bases de datos, grafo, historial y un chat con agentes (Claude Code, Codex, Ollama, OpenCue).",
        "description_en": "A Notion-style block editor on a local Markdown vault like Obsidian: pages, folders, file previews, databases, graph, history and a chat with agents (Claude Code, Codex, Ollama, OpenCue).",
        "color": "ink",
        "icon": "notebook",
        "repo": crate::REPO,
        "site": "https://lautaro005.github.io/openblocks/",
        "kind": "web",
        "url": format!("http://127.0.0.1:{}/", crate::DEFAULT_PORT),
        "health": {"url": format!("http://127.0.0.1:{}/api/status", crate::DEFAULT_PORT), "contains": "openblocks"},
        "home": "~/.openblocks",
        "cli": "openblocks",
        "mac_app": "OpenBlocks.app",
        "process": "openblocks",
        "version": {"json_url": format!("http://127.0.0.1:{}/api/status", crate::DEFAULT_PORT), "field": "version", "cmd": "openblocks --version"},
        "start": {"unix": "openblocks serve", "windows": "openblocks serve"},
        "stop": {"url": format!("http://127.0.0.1:{}/api/quit", crate::DEFAULT_PORT), "header": "X-OpenBlocks", "value": "1"},
        "install": {
            "unix": "curl -fsSL https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.sh | sh",
            "windows": "irm https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.ps1 | iex"
        },
        "update": {"unix": "openblocks update", "windows": "openblocks update"},
        "mcp": {
            "name": "openblocks", "command": "{cli}", "args": ["mcp"],
            "description": "Páginas, búsqueda, enlaces, propiedades y nota del día del vault de OpenBlocks",
            "description_en": "Pages, search, links, properties and daily note of the OpenBlocks vault"
        },
        "features": ["Bloques", "Markdown", "Bases de datos", "Grafo", "IA"],
        "webstore": "app.openblocks.desktop"
    })
}

/// Adds (or with `on = false` removes) OpenBlocks in `~/.workstudio/apps.json`. Keeps a backup.
pub fn workstudio_register(on: bool) -> Result<()> {
    let dir = util::user_home().join(".workstudio");
    std::fs::create_dir_all(&dir)?;
    let p = dir.join("apps.json");
    let mut doc: Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({"version": 1, "apps": []}));
    if p.exists() {
        let _ = std::fs::copy(&p, dir.join("apps.json.bak-openblocks"));
    }
    if !doc["apps"].is_array() {
        doc["apps"] = json!([]);
    }
    let apps = doc["apps"].as_array_mut().unwrap();
    apps.retain(|a| a["id"] != "openblocks");
    if on {
        apps.push(workstudio_entry());
    }
    std::fs::write(&p, serde_json::to_string_pretty(&doc)?)?;
    Ok(())
}
