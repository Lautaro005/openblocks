//! How each kind of model is called. API models get OpenBlocks' tools and OpenBlocks runs the tool
//! loop; CLI agents (Claude Code, Codex) get the same tools through `openblocks mcp`.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::tools::{self, Ctx};
use super::Run;
use crate::util;
use crate::vault::Vault;

const MAX_STEPS: usize = 12;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(900))
        .build()
        .unwrap_or_default()
}

/// Reads a streaming body line by line, stopping when the run is cancelled.
async fn lines(
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    resp: reqwest::Response,
    mut f: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = vec![];
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        buf.extend_from_slice(&chunk?);
        while let Some(i) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            let s = String::from_utf8_lossy(&line);
            let s = s.trim_end_matches(['\n', '\r']);
            if !s.is_empty() {
                f(s)?;
            }
        }
    }
    if !buf.is_empty() {
        let s = String::from_utf8_lossy(&buf).to_string();
        f(s.trim())?;
    }
    Ok(())
}

async fn check(resp: reqwest::Response, who: &str) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let code = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or(v["error"].as_str())
                .or(v["message"].as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| util::clip(&body, 300));
    bail!("{who} ({code}): {msg}")
}

fn tool_defs(ctx: &Ctx) -> Vec<Value> {
    tools::definitions(ctx.can_edit, &ctx.pills, !ctx.attachments.is_empty())
}

async fn run_tool(run: &mut Run, ctx: &Ctx, name: &str, args: &Value) -> String {
    run.tool(name, args);
    match tools::exec(ctx, name, args).await {
        Ok(o) => {
            let first = o.text.lines().next().unwrap_or("").to_string();
            run.tool_done(true, &first);
            if let Some(e) = o.edit {
                run.edit(e);
            }
            util::clip(&o.text, 30_000)
        }
        Err(e) => {
            run.tool_done(false, &e.to_string());
            format!("ERROR: {e}")
        }
    }
}

// ---------- OpenAI-compatible (OpenAI, LM Studio, OpenRouter) ----------

pub async fn openai(
    run: &mut Run,
    ctx: &Ctx,
    base: &str,
    key: &str,
    model: &str,
    sys: &str,
    history: &[(String, String)],
) -> Result<()> {
    let mut messages: Vec<Value> = vec![json!({"role": "system", "content": sys})];
    for (r, t) in history {
        messages.push(json!({"role": r, "content": t}));
    }
    let defs: Vec<Value> = tool_defs(ctx)
        .into_iter()
        .map(|d| json!({"type": "function", "function": d}))
        .collect();
    let mut use_tools = !defs.is_empty();
    for _ in 0..MAX_STEPS {
        let mut body = json!({"model": model, "messages": messages, "stream": true});
        if use_tools {
            body["tools"] = json!(defs);
        }
        let mut rq = client()
            .post(format!("{base}/chat/completions"))
            .json(&body);
        if !key.is_empty() {
            rq = rq.bearer_auth(key);
        }
        if base.contains("openrouter.ai") {
            rq = rq
                .header("HTTP-Referer", "https://lautaro005.github.io/openblocks/")
                .header("X-Title", "OpenBlocks");
        }
        let resp = rq.send().await?;
        if !resp.status().is_success() && use_tools {
            let code = resp.status();
            let t = resp.text().await.unwrap_or_default();
            if code.as_u16() == 400 && t.to_lowercase().contains("tool") {
                use_tools = false;
                continue;
            }
            bail!("{model} ({code}): {}", util::clip(&t, 300));
        }
        let resp = check(resp, model).await?;
        let mut text = String::new();
        let mut calls: Vec<(String, String, String)> = vec![];
        let mut in_think = false;
        lines(&run.cancel.clone(), resp, |l| {
            let Some(d) = l.strip_prefix("data:") else {
                return Ok(());
            };
            let d = d.trim();
            if d == "[DONE]" {
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<Value>(d) else {
                return Ok(());
            };
            let delta = &v["choices"][0]["delta"];
            if let Some(r) = delta["reasoning_content"]
                .as_str()
                .or(delta["reasoning"].as_str())
            {
                run.think(r);
            }
            if let Some(c) = delta["content"].as_str() {
                // Some local models put their reasoning in <think> tags.
                let mut rest = c;
                while !rest.is_empty() {
                    if in_think {
                        match rest.find("</think>") {
                            Some(i) => {
                                run.think(&rest[..i]);
                                rest = &rest[i + 8..];
                                in_think = false;
                            }
                            None => {
                                run.think(rest);
                                rest = "";
                            }
                        }
                    } else {
                        match rest.find("<think>") {
                            Some(i) => {
                                text.push_str(&rest[..i]);
                                run.delta(&rest[..i]);
                                rest = &rest[i + 7..];
                                in_think = true;
                            }
                            None => {
                                text.push_str(rest);
                                run.delta(rest);
                                rest = "";
                            }
                        }
                    }
                }
            }
            for tc in delta["tool_calls"].as_array().into_iter().flatten() {
                let i = tc["index"].as_u64().unwrap_or(calls.len() as u64) as usize;
                while calls.len() <= i {
                    calls.push(Default::default());
                }
                if let Some(id) = tc["id"].as_str() {
                    calls[i].0 = id.to_string();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    calls[i].1.push_str(n);
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    calls[i].2.push_str(a);
                }
            }
            if let Some(e) = v["error"]["message"].as_str() {
                bail!("{e}");
            }
            Ok(())
        })
        .await?;
        if calls.is_empty() || run.cancelled() {
            return Ok(());
        }
        let tc_json: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, (id, n, a))| {
                let id = if id.is_empty() { format!("call_{i}") } else { id.clone() };
                json!({"id": id, "type": "function", "function": {"name": n, "arguments": if a.is_empty() { "{}" } else { a }}})
            })
            .collect();
        messages.push(json!({"role": "assistant", "content": text, "tool_calls": tc_json}));
        for (i, (_, n, a)) in calls.iter().enumerate() {
            let args: Value =
                serde_json::from_str(if a.is_empty() { "{}" } else { a }).unwrap_or(json!({}));
            let result = run_tool(run, ctx, n, &args).await;
            messages
                .push(json!({"role": "tool", "tool_call_id": tc_json[i]["id"], "content": result}));
        }
        if !run.text.is_empty() && !run.text.ends_with("\n\n") {
            run.delta("\n\n");
        }
    }
    Ok(())
}

