//! The AI chat. One conversation view over the models the user already has: local ones (Ollama,
//! LM Studio), their own API keys (OpenAI-compatible, Anthropic, OpenRouter), the CLI agents they
//! are logged into (Claude Code, Codex) and their OpenCue agents. Agents read and edit the vault with
//! the tools in `tools.rs`; every edit can be undone.

pub mod providers;
pub mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::settings::Settings;
use crate::vault::{self, Vault};
use crate::{family, util, Shared};

#[derive(Default)]
pub struct AiState {
    pub running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    models: Mutex<Option<(Instant, Vec<Value>)>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Msg {
    pub role: String,
    pub text: String,
    pub thinking: String,
    pub tools: Vec<Value>,
    pub edits: Vec<Value>,
    pub model: String,
    pub ts: u64,
    /// Pages attached as context to this message.
    pub context: Vec<String>,
    /// Files the user attached to this message: `{id, name}`.
    pub files: Vec<Value>,
    pub error: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub created: u64,
    pub updated: u64,
    pub model: String,
    pub messages: Vec<Msg>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(default)]
pub struct SendReq {
    pub chat: Option<String>,
    pub text: String,
    pub model: String,
    /// "web", "brain", "lumina"
    pub pills: Vec<String>,
    /// The page open in the editor.
    pub page: Option<String>,
    /// Pages added with @.
    pub mentions: Vec<String>,
    /// Text selected in the editor.
    pub selection: Option<String>,
    /// Ids of files attached with the paperclip (from `save_attachment`).
    pub files: Vec<String>,
}

fn chats_dir(v: &Vault) -> PathBuf {
    v.root.join(vault::META_DIR).join("chats")
}

pub fn list_chats(v: &Vault) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(chats_dir(v))
        .map(|r| {
            r.flatten()
                .filter_map(|e| {
                    let c: Chat = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
                    Some(json!({"id": c.id, "title": c.title, "updated": c.updated, "model": c.model}))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b["updated"].as_u64().cmp(&a["updated"].as_u64()));
    out
}

fn safe_id(id: &str) -> Result<&str> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("id inválido");
    }
    Ok(id)
}

pub fn load_chat(v: &Vault, id: &str) -> Option<Chat> {
    let id = safe_id(id).ok()?;
    serde_json::from_str(&std::fs::read_to_string(chats_dir(v).join(format!("{id}.json"))).ok()?)
        .ok()
}

pub fn save_chat(v: &Vault, c: &Chat) {
    let d = chats_dir(v);
    let _ = std::fs::create_dir_all(&d);
    if let (Ok(id), Ok(s)) = (safe_id(&c.id), serde_json::to_string(c)) {
        let _ = std::fs::write(d.join(format!("{id}.json")), s);
    }
}

pub fn delete_chat(v: &Vault, id: &str) -> Result<()> {
    let id = safe_id(id)?;
    std::fs::remove_file(chats_dir(v).join(format!("{id}.json")))?;
    Ok(())
}

/// Streams events to the UI and keeps the reply.
pub struct Run {
    tx: UnboundedSender<Value>,
    pub cancel: Arc<AtomicBool>,
    pub text: String,
    pub thinking: String,
    pub tools: Vec<Value>,
    pub edits: Vec<Value>,
}

impl AiState {
    /// The cached model list, to clear it when models are added.
    pub fn models_cache_reset(&self) -> std::sync::MutexGuard<'_, Option<(Instant, Vec<Value>)>> {
        self.models.lock().unwrap()
    }
}

impl Run {
    pub fn delta(&mut self, t: &str) {
        if t.is_empty() {
            return;
        }
        self.text.push_str(t);
        let _ = self.tx.send(json!({"kind": "delta", "text": t}));
    }
    pub fn think(&mut self, t: &str) {
        if t.is_empty() {
            return;
        }
        self.thinking.push_str(t);
        let _ = self.tx.send(json!({"kind": "thinking", "text": t}));
    }
    pub fn tool(&mut self, name: &str, input: &Value) {
        let clean = name.trim_start_matches("mcp__openblocks__").to_string();
        self.tools
            .push(json!({"name": clean, "input": input, "done": false}));
        let _ = self
            .tx
            .send(json!({"kind": "tool", "name": clean, "input": input}));
    }
    pub fn tool_done(&mut self, ok: bool, summary: &str) {
        if let Some(t) = self.tools.iter_mut().rev().find(|t| t["done"] == false) {
            t["done"] = json!(true);
            t["ok"] = json!(ok);
            t["summary"] = json!(util::clip(summary, 300));
        }
        let _ = self
            .tx
            .send(json!({"kind": "tool_done", "ok": ok, "summary": util::clip(summary, 300)}));
    }
    pub fn edit(&mut self, e: Value) {
        self.edits.push(e.clone());
        let _ = self.tx.send(json!({"kind": "edit", "edit": e}));
    }
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

// ---------- models ----------

const CLAUDE_MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
];

