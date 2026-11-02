import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  Info,
  Lightbulb,
  NotePencil,
  Question,
  Quotes,
  Warning,
  WarningOctagon,
  CornersOut,
  ArrowRight,
} from "@phosphor-icons/react";
import { api, baseName, dirOf, fileUrl, isAudio, isImage, isVideo, stem } from "../lib/api";
import { useStore } from "../lib/store";
import { renderMd } from "../lib/render";
import { t } from "../lib/i18n";
import { FileIcon } from "../components/FileIcon";
import { CALLOUT_KINDS } from "./extensions";

const resolved = new Map<string, string | null>();

/** Finds the vault path an embed points to (Obsidian rules, then relative to the page). */
async function resolveSrc(src: string, pageFolder: string): Promise<string | null> {
  const key = pageFolder + "|" + src;
  if (resolved.has(key)) return resolved.get(key)!;
  let s = src;
  try {
    s = decodeURIComponent(src);
  } catch {}
  let r = (await api.resolve(s).catch(() => ({ path: null }))).path;
  if (!r && pageFolder) r = (await api.resolve(`${pageFolder}/${s}`).catch(() => ({ path: null }))).path;
  resolved.set(key, r);
  return r;
}

export function clearResolved() {
  resolved.clear();
}

function currentFolder() {
  const r = useStore.getState().route;
  return r.kind === "page" ? dirOf(r.path) : "";
}

export function EmbedView({ node, selected }: NodeViewProps) {
  const src: string = node.attrs.src;
  const external = /^https?:\/\//i.test(src);
  const [path, setPath] = useState<string | null | undefined>(external ? src : undefined);
  const [page, setPage] = useState<string | null>(null);
  const tree = useStore((s) => s.tree);
  const openPanel = (p: string) => useStore.getState().setPanel({ kind: "preview", path: p });

  useEffect(() => {
    if (external) return;
    let live = true;
    clearResolved();
    resolveSrc(src, currentFolder()).then((p) => live && setPath(p));
    return () => {
      live = false;
    };
  }, [src, tree, external]);

  const isPage = !!path && /\.(md|markdown)$/i.test(path);
  useEffect(() => {
    if (!isPage || !path) return;
    api.page(path).then((p) => setPage(p.body)).catch(() => setPage(null));
  }, [isPage, path]);

  const url = external ? src : path ? fileUrl(path) : "";
  let body;
  if (path === undefined) body = <div className="embed-card loading">…</div>;
  else if (path === null)
    body = (
      <div className="embed-card missing" contentEditable={false}>
        <FileIcon path={src} size={22} />
        <div className="embed-meta">
          <b>{baseName(src)}</b>
          <span>{t("No está en el vault")}</span>
        </div>
      </div>
    );
  else if (isImage(path))
    body = (
      <figure className="embed-image" onDoubleClick={() => !external && openPanel(path)}>
        <img src={url} alt={node.attrs.alt || baseName(path)} loading="lazy" draggable={false} />
        {node.attrs.alt && !/^\d+$/.test(node.attrs.alt) && <figcaption>{node.attrs.alt}</figcaption>}
      </figure>
    );
  else if (isVideo(path)) body = <video className="embed-media" src={url} controls preload="metadata" />;
  else if (isAudio(path)) body = <audio className="embed-audio" src={url} controls preload="metadata" />;
  else if (isPage)
    body = (
      <div className="embed-page" contentEditable={false}>
        <div className="embed-page-head">
          <span>{stem(path)}</span>
          <button className="btn-icon sm" onClick={() => useStore.getState().go({ kind: "page", path })} title={t("Abrir")}>
            <ArrowRight size={14} />
          </button>
        </div>
        <div className="prose small" dangerouslySetInnerHTML={{ __html: renderMd(page ?? "") }} />
      </div>
    );
  else
    body = (
      <div className="embed-card" contentEditable={false} onClick={() => openPanel(path)}>
        <FileIcon path={path} size={26} />
        <div className="embed-meta">
          <b>{baseName(path)}</b>
          <span>{(path.split(".").pop() ?? "").toUpperCase()} · {t("Tocá para ver")}</span>
        </div>
        <div className="embed-actions">
          <button
            className="btn-icon sm"
            title={t("Ventana flotante")}
            onClick={(e) => {
              e.stopPropagation();
              useStore.setState({ floating: path });
            }}
          >
            <CornersOut size={15} />
          </button>
          <button
            className="btn-icon sm"
            title={t("Abrir con la app del sistema")}
            onClick={(e) => {
              e.stopPropagation();
              api.open(path);
            }}
          >
            <ArrowSquareOut size={15} />
          </button>
        </div>
      </div>
    );
  return (
    <NodeViewWrapper className={`ob-embed ${selected ? "is-selected" : ""}`} data-drag-handle>
      {body}
    </NodeViewWrapper>
  );
}

const CALLOUT_ICON: Record<string, any> = {
  note: NotePencil,
  tip: Lightbulb,
  info: Info,
  success: CheckCircle,
  question: Question,
  warning: Warning,
  danger: WarningOctagon,
  quote: Quotes,
};

export const CALLOUT_LABEL: Record<string, string> = {
  note: "Nota",
  tip: "Consejo",
  info: "Info",
  success: "Listo",
  question: "Pregunta",
  warning: "Atención",
  danger: "Peligro",
  quote: "Cita",
};

export function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const kind = (CALLOUT_KINDS as readonly string[]).includes(node.attrs.kind) ? node.attrs.kind : "note";
  const I = CALLOUT_ICON[kind] ?? NotePencil;
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as any) && setMenu(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menu]);
  return (
    <NodeViewWrapper className={`callout callout-${kind}`}>
      <div className="callout-head" contentEditable={false} ref={ref}>
        <button className="callout-icon" onClick={() => editor.isEditable && setMenu(!menu)} title={t("Cambiar tipo")}>
          <I size={18} weight="duotone" />
        </button>
        <input
          className="callout-title-input"
          value={node.attrs.title}
          placeholder={t(CALLOUT_LABEL[kind])}
          onChange={(e) => updateAttributes({ title: e.target.value })}
          readOnly={!editor.isEditable}
        />
        {menu && (
          <div className="menu callout-menu">
            {CALLOUT_KINDS.map((k) => {
              const KI = CALLOUT_ICON[k];
              return (
                <button
                  key={k}
                  className={`menu-item callout-${k}`}
                  onClick={() => {
                    updateAttributes({ kind: k });
                    setMenu(false);
                  }}
                >
                  <KI size={16} weight="duotone" className="callout-tint" />
                  {t(CALLOUT_LABEL[k])}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <NodeViewContent className="callout-body" />
    </NodeViewWrapper>
  );
}
