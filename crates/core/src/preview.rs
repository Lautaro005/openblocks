//! Real previews for office files and tables, read locally: docx as a document, xlsx/xls/ods as a
//! grid, pptx as slides, csv/tsv as a table. PDFs, images, audio and video are shown by the webview.

use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};
use quick_xml::events::Event as X;
use serde_json::{json, Value};

const MAX_ROWS: usize = 500;
const MAX_COLS: usize = 60;

pub fn preview(path: &Path) -> Result<Value> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "docx" => docx(path),
        "xlsx" | "xlsm" | "xls" | "ods" => sheet(path),
        "pptx" => pptx(path),
        "csv" | "tsv" => csv(path, if ext == "tsv" { '\t' } else { ',' }),
        _ => Ok(json!({"kind": "none"})),
    }
}

/// Plain text of a file for agents (notes, txt, csv, office files).
pub fn text_of(path: &Path) -> Result<String> {
    let v = preview(path)?;
    let mut out = String::new();
    match v["kind"].as_str() {
        Some("doc") => {
            for b in v["blocks"].as_array().into_iter().flatten() {
                if b["kind"] == "page" {
                    continue;
                }
                if let Some(rows) = b["rows"].as_array() {
                    for r in rows {
                        let cells: Vec<&str> = r
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|c| c.as_str())
                            .collect();
                        out.push_str(&format!("| {} |\n", cells.join(" | ")));
                    }
                } else {
                    out.push_str(b["text"].as_str().unwrap_or(""));
                    out.push('\n');
                }
            }
        }
        Some("sheets") | Some("table") => {
            let sheets = if v["kind"] == "table" {
                vec![v.clone()]
            } else {
                v["sheets"].as_array().cloned().unwrap_or_default()
            };
            for s in sheets {
                if let Some(n) = s["name"].as_str() {
                    out.push_str(&format!("## {n}\n"));
                }
                for r in s["rows"].as_array().into_iter().flatten() {
                    let cells: Vec<&str> = r
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|c| c.as_str())
                        .collect();
                    out.push_str(&cells.join("\t"));
                    out.push('\n');
                }
            }
        }
        Some("slides") => {
            for (i, s) in v["slides"].as_array().into_iter().flatten().enumerate() {
                out.push_str(&format!(
                    "## {} {}\n",
                    i + 1,
                    s["title"].as_str().unwrap_or("")
                ));
                for l in s["lines"].as_array().into_iter().flatten() {
                    out.push_str(l.as_str().unwrap_or(""));
                    out.push('\n');
                }
            }
        }
        _ => {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            out = match ext.as_str() {
                "pdf" => pdf_text(path)?,
                "html" | "htm" => {
                    crate::web::html_to_text(&std::fs::read_to_string(path).unwrap_or_default())
                }
                _ => std::fs::read_to_string(path).unwrap_or_default(),
            };
        }
    }
    Ok(out)
}

/// Text of a PDF. pdf-extract can panic on unusual files and release builds abort on panic, so the
/// app reads it in a child process of its own binary (`openblocks __pdf-text <file>`).
fn pdf_text(path: &Path) -> Result<String> {
    let exe = std::env::current_exe()?;
    let ours = exe
        .file_stem()
        .is_some_and(|s| s.to_string_lossy().to_lowercase().starts_with("openblocks"));
    if !ours {
        return pdf_text_here(path);
    }
    let out = crate::util::command(&exe)
        .arg("__pdf-text")
        .arg(path)
        .output()?;
    let t = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() || t.trim().is_empty() {
        anyhow::bail!("no pude leer el texto de este PDF (puede ser una imagen escaneada)");
    }
    Ok(t)
}