fn m(id: String, name: String, provider: &str, local: bool, tools: bool) -> Value {
    json!({"id": id, "name": name, "provider": provider, "local": local, "tools": tools})
}

async fn get_json(url: &str, bearer: Option<&str>) -> Option<Value> {
    let c = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
        .ok()?;
    let mut r = c.get(url);
    if let Some(b) = bearer {
        r = r.bearer_auth(b);
    }
    r.send().await.ok()?.json().await.ok()
}

pub async fn models(st: &Shared, refresh: bool) -> Vec<Value> {
    if !refresh {
        if let Some((t, v)) = st.ai.models.lock().unwrap().as_ref() {
            if t.elapsed() < Duration::from_secs(60) {
                return v.clone();
            }
        }
    }
    let s = st.settings.read().unwrap().clone();
    let mut out = vec![];
    let ollama = s.ai.ollama_url.trim_end_matches('/').to_string();
    let lms = s.ai.lmstudio_url.trim_end_matches('/').to_string();
    let openai_base = s.ai.openai_base.trim_end_matches('/').to_string();
    let (u1, u2, u3) = (
        format!("{ollama}/api/tags"),
        format!("{lms}/v1/models"),
        format!("{openai_base}/models"),
    );
    let (o, l, oa) = tokio::join!(get_json(&u1, None), get_json(&u2, None), async {
        if s.ai.openai_key.is_empty() {
            None
        } else {
            get_json(&u3, Some(&s.ai.openai_key)).await
        }
    });
    for x in o
        .as_ref()
        .and_then(|v| v["models"].as_array())
        .into_iter()
        .flatten()
    {
        if let Some(n) = x["name"].as_str() {
            if !n.contains("embed") {
                out.push(m(
                    format!("ollama:{n}"),
                    n.to_string(),
                    "Ollama",
                    true,
                    true,
                ));
            }
        }
    }
    for x in l
        .as_ref()
        .and_then(|v| v["data"].as_array())
        .into_iter()
        .flatten()
    {
        if let Some(n) = x["id"].as_str() {
            if !n.contains("embed") {
                out.push(m(
                    format!("lmstudio:{n}"),
                    n.to_string(),
                    "LM Studio",
                    true,
                    true,
                ));
            }
        }
    }
    if util::which("claude").is_some() {
        for (alias, name) in [
            ("opus", "Opus · latest"),
            ("sonnet", "Sonnet · latest"),
            ("haiku", "Haiku · latest"),
        ] {
            out.push(m(
                format!("claude:{alias}"),
                name.into(),
                "Claude Code",
                false,
                true,
            ));
        }
        for (id, name) in CLAUDE_MODELS {
            out.push(m(
                format!("claude:{id}"),
                name.to_string(),
                "Claude Code",
                false,
                true,
            ));
        }
    }
    if util::which("codex").is_some() {
        out.push(m(
            "codex:".into(),
            "Codex · default".into(),
            "Codex",
            false,
            true,
        ));
        let cache = util::user_home().join(".codex/models_cache.json");
        if let Some(v) = std::fs::read_to_string(cache)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            let list = v["models"]
                .as_array()
                .or(v.as_array())
                .cloned()
                .unwrap_or_default();
            for x in list.iter().take(30) {
                let slug = x["slug"].as_str().or(x["id"].as_str()).or(x.as_str());
                if let Some(sl) = slug {
                    let name = x["display_name"].as_str().unwrap_or(sl);
                    out.push(m(
                        format!("codex:{sl}"),
                        name.to_string(),
                        "Codex",
                        false,
                        true,
                    ));
                }
            }
        }
    }
    if !s.ai.anthropic_key.is_empty() {
        for (id, name) in CLAUDE_MODELS {
            out.push(m(
                format!("anthropic:{id}"),
                name.to_string(),
                "Anthropic API",
                false,
                true,
            ));
        }
    }
    for x in oa
        .as_ref()
        .and_then(|v| v["data"].as_array())
        .into_iter()
        .flatten()
    {
        if let Some(n) = x["id"].as_str() {
            let chat_like = ![
                "embedding",
                "tts",
                "whisper",
                "dall-e",
                "image",
                "moderation",
                "audio",
                "realtime",
                "transcribe",
                "search",
            ]
            .iter()
            .any(|bad| n.contains(bad));
            if chat_like {
                out.push(m(
                    format!("openai:{n}"),
                    n.to_string(),
                    "OpenAI",
                    false,
                    true,
                ));
            }
        }
    }
    for c in &s.ai.custom_models {
        let (p, rest) = c.split_once(':').unwrap_or(("openai", c.as_str()));
        let provider = match p {
            "openrouter" => "OpenRouter",
            "anthropic" => "Anthropic API",
            "ollama" => "Ollama",
            "lmstudio" => "LM Studio",
            "claude" => "Claude Code",
            "codex" => "Codex",
            _ => "OpenAI",
        };
        if !out.iter().any(|x| x["id"] == c.as_str()) {
            out.push(m(
                c.clone(),
                rest.to_string(),
                provider,
                matches!(p, "ollama" | "lmstudio"),
                true,
            ));
        }
    }
    if let Some((id, name)) = crate::localai::chat_model() {
        out.push(m(id, name, "Gemma (local)", true, true));
    }
    for a in crate::family::opencue_agents() {
        out.push(
            json!({"id": format!("opencue:{}", a.name), "name": a.name, "provider": "OpenCue",
                        "local": false, "tools": true, "face": a.face, "agent_model": a.model}),
        );
    }
    *st.ai.models.lock().unwrap() = Some((Instant::now(), out.clone()));
    out
}

