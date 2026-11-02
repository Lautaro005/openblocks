//! `openblocks mcp`: the vaults as an MCP server, so Claude Code, Codex, Cursor, OpenCue agents and
//! AI WorkStudio's hub can search, read and edit pages with the same tools as the chat. It runs over
//! stdio (`openblocks mcp`) and, for remote access, over HTTP behind a Cloudflare tunnel (`remote.rs`).
//!
//! Which vaults: `--all` (every vault OpenBlocks knows), `--vault <folder>` (one), or neither — then
//! the choice in Settings → Family → MCP ("all" or "current", the last vault opened).
//! Other options: `--read-only`, `--with web,brain,lumina` (adds those tools). The app also passes
//! `--attach <file>` (files attached in the chat) and `--edits-log <file>` (changes, for Undo cards).

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::ai::tools;
use crate::settings::{self, Settings};
use crate::vault::Vault;

pub struct McpServer {
    /// (name, vault). The first one is the default.
    vaults: Vec<(String, Arc<Vault>)>,
    settings: Settings,
    read_only: bool,
    pills: Vec<String>,
    attachments: Vec<tools::Attachment>,
    edits_log: Option<PathBuf>,
}

/// The vaults a scope means: "all" = every known vault (last opened first), otherwise the last one.
pub fn scope_vaults(s: &Settings, all: bool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![];
    if let Some(l) = s.last_vault.clone().filter(|p| p.is_dir()) {
        out.push(l);
    }
    if all {
        for v in &s.vaults {
            if v.path.is_dir() && !out.contains(&v.path) {
                out.push(v.path.clone());
            }
        }
    }
    out
}

impl McpServer {
    pub fn new(paths: &[PathBuf], s: Settings, read_only: bool) -> Result<McpServer> {
        if paths.is_empty() {
            bail!("no vault: open one in OpenBlocks first or pass --vault <folder>");
        }
        let mut vaults: Vec<(String, Arc<Vault>)> = vec![];
        for p in paths {
            let name = s
                .vaults
                .iter()
                .find(|r| &r.path == p)
                .map(|r| r.name.clone())
                .filter(|n| !n.is_empty());
            let v = Arc::new(Vault::open(p, name, false)?);
            let mut n = v.name();
            let mut i = 2;
            while vaults.iter().any(|(x, _)| x.eq_ignore_ascii_case(&n)) {
                n = format!("{} {i}", v.name());
                i += 1;
            }
            vaults.push((n, v));
        }
        Ok(McpServer {
            vaults,
            settings: s,
            read_only,
            pills: vec![],
            attachments: vec![],
            edits_log: None,
        })
    }

    /// The vaults the settings say ("all" or the current one).
    pub fn from_settings(s: Settings, read_only: bool) -> Result<McpServer> {
        let all = s.mcp_scope == "all";
        let paths = scope_vaults(&s, all);
        McpServer::new(&paths, s, read_only)
    }

