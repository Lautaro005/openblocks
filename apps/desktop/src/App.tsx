import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  SidebarSimple,
  CaretLeft,
  CaretRight,
  Star,
  ClockCounterClockwise,
  Sparkle,
  DotsThree,
  DownloadSimple,
  FileHtml,
  Printer,
  ArrowSquareOut,
  LinkSimple,
  Trash,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  Robot,
  X,
  Info,
} from "@phosphor-icons/react";
import { api, dirOf, fileUrl, stem } from "./lib/api";
import { isMac, setSidebar, useStore } from "./lib/store";
import { appearanceOf, nextZoom } from "./lib/appearance";
import { t } from "./lib/i18n";
import { renderMd } from "./lib/render";
import { Sidebar, SidebarPeek } from "./components/Sidebar";
import { PageView, type SaveState } from "./components/PageView";
import { AiPanel } from "./components/AiPanel";
import { PreviewPanel, FloatingPreview, FilePage } from "./components/Preview";
import { HistoryPanel } from "./components/History";
import { Home, TrashView, TagView, FolderView } from "./components/Views";
import { Palette } from "./components/Palette";
const DatabaseView = lazy(() => import("./components/Database").then((m) => ({ default: m.DatabaseView })));
const GraphView = lazy(() => import("./components/Graph").then((m) => ({ default: m.GraphView })));
const Settings = lazy(() => import("./components/Settings").then((m) => ({ default: m.Settings })));
const Walkthrough = lazy(() => import("./components/Walkthrough").then((m) => ({ default: m.Walkthrough })));
import { ContextMenu, openMenuAt, type MenuItem } from "./components/Menu";
import { Brand } from "./components/Brand";

export function App() {
  const st = useStore();
  const [walk, setWalk] = useState(false);
  const [save, setSave] = useState<{ s: SaveState; at?: number }>({ s: "saved" });

  useEffect(() => {
    st.boot().catch(() => {});
  }, []);

  useEffect(() => {
    if (!st.ready) return;
    if (!st.status?.vault || localStorage.getItem("ob-walk") === "1") setWalk(true);
  }, [st.ready]);

  // Global shortcuts.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const m = isMac ? e.metaKey : e.ctrlKey;
      if (e.key === "Escape") {
        const s = useStore.getState();
        if (s.palette) useStore.setState({ palette: null });
        else if (s.floating) useStore.setState({ floating: null });
        return;
      }
      if (!m || e.defaultPrevented) return;
      const s = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "k") (e.preventDefault(), useStore.setState({ palette: s.palette ? null : "all" }));
      else if (key === "p" && !e.shiftKey) (e.preventDefault(), useStore.setState({ palette: "pages" }));
      else if (key === "n" && !e.shiftKey) (e.preventDefault(), s.newPage(s.route.kind === "folder" ? s.route.path : s.route.kind === "page" ? dirOf(s.route.path) : ""));
      else if (key === "j") (e.preventDefault(), s.togglePanel("ai"));
      else if (key === "d" && !e.shiftKey) (e.preventDefault(), s.daily());
      else if (key === "g") (e.preventDefault(), s.go({ kind: "graph" }));
      else if (key === "\\") (e.preventDefault(), setSidebar(!s.sidebar));
      else if (key === ",") (e.preventDefault(), useStore.setState({ settingsTab: "general" }));
      else if (!e.altKey && (key === "=" || key === "+" || key === "-" || key === "0")) {
        // The window's zoom, kept in Settings → Appearance.
        e.preventDefault();
        const cur = appearanceOf(s.settings).zoom;
        const z = key === "0" ? 1 : nextZoom(cur, key === "-" ? -1 : 1);
        s.saveSettings({ appearance: { zoom: z } });
      } else if (key === "[") (e.preventDefault(), s.goBack());
      else if (key === "]") (e.preventDefault(), s.goForward());
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const onSaveState = useCallback((s: SaveState, at?: number) => setSave((p) => ({ s, at: at ?? p.at })), []);

  if (!st.ready)
    return (
      <div className="boot">
        <div className="boot-mark" />
      </div>
    );
  if (walk)
    return (
      <Suspense fallback={<div className="boot" />}>
        <Walkthrough onDone={() => setWalk(false)} />
      </Suspense>
    );

  const r = st.route;
  const panel = st.panel;
  return (
    <div
      className={`shell ${st.sidebar ? "" : "no-sidebar"} ${panel ? "has-panel" : ""}`}
      style={{ ["--side-w" as any]: `${st.sideWidth}px` }}
    >
      {st.sidebar && <Sidebar />}
      {!st.sidebar && <SidebarPeek />}
      <main className="main">
        <TopBar save={save} />
        <div className="content" id="content">
          <Suspense fallback={<div className="page-loading" />}>
          {r.kind === "home" && <Home />}
          {r.kind === "page" && <PageView key={r.path} path={r.path} onSaveState={onSaveState} />}
          {r.kind === "folder" && (st.databases.includes(r.path) ? <DatabaseView folder={r.path} /> : <FolderView path={r.path} />)}
          {r.kind === "file" && <FilePage key={r.path} path={r.path} />}
          {r.kind === "graph" && <GraphView />}
          {r.kind === "trash" && <TrashView />}
          {r.kind === "tag" && <TagView tag={r.tag} />}
          </Suspense>
        </div>
      </main>
      {panel?.kind === "ai" && <AiPanel />}
      {panel?.kind === "preview" && <PreviewPanel path={panel.path} />}
      {panel?.kind === "history" && <HistoryPanel path={panel.path} />}
      {st.floating && <FloatingPreview path={st.floating} />}
      {st.palette && <Palette />}
      {st.settingsTab && (
        <Suspense fallback={null}>
          <Settings />
        </Suspense>
      )}
      <ContextMenu />
      <Toasts />
    </div>
  );
}