// ---------- attachments ----------

fn files_dir(v: &Vault) -> PathBuf {
    v.root.join(vault::META_DIR).join("chat-files")
}

/// Keeps a file the user attached in the chat. Returns `{id, name, size, readable}`.
pub fn save_attachment(v: &Vault, name: &str, data: &[u8]) -> Result<Value> {
    let name = vault::clean_name(name.rsplit(['/', '\\']).next().unwrap_or(name));
    let id = util::new_id();
    let d = files_dir(v);
    std::fs::create_dir_all(&d)?;
    let p = d.join(format!("{id}__{name}"));
    std::fs::write(&p, data)?;
    let readable = if crate::localai::is_image(&p) {
        crate::localai::vision_ready()
    } else {
        crate::preview::text_of(&p)
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false)
            || (p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
                && crate::localai::vision_ready())
    };
    Ok(json!({"id": id, "name": name, "size": data.len(), "readable": readable}))
}

fn attachment_by_id(v: &Vault, id: &str) -> Option<tools::Attachment> {
    let id = safe_id(id).ok()?;
    let pre = format!("{id}__");
    std::fs::read_dir(files_dir(v))
        .ok()?
        .flatten()
        .find_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.strip_prefix(&pre).map(|name| tools::Attachment {
                name: name.to_string(),
                path: e.path(),
            })
        })
}

/// Every file attached so far in the conversation, oldest first, without repeats.
fn chat_attachments(v: &Vault, chat: &Chat) -> Vec<tools::Attachment> {
    let mut out: Vec<tools::Attachment> = vec![];
    for m in &chat.messages {
        for f in &m.files {
            if let Some(a) = f["id"].as_str().and_then(|id| attachment_by_id(v, id)) {
                out.retain(|x| x.name != a.name);
                out.push(a);
            }
        }
    }
    out
}

// ---------- routing ----------

/// Where a model id actually runs. OpenCue agents run here, with their own model and who they are,
/// so they work on the user's notes instead of on their OpenCue chats.
struct Route {
    /// ollama | openai | anthropic | claude | codex | bridge
    kind: &'static str,
    model: String,
    base: String,
    key: String,
    agent: Option<family::AgentProfile>,
}

fn is_loopback(url: &str) -> bool {
    ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|p| url.starts_with(p))
}

fn route(s: &Settings, model: &str) -> Result<Route> {
    let (provider, name) = model.split_once(':').unwrap_or((model, ""));
    let r = |kind, base: &str, key: &str| Route {
        kind,
        model: name.to_string(),
        base: base.trim_end_matches('/').to_string(),
        key: key.to_string(),
        agent: None,
    };
    Ok(match provider {
        "ollama" => r("ollama", &s.ai.ollama_url, ""),
        "lmstudio" => r(
            "openai",
            &format!("{}/v1", s.ai.lmstudio_url.trim_end_matches('/')),
            "",
        ),
        "openrouter" => r(
            "openai",
            "https://openrouter.ai/api/v1",
            &s.ai.openrouter_key,
        ),
        "openai" => r("openai", &s.ai.openai_base, &s.ai.openai_key),
        "anthropic" => r("anthropic", "", &s.ai.anthropic_key),
        "claude" => r("claude", "", ""),
        "codex" => r("codex", "", ""),
        "local" => r("local", "", ""),
        "opencue" => {
            let p = family::opencue_profile(name)
                .ok_or_else(|| anyhow::anyhow!("no encontré el agente {name} en OpenCue"))?;
            let m = p.model.clone();
            let base = p.base_url.trim_end_matches('/').to_string();
            let (kind, base, key): (&'static str, String, String) = match p.provider.as_str() {
                "claude_cli" if util::which("claude").is_some() => {
                    ("claude", String::new(), String::new())
                }
                "codex_cli" if util::which("codex").is_some() => {
                    ("codex", String::new(), String::new())
                }
                "ollama" => (
                    "ollama",
                    if base.is_empty() {
                        s.ai.ollama_url.clone()
                    } else {
                        base.trim_end_matches("/v1").to_string()
                    },
                    String::new(),
                ),
                "lmstudio" | "openai_compatible" if is_loopback(&base) => {
                    ("openai", base.clone(), String::new())
                }
                "anthropic" if !s.ai.anthropic_key.is_empty() => {
                    ("anthropic", String::new(), s.ai.anthropic_key.clone())
                }
                "openai" if !s.ai.openai_key.is_empty() => {
                    ("openai", s.ai.openai_base.clone(), s.ai.openai_key.clone())
                }
                "openrouter" if !s.ai.openrouter_key.is_empty() => (
                    "openai",
                    "https://openrouter.ai/api/v1".into(),
                    s.ai.openrouter_key.clone(),
                ),
                // The model needs a key only OpenCue has: ask the agent through OpenCue.
                _ => ("bridge", String::new(), String::new()),
            };
            Route {
                kind,
                model: if kind == "bridge" { p.name.clone() } else { m },
                base: base.trim_end_matches('/').to_string(),
                key,
                agent: Some(p),
            }
        }
        p => bail!("proveedor desconocido: {p}"),
    })
}

