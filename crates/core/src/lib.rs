//! OpenBlocks core.
//!
//! Everything that is not the desktop window lives here: the Markdown vault on disk, the in-memory
//! index (titles, links, tags, properties, full text), file previews, page history and trash, the AI
//! chat with its agents, the family integrations (brain, Lumina, OpenCue, AI WorkStudio), the local
//! HTTP server the UI talks to and the stdio MCP server other agents use.

pub mod ai;
pub mod family;
pub mod http;
pub mod import;
pub mod localai;
pub mod markdown;
pub mod mcp_client;
pub mod mcp_server;
pub mod preview;
pub mod remote;
pub mod search;
pub mod settings;
pub mod sys;
pub mod util;
pub mod vault;
pub mod watcher;
pub mod web;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};

use tokio::sync::broadcast;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_PORT: u16 = 47880;
pub const REPO: &str = "Lautaro005/openblocks";

/// Something the UI should know about right away (sent over `/api/events`).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    /// Files changed on disk (by another program or by an agent).
    Changed { paths: Vec<String> },
    /// The tree changed shape (new, moved or deleted entries).
    Tree,
    /// Another vault was opened.
    Vault,
}

pub struct AppState {
    pub settings: RwLock<settings::Settings>,
    pub vault: RwLock<Option<Arc<vault::Vault>>>,
    pub events: broadcast::Sender<Event>,
    pub ai: ai::AiState,
    watcher: std::sync::Mutex<Option<watcher::Handle>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new() -> Shared {
        let (tx, _) = broadcast::channel(256);
        let st = Arc::new(AppState {
            settings: RwLock::new(settings::load()),
            vault: RwLock::new(None),
            events: tx,
            ai: ai::AiState::default(),
            watcher: std::sync::Mutex::new(None),
        });
        let last = st.settings.read().unwrap().last_vault.clone();
        if let Some(p) = last {
            if p.is_dir() {
                let _ = st.open_vault(&p, None, false);
            }
        }
        st
    }

    pub fn vault(&self) -> Option<Arc<vault::Vault>> {
        self.vault.read().unwrap().clone()
    }

    /// Opens (or creates) a vault and makes it the current one.
    pub fn open_vault(
        self: &Arc<Self>,
        path: &std::path::Path,
        name: Option<String>,
        guide: bool,
    ) -> anyhow::Result<Arc<vault::Vault>> {
        let v = Arc::new(vault::Vault::open(path, name, guide)?);
        {
            let mut s = self.settings.write().unwrap();
            s.remember_vault(&v.root, &v.name());
            settings::save(&s);
        }
        *self.watcher.lock().unwrap() = watcher::start(v.clone(), self.events.clone()).ok();
        *self.vault.write().unwrap() = Some(v.clone());
        let _ = self.events.send(Event::Vault);
        Ok(v)
    }
}

/// What a native picker should let the user choose.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pick {
    Folder,
    /// One or more `.zip` files.
    Zips,
}

/// A native picker the desktop shell can install (it shows a proper sheet). Without it the server
/// falls back to the system's own dialog commands (`osascript`, `zenity`, PowerShell).
type Picker = Box<dyn Fn(&str, Pick) -> Option<Vec<PathBuf>> + Send + Sync>;
static PICKER: OnceLock<Picker> = OnceLock::new();

pub fn set_picker(f: Picker) {
    let _ = PICKER.set(f);
}

pub fn pick(prompt: &str, kind: Pick) -> Option<Vec<PathBuf>> {
    let v = match PICKER.get() {
        Some(p) => p(prompt, kind),
        None if kind == Pick::Folder => sys::pick_folder(prompt).map(|p| vec![p]),
        None => sys::pick_zips(prompt),
    };
    v.filter(|v| !v.is_empty())
}

pub fn pick_folder(prompt: &str) -> Option<PathBuf> {
    pick(prompt, Pick::Folder).and_then(|v| v.into_iter().next())
}

/// Re-exported so the desktop shell does not need its own anyhow dependency.
pub use anyhow;
