import { useEffect, useMemo, useState } from "react";
import { Table, Kanban, Plus, MagnifyingGlass, SortAscending, SortDescending, FileText, Rows, X } from "@phosphor-icons/react";
import { api, baseName } from "../lib/api";
import { useStore } from "../lib/store";
import { t, timeAgo } from "../lib/i18n";

type Row = { path: string; title: string; mtime: number; props: Record<string, any> };
type View = { layout?: "table" | "board"; groupBy?: string; hidden?: string[]; sort?: { col: string; dir: 1 | -1 } };

const fmt = (v: any) => (Array.isArray(v) ? v.join(", ") : v === true ? "✓" : v === false ? "" : v == null ? "" : String(v));

export function DatabaseView({ folder }: { folder: string }) {
  const st = useStore();
  const [data, setData] = useState<{ columns: string[]; rows: Row[]; view: View | null } | null>(null);
  const [view, setView] = useState<View>({ layout: "table" });
  const [q, setQ] = useState("");
  const [newCol, setNewCol] = useState<string | null>(null);
  const load = async () => {
    const d = await api.database(folder);
    setData(d);
    if (d.view) setView({ layout: "table", ...d.view });
  };
  useEffect(() => {
    load();
  }, [folder, st.tree, st.external.n]);

  const saveView = (v: View) => {
    setView(v);
    api.databaseView(folder, v);
    if (!st.databases.includes(folder)) st.refreshTree();
  };

  const rows = useMemo(() => {
    if (!data) return [];
    let r = data.rows.filter((x) => !q || (x.title + " " + Object.values(x.props).map(fmt).join(" ")).toLowerCase().includes(q.toLowerCase()));
    if (view.sort) {
      const { col, dir } = view.sort;
      r = [...r].sort((a, b) => {
        const va = col === "title" ? a.title : col === "mtime" ? a.mtime : fmt(a.props[col]);
        const vb = col === "title" ? b.title : col === "mtime" ? b.mtime : fmt(b.props[col]);
        return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
      });
    }
    return r;
  }, [data, q, view.sort]);

  if (!data) return <div className="page-loading" />;
  const cols = data.columns.filter((c) => !(view.hidden ?? []).includes(c));
  const setCell = async (row: Row, col: string, raw: string) => {
    const old = row.props[col];
    let v: any = raw;
    if (Array.isArray(old) || /^(tags?|etiquetas)$/i.test(col)) v = raw.split(",").map((s) => s.trim()).filter(Boolean);
    else if (typeof old === "number" && raw !== "" && !isNaN(Number(raw))) v = Number(raw);
    else if (typeof old === "boolean") v = raw === "true";
    if (fmt(old) === fmt(v)) return;
    await api.setProp(row.path, col, v);
    load();
  };
  const addRow = async (preset?: Record<string, string>) => {
    const r = await api.createPage(folder, t("Sin título"));
    if (preset) for (const [k, v] of Object.entries(preset)) await api.setProp(r.path, k, v);
    await st.refreshTree();
    load();
  };
  const sortBy = (col: string) => {
    const dir: 1 | -1 = view.sort?.col === col && view.sort.dir === 1 ? -1 : 1;
    saveView({ ...view, sort: { col, dir } });
  };
  const SortI = view.sort?.dir === -1 ? SortDescending : SortAscending;

  const groupBy = view.groupBy || cols.find((c) => /^(status|estado|stage|etapa)$/i.test(c)) || cols[0] || "";
  return (
    <div className="db">
      <header className="db-head">
        <h1 className="db-title">{baseName(folder) || st.status?.vault?.name}</h1>
        <p className="muted">{t("{n} páginas · cada fila es una página de esta carpeta y cada columna una propiedad", { n: data.rows.length })}</p>
        <div className="db-bar">
          <div className="seg">
            <button className={view.layout !== "board" ? "on" : ""} onClick={() => saveView({ ...view, layout: "table" })}>
              <Table size={15} /> {t("Tabla")}
            </button>
            <button className={view.layout === "board" ? "on" : ""} onClick={() => saveView({ ...view, layout: "board" })}>
              <Kanban size={15} /> {t("Tablero")}
            </button>
          </div>
          {view.layout === "board" && (
            <label className="db-group">
              <Rows size={14} /> {t("Agrupar por")}
              <select value={groupBy} onChange={(e) => saveView({ ...view, groupBy: e.target.value })}>
                {cols.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <div className="db-search">
            <MagnifyingGlass size={14} />
            <input placeholder={t("Filtrar…")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="push" />
          <button className="btn primary sm" onClick={() => addRow()}>
            <Plus size={14} /> {t("Nueva")}
          </button>
        </div>
      </header>

      {view.layout === "board" && groupBy ? (
        <Board rows={rows} col={groupBy} onMove={(r, v) => setCell(r, groupBy, v)} onAdd={(v) => addRow({ [groupBy]: v })} />
      ) : (
        <div className="db-table-wrap">
          <table className="db-table">
            <thead>
              <tr>
                <th onClick={() => sortBy("title")} className="db-th-title">
                  <FileText size={13} /> {t("Nombre")} {view.sort?.col === "title" && <SortI size={12} />}
                </th>
                {cols.map((c) => (
                  <th key={c} onClick={() => sortBy(c)} onContextMenu={(e) => (e.preventDefault(), saveView({ ...view, hidden: [...(view.hidden ?? []), c] }))} title={t("Clic para ordenar · clic derecho para ocultar")}>
                    {c} {view.sort?.col === c && <SortI size={12} />}
                  </th>
                ))}
                <th onClick={() => sortBy("mtime")} className="db-th-date">
                  {t("Editada")} {view.sort?.col === "mtime" && <SortI size={12} />}
                </th>
                <th className="db-th-add">
                  {newCol == null ? (
                    <button className="btn-icon xs" onClick={() => setNewCol("")} title={t("Nueva propiedad")}>
                      <Plus size={13} />
                    </button>
                  ) : (
                    <input
                      autoFocus
                      className="db-newcol"
                      placeholder={t("propiedad")}
                      value={newCol}
                      onChange={(e) => setNewCol(e.target.value)}
                      onBlur={async () => {
                        const k = newCol.trim();
                        setNewCol(null);
                        if (k && rows[0]) {
                          await api.setProp(rows[0].path, k, "");
                          load();
                        }
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path}>
                  <td className="db-name" onClick={() => st.go({ kind: "page", path: r.path })}>
                    <FileText size={14} /> <span>{r.title}</span>
                  </td>
                  {cols.map((c) => (
                    <Cell key={c} value={r.props[c]} onSave={(v) => setCell(r, c, v)} />
                  ))}
                  <td className="db-date">{timeAgo(r.mtime)}</td>
                  <td />
                </tr>
              ))}
              <tr>
                <td colSpan={cols.length + 3}>
                  <button className="db-add-row" onClick={() => addRow()}>
                    <Plus size={13} /> {t("Nueva página")}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          {!!view.hidden?.length && (
            <div className="db-hidden">
              {t("Ocultas:")}
              {view.hidden.map((h) => (
                <button key={h} className="chip" onClick={() => saveView({ ...view, hidden: view.hidden!.filter((x) => x !== h) })}>
                  {h} <X size={10} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ value, onSave }: { value: any; onSave: (v: string) => void }) {
  const [v, setV] = useState(fmt(value));
  useEffect(() => setV(fmt(value)), [value]);
  if (typeof value === "boolean")
    return (
      <td className="db-cell center">
        <input type="checkbox" checked={value} onChange={(e) => onSave(String(e.target.checked))} />
      </td>
    );
  return (
    <td className="db-cell">
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onSave(v)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </td>
  );
}

function Board({ rows, col, onMove, onAdd }: { rows: Row[]; col: string; onMove: (r: Row, v: string) => void; onAdd: (v: string) => void }) {
  const st = useStore();
  const groups = useMemo(() => {
    const g = new Map<string, Row[]>();
    for (const r of rows) {
      const k = fmt(r.props[col]) || "";
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(r);
    }
    const keys = [...g.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    return keys.map((k) => [k, g.get(k)!] as const);
  }, [rows, col]);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="board">
      {groups.map(([k, list]) => (
        <div
          key={k || "_"}
          className={`board-col ${over === k ? "drop" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setOver(k))}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            setOver(null);
            const p = e.dataTransfer.getData("application/x-ob-row");
            const r = rows.find((x) => x.path === p);
            if (r) onMove(r, k);
          }}
        >
          <div className="board-head">
            <span className="board-name">{k || t("Sin valor")}</span>
            <span className="muted">{list.length}</span>
          </div>
          {list.map((r) => (
            <div key={r.path} className="board-card" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-ob-row", r.path)} onClick={() => st.go({ kind: "page", path: r.path })}>
              <b>{r.title}</b>
              <div className="board-props">
                {Object.entries(r.props)
                  .filter(([c, v]) => c !== col && fmt(v))
                  .slice(0, 3)
                  .map(([c, v]) => (
                    <span key={c} className="chip">
                      {fmt(v)}
                    </span>
                  ))}
              </div>
            </div>
          ))}
          <button className="board-add" onClick={() => onAdd(k)}>
            <Plus size={13} /> {t("Nueva")}
          </button>
        </div>
      ))}
    </div>
  );
}