pub fn pdf_text_here(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let t = std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&bytes))
        .map_err(|_| anyhow::anyhow!("PDF ilegible"))??;
    let mut out = String::new();
    let mut blank = 0;
    for l in t.lines() {
        let l = l.trim_end();
        if l.trim().is_empty() {
            blank += 1;
            if blank == 1 {
                out.push('\n');
            }
        } else {
            blank = 0;
            out.push_str(l);
            out.push('\n');
        }
    }
    Ok(out)
}

fn zip_entry(path: &Path, name: &str) -> Result<String> {
    let f = std::fs::File::open(path)?;
    let mut z = zip::ZipArchive::new(f)?;
    let mut e = z
        .by_name(name)
        .with_context(|| format!("{name} no está en el archivo"))?;
    let mut s = String::new();
    e.read_to_string(&mut s)?;
    Ok(s)
}

fn local(name: &[u8]) -> &[u8] {
    match name.iter().position(|b| *b == b':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| local(a.key.as_ref()) == key)
        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
}

/// Paragraphs (with heading level, list and bold runs) and tables of a Word document.
fn docx(path: &Path) -> Result<Value> {
    let xml = zip_entry(path, "word/document.xml")?;
    let mut r = quick_xml::Reader::from_str(&xml);
    let mut blocks: Vec<Value> = vec![];
    let mut para = String::new();
    let mut runs: Vec<Value> = vec![];
    let mut run_bold = false;
    let mut run_italic = false;
    let mut style = String::new();
    let mut list = false;
    let mut in_text = false;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut cell: Option<String> = None;
    let mut depth_tbl = 0;
    // Page breaks: the ones in the text and where Word last laid out each page, so the preview
    // shows the same pages. `break_before`: the paragraph starts a page; `break_after`: the next does.
    let mut break_before = false;
    let mut break_after = false;
    let mut pending_page = false;
    loop {
        let ev = r.read_event();
        let empty = matches!(ev, Ok(X::Empty(_)));
        match ev {
            Ok(X::Start(e)) | Ok(X::Empty(e)) => match local(e.name().as_ref()) {
                b"p" => {
                    para.clear();
                    runs.clear();
                    style.clear();
                    list = false;
                    break_before = false;
                    break_after = false;
                }
                b"pageBreakBefore" if depth_tbl == 0 => {
                    break_before = attr(&e, b"val").is_none_or(|v| v != "0" && v != "false")
                }
                b"lastRenderedPageBreak" if depth_tbl == 0 => {
                    if para.trim().is_empty() {
                        break_before = true
                    } else {
                        break_after = true
                    }
                }
                b"pStyle" => style = attr(&e, b"val").unwrap_or_default(),
                b"numPr" => list = true,
                b"r" => {
                    run_bold = false;
                    run_italic = false;
                }
                b"b" => run_bold = attr(&e, b"val").is_none_or(|v| v != "0" && v != "false"),
                b"i" => run_italic = attr(&e, b"val").is_none_or(|v| v != "0" && v != "false"),
                b"t" => in_text = !empty,
                b"tab" => para.push('\t'),
                b"br" if attr(&e, b"type").as_deref() == Some("page") && depth_tbl == 0 => {
                    if para.trim().is_empty() {
                        break_before = true
                    } else {
                        break_after = true
                    }
                }
                b"br" => para.push('\n'),
                b"tbl" => {
                    depth_tbl += 1;
                    if depth_tbl == 1 {
                        table = Some(vec![]);
                    }
                }
                b"tr" if depth_tbl == 1 => {
                    if let Some(t) = table.as_mut() {
                        t.push(vec![]);
                    }
                }
                b"tc" if depth_tbl == 1 => cell = Some(String::new()),
                _ => {}
            },
            Ok(X::Text(t)) if in_text => {
                let s = t.unescape().map(|s| s.into_owned()).unwrap_or_default();
                para.push_str(&s);
                runs.push(json!({"text": s, "b": run_bold, "i": run_italic}));
            }
            Ok(X::End(e)) => match local(e.name().as_ref()) {
                b"t" => in_text = false,
                b"p" => {
                    if let Some(c) = cell.as_mut() {
                        if !c.is_empty() {
                            c.push('\n');
                        }
                        c.push_str(&para);
                    } else if depth_tbl == 0 {
                        let s = style.to_ascii_lowercase();
                        let kind = if s.starts_with("heading1") || s == "title" {
                            "h1"
                        } else if s.starts_with("heading2") || s == "subtitle" {
                            "h2"
                        } else if s.starts_with("heading") {
                            "h3"
                        } else if list || s.contains("list") {
                            "li"
                        } else {
                            "p"
                        };
                        if break_before {
                            pending_page = true;
                        }
                        if !para.trim().is_empty() || kind == "p" && !blocks.is_empty() {
                            if pending_page && !blocks.is_empty() {
                                blocks.push(json!({"kind": "page"}));
                            }
                            pending_page = false;
                            blocks.push(json!({"kind": kind, "text": para, "runs": runs}));
                        }
                        if break_after {
                            pending_page = true;
                        }
                    }
                    para.clear();
                    runs.clear();
                }
                b"tc" if depth_tbl == 1 => {
                    if let (Some(t), Some(c)) = (table.as_mut(), cell.take()) {
                        if let Some(row) = t.last_mut() {
                            row.push(c);
                        }
                    }
                }
                b"tbl" => {
                    depth_tbl -= 1;
                    if depth_tbl == 0 {
                        if let Some(t) = table.take() {
                            if pending_page && !blocks.is_empty() {
                                blocks.push(json!({"kind": "page"}));
                            }
                            pending_page = false;
                            blocks.push(json!({"kind": "table", "rows": t}));
                        }
                    }
                }
                _ => {}
            },
            Ok(X::Eof) => break,
            Err(e) => return Err(e.into()),
            _ => {}
        }
        if blocks.len() > 4000 {
            break;
        }
    }
    // Trailing empty paragraphs read as noise.
    while blocks.last().is_some_and(|b| {
        b["kind"] == "page"
            || b["kind"] == "p" && b["text"].as_str().is_some_and(|t| t.trim().is_empty())
    }) {
        blocks.pop();
    }
    Ok(json!({"kind": "doc", "blocks": blocks}))
}

fn sheet(path: &Path) -> Result<Value> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut wb = open_workbook_auto(path).context("no pude abrir la planilla")?;
    let names = wb.sheet_names().to_vec();
    let mut sheets = vec![];
    for n in names.iter().take(20) {
        let Ok(range) = wb.worksheet_range(n) else {
            continue;
        };
        let total = range.height();
        let mut rows = vec![];
        for row in range.rows().take(MAX_ROWS) {
            let cells: Vec<String> = row
                .iter()
                .take(MAX_COLS)
                .map(|c| match c {
                    Data::Empty => String::new(),
                    Data::Float(f) => {
                        if f.fract() == 0.0 && f.abs() < 1e15 {
                            format!("{}", *f as i64)
                        } else {
                            format!("{f}")
                        }
                    }
                    Data::DateTime(d) => d
                        .as_datetime()
                        .map(|x| {
                            x.format("%Y-%m-%d %H:%M")
                                .to_string()
                                .trim_end_matches(" 00:00")
                                .to_string()
                        })
                        .unwrap_or_else(|| d.to_string()),
                    other => other.to_string(),
                })
                .collect();
            rows.push(cells);
        }
        while rows
            .last()
            .is_some_and(|r: &Vec<String>| r.iter().all(|c| c.is_empty()))
        {
            rows.pop();
        }
        sheets.push(json!({"name": n, "rows": rows, "total": total}));
    }
    Ok(json!({"kind": "sheets", "sheets": sheets}))
}

