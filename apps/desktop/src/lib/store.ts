import { create } from "zustand";
import { api, type Model, type Status, type TreeNode, stem } from "./api";
import { resolveLang, setLang, t, type Lang } from "./i18n";
import { applyAppearance } from "./appearance";

export type Route =
  | { kind: "home" }
  | { kind: "page"; path: string }
  | { kind: "folder"; path: string }
  /** A file shown in the whole page: HTML artifacts and spreadsheets. */
  | { kind: "file"; path: string }
  | { kind: "graph" }
  | { kind: "trash" }
  | { kind: "tag"; tag: string };

/** A tab: its page and its own back/forward history. The active tab's live in `route`, `back`, `forward`. */
export type Tab = { id: number; route: Route; back: Route[]; forward: Route[] };

export type Panel = null | { kind: "ai" } | { kind: "preview"; path: string } | { kind: "history"; path: string };

type Toast = { id: number; text: string; kind: "info" | "error" | "ok"; action?: { label: string; run: () => void } };

type State = {
  ready: boolean;
  status: Status | null;
  settings: any;
  lang: Lang;
  tree: TreeNode[];
  favorites: string[];
  collapsed: string[];
  databases: string[];
  names: Set<string>;
  route: Route;
  back: Route[];
  forward: Route[];
  panel: Panel;
  tabs: Tab[];
  tabIdx: number;
  floating: string | null;
  palette: null | "all" | "pages";
  settingsTab: string | null;
  sidebar: boolean;
  /** The sidebar shown over the page while it is hidden (mouse on the left edge). */
  peek: boolean;
  sideWidth: number;
  /** Widths of the right panels (preview, AI, history), dragged by their left edge. */
  panelW: Record<string, number>;
  toasts: Toast[];
  models: Model[];
  /** Bumped when files change on disk, with which ones. */
  external: { n: number; paths: string[] };
  /** Text to send to the AI panel when it opens. */
  aiSeed: { text: string; n: number } | null;
  renaming: string | null;

  boot(): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshTree(): Promise<void>;
  loadModels(refresh?: boolean): Promise<void>;
  go(r: Route, opts?: { replace?: boolean }): void;
  goBack(): void;
  goForward(): void;
  /** A new tab (Home when no route is given), made active unless `background`. */
  newTab(r?: Route, background?: boolean): void;
  switchTab(i: number): void;
  closeTab(i: number): void;
  openPath(path: string, kind?: string): void;
  newPage(folder?: string, title?: string, template?: string): Promise<string | null>;
  daily(): Promise<void>;
  /** New HTML artifact or spreadsheet in a folder, opened right away. */
  newFile(folder: string, kind: "html" | "xlsx"): Promise<void>;
  setPanel(p: Panel): void;
  togglePanel(kind: "ai"): void;
  askAI(text: string): void;
  saveSettings(patch: any): Promise<void>;
  toast(text: string, kind?: Toast["kind"], action?: Toast["action"]): void;
  dismiss(id: number): void;
  exists(target: string): boolean;
  /** The page a link target points to, from the tree (used when the server cannot say). */
  pagePath(target: string): string | null;
  /** A `[[link]]` to a page: just the name when it is unique, the full path otherwise. */
  linkTo(path: string): string;
};

function pagesOf(tree: TreeNode[], out: TreeNode[] = []) {
  for (const n of tree) {
    if (n.kind === "page") out.push(n);
    if (n.children) pagesOf(n.children, out);
  }
  return out;
}

let toastId = 0;
let tabId = 1;

/** The tabs with the active one's current route and history written in. */
function snapshot(): Tab[] {
  const s = useStore.getState();
  return s.tabs.map((x, i) => (i === s.tabIdx ? { ...x, route: s.route, back: s.back.slice(-30), forward: s.forward.slice(0, 30) } : x));
}

