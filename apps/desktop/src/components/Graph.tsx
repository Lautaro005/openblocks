import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass, Crosshair, ArrowsOut, Plus, Minus } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { t } from "../lib/i18n";

type N = { id: string; title: string; ghost?: boolean; folder?: string; x: number; y: number; vx: number; vy: number; deg: number };

/** A force-directed graph of the vault on a canvas (own simulation, no libraries). */
export function GraphView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [q, setQ] = useState("");
  const [ghosts, setGhosts] = useState(false);
  const [local, setLocal] = useState(false);
  const [stats, setStats] = useState({ n: 0, e: 0 });
  const st = useStore();
  const back = st.back[st.back.length - 1];
  const focus = back?.kind === "page" ? back.path : null;
  const state = useRef<{ nodes: N[]; edges: [N, N][]; cam: { x: number; y: number; k: number }; hover: N | null; drag: N | null; alpha: number }>({
    nodes: [],
    edges: [],
    cam: { x: 0, y: 0, k: 1 },
    hover: null,
    drag: null,
    alpha: 1,
  });
  const qRef = useRef(q);
  qRef.current = q;
  const [zoom, setZoom] = useState(1);

  /** Zooms by `f` keeping the point (x, y), relative to the canvas center, still. */
  const zoomAt = (f: number, x = 0, y = 0) => {
    const cam = state.current.cam;
    const k = Math.max(0.1, Math.min(5, cam.k * f));
    const g = k / cam.k;
    cam.x = x - (x - cam.x) * g;
    cam.y = y - (y - cam.y) * g;
    cam.k = k;
    setZoom(k);
  };

  useEffect(() => {
    api.graph().then((g) => {
      let nodes: N[] = g.nodes
        .filter((n: any) => ghosts || !n.ghost)
        .map((n: any) => ({ ...n, x: (Math.random() - 0.5) * 600, y: (Math.random() - 0.5) * 600, vx: 0, vy: 0, deg: 0 }));
      const byId = new Map(nodes.map((n) => [n.id, n]));
      let edges = g.edges.map(([a, b]) => [byId.get(a), byId.get(b)]).filter(([a, b]) => a && b) as [N, N][];
      if (local && focus && byId.has(focus)) {
        const keep = new Set<string>([focus]);
        for (const [a, b] of edges) {
          if (a.id === focus) keep.add(b.id);
          if (b.id === focus) keep.add(a.id);
        }
        nodes = nodes.filter((n) => keep.has(n.id));
        edges = edges.filter(([a, b]) => keep.has(a.id) && keep.has(b.id));
      }
      for (const [a, b] of edges) {
        a.deg++;
        b.deg++;
      }
      const s = state.current;
      s.nodes = nodes;
      s.edges = edges;
      s.alpha = 1;
      setStats({ n: nodes.length, e: edges.length });
    });
  }, [ghosts, local, focus, st.tree]);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();
    const resize = () => {
      const r = c.parentElement!.getBoundingClientRect();
      c.width = r.width * devicePixelRatio;
      c.height = r.height * devicePixelRatio;
      c.style.width = r.width + "px";
      c.style.height = r.height + "px";
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c.parentElement!);

    const tick = () => {
      const s = state.current;
      const { nodes, edges } = s;
      if (s.alpha > 0.005) {
        const n = nodes.length;
        const rep = 1800;
        // Repulsion (sampled when the vault is large).
        const step = n > 900 ? Math.ceil(n / 900) : 1;
        for (let i = 0; i < n; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < n; j += step) {
            const b = nodes[j];
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let d2 = dx * dx + dy * dy || 0.01;
            if (d2 > 250000) continue;
            const f = (rep * step) / d2;
            dx *= f;
            dy *= f;
            a.vx += dx * s.alpha;
            a.vy += dy * s.alpha;
            b.vx -= dx * s.alpha;
            b.vy -= dy * s.alpha;
          }
        }
        for (const [a, b] of edges) {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = ((d - 70) / d) * 0.04 * s.alpha;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
        for (const p of nodes) {
          p.vx -= p.x * 0.004 * s.alpha;
          p.vy -= p.y * 0.004 * s.alpha;
          if (p !== s.drag) {
            p.x += Math.max(-30, Math.min(30, p.vx));
            p.y += Math.max(-30, Math.min(30, p.vy));
          }
          p.vx *= 0.6;
          p.vy *= 0.6;
        }
        s.alpha *= 0.985;
      }
      // Draw.
      const W = c.width;
      const H = c.height;
      const k = s.cam.k * devicePixelRatio;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(k, 0, 0, k, W / 2 + s.cam.x * devicePixelRatio, H / 2 + s.cam.y * devicePixelRatio);
      const query = qRef.current.toLowerCase();
      const hv = s.hover;
      const near = new Set<N>();
      if (hv) {
        near.add(hv);
        for (const [a, b] of edges) {
          if (a === hv) near.add(b);
          if (b === hv) near.add(a);
        }
      }
      ctx.lineWidth = 1 / s.cam.k;
      for (const [a, b] of edges) {
        const lit = hv && (a === hv || b === hv);
        ctx.strokeStyle = lit ? col("--ink") : col("--graph-edge");
        ctx.globalAlpha = hv && !lit ? 0.25 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const p of nodes) {
        const r = 3.5 + Math.sqrt(p.deg) * 1.8;
        const match = query && p.title.toLowerCase().includes(query);
        const dim = (hv && !near.has(p)) || (query && !match);
        ctx.globalAlpha = dim ? 0.22 : 1;
        ctx.fillStyle = p.ghost ? col("--graph-ghost") : p.id === focus ? col("--accent") : match || p === hv ? col("--ink") : col("--graph-node");
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (s.cam.k > 0.75 || near.has(p) || match || p.deg > 4) {
          ctx.fillStyle = col("--ink-2");
          ctx.font = `${12 / Math.max(1, s.cam.k * 0.9)}px "Source Sans 3", sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(p.title, p.x, p.y + r + 12 / Math.max(1, s.cam.k * 0.9));
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const world = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      const s = state.current;
      return { x: (e.clientX - r.left - r.width / 2 - s.cam.x) / s.cam.k, y: (e.clientY - r.top - r.height / 2 - s.cam.y) / s.cam.k };
    };
    const pick = (e: MouseEvent) => {
      const w = world(e);
      let best: N | null = null;
      let bd = 144 / state.current.cam.k;
      for (const p of state.current.nodes) {
        const d = (p.x - w.x) ** 2 + (p.y - w.y) ** 2;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best;
    };
    let pan: { x: number; y: number; cx: number; cy: number } | null = null;
    let moved = false;
    const down = (e: MouseEvent) => {
      moved = false;
      const p = pick(e);
      if (p) state.current.drag = p;
      else pan = { x: e.clientX, y: e.clientY, cx: state.current.cam.x, cy: state.current.cam.y };
    };
    const move = (e: MouseEvent) => {
      const s = state.current;
      if (s.drag) {
        const w = world(e);
        s.drag.x = w.x;
        s.drag.y = w.y;
        s.alpha = Math.max(s.alpha, 0.3);
        moved = true;
      } else if (pan) {
        s.cam.x = pan.cx + e.clientX - pan.x;
        s.cam.y = pan.cy + e.clientY - pan.y;
        moved = true;
      } else {
        s.hover = pick(e);
        c.style.cursor = s.hover ? "pointer" : "grab";
      }
    };
    const up = () => {
      const s = state.current;
      if (s.drag && !moved && !s.drag.ghost) useStore.getState().go({ kind: "page", path: s.drag.id });
      s.drag = null;
      pan = null;
    };
    // The wheel and pinch (ctrl + wheel) zoom toward the pointer in proportion to how far they
    // moved, so a trackpad's many small steps and a mouse's few big ones feel the same. Sideways
    // scrolling pans.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = state.current;
      const r = c.getBoundingClientRect();
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      const dy = e.deltaY * px;
      const dx = e.deltaX * px;
      if (!e.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
        s.cam.x -= dx;
        return;
      }
      const speed = e.ctrlKey ? 0.008 : 0.0012;
      zoomAt(Math.exp(-Math.max(-120, Math.min(120, dy)) * speed), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    c.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    c.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      c.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      c.removeEventListener("wheel", wheel);
    };
  }, []);

  return (
    <div className="graph">
      <div className="graph-bar">
        <div className="db-search">
          <MagnifyingGlass size={14} />
          <input placeholder={t("Resaltar páginas…")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {focus && (
          <button className={`pill ${local ? "on" : ""}`} onClick={() => setLocal(!local)}>
            <Crosshair size={14} /> {t("Solo alrededor de la página")}
          </button>
        )}
        <button className={`pill ${ghosts ? "on" : ""}`} onClick={() => setGhosts(!ghosts)}>
          {t("Mostrar enlaces sin página")}
        </button>
        <div className="zoom-ctl">
          <button className="btn-icon sm" title={t("Alejar")} onClick={() => zoomAt(1 / 1.25)}>
            <Minus size={14} />
          </button>
          <button className="zoom-val" title={t("Volver al 100%")} onClick={() => zoomAt(1 / state.current.cam.k)}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="btn-icon sm" title={t("Acercar")} onClick={() => zoomAt(1.25)}>
            <Plus size={14} />
          </button>
        </div>
        <button
          className="btn-icon"
          title={t("Centrar")}
          onClick={() => {
            state.current.cam = { x: 0, y: 0, k: 1 };
            setZoom(1);
          }}
        >
          <ArrowsOut size={16} />
        </button>
        <span className="muted xs push-left">{t("{n} páginas · {e} enlaces", { n: stats.n, e: stats.e })}</span>
      </div>
      <div className="graph-canvas">
        <canvas ref={canvas} />
        {stats.n === 0 && <div className="graph-empty">{t("Enlazá páginas con [[ ]] y aparecen acá.")}</div>}
      </div>
    </div>
  );
}