// ---------- prompt ----------

fn page_block(v: &Vault, rel: &str, max: usize) -> Option<String> {
    let abs = v.abs(rel).ok()?;
    let text = if vault::is_note(rel) {
        std::fs::read_to_string(&abs).ok()?
    } else {
        crate::preview::text_of(&abs).ok()?
    };
    Some(format!(
        "### {} ({rel})\n````markdown\n{}\n````",
        vault::stem(rel),
        util::clip(&text, max)
    ))
}

/// What a prompt is built for.
pub struct PromptOpts<'a> {
    /// The model can call the vault tools.
    pub tools: bool,
    pub can_edit: bool,
    pub agent: Option<&'a family::AgentProfile>,
    pub attachments: &'a [tools::Attachment],
    /// The text of each attachment (same order), read before building the prompt.
    pub attachment_texts: &'a [String],
}

/// The system prompt: who the assistant is, how it works on the vault, and the context of this
/// message (open page, selection, attached pages and files).
pub fn system_prompt(v: &Vault, s: &Settings, req: &SendReq, o: &PromptOpts) -> String {
    let en = s.english();
    let now = chrono::Local::now();
    let mut p = String::new();
    let who = match o.agent {
        Some(a) => format!("{}, one of the user's OpenCue agents,", a.name),
        None => "the assistant".to_string(),
    };
    p.push_str(&format!(
        "You are {who} working inside OpenBlocks: a local notes app — a Notion-style block editor on top of a folder of Markdown files (an Obsidian-compatible vault). The vault is \"{}\". Now: {} ({}).\n\n",
        v.name(),
        now.format("%A %Y-%m-%d %H:%M"),
        now.format("%Z")
    ));
    p.push_str("Your job is to help the user think, write and keep their notes in order. The vault is the user's own files on their computer: be useful, and be careful with them.\n\n");

    if let Some(a) = o.agent {
        p.push_str("# Who you are\nThese come from your profile in OpenCue. Keep your personality and the user's preferences, but you are answering in OpenBlocks now: work on the user's request and their notes. Don't report on, summarize or quote your OpenCue chats or groups unless the user asks about them.\n");
        if !a.soul.is_empty() {
            p.push_str(&format!("\n## Personality\n{}\n", a.soul));
        }
        if !a.instructions.is_empty() {
            p.push_str(&format!("\n## Your instructions\n{}\n", a.instructions));
        }
        if !a.memory.is_empty() {
            p.push_str(&format!(
                "\n## What you remember about the user\n{}\n",
                a.memory
            ));
        }
        p.push('\n');
    }

    p.push_str("# How to work\n");
    if o.tools {
        p.push_str("1. Look before you answer. For anything about the user's notes, use search_pages (try two or three wordings), then read_page. Never guess what a page says, which pages exist or what they're called.\n");
        if o.can_edit {
            p.push_str("2. When the user asks for a change — write, add, draft, fix, summarize into a page, make a page, organize, sort, move, rename, delete — do it in the vault with the tools. Don't paste a page into the chat when they asked you to put it in their notes.\n");
            p.push_str("3. Make the smallest change that does the job. Read a page before editing it, then prefer edit_page with append, insert_after or replace_text; use mode replace only to restructure most of a page. Don't touch parts the user didn't ask about.\n");
            p.push_str("4. Organizing: list_pages first to see the structure, reuse existing folders and naming, and use move (links update by themselves). For a large reorganization (more than about ten moves or any delete), propose the plan and wait for an OK first.\n");
            p.push_str(
                "5. Delete only what the user asked to delete; deletes go to the vault's trash.\n",
            );
            p.push_str("6. Each change appears to the user as a card with an Undo button. When you finish, say in one or two lines what you changed, linking each page as [[Title]]. Don't repeat the content you wrote.\n");
            p.push_str("7. If a wrong guess would be costly (which page, overwrite or add), ask one short question. Otherwise pick the reasonable option and mention what you assumed.\n");
        } else {
            p.push_str("2. You can only read the vault: the user turned editing off in Settings. When they ask for a change, write the proposed text in your answer, ready to paste, and say which page it belongs in.\n");
        }
        if !o.attachments.is_empty() {
            p.push_str("- The user attached files to this conversation (listed below). Read them with read_attachment when you need more than what is shown. To turn one into notes, write a page with its content organized (headings, lists, tables, key points); keep the original with save_attachment only if the user wants the file in the vault.\n");
        }
        if req.pills.iter().any(|x| x == "web") {
            p.push_str("- Web is on: use web_search and web_fetch for current or outside facts, and cite the URLs you used.\n");
        }
        if req.pills.iter().any(|x| x == "brain") {
            p.push_str("- brain is on: brain_search is the user's long-term memory (profile, projects, saved sources). Use it for facts about them and their work.\n");
        }
        if req.pills.iter().any(|x| x == "lumina") {
            p.push_str("- Lumina is on: lumina_search has the user's meetings and transcripts. Cite the meeting title and date.\n");
        }
    } else {
        p.push_str("You can't use tools in this conversation, so you can't open or change files. Work from the context below; when the user wants something in their notes, write it in your answer ready to paste.\n");
    }

    p.push_str("\n# Writing in the vault\n");
    p.push_str("- Obsidian-flavored Markdown: ## and ### headings (never a # heading with the page title: the title is the file name), - lists, 1. steps, - [ ] tasks, [[Page title]] links, ![[file]] embeds, > [!note] / > [!tip] / > [!warning] callouts, tables, fenced code, ==highlight== and #tags.\n");
    p.push_str("- Page properties (status, tags, dates, owners) go in YAML with set_property, not as text lines.\n");
    p.push_str("- Link to pages that exist with their exact title. Match the language, tone and structure the user already uses in the vault.\n");
    p.push_str("- Write the content itself: no filler, no \"here is your page\" inside the page, no placeholder text the user has to fill unless they asked for a template.\n");

    p.push_str("\n# Answering\n");
    p.push_str(if en {
        "- Answer in the language the user writes in (default English).\n"
    } else {
        "- Answer in the language the user writes in (default Spanish, rioplatense, with \"vos\").\n"
    });
    p.push_str("- Be direct and brief. Markdown with short paragraphs, lists or a table when it helps. Refer to pages as [[Title]].\n");
    p.push_str("- Don't invent pages, quotes, dates or facts. If you couldn't find something, say so and what you searched.\n");

    if !s.ai.instructions.trim().is_empty() {
        p.push_str(&format!(
            "\n# The user's own instructions\n{}\n",
            s.ai.instructions.trim()
        ));
    }

    let mut ctx = String::new();
    if let Some(pg) = req.page.as_deref().filter(|p| !p.is_empty()) {
        if let Some(b) = page_block(v, pg, 24_000) {
            ctx.push_str(&format!(
                "## The page the user has open\n\"This page\" means this one.\n{b}\n\n"
            ));
        }
    }
    if let Some(sel) = req.selection.as_deref().filter(|s| !s.trim().is_empty()) {
        ctx.push_str(&format!(
            "## Text the user selected in that page\n```\n{}\n```\n\n",
            util::clip(sel, 8000)
        ));
    }
    for mpath in req.mentions.iter().take(8) {
        if Some(mpath.as_str()) == req.page.as_deref() {
            continue;
        }
        if let Some(b) = page_block(v, mpath, 12_000) {
            ctx.push_str(&format!("## A page the user added with @\n{b}\n\n"));
        }
    }
    if !o.attachments.is_empty() {
        ctx.push_str("## Files attached to this conversation\n");
        let mut budget: usize = 80_000;
        for (i, a) in o.attachments.iter().enumerate().rev() {
            let text = o.attachment_texts.get(i).cloned().unwrap_or_default();
            let size = std::fs::metadata(&a.path).map(|m| m.len()).unwrap_or(0);
            if text.trim().is_empty() {
                ctx.push_str(&format!(
                    "### {} ({} KB)\n(no readable text: an image or a scanned document, and the local vision model is not installed)\n\n",
                    a.name,
                    size / 1024 + 1
                ));
                continue;
            }
            let take = budget.min(30_000);
            if take < 500 {
                ctx.push_str(&format!(
                    "### {}\n(use read_attachment to read it)\n\n",
                    a.name
                ));
                continue;
            }
            let shown = util::clip(text.trim(), take);
            budget = budget.saturating_sub(shown.len());
            let more = if shown.len() < text.trim().len() {
                "\n(truncated: use read_attachment for the rest)"
            } else {
                ""
            };
            ctx.push_str(&format!(
                "### {}\n````text\n{shown}\n````{more}\n\n",
                a.name
            ));
        }
    }
    if !ctx.is_empty() {
        p.push_str("\n# Context for this message\n");
        p.push_str(&ctx);
    }
    p
}

