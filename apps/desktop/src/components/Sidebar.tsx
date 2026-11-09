import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  MagnifyingGlass,
  Sparkle,
  CalendarDots,
  Graph,
  Trash,
  GearSix,
  Plus,
  FolderSimplePlus,
  CaretRight,
  CaretUpDown,
  Star,
  SidebarSimple,
  House,
  FolderSimple,
  FolderOpen,
  FileText,
  PencilSimple,
  ArrowSquareOut,
  Table,
  StarFour,
  FileHtml,
  Check,
  FolderOpen as FolderNotchOpen,
} from "@phosphor-icons/react";
import { api, dirOf, stem, type TreeNode } from "../lib/api";
import { mod, setSidebar, setSidebarWidth, useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { FileIcon } from "./FileIcon";
import { openMenu, openMenuAt, type MenuItem } from "./Menu";
import { Logo } from "./Logo";

/** While the sidebar is hidden: a thin strip on the left edge that shows it floating over the page. */
export function SidebarPeek() {
  const peek = useStore((s) => s.peek);
  const timer = useRef<number | undefined>(undefined);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => useStore.setState({ peek: true }), 80);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // Keep it while a menu or a rename from the sidebar is open.
      if (document.querySelector(".menu.context") || useStore.getState().renaming) return hide();
      useStore.setState({ peek: false });
    }, 300);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <div className="side-peek-zone" onMouseEnter={show} onMouseLeave={() => !peek && window.clearTimeout(timer.current)} />
      {peek && (
        <div className="side-peek" onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={hide}>
          <Sidebar floating />
        </div>
      )}
    </>
  );
}

function Resizer() {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = useStore.getState().sideWidth;
    document.body.classList.add("resizing-side");
    const move = (ev: PointerEvent) => setSidebarWidth(w0 + ev.clientX - x0, false);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-side");
      setSidebarWidth(useStore.getState().sideWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className="side-resize"
      onPointerDown={start}
      onDoubleClick={() => setSidebarWidth(264)}
      role="separator"
      aria-orientation="vertical"
      title={t("Arrastrá para cambiar el ancho · doble clic para volver al original")}
    />
  );
}

