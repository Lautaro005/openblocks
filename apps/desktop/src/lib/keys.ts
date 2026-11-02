// Keyboard shortcuts the user can change. A combo is written like "Mod+." — Mod is ⌘ on macOS and
// Ctrl on Windows and Linux — so the same setting works on every system.

import { isMac } from "./store";

export const DEFAULT_AI_KEY = "Mod+.";

const CODES: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
};

/** The key part of an event, from the physical key so ⌥ on a Mac doesn't change it. */
function keyOf(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (CODES[e.code]) return CODES[e.code];
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/** The combo for a key press, or null while only modifiers are down. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // A shortcut needs at least one modifier, or typing would trigger it.
  if (!parts.length) return null;
  parts.push(keyOf(e));
  return parts.join("+");
}

export function matchCombo(e: KeyboardEvent, combo: string): boolean {
  return comboFromEvent(e) === (combo || DEFAULT_AI_KEY);
}

export function showCombo(combo: string): string {
  const names: Record<string, string> = isMac
    ? { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }
    : { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
  const parts = (combo || DEFAULT_AI_KEY).split("+");
  // "Mod++" (the + key) splits into an empty last part.
  const key = combo.endsWith("++") ? "+" : parts.pop()!;
  const mods = parts.filter(Boolean).map((p) => names[p] ?? p);
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...mods, k].join(isMac ? " " : " + ");
}
