//! Tools the agents use on the vault (and on the family apps and the web). The same set is offered
//! to API models (Ollama, LM Studio, OpenAI-compatible, Anthropic) and, through `openblocks mcp`, to
//! CLI agents like Claude Code and Codex. Every change can be undone: edits keep a history copy,
//! deletes go to the vault's trash, moves can be moved back.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::settings::Settings;
use crate::vault::{self, Vault};

/// A file the user attached to the conversation (kept in `.openblocks/chat-files`).
#[derive(Clone, Debug)]
pub struct Attachment {
    pub name: String,
    pub path: PathBuf,
}

pub struct Ctx {
    pub vault: Arc<Vault>,
    pub settings: Settings,
    /// Agents can only read when false.
    pub can_edit: bool,
    /// Family and web tools the user turned on for this message.
    pub pills: Vec<String>,
    /// Files attached to this conversation.
    pub attachments: Vec<Attachment>,
}

/// What a tool did: text for the model and, for changes, a card the UI shows with Undo.
pub struct Output {
    pub text: String,
    pub edit: Option<Value>,
}

fn out(text: impl Into<String>) -> Output {
    Output {
        text: text.into(),
        edit: None,
    }
}

fn changed(text: impl Into<String>, edit: Value) -> Output {
    Output {
        text: text.into(),
        edit: Some(edit),
    }
}

fn tool(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({"name": name, "description": desc,
           "parameters": {"type": "object", "properties": props, "required": required}})
}

