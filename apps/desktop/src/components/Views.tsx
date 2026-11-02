import { useEffect, useState } from "react";
import { Plus, CalendarDots, Sparkle, Graph, ArrowCounterClockwise, Trash, FileText, Hash, Folder, MagnifyingGlass, Table } from "@phosphor-icons/react";
import { api, stem } from "../lib/api";
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
export function FolderView({ path }: { path: string }) {
  const st = useStore();
  const find = (nodes: any[]): any => {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.children) {
        const f = find(n.children);
        if (f) return f;
      }
    }
  };
  const node = find(st.tree);
  return (
    <div className="plain-view">
      <h1>{stem(path)}</h1>
      <div className="row-gap">
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
      </div>
      <div className="list">
        {(node?.children ?? []).map((n: any) => (
          <button key={n.path} className="list-row" onClick={() => st.openPath(n.path, n.kind)}>
            {n.kind === "folder" ? <Folder size={16} /> : n.kind === "page" ? <FileText size={16} /> : <FileIcon path={n.path} size={16} />}
            <div className="list-main">
              <b>{n.name}</b>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