function saveTabs() {
  const s = useStore.getState();
  const v = s.status?.vault?.path;
  if (!v || !s.settings?.tabs) return;
  LS.set("ob-tabs:" + v, JSON.stringify({ tabs: snapshot().map((x) => ({ ...x, back: x.back.slice(-10), forward: x.forward.slice(0, 10) })), idx: s.tabIdx }));
}

function namesOf(tree: TreeNode[], out = new Set<string>()) {
  for (const n of tree) {
    if (n.kind === "page") {
      out.add(n.name.toLowerCase());
      out.add(n.path.toLowerCase().replace(/\.md$/, ""));
    } else if (n.kind === "file") {
      out.add(n.name.toLowerCase());
      out.add(n.path.toLowerCase());
    } else if (n.kind === "folder") {
      // Links to folders (databases imported from Notion) open the folder.
      out.add(n.path.toLowerCase());
    }
    if (n.children) namesOf(n.children, out);
  }
  return out;
}

const LS = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export function applyTheme(theme: string) {
  LS.set("ob-theme", theme || "system");
  const dark = theme === "dark" || ((!theme || theme === "system") && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  status: null,
  settings: {},
  lang: "es",
  tree: [],
  favorites: [],
  collapsed: [],
  databases: [],
  names: new Set(),
  route: { kind: "home" },
  back: [],
  forward: [],
  panel: null,
  tabs: [{ id: 1, route: { kind: "home" }, back: [], forward: [] }],
  tabIdx: 0,
  floating: null,
  palette: null,
  settingsTab: null,
  sidebar: LS.get("ob-sidebar") !== "0",
  peek: false,
  sideWidth: Math.min(480, Math.max(200, Number(LS.get("ob-side-w")) || 264)),
  panelW: (() => {
    try {
      return JSON.parse(LS.get("ob-panel-w") || "{}");
    } catch {
      return {};
    }
  })(),
  toasts: [],
  models: [],
  external: { n: 0, paths: [] },
  aiSeed: null,
  renaming: null,

  async boot() {
    const [status, settings] = await Promise.all([api.status(), api.settings()]);
    const lang = resolveLang(settings.language);
    setLang(lang);
    applyTheme(settings.theme);
    applyAppearance(settings);
    document.documentElement.dataset.width = settings.width || "normal";
    set({ status, settings, lang });
    if (status.vault) {
      await get().refreshTree();
      const ok = (r: Route) => (r.kind !== "page" && r.kind !== "file") || get().names.has(r.path.toLowerCase().replace(/\.md$/, ""));
      const last = LS.get("ob-route:" + status.vault.path);
      if (last) {
        try {
          const r = JSON.parse(last) as Route;
          if (ok(r)) set({ route: r });
        } catch {}
      }
      if (settings.tabs) {
        try {
          const saved = JSON.parse(LS.get("ob-tabs:" + status.vault.path) || "null");
          const tabs: Tab[] = (saved?.tabs ?? []).filter((x: Tab) => x?.route && ok(x.route)).slice(0, 30);
          if (tabs.length) {
            const idx = Math.min(Math.max(0, saved.idx ?? 0), tabs.length - 1);
            tabId = Math.max(...tabs.map((x) => x.id));
            set({ tabs, tabIdx: idx, route: tabs[idx].route, back: tabs[idx].back ?? [], forward: tabs[idx].forward ?? [] });
          }
        } catch {}
      }
    }
    useStore.subscribe((s, prev) => {
      if (s.route !== prev.route || s.tabs !== prev.tabs || s.tabIdx !== prev.tabIdx) saveTabs();
    });
    set({ ready: true });
    // Live updates from the server (files changed on disk, another vault opened).
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        if (ev.kind === "tree") get().refreshTree();
        if (ev.kind === "changed") {
          get().refreshTree();
          set((s) => ({ external: { n: s.external.n + 1, paths: ev.paths } }));
        }
        if (ev.kind === "vault") get().refreshStatus();
      } catch {}
    };
    get().loadModels();
  },

  async refreshStatus() {
    const status = await api.status();
    set({ status });
    if (status.vault) await get().refreshTree();
  },

  async refreshTree() {
    try {
      const r = await api.tree();
      set({ tree: r.tree, favorites: r.favorites, collapsed: r.collapsed, databases: r.databases, names: namesOf(r.tree) });
    } catch {}
  },

  async loadModels(refresh = false) {
    try {
      const models = await api.models(refresh);
      set({ models });
    } catch {}
  },

  go(r, opts) {
    const cur = get().route;
    if (JSON.stringify(cur) === JSON.stringify(r)) return;
    set((s) => ({
      route: r,
      back: opts?.replace ? s.back : [...s.back.slice(-50), cur],
      forward: [],
      renaming: null,
    }));
    const v = get().status?.vault?.path;
    if (v) LS.set("ob-route:" + v, JSON.stringify(r));
  },
  newTab(r, background) {
    const s = get();
    const tabs = snapshot();
    const tab: Tab = { id: ++tabId, route: r ?? { kind: "home" }, back: [], forward: [] };
    const at = s.tabIdx + 1;
    tabs.splice(at, 0, tab);
    if (background) set({ tabs, tabIdx: s.tabIdx });
    else set({ tabs, tabIdx: at, route: tab.route, back: [], forward: [], renaming: null });
  },
  switchTab(i) {
    const s = get();
    if (i === s.tabIdx || !s.tabs[i]) return;
    const tabs = snapshot();
    const tab = tabs[i];
    set({ tabs, tabIdx: i, route: tab.route, back: tab.back, forward: tab.forward, renaming: null });
  },
  closeTab(i) {
    const s = get();
    const tabs = snapshot();
    if (tabs.length <= 1) {
      // The last tab goes back to Home instead of leaving no page.
      tabs[0] = { id: ++tabId, route: { kind: "home" }, back: [], forward: [] };
      set({ tabs, tabIdx: 0, route: tabs[0].route, back: [], forward: [] });
      return;
    }
    tabs.splice(i, 1);
    if (i !== s.tabIdx) {
      set({ tabs, tabIdx: s.tabIdx > i ? s.tabIdx - 1 : s.tabIdx });
      return;
    }
    const idx = Math.min(i, tabs.length - 1);
    const tab = tabs[idx];
    set({ tabs, tabIdx: idx, route: tab.route, back: tab.back, forward: tab.forward, renaming: null });
  },
  goBack() {
    const { back, route } = get();
    if (!back.length) return;
    set({ route: back[back.length - 1], back: back.slice(0, -1), forward: [route, ...get().forward] });
  },
  goForward() {
    const { forward, route } = get();
    if (!forward.length) return;
    set({ route: forward[0], forward: forward.slice(1), back: [...get().back, route] });
  },

  openPath(path, kind) {
    const k = kind ?? (/\.(md|markdown)$/i.test(path) ? "page" : "file");
    if (k === "page") get().go({ kind: "page", path });
    else if (k === "folder") get().go({ kind: "folder", path });
    else if (/\.(html?|xlsx|xlsm|xls|ods|csv|tsv)$/i.test(path)) {
      // Artifacts and spreadsheets get the whole page; the side panel showing it closes.
      get().go({ kind: "file", path });
      if (get().panel?.kind === "preview") set({ panel: null });
    } else set({ panel: { kind: "preview", path } });
  },

  async newPage(folder = "", title, template) {
    try {
      // No template given: use the default one chosen in Settings → Templates ("" = blank page).
      const tpl = template ?? (get().settings?.default_template || undefined);
      const r = await api.createPage(folder, title || t("Sin título"), "", tpl);
      await get().refreshTree();
      get().go({ kind: "page", path: r.path });
      set({ renaming: r.path });
      return r.path;
    } catch (e: any) {
      get().toast(e.message, "error");
      return null;
    }
  },

  async newFile(folder, kind) {
    try {
      const r = await api.createFile(folder, kind === "html" ? t("Artefacto") : t("Planilla"), kind);
      await get().refreshTree();
      get().go({ kind: "file", path: r.path });
    } catch (e: any) {
      get().toast(e.message, "error");
    }
  },

  async daily() {
    try {
      const r = await api.daily();
      await get().refreshTree();
      get().go({ kind: "page", path: r.path });
    } catch (e: any) {
      get().toast(e.message, "error");
    }
  },

  setPanel(p) {
    set({ panel: p });
  },
  togglePanel(kind) {
    set((s) => ({ panel: s.panel?.kind === kind ? null : { kind } }));
  },
  askAI(text) {
    set((s) => ({ panel: { kind: "ai" }, aiSeed: { text, n: (s.aiSeed?.n ?? 0) + 1 } }));
  },

  async saveSettings(patch) {
    const settings = await api.saveSettings(patch);
    const lang = resolveLang(settings.language);
    setLang(lang);
    applyTheme(settings.theme);
    applyAppearance(settings);
    document.documentElement.dataset.width = settings.width || "normal";
    set({ settings, lang });
  },

  toast(text, kind = "info", action) {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
    setTimeout(() => get().dismiss(id), action ? 8000 : 4200);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },

  pagePath(target) {
    const k = target.split("#")[0].trim().replace(/^\.?\//, "").toLowerCase().replace(/\.md$/, "");
    if (!k) return null;
    const pages = pagesOf(get().tree);
    const exact = pages.find((p) => p.path.toLowerCase().replace(/\.md$/, "") === k);
    if (exact) return exact.path;
    const tail = pages.filter((p) => p.path.toLowerCase().replace(/\.md$/, "").endsWith("/" + k) || p.name.toLowerCase() === k);
    tail.sort((a, b) => a.path.length - b.path.length);
    return tail[0]?.path ?? null;
  },

  linkTo(path) {
    const name = stem(path);
    const same = pagesOf(get().tree).filter((p) => p.name.toLowerCase() === name.toLowerCase()).length;
    return same > 1 ? `[[${path.replace(/\.md$/i, "")}|${name}]]` : `[[${name}]]`;
  },

  exists(target) {
    const k = target.toLowerCase().replace(/\.md$/, "");
    const n = get().names;
    return n.has(k) || n.has(stem(k));
  },
}));