pub async fn openai_plain(
    run: &mut Run,
    base: &str,
    key: &str,
    model: &str,
    sys: &str,
    history: &[(String, String)],
) -> Result<()> {
    openai(run, &none_ctx(), base, key, model, sys, history).await
}

fn none_ctx() -> Ctx {
    Ctx {
        vault: Arc::new(empty_vault_ctx()),
        settings: Default::default(),
        can_edit: false,
        pills: vec!["__none".into()],
        attachments: vec![],
    }
}

fn empty_vault_ctx() -> Vault {
    // Only used to satisfy the type in text-only calls; never touches disk.
    Vault::empty()
}

// ---------- Ollama ----------

pub async fn ollama(
    run: &mut Run,
    ctx: &Ctx,
    url: &str,
    model: &str,
    sys: &str,
    history: &[(String, String)],
) -> Result<()> {
    let base = url.trim_end_matches('/');
    let mut messages: Vec<Value> = vec![json!({"role": "system", "content": sys})];
    for (r, t) in history {
        messages.push(json!({"role": r, "content": t}));
    }
    let defs: Vec<Value> = tool_defs(ctx)
        .into_iter()
        .map(|d| json!({"type": "function", "function": d}))
        .collect();
    let mut use_tools = !defs.is_empty();
    for _ in 0..MAX_STEPS {
        let mut body = json!({"model": model, "messages": messages, "stream": true});
        if use_tools {
            body["tools"] = json!(defs);
        }
        let resp = client()
            .post(format!("{base}/api/chat"))
            .json(&body)
            .send()
            .await
            .map_err(|_| anyhow!("Ollama no está abierto en {base}"))?;
        if !resp.status().is_success() && use_tools {
            let t = resp.text().await.unwrap_or_default();
            if t.contains("does not support tools") {
                use_tools = false;
                continue;
            }
            bail!("Ollama: {}", util::clip(&t, 300));
        }
        let resp = check(resp, "Ollama").await?;
        let mut text = String::new();
        let mut calls: Vec<Value> = vec![];
        let mut in_think = false;
        lines(&run.cancel.clone(), resp, |l| {
            let Ok(v) = serde_json::from_str::<Value>(l) else {
                return Ok(());
            };
            if let Some(e) = v["error"].as_str() {
                bail!("Ollama: {e}");
            }
            let m = &v["message"];
            if let Some(t) = m["thinking"].as_str() {
                run.think(t);
            }
            if let Some(c) = m["content"].as_str() {
                let mut rest = c;
                while !rest.is_empty() {
                    if in_think {
                        match rest.find("</think>") {
                            Some(i) => {
                                run.think(&rest[..i]);
                                rest = &rest[i + 8..];
                                in_think = false;
                            }
                            None => {
                                run.think(rest);
                                rest = "";
                            }
                        }
                    } else if let Some(i) = rest.find("<think>") {
                        text.push_str(&rest[..i]);
                        run.delta(&rest[..i]);
                        rest = &rest[i + 7..];
                        in_think = true;
                    } else {
                        text.push_str(rest);
                        run.delta(rest);
                        rest = "";
                    }
                }
            }
            for tc in m["tool_calls"].as_array().into_iter().flatten() {
                calls.push(tc.clone());
            }
            Ok(())
        })
        .await?;
        if calls.is_empty() || run.cancelled() {
            return Ok(());
        }
        messages.push(json!({"role": "assistant", "content": text, "tool_calls": calls}));
        for c in &calls {
            let name = c["function"]["name"].as_str().unwrap_or("");
            let args = match &c["function"]["arguments"] {
                Value::String(s) => serde_json::from_str(s).unwrap_or(json!({})),
                v => v.clone(),
            };
            let result = run_tool(run, ctx, name, &args).await;
            messages.push(json!({"role": "tool", "content": result, "tool_name": name}));
        }
        if !run.text.is_empty() && !run.text.ends_with("\n\n") {
            run.delta("\n\n");
        }
    }
    Ok(())
}

