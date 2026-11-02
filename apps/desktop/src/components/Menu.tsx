import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

export type MenuItem =
  | { label: string; icon?: any; run: () => void; danger?: boolean; hint?: string; disabled?: boolean }
  | { sep: true }
  | { title: string };

type M = { open: boolean; x: number; y: number; items: MenuItem[] };
export const useMenu = create<M>(() => ({ open: false, x: 0, y: 0, items: [] }));

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  useMenu.setState({ open: true, x: e.clientX, y: e.clientY, items });
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  useMenu.setState({ open: true, x: r.left, y: r.bottom + 4, items });
}

export function ContextMenu() {
  const m = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!m.open || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    setPos({ x: Math.min(m.x, window.innerWidth - w - 8), y: Math.min(m.y, window.innerHeight - h - 8) });
  }, [m.open, m.x, m.y]);
  useEffect(() => {
    if (!m.open) return;
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      useMenu.setState({ open: false });
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && useMenu.setState({ open: false });
    setTimeout(() => {
      document.addEventListener("mousedown", close);
      window.addEventListener("blur", close);
      document.addEventListener("keydown", key);
    });
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("keydown", key);
    };
  }, [m.open]);
  if (!m.open) return null;
  return (
    <div className="menu context" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {m.items.map((it, i) => {
        if ("sep" in it) return <div key={i} className="menu-sep" />;
        if ("title" in it) return <div key={i} className="menu-label">{it.title}</div>;
        const I = it.icon;
        return (
          <button
            key={i}
            className={`menu-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              useMenu.setState({ open: false });
              it.run();
            }}
          >
            {I && <I size={15} />}
            <span>{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
