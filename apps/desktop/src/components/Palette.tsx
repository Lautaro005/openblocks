import { useEffect, useMemo, useRef, useState } from "react";
import {
  MagnifyingGlass,
  FileText,
  Plus,
  CalendarDots,
  Graph,
  GearSix,
  Sparkle,
  Trash,
  Moon,
  Sun,
  FolderSimplePlus,
  House,
  SidebarSimple,
  ArrowRight,
} from "@phosphor-icons/react";
import { api, dirOf, type Hit } from "../lib/api";
import { mod, setSidebar, useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { FileIcon } from "./FileIcon";

type Item = { id: string; title: string; sub?: string; icon: any; kbd?: string; run: () => void; snippet?: string; file?: string };

export function Palette() {
  const st = useStore();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [i, setI] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ palette: null });

  useEffect(() => {
    let live = true;
    const h = setTimeout(async () => {
      const r = q.trim().length >= 2 ? await api.search(q, 30).catch(() => []) : await api.titles(q, 12).catch(() => []);
      if (live) {
        setHits(r);
        setI(0);
      }
    }, 60);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [q]);

  const commands: Item[] = useMemo(
    () => [
      { id: "new", title: t("Nueva página"), icon: Plus, kbd: `${mod}N`, run: () => st.newPage("", q && !hits.length ? q : undefined) },
      { id: "daily", title: t("Nota del día"), icon: CalendarDots, kbd: `${mod}D`, run: () => st.daily() },
      { id: "ai", title: q ? t("Preguntarle a la IA: «{q}»", { q }) : t("Preguntarle a la IA"), icon: Sparkle, kbd: `${mod}J`, run: () => st.askAI(q) },
      { id: "folder", title: t("Nueva carpeta"), icon: FolderSimplePlus, run: async () => {
        const r = await api.createFolder(t("Nueva carpeta"));
        await st.refreshTree();
        useStore.setState({ renaming: r.path });
      } },
      { id: "home", title: t("Ir al inicio"), icon: House, run: () => st.go({ kind: "home" }) },
      { id: "graph", title: t("Abrir el grafo"), icon: Graph, kbd: `${mod}G`, run: () => st.go({ kind: "graph" }) },
      { id: "trash", title: t("Papelera"), icon: Trash, run: () => st.go({ kind: "trash" }) },
      { id: "sidebar", title: t("Mostrar u ocultar la barra lateral"), icon: SidebarSimple, kbd: `${mod}\\`, run: () => setSidebar(!st.sidebar) },
      {
        id: "theme",
        title: document.documentElement.dataset.theme === "dark" ? t("Tema claro") : t("Tema oscuro"),
        icon: document.documentElement.dataset.theme === "dark" ? Sun : Moon,
        run: () => st.saveSettings({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }),
      },
      { id: "settings", title: t("Ajustes"), icon: GearSix, kbd: `${mod},`, run: () => useStore.setState({ settingsTab: "general" }) },
    ],
    [q, hits.length, st],
  );

  const items: Item[] = useMemo(() => {
    const pages: Item[] = hits.map((h) => ({
      id: h.path,
      title: h.title,
      sub: dirOf(h.path),
      icon: h.kind === "file" ? null : FileText,
      file: h.kind === "file" ? h.path : undefined,
      snippet: q.trim().length >= 2 ? h.snippet : undefined,
      run: () => st.openPath(h.path, h.kind),
    }));
    const qq = q.toLowerCase();
    const cmds = st.palette === "pages" ? [] : commands.filter((c) => !qq || c.title.toLowerCase().includes(qq) || c.id === "ai" || (c.id === "new" && !hits.length));
    return q ? [...pages, ...cmds] : [...cmds.slice(0, 4), ...pages, ...cmds.slice(4)];
  }, [hits, commands, q, st]);

  useEffect(() => {
    list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [i]);

  const run = (it: Item) => {
    close();
    it.run();
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <MagnifyingGlass size={18} />
          <input
            autoFocus
            placeholder={st.palette === "pages" ? t("Ir a una página…") : t("Buscar páginas y comandos…")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setI((i + 1) % Math.max(1, items.length)));
              if (e.key === "ArrowUp") (e.preventDefault(), setI((i - 1 + items.length) % Math.max(1, items.length)));
              if (e.key === "Enter" && items[i]) run(items[i]);
              if (e.key === "Escape") close();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={list}>
          {items.map((it, k) => {
            const I = it.icon;
            return (
              <button key={it.id + k} className={`palette-item ${k === i ? "sel" : ""}`} onMouseEnter={() => setI(k)} onClick={() => run(it)}>
                <span className="palette-icon">{I ? <I size={17} /> : <FileIcon path={it.file ?? ""} size={17} />}</span>
                <span className="palette-main">
                  <span className="palette-title">{it.title}</span>
                  {it.snippet && <span className="palette-snippet">{it.snippet}</span>}
                </span>
                {it.sub && <span className="palette-sub">{it.sub}</span>}
                {it.kbd && <kbd>{it.kbd}</kbd>}
                {k === i && <ArrowRight size={14} className="palette-go" />}
              </button>
            );
          })}
          {!items.length && <div className="palette-empty">{t("Nada coincide con «{q}»", { q })}</div>}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("moverse")}
          </span>
          <span>
            <kbd>↵</kbd> {t("abrir")}
          </span>
          <span>
            <kbd>#</kbd> {t("filtrar por etiqueta")}
          </span>
        </div>
      </div>
    </div>
  );
}
