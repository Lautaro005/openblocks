//! HTML artifacts: pages of HTML, CSS and JavaScript kept in the vault (a dashboard, a calculator,
//! a chart of a spreadsheet), shown inside the app. They run sandboxed, with no access to the app,
//! the vault or the network (only scripts and styles from the usual library CDNs). The data they
//! use comes from spreadsheets linked in the page with
//! `<meta name="openblocks-data" content="Ventas.xlsx">`; the app reads them and hands them to the
//! page as `window.openblocks`.

use std::path::Path;

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::sheet;
use crate::vault::Vault;

pub const DATA_META: &str = "openblocks-data";

/// Where an artifact's scripts and styles may come from. No `connect-src`: a page can't send what
/// it shows anywhere.
pub fn csp(host: &str) -> String {
    let cdns =
        "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh";
    format!(
        "sandbox allow-scripts allow-modals allow-downloads; default-src 'none'; \
         script-src 'unsafe-inline' 'unsafe-eval' blob: {cdns}; \
         style-src 'unsafe-inline' {cdns} https://fonts.googleapis.com; \
         font-src data: {cdns} https://fonts.gstatic.com; \
         img-src data: blob: http://{host}; media-src data: blob: http://{host}; \
         worker-src blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
    )
}

/// The spreadsheets an artifact names in its `openblocks-data` meta tags (in order, no repeats).
pub fn data_sources(html: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let lower = html.to_ascii_lowercase();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<meta") {
        let start = at + i;
        let end = lower[start..]
            .find('>')
            .map(|e| start + e)
            .unwrap_or(lower.len());
        let tag = &html[start..end];
        at = end;
        if attr(tag, "name").is_some_and(|n| n.eq_ignore_ascii_case(DATA_META)) {
            for p in attr(tag, "content").unwrap_or_default().split(',') {
                let p = decode_entities(p.trim());
                if !p.is_empty() && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let s = from + i;
        from = s + name.len();
        let before = lower[..s].chars().last();
        if !before.is_some_and(|c| c.is_whitespace()) {
            continue;
        }
        let rest = tag[s + name.len()..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        let q = rest.chars().next()?;
        if q == '"' || q == '\'' {
            return rest[1..].find(q).map(|e| rest[1..1 + e].to_string());
        }
        return Some(
            rest.split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next()
                .unwrap_or("")
                .to_string(),
        );
    }
    None
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// Sets the artifact's data sources (replacing its `openblocks-data` meta tags).
pub fn set_data_sources(html: &str, sources: &[String]) -> String {
    let mut out = String::with_capacity(html.len() + 80);
    let lower = html.to_ascii_lowercase();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<meta") {
        let start = at + i;
        let end = lower[start..]
            .find('>')
            .map(|e| start + e + 1)
            .unwrap_or(lower.len());
        let tag = &html[start..end];
        out.push_str(&html[at..start]);
        let is_data = attr(tag, "name").is_some_and(|n| n.eq_ignore_ascii_case(DATA_META));
        if is_data {
            // Drop the line break that followed the tag, so removing it leaves no empty line.
            let next = &html[end..];
            let skip = if next.starts_with("\r\n") {
                2
            } else if next.starts_with('\n') {
                1
            } else {
                0
            };
            at = end + skip;
            // Trailing indentation of the removed line.
            while out.ends_with(' ') || out.ends_with('\t') {
                out.pop();
            }
        } else {
            out.push_str(tag);
            at = end;
        }
    }
    out.push_str(&html[at..]);
    if sources.is_empty() {
        return out;
    }
    let meta = format!(
        "<meta name=\"{DATA_META}\" content=\"{}\">",
        crate::util::escape_html(&sources.join(", "))
    );
    let lower = out.to_ascii_lowercase();
    // Right after <meta charset> (which should stay first), or at the top of <head>.
    let after = lower
        .find("<meta charset")
        .and_then(|m| lower[m..].find('>').map(|e| m + e + 1))
        .or_else(|| {
            lower
                .find("<head")
                .and_then(|h| lower[h..].find('>').map(|e| h + e + 1))
        });
    if let Some(pos) = after {
        return format!("{}\n  {meta}{}", &out[..pos], &out[pos..]);
    }
    format!("{meta}\n{out}")
}

/// Finds a data file named in an artifact: next to it first, then anywhere in the vault.
pub fn resolve_source(v: &Vault, artifact: &str, src: &str) -> Option<String> {
    let dir = artifact.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let near = if dir.is_empty() {
        src.to_string()
    } else {
        format!("{dir}/{src}")
    };
    if v.abs(&near).ok().is_some_and(|p| p.is_file()) {
        return Some(near);
    }
    if v.abs(src).ok().is_some_and(|p| p.is_file()) {
        return Some(src.trim_start_matches('/').to_string());
    }
    v.resolve(src)
}

/// The data handed to the page: `{"Ventas.xlsx": {path, sheets: [{name, rows}]}}`, or an error per file.
pub fn data(v: &Vault, artifact: &str, html: &str) -> Value {
    let mut out = Map::new();
    for src in data_sources(html) {
        let entry = match resolve_source(v, artifact, &src) {
            Some(rel) => match v.abs(&rel).and_then(|p| read_table(&p)) {
                Ok(mut t) => {
                    t["path"] = json!(rel);
                    t
                }
                Err(e) => json!({"path": rel, "error": e.to_string(), "sheets": []}),
            },
            None => json!({"error": "no está en el vault", "sheets": []}),
        };
        out.insert(src, entry);
    }
    Value::Object(out)
}

fn read_table(p: &Path) -> Result<Value> {
    if !sheet::is_sheet(p) {
        anyhow::bail!("solo planillas (.xlsx, .xls, .ods, .csv, .tsv)");
    }
    sheet::tables(p)
}

/// The script that defines `window.openblocks` before the page's own scripts run.
fn runtime(data: &Value, theme: &str, path: &str) -> String {
    // `</` would end the script tag early.
    let json = data.to_string().replace("</", "<\\/");
    let theme = if theme == "dark" { "dark" } else { "light" };
    let path = json!(path).to_string().replace("</", "<\\/");
    format!(
        r#"<script>(function(){{
var D={json};
function file(f){{var k=Object.keys(D);if(!k.length)return null;if(f==null)return D[k[0]];if(D[f])return D[f];
var l=String(f).toLowerCase();for(var i=0;i<k.length;i++){{var n=k[i].toLowerCase();if(n===l||n.replace(/\.[^.]+$/,"")===l||n.split("/").pop()===l)return D[k[i]];}}return null;}}
function sheet(f,s){{var x=file(f);if(!x)return null;if(s==null)return x.sheets[0]||null;if(typeof s==="number")return x.sheets[s]||null;
for(var i=0;i<x.sheets.length;i++)if(x.sheets[i].name===s)return x.sheets[i];return null;}}
function rows(f,s){{var x=sheet(f,s);return x?x.rows.map(function(r){{return r.slice();}}):[];}}
function table(f,s){{var r=rows(f,s);while(r.length&&!r[0].some(function(c){{return c!=null&&c!=="";}}))r.shift();if(!r.length)return[];
var h=r[0].map(function(c,i){{return c==null||c===""?"col"+(i+1):String(c);}});
return r.slice(1).filter(function(row){{return row.some(function(c){{return c!=null&&c!=="";}});}}).map(function(row){{var o={{}};h.forEach(function(k,i){{o[k]=row[i]==null?null:row[i];}});return o;}});}}
window.openblocks={{data:D,files:Object.keys(D),theme:"{theme}",path:{path},file:file,sheets:function(f){{var x=file(f);return x?x.sheets:[];}},sheet:sheet,rows:rows,table:table}};
document.documentElement.dataset.theme="{theme}";
}})();</script>"#
    )
}

