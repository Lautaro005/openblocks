// Selecting blocks like files on a desktop: press outside the text (the page margins, below the
// last block) and drag a rectangle. Every block it touches gets selected as one range, so the usual
// actions work on all of them: delete, cut/copy, the format bar, turn into, ask the AI.
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type Range = { from: number; to: number } | null;
export const blockSelKey = new PluginKey<Range>("obBlockSel");

export const BlockSelection = Extension.create({
  name: "obBlockSel",
  addProseMirrorPlugins() {
    return [
      new Plugin<Range>({
        key: blockSelKey,
        state: {
          init: () => null,
          apply(tr, old) {
            const meta = tr.getMeta(blockSelKey) as Range | undefined;
            if (meta !== undefined) return meta;
            // Any other change of selection or content ends the block selection.
            if (tr.docChanged || tr.selectionSet) return null;
            return old;
          },
        },
        props: {
          decorations(state) {
            const r = blockSelKey.getState(state);
            if (!r) return null;
            const decos: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              if (offset >= r.from && offset + node.nodeSize <= r.to) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: "ob-block-selected" }));
            });
            return DecorationSet.create(state.doc, decos);
          },
          handleKeyDown(view, e) {
            const r = blockSelKey.getState(view.state);
            if (!r) return false;
            if (e.key === "Backspace" || e.key === "Delete") {
              const tr = view.state.tr.delete(r.from, r.to).setMeta(blockSelKey, null);
              if (tr.doc.childCount === 0) tr.insert(0, view.state.schema.nodes.paragraph.create());
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            if (e.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(blockSelKey, null).setSelection(Selection.near(view.state.doc.resolve(Math.min(r.from, view.state.doc.content.size)))));
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/** Selects the top-level blocks between `from` and `to` (document positions of block edges). */
export function selectBlocks(editor: Editor, from: number, to: number) {
  const { state, view } = editor;
  const sel = TextSelection.between(state.doc.resolve(from), state.doc.resolve(to));
  view.dispatch(state.tr.setSelection(sel).setMeta(blockSelKey, { from, to }));
  view.focus();
}

const SKIP = "input, textarea, select, button, a, [contenteditable='true'], .block-handle, .find-bar, .props, .page-title, .menu, .ai-inline, .ask-box";

/** Starts the rectangle on presses outside the editor's text, inside `container`. */
export function attachMarquee(editor: Editor, container: HTMLElement): () => void {
  let box: HTMLDivElement | null = null;
  let start: { x: number; y: number } | null = null; // y in container scroll coordinates
  let last = { x: 0, y: 0 };
  let picked: [number, number] | null = null;
  let scrollTimer = 0;

  const blocks = () => {
    const out: { from: number; to: number; el: HTMLElement }[] = [];
    editor.state.doc.forEach((node, offset) => {
      const el = editor.view.nodeDOM(offset);
      if (el instanceof HTMLElement) out.push({ from: offset, to: offset + node.nodeSize, el });
    });
    return out;
  };

  const update = () => {
    if (!start || !box) return;
    const cr = container.getBoundingClientRect();
    const y0 = start.y - container.scrollTop + cr.top;
    const x1 = Math.min(start.x, last.x),
      x2 = Math.max(start.x, last.x);
    const y1 = Math.min(y0, last.y),
      y2 = Math.max(y0, last.y);
    Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    // Blocks span the text column, so only the vertical overlap matters once the box reaches the column.
    const col = editor.view.dom.getBoundingClientRect();
    const reaches = x2 >= col.left - 80 && x1 <= col.right + 80;
    let a = -1,
      b = -1;
    for (const bl of blocks()) {
      const r = bl.el.getBoundingClientRect();
      const hit = reaches && r.bottom >= y1 && r.top <= y2;
      bl.el.classList.toggle("ob-block-picking", hit);
      if (hit) {
        if (a < 0) a = bl.from;
        b = bl.to;
      }
    }
    picked = a >= 0 ? [a, b] : null;
  };

  const autoscroll = () => {
    const cr = container.getBoundingClientRect();
    const edge = 40;
    let dy = 0;
    if (last.y < cr.top + edge) dy = -Math.ceil((cr.top + edge - last.y) / 3);
    else if (last.y > cr.bottom - edge) dy = Math.ceil((last.y - (cr.bottom - edge)) / 3);
    if (dy) {
      container.scrollTop += dy;
      update();
    }
    scrollTimer = window.requestAnimationFrame(autoscroll);
  };

  const move = (e: MouseEvent) => {
    if (!start) return;
    last = { x: e.clientX, y: e.clientY };
    if (!box) {
      const cr = container.getBoundingClientRect();
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - (start.y - container.scrollTop + cr.top));
      if (dx < 5 && dy < 5) return;
      box = document.createElement("div");
      box.className = "ob-marquee";
      document.body.appendChild(box);
      document.body.classList.add("marquee-on");
      scrollTimer = window.requestAnimationFrame(autoscroll);
    }
    e.preventDefault();
    update();
  };

  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    window.cancelAnimationFrame(scrollTimer);
    document.body.classList.remove("marquee-on");
    for (const el of editor.view.dom.querySelectorAll(".ob-block-picking")) el.classList.remove("ob-block-picking");
    if (box) {
      box.remove();
      box = null;
      if (picked) selectBlocks(editor, picked[0], picked[1]);
    }
    start = null;
    picked = null;
  };

  const down = (e: MouseEvent) => {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || !editor.isEditable) return;
    const t = e.target as HTMLElement;
    if (editor.view.dom.contains(t) || t.closest(SKIP)) return;
    const cr = container.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY - cr.top + container.scrollTop };
    last = { x: e.clientX, y: e.clientY };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  container.addEventListener("mousedown", down);
  return () => {
    container.removeEventListener("mousedown", down);
    up();
  };
}
