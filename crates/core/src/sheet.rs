//! Spreadsheets the app can edit: xlsx (and xls/ods to read), csv and tsv. Cells come with their
//! types (numbers stay numbers) and formulas, so the editor can show values and keep formulas, and
//! HTML artifacts get real data. Saving writes values and formulas; cell formatting is not kept.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

pub const MAX_ROWS: usize = 20_000;
pub const MAX_COLS: usize = 300;

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn is_sheet(path: &Path) -> bool {
    matches!(
        ext_of(path).as_str(),
        "xlsx" | "xlsm" | "xls" | "ods" | "csv" | "tsv"
    )
}

pub fn can_write(path: &Path) -> bool {
    matches!(ext_of(path).as_str(), "xlsx" | "csv" | "tsv")
}

/// `{sheets: [{name, rows: [[value…]…], formulas: {"r,c": "=SUM(A1:A3)"}}]}`; rows start at A1.
pub fn read(path: &Path) -> Result<Value> {
    match ext_of(path).as_str() {
        "csv" | "tsv" => {
            let bytes = std::fs::read(path)?;
            let text = String::from_utf8_lossy(&bytes);
            let sep = csv_sep(&text, ext_of(path) == "tsv");
            let rows: Vec<Vec<Value>> = crate::preview::parse_csv(&text, sep)
                .into_iter()
                .take(MAX_ROWS)
                .map(|r| r.into_iter().take(MAX_COLS).map(typed).collect())
                .collect();
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(json!({"sheets": [{"name": name, "rows": rows, "formulas": {}}]}))
        }
        "xlsx" | "xlsm" | "xls" | "ods" => read_book(path),
        _ => bail!("no es una planilla"),
    }
}

fn csv_sep(text: &str, tsv: bool) -> char {
    if tsv {
        return '\t';
    }
    let first = text.lines().next().unwrap_or("");
    if first.matches(';').count() > first.matches(',').count() {
        ';'
    } else {
        ','
    }
}

/// A csv cell: numbers as numbers (also with a decimal comma), the rest as text.
fn typed(s: String) -> Value {
    let t = s.trim();
    if t.is_empty() {
        return Value::Null;
    }
    if let Ok(n) = t.parse::<f64>() {
        if n.is_finite()
            && !t.starts_with('+')
            && !(t.len() > 1 && t.starts_with('0') && !t.starts_with("0."))
        {
            return json!(n);
        }
    }
    Value::String(s)
}

fn read_book(path: &Path) -> Result<Value> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut wb = open_workbook_auto(path).context("no pude abrir la planilla")?;
    let names = wb.sheet_names().to_vec();
    let mut sheets = vec![];
    for n in names.iter().take(50) {
        let Ok(range) = wb.worksheet_range(n) else {
            continue;
        };
        let (r0, c0) = range
            .start()
            .map(|(r, c)| (r as usize, c as usize))
            .unwrap_or((0, 0));
        let mut rows: Vec<Vec<Value>> = vec![vec![]; r0.min(MAX_ROWS)];
        for row in range.rows().take(MAX_ROWS.saturating_sub(r0)) {
            let mut cells: Vec<Value> = vec![Value::Null; c0.min(MAX_COLS)];
            for c in row.iter().take(MAX_COLS.saturating_sub(c0)) {
                cells.push(match c {
                    Data::Empty => Value::Null,
                    Data::Float(f) => json!(f),
                    Data::Int(i) => json!(i),
                    Data::Bool(b) => json!(b),
                    Data::String(s) => json!(s),
                    Data::DateTime(d) => d
                        .as_datetime()
                        .map(|x| {
                            json!(x
                                .format("%Y-%m-%d %H:%M")
                                .to_string()
                                .trim_end_matches(" 00:00"))
                        })
                        .unwrap_or_else(|| json!(d.to_string())),
                    Data::DateTimeIso(s) | Data::DurationIso(s) => json!(s),
                    Data::Error(e) => json!(format!("#{e:?}").to_uppercase()),
                });
            }
            while cells.last().is_some_and(|c| c.is_null()) {
                cells.pop();
            }
            rows.push(cells);
        }
        while rows.last().is_some_and(|r| r.is_empty()) {
            rows.pop();
        }
        let mut formulas = serde_json::Map::new();
        if let Ok(f) = wb.worksheet_formula(n) {
            let (fr, fc) = f
                .start()
                .map(|(r, c)| (r as usize, c as usize))
                .unwrap_or((0, 0));
            for (i, row) in f.rows().enumerate() {
                for (j, s) in row.iter().enumerate() {
                    if !s.is_empty() && fr + i < MAX_ROWS && fc + j < MAX_COLS {
                        formulas.insert(format!("{},{}", fr + i, fc + j), json!(format!("={s}")));
                    }
                }
            }
        }
        sheets.push(json!({"name": n, "rows": rows, "formulas": formulas}));
    }
    Ok(json!({"sheets": sheets}))
}

#[derive(Deserialize)]
pub struct SheetIn {
    pub name: String,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    /// "r,c" → "=FORMULA"; a cell's formula wins over its value (the value is kept as its result).
    #[serde(default)]
    pub formulas: serde_json::Map<String, Value>,
}