pub async fn ollama_plain(
    run: &mut Run,
    url: &str,
    model: &str,
    sys: &str,
    history: &[(String, String)],
) -> Result<()> {
    ollama(run, &none_ctx(), url, model, sys, history).await
}

// ---------- Anthropic ----------

fn anthropic_body(
    model: &str,
    sys: &str,
    messages: &[Value],
    tools: &[Value],
    fallback: bool,
) -> Value {
    let mut b = json!({
        "model": model,
        "max_tokens": 64000,
        "stream": true,
        "system": sys,
        "messages": messages,
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "medium"},
    });
    if !tools.is_empty() {
        b["tools"] = json!(tools);
    }
    if fallback {
        b["fallbacks"] = json!("default");
    }
    b
}

pub async fn anthropic(
    run: &mut Run,
    ctx: &Ctx,
    key: &str,
    model: &str,
    sys: &str,
    history: &[(String, String)],
) -> Result<()> {
    if key.is_empty() {
        bail!("falta la clave de Anthropic en Ajustes → IA");
    }
    let mut messages: Vec<Value> = history
        .iter()
        .map(|(r, t)| json!({"role": r, "content": t}))
        .collect();
    let defs: Vec<Value> = tool_defs(ctx)
        .into_iter()
        .map(|d| json!({"name": d["name"], "description": d["description"], "input_schema": d["parameters"], "eager_input_streaming": true}))
        .collect();
    // Server-side fallback reroutes a request the safety classifiers decline; it exists on the
    // current Opus, Sonnet and Fable models.
    let mut fallback = matches!(
        model,
        "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-fable-5-1"
    );
    let mut step = 0;
    while step < MAX_STEPS {
        let mut rq = client()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&anthropic_body(model, sys, &messages, &defs, fallback));
        if fallback {
            rq = rq.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        let resp = rq.send().await?;
        if !resp.status().is_success() && fallback && resp.status().as_u16() == 400 {
            // Retry once without the fallback option if this account or model refuses it.
            let t = resp.text().await.unwrap_or_default();
            if t.contains("fallback") {
                fallback = false;
                continue;
            }
            bail!("Anthropic: {}", util::clip(&t, 300));
        }
        let resp = check(resp, "Anthropic").await?;
        step += 1;
        let mut blocks: Vec<Value> = vec![];
        let mut partial: Vec<String> = vec![];
        let mut stop = String::new();
        lines(&run.cancel.clone(), resp, |l| {
            let Some(d) = l.strip_prefix("data:") else {
                return Ok(());
            };
            let Ok(v) = serde_json::from_str::<Value>(d.trim()) else {
                return Ok(());
            };
            match v["type"].as_str().unwrap_or("") {
                "content_block_start" => {
                    let i = v["index"].as_u64().unwrap_or(blocks.len() as u64) as usize;
                    while blocks.len() <= i {
                        blocks.push(Value::Null);
                        partial.push(String::new());
                    }
                    let b = v["content_block"].clone();
                    if b["type"] == "text" && !run.text.is_empty() && !run.text.ends_with("\n\n") {
                        run.delta("\n\n");
                    }
                    blocks[i] = b;
                }
                "content_block_delta" => {
                    let i = v["index"].as_u64().unwrap_or(0) as usize;
                    if i >= blocks.len() {
                        return Ok(());
                    }
                    let dl = &v["delta"];
                    match dl["type"].as_str().unwrap_or("") {
                        "text_delta" => {
                            let t = dl["text"].as_str().unwrap_or("");
                            let cur = blocks[i]["text"].as_str().unwrap_or("").to_string();
                            blocks[i]["text"] = json!(cur + t);
                            run.delta(t);
                        }
                        "thinking_delta" => {
                            let t = dl["thinking"].as_str().unwrap_or("");
                            let cur = blocks[i]["thinking"].as_str().unwrap_or("").to_string();
                            blocks[i]["thinking"] = json!(cur + t);
                            run.think(t);
                        }
                        "signature_delta" => {
                            let t = dl["signature"].as_str().unwrap_or("");
                            let cur = blocks[i]["signature"].as_str().unwrap_or("").to_string();
                            blocks[i]["signature"] = json!(cur + t);
                        }
                        "input_json_delta" => {
                            partial[i].push_str(dl["partial_json"].as_str().unwrap_or(""))
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let i = v["index"].as_u64().unwrap_or(0) as usize;
                    if i < blocks.len() && blocks[i]["type"] == "tool_use" {
                        // Eager streaming does not validate the input; a broken one becomes an error result.
                        blocks[i]["input"] = if partial[i].trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&partial[i])
                                .unwrap_or(json!({"__invalid_json": true}))
                        };
                    }
                }
                "message_delta" => {
                    if let Some(s) = v["delta"]["stop_reason"].as_str() {
                        stop = s.to_string();
                    }
                }
                "error" => bail!(
                    "Anthropic: {}",
                    v["error"]["message"].as_str().unwrap_or("error")
                ),
                _ => {}
            }
            Ok(())
        })
        .await?;
        if run.cancelled() {
            return Ok(());
        }
        if stop == "refusal" {
            bail!("Claude no respondió a este pedido (lo rechazaron los filtros de seguridad).");
        }
        let blocks: Vec<Value> = blocks.into_iter().filter(|b| !b.is_null()).collect();
        if stop != "tool_use" {
            if stop == "max_tokens" {
                run.delta("\n\n_(Se cortó la respuesta por el largo máximo.)_");
            }
            return Ok(());
        }
        // Pass the assistant turn back unchanged (thinking blocks included) and answer every tool
        // call in a single user message.
        messages.push(json!({"role": "assistant", "content": blocks}));
        let mut results = vec![];
        for b in &blocks {
            if b["type"] != "tool_use" {
                continue;
            }
            let id = b["id"].clone();
            if b["input"].get("__invalid_json").is_some() {
                results.push(json!({"type": "tool_result", "tool_use_id": id, "is_error": true,
                                    "content": "INVALID_JSON: the tool input was not valid JSON. Try again."}));
                continue;
            }
            let name = b["name"].as_str().unwrap_or("");
            let out = run_tool(run, ctx, name, &b["input"]).await;
            let err = out.starts_with("ERROR:");
            results.push(
                json!({"type": "tool_result", "tool_use_id": id, "content": out, "is_error": err}),
            );
        }
        messages.push(json!({"role": "user", "content": results}));
    }
    Ok(())
}

