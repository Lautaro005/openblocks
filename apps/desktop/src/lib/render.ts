// Read-only Markdown rendering for the chat, previews, history and embedded pages. Raw HTML is
// escaped and links are handled by the app (never by the webview).
import { Marked } from "marked";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const m = new Marked({ gfm: true, breaks: true });
m.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.indexOf("[["),
      tokenizer(src: string) {
        const r = /^!?\[\[([^\]\n]+?)\]\]/.exec(src);
        if (r) return { type: "wikilink", raw: r[0], target: r[1] } as any;
      },
      renderer(tk: any) {
        const [target, alias] = tk.target.split("|");
        const label = (alias || target).split("/").pop().replace(/\.md$/i, "");
        return `<a class="ob-link" data-target="${esc(target.trim())}">${esc(label)}</a>`;
      },
    },
    {
      name: "highlight",
      level: "inline",
      start: (src: string) => src.indexOf("=="),
      tokenizer(src: string) {
        const r = /^==([^=\n](?:[^\n]*?[^=\n])?)==/.exec(src);
        if (r) return { type: "highlight", raw: r[0], tokens: this.lexer.inlineTokens(r[1]) } as any;
      },
      renderer(tk: any) {
        return `<mark>${this.parser.parseInline(tk.tokens)}</mark>`;
      },
    },
  ],
  renderer: {
    html(tk: any) {
      return esc(tk.text ?? tk.raw ?? "");
    },
    link(tk: any) {
      const href = String(tk.href ?? "");
      const safe = /^(https?:|mailto:)/i.test(href) ? href : "#";
      return `<a href="${esc(safe)}" data-href="${esc(href)}">${this.parser.parseInline(tk.tokens)}</a>`;
    },
    image(tk: any) {
      const href = String(tk.href ?? "");
      if (/^https?:/i.test(href)) return `<img src="${esc(href)}" alt="${esc(tk.text ?? "")}">`;
      return `<span class="ob-embed-ref">🖼 ${esc(tk.text || href)}</span>`;
    },
    blockquote(tk: any) {
      const text: string = tk.text ?? "";
      const c = /^\[!([a-zA-Z-]+)\][+-]?[ \t]*([^\n]*)\n?([\s\S]*)$/.exec(text.trim());
      if (c) {
        return `<div class="callout callout-${esc(c[1].toLowerCase())}"><div class="callout-title">${esc(c[2] || c[1])}</div><div class="callout-body">${m.parse(c[3] ?? "")}</div></div>`;
      }
      return `<blockquote>${this.parser.parse(tk.tokens)}</blockquote>`;
    },
    checkbox(tk: any) {
      return `<input type="checkbox" disabled ${tk.checked ? "checked" : ""}> `;
    },
  },
});

export function renderMd(md: string): string {
  return m.parse(md ?? "", { async: false }) as string;
}
