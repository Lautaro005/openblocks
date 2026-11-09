// The spreadsheet editor (xlsx, csv, tsv): click a cell and type, Enter / Tab / arrows to move,
// = for a formula, Delete to clear, ⌘C / ⌘V with other spreadsheets, ⌘Z to undo. Changes are saved
// on their own a moment after you stop typing. xls and ods open read-only (save a copy as xlsx).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash, ArrowCounterClockwise, CheckCircle, CircleNotch, FloppyDisk } from "@phosphor-icons/react";
import { api, baseName, dirOf, type Cell, type Sheet } from "../lib/api";
import { colName, computeSheet } from "../lib/formula";
import { useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { openMenuAt } from "./Menu";

const ROW_H = 28;
const COL_W = 120;
const HEAD_W = 46;

type Pos = { r: number; c: number };
type Edit = { r: number; c: number; text: string; fresh: boolean };

/** What a typed text becomes: a number, a boolean, a formula or text. */
function parseInput(s: string): { value: Cell; formula?: string } {
  const t = s.trim();
  if (t.startsWith("=") && t.length > 1) return { value: null, formula: t };
  if (t === "") return { value: null };
  if (/^-?(\d+([.,]\d+)?|[.,]\d+)$/.test(t)) return { value: Number(t.replace(",", ".")) };
  if (/^(true|false|verdadero|falso)$/i.test(t)) return { value: /^(true|verdadero)$/i.test(t) };
  return { value: s };
}

function show(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e8) / 1e8);
  return v;
}

function cloneSheet(s: Sheet): Sheet {
  return { name: s.name, rows: s.rows.map((r) => r.slice()), formulas: { ...s.formulas } };
}