/// The page as the app serves it: the runtime goes first in `<head>` (or at the very top).
pub fn render(v: &Vault, rel: &str, html: &str, theme: &str) -> String {
    let data = data(v, rel, html);
    let rt = runtime(&data, theme, rel);
    let lower = html.to_ascii_lowercase();
    if let Some(h) = lower.find("<head") {
        if let Some(e) = lower[h..].find('>') {
            let pos = h + e + 1;
            return format!("{}{rt}{}", &html[..pos], &html[pos..]);
        }
    }
    if let Some(h) = lower.find("<html") {
        if let Some(e) = lower[h..].find('>') {
            let pos = h + e + 1;
            return format!("{}<head>{rt}</head>{}", &html[..pos], &html[pos..]);
        }
    }
    format!("<!doctype html><meta charset=\"utf-8\">{rt}{html}")
}

/// A starting artifact for "New → HTML".
pub fn template(title: &str, sources: &[String]) -> String {
    let t = crate::util::escape_html(title);
    let base = format!(
        r#"<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{t}</title>
  <style>
    :root {{ color-scheme: light dark; --ink: #1d1c1a; --paper: #fbfaf7; --line: #e6e2da; }}
    [data-theme="dark"] {{ --ink: #ece8e0; --paper: #191816; --line: #2f2d29; }}
    body {{ margin: 0; padding: 32px; font: 15px/1.55 system-ui, sans-serif; color: var(--ink); background: var(--paper); }}
    h1 {{ font-size: 26px; margin: 0 0 16px; }}
    table {{ border-collapse: collapse; }}
    td, th {{ border: 1px solid var(--line); padding: 6px 10px; text-align: left; }}
  </style>
</head>
<body>
  <h1>{t}</h1>
  <div id="app"></div>
  <script>
    // Linked spreadsheets: openblocks.table() gives the first sheet as a list of rows
    // ({{"Header": value}}); openblocks.files lists them.
    const rows = openblocks.table();
    const app = document.getElementById("app");
    if (!rows.length) {{
      app.textContent = "Vinculá una planilla con el botón Datos para ver sus filas acá.";
    }} else {{
      const cols = Object.keys(rows[0]);
      app.innerHTML = "<table><tr>" + cols.map((c) => "<th>" + c + "</th>").join("") + "</tr>" +
        rows.map((r) => "<tr>" + cols.map((c) => "<td>" + (r[c] ?? "") + "</td>").join("") + "</tr>").join("") + "</table>";
    }}
  </script>
</body>
</html>
"#
    );
    set_data_sources(&base, sources)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_sets_data_sources() {
        let html = "<html><head>\n  <meta charset=\"utf-8\">\n  <meta name=\"openblocks-data\" content=\"Ventas.xlsx, datos/b.csv\">\n</head><body></body></html>";
        assert_eq!(data_sources(html), vec!["Ventas.xlsx", "datos/b.csv"]);
        let changed = set_data_sources(html, &["c.xlsx".into()]);
        assert_eq!(data_sources(&changed), vec!["c.xlsx"]);
        assert!(!changed.contains("Ventas"));
        let none = set_data_sources(html, &[]);
        assert!(data_sources(&none).is_empty());
        assert!(none.contains("<meta charset"));
    }

    #[test]
    fn runtime_goes_first() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path(), None, false).unwrap();
        std::fs::write(dir.path().join("t.csv"), "Mes,Total\nEnero,10\n").unwrap();
        v.reindex();
        let html = "<!doctype html><html><head><meta name=\"openblocks-data\" content=\"t.csv\"><script>x()</script></head></html>";
        let out = render(&v, "a.html", html, "dark");
        let rt = out.find("window.openblocks").unwrap();
        assert!(rt < out.find("x()").unwrap());
        assert!(out.contains("\"Enero\""));
        assert!(out.contains("theme:\"dark\""));
    }
}