pub async fn anthropic_plain(
    run: &mut Run,
    key: &str,
    model: &str,
    sys: &str,
    history: &[(String, String)],
) -> Result<()> {
    anthropic(run, &none_ctx(), key, model, sys, history).await
}

// ---------- CLI agents ----------

/// The `openblocks mcp` command for a CLI agent. Changes it makes are written to `log`, so they
/// become Undo cards in the chat.
fn mcp_args(v: &Vault, ctx: &Ctx, log: &std::path::Path) -> (String, Vec<String>) {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "openblocks".into());
    let mut args = vec![
        "mcp".to_string(),
        "--vault".into(),
        v.root.to_string_lossy().into_owned(),
        "--edits-log".into(),
        log.to_string_lossy().into_owned(),
    ];
    for a in &ctx.attachments {
        args.push("--attach".into());
        args.push(a.path.to_string_lossy().into_owned());
    }
    if !ctx.can_edit {
        args.push("--read-only".into());
    }
    let pills: Vec<&str> = ctx
        .pills
        .iter()
        .map(|s| s.as_str())
        .filter(|p| ["web", "brain", "lumina"].contains(p))
        .collect();
    if !pills.is_empty() {
        args.push("--with".into());
        args.push(pills.join(","));
    }
    (exe, args)
}

