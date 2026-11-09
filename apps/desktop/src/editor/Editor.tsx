import { useEditor, EditorContent, type Editor as TEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import Highlight from "@tiptap/extension-highlight";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Placeholder } from "@tiptap/extensions";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { DOMSerializer } from "@tiptap/pm/model";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import {
  TextB,
  TextItalic,
  TextStrikethrough,
  Code,
  HighlighterCircle,
  LinkSimple,
  Sparkle,
  DotsSixVertical,
  Plus,
  TextH,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextHFour,
  Columns as ColumnsIcon,
  CaretCircleDown,
  TextT,
  ListBullets,
  ListNumbers,
  CheckSquare,
  Quotes,
  CodeBlock,
  Table as TableIcon,
  Minus,
  Paperclip,
  CalendarBlank,
  NotePencil,
  CaretCircleRight,
  Copy,
  Trash,
  ArrowsClockwise,
  Check,
  X,
  FileDashed,
  ArrowUp,
  Stop,
} from "@phosphor-icons/react";
import { api, dirOf, stream, type Page } from "../lib/api";
import { docToMd, mdToHtml } from "../lib/markdown";
import { renderMd } from "../lib/render";
import { t } from "../lib/i18n";
import { isMac, useStore } from "../lib/store";
import { FindReplace, findState } from "./find";
import { BlockSelection, attachMarquee } from "./marquee";
import { FindBar } from "./FindBar";
import { Callout, Embed, Shortcuts, SlashCommand, TagHighlight, ToggleDetails, WikiLink, WikiSuggest, setToggleHeading, usePopup, type SuggestItem } from "./extensions";
import { Column, Columns, MAX_COLUMNS, dropBeside, insertColumns } from "./columns";
import { slashItems } from "./slash";
import { matchCombo, showCombo } from "../lib/keys";
import { ModelPicker } from "../components/AiPanel";

const lowlight = createLowlight({ bash, c, cpp, csharp, css, diff, go, java, javascript, json, kotlin, markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml });
lowlight.registerAlias({ bash: ["sh", "shell", "zsh"], javascript: ["js", "jsx"], typescript: ["ts", "tsx"], xml: ["html"], python: ["py"], rust: ["rs"], yaml: ["yml"] });

const ICONS: Record<string, any> = {
  text: TextT,
  h1: TextHOne,
  h2: TextHTwo,
  h3: TextHThree,
  h4: TextHFour,
  toggleh: CaretCircleDown,
  columns: ColumnsIcon,
  list: ListBullets,
  numbered: ListNumbers,
  task: CheckSquare,
  quote: Quotes,
  callout: NotePencil,
  toggle: CaretCircleRight,
  code: CodeBlock,
  table: TableIcon,
  divider: Minus,
  link: LinkSimple,
  file: Paperclip,
  date: CalendarBlank,
  template: FileDashed,
  ai: Sparkle,
  page: TextT,
  newpage: Plus,
};

export type EditorHandle = {
  markdown(): string;
  focusStart(): void;
  selectionMarkdown(): string;
};

type Props = {
  page: Page;
  onChange: (md: string) => void;
  spellcheck: boolean;
};

