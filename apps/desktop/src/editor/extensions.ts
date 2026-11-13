// Custom editor nodes and plugins: [[wikilinks]], embedded files, callouts, the "/" and "[["
// menus (through @tiptap/suggestion), and a small popup store the React menu renders from.
import { Extension, Node, mergeAttributes, type Editor, type Range } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Details } from "@tiptap/extension-details";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { create } from "zustand";
import { EmbedView, CalloutView } from "./NodeViews";

// ---------- placeholder ----------

/** The hint on the empty line under the cursor. TipTap's own placeholder updates its decorations
 * piece by piece and leaves old ones behind when the cursor moves down through empty lines. */
export const CursorPlaceholder = Extension.create<{ placeholder: (p: { node: any; editor: Editor; pos: number }) => string }>({
  name: "placeholder",
  addOptions() {
    return { placeholder: () => "" };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const opts = this.options;
    return [
      new Plugin({
        key: new PluginKey("obPlaceholder"),
        props: {
          decorations: (state) => {
            if (!editor.isEditable) return null;
            const { $anchor } = state.selection;
            let d = $anchor.depth;
            while (d > 0 && !$anchor.node(d).isTextblock) d--;
            const node = $anchor.node(d);
            if (d === 0 || !node.isTextblock || node.content.size) return null;
            const pos = $anchor.before(d);
            const empty = state.doc.childCount === 1 && d === 1;
            const text = opts.placeholder({ node, editor, pos });
            if (!text) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, { class: empty ? "is-empty is-editor-empty" : "is-empty", "data-placeholder": text }),
            ]);
          },
        },
      }),
    ];
  },
});

// ---------- popup store (slash, wikilink and mention menus) ----------

export type SuggestItem = {
  id: string;
  title: string;
  hint?: string;
  icon?: string;
  group?: string;
  run: (editor: Editor, range: Range) => void;
};

type Popup = {
  open: boolean;
  kind: "slash" | "link" | "";
  items: SuggestItem[];
  index: number;
  rect: DOMRect | null;
  query: string;
  select: ((i: SuggestItem) => void) | null;
};

export const usePopup = create<Popup>(() => ({ open: false, kind: "", items: [], index: 0, rect: null, query: "", select: null }));

function popupRenderer(kind: "slash" | "link") {
  return () => {
    let props: SuggestionProps<SuggestItem> | null = null;
    const update = (p: SuggestionProps<SuggestItem>) => {
      props = p;
      usePopup.setState((s) => ({
        open: true,
        kind,
        items: p.items,
        index: s.kind === kind && s.query === p.query ? Math.min(s.index, Math.max(0, p.items.length - 1)) : 0,
        rect: p.clientRect?.() ?? null,
        query: p.query,
        select: (i) => p.command(i),
      }));
    };
    return {
      onStart: update,
      onUpdate: update,
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        const s = usePopup.getState();
        if (!s.open) return false;
        if (event.key === "ArrowDown") {
          usePopup.setState({ index: (s.index + 1) % Math.max(1, s.items.length) });
          return true;
        }
        if (event.key === "ArrowUp") {
          usePopup.setState({ index: (s.index - 1 + s.items.length) % Math.max(1, s.items.length) });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const it = s.items[s.index];
          if (it && props) {
            props.command(it);
            return true;
          }
          return false;
        }
        if (event.key === "Escape") {
          usePopup.setState({ open: false });
          return true;
        }
        return false;
      },
      onExit: () => usePopup.setState({ open: false, items: [], select: null }),
    };
  };
}

export type SlashSource = (query: string) => SuggestItem[];
export type LinkSource = (query: string) => Promise<SuggestItem[]>;

export const SlashCommand = Extension.create<{ items: SlashSource }>({
  name: "slashCommand",
  addOptions() {
    return { items: () => [] };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<SuggestItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slash"),
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== "codeBlock";
        },
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: popupRenderer("slash"),
      }),
    ];
  },
});

export const WikiSuggest = Extension.create<{ items: LinkSource }>({
  name: "wikiSuggest",
  addOptions() {
    return { items: async () => [] };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<SuggestItem>({
        editor: this.editor,
        pluginKey: new PluginKey("wiki"),
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: popupRenderer("link"),
      }),
    ];
  },
});

// ---------- wikilink (inline) ----------

export const WikiLink = Node.create<{ onOpen: (target: string) => void; exists: (t: string) => boolean }>({
  name: "wikilink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { onOpen: () => {}, exists: () => true };
  },
  addAttributes() {
    return {
      target: { default: "" },
      alias: { default: "" },
      embed: { default: false },
      md: { default: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-type="wikilink"]',
        getAttrs: (el) => ({ target: (el as HTMLElement).dataset.target ?? "", alias: (el as HTMLElement).dataset.alias ?? "" }),
      },
      {
        tag: 'span[data-type="embed"]',
        getAttrs: (el) => ({
          target: (el as HTMLElement).dataset.src ?? "",
          alias: (el as HTMLElement).dataset.alt ?? "",
          embed: true,
          md: (el as HTMLElement).dataset.md === "1",
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "wikilink", class: "ob-link" }), node.attrs.alias || node.attrs.target];
  },
  renderText({ node }) {
    return node.attrs.alias || node.attrs.target;
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "ob-link";
      const label = (node.attrs.alias || node.attrs.target).split("/").pop()?.replace(/\.md$/i, "");
      dom.textContent = (node.attrs.embed ? "↳ " : "") + label;
      dom.title = node.attrs.target;
      if (!this.options.exists(node.attrs.target)) dom.classList.add("missing");
      dom.addEventListener("click", (e) => {
        e.preventDefault();
        this.options.onOpen(node.attrs.target);
      });
      return { dom };
    };
  },
});