/// The conversation so far as plain text, for CLI agents that take one prompt.
fn transcript(chat: &Chat, text: &str) -> String {
    let mut t = String::new();
    for m in &chat.messages {
        if m.text.trim().is_empty() {
            continue;
        }
        let who = if m.role == "user" {
            "User"
        } else {
            "Assistant"
        };
        t.push_str(&format!("{who}: {}\n\n", m.text.trim()));
    }
    let tail = if t.len() > 40_000 {
        let mut st = t.len() - 40_000;
        while !t.is_char_boundary(st) {
            st += 1;
        }
        t[st..].to_string()
    } else {
        t
    };
    if tail.is_empty() {
        text.to_string()
    } else {
        format!("Conversation so far:\n\n{tail}User: {text}")
    }
}

/// Starts a reply. Events go to `tx`; the chat is saved when it ends.
pub async fn send(st: Shared, req: SendReq, tx: UnboundedSender<Value>) -> Result<String> {
    let v = st
        .vault()
        .ok_or_else(|| anyhow::anyhow!("no hay un vault abierto"))?;
    let s = st.settings.read().unwrap().clone();
    let text = req.text.trim().to_string();
    if text.is_empty() && req.files.is_empty() {
        bail!("escribí un mensaje");
    }
    let model = if req.model.is_empty() {
        s.ai.model.clone()
    } else {
        req.model.clone()
    };
    if model.is_empty() {
        bail!("elegí un modelo en el selector");
    }
    let mut chat = req
        .chat
        .as_deref()
        .and_then(|id| load_chat(&v, id))
        .unwrap_or_else(|| Chat {
            id: util::new_id(),
            created: util::now(),
            ..Default::default()
        });
    if st.ai.running.lock().unwrap().contains_key(&chat.id) {
        bail!("esperá a que termine la respuesta");
    }
    let files: Vec<Value> = req
        .files
        .iter()
        .filter_map(|id| attachment_by_id(&v, id))
        .zip(req.files.iter())
        .map(|(a, id)| json!({"id": id, "name": a.name}))
        .collect();
    let text = if text.is_empty() {
        "Read the attached files.".to_string()
    } else {
        text
    };
    if chat.title.is_empty() {
        chat.title = util::clip(text.lines().next().unwrap_or(""), 60);
    }
    let prior = chat.clone();
    let mut ctx_pages = req.mentions.clone();
    if let Some(p) = &req.page {
        if !p.is_empty() && !ctx_pages.contains(p) {
            ctx_pages.insert(0, p.clone());
        }
    }
    chat.model = model.clone();
    chat.updated = util::now();
    chat.messages.push(Msg {
        role: "user".into(),
        text: text.clone(),
        ts: util::now(),
        context: ctx_pages,
        files,
        ..Default::default()
    });
    save_chat(&v, &chat);
    let attachments = chat_attachments(&v, &chat);
    let cancel = Arc::new(AtomicBool::new(false));
    st.ai
        .running
        .lock()
        .unwrap()
        .insert(chat.id.clone(), cancel.clone());
    let id = chat.id.clone();
    let _ = tx.send(json!({"kind": "start", "chat": id, "title": chat.title}));
    let st2 = st.clone();
    tokio::spawn(async move {
        let mut run = Run {
            tx: tx.clone(),
            cancel: cancel.clone(),
            text: String::new(),
            thinking: String::new(),
            tools: vec![],
            edits: vec![],
        };
        let can_edit = s.ai.edits != "read";
        let r = run_model(
            &v,
            &s,
            &req,
            &model,
            &prior,
            &text,
            can_edit,
            attachments,
            &mut run,
        )
        .await;
        let mut msg = Msg {
            role: "assistant".into(),
            text: run.text.clone(),
            thinking: run.thinking.clone(),
            tools: run.tools.clone(),
            edits: run.edits.clone(),
            model: model.clone(),
            ts: util::now(),
            ..Default::default()
        };
        match r {
            Ok(()) => {
                if run.text.trim().is_empty() && run.edits.is_empty() && !run.cancelled() {
                    msg.error = "El modelo no devolvió texto.".into();
                }
            }
            Err(e) => msg.error = e.to_string(),
        }
        if !msg.error.is_empty() {
            let _ = tx.send(json!({"kind": "error", "text": msg.error}));
        }
        chat.messages.push(msg);
        chat.updated = util::now();
        save_chat(&v, &chat);
        st2.ai.running.lock().unwrap().remove(&chat.id);
        let _ = tx.send(json!({"kind": "done", "chat": chat.id}));
    });
    Ok(id)
}

