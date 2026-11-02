//! Small helpers shared by every module.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Seconds since the epoch.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// A short unique id (time + counter), good enough for chats and runs.
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    format!(
        "{:x}{:04x}",
        now_ms(),
        N.fetch_add(1, Ordering::Relaxed) & 0xffff
    )
}

/// Where OpenBlocks keeps its own data (`~/.openblocks`, or `OPENBLOCKS_HOME`).
pub fn home_dir() -> PathBuf {
    if let Ok(h) = std::env::var("OPENBLOCKS_HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    user_home().join(".openblocks")
}

pub fn user_home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Expands a leading `~`.
pub fn expand(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        return user_home().join(rest);
    }
    if p == "~" {
        return user_home();
    }
    PathBuf::from(p)
}

pub fn escape_html(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

/// Truncates on a char boundary.
pub fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Apps opened from the Dock get a bare PATH; add the usual places CLIs live in.
pub fn extend_path() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let home = user_home();
        let mut extra: Vec<PathBuf> = vec![
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".bun/bin"),
            home.join(".npm-global/bin"),
            home.join(".volta/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for e in rd.flatten() {
                extra.push(e.path().join("bin"));
            }
        }
        if cfg!(windows) {
            if let Ok(a) = std::env::var("APPDATA") {
                extra.push(PathBuf::from(a).join("npm"));
            }
        }
        let cur = std::env::var_os("PATH").unwrap_or_default();
        let mut parts: Vec<PathBuf> = std::env::split_paths(&cur).collect();
        for e in extra {
            if e.is_dir() && !parts.contains(&e) {
                parts.push(e);
            }
        }
        if let Ok(p) = std::env::join_paths(parts) {
            std::env::set_var("PATH", p);
        }
    });
}

/// Finds an executable on PATH (after `extend_path`).
pub fn which(name: &str) -> Option<PathBuf> {
    extend_path();
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        vec![".exe".into(), ".cmd".into(), ".bat".into(), "".into()]
    } else {
        vec!["".into()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// A `Command` that does not flash a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

pub fn tokio_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Today's date as YYYY-MM-DD in local time.
pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn stamp() -> String {
    chrono::Local::now().format("%Y%m%dT%H%M%S").to_string()
}