/// Tool definitions in a neutral form (`name`, `description`, `parameters` JSON Schema).
pub fn definitions(ctx_edit: bool, pills: &[String], attachments: bool) -> Vec<Value> {
    if pills.iter().any(|p| p == "__none") {
        return vec![];
    }
    let mut v = vec![
        tool("search_pages",
             "Full-text search over the vault's pages (titles and bodies). Returns path, title and a snippet for each hit, best first. Start here whenever the user mentions something that may be in their notes. `#tag` filters by tag. Try 2-3 different wordings before concluding something is not in the vault.",
             json!({"query": {"type": "string", "description": "words to look for, or #tag"},
                    "limit": {"type": "integer", "description": "1-30, default 10"}}), &["query"]),
        tool("read_page",
             "Reads one page (its Markdown with YAML properties) or the text of a file in the vault (pdf, docx, xlsx, pptx, csv, txt, html; images and scanned PDFs are read by the local vision model when it is installed). `path` is the vault path from search_pages/list_pages, or just a page title. Read a page before editing it.",
             json!({"path": {"type": "string"}}), &["path"]),
        tool("list_pages",
             "Lists folders, pages and files under a folder, as an indented tree with each item's path. Empty `folder` lists the whole vault. Use it to see how the vault is organized before creating or moving things.",
             json!({"folder": {"type": "string", "description": "vault folder; empty for the whole vault"}}), &[]),
        tool("backlinks",
             "Pages that link to a page, and pages that mention its title without linking (unlinked mentions).",
             json!({"path": {"type": "string"}}), &["path"]),
    ];
    if crate::localai::embed_ready() {
        v.push(tool("find_images",
            "Finds images in the vault by what they show (photos, screenshots, scans, diagrams), ranked by meaning with EmbeddingGemma 2. Describe what you are looking for in words. Read a result with read_page to get its text and a description.",
            json!({"query": {"type": "string"}, "limit": {"type": "integer", "description": "1-20, default 8"}}), &["query"]));
    }
    if attachments {
        v.push(tool("read_attachment",
            "Reads the full text of a file the user attached to this conversation (pdf, docx, xlsx, pptx, csv, txt, md; images and scanned PDFs through the local vision model). Use the file name shown in the attachments list.",
            json!({"name": {"type": "string"}}), &["name"]));
    }
    if ctx_edit {
        v.extend([
            tool("create_page",
                 "Creates a new page and returns its path. `content` is the page body in Markdown (no title heading: the title is the file name). If a page with that title exists in the folder, a number is added to the name.",
                 json!({"title": {"type": "string"},
                        "folder": {"type": "string", "description": "vault folder, created if missing; empty for the root"},
                        "content": {"type": "string"}}), &["title", "content"]),
            tool("edit_page",
                 "Changes the body of an existing page (properties stay as they are; use set_property for those). Modes: `append` adds at the end; `prepend` adds at the start; `insert_after` adds a new block right after the line that contains `find`; `replace_text` replaces the exact text `find` (first match) with `content` — use an empty `content` to delete that text; `replace` rewrites the whole body (only when restructuring most of the page). Prefer the smallest change that does the job.",
                 json!({"path": {"type": "string"},
                        "mode": {"type": "string", "enum": ["append", "prepend", "insert_after", "replace_text", "replace"]},
                        "content": {"type": "string", "description": "Markdown"},
                        "find": {"type": "string", "description": "exact text already in the page (for insert_after and replace_text)"}}),
                 &["path", "mode", "content"]),
            tool("set_property",
                 "Sets a page property (YAML frontmatter), e.g. status, tags, due, owner. An empty value removes it. Lists are written as YAML lists.",
                 json!({"path": {"type": "string"}, "key": {"type": "string"},
                        "value": {"description": "string, number, boolean or list of strings"}}), &["path", "key"]),
            tool("create_folder",
                 "Creates a folder (and its parents). Returns its path.",
                 json!({"path": {"type": "string", "description": "e.g. Projects/2026"}}), &["path"]),
            tool("move",
                 "Moves or renames a page, file or folder. `to` is the new full path (e.g. `Archive/Old idea` renames and moves a page) or an existing folder to move it into. Every [[link]] to it is updated. Use it to organize, sort into folders and rename.",
                 json!({"from": {"type": "string"}, "to": {"type": "string"}}), &["from", "to"]),
            tool("delete",
                 "Moves a page, file or folder to the vault's trash (the user can restore it). Only delete what the user asked you to delete.",
                 json!({"path": {"type": "string"}}), &["path"]),
        ]);
        if attachments {
            v.push(tool("save_attachment",
                "Copies a file the user attached to this conversation into the vault (e.g. to keep the original PDF next to the page you wrote from it). Returns its vault path; embed it in a page with ![[file name]].",
                json!({"name": {"type": "string"}, "folder": {"type": "string", "description": "vault folder; empty for the root"}}),
                &["name"]));
        }
    }
    if pills.iter().any(|p| p == "web") {
        v.push(tool(
            "web_search",
            "Searches the web. Returns titles, URLs and snippets. Follow up with web_fetch to read a result.",
            json!({"query": {"type": "string"}}),
            &["query"],
        ));
        v.push(tool(
            "web_fetch",
            "Reads a web page as plain text.",
            json!({"url": {"type": "string"}}),
            &["url"],
        ));
    }
    if pills.iter().any(|p| p == "brain") {
        v.push(tool("brain_search", "Searches brain, the user's long-term memory (profile, memories, project notes, saved sources).",
                    json!({"query": {"type": "string"}}), &["query"]));
    }
    if pills.iter().any(|p| p == "lumina") {
        v.push(tool(
            "lumina_search",
            "Searches Lumina: the user's meetings, transcripts, meeting notes and indexed files.",
            json!({"query": {"type": "string"}}),
            &["query"],
        ));
    }
    v
}

fn s<'a>(a: &'a Value, k: &str) -> &'a str {
    a.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

fn tree_text(nodes: &[vault::TreeNode], depth: usize, out: &mut String, budget: &mut usize) {
    for n in nodes {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let mark = match n.kind {
            "folder" => "📁 ",
            "page" => "",
            _ => "📎 ",
        };
        out.push_str(&format!(
            "{}{}{} ({})\n",
            "  ".repeat(depth),
            mark,
            n.name,
            n.path
        ));
        if let Some(c) = &n.children {
            tree_text(c, depth + 1, out, budget);
        }
    }
}

