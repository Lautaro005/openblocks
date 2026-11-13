import { lazy, Suspense, useEffect, useState } from "react";
import { Plus, CalendarDots, Sparkle, Graph, ArrowCounterClockwise, Trash, FileText, Hash, Folder, MagnifyingGlass, Table, SortAscending, SortDescending, ListBullets, SquaresFour, FileHtml, PencilSimple, X } from "@phosphor-icons/react";
import { api, stem, type TreeNode } from "../lib/api";
import { openMenuAt, type MenuItem } from "./Menu";
const ArtifactFrame = lazy(() => import("./ArtifactView").then((m) => ({ default: m.ArtifactFrame })));
import { mod, useStore } from "../lib/store";
import { t, timeAgo, getLang } from "../lib/i18n";
import { FileIcon } from "./FileIcon";

export function Home() {
  const st = useStore();
  const [recent, setRecent] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  useEffect(() => {
    api.recent().then(setRecent).catch(() => {});
    api.tags().then((x) => setTags(x.slice(0, 16))).catch(() => {});
  }, [st.tree]);
  const h = new Date().getHours();
  const hello = h < 6 ? t("Buenas noches") : h < 13 ? t("Buen día") : h < 20 ? t("Buenas tardes") : t("Buenas noches");
  const date = new Date().toLocaleDateString(getLang() === "en" ? "en-US" : "es-AR", { weekday: "long", day: "numeric", month: "long" });
  const stats = st.status?.vault?.stats;
  return (
    <div className="home">
      <p className="home-date">{date}</p>
      <h1 className="home-hello">{hello}.</h1>
      <div className="home-actions">
        <button className="home-card" onClick={() => st.newPage("")}>
          <Plus size={20} />
          <b>{t("Página nueva")}</b>
          <span>{mod}N</span>
        </button>
        <button className="home-card" onClick={() => st.daily()}>
          <CalendarDots size={20} />
          <b>{t("Nota del día")}</b>
          <span>{mod}D</span>
        </button>
        <button className="home-card" onClick={() => st.togglePanel("ai")}>
          <Sparkle size={20} />
          <b>{t("Preguntarle a la IA")}</b>
          <span>{mod}J</span>
        </button>
        <button className="home-card" onClick={() => useStore.setState({ palette: "all" })}>
          <MagnifyingGlass size={20} />
          <b>{t("Buscar")}</b>
          <span>{mod}K</span>
        </button>
      </div>
      {recent.length > 0 && (
        <section className="home-section">
          <h4>{t("Editadas hace poco")}</h4>
          <div className="home-recent">
            {recent.map((r) => (
              <button key={r.path} className="recent-row" onClick={() => st.go({ kind: "page", path: r.path })}>
                <FileText size={16} />
                <span className="recent-title">{r.title}</span>
                {r.folder && (
                  <span className="recent-folder">
                    <Folder size={12} /> {r.folder}
                  </span>
                )}
                <span className="recent-time">{timeAgo(r.mtime)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {tags.length > 0 && (
        <section className="home-section">
          <h4>{t("Etiquetas")}</h4>
          <div className="chips">
            {tags.map((x) => (
              <button key={x.tag} className="chip tag-chip" onClick={() => st.go({ kind: "tag", tag: x.tag })}>
                <Hash size={11} /> {x.tag} <span className="muted">{x.count}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {stats && (
        <p className="home-stats muted">
          {t("{p} páginas · {f} archivos · {w} palabras", { p: stats.pages, f: stats.files, w: stats.words.toLocaleString() })}
          {" · "}
          <button className="link" onClick={() => st.go({ kind: "graph" })}>
            <Graph size={12} /> {t("Ver el grafo")}
          </button>
        </p>
      )}
    </div>
  );
}

export function TrashView() {
  const st = useStore();
  const [list, setList] = useState<any[] | null>(null);
  const load = () => api.trashList().then(setList);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="plain-view">
      <h1>{t("Papelera")}</h1>
      <p className="muted">{t("Lo que borrás queda acá, dentro de tu vault (.openblocks/trash), hasta que vacíes la papelera.")}</p>
      {list && !list.length && <div className="empty-box">{t("La papelera está vacía.")}</div>}
      <div className="list">
        {list?.map((x) => (
          <div key={x.id} className="list-row static">
            {x.folder ? <Folder size={16} /> : <FileIcon path={x.path} size={16} />}
            <div className="list-main">
              <b>{x.name}</b>
              <span className="muted xs">
                {x.path} · {timeAgo(x.deleted)}
              </span>
            </div>
            <button
              className="btn sm"
              onClick={async () => {
                const r = await api.restore(x.id);
                await st.refreshTree();
                load();
                st.toast(t("Restaurada en {p}", { p: r.path }), "ok");
              }}
            >
              <ArrowCounterClockwise size={14} /> {t("Restaurar")}
            </button>
          </div>
        ))}
      </div>
      {!!list?.length && (
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm(t("¿Borrar para siempre todo lo que hay en la papelera? No se puede deshacer."))) return;
            await api.emptyTrash();
            load();
          }}
        >
          <Trash size={15} /> {t("Vaciar la papelera")}
        </button>
      )}
    </div>
  );
}

export function TagView({ tag }: { tag: string }) {
  const st = useStore();
  const [hits, setHits] = useState<any[]>([]);
  useEffect(() => {
    api.search("#" + tag, 200).then(setHits);
  }, [tag, st.tree]);
  return (
    <div className="plain-view">
      <h1>
        <Hash size={26} /> {tag}
      </h1>
      <p className="muted">{t("{n} páginas con esta etiqueta", { n: hits.length })}</p>
      <div className="list">
        {hits.map((h) => (
          <button key={h.path} className="list-row" onClick={() => st.go({ kind: "page", path: h.path })}>
            <FileText size={16} />
            <div className="list-main">
              <b>{h.title}</b>
              <span className="muted xs">{h.snippet}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A folder that is not a database: its pages and files as a list, with a button to turn it into one. */
type FolderItem = { path: string; name: string; kind: "folder" | "page" | "file"; mtime: number; size: number; count: number };
type FolderViewCfg = {
  layout?: "list" | "grid";
  sort?: "name" | "mtime" | "kind" | "manual";
  dir?: 1 | -1;
  order?: string[];
  /** An HTML page the folder shows instead of only its files. */
  html?: string;
};

function htmlFiles(tree: TreeNode[], folder: string): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.kind === "file" && /\.html?$/i.test(n.path) && (!folder || n.path.startsWith(folder + "/"))) out.push(n.path);
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return out.sort();
}

const KIND_RANK = { folder: 0, page: 1, file: 2 } as const;

function sortItems(items: FolderItem[], v: FolderViewCfg): FolderItem[] {
  const dir = v.dir ?? 1;
  const by = v.sort ?? "name";
  const name = (a: FolderItem, b: FolderItem) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  if (by === "manual") {
    const pos = new Map((v.order ?? []).map((p, i) => [p, i]));
    // Items not placed by hand yet go at the end, by name.
    return [...items].sort((a, b) => (pos.get(a.path) ?? 1e9) - (pos.get(b.path) ?? 1e9) || name(a, b));
  }
  return [...items].sort((a, b) => {
    if (by === "mtime") return dir * (a.mtime - b.mtime) || name(a, b);
    if (by === "kind") return dir * (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || name(a, b);
    return KIND_RANK[a.kind] === 0 && KIND_RANK[b.kind] !== 0 ? -1 : KIND_RANK[b.kind] === 0 && KIND_RANK[a.kind] !== 0 ? 1 : dir * name(a, b);
  });
}

export function FolderView({ path }: { path: string }) {
  const st = useStore();
  const [data, setData] = useState<{ items: FolderItem[]; view: FolderViewCfg | null } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    api.folder(path).then(setData).catch((e) => st.toast(e.message, "error"));
  }, [path, st.tree]);
  const view: FolderViewCfg = data?.view ?? {};
  const save = (v: FolderViewCfg) => {
    setData((d) => (d ? { ...d, view: v } : d));
    api.folderView(path, v).catch((e) => st.toast(e.message, "error"));
  };
  const items = data ? sortItems(data.items, view) : [];
  const html = view.html && st.names.has(view.html.toLowerCase()) ? view.html : null;
  const [tab, setTab] = useState<"page" | "files">("page");
  useEffect(() => setTab("page"), [path]);
  const showHtml = !!html && tab === "page";
  const pickHtml = (el: HTMLElement) => {
    const files = htmlFiles(st.tree, path);
    const items: MenuItem[] = [{ title: t("Página HTML de la carpeta") }];
    for (const f of files.slice(0, 30))
      items.push({ label: f.slice(path.length + 1), icon: FileHtml, run: () => (save({ ...view, html: f }), setTab("page")) });
    if (!files.length) items.push({ label: t("No hay archivos HTML en esta carpeta"), disabled: true, run: () => {} });
    items.push({ sep: true }, {
      label: t("Nuevo artefacto HTML"),
      icon: Plus,
      run: async () => {
        try {
          const r = await api.createFile(path, stem(path), "html");
          save({ ...view, html: r.path });
          await st.refreshTree();
          setTab("page");
        } catch (e: any) {
          st.toast(e.message, "error");
        }
      },
    });
    if (html) items.push({ label: t("Quitar la página HTML"), icon: X, danger: true, run: () => save({ ...view, html: undefined }) });
    openMenuAt(el, items);
  };
  const layout = view.layout ?? "list";
  const sort = view.sort ?? "name";
  const dropOnItem = (target: string) => {
    if (!drag || drag === target) return;
    const order = items.map((i) => i.path).filter((p) => p !== drag);
    order.splice(order.indexOf(target), 0, drag);
    save({ ...view, sort: "manual", order });
  };
  const icon = (n: FolderItem, size: number) =>
    n.kind === "folder" ? <Folder size={size} /> : n.kind === "page" ? <FileText size={size} /> : <FileIcon path={n.path} size={size} />;
  const meta = (n: FolderItem) =>
    n.kind === "folder" ? t(n.count === 1 ? "{n} elemento" : "{n} elementos", { n: n.count }) : timeAgo(n.mtime);
  return (
    <div className={`plain-view folder-view ${showHtml ? "with-html" : ""}`}>
      <h1>{stem(path)}</h1>
      <div className="row-gap folder-bar">
        {html && (
          <div className="seg">
            <button className={tab === "page" ? "on" : ""} onClick={() => setTab("page")}>
              <FileHtml size={15} /> {t("Página")}
            </button>
            <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
              <Folder size={15} /> {t("Archivos")}
            </button>
          </div>
        )}
        <button className="btn sm" title={t("Elegí un archivo HTML para que la carpeta lo muestre")} onClick={(e) => pickHtml(e.currentTarget)}>
          <FileHtml size={14} /> {html ? t("Cambiar página HTML") : t("Página HTML")}
        </button>
        {showHtml && (
          <button className="btn sm" onClick={() => st.go({ kind: "file", path: html! })}>
            <PencilSimple size={14} /> {t("Editar")}
          </button>
        )}
        {showHtml && <div className="push" />}
        {!showHtml && <>
        <button className="btn sm" onClick={() => st.newPage(path)}>
          <Plus size={14} /> {t("Nueva página")}
        </button>
        <button
          className="btn sm"
          onClick={async () => {
            await api.databaseView(path, { layout: "table" });
            st.refreshTree();
          }}
        >
          <Table size={14} /> {t("Ver como base de datos")}
        </button>
        <div className="push" />
        <label className="folder-sort">
          <span className="muted xs">{t("Ordenar")}</span>
          <select className="input sm" value={sort} onChange={(e) => save({ ...view, sort: e.target.value as FolderViewCfg["sort"] })}>
            <option value="name">{t("Nombre")}</option>
            <option value="mtime">{t("Última edición")}</option>
            <option value="kind">{t("Tipo")}</option>
            <option value="manual">{t("A mano (arrastrar)")}</option>
          </select>
        </label>
        {sort !== "manual" && (
          <button
            className="btn-icon sm"
            title={(view.dir ?? 1) === 1 ? t("Ascendente") : t("Descendente")}
            onClick={() => save({ ...view, dir: (view.dir ?? 1) === 1 ? -1 : 1 })}
          >
            {(view.dir ?? 1) === 1 ? <SortAscending size={16} /> : <SortDescending size={16} />}
          </button>
        )}
        <div className="seg">
          <button className={layout === "list" ? "on" : ""} title={t("Lista")} onClick={() => save({ ...view, layout: "list" })}>
            <ListBullets size={15} />
          </button>
          <button className={layout === "grid" ? "on" : ""} title={t("Cuadrícula")} onClick={() => save({ ...view, layout: "grid" })}>
            <SquaresFour size={15} />
          </button>
        </div>
        </>}
      </div>
      {showHtml && (
        <div className="folder-html">
          <Suspense fallback={<div className="pv-loading" />}>
            <ArtifactFrame path={html!} />
          </Suspense>
        </div>
      )}
      {!showHtml && sort === "manual" && <p className="muted xs">{t("Arrastrá los elementos para ordenarlos.")}</p>}
      {!showHtml && <div className={layout === "grid" ? "folder-grid" : "list"}>
        {items.map((n) => (
          <button
            key={n.path}
            className={`${layout === "grid" ? "folder-card" : "list-row"} ${over === n.path && drag && drag !== n.path ? "drop-before" : ""} ${drag === n.path ? "dragging" : ""}`}
            draggable
            onDragStart={(e) => {
              setDrag(n.path);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("application/x-ob-order", n.path);
            }}
            onDragEnd={() => (setDrag(null), setOver(null))}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              setOver(n.path);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropOnItem(n.path);
              setDrag(null);
              setOver(null);
            }}
            onClick={() => st.openPath(n.path, n.kind)}
          >
            {layout === "grid" ? (
              <>
                <span className="folder-card-icon">{icon(n, 26)}</span>
                <b>{n.name}</b>
                <span className="muted xs">{meta(n)}</span>
              </>
            ) : (
              <>
                {icon(n, 16)}
                <div className="list-main">
                  <b>{n.name}</b>
                </div>
                <span className="muted xs">{meta(n)}</span>
              </>
            )}
          </button>
        ))}
        {data && !items.length && <p className="muted">{t("Vacía")}</p>}
      </div>}
    </div>
  );
}
