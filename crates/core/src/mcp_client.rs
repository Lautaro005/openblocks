//! A small MCP client over stdio (newline-delimited JSON-RPC), used to talk to the family's
//! servers: brain (`write_file`), OpenCue (`send_to_agent`) and any other the user adds.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

type Pending = Arc<Mutex<HashMap<u64, Sender<Value>>>>;

pub struct McpClient {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next: Mutex<u64>,
}

impl McpClient {
    pub fn start(cmd: &str, args: &[String], cwd: Option<&std::path::Path>) -> Result<McpClient> {
        crate::util::extend_path();
        let mut c = crate::util::command(cmd);
        c.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(d) = cwd {
            c.current_dir(d);
        }
        let mut child = c
            .spawn()
            .map_err(|e| anyhow!("no pude arrancar {cmd}: {e}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or_else(|| anyhow!("sin stdin"))?,
        ));
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("sin stdout"))?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (p2, in2) = (pending.clone(), stdin.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                // A request from the server (ping, roots/list): answer it.
                if msg.get("method").is_some() {
                    if let Some(id) = msg.get("id") {
                        let result = match msg["method"].as_str() {
                            Some("roots/list") => json!({"roots": []}),
                            _ => json!({}),
                        };
                        let reply = json!({"jsonrpc": "2.0", "id": id, "result": result});
                        if let Ok(mut w) = in2.lock() {
                            let _ = writeln!(w, "{reply}");
                            let _ = w.flush();
                        }
                    }
                    continue;
                }
                if let Some(id) = msg.get("id").and_then(|i| i.as_u64()) {
                    if let Some(tx) = p2.lock().unwrap().remove(&id) {
                        let _ = tx.send(msg);
                    }
                }
            }
        });
        let c = McpClient {
            child,
            stdin,
            pending,
            next: Mutex::new(1),
        };
        c.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "openblocks", "version": crate::VERSION},
            }),
            Duration::from_secs(40),
        )?;
        c.notify("notifications/initialized", json!({}))?;
        Ok(c)
    }

    fn send(&self, msg: &Value) -> Result<()> {
        let mut w = self.stdin.lock().unwrap();
        writeln!(w, "{msg}")?;
        w.flush()?;
        Ok(())
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let msg = rx
            .recv_timeout(timeout)
            .map_err(|_| anyhow!("{method}: no respondió a tiempo"))?;
        if let Some(e) = msg.get("error") {
            bail!(
                "{}",
                e["message"].as_str().unwrap_or("error del servidor MCP")
            );
        }
        Ok(msg["result"].clone())
    }

    pub fn list_tools(&self) -> Result<Vec<Value>> {
        let r = self.request("tools/list", json!({}), Duration::from_secs(30))?;
        Ok(r["tools"].as_array().cloned().unwrap_or_default())
    }

    /// Calls a tool and returns its text content. A tool error becomes an `Err`.
    pub fn call_text(&self, name: &str, args: Value, timeout: Duration) -> Result<String> {
        let r = self.request(
            "tools/call",
            json!({"name": name, "arguments": args}),
            timeout,
        )?;
        let text = r["content"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if r["isError"].as_bool().unwrap_or(false) {
            bail!(if text.is_empty() {
                "la tool falló".to_string()
            } else {
                text
            });
        }
        Ok(text)
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