// ---------- embed (block): ![[file]] and ![](image) ----------

export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: "" }, alt: { default: "" }, md: { default: false } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="embed"]',
        getAttrs: (el) => ({
          src: (el as HTMLElement).dataset.src ?? "",
          alt: (el as HTMLElement).dataset.alt ?? "",
          md: (el as HTMLElement).dataset.md === "1",
        }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "embed" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },
});

// ---------- callout (> [!note] Title) ----------

export const CALLOUT_KINDS = ["note", "tip", "info", "success", "question", "warning", "danger", "quote"] as const;

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { kind: { default: "note" }, title: { default: "" }, fold: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
        getAttrs: (el) => ({
          kind: (el as HTMLElement).dataset.kind || "note",
          title: (el as HTMLElement).dataset.title || "",
          fold: (el as HTMLElement).dataset.fold || "",
        }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout" }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

// ---------- small keyboard extras ----------

export const Shortcuts = Extension.create<{ onSave: () => void }>({
  name: "obShortcuts",
  addOptions() {
    return { onSave: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-s": () => {
        this.options.onSave();
        return true;
      },
      "Mod-Shift-h": () => this.editor.chain().focus().toggleHighlight().run(),
      "Mod-Alt-1": () => this.editor.chain().focus().toggleHeading({ level: 1 }).run(),
      "Mod-Alt-2": () => this.editor.chain().focus().toggleHeading({ level: 2 }).run(),
      "Mod-Alt-3": () => this.editor.chain().focus().toggleHeading({ level: 3 }).run(),
      "Mod-Alt-4": () => this.editor.chain().focus().toggleHeading({ level: 4 }).run(),
      "Mod-Alt-0": () => this.editor.chain().focus().setParagraph().run(),
    };
  },
});

// ---------- #tags look like tags and open the tag view ----------

const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export const TagHighlight = Extension.create<{ onOpen: (tag: string) => void }>({
  name: "tagHighlight",
  addOptions() {
    return { onOpen: () => {} };
  },
  addProseMirrorPlugins() {
    const onOpen = this.options.onOpen;
    const build = (doc: any) => {
      const decos: Decoration[] = [];
      doc.descendants((node: any, pos: number, parent: any) => {
        if (!node.isText || parent?.type.name === "codeBlock" || node.marks.some((m: any) => m.type.name === "code")) return;
        const text: string = node.text;
        TAG_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TAG_RE.exec(text))) {
          const from = pos + m.index + m[1].length;
          decos.push(Decoration.inline(from, from + 1 + m[2].length, { class: "ob-tag", "data-tag": m[2].toLowerCase() }));
        }
      });
      return DecorationSet.create(doc, decos);
    };
    return [
      new Plugin({
        key: new PluginKey("obTags"),
        state: {
          init: (_, { doc }) => build(doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest(".ob-tag") as HTMLElement | null;
            if (el && (event.metaKey || event.ctrlKey || event.altKey)) {
              onOpen(el.dataset.tag ?? "");
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

// ---------- toggle headings: a toggle whose title is a heading ----------

/** Toggles with a `heading` level (0 = a plain toggle). Stored as <details data-heading="2">. */
export const ToggleDetails = Details.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      heading: {
        default: 0,
        parseHTML: (el: HTMLElement) => Math.max(0, Math.min(4, Number(el.dataset.heading) || 0)),
        renderHTML: (a: { heading: number }) => (a.heading ? { "data-heading": String(a.heading) } : {}),
      },
    };
  },
  addNodeView() {
    const parent = this.parent?.();
    if (!parent) return null;
    return (props: any) => {
      const v: any = parent(props);
      const set = (n: any) => {
        if (n.attrs.heading) v.dom.setAttribute("data-heading", String(n.attrs.heading));
        else v.dom.removeAttribute("data-heading");
      };
      set(props.node);
      const up = v.update?.bind(v);
      v.update = (n: any, ...rest: any[]) => {
        const ok = up ? up(n, ...rest) : n.type === props.node.type;
        if (ok) set(n);
        return ok;
      };
      return v;
    };
  },
});

/** Turns the block with the cursor into a toggle heading of `level` (its text becomes the title). */
export function setToggleHeading(editor: Editor, level: number) {
  const { state } = editor;
  const { $from } = state.selection;
  const schema = state.schema;
  // Already in a toggle's title: change its level.
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === "details") {
      editor.view.dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, heading: level }));
      return true;
    }
    if (n.type.name === "detailsContent") break;
  }
  const block = $from.parent;
  if (!block.isTextblock) return false;
  const from = $from.before($from.depth);
  const to = $from.after($from.depth);
  const node = schema.nodes.details.create({ heading: level, open: true }, [
    schema.nodes.detailsSummary.create(null, block.content),
    schema.nodes.detailsContent.create(null, schema.nodes.paragraph.create()),
  ]);
  const tr = state.tr.replaceWith(from, to, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2 + block.content.size)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  // A new toggle starts open, so Enter goes on into its content.
  const dom = editor.view.nodeDOM(from) as HTMLElement | null;
  if (dom && !dom.classList.contains("is-open")) (dom.querySelector(":scope > button") as HTMLElement | null)?.click();
  return true;
}
