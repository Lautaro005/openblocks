// Columns, like Notion's: 2 to 4 side by side, each holding any blocks. The line between two
// columns drags to change their widths. Backspace at the start of an empty column removes it, and
// columns left with one column become plain blocks again. Stored in Markdown as
// <div class="ob-columns"> with one <div class="ob-column"> per column (see lib/markdown.ts).
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view";

export const MAX_COLUMNS = 4;

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  defining: true,
  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el) => {
          const w = parseFloat((el as HTMLElement).dataset.width ?? "");
          return Number.isFinite(w) && w > 0 ? w : null;
        },
        renderHTML: (a) => (a.width ? { "data-width": String(a.width), style: `flex-grow: ${a.width}` } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "column", class: "ob-column" }), 0];
  },
});

class ColumnsView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private handles: HTMLElement;
  private ro: ResizeObserver;
  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "ob-columns-wrap";
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "ob-columns";
    this.contentDOM.dataset.type = "columns";
    this.handles = document.createElement("div");
    this.handles.className = "ob-col-handles";
    this.handles.contentEditable = "false";
    this.dom.append(this.contentDOM, this.handles);
    this.ro = new ResizeObserver(() => this.place());
    this.ro.observe(this.contentDOM);
    this.build();
  }

  private build() {
    this.handles.replaceChildren();
    for (let i = 0; i < this.node.childCount - 1; i++) {
      const h = document.createElement("div");
      h.className = "ob-col-handle";
      h.title = "";
      h.addEventListener("mousedown", (e) => this.drag(e, i));
      h.addEventListener("dblclick", () => this.reset());
      this.handles.appendChild(h);
    }
    requestAnimationFrame(() => this.place());
  }

  /** Puts each handle on the gap between two columns. */
  private place() {
    const cols = Array.from(this.contentDOM.children) as HTMLElement[];
    const base = this.dom.getBoundingClientRect();
    Array.from(this.handles.children).forEach((h, i) => {
      const a = cols[i]?.getBoundingClientRect();
      const b = cols[i + 1]?.getBoundingClientRect();
      if (!a || !b) return;
      (h as HTMLElement).style.left = `${(a.right + b.left) / 2 - base.left}px`;
    });
  }

  private widths(): number[] {
    const cols = Array.from(this.contentDOM.children) as HTMLElement[];
    return cols.map((c) => c.getBoundingClientRect().width);
  }

  private setWidths(ws: (number | null)[]) {
    const pos = this.getPos();
    if (pos == null) return;
    const tr = this.view.state.tr;
    let p = pos + 1;
    this.node.forEach((col, _o, i) => {
      if (col.attrs.width !== ws[i]) tr.setNodeMarkup(p, undefined, { ...col.attrs, width: ws[i] });
      p += col.nodeSize;
    });
    if (tr.docChanged) this.view.dispatch(tr);
  }

  private reset() {
    this.setWidths(Array.from({ length: this.node.childCount }, () => null));
  }

  private drag(e: MouseEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const px = this.widths();
    const total = px.reduce((a, b) => a + b, 0);
    const pair = px[i] + px[i + 1];
    const min = Math.min(80, pair / 3);
    const cols = Array.from(this.contentDOM.children) as HTMLElement[];
    document.body.classList.add("resizing-col");
    const ratios = (dx: number) => {
      const a = Math.max(min, Math.min(pair - min, px[i] + dx));
      const out = px.slice();
      out[i] = a;
      out[i + 1] = pair - a;
      // Widths are saved as shares of the row (flex-grow), rounded to keep the Markdown short.
      return out.map((w) => Math.round((w / total) * px.length * 100) / 100);
    };
    const move = (ev: MouseEvent) => {
      // Live while dragging, written to the document on release (one undo step).
      ratios(ev.clientX - start).forEach((r, k) => (cols[k].style.flexGrow = String(r)));
      this.place();
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-col");
      const r = ratios(ev.clientX - start);
      this.setWidths(r.every((x) => Math.abs(x - 1) < 0.02) ? r.map(() => null) : r);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const rebuild = node.childCount !== this.node.childCount;
    this.node = node;
    if (rebuild) this.build();
    else requestAnimationFrame(() => this.place());
    return true;
  }

  ignoreMutation(m: ViewMutationRecord) {
    return this.handles.contains(m.target as globalThis.Node) || (m.type === "attributes" && m.target === this.dom);
  }

  stopEvent(e: Event) {
    return this.handles.contains(e.target as globalThis.Node);
  }

  destroy() {
    this.ro.disconnect();
  }
}

const normalizeKey = new PluginKey("obColumnsNormalize");

/** Columns with one column left become plain blocks; the column a block was dragged out of goes
 * away when it is left empty (`emptied` is its position after the drag). */