/// The message for an OpenCue agent reached through OpenCue itself (when its model needs a key
/// only OpenCue has). It says plainly that this is a one-off request from OpenBlocks.
fn bridge_message(v: &Vault, req: &SendReq, prior: &Chat, text: &str) -> String {
    let mut msg = String::from("[Request from OpenBlocks, the user's notes app. Answer only this request, in your reply. Don't summarize or mention your other chats, groups or tasks.]\n\n");
    let recent: Vec<&Msg> = prior
        .messages
        .iter()
        .rev()
        .filter(|m| !m.text.trim().is_empty())
        .take(6)
        .collect();
    if !recent.is_empty() {
        msg.push_str("Earlier in this OpenBlocks conversation:\n");
        for m in recent.into_iter().rev() {
            let who = if m.role == "user" { "User" } else { "You" };
            msg.push_str(&format!("{who}: {}\n", util::clip(m.text.trim(), 2000)));
        }
        msg.push('\n');
    }
    if let Some(pg) = req.page.as_deref().filter(|p| !p.is_empty()) {
        if let Some(b) = page_block(v, pg, 16_000) {
            msg.push_str(&format!(
                "The page the user has open in OpenBlocks:\n{b}\n\n"
            ));
        }
    }
    for mp in &req.mentions {
        if let Some(b) = page_block(v, mp, 8000) {
            msg.push_str(&format!("A page the user attached:\n{b}\n\n"));
        }
    }
    msg.push_str(&format!("The user's request: {text}"));
    msg
}

