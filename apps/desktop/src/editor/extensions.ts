// Custom editor nodes and plugins: [[wikilinks]], embedded files, callouts, the "/" and "[["
// menus (through @tiptap/suggestion), and a small popup store the React menu renders from.
import { Extension, Node, mergeAttributes, type Editor, type Range } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { create } from "zustand";
import { EmbedView, CalloutView } from "./NodeViews";

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