fn pptx(path: &Path) -> Result<Value> {
    let f = std::fs::File::open(path)?;
    let mut z = zip::ZipArchive::new(f)?;
    let mut names: Vec<(u32, String)> = (0..z.len())
        .filter_map(|i| {
            let n = z.by_index(i).ok()?.name().to_string();
            let num = n
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse()
                .ok()?;
            Some((num, n))
        })
        .collect();
    names.sort();
    let mut slides = vec![];
    for (_, n) in names.iter().take(200) {
        let mut xml = String::new();
        z.by_name(n)?.read_to_string(&mut xml)?;
        let mut r = quick_xml::Reader::from_str(&xml);
        let mut lines: Vec<String> = vec![];
        let mut cur = String::new();
        let mut in_t = false;
        let mut title_idx: Option<usize> = None;
        let mut is_title_shape = false;
        loop {
            match r.read_event() {
                Ok(X::Start(e)) | Ok(X::Empty(e)) => match local(e.name().as_ref()) {
                    b"t" => in_t = true,
                    b"ph" => {
                        let t = attr(&e, b"type").unwrap_or_default();
                        is_title_shape = t == "title" || t == "ctrTitle";
                    }
                    b"sp" => is_title_shape = false,
                    _ => {}
                },
                Ok(X::Text(t)) if in_t => {
                    cur.push_str(&t.unescape().map(|s| s.into_owned()).unwrap_or_default())
                }
                Ok(X::End(e)) => match local(e.name().as_ref()) {
                    b"t" => in_t = false,
                    b"p" => {
                        if !cur.trim().is_empty() {
                            if is_title_shape && title_idx.is_none() {
                                title_idx = Some(lines.len());
                            }
                            lines.push(cur.trim().to_string());
                        }
                        cur.clear();
                    }
                    _ => {}
                },
                Ok(X::Eof) => break,
                Err(_) => break,
                _ => {}
            }
        }
        let ti = title_idx.unwrap_or(0);
        let title = if lines.is_empty() {
            String::new()
        } else {
            lines.remove(ti.min(lines.len() - 1))
        };
        slides.push(json!({"title": title, "lines": lines}));
    }
    Ok(json!({"kind": "slides", "slides": slides}))
}