/// A vault path from what the model wrote: an exact path, a path without `.md`, or a title.
fn find(v: &Vault, p: &str) -> Result<String> {
    let p = p.trim().trim_matches('/');
    if p.is_empty() {
        bail!("empty path");
    }
    if v.abs(p)?.exists() {
        return Ok(p.to_string());
    }
    let md = format!("{p}.md");
    if v.abs(&md).map(|a| a.exists()).unwrap_or(false) {
        return Ok(md);
    }
    v.resolve(p)
        .ok_or_else(|| anyhow!("nothing called {p} in the vault (use search_pages or list_pages)"))
}

fn attachment<'a>(ctx: &'a Ctx, name: &str) -> Result<&'a Attachment> {
    let n = name.trim();
    ctx.attachments
        .iter()
        .find(|a| a.name == n)
        .or_else(|| {
            ctx.attachments
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case(n))
        })
        .ok_or_else(|| {
            let names: Vec<&str> = ctx.attachments.iter().map(|a| a.name.as_str()).collect();
            anyhow!("no attachment called {n}. Attached: {}", names.join(", "))
        })
}

fn version_before(v: &Vault, p: &str) -> Result<Option<String>> {
    let before = std::fs::read_to_string(v.abs(p)?)?;
    v.snapshot(p, &before, "ai");
    Ok(v.history(p)
        .first()
        .and_then(|h| h["id"].as_str().map(|s| s.to_string())))
}