#[allow(clippy::too_many_arguments)]
async fn run_model(
    v: &Arc<Vault>,
    s: &Settings,
    req: &SendReq,
    model: &str,
    prior: &Chat,
    text: &str,
    can_edit: bool,
    attachments: Vec<tools::Attachment>,
    run: &mut Run,
) -> Result<()> {
    let mut r = route(s, model)?;
    let mut texts = vec![];
    for a in &attachments {
        if crate::localai::is_image(&a.path) && crate::localai::vision_ready() {
            run.tool("read_attachment", &json!({"name": a.name}));
        }
        let t = crate::localai::file_text(&a.path).await;
        if crate::localai::is_image(&a.path) && crate::localai::vision_ready() {
            run.tool_done(t.is_ok(), "");
        }
        texts.push(t.unwrap_or_default());
    }
    if r.kind == "local" {
        r.base = crate::localai::chat_base().await?;
        r.kind = "openai";
    }
    let ctx = tools::Ctx {
        vault: v.clone(),
        settings: s.clone(),
        can_edit,
        pills: req.pills.clone(),
        attachments,
    };
    if r.kind == "bridge" {
        let mut msg = bridge_message(v, req, prior, text);
        for (i, a) in ctx.attachments.iter().enumerate() {
            let t = texts.get(i).cloned().unwrap_or_default();
            if !t.trim().is_empty() {
                msg.push_str(&format!(
                    "\n\nAttached file {}:\n{}",
                    a.name,
                    util::clip(t.trim(), 20_000)
                ));
            }
        }
        run.tool(&format!("OpenCue → {}", r.model), &json!({}));
        let agent = r.model.clone();
        let reply =
            tokio::task::spawn_blocking(move || family::opencue_send(&agent, &msg)).await??;
        run.tool_done(true, "");
        run.delta(&reply);
        return Ok(());
    }
    let sys = system_prompt(
        v,
        s,
        req,
        &PromptOpts {
            tools: true,
            can_edit,
            agent: r.agent.as_ref(),
            attachments: &ctx.attachments,
            attachment_texts: &texts,
        },
    );
    match r.kind {
        "claude" => {
            providers::claude_cli(run, v, &ctx, &r.model, &sys, &transcript(prior, text)).await
        }
        "codex" => {
            providers::codex_cli(run, v, &ctx, &r.model, &sys, &transcript(prior, text)).await
        }
        _ => {
            let mut history: Vec<(String, String)> = prior
                .messages
                .iter()
                .filter(|m| !m.text.trim().is_empty())
                .map(|m| (m.role.clone(), m.text.clone()))
                .collect();
            // Keep the last ~60k characters of history.
            let mut total = 0;
            let mut keep = history.len();
            for (i, (_, t)) in history.iter().enumerate().rev() {
                total += t.len();
                if total > 60_000 {
                    break;
                }
                keep = i;
            }
            history.drain(..keep);
            history.push(("user".into(), text.to_string()));
            match r.kind {
                "anthropic" => {
                    providers::anthropic(run, &ctx, &r.key, &r.model, &sys, &history).await
                }
                "ollama" => providers::ollama(run, &ctx, &r.base, &r.model, &sys, &history).await,
                _ => providers::openai(run, &ctx, &r.base, &r.key, &r.model, &sys, &history).await,
            }
        }
    }
}

