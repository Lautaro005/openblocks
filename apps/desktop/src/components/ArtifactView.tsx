// An HTML artifact: how it looks (sandboxed, with its linked spreadsheets as data) or its code,
// with a toggle between the two. The view reloads when the code or a linked spreadsheet changes.
import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Code, ArrowClockwise, Table, Plus, X, FloppyDisk, MagnifyingGlass, FilePlus } from "@phosphor-icons/react";
import { api, artifactUrl, baseName, dirOf, fileUrl, isSheet, type TreeNode } from "../lib/api";
import { useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { CodeArea } from "./CodeArea";

type Mode = "view" | "code";

function readMode(): Mode {
  try {
    return localStorage.getItem("ob-artifact-mode") === "code" ? "code" : "view";
  } catch {
    return "view";
  }
}

function sheetsIn(tree: TreeNode[], out: string[] = []) {
  for (const n of tree) {
    if (n.kind === "file" && isSheet(n.path)) out.push(n.path);
    if (n.children) sheetsIn(n.children, out);
  }
  return out;
}

/** The view alone, for a page that embeds the artifact. */
export function ArtifactFrame({ path, height, n = 0 }: { path: string; height?: number; n?: number }) {
  const theme = document.documentElement.dataset.theme ?? "light";
  const [sources, setSources] = useState<string[]>([]);
  const [k, setK] = useState(0);
  const external = useStore((s) => s.external);
  useEffect(() => {
    api.artifactInfo(path).then((i) => setSources(i.sources.map((s) => s.path).filter(Boolean) as string[])).catch(() => {});
  }, [path, k]);
  useEffect(() => {
    if (external.n && (external.paths.includes(path) || external.paths.some((p) => sources.includes(p)))) setK((x) => x + 1);
  }, [external]);
  return (
    <iframe
      className="artifact-frame"
      title={baseName(path)}
      sandbox="allow-scripts allow-modals allow-downloads"
      src={artifactUrl(path, theme, n + k)}
      style={height ? { height } : undefined}
    />
  );
}

export function ArtifactView({ path }: { path: string }) {
  const st = useStore();
  const [mode, setModeState] = useState<Mode>(readMode);
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [n, setN] = useState(0);
  const [sources, setSources] = useState<{ name: string; path: string | null }[]>([]);
  const [picker, setPicker] = useState(false);
  const [q, setQ] = useState("");
  const pickRef = useRef<HTMLDivElement>(null);
  const theme = document.documentElement.dataset.theme ?? "light";
  const dirty = code != null && code !== saved;

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem("ob-artifact-mode", m);
    } catch {}
  };

  const loadCode = () =>
    fetch(fileUrl(path), { cache: "no-store" })
      .then((r) => r.text())
      .then((t) => {
        setCode(t);
        setSaved(t);
      });
  const loadInfo = () => api.artifactInfo(path).then((i) => setSources(i.sources)).catch(() => setSources([]));

  useEffect(() => {
    setCode(null);
    loadCode();
    loadInfo();
  }, [path]);

  // The file or a linked spreadsheet changed (saved here, by an agent or by another app).
  const external = st.external;
  const lastSave = useRef(0);
  useEffect(() => {
    if (!external.n) return;
    const mine = external.paths.includes(path);
    const data = external.paths.some((p) => sources.some((s) => s.path === p));
    if (mine && Date.now() - lastSave.current > 2000 && !dirty) {
      loadCode();
      loadInfo();
    }
    if (mine || data) setN((x) => x + 1);
  }, [external]);

  useEffect(() => {
    if (!picker) return;
    const h = (e: MouseEvent) => !pickRef.current?.contains(e.target as any) && setPicker(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [picker]);

  const save = async () => {
    if (code == null) return;
    try {
      lastSave.current = Date.now();
      await api.saveText(path, code);
      setSaved(code);
      setN((x) => x + 1);
      loadInfo();
    } catch (e: any) {
      st.toast(e.message, "error");
    }
  };

  const setData = async (list: string[]) => {
    try {
      lastSave.current = Date.now();
      const r = await api.artifactData(path, list);
      setCode(r.text);
      setSaved(r.text);
      await loadInfo();
      setN((x) => x + 1);
    } catch (e: any) {
      st.toast(e.message, "error");
    }
  };

  // Paths are written relative to the artifact's folder when they are inside it.
  const relName = (p: string) => {
    const d = dirOf(path);
    return d && p.startsWith(d + "/") ? p.slice(d.length + 1) : p;
  };

  const all = useMemo(() => sheetsIn(st.tree), [st.tree]);
  const linked = new Set(sources.map((s) => s.path));
  const options = all.filter((p) => !linked.has(p) && (!q || p.toLowerCase().includes(q.toLowerCase()))).slice(0, 40);

  const newSheet = async () => {
    try {
      const r = await api.createFile(dirOf(path), baseName(path).replace(/\.html?$/i, "") + " datos", "xlsx");
      await st.refreshTree();
      await setData([...sources.map((s) => s.name), relName(r.path)]);
      st.setPanel({ kind: "preview", path: r.path });
    } catch (e: any) {
      st.toast(e.message, "error");
    }
    setPicker(false);
  };

  return (
    <div className="artifact">
      <div className="artifact-bar">
        <div className="seg sm">
          <button className={mode === "view" ? "on" : ""} onClick={() => (dirty && save(), setMode("view"))}>
            <Eye size={14} /> {t("Vista")}
          </button>
          <button className={mode === "code" ? "on" : ""} onClick={() => setMode("code")}>
            <Code size={14} /> {t("Código")}
            {dirty && <span className="dot-dirty" />}
          </button>
        </div>
        <div className="artifact-data" ref={pickRef}>
          {sources.map((s) => (
            <span key={s.name} className={`chip data-chip ${s.path ? "" : "missing"}`} title={s.path ?? t("No está en el vault")}>
              <Table size={13} />
              <button className="chip-link" onClick={() => s.path && st.setPanel({ kind: "preview", path: s.path })}>
                {baseName(s.name)}
              </button>
              <button title={t("Desvincular")} onClick={() => setData(sources.filter((x) => x.name !== s.name).map((x) => x.name))}>
                <X size={10} />
              </button>
            </span>
          ))}
          <button className="btn ghost xs" onClick={() => setPicker(!picker)} title={t("Planillas que usa el artefacto (openblocks.table())")}>
            <Plus size={13} /> {t("Datos")}
          </button>
          {picker && (
            <div className="menu data-picker">
              <div className="model-search">
                <MagnifyingGlass size={14} />
                <input autoFocus placeholder={t("Buscar planilla…")} value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="data-picker-list">
                {options.map((p) => (
                  <button key={p} className="menu-item" onClick={() => (setData([...sources.map((s) => s.name), relName(p)]), setPicker(false))}>
                    <Table size={15} /> <span className="ellipsis">{baseName(p)}</span>
                    <span className="muted xs push-left ellipsis">{dirOf(p)}</span>
                  </button>
                ))}
                {!options.length && <div className="muted xs data-picker-empty">{t("No hay planillas (.xlsx, .csv) en el vault.")}</div>}
              </div>
              <div className="menu-sep" />
              <button className="menu-item" onClick={newSheet}>
                <FilePlus size={15} /> {t("Nueva planilla vinculada")}
              </button>
            </div>
          )}
        </div>
        <div className="push" />
        {mode === "code" && (
          <button className="btn sm primary" disabled={!dirty} onClick={save} title={t("Guardar") + " (⌘S)"}>
            <FloppyDisk size={14} /> {dirty ? t("Guardar") : t("Guardado")}
          </button>
        )}
        {mode === "view" && (
          <button className="btn-icon sm" title={t("Recargar")} onClick={() => setN((x) => x + 1)}>
            <ArrowClockwise size={15} />
          </button>
        )}
      </div>
      <div className="artifact-body">
        {mode === "view" ? (
          <iframe key={n} className="artifact-frame full" title={baseName(path)} sandbox="allow-scripts allow-modals allow-downloads" src={artifactUrl(path, theme, n)} />
        ) : code == null ? (
          <div className="pv-loading" />
        ) : (
          <CodeArea value={code} onChange={setCode} lang="xml" onSave={save} />
        )}
      </div>
    </div>
  );
}