function normalize(state: EditorState, emptied: number | null): Transaction | null {
  const tr = state.tr;
  const found: { pos: number; node: PMNode }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === "columns") {
      found.push({ pos, node });
      return false;
    }
    return node.isBlock;
  });
  for (const { pos, node } of found.reverse()) {
    let keep = [] as PMNode[];
    node.forEach((c, offset) => {
      const empty = c.childCount === 1 && c.firstChild!.isTextblock && c.firstChild!.content.size === 0;
      if (!(empty && emptied === pos + 1 + offset)) keep.push(c);
    });
    if (!keep.length) keep = [node.firstChild!];
    if (keep.length === node.childCount && keep.length > 1) continue;
    const from = tr.mapping.map(pos);
    const to = tr.mapping.map(pos + node.nodeSize);
    if (keep.length <= 1) {
      const blocks: PMNode[] = [];
      keep.forEach((c) => c.forEach((b) => blocks.push(b)));
      tr.replaceWith(from, to, blocks);
    } else {
      // Spread the space of the removed columns over the ones left.
      tr.replaceWith(from, to, node.type.create(node.attrs, keep.map((c) => c.type.create({ ...c.attrs, width: null }, c.content))));
    }
  }
  return tr.docChanged ? tr : null;
}

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,4}",
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns", class: "ob-columns" }), 0];
  },
  addNodeView() {
    return (({ node, view, getPos }: any) => new ColumnsView(node, view, getPos)) as any;
  },
  addKeyboardShortcuts() {
    return {
      // At the start of an empty column: remove the column.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        for (let d = $from.depth; d > 0; d--) {
          const n = $from.node(d);
          if (n.type.name !== "column") continue;
          const isEmpty = n.childCount === 1 && n.firstChild!.isTextblock && n.firstChild!.content.size === 0;
          if (!isEmpty) return false;
          const row = $from.node(d - 1);
          const colStart = $from.before(d);
          const tr = editor.state.tr;
          if (row.childCount <= 2) {
            // Back to plain blocks, with the cursor where the column was.
            const other: PMNode[] = [];
            row.forEach((c) => c !== n && c.forEach((b) => other.push(b)));
            const rowStart = $from.before(d - 1);
            tr.replaceWith(rowStart, rowStart + row.nodeSize, other);
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(rowStart + 1, tr.doc.content.size))));
          } else {
            tr.delete(colStart, colStart + n.nodeSize);
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, colStart - 2)), -1));
          }
          editor.view.dispatch(tr.scrollIntoView());
          return true;
        }
        return false;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: normalizeKey,
        appendTransaction(trs, old, state) {
          if (!trs.some((t) => t.docChanged)) return null;
          let emptied: number | null = null;
          if (trs.some((t) => t.getMeta("uiEvent") === "drop")) {
            // The column the dragged block came from, where it is now.
            const $f = old.selection.$from;
            for (let d = $f.depth; d > 0; d--) {
              if ($f.node(d).type.name === "column") {
                let p = $f.before(d);
                for (const t of trs) p = t.mapping.map(p, 1);
                emptied = p;
                break;
              }
            }
          }
          return normalize(state, emptied);
        },
      }),
    ];
  },
});

/** Turns the top-level block at `pos` (or an empty line) into `n` columns, the block in the first. */
export function insertColumns(editor: Editor, n: number) {
  const { state } = editor;
  const { $from } = state.selection;
  const schema = state.schema;
  const empty = () => schema.nodes.column.create(null, schema.nodes.paragraph.create());
  // Inside a column already: add columns to that row, up to four.
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "columns") {
      const row = $from.node(d);
      const add = Math.max(0, Math.min(MAX_COLUMNS, Math.max(n, row.childCount + 1)) - row.childCount);
      if (!add) return false;
      const end = $from.after(d) - 1;
      editor.view.dispatch(state.tr.insert(end, Array.from({ length: add }, empty)));
      return true;
    }
  }
  const depth = Math.min(1, $from.depth);
  const block = depth ? $from.node(1) : null;
  const from = depth ? $from.before(1) : $from.pos;
  const to = depth ? $from.after(1) : $from.pos;
  const first =
    block && !(block.isTextblock && block.content.size === 0)
      ? schema.nodes.column.create(null, block)
      : empty();
  const row = schema.nodes.columns.create(null, [first, ...Array.from({ length: n - 1 }, empty)]);
  const tr = state.tr.replaceWith(from, to, row);
  // The cursor goes to the first empty column.
  const target = first.content.size && first.firstChild!.content.size ? from + 1 + first.nodeSize + 2 : from + 3;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target, tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** Puts `dragged` (a block taken out of the document) next to the block at `pos`. */
export function dropBeside(view: EditorView, pos: number, side: "left" | "right", dragged: PMNode, from: number, to: number) {
  const { state } = view;
  const schema = state.schema;
  const $p = state.doc.resolve(pos);
  const target = state.doc.nodeAt(pos);
  if (!target) return false;
  const tr = state.tr;
  // Remove the dragged block first, then map the target's position.
  tr.delete(from, to);
  const at = tr.mapping.map(pos);
  const parent = $p.parent;
  const col = schema.nodes.column.create(null, dragged);
  if (parent.type.name === "column") {
    // Beside a block in a column: a new column next to that one, if there is room.
    const $c = tr.doc.resolve(at);
    let d = $c.depth;
    while (d > 0 && $c.node(d).type.name !== "column") d--;
    if (!d) return false;
    const row = $c.node(d - 1);
    if (row.childCount >= MAX_COLUMNS) return false;
    const colPos = side === "left" ? $c.before(d) : $c.after(d);
    tr.insert(colPos, col);
  } else {
    const node = tr.doc.nodeAt(at);
    if (!node) return false;
    const cols = side === "left" ? [col, schema.nodes.column.create(null, node)] : [schema.nodes.column.create(null, node), col];
    tr.replaceWith(at, at + node.nodeSize, schema.nodes.columns.create(null, cols));
  }
  tr.setMeta("uiEvent", "drop");
  view.dispatch(tr.scrollIntoView());
  return true;
}