function TopBar({ save }: { save: { s: SaveState; at?: number } }) {
  const st = useStore();
  const r = st.route;
  const path = r.kind === "page" ? r.path : null;
  const crumbs = path
    ? dirOf(path).split("/").filter(Boolean)
    : r.kind === "folder" || r.kind === "file"
      ? (r.kind === "file" ? dirOf(r.path) : r.path).split("/").filter(Boolean)
      : [];
  const title =
    r.kind === "page"
      ? stem(r.path)
      : r.kind === "file"
        ? r.path.split("/").pop()!
      : r.kind === "graph"
        ? t("Grafo")
        : r.kind === "trash"
          ? t("Papelera")
          : r.kind === "tag"
            ? "#" + r.tag
            : r.kind === "home"
              ? t("Inicio")
              : "";
  const fav = path ? st.favorites.includes(path) : false;

  const more = async (el: HTMLElement) => {
    if (!path) return;
    const family = await api.family().catch(() => null);
    const items: MenuItem[] = [
      { label: t("Copiar enlace [[ ]]"), icon: LinkSimple, run: () => navigator.clipboard.writeText(st.linkTo(path)) },
      { label: t("Historial de versiones"), icon: ClockCounterClockwise, run: () => st.setPanel({ kind: "history", path }) },
      { sep: true },
      { title: t("Exportar") },
      {
        label: t("Markdown (.md)"),
        icon: DownloadSimple,
        run: () => {
          const a = document.createElement("a");
          a.href = fileUrl(path, true);
          a.download = path.split("/").pop()!;
          a.click();
        },
      },
      { label: t("HTML"), icon: FileHtml, run: () => exportHtml(path) },
      { label: t("Imprimir o guardar como PDF"), icon: Printer, run: () => window.print() },
    ];
    if (family?.brain?.installed || (family?.opencue?.agents ?? []).length) items.push({ sep: true }, { title: t("Familia") });
    if (family?.brain?.installed)
      items.push({
        label: t("Guardar en brain"),
        icon: () => <Brand name="brain" size={15} />,
        run: async () => {
          try {
            const res = await api.saveToBrain(path);
            st.toast(t("Guardada en brain: {p}", { p: res.path }), "ok");
          } catch (e: any) {
            st.toast(e.message, "error");
          }
        },
      });
    for (const a of (family?.opencue?.agents ?? []).slice(0, 6))
      items.push({
        label: t("Mandar a {a} (OpenCue)", { a: a.name }),
        icon: Robot,
        run: () => {
          st.saveSettings({ ai: { model: `opencue:${a.name}` } });
          st.askAI(t("Te comparto esta página. "));
        },
      });
    items.push(
      { sep: true },
      { label: t("Mostrar en el sistema"), icon: ArrowSquareOut, run: () => api.open(path, true) },
      {
        label: t("Mover a la papelera"),
        icon: Trash,
        danger: true,
        run: async () => {
          await api.trash(path);
          await st.refreshTree();
          st.go({ kind: "home" }, { replace: true });
          st.toast(t("«{n}» está en la papelera.", { n: stem(path) }));
        },
      },
    );
    openMenuAt(el, items);
  };

  return (
    <header className="topbar" data-tauri-drag-region>
      {!st.sidebar && (
        <button
          className="btn-icon"
          onClick={() => setSidebar(true)}
          onMouseEnter={() => useStore.setState({ peek: true })}
          title={t("Mostrar la barra lateral")}
        >
          <SidebarSimple size={18} />
        </button>
      )}
      <div className="nav-btns">
        <button className="btn-icon" disabled={!st.back.length} onClick={() => st.goBack()} title={t("Atrás")}>
          <CaretLeft size={16} />
        </button>
        <button className="btn-icon" disabled={!st.forward.length} onClick={() => st.goForward()} title={t("Adelante")}>
          <CaretRight size={16} />
        </button>
      </div>
      <nav className="crumbs" data-tauri-drag-region>
        {crumbs.map((c, i) => (
          <span key={i} className="crumb">
            <button onClick={() => st.go({ kind: "folder", path: crumbs.slice(0, i + 1).join("/") })}>{c}</button>
            <span className="crumb-sep">/</span>
          </span>
        ))}
        <span className="crumb current">{title}</span>
      </nav>
      <div className="push" />
      {path && (
        <span className={`save-state ${save.s}`} title={save.at ? new Date(save.at * 1000).toLocaleTimeString() : ""}>
          {save.s === "saving" || save.s === "dirty" ? (
            <>
              <CircleNotch size={13} className="spin-i" /> {t("Guardando")}
            </>
          ) : save.s === "error" || save.s === "conflict" ? (
            <>
              <WarningCircle size={13} /> {save.s === "conflict" ? t("Conflicto") : t("Sin guardar")}
            </>
          ) : (
            <>
              <CheckCircle size={13} /> {t("Guardado")}
            </>
          )}
        </span>
      )}
      {path && (
        <>
          <button
            className={`btn-icon ${fav ? "fav" : ""}`}
            title={fav ? t("Quitar de favoritos") : t("Agregar a favoritos")}
            onClick={async () => {
              await api.favorite(path, !fav);
              st.refreshTree();
            }}
          >
            <Star size={17} weight={fav ? "fill" : "regular"} />
          </button>
          <button className={`btn-icon ${st.panel?.kind === "history" ? "on" : ""}`} title={t("Historial")} onClick={() => st.setPanel(st.panel?.kind === "history" ? null : { kind: "history", path })}>
            <ClockCounterClockwise size={17} />
          </button>
        </>
      )}
      <button className={`btn ai-btn ${st.panel?.kind === "ai" ? "on" : ""}`} onClick={() => st.togglePanel("ai")}>
        <Sparkle size={15} weight="fill" /> {t("IA")}
      </button>
      {path && (
        <button className="btn-icon" title={t("Más")} onClick={(e) => more(e.currentTarget)}>
          <DotsThree size={20} weight="bold" />
        </button>
      )}
    </header>
  );
}

async function exportHtml(path: string) {
  const p = await api.page(path);
  const css = `body{font:16px/1.65 -apple-system,system-ui,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#1d1c1a}h1,h2,h3{line-height:1.25}pre{background:#f4f2ee;padding:12px;border-radius:8px;overflow:auto}code{font-family:ui-monospace,Menlo,monospace}blockquote{border-left:3px solid #1d1c1a;margin:0;padding-left:14px;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}.callout{border-radius:8px;padding:10px 14px;background:#f4f2ee;margin:12px 0}.callout-title{font-weight:700}mark{background:#fde68a}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${p.title}</title><style>${css}</style></head><body><h1>${p.title}</h1>${renderMd(p.body)}</body></html>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = `${p.title}.html`;
  a.click();
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`}>
          {x.kind === "error" ? <WarningCircle size={16} /> : x.kind === "ok" ? <CheckCircle size={16} /> : <Info size={16} />}
          <span>{x.text}</span>
          {x.action && (
            <button
              className="btn xs"
              onClick={() => {
                x.action!.run();
                useStore.getState().dismiss(x.id);
              }}
            >
              {x.action.label}
            </button>
          )}
          <button className="btn-icon xs" onClick={() => useStore.getState().dismiss(x.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
