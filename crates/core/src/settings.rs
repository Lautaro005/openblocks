//! App settings in `~/.openblocks/settings.json`. Unknown keys are kept, so older and newer
//! versions can share the file. The file holds API keys, so it is written with 0600 permissions.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::util;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct VaultRef {
    pub path: PathBuf,
    pub name: String,
    #[serde(default)]
    pub opened: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "system" | "es" | "en"
    pub language: String,
    /// "system" | "light" | "dark"
    pub theme: String,
    pub vaults: Vec<VaultRef>,
    pub last_vault: Option<PathBuf>,
    pub onboarded: bool,
    /// Editor width: "normal" | "wide"
    pub width: String,
    pub spellcheck: bool,
    /// Folder for daily notes, relative to the vault.
    pub daily_folder: String,
    pub templates_folder: String,
    pub ai: AiSettings,
    pub family: FamilySettings,
    pub check_updates: bool,
    /// Vaults the MCP server offers when no `--vault` is given: "current" or "all".
    pub mcp_scope: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AiSettings {
    /// Model id, e.g. `ollama:llama3.2`, `claude:sonnet`, `opencue:Ada`.
    pub model: String,
    pub ollama_url: String,
    pub lmstudio_url: String,
    pub openai_key: String,
    pub openai_base: String,
    pub anthropic_key: String,
    pub openrouter_key: String,
    /// Extra models typed by the user (`openai:gpt-…`, `anthropic:claude-…`).
    pub custom_models: Vec<String>,
    pub hidden_models: Vec<String>,
    /// Personal instructions added to every chat.
    pub instructions: String,
    /// "ask" (agents propose, you confirm edits) or "edit" (agents edit, you can undo).
    pub edits: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct FamilySettings {
    pub brain: bool,
    pub lumina: bool,
    pub opencue: bool,
    pub workstudio: bool,
    pub brain_url: String,
    pub lumina_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: "system".into(),
            theme: "system".into(),
            vaults: vec![],
            last_vault: None,
            onboarded: false,
            width: "normal".into(),
            spellcheck: true,
            daily_folder: "Diario".into(),
            templates_folder: "Plantillas".into(),
            ai: AiSettings::default(),
            family: FamilySettings::default(),
            check_updates: true,
            mcp_scope: "current".into(),
            extra: Map::new(),
        }
    }
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            model: String::new(),
            ollama_url: "http://127.0.0.1:11434".into(),
            lmstudio_url: "http://127.0.0.1:1234".into(),
            openai_key: String::new(),
            openai_base: "https://api.openai.com/v1".into(),
            anthropic_key: String::new(),
            openrouter_key: String::new(),
            custom_models: vec![],
            hidden_models: vec![],
            instructions: String::new(),
            edits: "edit".into(),
        }
    }
}

impl Default for FamilySettings {
    fn default() -> Self {
        FamilySettings {
            brain: true,
            lumina: true,
            opencue: true,
            workstudio: true,
            brain_url: "http://127.0.0.1:8765".into(),
            lumina_url: "http://127.0.0.1:47770".into(),
        }
    }
}

impl Settings {
    pub fn remember_vault(&mut self, path: &Path, name: &str) {
        self.vaults.retain(|v| v.path != path);
        self.vaults.insert(
            0,
            VaultRef {
                path: path.to_path_buf(),
                name: name.to_string(),
                opened: util::now(),
            },
        );
        self.vaults.truncate(12);
        self.last_vault = Some(path.to_path_buf());
    }

    pub fn english(&self) -> bool {
        match self.language.as_str() {
            "en" => true,
            "es" => false,
            _ => sys_english(),
        }
    }

    /// What the UI may see: keys are replaced by a flag saying whether they are set.
    pub fn public(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(ai) = v.get_mut("ai").and_then(|a| a.as_object_mut()) {
            for k in ["openai_key", "anthropic_key", "openrouter_key"] {
                let set = ai
                    .get(k)
                    .and_then(|x| x.as_str())
                    .is_some_and(|s| !s.is_empty());
                ai.insert(
                    k.into(),
                    Value::String(if set {
                        "•••".into()
                    } else {
                        String::new()
                    }),
                );
            }
        }
        v
    }

    /// Applies a partial update from the UI. Masked keys ("•••") keep the stored value.
    pub fn merge(&mut self, patch: &Value) {
        let mut cur = serde_json::to_value(&*self).unwrap_or(Value::Null);
        merge_json(&mut cur, patch);
        if let Ok(mut s) = serde_json::from_value::<Settings>(cur) {
            for (k, old) in [
                ("openai_key", self.ai.openai_key.clone()),
                ("anthropic_key", self.ai.anthropic_key.clone()),
                ("openrouter_key", self.ai.openrouter_key.clone()),
            ] {
                let field = match k {
                    "openai_key" => &mut s.ai.openai_key,
                    "anthropic_key" => &mut s.ai.anthropic_key,
                    _ => &mut s.ai.openrouter_key,
                };
                if field == "•••" {
                    *field = old;
                }
            }
            *self = s;
        }
    }
}

fn merge_json(a: &mut Value, b: &Value) {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                merge_json(a.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (a, b) => *a = b.clone(),
    }
}

fn sys_english() -> bool {
    use std::sync::OnceLock;
    static EN: OnceLock<bool> = OnceLock::new();
    *EN.get_or_init(|| {
        let env = std::env::var("LANG").unwrap_or_default();
        if !env.is_empty() && !env.starts_with('C') {
            return !env.starts_with("es");
        }
        if cfg!(target_os = "macos") {
            if let Ok(o) = util::command("defaults")
                .args(["read", "-g", "AppleLanguages"])
                .output()
            {
                let s = String::from_utf8_lossy(&o.stdout);
                let first = s.split('"').nth(1).unwrap_or("");
                return !first.starts_with("es");
            }
        }
        true
    })
}

pub fn path() -> PathBuf {
    util::home_dir().join("settings.json")
}

pub fn load() -> Settings {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(s: &Settings) {
    let p = path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let Ok(text) = serde_json::to_string_pretty(s) else {
        return;
    };
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(&tmp, &p);
    }
}

/// `tr("hola", "hello")` in the language the user chose.
pub fn tr<'a>(s: &Settings, es: &'a str, en: &'a str) -> &'a str {
    if s.english() {
        en
    } else {
        es
    }
}
