// Settings → Appearance: palette, accent color, fonts, text size, line spacing and the window's zoom.
// Everything is CSS variables and data attributes on <html>, so it applies at once.
import { api } from "./api";

export type Appearance = {
  palette: "warm" | "neutral" | "sepia" | "contrast";
  accent: string;
  textFont: "sans" | "system" | "serif" | "mono" | "custom";
  customFont: string;
  headingFont: "rounded" | "same" | "serif" | "system";
  uiFont: "sans" | "system";
  textSize: number;
  lineHeight: "compact" | "normal" | "relaxed";
  zoom: number;
};

export const DEFAULT_APPEARANCE: Appearance = {
  palette: "warm",
  accent: "",
  textFont: "sans",
  customFont: "",
  headingFont: "rounded",
  uiFont: "sans",
  textSize: 16.5,
  lineHeight: "normal",
  zoom: 1,
};

export const ACCENTS: [string, string][] = [
  ["", "Naranja"],
  ["#2563eb", "Azul"],
  ["#0f8a6c", "Verde"],
  ["#7c3aed", "Violeta"],
  ["#db2777", "Rosa"],
  ["#b45309", "Ámbar"],
  ["#475569", "Pizarra"],
];

const STACKS = {
  sans: `"Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
  system: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif`,
  serif: `"Iowan Old Style", "Charter", "Georgia", "Cambria", "Times New Roman", serif`,
  mono: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`,
  rounded: `"Nunito", "Source Sans 3", system-ui, sans-serif`,
};

export function appearanceOf(settings: any): Appearance {
  return { ...DEFAULT_APPEARANCE, ...(settings?.appearance ?? {}) };
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A lighter accent for dark mode, so it reads on a dark background. */
function lighten([r, g, b]: [number, number, number], t: number): [number, number, number] {
  return [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t].map(Math.round) as [number, number, number];
}

let lastZoom = 1;

export function applyAppearance(settings: any) {
  const a = appearanceOf(settings);
  const root = document.documentElement;
  const css = root.style;
  root.dataset.palette = a.palette;

  const rgb = hexToRgb(a.accent);
  if (rgb) {
    const dark = lighten(rgb, 0.3);
    css.setProperty("--accent-light", `rgb(${rgb.join(",")})`);
    css.setProperty("--accent-dark", `rgb(${dark.join(",")})`);
    css.setProperty("--accent-soft-light", `rgba(${rgb.join(",")}, 0.1)`);
    css.setProperty("--accent-soft-dark", `rgba(${dark.join(",")}, 0.16)`);
    root.dataset.accent = "custom";
  } else {
    for (const k of ["--accent-light", "--accent-dark", "--accent-soft-light", "--accent-soft-dark"]) css.removeProperty(k);
    delete root.dataset.accent;
  }

  const safe = a.customFont.replace(/["\\;{}<>]/g, "").trim();
  const text = a.textFont === "custom" && safe ? `"${safe}", ${STACKS.sans}` : STACKS[a.textFont === "custom" ? "sans" : a.textFont];
  const ui = STACKS[a.uiFont];
  const heading = a.headingFont === "same" ? text : a.headingFont === "rounded" ? STACKS.rounded : STACKS[a.headingFont];
  css.setProperty("--text-font", text);
  css.setProperty("--font", ui);
  css.setProperty("--display", heading);
  css.setProperty("--text-size", `${Math.max(12, Math.min(26, Number(a.textSize) || 16.5))}px`);
  css.setProperty("--text-lh", a.lineHeight === "compact" ? "1.5" : a.lineHeight === "relaxed" ? "1.9" : "1.7");

  const z = Math.max(0.5, Math.min(2, Number(a.zoom) || 1));
  if (z !== lastZoom || z !== 1) setZoom(z);
}

/** The window's zoom: the desktop app zooms natively; in a browser the page scales with CSS. */
export async function setZoom(z: number) {
  lastZoom = z;
  const r = await api.zoom(z).catch(() => ({ native: false }));
  document.documentElement.style.setProperty("zoom", r.native ? "" : z === 1 ? "" : String(z));
}

export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function nextZoom(z: number, dir: 1 | -1) {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0];
}