/** Where a path opens in the whole page, or null for files that open in the side panel. */
export function routeFor(path: string, kind?: string): Route | null {
  const k = kind ?? (/\.(md|markdown)$/i.test(path) ? "page" : "file");
  if (k === "page") return { kind: "page", path };
  if (k === "folder") return { kind: "folder", path };
  if (/\.(html?|xlsx|xlsm|xls|ods|csv|tsv)$/i.test(path)) return { kind: "file", path };
  return null;
}

export function setSidebarWidth(w: number, save = true) {
  const width = Math.round(Math.min(480, Math.max(200, w)));
  if (save) LS.set("ob-side-w", String(width));
  useStore.setState({ sideWidth: width });
}

export const PANEL_MIN = 300;
export function setPanelWidth(kind: string, w: number | null, save = true) {
  const panelW = { ...useStore.getState().panelW };
  if (w == null) delete panelW[kind];
  else panelW[kind] = Math.round(Math.max(PANEL_MIN, Math.min(window.innerWidth - 360, w)));
  if (save) LS.set("ob-panel-w", JSON.stringify(panelW));
  useStore.setState({ panelW });
}

export function setSidebar(open: boolean) {
  LS.set("ob-sidebar", open ? "1" : "0");
  useStore.setState({ sidebar: open, peek: false });
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || document.documentElement.dataset.desktop === "mac";
export const mod = isMac ? "⌘" : "Ctrl";
