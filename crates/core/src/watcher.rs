//! Watches the vault folder so edits made by other programs (Obsidian, a text editor, an agent
//! over MCP, a sync tool) show up at once. Events are batched for 250 ms.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tokio::sync::broadcast;

use crate::vault::{Vault, META_DIR};
use crate::Event;

pub struct Handle {
    _w: notify::RecommendedWatcher,
}

pub fn start(v: Arc<Vault>, tx: broadcast::Sender<Event>) -> notify::Result<Handle> {
    let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut w = notify::recommended_watcher(raw_tx)?;
    w.watch(&v.root, RecursiveMode::Recursive)?;
    let weak = Arc::downgrade(&v);
    std::thread::Builder::new()
        .name("ob-watch".into())
        .spawn(move || loop {
            let Ok(first) = raw_rx.recv() else { return };
            let mut batch = vec![first];
            let until = std::time::Instant::now() + Duration::from_millis(250);
            while let Some(left) = until.checked_duration_since(std::time::Instant::now()) {
                match raw_rx.recv_timeout(left) {
                    Ok(e) => batch.push(e),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let Some(v) = weak.upgrade() else { return };
            let mut paths: Vec<PathBuf> = vec![];
            let mut shape = false;
            for e in batch.into_iter().flatten() {
                use notify::EventKind::*;
                if matches!(e.kind, Create(_) | Remove(_))
                    || matches!(e.kind, Modify(notify::event::ModifyKind::Name(_)))
                {
                    shape = true;
                }
                if matches!(e.kind, Access(_)) {
                    continue;
                }
                for p in e.paths {
                    if !paths.contains(&p) {
                        paths.push(p);
                    }
                }
            }
            let mut changed = vec![];
            for p in paths {
                let Some(rel) = v.rel(&p) else { continue };
                if rel.split('/').any(|c| c == META_DIR || c.starts_with('.'))
                    || rel.ends_with(".ob-tmp")
                {
                    continue;
                }
                let ours = v.wrote_recently(&p);
                v.reindex_one(&rel);
                if !ours {
                    changed.push(rel);
                }
            }
            if shape {
                let _ = tx.send(Event::Tree);
            }
            if !changed.is_empty() {
                let _ = tx.send(Event::Changed { paths: changed });
            }
        })
        .ok();
    Ok(Handle { _w: w })
}
