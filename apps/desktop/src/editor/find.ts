// Find and replace inside the page (⌘F / Ctrl+F). The matches are editor decorations, so they
// follow edits, and every change goes through the editor (one undo step per action).
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export type FindOpts = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
export type Match = { from: number; to: number; text: string; groups: string[] };
type FindState = { query: string; opts: FindOpts; matches: Match[]; index: number; error: string | null; decos: DecorationSet };

export const findKey = new PluginKey<FindState>("obFind");

const EMPTY_OPTS: FindOpts = { caseSensitive: false, wholeWord: false, regex: false };

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The search as a regular expression, or an error message for an invalid one. */
export function buildRe(query: string, opts: FindOpts): RegExp | string | null {
  if (!query) return null;
  let src = opts.regex ? query : escapeRe(query);
  if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, `gu${opts.caseSensitive ? "" : "i"}`);
  } catch (e: any) {
    return String(e.message || e);
  }
}

/** Every match in the document. Text is searched per block; inline atoms (links) separate words. */
export function findAll(doc: PMNode, re: RegExp): Match[] {
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    const map: number[] = []; // text offset → document position
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) map.push(start + i);
        text += child.text;
      } else {
        map.push(start);
        text += "￼";
      }
    });
    map.push(pos + 1 + node.content.size);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (m[0].includes("￼")) continue;
      out.push({ from: map[m.index], to: map[m.index + m[0].length - 1] + 1, text: m[0], groups: m.slice(1) });
      if (out.length > 5000) return false;
    }
    return false;
  });
  return out;
}

function decorate(doc: PMNode, matches: Match[], index: number) {
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? "ob-find ob-find-current" : "ob-find" })),
  );
}

function compute(doc: PMNode, query: string, opts: FindOpts, near: number | null, keepIndex?: number): FindState {
  const re = buildRe(query, opts);
  if (re === null || typeof re === "string") {
    return { query, opts, matches: [], index: -1, error: typeof re === "string" ? re : null, decos: DecorationSet.empty };
  }
  const matches = findAll(doc, re);
  let index = -1;
  if (matches.length) {
    if (keepIndex != null) index = Math.min(keepIndex, matches.length - 1);
    else if (near != null) {
      index = matches.findIndex((m) => m.from >= near);
      if (index < 0) index = 0;
    } else index = 0;
  }
  return { query, opts, matches, index, error: null, decos: decorate(doc, matches, index) };
}

type Meta = { query?: string; opts?: FindOpts; index?: number; clear?: boolean };

export const FindReplace = Extension.create({
  name: "obFind",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: "", opts: EMPTY_OPTS, matches: [], index: -1, error: null, decos: DecorationSet.empty }),
          apply(tr, old, _prev, next) {
            const meta = tr.getMeta(findKey) as Meta | undefined;
            if (meta?.clear) return { query: "", opts: old.opts, matches: [], index: -1, error: null, decos: DecorationSet.empty };
            if (meta && (meta.query !== undefined || meta.opts)) {
              return compute(next.doc, meta.query ?? old.query, meta.opts ?? old.opts, next.selection.from);
            }
            if (meta?.index !== undefined && old.matches.length) {
              const n = old.matches.length;
              const index = ((meta.index % n) + n) % n;
              return { ...old, index, decos: decorate(next.doc, old.matches, index) };
            }
            if (tr.docChanged && old.query) return compute(next.doc, old.query, old.opts, null, Math.max(0, old.index));
            return old;
          },
        },
        props: {
          decorations(state) {
            return findKey.getState(state)?.decos;
          },
        },
      }),
    ];
  },
});

export function findState(state: EditorState) {
  return findKey.getState(state)!;
}

function send(view: EditorView, meta: Meta, extra?: (tr: Transaction) => void) {
  const tr = view.state.tr.setMeta(findKey, meta).setMeta("addToHistory", false);
  extra?.(tr);
  view.dispatch(tr);
}

/** Moves the editor's selection to the current match so it scrolls into view. */
function reveal(view: EditorView) {
  const s = findState(view.state);
  const m = s.matches[s.index];
  if (!m) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView().setMeta("addToHistory", false));
}

export function setQuery(view: EditorView, query: string, opts: FindOpts) {
  send(view, { query, opts });
  reveal(view);
}

export function step(view: EditorView, dir: 1 | -1) {
  const s = findState(view.state);
  if (!s.matches.length) return;
  send(view, { index: s.index + dir });
  reveal(view);
}

export function clearFind(view: EditorView) {
  send(view, { clear: true });
}

/** `$1`, `$2`… and `$&` in a regex replacement. */
function replacement(m: Match, text: string, opts: FindOpts) {
  if (!opts.regex) return text;
  return text.replace(/\$(\d+|&)/g, (_, g) => (g === "&" ? m.text : (m.groups[Number(g) - 1] ?? "")));
}

export function replaceCurrent(view: EditorView, text: string) {
  const s = findState(view.state);
  const m = s.matches[s.index];
  if (!m) return;
  const rep = replacement(m, text, s.opts);
  const tr = view.state.tr;
  if (rep) tr.insertText(rep, m.from, m.to);
  else tr.delete(m.from, m.to);
  view.dispatch(tr);
  reveal(view);
}

/** Replaces (or, with an empty text, deletes) every match. Returns how many. */
export function replaceAll(view: EditorView, text: string) {
  const s = findState(view.state);
  if (!s.matches.length) return 0;
  const tr = view.state.tr;
  for (const m of [...s.matches].reverse()) {
    const rep = replacement(m, text, s.opts);
    if (rep) tr.insertText(rep, m.from, m.to);
    else tr.delete(m.from, m.to);
  }
  view.dispatch(tr);
  return s.matches.length;
}

/** Deletes every block (paragraph, list item, heading…) that has a match. Returns how many. */
export function deleteBlocks(view: EditorView) {
  const s = findState(view.state);
  if (!s.matches.length) return 0;
  const ranges = new Map<number, number>();
  for (const m of s.matches) {
    const $p = view.state.doc.resolve(m.from);
    // The outermost block under the document, or the list item that holds the match.
    let depth = 1;
    for (let d = $p.depth; d > 0; d--) {
      const name = $p.node(d).type.name;
      if (name === "listItem" || name === "taskItem") {
        depth = d;
        break;
      }
    }
    ranges.set($p.before(depth), $p.after(depth));
  }
  const tr = view.state.tr;
  for (const [from, to] of [...ranges.entries()].sort((a, b) => b[0] - a[0])) tr.delete(tr.mapping.map(from), tr.mapping.map(to));
  view.dispatch(tr);
  return ranges.size;
}