pub fn parse_csv(text: &str, sep: char) -> Vec<Vec<String>> {
    let mut rows = vec![];
    let mut row = vec![];
    let mut cell = String::new();
    let mut q = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if q {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    q = false;
                }
            } else {
                cell.push(c);
            }
            continue;
        }
        match c {
            '"' => q = true,
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
                if rows.len() >= MAX_ROWS {
                    return rows;
                }
            }
            c if c == sep => row.push(std::mem::take(&mut cell)),
            c => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

fn csv(path: &Path, sep: char) -> Result<Value> {
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let sep = if sep == ','
        && text
            .lines()
            .next()
            .is_some_and(|l| l.matches(';').count() > l.matches(',').count())
    {
        ';'
    } else {
        sep
    };
    let rows = parse_csv(&text, sep);
    Ok(json!({"kind": "table", "rows": rows}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn csv_quotes() {
        let r = super::parse_csv("a,\"b,c\",\"d \"\"e\"\"\"\n1,2,3\n", ',');
        assert_eq!(r, vec![vec!["a", "b,c", "d \"e\""], vec!["1", "2", "3"]]);
    }

    #[test]
    fn docx_keeps_its_pages() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("d.docx");
        let body = r#"<w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Uno</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Texto </w:t></w:r><w:r><w:t/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r></w:p>
<w:p><w:r><w:lastRenderedPageBreak/><w:t>Dos</w:t></w:r></w:p>
<w:p><w:r><w:t>Antes</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>
<w:p><w:r><w:t>Tres</w:t></w:r></w:p>
</w:body></w:document>"#;
        let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        z.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        z.write_all(body.as_bytes()).unwrap();
        z.finish().unwrap();
        let v = super::preview(&p).unwrap();
        let kinds: Vec<&str> = v["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["h1", "p", "page", "p", "p", "page", "p"]);
        assert_eq!(v["blocks"][1]["text"], "Texto ");
    }
}