fn toml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// Runs a CLI and hands each stdout line to `f`. Returns stderr's tail on failure.
async fn spawn_lines(
    run: &mut Run,
    mut cmd: tokio::process::Command,
    mut f: impl FnMut(&mut Run, &str),
) -> Result<(bool, String)> {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let out = child.stdout.take().ok_or_else(|| anyhow!("sin salida"))?;
    let err = child.stderr.take().ok_or_else(|| anyhow!("sin stderr"))?;
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let mut r = BufReader::new(err).lines();
        while let Ok(Some(l)) = r.next_line().await {
            s.push_str(&l);
            s.push('\n');
            if s.len() > 20_000 {
                s.drain(..10_000);
            }
        }
        s
    });
    let mut r = BufReader::new(out).lines();
    loop {
        tokio::select! {
            l = r.next_line() => match l {
                Ok(Some(l)) => f(run, &l),
                _ => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(300)) => {
                if run.cancel.load(Ordering::Relaxed) {
                    let _ = child.kill().await;
                    break;
                }
            }
        }
    }
    let status = child.wait().await?;
    let e = err_task.await.unwrap_or_default();
    Ok((status.success(), e))
}

fn last_lines(err: &str, who: &str) -> String {
    let l: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
    if l.is_empty() {
        format!("{who} terminó con un error.")
    } else {
        l[l.len().saturating_sub(4)..].join("\n")
    }
}

/// After a CLI agent finished, turn the changes it made over MCP into Undo cards.
fn edits_from_log(run: &mut Run, log: &std::path::Path) {
    if let Ok(t) = std::fs::read_to_string(log) {
        for l in t.lines() {
            if let Ok(e) = serde_json::from_str::<Value>(l) {
                run.edit(e);
            }
        }
    }
    let _ = std::fs::remove_file(log);
}

fn edits_log() -> std::path::PathBuf {
    let d = util::home_dir().join("mcp");
    let _ = std::fs::create_dir_all(&d);
    d.join(format!("edits-{}.jsonl", util::new_id()))
}