/// One-shot text actions from the editor (improve, shorten, translate, write here…). Streams
/// plain text.
pub async fn inline(
    st: Shared,
    action: &str,
    input: &str,
    extra: &str,
    model: &str,
    tx: UnboundedSender<Value>,
) -> Result<()> {
    let s = st.settings.read().unwrap().clone();
    let v = st
        .vault()
        .ok_or_else(|| anyhow::anyhow!("no hay un vault abierto"))?;
    let model = if model.is_empty() {
        s.ai.model.clone()
    } else {
        model.to_string()
    };
    if model.is_empty() {
        bail!("elegí un modelo de IA en Ajustes → IA");
    }
    let mut r = route(&s, &model)?;
    if r.kind == "local" {
        r.base = crate::localai::chat_base().await?;
        r.kind = "openai";
    }
    let lang = if s.english() {
        "Use the language of the text (default English)."
    } else {
        "Use the language of the text (default Spanish, rioplatense, with \"vos\")."
    };
    let (sys, prompt) = if action == "write" {
        // ⌘. in the editor: write at the cursor (or replace the selection) following an instruction.
        let sys = format!(
            "You write inside the user's page in OpenBlocks, a Markdown notes app (Obsidian-flavored: ## headings, - lists, - [ ] tasks, [[links]], > [!note] callouts, tables).\n\
             The page is below. ⟦HERE⟧ marks where your text goes; or ⟦SELECTION⟧…⟦/SELECTION⟧ marks the text your output replaces.\n\
             Do exactly what the user's instruction asks for that spot, using the rest of the page as context.\n\
             Return ONLY the Markdown to put there: no preamble, no explanation, no code fence around it, no markers, and don't repeat the text around it.\n\
             Match the page's language, tone and formatting. {lang}{}",
            agent_note(r.agent.as_ref())
        );
        let prompt = format!("Instruction: {}\n\nThe page:\n\n{input}", extra.trim());
        (sys, prompt)
    } else {
        let task = match action {
            "improve" => "Improve the writing of the text: clearer and more fluent, same meaning, same language, same Markdown structure.",
            "fix" => "Fix spelling and grammar. Change nothing else.",
            "shorten" => "Make the text shorter, keeping the key points.",
            "expand" => "Expand the text with more detail, in the same voice.",
            "summarize" => "Summarize the text in a few bullet points.",
            "continue" => "Continue writing after the text, in the same voice and language. Return only the new part.",
            "translate" => "Translate the text. If an instruction names a language use it; otherwise translate Spanish to English and any other language to Spanish.",
            "tasks" => "Extract the action items in the text as a Markdown task list (- [ ] …).",
            "table" => "Turn the text into a Markdown table.",
            "explain" => "Explain the text simply, in the same language.",
            _ => "Do what the instruction says with the text.",
        };
        let sys = format!(
            "You transform text for a notes app. {task}\nReturn ONLY the resulting Markdown, with no preamble, no quotes around it and no explanation.{}{}",
            if extra.trim().is_empty() { String::new() } else { format!("\nInstruction from the user: {}", extra.trim()) },
            agent_note(r.agent.as_ref())
        );
        (sys, format!("Text:\n\n{input}"))
    };
    let mut run = Run {
        tx,
        cancel: Arc::new(AtomicBool::new(false)),
        text: String::new(),
        thinking: String::new(),
        tools: vec![],
        edits: vec![],
    };
    let none = tools::Ctx {
        vault: v.clone(),
        settings: s.clone(),
        can_edit: false,
        pills: vec!["__none".into()],
        attachments: vec![],
    };
    let history = vec![("user".to_string(), prompt.clone())];
    match r.kind {
        "anthropic" => providers::anthropic_plain(&mut run, &r.key, &r.model, &sys, &history).await,
        "ollama" => providers::ollama_plain(&mut run, &r.base, &r.model, &sys, &history).await,
        "openai" => {
            providers::openai_plain(&mut run, &r.base, &r.key, &r.model, &sys, &history).await
        }
        "claude" => providers::claude_cli(&mut run, &v, &none, &r.model, &sys, &prompt).await,
        "codex" => providers::codex_cli(&mut run, &v, &none, &r.model, &sys, &prompt).await,
        _ => {
            let agent = r.model.clone();
            let msg = format!("[Request from OpenBlocks, the user's notes app. Reply with only the requested text.]\n\n{sys}\n\n{prompt}");
            let reply =
                tokio::task::spawn_blocking(move || family::opencue_send(&agent, &msg)).await??;
            run.delta(&reply);
            Ok(())
        }
    }
}

fn agent_note(a: Option<&family::AgentProfile>) -> String {
    match a {
        Some(a) if !a.instructions.is_empty() || !a.soul.is_empty() => format!(
            "\n\nYou are {}, one of the user's OpenCue agents. Keep your voice:\n{}\n{}",
            a.name,
            util::clip(&a.soul, 1500),
            util::clip(&a.instructions, 2500)
        ),
        _ => String::new(),
    }
}