export function Sidebar({ floating = false }: { floating?: boolean }) {
  const st = useStore();
  const vault = st.status?.vault;
  const [over, setOver] = useState<string | null>(null);

  const vaultMenu = async (el: HTMLElement) => {
    const list = await api.vaults().catch(() => []);
    const items: MenuItem[] = [{ title: t("Vaults") }];
    for (const v of list.filter((x) => x.exists).slice(0, 8)) {
      items.push({
        label: v.name,
        icon: v.path === vault?.path ? Check : FolderSimple,
        hint: v.path.replace(/^\/Users\/[^/]+/, "~"),
        run: async () => {
          await api.openVault(v.path);
          location.reload();
        },
      });
    }
    items.push({ sep: true });
    items.push({
      label: t("Abrir otra carpeta…"),
      icon: FolderNotchOpen,
      run: async () => {
        const r = await api.pickFolder();
        if (r.path) {
          await api.openVault(r.path, undefined, false);
          location.reload();
        }
      },
    });
    items.push({ label: t("Mostrar en el sistema"), icon: ArrowSquareOut, run: () => api.open("", true) });
    items.push({ label: t("Ajustes del vault"), icon: GearSix, run: () => useStore.setState({ settingsTab: "vault" }) });
    openMenuAt(el, items);
  };

  const dropOn = async (e: DragEvent, folder: string) => {
    e.preventDefault();
    setOver(null);
    const from = e.dataTransfer.getData("application/x-ob-path");
    if (from) {
      const name = from.split("/").pop()!;
      const to = folder ? `${folder}/${name}` : name;
      if (to === from || folder.startsWith(from + "/") || folder === from) return;
      try {
        const r = await api.move(from, to);
        await st.refreshTree();
        const route = useStore.getState().route;
        if (route.kind === "page" && route.path === from) st.go({ kind: "page", path: r.path }, { replace: true });
        if (r.fixed) st.toast(t("Movida. Se actualizaron los enlaces en {n} páginas.", { n: r.fixed }), "ok");
      } catch (err: any) {
        st.toast(err.message, "error");
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      try {
        if (/\.(md|markdown)$/i.test(f.name)) {
          const text = await f.text();
          await api.createPage(folder, f.name.replace(/\.(md|markdown)$/i, ""), text);
        } else {
          await api.upload(folder, f);
        }
      } catch (err: any) {
        st.toast(err.message, "error");
      }
    }
    if (files.length) {
      st.refreshTree();
      st.toast(t("{n} archivos agregados", { n: files.length }), "ok");
    }
  };

  const route = st.route;
  return (
    <aside className={`sidebar ${floating ? "floating" : ""}`} onDragOver={(e) => e.preventDefault()}>
      {!floating && <Resizer />}
      <div className="drag-strip" data-tauri-drag-region />
      <div className="side-top">
        <button className="vault-btn" onClick={(e) => vaultMenu(e.currentTarget)}>
          <Logo size={22} />
          <span className="vault-name">{vault?.name ?? "OpenBlocks"}</span>
          <CaretUpDown size={13} className="muted" />
        </button>
        <button
          className="btn-icon"
          onClick={() => setSidebar(floating)}
          title={floating ? t("Fijar la barra lateral") + ` (${mod}\\)` : t("Ocultar la barra lateral") + ` (${mod}\\)`}
        >
          <SidebarSimple size={18} />
        </button>
      </div>
      <nav className="side-actions">
        <SideItem icon={MagnifyingGlass} label={t("Buscar")} kbd={`${mod}K`} onClick={() => useStore.setState({ palette: "all" })} />
        <SideItem icon={Sparkle} label={t("Preguntarle a la IA")} kbd={`${mod}J`} active={st.panel?.kind === "ai"} onClick={() => st.togglePanel("ai")} />
        <SideItem icon={House} label={t("Inicio")} active={route.kind === "home"} onClick={() => st.go({ kind: "home" })} />
        <SideItem icon={CalendarDots} label={t("Nota del día")} kbd={`${mod}D`} onClick={() => st.daily()} />
        <SideItem icon={Graph} label={t("Grafo")} active={route.kind === "graph"} onClick={() => st.go({ kind: "graph" })} />
      </nav>

      <div className="side-scroll">
        {st.favorites.length > 0 && (
          <section className="side-section">
            <div className="side-head">
              <span>{t("Favoritos")}</span>
            </div>
            {st.favorites.map((f) => (
              <button
                key={f}
                className={`tree-row ${route.kind === "page" && route.path === f ? "active" : ""}`}
                style={{ paddingLeft: 10 }}
                onClick={() => st.openPath(f)}
              >
                <Star size={14} weight="fill" className="star" />
                <span className="tree-name">{stem(f)}</span>
              </button>
            ))}
          </section>
        )}
        <section
          className={`side-section tree-root ${over === "" ? "drop" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver("");
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => dropOn(e, "")}
        >
          <div className="side-head">
            <span>{t("Páginas")}</span>
            <div className="side-head-actions">
              <button
                className="btn-icon xs"
                title={t("Nuevo artefacto o planilla")}
                onClick={(e) =>
                  openMenuAt(e.currentTarget, [
                    { label: t("Nueva carpeta"), icon: FolderSimplePlus, run: () => newFolder("") },
                    { label: t("Nuevo artefacto HTML"), icon: FileHtml, run: () => st.newFile("", "html") },
                    { label: t("Nueva planilla"), icon: Table, run: () => st.newFile("", "xlsx") },
                  ])
                }
              >
                <FolderSimplePlus size={15} />
              </button>
              <button className="btn-icon xs" title={t("Nueva página") + ` (${mod}N)`} onClick={() => st.newPage("")}>
                <Plus size={15} />
              </button>
            </div>
          </div>
          {st.tree.length === 0 && (
            <button className="tree-empty" onClick={() => st.newPage("")}>
              <Plus size={14} /> {t("Crear la primera página")}
            </button>
          )}
          <Tree nodes={st.tree} depth={0} over={over} setOver={setOver} dropOn={dropOn} />
        </section>
      </div>

      <div className="side-foot">
        <SideItem icon={Trash} label={t("Papelera")} active={route.kind === "trash"} onClick={() => st.go({ kind: "trash" })} />
        <SideItem icon={GearSix} label={t("Ajustes")} kbd={`${mod},`} onClick={() => useStore.setState({ settingsTab: "general" })} />
      </div>
    </aside>
  );
}

function SideItem({ icon: I, label, kbd, onClick, active }: { icon: any; label: string; kbd?: string; onClick: () => void; active?: boolean }) {
  return (
    <button className={`side-item ${active ? "active" : ""}`} onClick={onClick}>
      <I size={17} />
      <span>{label}</span>
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

async function newFolder(parent: string) {
  const st = useStore.getState();
  try {
    const r = await api.createFolder((parent ? parent + "/" : "") + t("Nueva carpeta"));
    await st.refreshTree();
    useStore.setState({ renaming: r.path });
  } catch (e: any) {
    st.toast(e.message, "error");
  }
}

function Tree({
  nodes,
  depth,
  over,
  setOver,
  dropOn,
}: {
  nodes: TreeNode[];
  depth: number;
  over: string | null;
  setOver: (s: string | null) => void;
  dropOn: (e: DragEvent, folder: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => (
        <TreeItem key={n.path} n={n} siblings={nodes} depth={depth} over={over} setOver={setOver} dropOn={dropOn} />
      ))}
    </>
  );
}

function TreeItem({ n, siblings, depth, over, setOver, dropOn }: { n: TreeNode; siblings: TreeNode[]; depth: number; over: string | null; setOver: (s: string | null) => void; dropOn: (e: DragEvent, folder: string) => void }) {
  const st = useStore();
  const collapsed = st.collapsed.includes(n.path);
  const isDb = st.databases.includes(n.path);
  const route = st.route;
  const active =
    (route.kind === "page" && route.path === n.path) ||
    (route.kind === "folder" && route.path === n.path) ||
    (st.panel?.kind === "preview" && st.panel.path === n.path);
  const renaming = st.renaming === n.path;

  const toggle = () => {
    const next = collapsed ? st.collapsed.filter((c) => c !== n.path) : [...st.collapsed, n.path];
    useStore.setState({ collapsed: next });
    api.collapsed(next);
  };

  const rename = async (name: string) => {
    useStore.setState({ renaming: null });
    const clean = name.trim();
    if (!clean || clean === n.name) return;
    const dir = dirOf(n.path);
    try {
      const r = await api.move(n.path, (dir ? dir + "/" : "") + clean);
      await st.refreshTree();
      if (route.kind === "page" && route.path === n.path) st.go({ kind: "page", path: r.path }, { replace: true });
      if (r.fixed) st.toast(t("Renombrada. Se actualizaron los enlaces en {n} páginas.", { n: r.fixed }), "ok");
    } catch (e: any) {
      st.toast(e.message, "error");
    }
  };

  // A folder opens its own page when there is one with the same name, inside it or next to it (how
  // Notion pages with subpages come in); otherwise its folder view.
  const open = () => {
    if (n.kind !== "folder") return st.openPath(n.path, n.kind);
    const same = (c: TreeNode) => c.kind === "page" && c.name.toLowerCase() === n.name.toLowerCase();
    const own = n.children?.find(same) ?? siblings.find(same);
    if (own && !isDb) st.openPath(own.path, "page");
    else st.go({ kind: "folder", path: n.path });
  };

  const menu = (e: React.MouseEvent) => {
    const fav = st.favorites.includes(n.path);
    const items: MenuItem[] = [{ label: t("Abrir"), icon: ArrowSquareOut, run: open }];
    if (n.kind === "folder") items.push({ label: collapsed ? t("Desplegar") : t("Plegar"), icon: CaretRight, run: toggle });
    items.push({ sep: true });
    if (n.kind === "folder") {
      items.push({ label: t("Nueva página"), icon: Plus, run: () => st.newPage(n.path) });
      items.push({ label: t("Nueva carpeta"), icon: FolderSimplePlus, run: () => newFolder(n.path) });
      items.push({ label: t("Nuevo artefacto HTML"), icon: FileHtml, run: () => st.newFile(n.path, "html") });
      items.push({ label: t("Nueva planilla"), icon: Table, run: () => st.newFile(n.path, "xlsx") });
      items.push({
        label: isDb ? t("Ver como carpeta") : t("Ver como base de datos"),
        icon: Table,
        run: async () => {
          await api.databaseView(n.path, { layout: "table" }, isDb);
          await st.refreshTree();
          if (!isDb) st.go({ kind: "folder", path: n.path });
        },
      });
      items.push({ sep: true });
    }
    if (n.kind === "page")
      items.push({
        label: fav ? t("Quitar de favoritos") : t("Agregar a favoritos"),
        icon: fav ? StarFour : Star,
        run: async () => {
          await api.favorite(n.path, !fav);
          st.refreshTree();
        },
      });
    if (n.kind === "page") items.push({ label: t("Preguntarle a la IA sobre esta página"), icon: Sparkle, run: () => (st.go({ kind: "page", path: n.path }), st.askAI("")) });
    items.push({ label: t("Renombrar"), icon: PencilSimple, run: () => useStore.setState({ renaming: n.path }) });
    items.push({ label: t("Mostrar en el sistema"), icon: ArrowSquareOut, run: () => api.open(n.path, true) });
    if (n.kind === "file") items.push({ label: t("Abrir con la app del sistema"), icon: ArrowSquareOut, run: () => api.open(n.path) });
    items.push({ sep: true });
    items.push({
      label: t("Mover a la papelera"),
      icon: Trash,
      danger: true,
      run: async () => {
        await api.trash(n.path);
        await st.refreshTree();
        if (active) st.go({ kind: "home" }, { replace: true });
        st.toast(t("«{n}» está en la papelera.", { n: n.name }), "info", {
          label: t("Deshacer"),
          run: async () => {
            const list = await api.trashList();
            const it = list.find((x) => x.path === n.path);
            if (it) {
              await api.restore(it.id);
              st.refreshTree();
            }
          },
        });
      },
    });
    openMenu(e, items);
  };

  const pad = 8 + depth * 14;
  const Icon = n.kind === "folder" ? (isDb ? Table : collapsed ? FolderSimple : FolderOpen) : null;
  return (
    <>
      <div
        className={`tree-row ${active ? "active" : ""} ${over === n.path ? "drop" : ""} kind-${n.kind}`}
        style={{ paddingLeft: pad }}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-ob-path", n.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (n.kind !== "folder") return;
          e.preventDefault();
          e.stopPropagation();
          setOver(n.path);
        }}
        onDragLeave={() => over === n.path && setOver(null)}
        onDrop={(e) => {
          if (n.kind !== "folder") return;
          e.stopPropagation();
          dropOn(e, n.path);
        }}
        onClick={() => {
          if (renaming) return;
          // The row expands or collapses a folder; its name opens it.
          if (n.kind === "folder") toggle();
          else open();
        }}
        onContextMenu={menu}
        role="treeitem"
        aria-expanded={n.kind === "folder" ? !collapsed : undefined}
      >
        {n.kind === "folder" ? (
          <span
            className={`caret ${collapsed ? "" : "open"}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            <CaretRight size={11} weight="bold" />
          </span>
        ) : (
          <span className="caret-space" />
        )}
        <span className="tree-icon">{Icon ? <Icon size={15} weight={isDb ? "duotone" : "regular"} /> : n.kind === "page" ? <FileText size={15} /> : <FileIcon path={n.path} size={15} />}</span>
        {renaming ? (
          <input
            className="tree-rename"
            autoFocus
            defaultValue={n.name}
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") useStore.setState({ renaming: null });
            }}
          />
        ) : (
          <span
            className={`tree-name ${n.kind === "folder" ? "openable" : ""}`}
            onClick={(e) => {
              if (n.kind !== "folder" || renaming) return;
              e.stopPropagation();
              open();
            }}
          >
            {n.name}
          </span>
        )}
        <span className="tree-actions">
          {n.kind === "folder" && (
            <button
              className="btn-icon xs"
              title={t("Nueva página")}
              onClick={(e) => {
                e.stopPropagation();
                st.newPage(n.path);
              }}
            >
              <Plus size={13} />
            </button>
          )}
        </span>
      </div>
      {n.kind === "folder" && !collapsed && n.children && (
        <div className="tree-children">
          <Tree nodes={n.children} depth={depth + 1} over={over} setOver={setOver} dropOn={dropOn} />
          {n.children.length === 0 && (
            <div className="tree-hint" style={{ paddingLeft: pad + 30 }}>
              {t("Vacía")}
            </div>
          )}
        </div>
      )}
    </>
  );
}