function sliceMd(editor: TEditor): string {
  const { from, to } = editor.state.selection;
  if (from === to) return "";
  const slice = editor.state.doc.cut(from, to);
  return docToMd(slice.toJSON() as any).trim() || editor.state.doc.textBetween(from, to, "\n");
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ page, onChange, spellcheck }, ref) {
  const fileInput = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [aiBox, setAiBox] = useState<null | { action: string; label: string; text: string; done: boolean; error?: string; from: number; to: number }>(null);
  const [tplMenu, setTplMenu] = useState<null | { items: { path: string; title: string }[] }>(null);
  const [ask, setAsk] = useState<null | AskState>(null);
  const [find, setFind] = useState<null | { replace: boolean; seed: string; n: number }>(null);
  const openAskRef = useRef<() => void>(() => {});
  const askAbort = useRef<AbortController | null>(null);

  const uploadFiles = useCallback(async (files: File[], editor: TEditor, pos?: number) => {
    const folder = dirOf(pageRef.current.path);
    for (const f of files) {
      try {
        const r = await api.upload(folder, f);
        const node = { type: "embed", attrs: { src: r.path, alt: "" } };
        if (pos != null) editor.chain().focus().insertContentAt(pos, node).run();
        else editor.chain().focus().insertContent(node).run();
      } catch (e: any) {
        useStore.getState().toast(e.message, "error");
      }
    }
    useStore.getState().refreshTree();
  }, []);

  const editor = useEditor({
    immediatelyRender: true,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3, 4] },
        link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: null, target: null } },
        dropcursor: { color: "var(--ink)", width: 3 },
      }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      ToggleDetails.configure({ persist: false, HTMLAttributes: { class: "toggle" } }),
      Columns,
      Column,
      DetailsSummary,
      FindReplace,
      BlockSelection,
      DetailsContent,
      Highlight,
      TagHighlight.configure({ onOpen: (tag: string) => useStore.getState().go({ kind: "tag", tag }) }),
      Callout,
      Embed,
      WikiLink.configure({
        exists: (target: string) => useStore.getState().exists(target),
        onOpen: async (target: string) => {
          const r = await api.resolve(target).catch(() => ({ path: null }) as { path: string | null; kind?: "page" | "file" | "folder" });
          const st = useStore.getState();
          // The tree knows the page too, in case the server's index is behind.
          const local = r.path ? null : st.pagePath(target);
          if (r.path) st.openPath(r.path, r.kind);
          else if (local) st.openPath(local, "page");
          else {
            // Following a link to a page that does not exist creates it, like Obsidian.
            const name = target.split("/").pop() || target;
            const folder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : dirOf(pageRef.current.path);
            const c = await api.createPage(folder, name).catch((e) => (st.toast(e.message, "error"), null));
            if (c) {
              await st.refreshTree();
              st.go({ kind: "page", path: c.path });
            }
          }
        },
      }),
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node, editor, pos }) => {
          if (node.type.name === "heading") return t("Título");
          if (node.type.name === "detailsSummary") return t("Desplegable");
          if (node.type.name === "paragraph" && pos != null) {
            // An empty column says what it is for.
            try {
              const $p = editor.state.doc.resolve(pos);
              if ($p.parent.type.name === "column" && $p.parent.childCount === 1) return t("Columna");
            } catch {}
          }
          if (editor.isEmpty) return t("Escribí, o tocá '/' para insertar un bloque…");
          return t("Escribí '/' para comandos");
        },
      }),
      SlashCommand.configure({
        items: slashItems({
          attach: () => fileInput.current?.click(),
          linkPage: (e) => e.chain().focus().insertContent("[[").run(),
          ai: (e) => {
            const sel = sliceMd(e);
            useStore.getState().askAI(sel ? `> ${sel.split("\n").join("\n> ")}\n\n` : "");
          },
          template: async () => {
            const items = await api.templates().catch(() => []);
            if (!items.length) {
              const folder = useStore.getState().settings?.templates_folder || "Plantillas";
              useStore.getState().toast(t("Creá páginas en la carpeta «{f}» para usarlas como plantillas.", { f: folder }));
              return;
            }
            setTplMenu({ items });
          },
        }),
      }),
      WikiSuggest.configure({
        items: async (query: string) => {
          const hits = await api.titles(query, 8).catch(() => []);
          const items: SuggestItem[] = hits.map((h) => ({
            id: h.path,
            title: h.title,
            hint: h.path.includes("/") ? dirOf(h.path) : "",
            icon: h.kind === "file" ? "file" : "page",
            run: (e, r) => {
              const target = h.kind === "file" ? h.path.split("/").pop()! : h.title;
              e.chain()
                .focus()
                .deleteRange({ from: r.from, to: r.to + (e.state.doc.textBetween(r.to, Math.min(r.to + 2, e.state.doc.content.size)) === "]]" ? 2 : 0) })
                .insertContent([{ type: "wikilink", attrs: { target, embed: h.kind === "file" } }, { type: "text", text: " " }])
                .run();
            },
          }));
          const q = query.trim();
          if (q && !hits.some((h) => h.title.toLowerCase() === q.toLowerCase())) {
            items.push({
              id: "new:" + q,
              title: t("Crear «{q}»", { q }),
              icon: "newpage",
              hint: t("página nueva"),
              run: (e, r) => {
                e.chain()
                  .focus()
                  .deleteRange(r)
                  .insertContent([{ type: "wikilink", attrs: { target: q } }, { type: "text", text: " " }])
                  .run();
                api.createPage(dirOf(pageRef.current.path), q).then(() => useStore.getState().refreshTree());
              },
            });
          }
          return items;
        },
      }),
      Shortcuts.configure({ onSave: () => onChangeRef.current(docToMd(editorRef.current!.getJSON() as any)) }),
    ],
    content: mdToHtml(page.body),
    editorProps: {
      attributes: { class: "prose ob-editor", spellcheck: spellcheck ? "true" : "false" },
      handleKeyDown: (_view, event) => {
        // ⌘. (Ctrl+. on Windows and Linux, or whatever the user set): write here with AI.
        if (matchCombo(event, useStore.getState().settings?.ai_shortcut)) {
          event.preventDefault();
          openAskRef.current();
          return true;
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (moved || !files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        uploadFiles(files, editorRef.current!, pos);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length) {
          event.preventDefault();
          uploadFiles(files, editorRef.current!);
          return true;
        }
        const html = event.clipboardData?.getData("text/html");
        const text = event.clipboardData?.getData("text/plain") ?? "";
        // Plain text that looks like Markdown is pasted as blocks.
        if (!html && /(^|\n)(#{1,6} |[-*+] |\d+\. |> |```|\|.+\|)|\[\[.+\]\]|\*\*.+\*\*/.test(text)) {
          event.preventDefault();
          editorRef.current!.chain().focus().insertContent(mdToHtml(text)).run();
          return true;
        }
        return false;
      },
      handleClickOn: (_view, _pos, node, _np, event) => {
        const a = (event.target as HTMLElement).closest("a");
        if (a && node) {
          const href = a.getAttribute("href") ?? "";
          if (/^(https?:|mailto:)/i.test(href)) {
            event.preventDefault();
            api.openUrl(href);
            return true;
          }
          if (href && !href.startsWith("#")) {
            event.preventDefault();
            api.resolve(decodeURIComponent(href)).then((r) => r.path && useStore.getState().openPath(r.path, r.kind));
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(docToMd(editor.getJSON() as any)),
  });
  const editorRef = useRef<TEditor | null>(editor);
  editorRef.current = editor;

  useImperativeHandle(ref, () => ({
    markdown: () => docToMd(editor.getJSON() as any),
    focusStart: () => editor.chain().focus("start").run(),
    selectionMarkdown: () => sliceMd(editor),
  }));

  // Another version of the page (changed on disk, restored from history, edited by an agent).
  const loaded = useRef(page.body);
  useEffect(() => {
    if (page.body === loaded.current) return;
    loaded.current = page.body;
    const cur = docToMd(editor.getJSON() as any);
    if (cur.trim() === page.body.trim()) return;
    const { from } = editor.state.selection;
    editor.commands.setContent(mdToHtml(page.body), { emitUpdate: false });
    try {
      editor.commands.setTextSelection(Math.min(from, editor.state.doc.content.size - 1));
    } catch {}
  }, [page.body, editor]);

  useEffect(() => {
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: { class: "prose ob-editor", spellcheck: spellcheck ? "true" : "false" } } });
  }, [spellcheck, editor]);

  // ---------- inline AI ----------
  const runAI = useCallback(
    async (action: string, label: string, extra = "") => {
      const { from, to } = editor.state.selection;
      const text = from === to ? docToMd(editor.getJSON() as any) : sliceMd(editor);
      const model = useStore.getState().settings?.ai?.model;
      if (!model) {
        useStore.getState().toast(t("Elegí un modelo de IA en Ajustes → IA."), "error", {
          label: t("Abrir"),
          run: () => useStore.setState({ settingsTab: "ai" }),
        });
        return;
      }
      setAiBox({ action, label, text: "", done: false, from, to });
      try {
        await stream("/api/ai/inline", { action, text, extra, model }, (ev) => {
          if (ev.kind === "delta") setAiBox((b) => (b ? { ...b, text: b.text + ev.text } : b));
          if (ev.kind === "error") setAiBox((b) => (b ? { ...b, error: ev.text } : b));
          if (ev.kind === "done") setAiBox((b) => (b ? { ...b, done: true } : b));
        });
      } catch (e: any) {
        setAiBox((b) => (b ? { ...b, error: e.message, done: true } : b));
      }
    },
    [editor],
  );

  // ---------- ⌘. : ask the AI to write at this line ----------
  openAskRef.current = () => {
    const w = wrap.current;
    if (!w) return;
    const { from, to } = editor.state.selection;
    const $from = editor.state.doc.resolve(from);
    let top = 0;
    try {
      // Right under the block the cursor is in.
      const blockStart = $from.depth >= 1 ? $from.before(1) : from;
      const dom = editor.view.nodeDOM(blockStart) as HTMLElement | null;
      const r = (dom && dom.getBoundingClientRect ? dom.getBoundingClientRect() : null) ?? editor.view.coordsAtPos(to);
      top = r.bottom - w.getBoundingClientRect().top + 6;
    } catch {
      top = editor.view.coordsAtPos(to).bottom - w.getBoundingClientRect().top + 6;
    }
    setAiBox(null);
    setAsk({ top, from, to, prompt: "", out: "", phase: "input" });
  };

  const runAsk = async (prompt: string) => {
    if (!ask || !prompt.trim()) return;
    const model = useStore.getState().settings?.ai?.model;
    if (!model) {
      useStore.getState().toast(t("Elegí un modelo de IA en Ajustes → IA."), "error");
      return;
    }
    const { from, to } = ask;
    const doc = editor.state.doc;
    const md = (a: number, b: number) => (a >= b ? "" : docToMd(doc.cut(a, b).toJSON() as any).trim());
    const before = md(0, from);
    const after = md(to, doc.content.size);
    const input =
      from === to
        ? `${before}\n\n⟦HERE⟧\n\n${after}`
        : `${before}\n\n⟦SELECTION⟧\n${md(from, to)}\n⟦/SELECTION⟧\n\n${after}`;
    setAsk((a) => (a ? { ...a, prompt, out: "", error: undefined, phase: "run" } : a));
    askAbort.current?.abort();
    const ac = new AbortController();
    askAbort.current = ac;
    try {
      await stream(
        "/api/ai/inline",
        { action: "write", text: input, extra: prompt, model },
        (ev) => {
          if (ev.kind === "delta") setAsk((a) => (a ? { ...a, out: a.out + ev.text } : a));
          if (ev.kind === "error") setAsk((a) => (a ? { ...a, error: ev.text } : a));
        },
        ac.signal,
      );
    } catch (e: any) {
      if (e?.name !== "AbortError") setAsk((a) => (a ? { ...a, error: e.message } : a));
    }
    setAsk((a) => (a ? { ...a, phase: "done" } : a));
  };

  const acceptAsk = () => {
    const out = ask?.out.replace(/⟦\/?(HERE|SELECTION)⟧/g, "").trim();
    if (!ask || !out) return;
    const html = mdToHtml(out);
    const { from, to } = ask;
    const doc = editor.state.doc;
    if (from !== to) {
      editor.chain().focus().insertContentAt({ from, to }, html).run();
    } else {
      const $p = doc.resolve(Math.min(from, doc.content.size));
      if ($p.depth < 1) editor.chain().focus().insertContentAt(from, html).run();
      else if ($p.parent.isTextblock && $p.parent.content.size === 0) {
        // The cursor is on an empty line: it is replaced by the text. Climb to the outermost node
        // that holds only that line (an empty list item, or a whole empty list).
        let d = $p.depth;
        while (d > 1 && $p.node(d - 1).childCount === 1) d--;
        if (d === 1) editor.chain().focus().insertContentAt({ from: $p.before(1), to: $p.after(1) }, html).run();
        else {
          const a = $p.before(d);
          const b = $p.after(d);
          editor
            .chain()
            .focus()
            .deleteRange({ from: a, to: b })
            .insertContentAt($p.after(1) - (b - a), html)
            .run();
        }
      } else editor.chain().focus().insertContentAt($p.after(1), html).run();
    }
    setAsk(null);
  };

  const closeAsk = () => {
    askAbort.current?.abort();
    setAsk(null);
    editor.commands.focus();
  };

  const applyAI = (mode: "replace" | "below") => {
    if (!aiBox) return;
    const html = mdToHtml(aiBox.text.trim());
    const { from, to } = aiBox;
    if (mode === "replace" && from !== to) editor.chain().focus().insertContentAt({ from, to }, html).run();
    else {
      const $to = editor.state.doc.resolve(to);
      const after = from === to ? editor.state.doc.content.size : $to.after(1);
      editor.chain().focus().insertContentAt(after, html).run();
    }
    setAiBox(null);
  };

  // Dragging from outside the text draws a rectangle that selects blocks.
  useEffect(() => {
    const c = document.getElementById("content");
    if (!editor || !c) return;
    return attachMarquee(editor, c);
  }, [editor]);

  // ⌘F / Ctrl+F finds in the page; ⌘⌥F / Ctrl+H also replaces. The selected text is the search.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const m = isMac ? e.metaKey : e.ctrlKey;
      if (!m || !editor) return;
      const key = e.key.toLowerCase();
      const replace = (key === "f" && e.altKey) || (!isMac && key === "h");
      if (key !== "f" && !replace) return;
      if (useStore.getState().settingsTab || useStore.getState().palette) return;
      e.preventDefault();
      const { from, to } = editor.state.selection;
      const sel = from !== to ? editor.state.doc.textBetween(from, to, " ").slice(0, 200) : "";
      setFind((f) => ({ replace: replace || !!f?.replace, seed: sel.includes("\n") ? "" : sel || f?.seed || "", n: (f?.n ?? 0) + 1 }));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [editor]);

  return (
    <div className="editor-wrap" ref={wrap}>
      {find && editor && (
        <div className="find-dock">
          <FindBar editor={editor} replace={find.replace} seed={find.seed} n={find.n} onClose={() => setFind(null)} />
        </div>
      )}
      <BlockHandle editor={editor} wrap={wrap} onAsk={(md) => useStore.getState().askAI(md ? `> ${md.split("\n").join("\n> ")}\n\n` : "")} />
      <EditorContent editor={editor} />
      <BubbleMenu editor={editor} options={{ placement: "top", offset: 8 }} shouldShow={({ editor, state }) => {
        const { from, to } = state.selection;
        if (from === to || state.selection instanceof NodeSelection) return false;
        // While finding, the selection jumps between matches: no format bar for that.
        const f = findState(state);
        if (f?.query && f.matches[f.index]?.from === from && f.matches[f.index]?.to === to) return false;
        return !editor.isActive("codeBlock");
      }}>
        <FormatBar editor={editor} onAI={runAI} />
      </BubbleMenu>
      <SuggestPopup />
      {ask && <AskBox ask={ask} onRun={runAsk} onAccept={acceptAsk} onClose={closeAsk} onStop={() => askAbort.current?.abort()} />}
      {aiBox && (
        <div className="ai-inline" role="dialog">
          <div className="ai-inline-head">
            <Sparkle size={15} weight="fill" />
            <span>{aiBox.label}</span>
            {!aiBox.done && <span className="dots" />}
            <button className="btn-icon sm push" onClick={() => setAiBox(null)} title={t("Descartar")}>
              <X size={14} />
            </button>
          </div>
          {aiBox.error ? (
            <div className="ai-inline-error">{aiBox.error}</div>
          ) : (
            <div className="ai-inline-body prose small" dangerouslySetInnerHTML={{ __html: renderMd(aiBox.text || "…") }} />
          )}
          {aiBox.done && !aiBox.error && (
            <div className="ai-inline-actions">
              {aiBox.from !== aiBox.to && (
                <button className="btn primary sm" onClick={() => applyAI("replace")}>
                  <Check size={14} /> {t("Reemplazar")}
                </button>
              )}
              <button className="btn sm" onClick={() => applyAI("below")}>
                <Plus size={14} /> {t("Insertar debajo")}
              </button>
              <button className="btn sm" onClick={() => navigator.clipboard.writeText(aiBox.text)}>
                <Copy size={14} /> {t("Copiar")}
              </button>
              <button className="btn ghost sm" onClick={() => runAI(aiBox.action, aiBox.label)}>
                <ArrowsClockwise size={14} /> {t("Otra vez")}
              </button>
            </div>
          )}
        </div>
      )}
      {tplMenu && (
        <div className="overlay" onMouseDown={() => setTplMenu(null)}>
          <div className="dialog small" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{t("Insertar plantilla")}</h3>
            <div className="list">
              {tplMenu.items.map((it) => (
                <button
                  key={it.path}
                  className="list-row"
                  onClick={async () => {
                    const p = await api.page(it.path);
                    const now = new Date();
                    const body = p.body
                      .replaceAll("{{title}}", pageRef.current.title)
                      .replaceAll("{{date}}", now.toISOString().slice(0, 10))
                      .replaceAll("{{time}}", now.toTimeString().slice(0, 5));
                    editor.chain().focus().insertContent(mdToHtml(body)).run();
                    setTplMenu(null);
                  }}
                >
                  <FileDashed size={16} /> {it.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) uploadFiles(files, editor);
          e.target.value = "";
        }}
      />
    </div>
  );
});

// ---------- ⌘. box ----------

type AskState = { top: number; from: number; to: number; prompt: string; out: string; phase: "input" | "run" | "done"; error?: string };

function AskBox({ ask, onRun, onAccept, onClose, onStop }: { ask: AskState; onRun: (p: string) => void; onAccept: () => void; onClose: () => void; onStop: () => void }) {
  const [text, setText] = useState(ask.prompt);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const st = useStore();
  const model = st.settings?.ai?.model ?? "";
  useEffect(() => {
    input.current?.focus();
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  useEffect(() => {
    if (ask.phase === "done") input.current?.focus();
  }, [ask.phase]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Enter on a finished answer with the same prompt keeps it; a changed prompt asks again.
      if (ask.phase === "done" && !ask.error && ask.out.trim() && text.trim() === ask.prompt.trim()) onAccept();
      else if (ask.phase !== "run") onRun(text);
    }
  };
  const selected = ask.from !== ask.to;
  return (
    <div className="ai-ask" ref={box} style={{ top: ask.top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="ai-ask-row">
        <div className="ai-ask-avatar" title={t("Modelo")}>
          <ModelPicker value={model} models={st.models} onChange={(id) => st.saveSettings({ ai: { model: id } })} />
        </div>
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={key}
          placeholder={selected ? t("¿Qué hago con el texto seleccionado?") : t("Editar con IA")}
          readOnly={ask.phase === "run"}
        />
        {ask.phase === "run" ? (
          <button className="ai-ask-send stop" onClick={onStop} title={t("Detener")}>
            <Stop size={13} weight="fill" />
          </button>
        ) : (
          <button className="ai-ask-send" disabled={!text.trim()} onClick={() => onRun(text)} title={t("Enviar")}>
            <ArrowUp size={14} weight="bold" />
          </button>
        )}
      </div>
      {(ask.phase !== "input" || ask.error) && (
        <div className="ai-ask-out">
          {ask.error ? (
            <div className="ai-inline-error">{ask.error}</div>
          ) : ask.out ? (
            <div className="prose small" dangerouslySetInnerHTML={{ __html: renderMd(ask.out) }} />
          ) : (
            <div className="typing">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      )}
      {ask.phase === "done" && !ask.error && ask.out.trim() && (
        <div className="ai-ask-actions">
          <button className="btn primary sm" onClick={onAccept}>
            <Check size={14} /> {selected ? t("Reemplazar") : t("Insertar")}
          </button>
          <button className="btn sm" onClick={() => onRun(text)}>
            <ArrowsClockwise size={14} /> {t("Otra vez")}
          </button>
          <button className="btn ghost sm" onClick={onClose}>
            <X size={14} /> {t("Descartar")}
          </button>
          <span className="push muted xs">{t("Enter para insertar · Esc para cerrar")}</span>
        </div>
      )}
      {ask.phase === "input" && !ask.error && (
        <div className="ai-ask-hint muted xs">
          {selected ? t("Reescribe la selección usando toda la página como contexto.") : t("Escribe en esta línea usando toda la página como contexto.")} · {showCombo(st.settings?.ai_shortcut ?? "")}
        </div>
      )}
    </div>
  );
}

// ---------- formatting bar (selection) ----------

const AI_ACTIONS: [string, string][] = [
  ["improve", "Mejorar la redacción"],
  ["fix", "Corregir ortografía"],
  ["shorten", "Acortar"],
  ["expand", "Extender"],
  ["summarize", "Resumir"],
  ["tasks", "Sacar tareas"],
  ["table", "Convertir en tabla"],
  ["translate", "Traducir"],
  ["explain", "Explicar"],
];

function FormatBar({ editor, onAI }: { editor: TEditor; onAI: (a: string, label: string, extra?: string) => void }) {
  const [ai, setAi] = useState(false);
  const [turn, setTurn] = useState(false);
  const [ask, setAsk] = useState("");
  const btn = (active: boolean, onClick: () => void, icon: any, title: string) => {
    const I = icon;
    return (
      <button className={`fmt ${active ? "on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title}>
        <I size={16} weight="bold" />
      </button>
    );
  };
  return (
    <div className="format-bar" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <button className="fmt ai" onMouseDown={(e) => e.preventDefault()} onClick={() => (setAi(!ai), setTurn(false))}>
        <Sparkle size={15} weight="fill" /> <span>{t("IA")}</span>
      </button>
      <span className="fmt-sep" />
      <button className="fmt" onMouseDown={(e) => e.preventDefault()} onClick={() => (setTurn(!turn), setAi(false))} title={t("Convertir en")}>
        <TextH size={16} weight="bold" />
      </button>
      {btn(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), TextB, t("Negrita"))}
      {btn(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), TextItalic, t("Cursiva"))}
      {btn(editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), TextStrikethrough, t("Tachado"))}
      {btn(editor.isActive("code"), () => editor.chain().focus().toggleCode().run(), Code, t("Código"))}
      {btn(editor.isActive("highlight"), () => editor.chain().focus().toggleHighlight().run(), HighlighterCircle, t("Resaltar"))}
      {btn(
        editor.isActive("link"),
        () => {
          if (editor.isActive("link")) return editor.chain().focus().unsetLink().run();
          const url = prompt(t("Enlace (https://…)"));
          if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        },
        LinkSimple,
        t("Enlace"),
      )}
      {ai && (
        <div className="menu fmt-menu">
          <form
            className="menu-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (ask.trim()) {
                onAI("custom", ask.trim(), ask.trim());
                setAsk("");
                setAi(false);
              }
            }}
          >
            <Sparkle size={14} />
            <input autoFocus placeholder={t("Pedile algo a la IA…")} value={ask} onChange={(e) => setAsk(e.target.value)} />
          </form>
          {AI_ACTIONS.map(([a, l]) => (
            <button
              key={a}
              className="menu-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setAi(false);
                onAI(a, t(l));
              }}
            >
              {t(l)}
            </button>
          ))}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setAi(false);
              const { from, to } = editor.state.selection;
              const slice = editor.state.doc.cut(from, to);
              const md = docToMd(slice.toJSON() as any).trim();
              useStore.getState().askAI(`> ${md.split("\n").join("\n> ")}\n\n`);
            }}
          >
            {t("Preguntar en el chat")}
          </button>
        </div>
      )}
      {turn && (
        <div className="menu fmt-menu">
          {(
            [
              ["Texto", TextT, () => editor.chain().focus().setParagraph().run()],
              ["Título 1", TextHOne, () => editor.chain().focus().setHeading({ level: 1 }).run()],
              ["Título 2", TextHTwo, () => editor.chain().focus().setHeading({ level: 2 }).run()],
              ["Título 3", TextHThree, () => editor.chain().focus().setHeading({ level: 3 }).run()],
              ["Título 4", TextHFour, () => editor.chain().focus().setHeading({ level: 4 }).run()],
              ["Lista", ListBullets, () => editor.chain().focus().toggleBulletList().run()],
              ["Lista numerada", ListNumbers, () => editor.chain().focus().toggleOrderedList().run()],
              ["Tareas", CheckSquare, () => editor.chain().focus().toggleTaskList().run()],
              ["Cita", Quotes, () => editor.chain().focus().toggleBlockquote().run()],
              ["Código", CodeBlock, () => editor.chain().focus().toggleCodeBlock().run()],
            ] as [string, any, () => void][]
          ).map(([l, I, f]) => (
            <button key={l} className="menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => (f(), setTurn(false))}>
              <I size={16} /> {t(l)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- suggestion popup ("/" and "[[") ----------

function SuggestPopup() {
  const p = usePopup();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!p.open || !p.rect) return;
    const h = box.current?.offsetHeight ?? 300;
    const w = box.current?.offsetWidth ?? 300;
    let top = p.rect.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, p.rect.top - h - 6);
    const left = Math.min(p.rect.left, window.innerWidth - w - 12);
    setPos({ top, left });
  }, [p.open, p.rect, p.items.length]);
  useEffect(() => {
    box.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [p.index]);
  if (!p.open) return null;
  let lastGroup = "";
  return (
    <div className={`suggest ${p.kind}`} ref={box} style={{ top: pos.top, left: pos.left }} onMouseDown={(e) => e.preventDefault()}>
      {!p.items.length && <div className="suggest-empty">{p.kind === "link" ? t("Escribí el nombre de una página") : t("Nada coincide")}</div>}
      {p.items.map((it, i) => {
        const I = ICONS[it.icon ?? "text"] ?? TextT;
        const head = it.group && it.group !== lastGroup ? it.group : "";
        lastGroup = it.group ?? "";
        return (
          <div key={it.id}>
            {head && <div className="suggest-group">{head}</div>}
            <button
              className={`suggest-item ${i === p.index ? "sel" : ""}`}
              onMouseEnter={() => usePopup.setState({ index: i })}
              onClick={() => p.select?.(it)}
            >
              <span className="suggest-icon">
                <I size={16} weight={it.icon === "ai" ? "fill" : "regular"} />
              </span>
              <span className="suggest-title">{it.title}</span>
              {it.hint && <span className="suggest-hint">{it.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- block handle (drag to move, + to insert, menu) ----------

function BlockHandle({ editor, wrap, onAsk }: { editor: TEditor; wrap: React.RefObject<HTMLDivElement | null>; onAsk: (md: string) => void }) {
  // `nested`: a block inside a column (only the grip fits in the gap between columns).
  const [block, setBlock] = useState<{ top: number; left?: number; el: HTMLElement; nested: boolean } | null>(null);
  const [menu, setMenu] = useState(false);
  const [drop, setDrop] = useState<null | { pos: number; side: "left" | "right"; x: number; top: number; height: number }>(null);
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const hideT = useRef<number>(0);

  /** The block under (x, y): a top-level block, or a block inside the column under the pointer. */
  const blockAt = (x: number, y: number): { el: HTMLElement; nested: boolean } | null => {
    const dom = editor.view.dom as HTMLElement;
    const kids = Array.from(dom.children) as HTMLElement[];
    const hit = kids.find((k) => {
      const r = k.getBoundingClientRect();
      return y >= r.top - 4 && y <= r.bottom + 4;
    });
    if (!hit) return null;
    if (hit.classList.contains("ob-columns-wrap")) {
      const cols = Array.from(hit.querySelectorAll<HTMLElement>(":scope > .ob-columns > .ob-column"));
      const col = cols.find((c) => {
        const r = c.getBoundingClientRect();
        return x >= r.left - 14 && x <= r.right + 14;
      });
      const inner = col
        ? (Array.from(col.children) as HTMLElement[]).find((k) => {
            const r = k.getBoundingClientRect();
            return y >= r.top - 4 && y <= r.bottom + 4;
          })
        : null;
      if (inner) return { el: inner, nested: true };
    }
    return { el: hit, nested: false };
  };

  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const move = (e: MouseEvent) => {
      if (menu) return;
      const hit = blockAt(e.clientX, e.clientY);
      if (hit) {
        window.clearTimeout(hideT.current);
        const wr = w.getBoundingClientRect();
        const r = hit.el.getBoundingClientRect();
        const style = getComputedStyle(hit.el);
        const lh = parseFloat(style.lineHeight) || 24;
        const firstLine = Math.min(r.height, lh);
        setBlock({
          top: r.top - wr.top + firstLine / 2 - 12 + (parseFloat(style.paddingTop) || 0),
          left: hit.nested ? r.left - wr.left - 26 : undefined,
          el: hit.el,
          nested: hit.nested,
        });
      }
    };
    const leave = () => {
      hideT.current = window.setTimeout(() => !menu && setBlock(null), 400);
    };
    w.addEventListener("mousemove", move);
    w.addEventListener("mouseleave", leave);
    return () => {
      w.removeEventListener("mousemove", move);
      w.removeEventListener("mouseleave", leave);
    };
  }, [editor, wrap, menu]);

  /** Where a block element starts in the document. */
  const posOf = (el: HTMLElement): number | null => {
    const view = editor.view;
    let found: number | null = null;
    view.state.doc.forEach((_n, offset) => {
      if (found == null && view.nodeDOM(offset) === el) found = offset;
    });
    if (found != null) return found;
    try {
      const pos = view.posAtDOM(el, 0);
      const $p = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
      for (let d = $p.depth; d > 0; d--) {
        if (d === 1 || $p.node(d - 1).type.name === "column") return $p.before(d);
      }
      return pos;
    } catch {
      return null;
    }
  };

  const blockPos = (): number | null => (block ? posOf(block.el) : null);

  const onDragStart = (e: React.DragEvent) => {
    const pos = blockPos();
    if (pos == null || !block) return;
    const view = editor.view;
    const sel = NodeSelection.create(view.state.doc, pos);
    view.dispatch(view.state.tr.setSelection(sel));
    const slice = sel.content();
    // ProseMirror reads `view.dragging` on drop and moves the block.
    (view as any).dragging = { slice, move: true };
    e.dataTransfer.effectAllowed = "copyMove";
    const div = document.createElement("div");
    div.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content));
    e.dataTransfer.setData("text/html", div.innerHTML);
    e.dataTransfer.setData("text/plain", view.state.doc.textBetween(sel.from, sel.to, "\n"));
    e.dataTransfer.setDragImage(block.el, 0, 0);
  };

  // Dragging a block to the side of another one puts them in columns.
  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const over = (e: DragEvent) => {
      const view = editor.view;
      const sel = view.state.selection;
      const dragging = (view as any).dragging;
      if (!dragging || !(sel instanceof NodeSelection) || sel.node.type.name === "columns") return setDrop(null);
      const hit = blockAt(e.clientX, e.clientY);
      if (!hit) return setDrop(null);
      const r = hit.el.getBoundingClientRect();
      const edge = Math.min(90, r.width * 0.18);
      const side = e.clientX > r.right - edge ? "right" : e.clientX < r.left - 6 ? "left" : null;
      const pos = side ? posOf(hit.el) : null;
      if (!side || pos == null || pos === sel.from) return setDrop(null);
      if (hit.nested) {
        const row = hit.el.closest(".ob-columns");
        if (row && row.children.length >= MAX_COLUMNS) return setDrop(null);
      }
      const wr = w.getBoundingClientRect();
      setDrop({ pos, side, x: (side === "right" ? r.right + 6 : r.left - 9) - wr.left, top: r.top - wr.top, height: r.height });
    };
    const end = () => setDrop(null);
    w.addEventListener("dragover", over);
    w.addEventListener("dragleave", (e) => !w.contains(e.relatedTarget as any) && end());
    window.addEventListener("dragend", end);
    window.addEventListener("drop", () => setTimeout(end));
    return () => {
      w.removeEventListener("dragover", over);
      window.removeEventListener("dragend", end);
    };
  }, [editor, wrap]);

  useEffect(() => {
    document.body.classList.toggle("ob-side-drop", !!drop);
  }, [drop]);

  // The editor asks before its own drop: a side drop wins.
  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    const onDrop = (e: DragEvent) => {
      const d = dropRef.current;
      const view = editor.view;
      const sel = view.state.selection;
      if (!d || !(sel instanceof NodeSelection)) return;
      e.preventDefault();
      e.stopPropagation();
      (view as any).dragging = null;
      dropBeside(view, d.pos, d.side, sel.node, sel.from, sel.to);
      setDrop(null);
    };
    dom.addEventListener("drop", onDrop, true);
    return () => dom.removeEventListener("drop", onDrop, true);
  }, [editor]);

  const insertBelow = () => {
    const pos = blockPos();
    if (pos == null) return;
    const node = editor.state.doc.nodeAt(pos);
    const at = pos + (node?.nodeSize ?? 0);
    editor.chain().insertContentAt(at, { type: "paragraph", content: [{ type: "text", text: "/" }] }).run();
    editor.commands.setTextSelection(at + 2);
    editor.commands.focus();
  };

  const act = (what: string) => {
    const pos = blockPos();
    setMenu(false);
    if (pos == null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    if (what === "delete") editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    if (what === "duplicate") editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON()).run();
    if (what === "copy") {
      const md = docToMd({ type: "doc", content: [node.toJSON()] } as any);
      navigator.clipboard.writeText(md);
    }
    if (what === "ai") onAsk(docToMd({ type: "doc", content: [node.toJSON()] } as any).trim());
    if (what === "uncolumns" && node.type.name === "columns") {
      // Back to plain blocks, one column after the other.
      const blocks: any[] = [];
      node.forEach((col) => col.forEach((b) => blocks.push(b)));
      editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, blocks));
    }
    if (what.startsWith("columns:")) {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
      insertColumns(editor, Number(what.slice(8)));
    }
    if (what.startsWith("turn:")) {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 1)));
      const c = editor.chain().focus();
      const k = what.slice(5);
      if (k === "p") c.setParagraph().run();
      else if (k.startsWith("toggle")) setToggleHeading(editor, Number(k.slice(6)));
      else if (k.startsWith("h")) c.setHeading({ level: Number(k[1]) as 1 | 2 | 3 | 4 }).run();
      else if (k === "ul") c.toggleBulletList().run();
      else if (k === "task") c.toggleTaskList().run();
      else if (k === "quote") c.toggleBlockquote().run();
    }
  };

  const isColumns = !!block?.el.classList.contains("ob-columns-wrap");
  if (!block && !drop) return null;
  if (!editor.isEditable) return null;
  return (
    <>
      {drop && <div className="ob-col-drop" style={{ left: drop.x, top: drop.top, height: drop.height }} />}
      {block && (
        <div
          className={`block-handle ${block.nested ? "nested" : ""}`}
          style={{ top: block.top, left: block.left }}
          onMouseEnter={() => window.clearTimeout(hideT.current)}
        >
          {!block.nested && (
            <button className="handle-btn" onClick={insertBelow} title={t("Insertar un bloque debajo")}>
              <Plus size={15} />
            </button>
          )}
          <button className="handle-btn grip" draggable onDragStart={onDragStart} onClick={() => setMenu(!menu)} title={t("Arrastrá para mover · clic para opciones")}>
            <DotsSixVertical size={16} weight="bold" />
          </button>
          {menu && (
            <div className="menu handle-menu" onMouseLeave={() => setMenu(false)}>
              <button className="menu-item" onClick={() => act("ai")}>
                <Sparkle size={15} /> {t("Preguntarle a la IA")}
              </button>
              <div className="menu-sep" />
              {isColumns ? (
                <button className="menu-item" onClick={() => act("uncolumns")}>
                  <ColumnsIcon size={15} /> {t("Quitar las columnas")}
                </button>
              ) : (
                <>
                  <div className="menu-label">{t("Convertir en")}</div>
                  <button className="menu-item" onClick={() => act("turn:p")}>
                    <TextT size={15} /> {t("Texto")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:h1")}>
                    <TextHOne size={15} /> {t("Título 1")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:h2")}>
                    <TextHTwo size={15} /> {t("Título 2")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:h3")}>
                    <TextHThree size={15} /> {t("Título 3")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:h4")}>
                    <TextHFour size={15} /> {t("Título 4")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:toggle2")}>
                    <CaretCircleDown size={15} /> {t("Título desplegable")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:ul")}>
                    <ListBullets size={15} /> {t("Lista")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:task")}>
                    <CheckSquare size={15} /> {t("Tareas")}
                  </button>
                  <button className="menu-item" onClick={() => act("turn:quote")}>
                    <Quotes size={15} /> {t("Cita")}
                  </button>
                  {!block.nested && (
                    <button className="menu-item" onClick={() => act("columns:2")}>
                      <ColumnsIcon size={15} /> {t("Columnas")}
                    </button>
                  )}
                </>
              )}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => act("duplicate")}>
                <Copy size={15} /> {t("Duplicar")}
              </button>
              <button className="menu-item" onClick={() => act("copy")}>
                <CodeBlock size={15} /> {t("Copiar como Markdown")}
              </button>
              <button className="menu-item danger" onClick={() => act("delete")}>
                <Trash size={15} /> {t("Borrar")}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

