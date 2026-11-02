// Markdown ⇄ editor. Pages are stored as Obsidian-flavored Markdown; the editor works on HTML
// it parses into its schema. Both directions are written here so round trips stay lossless for
// what the editor supports: headings, paragraphs, lists, tasks, quotes, callouts, toggles, code,
// tables, rules, embeds (![[file]]), images, [[wikilinks]] and inline marks.
import { marked, type Token, type Tokens } from "marked";

// ---------- Markdown → HTML ----------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

marked.use({
  gfm: true,
  breaks: true,
  extensions: [
    {
      name: "wikiembed",
      level: "inline",
      start: (src: string) => src.indexOf("![["),
      tokenizer(src: string) {
        const m = /^!\[\[([^\]\n]+?)\]\]/.exec(src);
        if (m) return { type: "wikiembed", raw: m[0], target: m[1] } as any;
      },
    },
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.indexOf("[["),
      tokenizer(src: string) {
        const m = /^\[\[([^\]\n]+?)\]\]/.exec(src);
        if (m) return { type: "wikilink", raw: m[0], target: m[1] } as any;
      },
    },
    {
      name: "highlight",
      level: "inline",
      start: (src: string) => src.indexOf("=="),
      tokenizer(src: string) {
        const m = /^==([^=\n](?:[^\n]*?[^=\n])?)==/.exec(src);
        if (m) return { type: "highlight", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) } as any;
      },
    },
  ],
});

function splitTarget(raw: string) {
  const [left, alias] = raw.split("|");
  return { target: left.trim(), alias: (alias ?? "").trim() };
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let o = "";
  for (const tk of tokens as any[]) {
    switch (tk.type) {
      case "text":
        o += tk.tokens ? inline(tk.tokens) : esc(tk.text).replace(/\n/g, "<br>");
        break;
      case "escape":
        o += esc(tk.text);
        break;
      case "strong":
        o += `<strong>${inline(tk.tokens)}</strong>`;
        break;
      case "em":
        o += `<em>${inline(tk.tokens)}</em>`;
        break;
      case "del":
        o += `<s>${inline(tk.tokens)}</s>`;
        break;
      case "codespan":
        o += `<code>${esc(tk.text)}</code>`;
        break;
      case "br":
        o += "<br>";
        break;
      case "link":
        o += `<a href="${esc(tk.href)}">${inline(tk.tokens)}</a>`;
        break;
      case "image":
        o += `<span data-type="embed" data-src="${esc(tk.href)}" data-alt="${esc(tk.text || "")}" data-md="1"></span>`;
        break;
      case "wikilink": {
        const { target, alias } = splitTarget(tk.target);
        o += `<span data-type="wikilink" data-target="${esc(target)}" data-alias="${esc(alias)}"></span>`;
        break;
      }
      case "wikiembed": {
        const { target, alias } = splitTarget(tk.target);
        o += `<span data-type="embed" data-src="${esc(target)}" data-alt="${esc(alias)}"></span>`;
        break;
      }
      case "highlight":
        o += `<mark>${inline(tk.tokens)}</mark>`;
        break;
      case "html":
        o += esc(tk.text);
        break;
      default:
        o += esc(tk.raw ?? tk.text ?? "");
    }
  }
  return o;
}

/** A paragraph that is only an embed becomes a block embed. */
function soloEmbed(tokens: any[] | undefined): string | null {
  const real = (tokens ?? []).filter((t) => !(t.type === "text" && !t.text.trim()) && t.type !== "br");
  if (real.length !== 1) return null;
  const t = real[0];
  if (t.type === "wikiembed") {
    const { target, alias } = splitTarget(t.target);
    return `<div data-type="embed" data-src="${esc(target)}" data-alt="${esc(alias)}"></div>`;
  }
  if (t.type === "image") return `<div data-type="embed" data-src="${esc(t.href)}" data-alt="${esc(t.text || "")}" data-md="1"></div>`;
  return null;
}