pub async fn claude_cli(
    run: &mut Run,
    v: &Vault,
    ctx: &Ctx,
    model: &str,
    sys: &str,
    prompt: &str,
) -> Result<()> {
    let bin = util::which("claude").ok_or_else(|| anyhow!("Claude Code no está instalado"))?;
    let use_tools = !ctx.pills.iter().any(|p| p == "__none");
    let cfg = util::home_dir()
        .join("mcp")
        .join(format!("claude-{}.json", util::new_id()));
    let log = edits_log();
    if use_tools {
        let (exe, args) = mcp_args(v, ctx, &log);
        std::fs::create_dir_all(cfg.parent().unwrap())?;
        std::fs::write(
            &cfg,
            serde_json::to_string(
                &json!({"mcpServers": {"openblocks": {"command": exe, "args": args}}}),
            )?,
        )?;
    }
    let mut cmd = util::tokio_command(bin);
    cmd.current_dir(&v.root);
    cmd.args([
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ])
    .args(["--model", if model.is_empty() { "sonnet" } else { model }])
    .args(["--append-system-prompt", sys])
    .args([
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
    ]);
    if use_tools {
        cmd.args([
            "--mcp-config",
            &cfg.to_string_lossy(),
            "--allowedTools",
            "mcp__openblocks",
        ]);
    }
    let mut result_err = String::new();
    let mut texted = false;
    let (ok, err) = spawn_lines(run, cmd, |run, line| {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match v["type"].as_str().unwrap_or("") {
            "stream_event" => {
                let ev = &v["event"];
                match ev["type"].as_str().unwrap_or("") {
                    "content_block_start"
                        if ev["content_block"]["type"] == "text"
                            && texted
                            && !run.text.ends_with("\n\n") =>
                    {
                        run.delta("\n\n");
                    }
                    "content_block_delta" => match ev["delta"]["type"].as_str().unwrap_or("") {
                        "text_delta" => {
                            texted = true;
                            run.delta(ev["delta"]["text"].as_str().unwrap_or(""));
                        }
                        "thinking_delta" => {
                            run.think(ev["delta"]["thinking"].as_str().unwrap_or(""))
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
            "assistant" => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_use" {
                        run.tool(b["name"].as_str().unwrap_or("tool"), &b["input"]);
                    }
                }
            }
            "user" => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_result" {
                        let txt = match &b["content"] {
                            Value::String(s) => s.clone(),
                            Value::Array(a) => a
                                .iter()
                                .filter_map(|x| x["text"].as_str())
                                .collect::<Vec<_>>()
                                .join(" "),
                            _ => String::new(),
                        };
                        run.tool_done(
                            !b["is_error"].as_bool().unwrap_or(false),
                            txt.lines().next().unwrap_or(""),
                        );
                    }
                }
            }
            "result" => {
                if v["is_error"].as_bool().unwrap_or(false) {
                    result_err = v["result"]
                        .as_str()
                        .unwrap_or("Claude Code falló")
                        .to_string();
                } else if !texted {
                    run.delta(v["result"].as_str().unwrap_or(""));
                }
            }
            _ => {}
        }
    })
    .await?;
    let _ = std::fs::remove_file(&cfg);
    edits_from_log(run, &log);
    if !result_err.is_empty() {
        bail!(result_err);
    }
    if !ok && !run.cancelled() && run.text.is_empty() {
        bail!(last_lines(&err, "Claude Code"));
    }
    Ok(())
}

pub async fn codex_cli(
    run: &mut Run,
    v: &Vault,
    ctx: &Ctx,
    model: &str,
    sys: &str,
    prompt: &str,
) -> Result<()> {
    let bin = util::which("codex").ok_or_else(|| anyhow!("Codex no está instalado"))?;
    let use_tools = !ctx.pills.iter().any(|p| p == "__none");
    let mut cmd = util::tokio_command(bin);
    cmd.current_dir(&v.root);
    cmd.args([
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-c",
        "approval_policy=\"never\"",
    ]);
    if !model.is_empty() {
        cmd.args(["-m", model]);
    }
    let log = edits_log();
    if use_tools {
        let (exe, args) = mcp_args(v, ctx, &log);
        let a: Vec<String> = args.iter().map(|x| toml_str(x)).collect();
        cmd.args([
            "-c",
            &format!("mcp_servers.openblocks.command={}", toml_str(&exe)),
        ]);
        cmd.args([
            "-c",
            &format!("mcp_servers.openblocks.args=[{}]", a.join(",")),
        ]);
    }
    cmd.arg(format!("{sys}\n\n{prompt}"));
    let mut fail = String::new();
    let (ok, err) = spawn_lines(run, cmd, |run, line| {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let item = &v["item"];
        match (
            v["type"].as_str().unwrap_or(""),
            item["type"].as_str().unwrap_or(""),
        ) {
            ("item.started", "mcp_tool_call") => {
                run.tool(item["tool"].as_str().unwrap_or("tool"), &item["arguments"]);
            }
            ("item.completed", "mcp_tool_call") => run.tool_done(item["status"] != "failed", ""),
            ("item.started", "web_search") => run.tool("web search", &json!({})),
            ("item.completed", "web_search") => run.tool_done(true, ""),
            ("item.completed", "reasoning") => run.think(item["text"].as_str().unwrap_or("")),
            ("item.completed", "agent_message") => {
                if !run.text.is_empty() {
                    run.delta("\n\n");
                }
                run.delta(item["text"].as_str().unwrap_or(""));
            }
            ("error", _) | ("turn.failed", _) => {
                fail = v["message"]
                    .as_str()
                    .or_else(|| v["error"]["message"].as_str())
                    .unwrap_or("Codex falló")
                    .to_string();
            }
            _ => {}
        }
    })
    .await?;
    edits_from_log(run, &log);
    if !fail.is_empty() && run.text.is_empty() {
        bail!(fail);
    }
    if !ok && !run.cancelled() && run.text.is_empty() {
        bail!(last_lines(&err, "Codex"));
    }
    Ok(())
}
