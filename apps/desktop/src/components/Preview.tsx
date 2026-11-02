import { useEffect, useRef, useState } from "react";
import { X, ArrowSquareOut, CornersOut, CornersIn, DownloadSimple, FolderOpen, MagnifyingGlassPlus, MagnifyingGlassMinus } from "@phosphor-icons/react";
import { api, baseName, extOf, fileUrl, humanSize, isAudio, isImage, isVideo } from "../lib/api";
import { useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { renderMd } from "../lib/render";
import { FileIcon } from "./FileIcon";

const TEXT = /\.(txt|log|json|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|css|scss|html|xml|yaml|yml|toml|ini|sh|sql|rb|php|swift|kt)$/i;
const OFFICE = /\.(docx|xlsx|xlsm|xls|ods|pptx|csv|tsv)$/i;

function Body({ path }: { path: string }) {
  const [data, setData] = useState<any>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [sheet, setSheet] = useState(0);
  const [zoom, setZoom] = useState(1);
  const url = fileUrl(path);
  useEffect(() => {
    setData(null);
    setText(null);
    setErr("");
    setSheet(0);
    setZoom(1);
    if (OFFICE.test(path)) api.preview(path).then(setData).catch((e) => setErr(e.message));
    else if (TEXT.test(path) || /\.(md|markdown)$/i.test(path))
      fetch(url)
        .then((r) => r.text())
        .then(setText)
        .catch((e) => setErr(e.message));
  }, [path, url]);

  if (err) return <div className="pv-empty">{err}</div>;
  if (isImage(path))
    return (
      <div className="pv-image">
        <div className="pv-zoom">
          <button className="btn-icon sm" onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}>
            <MagnifyingGlassMinus size={15} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="btn-icon sm" onClick={() => setZoom(Math.min(4, zoom + 0.25))}>
            <MagnifyingGlassPlus size={15} />
          </button>
        </div>
        <img src={url} alt="" style={{ width: `${zoom * 100}%` }} />
      </div>
    );
  if (extOf(path) === "pdf") return <iframe className="pv-pdf" src={url} title={baseName(path)} />;
  if (isVideo(path)) return <video className="pv-media" src={url} controls />;
  if (isAudio(path))
    return (
      <div className="pv-audio">
        <FileIcon path={path} size={48} />
        <audio src={url} controls />
      </div>
    );
  if (/\.(md|markdown)$/i.test(path)) return text == null ? <Loading /> : <div className="prose pv-doc" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />;
  if (TEXT.test(path)) return text == null ? <Loading /> : <pre className="pv-text">{text}</pre>;
  if (OFFICE.test(path)) {
    if (!data) return <Loading />;
    if (data.kind === "doc")
      return (
        <div className="pv-docx">
          {data.blocks.map((b: any, i: number) => {
            if (b.kind === "table")
              return (
                <table key={i} className="pv-table">
                  <tbody>
                    {b.rows.map((r: string[], j: number) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            const content = (b.runs?.length ? b.runs : [{ text: b.text }]).map((r: any, k: number) => (
              <span key={k} style={{ fontWeight: r.b ? 700 : undefined, fontStyle: r.i ? "italic" : undefined }}>
                {r.text}
              </span>
            ));
            if (b.kind === "h1") return <h1 key={i}>{content}</h1>;
            if (b.kind === "h2") return <h2 key={i}>{content}</h2>;
            if (b.kind === "h3") return <h3 key={i}>{content}</h3>;
            if (b.kind === "li") return <li key={i}>{content}</li>;
            return <p key={i}>{b.text.trim() ? content : " "}</p>;
          })}
        </div>
      );
    if (data.kind === "sheets" || data.kind === "table") {
      const sheets = data.kind === "table" ? [{ name: baseName(path), rows: data.rows }] : data.sheets;
      const s = sheets[sheet] ?? { rows: [] };
      const cols = Math.max(0, ...s.rows.map((r: string[]) => r.length));
      const letter = (n: number) => {
        let o = "";
        n++;
        while (n > 0) {
          const m = (n - 1) % 26;
          o = String.fromCharCode(65 + m) + o;
          n = Math.floor((n - 1) / 26);
        }
        return o;
      };
      return (
        <div className="pv-sheet">
          <div className="pv-grid">
            <table>
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: cols }, (_, i) => (
                    <th key={i}>{letter(i)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r: string[], i: number) => (
                  <tr key={i}>
                    <th>{i + 1}</th>
                    {Array.from({ length: cols }, (_, k) => (
                      <td key={k} className={/^-?[\d.,]+%?$/.test(r[k] ?? "") ? "num" : ""}>
                        {r[k] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sheets.length > 1 && (
            <div className="pv-tabs">
              {sheets.map((x: any, i: number) => (
                <button key={i} className={i === sheet ? "on" : ""} onClick={() => setSheet(i)}>
                  {x.name}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }
    if (data.kind === "slides")
      return (
        <div className="pv-slides">
          {data.slides.map((s: any, i: number) => (
            <div key={i} className="slide">
              <span className="slide-n">{i + 1}</span>
              <h3>{s.title}</h3>
              <ul>
                {s.lines.slice(0, 12).map((l: string, k: number) => (
                  <li key={k}>{l}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
  }
  return (
    <div className="pv-empty">
      <FileIcon path={path} size={56} />
      <p>{t("No hay vista previa para este tipo de archivo.")}</p>
      <button className="btn" onClick={() => api.open(path)}>
        <ArrowSquareOut size={15} /> {t("Abrir con la app del sistema")}
      </button>
    </div>
  );
}

function Loading() {
  return <div className="pv-loading" />;
}

function Head({ path, floating, onClose }: { path: string; floating: boolean; onClose: () => void }) {
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    fetch(fileUrl(path), { method: "HEAD" })
      .then((r) => setSize(Number(r.headers.get("content-length") ?? 0) || null))
      .catch(() => {});
  }, [path]);
  return (
    <header className="panel-head pv-head">
      <FileIcon path={path} size={18} />
      <div className="pv-title">
        <b title={path}>{baseName(path)}</b>
        <span>
          {extOf(path).toUpperCase()}
          {size ? ` · ${humanSize(size)}` : ""}
        </span>
      </div>
      <div className="push" />
      <button
        className="btn-icon"
        title={floating ? t("Volver al costado") : t("Ventana flotante")}
        onClick={() => {
          if (floating) useStore.setState({ floating: null, panel: { kind: "preview", path } });
          else useStore.setState({ floating: path, panel: null });
        }}
      >
        {floating ? <CornersIn size={16} /> : <CornersOut size={16} />}
      </button>
      <a className="btn-icon" title={t("Descargar")} href={fileUrl(path, true)} download>
        <DownloadSimple size={16} />
      </a>
      <button className="btn-icon" title={t("Mostrar en el sistema")} onClick={() => api.open(path, true)}>
        <FolderOpen size={16} />
      </button>
      <button className="btn-icon" title={t("Abrir con la app del sistema")} onClick={() => api.open(path)}>
        <ArrowSquareOut size={16} />
      </button>
      <button className="btn-icon" title={t("Cerrar")} onClick={onClose}>
        <X size={16} />
      </button>
    </header>
  );
}

export function PreviewPanel({ path }: { path: string }) {
  return (
    <aside className="preview-panel">
      <Head path={path} floating={false} onClose={() => useStore.getState().setPanel(null)} />
      <div className="pv-body">
        <Body path={path} />
      </div>
    </aside>
  );
}

export function FloatingPreview({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: Math.max(40, window.innerWidth - 720), y: 80 });
  const drag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,a")) return;
    const sx = e.clientX - pos.x;
    const sy = e.clientY - pos.y;
    const mv = (ev: MouseEvent) => setPos({ x: Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - sx)), y: Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - sy)) });
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  };
  return (
    <div className="float-win" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <div onMouseDown={drag} className="float-drag">
        <Head path={path} floating onClose={() => useStore.setState({ floating: null })} />
      </div>
      <div className="pv-body">
        <Body path={path} />
      </div>
    </div>
  );
}
