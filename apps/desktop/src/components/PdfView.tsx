// The PDF viewer: pdf.js draws each page on a canvas (only the pages near the screen), with a text
// layer on top so text can be selected and copied. The system's PDF viewer can't be used: the
// webview shows nothing for a sandboxed PDF, and Linux has none.
import { useEffect, useRef, useState } from "react";
import { MagnifyingGlassMinus, MagnifyingGlassPlus, ArrowsHorizontal, CaretUp, CaretDown } from "@phosphor-icons/react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { t } from "../lib/i18n";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Doc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function PdfView({ url }: { url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [err, setErr] = useState("");
  // null = fit the width of the panel.
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");

  useEffect(() => {
    setDoc(null);
    setErr("");
    setSizes([]);
    const base = new URL("/pdfjs/", location.href).href;
    const task = pdfjs.getDocument({
      url,
      cMapUrl: base + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      wasmUrl: base + "wasm/",
      iccUrl: base + "iccs/",
    });
    let live = true;
    task.promise
      .then(async (d) => {
        // Page sizes first, so the scroll height is right before any page is drawn.
        const s: { w: number; h: number }[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const p = await d.getPage(i);
          const v = p.getViewport({ scale: 1 });
          s.push({ w: v.width, h: v.height });
        }
        if (!live) return;
        setSizes(s);
        setDoc(d);
      })
      .catch((e) => live && setErr(e?.message || String(e)));
    return () => {
      live = false;
      task.destroy();
    };
  }, [url]);

  // Fit width follows the panel's size.
  useEffect(() => {
    const el = box.current;
    if (!el || !sizes.length) return;
    const widest = Math.max(...sizes.map((s) => s.w));
    const fit = () => setFitScale(Math.max(0.2, (el.clientWidth - 40) / widest));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sizes]);

  const scale = zoom ?? fitScale;

  // Zoom keeping the same spot of the document in view.
  const setScale = (next: number | null) => {
    const el = box.current;
    const before = scale;
    const after = next ?? fitScale;
    if (el) {
      const ratio = after / before;
      const mid = el.scrollTop + el.clientHeight / 2;
      setZoom(next);
      requestAnimationFrame(() => (el.scrollTop = mid * ratio - el.clientHeight / 2));
    } else setZoom(next);
  };
  const stepZoom = (dir: 1 | -1) => {
    const cur = scale;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.01) ?? ZOOMS[ZOOMS.length - 1] : [...ZOOMS].reverse().find((z) => z < cur - 0.01) ?? ZOOMS[0];
    setScale(next);
  };

  // Pinch or ctrl + wheel zooms, in proportion to how far it moved.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.max(0.25, Math.min(5, (z ?? fitScale) * Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.01))));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [fitScale]);

  // The page in the middle of the view.
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    const pages = el.querySelectorAll<HTMLElement>(".pdf-page");
    let n = 1;
    pages.forEach((p, i) => {
      if (p.offsetTop <= mid) n = i + 1;
    });
    if (n !== page) {
      setPage(n);
      setPageInput(String(n));
    }
  };

  const goTo = (n: number) => {
    const el = box.current;
    const p = el?.querySelectorAll<HTMLElement>(".pdf-page")[n - 1];
    if (el && p) el.scrollTop = p.offsetTop - 12;
  };

  if (err) return <div className="pv-empty">{t("No pude abrir este PDF.")} <span className="muted xs">{err}</span></div>;
  return (
    <div className="pdf">
      <div className="pdf-bar">
        <div className="pdf-pages">
          <button className="btn-icon sm" disabled={page <= 1} onClick={() => goTo(page - 1)} title={t("Página anterior")}>
            <CaretUp size={14} />
          </button>
          <button className="btn-icon sm" disabled={page >= sizes.length} onClick={() => goTo(page + 1)} title={t("Página siguiente")}>
            <CaretDown size={14} />
          </button>
          <input
            className="pdf-page-input"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const n = Math.max(1, Math.min(sizes.length, Number(pageInput) || 1));
                goTo(n);
                setPageInput(String(n));
              }
            }}
            onBlur={() => setPageInput(String(page))}
          />
          <span className="muted xs">/ {sizes.length || "…"}</span>
        </div>
        <div className="push" />
        <div className="zoom-ctl">
          <button className="btn-icon sm" title={t("Alejar")} onClick={() => stepZoom(-1)}>
            <MagnifyingGlassMinus size={14} />
          </button>
          <button className="zoom-val" title={t("Volver al 100%")} onClick={() => setScale(1)}>
            {Math.round(scale * 100)}%
          </button>
          <button className="btn-icon sm" title={t("Acercar")} onClick={() => stepZoom(1)}>
            <MagnifyingGlassPlus size={14} />
          </button>
        </div>
        <button className={`btn-icon sm ${zoom == null ? "on" : ""}`} title={t("Ajustar al ancho")} onClick={() => setScale(null)}>
          <ArrowsHorizontal size={15} />
        </button>
      </div>
      <div className="pdf-scroll" ref={box} onScroll={onScroll}>
        {!doc && <div className="pv-loading" />}
        {doc &&
          sizes.map((s, i) => <PdfPage key={i} doc={doc} n={i + 1} width={s.w * scale} height={s.h * scale} scale={scale} root={box} />)}
      </div>
    </div>
  );
}

function PdfPage({ doc, n, width, height, scale, root }: { doc: Doc; n: number; width: number; height: number; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  // Only pages close to the screen are drawn.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    let layer: { cancel: () => void } | null = null;
    // A short wait so zooming with the wheel doesn't draw every step.
    const timer = window.setTimeout(async () => {
      const p = await doc.getPage(n);
      if (cancelled || !canvas.current || !text.current) return;
      const vp = p.getViewport({ scale });
      const ratio = Math.min(3, window.devicePixelRatio || 1);
      const c = canvas.current;
      c.width = Math.floor(vp.width * ratio);
      c.height = Math.floor(vp.height * ratio);
      const r = p.render({ canvas: c, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      task = r;
      await r.promise.catch(() => {});
      if (cancelled) return;
      const tl = text.current;
      tl.replaceChildren();
      tl.style.setProperty("--scale-factor", String(scale));
      tl.style.setProperty("--total-scale-factor", String(scale));
      const content = await p.getTextContent();
      if (cancelled) return;
      const l = new pdfjs.TextLayer({ textContentSource: content, container: tl, viewport: vp });
      layer = l;
      await l.render().catch(() => {});
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
      layer?.cancel();
    };
  }, [near, doc, n, scale]);

  return (
    <div className="pdf-page" ref={wrap} style={{ width, height }}>
      <canvas ref={canvas} style={{ width, height }} />
      <div className="pdf-text textLayer" ref={text} />
    </div>
  );
}
