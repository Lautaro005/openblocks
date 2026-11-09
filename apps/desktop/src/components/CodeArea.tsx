// A code editor for an artifact's HTML: a textarea over a highlighted copy of the same text, with
// line numbers. Tab indents, Shift+Tab unindents, Enter keeps the indentation, ⌘S / Ctrl+S saves.
import { useLayoutEffect, useMemo, useRef } from "react";
import { createLowlight } from "lowlight";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";

const low = createLowlight({ xml, css, javascript, json });
low.registerAlias({ xml: ["html", "svg"], javascript: ["js", "mjs"] });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toHtml(node: any): string {
  if (node.type === "text") return esc(node.value);
  const inner = (node.children ?? []).map(toHtml).join("");
  if (node.type === "element") {
    const cls = (node.properties?.className ?? []).join(" ");
    return cls ? `<span class="${cls}">${inner}</span>` : inner;
  }
  return inner;
}

export function highlight(code: string, lang: string) {
  try {
    return toHtml(low.highlight(lang, code));
  } catch {
    return esc(code);
  }
}

export function CodeArea({ value, onChange, lang = "xml", onSave }: { value: string; onChange: (v: string) => void; lang?: string; onSave?: () => void }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  // A trailing newline needs a space after it to be drawn, so both layers stay the same height.
  const html = useMemo(() => highlight(value, lang) + "\n ", [value, lang]);
  const lines = useMemo(() => value.split("\n").length, [value]);

  const sync = () => {
    const t = ta.current;
    if (!t) return;
    if (pre.current) {
      pre.current.scrollTop = t.scrollTop;
      pre.current.scrollLeft = t.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = t.scrollTop;
  };
  useLayoutEffect(sync, [html]);

  // Edits through execCommand keep the textarea's own undo history.
  const insert = (text: string, from: number, to: number) => {
    const t = ta.current!;
    t.focus();
    t.setSelectionRange(from, to);
    if (!document.execCommand("insertText", false, text)) {
      const v = t.value.slice(0, from) + text + t.value.slice(to);
      onChange(v);
      requestAnimationFrame(() => t.setSelectionRange(from + text.length, from + text.length));
    }
  };

  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value: v } = t;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const start = v.lastIndexOf("\n", a - 1) + 1;
      if (!e.shiftKey && a === b) return insert("  ", a, b);
      // Indent or unindent every selected line.
      const end = b;
      const block = v.slice(start, end);
      const out = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
      insert(out, start, end);
      requestAnimationFrame(() => t.setSelectionRange(start, start + out.length));
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const start = v.lastIndexOf("\n", a - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(start, a))?.[0] ?? "";
      const opens = /<[a-zA-Z][^>/]*>$|[{[(]$/.test(v.slice(start, a).trimEnd());
      insert("\n" + indent + (opens ? "  " : ""), a, b);
    }
  };

  return (
    <div className="code-area">
      <div className="code-gutter" ref={gutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
        <div> </div>
      </div>
      <div className="code-layers">
        <pre className="code-hl hljs" ref={pre} aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          ref={ta}
          className="code-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={key}
        />
      </div>
    </div>
  );
}