    pub fn from_args(args: &[String]) -> Result<McpServer> {
        let mut vault_path: Option<PathBuf> = None;
        let mut all = false;
        let mut read_only = false;
        let mut pills = vec![];
        let mut attachments = vec![];
        let mut edits_log = None;
        let mut it = args.iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--vault" => vault_path = it.next().map(|s| crate::util::expand(s)),
                "--all" => all = true,
                "--read-only" => read_only = true,
                "--edits-log" => edits_log = it.next().map(PathBuf::from),
                "--attach" => {
                    if let Some(p) = it.next() {
                        let path = PathBuf::from(p);
                        let file = path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        // Stored as `<id>__<name>`.
                        let name = file
                            .split_once("__")
                            .map(|(_, n)| n.to_string())
                            .unwrap_or(file);
                        attachments.push(tools::Attachment { name, path });
                    }
                }
                "--with" => {
                    if let Some(w) = it.next() {
                        pills = w
                            .split(',')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                    }
                }
                _ => {}
            }
        }
        let s = settings::load();
        let paths = match vault_path {
            Some(p) => vec![p],
            None => scope_vaults(&s, all || s.mcp_scope == "all"),
        };
        let mut m = McpServer::new(&paths, s, read_only).context("openblocks mcp")?;
        m.pills = pills;
        m.attachments = attachments;
        m.edits_log = edits_log;
        Ok(m)
    }

    pub fn vault_names(&self) -> Vec<String> {
        self.vaults.iter().map(|(n, _)| n.clone()).collect()
    }

    fn multi(&self) -> bool {
        self.vaults.len() > 1
    }

    fn pick(&self, args: &Value) -> Result<&Arc<Vault>> {
        let want = args
            .get("vault")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if want.is_empty() {
            return Ok(&self.vaults[0].1);
        }
        self.vaults
            .iter()
            .find(|(n, v)| n.eq_ignore_ascii_case(want) || v.root.to_string_lossy() == want)
            .map(|(_, v)| v)
            .with_context(|| {
                let names: Vec<&str> = self.vaults.iter().map(|(n, _)| n.as_str()).collect();
                format!("no vault called {want}. Vaults: {}", names.join(", "))
            })
    }

    fn tool_list(&self) -> Vec<Value> {
        let names: Vec<&str> = self.vaults.iter().map(|(n, _)| n.as_str()).collect();
        let multi = self.multi();
        let mut list: Vec<Value> =
            tools::definitions(!self.read_only, &self.pills, !self.attachments.is_empty())
                .into_iter()
                .map(|mut d| {
                    if multi {
                        if let Some(props) = d["parameters"]["properties"].as_object_mut() {
                            props.insert(
                                "vault".into(),
                                json!({"type": "string", "enum": names,
                                       "description": format!("Which vault (default: {})", names[0])}),
                            );
                        }
                    }
                    json!({"name": d["name"], "description": d["description"], "inputSchema": d["parameters"]})
                })
                .collect();
        if multi {
            list.insert(0, json!({
                "name": "list_vaults",
                "description": "Lists the user's OpenBlocks vaults (each one a folder of Markdown pages). Every other tool takes an optional `vault`; without it, the first vault is used.",
                "inputSchema": {"type": "object", "properties": {}},
            }));
        }
        list
    }

    async fn call(&self, name: &str, args: &Value) -> Result<tools::Output> {
        if name == "list_vaults" {
            let rows: Vec<String> = self
                .vaults
                .iter()
                .enumerate()
                .map(|(i, (n, v))| {
                    let st = v.stats();
                    format!(
                        "- {n}{} — {} pages, {} files",
                        if i == 0 { " (default)" } else { "" },
                        st["pages"],
                        st["files"],
                    )
                })
                .collect();
            return Ok(tools::Output {
                text: rows.join("\n"),
                edit: None,
            });
        }
        let v = self.pick(args)?.clone();
        // Re-read the index so pages written by the app or by hand since start are seen.
        v.reindex();
        let ctx = tools::Ctx {
            vault: v,
            settings: self.settings.clone(),
            can_edit: !self.read_only,
            pills: self.pills.clone(),
            attachments: self.attachments.clone(),
        };
        tools::exec(&ctx, name, args).await
    }

    /// Answers one JSON-RPC message. `None` for notifications.
    pub async fn handle(&self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned()?;
        let method = msg["method"].as_str().unwrap_or("");
        let result: Result<Value, (i64, String)> = match method {
            "initialize" => {
                let names: Vec<&str> = self.vaults.iter().map(|(n, _)| n.as_str()).collect();
                let what = if self.multi() {
                    format!(
                        "OpenBlocks vaults {} (use list_vaults; pass `vault` to choose one)",
                        names.join(", ")
                    )
                } else {
                    format!("OpenBlocks vault \"{}\"", names[0])
                };
                Ok(json!({
                    "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "openblocks", "version": crate::VERSION},
                    "instructions": format!("{what}: Markdown pages with [[wikilinks]], #tags and YAML properties. Search before reading; edits keep a history copy the user can restore and deletes go to the vault's trash."),
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": self.tool_list()})),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
                let mut args = msg["params"]["arguments"].clone();
                if args.is_null() {
                    args = json!({});
                }
                Ok(match self.call(&name, &args).await {
                    Ok(o) => {
                        if let (Some(e), Some(log)) = (&o.edit, &self.edits_log) {
                            if let Ok(mut f) = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(log)
                            {
                                let _ = writeln!(f, "{e}");
                            }
                        }
                        json!({"content": [{"type": "text", "text": o.text}]})
                    }
                    Err(e) => {
                        json!({"content": [{"type": "text", "text": format!("ERROR: {e}")}], "isError": true})
                    }
                })
            }
            "resources/list" => Ok(json!({"resources": []})),
            "prompts/list" => Ok(json!({"prompts": []})),
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        Some(match result {
            Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
            Err((code, m)) => {
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": m}})
            }
        })
    }
}

/// `openblocks mcp`: JSON-RPC over stdio, one message per line.
pub fn serve(args: &[String]) -> Result<()> {
    crate::localai::cleanup_stale();
    let srv = McpServer::from_args(args)?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(reply) = rt.block_on(srv.handle(&msg)) {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
    }
    // The client closed the connection: stop the local models this process started.
    rt.block_on(crate::localai::shutdown());
    Ok(())
}