export function SheetEditor({ path }: { path: string }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [writable, setWritable] = useState(true);
  const [err, setErr] = useState("");
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState<Pos>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const undo = useRef<Sheet[][]>([]);
  const redo = useRef<Sheet[][]>([]);
  const saveT = useRef(0);
  const latest = useRef<Sheet[] | null>(null);
  latest.current = sheets;
  const ownSave = useRef(0);

  const load = useCallback(() => {
    api
      .sheet(path)
      .then((b) => {
        setSheets(b.sheets.length ? b.sheets : [{ name: "Hoja1", rows: [], formulas: {} }]);
        setWritable(b.writable);
        setErr("");
      })
      .catch((e) => setErr(e.message));
  }, [path]);
  useEffect(() => {
    setSheets(null);
    setActive(0);
    setSel({ r: 0, c: 0 });
    undo.current = [];
    redo.current = [];
    load();
  }, [load]);

  // Changed elsewhere (an agent, another app): reload, unless it was this editor saving.
  const external = useStore((s) => s.external);
  useEffect(() => {
    if (!external.n || !external.paths.includes(path)) return;
    if (Date.now() - ownSave.current < 2500) return;
    load();
  }, [external, path, load]);

  const sheet = sheets?.[active] ?? null;
  const computed = useMemo(() => (sheet ? computeSheet(sheet.rows, sheet.formulas) : new Map<string, Cell>()), [sheet]);
  const valueAt = (r: number, c: number): Cell => {
    const k = `${r},${c}`;
    if (sheet?.formulas[k]) return computed.get(k) ?? null;
    return sheet?.rows[r]?.[c] ?? null;
  };

  const nRows = Math.max(60, (sheet?.rows.length ?? 0) + 20);
  const nCols = Math.max(12, ...(sheet?.rows.map((r) => r.length) ?? [0]), ...Object.keys(sheet?.formulas ?? {}).map((k) => Number(k.split(",")[1]) + 1)) + 2;

  // ---------- saving ----------
  const save = useCallback(async () => {
    const s = latest.current;
    if (!s || !writable) return;
    window.clearTimeout(saveT.current);
    setSaving("saving");
    // Formula cells carry their computed result, so other apps show it before recomputing.
    const out = s.map((sh) => {
      const res = computeSheet(sh.rows, sh.formulas);
      const rows = sh.rows.map((r) => r.slice());
      for (const [k, v] of res) {
        const [r, c] = k.split(",").map(Number);
        while (rows.length <= r) rows.push([]);
        while (rows[r].length <= c) rows[r].push(null);
        rows[r][c] = typeof v === "string" && v.startsWith("#") ? null : v;
      }
      return { ...sh, rows };
    });
    try {
      ownSave.current = Date.now();
      await api.saveSheet(path, out);
      ownSave.current = Date.now();
      setSaving("saved");
      // Artifacts that use this spreadsheet reload.
      useStore.setState((st) => ({ external: { n: st.external.n + 1, paths: [path] } }));
    } catch (e: any) {
      setSaving("error");
      useStore.getState().toast(e.message, "error");
    }
  }, [path, writable]);

  useEffect(() => () => {
    // Leaving with changes not saved yet: save them now.
    if (saveT.current) {
      window.clearTimeout(saveT.current);
      if (latest.current) save();
    }
  }, [save]);

  const change = (fn: (s: Sheet) => void) => {
    if (!sheets || !writable) return;
    undo.current.push(sheets.map(cloneSheet));
    if (undo.current.length > 100) undo.current.shift();
    redo.current = [];
    const next = sheets.map(cloneSheet);
    fn(next[active]);
    // Trailing empty cells and rows go away.
    const rows = next[active].rows;
    for (const r of rows) while (r.length && (r[r.length - 1] === null || r[r.length - 1] === "")) r.pop();
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    setSheets(next);
    setSaving("dirty");
    window.clearTimeout(saveT.current);
    saveT.current = window.setTimeout(() => {
      saveT.current = 0;
      save();
    }, 700);
  };

  const setCell = (s: Sheet, r: number, c: number, text: string) => {
    const { value, formula } = parseInput(text);
    const k = `${r},${c}`;
    while (s.rows.length <= r) s.rows.push([]);
    while (s.rows[r].length <= c) s.rows[r].push(null);
    s.rows[r][c] = value;
    if (formula) s.formulas[k] = formula;
    else delete s.formulas[k];
  };

  const history = (from: React.MutableRefObject<Sheet[][]>, to: React.MutableRefObject<Sheet[][]>) => {
    const prev = from.current.pop();
    if (!prev || !sheets) return;
    to.current.push(sheets.map(cloneSheet));
    setSheets(prev);
    setSaving("dirty");
    window.clearTimeout(saveT.current);
    saveT.current = window.setTimeout(() => {
      saveT.current = 0;
      save();
    }, 400);
  };

  // ---------- selection ----------
  const range = () => {
    const a = anchor ?? sel;
    return { r1: Math.min(a.r, sel.r), r2: Math.max(a.r, sel.r), c1: Math.min(a.c, sel.c), c2: Math.max(a.c, sel.c) };
  };
  const inRange = (r: number, c: number) => {
    const g = range();
    return r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
  };

  const moveTo = (r: number, c: number, extend = false) => {
    const p = { r: Math.max(0, Math.min(nRows + 200, r)), c: Math.max(0, Math.min(nCols + 50, c)) };
    if (extend) {
      if (!anchor) setAnchor(sel);
    } else setAnchor(null);
    setSel(p);
    // Keep the cell in view.
    const el = box.current;
    if (el) {
      const top = p.r * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H * 2 - el.clientHeight;
      const left = HEAD_W + p.c * COL_W;
      if (left - HEAD_W < el.scrollLeft) el.scrollLeft = left - HEAD_W;
      else if (left + COL_W > el.scrollLeft + el.clientWidth) el.scrollLeft = left + COL_W - el.clientWidth;
    }
  };

  const startEdit = (fresh: boolean, text?: string) => {
    if (!writable || !sheet) return;
    const k = `${sel.r},${sel.c}`;
    const cur = sheet.formulas[k] ?? show(sheet.rows[sel.r]?.[sel.c] ?? null);
    setEdit({ r: sel.r, c: sel.c, text: text ?? (fresh ? "" : cur), fresh });
  };

  // The edit being typed, read by commit: blur can fire after Enter or Tab already committed it.
  const editRef = useRef<Edit | null>(null);
  editRef.current = edit;

  const commit = (dr: number, dc: number) => {
    const e = editRef.current;
    if (!e) return;
    editRef.current = null;
    setEdit(null);
    const k = `${e.r},${e.c}`;
    const before = sheet?.formulas[k] ?? show(sheet?.rows[e.r]?.[e.c] ?? null);
    if (e.text !== before) change((s) => setCell(s, e.r, e.c, e.text));
    moveTo(e.r + dr, e.c + dc);
    box.current?.focus();
  };

  useLayoutEffect(() => {
    if (edit) {
      input.current?.focus();
      const l = input.current?.value.length ?? 0;
      input.current?.setSelectionRange(l, l);
    }
  }, [edit?.r, edit?.c]);

  const clearRange = () => {
    const g = range();
    change((s) => {
      for (let r = g.r1; r <= g.r2; r++)
        for (let c = g.c1; c <= g.c2; c++) {
          if (s.rows[r] && c < s.rows[r].length) s.rows[r][c] = null;
          delete s.formulas[`${r},${c}`];
        }
    });
  };

  const copy = (e: ClipboardEvent) => {
    if (edit || !sheet) return;
    const g = range();
    const lines: string[] = [];
    for (let r = g.r1; r <= g.r2; r++) {
      const cells: string[] = [];
      for (let c = g.c1; c <= g.c2; c++) cells.push(show(valueAt(r, c)).replace(/[\t\n]/g, " "));
      lines.push(cells.join("\t"));
    }
    e.clipboardData?.setData("text/plain", lines.join("\n"));
    e.preventDefault();
  };

  const paste = (e: ClipboardEvent) => {
    if (edit || !writable) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    const grid = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    change((s) => grid.forEach((row, i) => row.forEach((v, j) => setCell(s, sel.r + i, sel.c + j, v))));
    setAnchor({ r: sel.r + grid.length - 1, c: sel.c + Math.max(...grid.map((r) => r.length)) - 1 });
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = (e: ClipboardEvent) => copy(e);
    const x = (e: ClipboardEvent) => {
      copy(e);
      if (!edit) clearRange();
    };
    const p = (e: ClipboardEvent) => paste(e);
    el.addEventListener("copy", c);
    el.addEventListener("cut", x);
    el.addEventListener("paste", p);
    return () => {
      el.removeEventListener("copy", c);
      el.removeEventListener("cut", x);
      el.removeEventListener("paste", p);
    };
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (edit) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? history(redo, undo) : history(undo, redo);
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      history(redo, undo);
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setSel({ r: Math.max(0, (sheet?.rows.length ?? 1) - 1), c: Math.max(0, nCols - 3) });
      return;
    }
    if (mod) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      moveTo(sel.r + dr, sel.c + dc, e.shiftKey);
    } else if (e.key === "Tab") {
      e.preventDefault();
      moveTo(sel.r, sel.c + (e.shiftKey ? -1 : 1));
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      if (e.key === "Enter" && e.shiftKey) moveTo(sel.r - 1, sel.c);
      else startEdit(false);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      clearRange();
    } else if (e.key === "Escape") setAnchor(null);
    else if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      startEdit(true, e.key);
    }
  };

  // ---------- rows, columns and sheets ----------
  const insertRow = (at: number) =>
    change((s) => {
      s.rows.splice(at, 0, []);
      s.formulas = shiftFormulas(s.formulas, (r, c) => [r >= at ? r + 1 : r, c]);
    });
  const deleteRow = (at: number) =>
    change((s) => {
      s.rows.splice(at, 1);
      s.formulas = shiftFormulas(s.formulas, (r, c) => (r === at ? null : [r > at ? r - 1 : r, c]));
    });
  const insertCol = (at: number) =>
    change((s) => {
      for (const r of s.rows) if (r.length > at) r.splice(at, 0, null);
      s.formulas = shiftFormulas(s.formulas, (r, c) => [r, c >= at ? c + 1 : c]);
    });
  const deleteCol = (at: number) =>
    change((s) => {
      for (const r of s.rows) if (r.length > at) r.splice(at, 1);
      s.formulas = shiftFormulas(s.formulas, (r, c) => (c === at ? null : [r, c > at ? c - 1 : c]));
    });

  const rowMenu = (el: HTMLElement, r: number) =>
    openMenuAt(el, [
      { label: t("Insertar fila arriba"), icon: Plus, run: () => insertRow(r) },
      { label: t("Insertar fila abajo"), icon: Plus, run: () => insertRow(r + 1) },
      { sep: true },
      { label: t("Borrar fila"), icon: Trash, danger: true, run: () => deleteRow(r) },
    ]);
  const colMenu = (el: HTMLElement, c: number) =>
    openMenuAt(el, [
      { label: t("Insertar columna a la izquierda"), icon: Plus, run: () => insertCol(c) },
      { label: t("Insertar columna a la derecha"), icon: Plus, run: () => insertCol(c + 1) },
      { sep: true },
      { label: t("Borrar columna"), icon: Trash, danger: true, run: () => deleteCol(c) },
    ]);

  const changeBook = (fn: (s: Sheet[]) => Sheet[], nextActive?: number) => {
    if (!sheets || !writable) return;
    undo.current.push(sheets.map(cloneSheet));
    setSheets(fn(sheets.map(cloneSheet)));
    if (nextActive != null) setActive(nextActive);
    setSaving("dirty");
    window.clearTimeout(saveT.current);
    saveT.current = window.setTimeout(() => {
      saveT.current = 0;
      save();
    }, 300);
  };
  const addSheet = () => {
    if (!sheets) return;
    let n = sheets.length + 1;
    while (sheets.some((s) => s.name === `Hoja${n}`)) n++;
    changeBook((s) => [...s, { name: `Hoja${n}`, rows: [], formulas: {} }], sheets.length);
  };
  const sheetMenu = (el: HTMLElement, i: number) =>
    openMenuAt(el, [
      {
        label: t("Renombrar"),
        run: () => {
          const name = prompt(t("Nombre de la hoja"), sheets![i].name)?.trim();
          if (name) changeBook((s) => s.map((x, k) => (k === i ? { ...x, name } : x)));
        },
      },
      ...(sheets!.length > 1
        ? [{ label: t("Borrar hoja"), icon: Trash, danger: true, run: () => changeBook((s) => s.filter((_, k) => k !== i), Math.max(0, Math.min(active, sheets!.length - 2))) }]
        : []),
    ]);

  const saveAsXlsx = async () => {
    if (!sheets) return;
    const stem = baseName(path).replace(/\.[^.]+$/, "");
    const dir = dirOf(path);
    const target = `${dir ? dir + "/" : ""}${stem}.xlsx`;
    try {
      await api.saveSheet(target, sheets);
      await useStore.getState().refreshTree();
      useStore.getState().openPath(target);
    } catch (e: any) {
      useStore.getState().toast(e.message, "error");
    }
  };

  if (err) return <div className="pv-empty">{err}</div>;
  if (!sheets || !sheet) return <div className="pv-loading" />;

  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 5);
  const last = Math.min(nRows, Math.ceil((scroll.top + scroll.height) / ROW_H) + 5);
  const g = range();
  const selKey = `${sel.r},${sel.c}`;
  const formulaText = sheet.formulas[selKey] ?? show(sheet.rows[sel.r]?.[sel.c] ?? null);

  return (
    <div className="sheet-ed">
      <div className="sheet-bar">
        <span className="sheet-ref">{colName(sel.c)}{sel.r + 1}</span>
        <input
          className="sheet-fx"
          value={edit ? edit.text : formulaText}
          readOnly={!writable}
          placeholder={writable ? t("Valor o =fórmula") : ""}
          onFocus={() => !edit && writable && setEdit({ r: sel.r, c: sel.c, text: formulaText, fresh: false })}
          onChange={(e) => setEdit((x) => (x ? { ...x, text: e.target.value } : { r: sel.r, c: sel.c, text: e.target.value, fresh: false }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.preventDefault(), commit(1, 0));
            if (e.key === "Escape") (setEdit(null), box.current?.focus());
          }}
        />
        {/\.(csv|tsv)$/i.test(path) && Object.keys(sheet.formulas).length > 0 && (
          <span className="muted xs" title={t("CSV guarda solo valores: las fórmulas quedan como su resultado. Usá .xlsx para conservarlas.")}>
            {t("CSV: fórmulas como valores")}
          </span>
        )}
        <div className="sheet-state">
          {!writable ? (
            <button className="btn sm" onClick={saveAsXlsx}>
              <FloppyDisk size={14} /> {t("Guardar una copia .xlsx para editar")}
            </button>
          ) : saving === "saving" ? (
            <span className="muted xs">
              <CircleNotch size={13} className="spin-i" /> {t("Guardando…")}
            </span>
          ) : saving === "dirty" ? (
            <span className="muted xs">{t("Cambios sin guardar")}</span>
          ) : saving === "error" ? (
            <button className="btn sm" onClick={save}>
              {t("Reintentar")}
            </button>
          ) : (
            <span className="muted xs">
              <CheckCircle size={13} /> {t("Guardado")}
            </span>
          )}
          <button className="btn-icon sm" title={t("Deshacer")} disabled={!undo.current.length} onClick={() => history(undo, redo)}>
            <ArrowCounterClockwise size={14} />
          </button>
        </div>
      </div>
      <div
        className="sheet-grid"
        ref={box}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        style={{ ["--row-h" as any]: `${ROW_H}px`, ["--col-w" as any]: `${COL_W}px`, ["--head-w" as any]: `${HEAD_W}px` }}
      >
        <div className="sheet-canvas" style={{ width: HEAD_W + nCols * COL_W, height: ROW_H * (nRows + 1) }}>
          <div className="sheet-colheads" style={{ width: HEAD_W + nCols * COL_W }}>
            <div className="sheet-corner" />
            {Array.from({ length: nCols }, (_, c) => (
              <div
                key={c}
                className={`sheet-colhead ${c >= g.c1 && c <= g.c2 ? "on" : ""}`}
                style={{ left: HEAD_W + c * COL_W }}
                onClick={() => {
                  setAnchor({ r: 0, c });
                  setSel({ r: Math.max(0, sheet.rows.length - 1), c });
                }}
                onContextMenu={(e) => (e.preventDefault(), writable && colMenu(e.currentTarget, c))}
              >
                {colName(c)}
              </div>
            ))}
          </div>
          {Array.from({ length: last - first }, (_, i) => {
            const r = first + i;
            return (
              <div key={r} className="sheet-row" style={{ top: ROW_H * (r + 1) }}>
                <div
                  className={`sheet-rowhead ${r >= g.r1 && r <= g.r2 ? "on" : ""}`}
                  onClick={() => {
                    setAnchor({ r, c: 0 });
                    setSel({ r, c: nCols - 3 });
                  }}
                  onContextMenu={(e) => (e.preventDefault(), writable && rowMenu(e.currentTarget, r))}
                >
                  {r + 1}
                </div>
                {Array.from({ length: nCols }, (_, c) => {
                  const v = valueAt(r, c);
                  const isSel = sel.r === r && sel.c === c;
                  const editing = edit && edit.r === r && edit.c === c;
                  const err = typeof v === "string" && /^#[A-Z/0!?]+$/.test(v);
                  return (
                    <div
                      key={c}
                      className={`sheet-cell ${typeof v === "number" ? "num" : ""} ${inRange(r, c) ? "in" : ""} ${isSel ? "sel" : ""} ${err ? "err" : ""} ${sheet.formulas[`${r},${c}`] ? "fx" : ""}`}
                      style={{ left: HEAD_W + c * COL_W }}
                      onMouseDown={(e) => {
                        if (editing) return;
                        if (edit) commit(0, 0);
                        e.preventDefault();
                        box.current?.focus();
                        if (e.shiftKey) {
                          if (!anchor) setAnchor(sel);
                          setSel({ r, c });
                        } else {
                          setAnchor(null);
                          setSel({ r, c });
                          // Drag to select a range.
                          const startR = r,
                            startC = c;
                          const move = (ev: MouseEvent) => {
                            const el = (ev.target as HTMLElement).closest?.(".sheet-cell") as HTMLElement | null;
                            if (!el?.dataset.r) return;
                            setAnchor({ r: startR, c: startC });
                            setSel({ r: Number(el.dataset.r), c: Number(el.dataset.c) });
                          };
                          const up = () => {
                            window.removeEventListener("mousemove", move);
                            window.removeEventListener("mouseup", up);
                          };
                          window.addEventListener("mousemove", move);
                          window.addEventListener("mouseup", up);
                        }
                      }}
                      onDoubleClick={() => startEdit(false)}
                      data-r={r}
                      data-c={c}
                    >
                      {editing ? (
                        <input
                          ref={input}
                          className="sheet-input"
                          value={edit!.text}
                          onChange={(e) => setEdit({ ...edit!, text: e.target.value })}
                          onBlur={() => commit(0, 0)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.preventDefault(), commit(e.shiftKey ? -1 : 1, 0));
                            else if (e.key === "Tab") (e.preventDefault(), commit(0, e.shiftKey ? -1 : 1));
                            else if (e.key === "Escape") (e.preventDefault(), setEdit(null), box.current?.focus());
                            else if (edit!.fresh && (e.key === "ArrowUp" || e.key === "ArrowDown")) (e.preventDefault(), commit(e.key === "ArrowUp" ? -1 : 1, 0));
                          }}
                        />
                      ) : (
                        show(v)
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="pv-tabs sheet-tabs">
        {sheets.map((x, i) => (
          <button
            key={i}
            className={i === active ? "on" : ""}
            onClick={() => (setActive(i), setSel({ r: 0, c: 0 }), setAnchor(null), setEdit(null))}
            onDoubleClick={(e) => writable && sheetMenu(e.currentTarget, i)}
            onContextMenu={(e) => (e.preventDefault(), writable && sheetMenu(e.currentTarget, i))}
          >
            {x.name}
          </button>
        ))}
        {writable && (
          <button className="sheet-add" title={t("Agregar hoja")} onClick={addSheet}>
            <Plus size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Moves (or drops, with null) formula cells after a row or column is inserted or deleted. */
function shiftFormulas(f: Record<string, string>, map: (r: number, c: number) => [number, number] | null) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    const [r, c] = k.split(",").map(Number);
    const to = map(r, c);
    if (to) out[`${to[0]},${to[1]}`] = v;
  }
  return out;
}