const CALLOUT = /^\[!([a-zA-Z-]+)\]([+-]?)[ \t]*([^\n]*)(?:\n([\s\S]*))?$/;

function listHtml(l: Tokens.List): string {
  const task = l.items.some((i) => i.task);
  if (task) {
    return `<ul data-type="taskList">${l.items
      .map((i) => `<li data-type="taskItem" data-checked="${i.checked ? "true" : "false"}">${itemBody(i)}</li>`)
      .join("")}</ul>`;
  }
  const tag = l.ordered ? "ol" : "ul";
  const start = l.ordered && l.start !== 1 && l.start !== "" ? ` start="${l.start}"` : "";
  return `<${tag}${start}>${l.items.map((i) => `<li>${itemBody(i)}</li>`).join("")}</${tag}>`;
}

function itemBody(i: Tokens.ListItem): string {
  let o = "";
  let para = false;
  for (const t of i.tokens as any[]) {
    if (t.type === "checkbox") continue;
    if (t.type === "text") {
      o += `<p>${inline(t.tokens ?? [{ type: "text", text: t.text }])}</p>`;
      para = true;
    } else {
      o += blocks([t]);
      if (t.type === "paragraph") para = true;
    }
  }
  return para ? o : `<p></p>${o}`;
}

function blocks(tokens: Token[]): string {
  let o = "";
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k] as any;
    switch (tk.type) {
      case "space":
        break;
      case "heading":
        o += `<h${Math.min(tk.depth, 3)}>${inline(tk.tokens)}</h${Math.min(tk.depth, 3)}>`;
        break;
      case "paragraph":
        o += soloEmbed(tk.tokens) ?? `<p>${inline(tk.tokens)}</p>`;
        break;
      case "text":
        o += `<p>${inline(tk.tokens ?? [{ type: "text", text: tk.text }])}</p>`;
        break;
      case "list":
        o += listHtml(tk);
        break;
      case "blockquote": {
        const m = CALLOUT.exec(tk.text.trim());
        if (m) {
          const kind = m[1].toLowerCase();
          const inner = marked.lexer(m[4] ?? "");
          o += `<div data-type="callout" data-kind="${esc(kind)}" data-title="${esc(m[3] ?? "")}" data-fold="${esc(m[2])}">${blocks(inner) || "<p></p>"}</div>`;
        } else {
          o += `<blockquote>${blocks(tk.tokens) || "<p></p>"}</blockquote>`;
        }
        break;
      }
      case "code":
        o += `<pre><code${tk.lang ? ` class="language-${esc(tk.lang)}"` : ""}>${esc(tk.text)}</code></pre>`;
        break;
      case "hr":
        o += "<hr>";
        break;
      case "table": {
        const head = `<tr>${tk.header.map((c: any) => `<th><p>${inline(c.tokens)}</p></th>`).join("")}</tr>`;
        const rows = tk.rows.map((r: any[]) => `<tr>${r.map((c) => `<td><p>${inline(c.tokens)}</p></td>`).join("")}</tr>`).join("");
        o += `<table><tbody>${head}${rows}</tbody></table>`;
        break;
      }
      case "html": {
        const raw: string = tk.raw;
        const open = /<details[^>]*>\s*(?:<summary>([\s\S]*?)<\/summary>)?([\s\S]*)/i.exec(raw);
        if (open) {
          // Collect everything up to </details>.
          let rest = open[2] ?? "";
          const inner: Token[] = [];
          let closed = /<\/details>/i.test(rest);
          rest = rest.replace(/<\/details>\s*$/i, "");
          if (rest.trim()) inner.push(...marked.lexer(rest));
          while (!closed && k + 1 < tokens.length) {
            k++;
            const nx = tokens[k] as any;
            if (nx.type === "html" && /<\/details>/i.test(nx.raw)) {
              const before = nx.raw.replace(/<\/details>[\s\S]*$/i, "");
              if (before.trim()) inner.push(...marked.lexer(before));
              closed = true;
              break;
            }
            inner.push(nx);
          }
          const summary = (open[1] ?? "").trim();
          o += `<details><summary>${esc(summary)}</summary><div data-type="detailsContent">${blocks(inner) || "<p></p>"}</div></details>`;
        } else if (/^<!--[\s\S]*-->\s*$/.test(raw.trim())) {
          o += `<p>${esc(raw.trim())}</p>`;
        } else {
          o += `<p>${esc(raw.trim()).replace(/\n/g, "<br>")}</p>`;
        }
        break;
      }
      default:
        if (tk.raw?.trim()) o += `<p>${esc(tk.raw.trim())}</p>`;
    }
  }
  return o;
}