/// The file's bytes for these sheets (xlsx, or the first sheet as csv/tsv).
pub fn encode(path: &Path, sheets: &[SheetIn]) -> Result<Vec<u8>> {
    match ext_of(path).as_str() {
        "csv" | "tsv" => {
            let sep = if ext_of(path) == "tsv" { '\t' } else { ',' };
            let mut out = String::new();
            if let Some(s) = sheets.first() {
                for r in &s.rows {
                    let line: Vec<String> =
                        r.iter().map(|v| csv_cell(&cell_text(v), sep)).collect();
                    out.push_str(&line.join(&sep.to_string()));
                    out.push('\n');
                }
            }
            Ok(out.into_bytes())
        }
        "xlsx" => xlsx(sheets),
        _ => bail!("solo se pueden guardar planillas .xlsx, .csv o .tsv"),
    }
}

fn cell_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn csv_cell(s: &str, sep: char) -> String {
    if s.contains(sep) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn xlsx(sheets: &[SheetIn]) -> Result<Vec<u8>> {
    use rust_xlsxwriter::{Formula, Workbook};
    let mut wb = Workbook::new();
    let mut used = std::collections::HashSet::new();
    for (i, s) in sheets.iter().enumerate().take(50) {
        let ws = wb.add_worksheet();
        // Excel's rules for sheet names: 31 characters, none of []:*?/\ and unique.
        let mut name: String = s
            .name
            .chars()
            .filter(|c| !"[]:*?/\\".contains(*c))
            .take(31)
            .collect();
        if name.trim().is_empty() || !used.insert(name.to_lowercase()) {
            name = format!("Hoja{}", i + 1);
            used.insert(name.to_lowercase());
        }
        ws.set_name(&name)?;
        for (r, row) in s.rows.iter().enumerate().take(MAX_ROWS) {
            for (c, v) in row.iter().enumerate().take(MAX_COLS) {
                let (rr, cc) = (r as u32, c as u16);
                if let Some(f) = s.formulas.get(&format!("{r},{c}")).and_then(|f| f.as_str()) {
                    let mut formula = Formula::new(f);
                    let result = cell_text(v);
                    if !result.is_empty() {
                        formula = formula.set_result(result);
                    }
                    ws.write_formula(rr, cc, formula)?;
                    continue;
                }
                match v {
                    Value::Null => {}
                    Value::Number(n) => {
                        ws.write_number(rr, cc, n.as_f64().unwrap_or(0.0))?;
                    }
                    Value::Bool(b) => {
                        ws.write_boolean(rr, cc, *b)?;
                    }
                    Value::String(t) if t.is_empty() => {}
                    other => {
                        ws.write_string(rr, cc, cell_text(other))?;
                    }
                }
            }
        }
        // Formulas in cells with no value in `rows`.
        for (k, f) in &s.formulas {
            let Some((r, c)) = k.split_once(',') else {
                continue;
            };
            let (Ok(r), Ok(c)) = (r.parse::<usize>(), c.parse::<usize>()) else {
                continue;
            };
            if r < MAX_ROWS && c < MAX_COLS && s.rows.get(r).and_then(|row| row.get(c)).is_none() {
                if let Some(f) = f.as_str() {
                    ws.write_formula(r as u32, c as u16, Formula::new(f))?;
                }
            }
        }
    }
    if sheets.is_empty() {
        wb.add_worksheet();
    }
    Ok(wb.save_to_buffer()?)
}

/// Sheets as tables for an artifact: `{name: {sheets: [{name, rows}]}}`.
pub fn tables(path: &Path) -> Result<Value> {
    let v = read(path)?;
    let sheets: Vec<Value> = v["sheets"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| json!({"name": s["name"], "rows": s["rows"]}))
        .collect();
    Ok(json!({ "sheets": sheets }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_round_trip_keeps_values_and_formulas() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.xlsx");
        let mut formulas = serde_json::Map::new();
        formulas.insert("3,1".into(), json!("=SUM(B2:B3)"));
        let sheets = vec![SheetIn {
            name: "Ventas".into(),
            rows: vec![
                vec![json!("Mes"), json!("Total")],
                vec![json!("Enero"), json!(10)],
                vec![json!("Febrero"), json!(12.5)],
                vec![json!("Suma"), json!(22.5)],
            ],
            formulas,
        }];
        std::fs::write(&p, encode(&p, &sheets).unwrap()).unwrap();
        let v = read(&p).unwrap();
        let s = &v["sheets"][0];
        assert_eq!(s["name"], "Ventas");
        assert_eq!(s["rows"][1][1], json!(10.0));
        assert_eq!(s["rows"][2][0], "Febrero");
        assert_eq!(s["formulas"]["3,1"], "=SUM(B2:B3)");
    }

    #[test]
    fn csv_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.csv");
        let sheets = vec![SheetIn {
            name: "t".into(),
            rows: vec![
                vec![json!("a, b"), json!(1)],
                vec![json!("c\"d"), Value::Null],
            ],
            formulas: Default::default(),
        }];
        std::fs::write(&p, encode(&p, &sheets).unwrap()).unwrap();
        let v = read(&p).unwrap();
        assert_eq!(v["sheets"][0]["rows"][0][0], "a, b");
        assert_eq!(v["sheets"][0]["rows"][0][1], json!(1.0));
        assert_eq!(v["sheets"][0]["rows"][1][0], "c\"d");
    }
}