pub async fn exec(ctx: &Ctx, name: &str, args: &Value) -> Result<Output> {
    let v = &ctx.vault;
    let editing = matches!(
        name,
        "create_page"
            | "edit_page"
            | "set_property"
            | "create_folder"
            | "move"
            | "delete"
            | "save_attachment"
    );
    if editing && !ctx.can_edit {
        bail!("editing is turned off: the user set agents to read only. Propose the change in your answer instead.");
    }
    match name {
        "search_pages" => {
            let lim = args["limit"].as_u64().unwrap_or(10).clamp(1, 30) as usize;
            let hits = crate::search::search(v, s(args, "query"), lim);
            if hits.is_empty() {
                return Ok(out("No pages matched. Try other words, or list_pages."));
            }
            let lines: Vec<String> = hits
                .iter()
                .map(|h| {
                    format!(
                        "- [[{}]] ({}) — {}",
                        h["title"].as_str().unwrap_or(""),
                        h["path"].as_str().unwrap_or(""),
                        h["snippet"].as_str().unwrap_or("")
                    )
                })
                .collect();
            Ok(out(lines.join("\n")))
        }
        "read_page" => {
            let p = find(v, s(args, "path"))?;
            let abs = v.abs(&p)?;
            if abs.is_dir() {
                bail!("{p} is a folder: use list_pages");
            }
            if vault::is_note(&p) {
                let text = std::fs::read_to_string(&abs)?;
                Ok(out(format!(
                    "path: {p}\n\n{}",
                    crate::util::clip(&text, 40_000)
                )))
            } else {
                let text = crate::localai::file_text(&abs).await?;
                if text.trim().is_empty() {
                    bail!("{p} has no readable text");
                }
                Ok(out(format!(
                    "file: {p}\n\n{}",
                    crate::util::clip(&text, 40_000)
                )))
            }
        }
        "read_attachment" => {
            let a = attachment(ctx, s(args, "name"))?;
            let text = crate::localai::file_text(&a.path).await?;
            if text.trim().is_empty() {
                bail!("{} has no readable text", a.name);
            }
            Ok(out(format!(
                "attachment: {}\n\n{}",
                a.name,
                crate::util::clip(&text, 60_000)
            )))
        }
        "list_pages" => {
            let folder = s(args, "folder").trim_matches('/');
            let mut nodes = v.tree();
            if !folder.is_empty() {
                let mut cur = nodes.clone();
                let mut found = None;
                let mut acc = String::new();
                for part in folder.split('/') {
                    acc = if acc.is_empty() {
                        part.to_string()
                    } else {
                        format!("{acc}/{part}")
                    };
                    let Some(n) = cur.iter().find(|n| n.path.eq_ignore_ascii_case(&acc)) else {
                        found = None;
                        break;
                    };
                    found = n.children.clone();
                    cur = found.clone().unwrap_or_default();
                }
                nodes = found.ok_or_else(|| anyhow!("no folder {folder}"))?;
            }
            let mut text = String::new();
            let mut budget = 400;
            tree_text(&nodes, 0, &mut text, &mut budget);
            if budget == 0 {
                text.push_str("… (more items: list a subfolder)\n");
            }
            Ok(out(if text.is_empty() {
                "(empty)".into()
            } else {
                text
            }))
        }
        "find_images" => {
            let lim = args["limit"].as_u64().unwrap_or(8).clamp(1, 20) as usize;
            let hits = crate::localai::find_images(v, s(args, "query"), lim).await?;
            if hits.is_empty() {
                return Ok(out("There are no images in the vault."));
            }
            let lines: Vec<String> = hits
                .iter()
                .map(|(p, score)| {
                    format!(
                        "- ![[{}]] ({p}) — match {:.2}",
                        p.rsplit('/').next().unwrap_or(p),
                        score
                    )
                })
                .collect();
            Ok(out(lines.join("\n")))
        }
        "backlinks" => {
            let p = find(v, s(args, "path"))?;
            Ok(out(v.backlinks(&p).to_string()))
        }
        "create_page" => {
            let folder = s(args, "folder").trim().trim_matches('/');
            let rel = v.create_page(folder, s(args, "title"), s(args, "content"))?;
            Ok(changed(
                format!("Created {rel}"),
                json!({"action": "create", "path": rel, "title": vault::stem(&rel)}),
            ))
        }
        "edit_page" => {
            let p = find(v, s(args, "path"))?;
            if !vault::is_note(&p) {
                bail!("{p} is not a page; only Markdown pages can be edited");
            }
            let page = v.read_page(&p)?;
            let body = page["body"].as_str().unwrap_or("").to_string();
            let content = s(args, "content");
            let needle = s(args, "find");
            let new_body =
                match s(args, "mode") {
                    "append" => format!("{}\n\n{}\n", body.trim_end(), content.trim()),
                    "prepend" => format!("{}\n\n{}", content.trim(), body.trim_start()),
                    "replace" => content.to_string(),
                    "replace_text" => {
                        if needle.is_empty() || !body.contains(needle) {
                            bail!(
                                "the `find` text is not in the page; read_page and copy it exactly"
                            );
                        }
                        body.replacen(needle, content, 1)
                    }
                    "insert_after" => {
                        let at = body.find(needle).filter(|_| !needle.is_empty()).ok_or_else(|| {
                        anyhow!("the `find` text is not in the page; read_page and copy it exactly")
                    })?;
                        let end = body[at..].find('\n').map(|i| at + i).unwrap_or(body.len());
                        format!(
                            "{}\n\n{}\n{}",
                            body[..end].trim_end(),
                            content.trim(),
                            &body[end..]
                        )
                    }
                    m => bail!("unknown mode {m}"),
                };
            let version = version_before(v, &p)?;
            v.save_page(&p, &new_body, None, "none")?;
            Ok(changed(
                format!("Edited {p}"),
                json!({"action": "edit", "path": p, "title": vault::stem(&p), "version": version}),
            ))
        }
        "set_property" => {
            let p = find(v, s(args, "path"))?;
            let val = args
                .get("value")
                .cloned()
                .filter(|x| !(x.is_null() || x.as_str() == Some("")));
            let version = version_before(v, &p)?;
            v.set_prop(&p, s(args, "key"), val)?;
            Ok(changed(
                format!("Set {} on {p}", s(args, "key")),
                json!({"action": "edit", "path": p, "title": vault::stem(&p), "version": version}),
            ))
        }
        "create_folder" => {
            let want = s(args, "path").trim().trim_matches('/');
            if want.is_empty() {
                bail!("empty path");
            }
            if v.abs(want)?.is_dir() {
                return Ok(out(format!("{want} already exists")));
            }
            let rel = v.create_folder(want)?;
            Ok(changed(
                format!("Created folder {rel}"),
                json!({"action": "folder", "path": rel, "title": rel.rsplit('/').next().unwrap_or(&rel)}),
            ))
        }
        "move" => {
            let from = find(v, s(args, "from"))?;
            let mut to = s(args, "to").trim().trim_matches('/').to_string();
            let name = from.rsplit('/').next().unwrap_or(&from).to_string();
            if to.is_empty() {
                to = name.clone();
            } else if to != from && v.abs(&to)?.is_dir() {
                // An existing folder: move the item into it.
                to = format!("{to}/{name}");
            }
            let (rel, fixed) = v.move_entry(&from, &to)?;
            Ok(changed(
                format!("Moved {from} → {rel} ({fixed} links updated)"),
                json!({"action": "move", "path": rel, "from": from, "title": vault::stem(&rel)}),
            ))
        }
        "delete" => {
            let p = find(v, s(args, "path"))?;
            let id = v.trash(&p)?;
            Ok(changed(
                format!("Moved {p} to the trash"),
                json!({"action": "delete", "path": p, "title": vault::stem(&p), "trash": id}),
            ))
        }
        "save_attachment" => {
            let a = attachment(ctx, s(args, "name"))?;
            let data = std::fs::read(&a.path)?;
            let folder = s(args, "folder").trim().trim_matches('/');
            let (base, ext) = match a.name.rsplit_once('.') {
                Some((b, e)) if !b.is_empty() => (b.to_string(), format!(".{e}")),
                _ => (a.name.clone(), String::new()),
            };
            let rel = v.free_name(folder, &base, &ext)?;
            v.write_bytes(&rel, &data)?;
            Ok(changed(
                format!("Saved {rel}"),
                json!({"action": "create", "path": rel, "title": a.name}),
            ))
        }
        "web_search" => {
            let r = crate::web::search(s(args, "query"), 8).await?;
            Ok(out(serde_json::to_string_pretty(&r)?))
        }
        "web_fetch" => Ok(out(crate::web::fetch(s(args, "url"), 14_000).await?)),
        "brain_search" => {
            let r = crate::family::brain_search(&ctx.settings, s(args, "query"), 6).await?;
            let rows: Vec<String> = r
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    format!(
                        "[{}] {}\n{}",
                        i + 1,
                        h["path"].as_str().or(h["url"].as_str()).unwrap_or(""),
                        crate::util::clip(h["text"].as_str().unwrap_or(""), 1500)
                    )
                })
                .collect();
            Ok(out(if rows.is_empty() {
                "Nothing in brain.".into()
            } else {
                rows.join("\n\n")
            }))
        }
        "lumina_search" => {
            let r = crate::family::lumina_search(&ctx.settings, s(args, "query"), 6).await?;
            let rows: Vec<String> = r
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    let tag: Vec<&str> =
                        [h["kind"].as_str(), h["title"].as_str(), h["date"].as_str()]
                            .into_iter()
                            .flatten()
                            .filter(|x| !x.is_empty())
                            .collect();
                    format!(
                        "[{}] {}\n{}",
                        i + 1,
                        tag.join(" · "),
                        h["text"].as_str().unwrap_or("")
                    )
                })
                .collect();
            Ok(out(if rows.is_empty() {
                "Nothing in Lumina.".into()
            } else {
                rows.join("\n\n")
            }))
        }
        _ => bail!("unknown tool {name}"),
    }
}