// An empty task ("- [ ]" with nothing after it) is not a task for Markdown parsers, so it would
// come back as the text "[ ]". A zero-width marker keeps it a task while parsing, then goes away.
const EMPTY_TASK = /^(\s*(?:[-*+]|\d+[.)]) \[[ xX]\])[ \t]*$/gm;
const ZW = "\u200b";

export function mdToHtml(md: string): string {
  const src = (md ?? "").replace(EMPTY_TASK, `$1 ${ZW}`);
  const html = blocks(marked.lexer(src)).split(ZW).join("");
  return html || "<p></p>";
}

// ---------- editor JSON → Markdown ----------

type J = { type: string; attrs?: any; content?: J[]; text?: string; marks?: { type: string; attrs?: any }[] };

const ORDER = ["link", "bold", "italic", "strike", "highlight", "code"];
const OPEN: Record<string, (a: any) => string> = {
  bold: () => "**",
  italic: () => "*",
  strike: () => "~~",
  highlight: () => "==",
  code: () => "`",
  link: () => "[",
};
const CLOSE: Record<string, (a: any) => string> = {
  bold: () => "**",
  italic: () => "*",
  strike: () => "~~",
  highlight: () => "==",
  code: () => "`",
  link: (a) => `](${(a?.href ?? "").replace(/ /g, "%20").replace(/\)/g, "%29")})`,
};

function escText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/~~/g, "\\~\\~")
    .replace(/==/g, "\\=\\=")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/(^|[^\p{L}\p{N}])_/gu, "$1\\_")
    .replace(/_(?=$|[^\p{L}\p{N}])/gu, "\\_");
}

function inlineMd(nodes: J[] | undefined): string {
  if (!nodes) return "";
  let o = "";
  let open: { type: string; attrs?: any }[] = [];
  const closeAll = (keep: number) => {
    while (open.length > keep) {
      const m = open.pop()!;
      o += CLOSE[m.type]?.(m.attrs) ?? "";
    }
  };
  for (const n of nodes) {
    if (n.type !== "text") {
      closeAll(0);
      if (n.type === "hardBreak") o += "\n";
      else if (n.type === "wikilink") {
        const a = n.attrs ?? {};
        if (a.embed && a.md) o += `![${a.alias ?? ""}](${(a.target ?? "").replace(/ /g, "%20")})`;
        else o += `${a.embed ? "!" : ""}[[${a.target ?? ""}${a.alias ? "|" + a.alias : ""}]]`;
      }
      else if (n.type === "embed") o += embedMd(n);
      continue;
    }
    const marks = (n.marks ?? [])
      .filter((m) => ORDER.includes(m.type))
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    // Keep the longest common prefix of open marks; close the rest, open the new ones.
    let keep = 0;
    while (
      keep < open.length &&
      keep < marks.length &&
      open[keep].type === marks[keep].type &&
      JSON.stringify(open[keep].attrs ?? {}) === JSON.stringify(marks[keep].attrs ?? {})
    )
      keep++;
    closeAll(keep);
    let text = n.text ?? "";
    const isCode = marks.some((m) => m.type === "code");
    for (const m of marks.slice(keep)) {
      o += OPEN[m.type](m.attrs);
      open.push(m);
    }
    o += isCode ? text : escText(text);
  }
  closeAll(0);
  return o;
}

