// Talking to the local OpenBlocks server. Every request that changes something carries the
// X-OpenBlocks header (the server refuses it otherwise).

export type TreeNode = {
  name: string;
  path: string;
  kind: "folder" | "page" | "file";
  children?: TreeNode[];
  ext?: string;
};

export type Prop = { key: string; value: unknown };

export type Page = {
  path: string;
  title: string;
  folder: string;
  body: string;
  props: Prop[];
  complex: boolean;
  mtime: number;
};

export type Hit = { path: string; title: string; kind: "page" | "file"; snippet?: string; tags?: string[] };

export type Model = {
  id: string;
  name: string;
  provider: string;
  local: boolean;
  tools: boolean;
  face?: string;
};

export type Status = {
  app: string;
  version: string;
  vault: null | { path: string; name: string; stats: { pages: number; files: number; words: number } };
  onboarded: boolean;
  english: boolean;
  platform: string;
};

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

async function req<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const headers: Record<string, string> = { "X-OpenBlocks": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(url, {
    method,
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new ApiError((data && data.error) || text || r.statusText, r.status);
  return data as T;
}

const q = (o: Record<string, string | number | boolean | undefined>) =>
  "?" +
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = {
  get: <T>(url: string) => req<T>("GET", url),
  post: <T>(url: string, body?: unknown) => req<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => req<T>("PUT", url, body ?? {}),
  del: <T>(url: string) => req<T>("DELETE", url),

  status: () => req<Status>("GET", "/api/status"),
  settings: () => req<any>("GET", "/api/settings"),
  saveSettings: (patch: unknown) => req<any>("PUT", "/api/settings", patch),
  pickFolder: () => req<{ path: string | null }>("POST", "/api/pick-folder", {}),
  openVault: (path: string, name?: string, guide = false) => req<any>("POST", "/api/vault/open", { path, name, guide }),
  vaults: () => req<{ path: string; name: string; opened: number; exists: boolean }[]>("GET", "/api/vaults"),
  tree: () => req<{ tree: TreeNode[]; favorites: string[]; collapsed: string[]; databases: string[] }>("GET", "/api/tree"),
  page: (path: string) => req<Page>("GET", "/api/page" + q({ path })),
  savePage: (path: string, body: string, props: Prop[] | null, base?: number) =>
    req<{ mtime: number }>("PUT", "/api/page", { path, body, props, base }),
  createPage: (folder: string, title: string, body = "", template?: string) =>
    req<{ path: string }>("POST", "/api/page/create", { folder, title, body, template }),
  createFolder: (path: string) => req<{ path: string }>("POST", "/api/folder", { path }),
  move: (from: string, to: string) => req<{ path: string; fixed: number }>("POST", "/api/move", { from, to }),
  trash: (path: string) => req("DELETE", "/api/entry" + q({ path })),
  trashList: () => req<any[]>("GET", "/api/trash"),
  restore: (id: string) => req<{ path: string }>("POST", "/api/trash/restore", { id }),
  emptyTrash: () => req("DELETE", "/api/trash"),
  setProp: (path: string, key: string, value: unknown, remove = false) => req("PUT", "/api/property", { path, key, value, remove }),
  favorite: (path: string, on: boolean) => req("POST", "/api/favorite", { path, on }),
  collapsed: (collapsed: string[]) => req("POST", "/api/collapsed", { collapsed }),
  search: (s: string, limit = 40) => req<Hit[]>("GET", "/api/search" + q({ q: s, limit })),
  titles: (s: string, limit = 12) => req<Hit[]>("GET", "/api/titles" + q({ q: s, limit })),
  resolve: (s: string) => req<{ path: string | null }>("GET", "/api/resolve" + q({ q: s })),
  backlinks: (path: string) => req<{ linked: any[]; unlinked: any[] }>("GET", "/api/backlinks" + q({ path })),
  graph: () => req<{ nodes: any[]; edges: [string, string][] }>("GET", "/api/graph"),
  tags: () => req<{ tag: string; count: number; pages: string[] }[]>("GET", "/api/tags"),
  recent: () => req<any[]>("GET", "/api/recent"),
  database: (folder: string) => req<any>("GET", "/api/database" + q({ folder })),
  databaseView: (folder: string, view: unknown, remove = false) => req("PUT", "/api/database", { folder, view, remove }),
  history: (path: string) => req<{ id: string; stamp: string; reason: string; size: number }[]>("GET", "/api/history" + q({ path })),
  historyVersion: (path: string, id: string) => req<{ text: string; body: string }>("GET", "/api/history/version" + q({ path, id })),
  restoreVersion: (path: string, id: string) => req("POST", "/api/history/restore", { path, id }),
  upload: (folder: string, file: File) =>
    req<{ path: string; size: number }>("POST", "/api/upload" + q({ folder, name: file.name }), undefined, file),
  preview: (path: string) => req<any>("GET", "/api/preview" + q({ path })),
  open: (path: string, reveal = false) => req("POST", "/api/open", { path, reveal }),
  openUrl: (url: string) => req("POST", "/api/open", { url }),
  daily: (name?: string) => req<{ path: string }>("POST", "/api/daily" + q({ name })),
  templates: () => req<{ path: string; title: string }[]>("GET", "/api/templates"),
  models: (refresh = false) => req<Model[]>("GET", "/api/ai/models" + q({ refresh: refresh || undefined })),
  chats: () => req<any[]>("GET", "/api/ai/chats"),
  chat: (id: string) => req<any>("GET", "/api/ai/chat" + q({ id })),
  deleteChat: (id: string) => req("DELETE", "/api/ai/chat" + q({ id })),
  stopChat: (chat: string) => req("POST", "/api/ai/stop", { chat }),
  undo: (edit: any) => req("POST", "/api/ai/undo", edit),
  remote: () => req<any>("GET", "/api/remote"),
  remoteSet: (patch: any) => req<any>("PUT", "/api/remote", patch),
  remoteToken: () => req<any>("POST", "/api/remote/token"),
  remoteInstall: () => req("POST", "/api/remote/install"),
  remoteReconnect: () => req<any>("POST", "/api/remote/reconnect"),
  local: () => req<any>("GET", "/api/local"),
  localDownload: (id: string) => req("POST", "/api/local/download", { id }),
  attach: (file: File) =>
    req<{ id: string; name: string; size: number; readable: boolean }>("POST", "/api/ai/attach" + q({ name: file.name }), undefined, file),
  family: () => req<any>("GET", "/api/family"),
  familyOpen: (id: string) => req("POST", "/api/family/open", { id }),
  saveToBrain: (path: string) => req<{ path: string }>("POST", "/api/family/brain/save", { path }),
  workstudio: (on: boolean) => req("POST", "/api/family/workstudio", { on }),
  updateCheck: () => req<{ current: string; latest: string | null; update: boolean }>("GET", "/api/update"),
  updateRun: () => req("POST", "/api/update", {}),
};

export const fileUrl = (path: string, download = false) =>
  "/api/file" + q({ path, download: download || undefined });

/** POSTs and reads a server-sent event stream; calls `on` for each JSON event. */
export async function stream(url: string, body: unknown, on: (ev: any) => void, signal?: AbortSignal) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "X-OpenBlocks": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const t = await r.text();
    let msg = t;
    try {
      msg = JSON.parse(t).error ?? t;
    } catch {}
    throw new ApiError(msg || r.statusText, r.status);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        on(JSON.parse(data));
      } catch {}
    }
  }
}

export const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(p);
export const isVideo = (p: string) => /\.(mp4|webm|mov|m4v)$/i.test(p);
export const isAudio = (p: string) => /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(p);
export const extOf = (p: string) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
export const baseName = (p: string) => p.split("/").pop() ?? p;
export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const stem = (p: string) => baseName(p).replace(/\.(md|markdown)$/i, "");

export function humanSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