function embedMd(n: J): string {
  const src = n.attrs?.src ?? "";
  const alt = n.attrs?.alt ?? "";
  if (n.attrs?.md) return `![${alt}](${src.replace(/ /g, "%20")})`;
  return `![[${src}${alt ? "|" + alt : ""}]]`;
}

function listItemMd(item: J, marker: string): string {
  const pad = " ".repeat(marker.length);
  let s = "";
  (item.content ?? []).forEach((c, i) => {
    const b = blockMd(c, true).replace(/\n+$/, "");
    s += i === 0 ? b : (c.type === "paragraph" ? "\n\n" : "\n") + b;
  });
  return (
    marker +
    s
      .split("\n")
      .map((l, i) => (i === 0 || !l ? l : pad + l))
      .join("\n")
  );
}

function quote(s: string): string {
  return s
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function cellText(c: J): string {
  return (c.content ?? [])
    .map((p) => inlineMd(p.content))
    .join(" ")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function blockMd(n: J, tight = false): string {
  switch (n.type) {
    case "paragraph": {
      const t = inlineMd(n.content);
      // Markdown would read these as other blocks; escape them.
      return t.replace(/^(#{1,6} |> |- |\+ |\d+\. |---$)/, "\\$1") + (tight ? "" : "\n");
    }
    case "heading":
      return `${"#".repeat(n.attrs?.level ?? 1)} ${inlineMd(n.content)}\n`;
    case "bulletList":
      return (n.content ?? []).map((i) => listItemMd(i, "- ")).join("\n") + "\n";
    case "orderedList": {
      const s = n.attrs?.start ?? 1;
      return (n.content ?? []).map((i, k) => listItemMd(i, `${s + k}. `)).join("\n") + "\n";
    }
    case "taskList":
      return (n.content ?? []).map((i) => listItemMd(i, i.attrs?.checked ? "- [x] " : "- [ ] ")).join("\n") + "\n";
    case "blockquote":
      return quote(docMd(n.content ?? [])) + "\n";
    case "callout": {
      const head = `[!${n.attrs?.kind || "note"}]${n.attrs?.fold || ""}${n.attrs?.title ? " " + n.attrs.title : ""}`;
      const body = docMd(n.content ?? []).replace(/\n+$/, "");
      return quote(body ? `${head}\n${body}` : head) + "\n";
    }
    case "details": {
      const sum = (n.content ?? []).find((c) => c.type === "detailsSummary");
      const body = (n.content ?? []).find((c) => c.type === "detailsContent");
      const title = inlineMd(sum?.content).replace(/</g, "&lt;");
      return `<details>\n<summary>${title}</summary>\n\n${docMd(body?.content ?? []).replace(/\n+$/, "")}\n\n</details>\n`;
    }
    case "codeBlock": {
      const code = (n.content ?? []).map((c) => c.text ?? "").join("");
      const fence = code.includes("```") ? "~~~" : "```";
      return `${fence}${n.attrs?.language ?? ""}\n${code}\n${fence}\n`;
    }
    case "horizontalRule":
      return "---\n";
    case "embed":
      return embedMd(n) + "\n";
    case "image":
      return `![${n.attrs?.alt ?? ""}](${n.attrs?.src ?? ""})\n`;
    case "table": {
      const rows = n.content ?? [];
      if (!rows.length) return "";
      const cells = rows.map((r) => (r.content ?? []).map(cellText));
      const w = Math.max(...cells.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return [line(cells[0]), `| ${Array.from({ length: w }, () => "---").join(" | ")} |`, ...cells.slice(1).map(line)].join("\n") + "\n";
    }
    default:
      return n.content ? docMd(n.content) : "";
  }
}

function docMd(nodes: J[]): string {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "paragraph" && !(n.content ?? []).length) {
      out.push("");
      continue;
    }
    out.push(blockMd(n).replace(/\n+$/, ""));
  }
  // Blocks are separated by a blank line; runs of empty paragraphs collapse.
  return out
    .filter((b, i, a) => b !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function docToMd(doc: J): string {
  const s = docMd(doc.content ?? []);
  return s ? s + "\n" : "";
}
