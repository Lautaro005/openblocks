import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Stop,
  X,
  Plus,
  ClockCounterClockwise,
  Globe,
  At,
  FileText,
  CaretDown,
  CaretRight,
  Wrench,
  Check,
  WarningCircle,
  ArrowCounterClockwise,
  ArrowSquareOut,
  Copy,
  Trash,
  Brain as BrainIcon,
  MagnifyingGlass,
  Sparkle,
  ArrowsClockwise,
  Lightning,
  Paperclip,
  FolderSimplePlus,
  ArrowRight,
  File as FileIcon,
} from "@phosphor-icons/react";
import { api, stream, stem, type Model } from "../lib/api";
import { useStore } from "../lib/store";
import { t, timeAgo } from "../lib/i18n";
import { renderMd } from "../lib/render";
import { Brand } from "./Brand";

type Msg = {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools?: { name: string; input?: any; done?: boolean; ok?: boolean; summary?: string }[];
  edits?: any[];
  model?: string;
  error?: string;
  context?: string[];
  files?: { id: string; name: string }[];
};

type Attached = { id?: string; name: string; size: number; readable?: boolean; uploading?: boolean; error?: string };

const TOOL_LABEL: Record<string, string> = {
  search_pages: "Buscó en el vault",
  read_page: "Leyó una página",
  list_pages: "Miró las carpetas",
  backlinks: "Miró los enlaces",
  create_page: "Creó una página",
  edit_page: "Editó una página",
  set_property: "Cambió una propiedad",
  create_folder: "Creó una carpeta",
  move: "Movió",
  delete: "Mandó a la papelera",
  read_attachment: "Leyó un adjunto",
  save_attachment: "Guardó un adjunto en el vault",
  find_images: "Buscó imágenes",
  web_search: "Buscó en la web",
  web_fetch: "Leyó una página web",
  brain_search: "Buscó en brain",
  lumina_search: "Buscó en Lumina",
};

function toolLabel(tl: { name: string; input?: any }) {
  const base = t(TOOL_LABEL[tl.name] ?? tl.name);
  const arg = tl.input?.query ?? tl.input?.path ?? tl.input?.from ?? tl.input?.title ?? tl.input?.name ?? tl.input?.url ?? "";
  return arg ? `${base}: ${String(arg).replace(/\.md$/, "")}` : base;
}

export function AiPanel() {
  const st = useStore();
  const route = st.route;
  const pagePath = route.kind === "page" ? route.path : null;
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [usePage, setUsePage] = useState(true);
  const [mentions, setMentions] = useState<string[]>([]);
  const [files, setFiles] = useState<Attached[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pills, setPills] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("ob-pills") ?? "[]");
    } catch {
      return [];
    }
  });
  const [history, setHistory] = useState<any[] | null>(null);
  const [family, setFamily] = useState<any>(null);
  const [mention, setMention] = useState<{ q: string; items: any[]; i: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const model = st.settings?.ai?.model ?? "";

  useEffect(() => {
    api.family().then(setFamily).catch(() => {});
  }, []);

  useEffect(() => {
    if (!st.aiSeed) return;
    setText((x) => (st.aiSeed!.text ? st.aiSeed!.text + x : x));
    setTimeout(() => ta.current?.focus(), 30);
  }, [st.aiSeed]);

  useEffect(() => {
    setTimeout(() => ta.current?.focus(), 60);
  }, []);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = Math.min(220, el.scrollHeight) + "px";
  }, [text]);

  useEffect(() => {
    localStorage.setItem("ob-pills", JSON.stringify(pills));
  }, [pills]);

  const current = st.models.find((m) => m.id === model);
  const isAgent = model.startsWith("opencue:");

  const attach = async (list: File[]) => {
    for (const f of list) {
      const tmp: Attached = { name: f.name, size: f.size, uploading: true };
      setFiles((x) => [...x, tmp]);
      try {
        const r = await api.attach(f);
        setFiles((x) => x.map((a) => (a === tmp ? { ...r } : a)));
      } catch (e: any) {
        setFiles((x) => x.map((a) => (a === tmp ? { ...a, uploading: false, error: e.message } : a)));
      }
    }
    ta.current?.focus();
  };

  const send = async (override?: string) => {
    const ready = files.filter((f) => f.id);
    const body = (override ?? text).trim() || (override === undefined && ready.length ? t("Leé los archivos adjuntos.") : "");
    if (!body || busy) return;
    if (files.some((f) => f.uploading)) {
      st.toast(t("Esperá a que terminen de subir los archivos."));
      return;
    }
    if (!model) {
      st.toast(t("Elegí un modelo en el selector de abajo."), "error");
      return;
    }
    setText("");
    setMention(null);
    const ctx = [...(usePage && pagePath ? [pagePath] : []), ...mentions];
    const sentFiles = override === undefined ? ready.map((f) => ({ id: f.id!, name: f.name })) : [];
    setMsgs((m) => [...m, { role: "user", text: body, context: ctx, files: sentFiles }, { role: "assistant", text: "", tools: [], edits: [], model }]);
    setMentions([]);
    if (override === undefined) setFiles([]);
    setBusy(true);
    const patch = (f: (m: Msg) => Msg) =>
      setMsgs((all) => {
        const c = [...all];
        c[c.length - 1] = f({ ...c[c.length - 1] });
        return c;
      });
    try {
      await stream(
        "/api/ai/send",
        { chat: chatId, text: body, model, pills, page: usePage ? pagePath : null, mentions, files: sentFiles.map((f) => f.id) },
        (ev) => {
          if (ev.kind === "start") setChatId(ev.chat);
          if (ev.kind === "delta") patch((m) => ({ ...m, text: m.text + ev.text }));
          if (ev.kind === "thinking") patch((m) => ({ ...m, thinking: (m.thinking ?? "") + ev.text }));
          if (ev.kind === "tool") patch((m) => ({ ...m, tools: [...(m.tools ?? []), { name: ev.name, input: ev.input }] }));
          if (ev.kind === "tool_done")
            patch((m) => {
              const tools = [...(m.tools ?? [])];
              const i = tools.map((x) => !x.done).lastIndexOf(true);
              if (i >= 0) tools[i] = { ...tools[i], done: true, ok: ev.ok, summary: ev.summary };
              return { ...m, tools };
            });
          if (ev.kind === "edit") {
            patch((m) => ({ ...m, edits: [...(m.edits ?? []), ev.edit] }));
            useStore.getState().refreshTree();
            const s = useStore.getState();
            useStore.setState({ external: { n: s.external.n + 1, paths: [ev.edit.path] } });
            // The open page was moved or deleted by the agent: follow it, or go home.
            const r = s.route;
            if (r.kind === "page" && ev.edit.action === "move" && ev.edit.from === r.path) s.go({ kind: "page", path: ev.edit.path });
            if (r.kind === "page" && ev.edit.action === "delete" && ev.edit.path === r.path) s.go({ kind: "home" });
          }
          if (ev.kind === "error") patch((m) => ({ ...m, error: ev.text }));
        },
      );
    } catch (e: any) {
      patch((m) => ({ ...m, error: e.message }));
    } finally {
      setBusy(false);
    }
  };

  const stop = () => chatId && api.stopChat(chatId);

  const newChat = () => {
    if (busy) return;
    setChatId(null);
    setMsgs([]);
    setHistory(null);
  };

  const openChat = async (id: string) => {
    const c = await api.chat(id);
    setChatId(c.id);
    setMsgs(c.messages);
    setHistory(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (mention) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention({ ...mention, i: (mention.i + 1) % Math.max(1, mention.items.length) });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention({ ...mention, i: (mention.i - 1 + mention.items.length) % Math.max(1, mention.items.length) });
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && mention.items[mention.i]) {
        e.preventDefault();
        pickMention(mention.items[mention.i].path);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const onInput = async (v: string) => {
    setText(v);
    const caret = ta.current?.selectionStart ?? v.length;
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(v.slice(0, caret));
    if (m) {
      const items = await api.titles(m[2], 6).catch(() => []);
      setMention({ q: m[2], items: items.filter((x) => x.kind === "page"), i: 0 });
    } else setMention(null);
  };

  const pickMention = (path: string) => {
    const caret = ta.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/(^|\s)@[^\s@]*$/, "$1");
    setText(before + text.slice(caret));
    if (!mentions.includes(path) && path !== pagePath) setMentions([...mentions, path]);
    setMention(null);
    ta.current?.focus();
  };

  const familyOn = (id: string) => family?.[id]?.installed && family?.[id]?.enabled !== false;
  const togglePill = (p: string) => setPills(pills.includes(p) ? pills.filter((x) => x !== p) : [...pills, p]);

  return (
    <aside
      className={`ai-panel ${dragging ? "dropping" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        const list = Array.from(e.dataTransfer.files ?? []);
        setDragging(false);
        if (list.length) {
          e.preventDefault();
          attach(list);
        }
      }}
    >
      <header className="panel-head">
        <Sparkle size={16} weight="fill" className="ai-mark" />
        <span className="panel-title">{history ? t("Conversaciones") : t("Asistente")}</span>
        <div className="push" />
        <button
          className="btn-icon"
          title={t("Conversaciones anteriores")}
          onClick={async () => setHistory(history ? null : await api.chats().catch(() => []))}
        >
          <ClockCounterClockwise size={17} />
        </button>
        <button className="btn-icon" title={t("Conversación nueva")} onClick={newChat}>
          <Plus size={17} />
        </button>
        <button className="btn-icon" title={t("Cerrar")} onClick={() => st.setPanel(null)}>
          <X size={17} />
        </button>
      </header>

      {history ? (
        <div className="ai-history">
          {!history.length && <p className="muted pad">{t("Todavía no hay conversaciones en este vault.")}</p>}
          {history.map((c) => (
            <div key={c.id} className="ai-history-row">
              <button className="ai-history-open" onClick={() => openChat(c.id)}>
                <b>{c.title || t("Sin título")}</b>
                <span>{timeAgo(c.updated)}</span>
              </button>
              <button
                className="btn-icon xs"
                title={t("Borrar")}
                onClick={async () => {
                  await api.deleteChat(c.id);
                  setHistory(history.filter((x) => x.id !== c.id));
                  if (chatId === c.id) newChat();
                }}
              >
                <Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="ai-scroll" ref={scroll}>
          {!msgs.length && <Welcome pagePath={pagePath} onPick={(s) => send(s)} model={current} />}
          {msgs.map((m, i) => (
            <Message key={i} m={m} last={i === msgs.length - 1} busy={busy} onRetry={() => {
              const u = msgs[i - 1];
              if (u?.role === "user") {
                setMsgs(msgs.slice(0, i - 1));
                send(u.text);
              }
            }} />
          ))}
        </div>
      )}

      <div className="composer">
        {mention && mention.items.length > 0 && (
          <div className="mention-pop">
            {mention.items.map((it, i) => (
              <button key={it.path} className={`suggest-item ${i === mention.i ? "sel" : ""}`} onMouseDown={(e) => (e.preventDefault(), pickMention(it.path))}>
                <FileText size={15} /> <span className="suggest-title">{it.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-ctx">
          {pagePath && (
            <button className={`ctx-chip ${usePage ? "on" : "off"}`} onClick={() => setUsePage(!usePage)} title={t("Mandar la página abierta como contexto")}>
              <FileText size={13} /> {stem(pagePath)}
              {usePage ? <X size={11} /> : <Plus size={11} />}
            </button>
          )}
          {mentions.map((m) => (
            <button key={m} className="ctx-chip on" onClick={() => setMentions(mentions.filter((x) => x !== m))}>
              <At size={13} /> {stem(m)} <X size={11} />
            </button>
          ))}
          {files.map((f, i) => (
            <button
              key={i}
              className={`ctx-chip file ${f.error ? "bad" : "on"}`}
              title={f.error ?? (f.readable === false ? t("No tiene texto legible (imagen o escaneo)") : f.name)}
              onClick={() => setFiles(files.filter((x) => x !== f))}
            >
              {f.uploading ? <span className="spin" /> : <Paperclip size={13} />} {f.name}
              {f.readable === false && <WarningCircle size={12} />} <X size={11} />
            </button>
          ))}
        </div>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={isAgent ? t("Escribile a {a}…", { a: current?.name ?? "" }) : t("Preguntá, pedí que escriba u ordene tus notas… (@ para sumar páginas)")}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="composer-bar">
          <button className="btn-icon sm" title={t("Adjuntar archivos (PDF, Word, Excel, texto…)")} onClick={() => fileInput.current?.click()}>
            <Paperclip size={16} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (list.length) attach(list);
            }}
          />
          <ModelPicker value={model} models={st.models} onChange={(id) => st.saveSettings({ ai: { model: id } })} />
          {(
            <>
              <button className={`pill ${pills.includes("web") ? "on" : ""}`} onClick={() => togglePill("web")} title={t("Buscar en la web")}>
                <Globe size={14} /> {t("Web")}
              </button>
              {familyOn("brain") && (
                <button className={`pill ${pills.includes("brain") ? "on" : ""}`} onClick={() => togglePill("brain")} title={t("Buscar en brain, tu memoria")}>
                  <Brand name="brain" size={14} /> brain
                </button>
              )}
              {familyOn("lumina") && (
                <button className={`pill ${pills.includes("lumina") ? "on" : ""}`} onClick={() => togglePill("lumina")} title={t("Buscar en tus reuniones de Lumina")}>
                  <Brand name="lumina" size={14} /> Lumina
                </button>
              )}
            </>
          )}
          <div className="push" />
          {busy ? (
            <button className="send stop" onClick={stop} title={t("Detener")}>
              <Stop size={15} weight="fill" />
            </button>
          ) : (
            <button className="send" onClick={() => send()} disabled={!text.trim() && !files.some((f) => f.id)} title={t("Enviar")}>
              <ArrowUp size={16} weight="bold" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Welcome({ pagePath, onPick, model }: { pagePath: string | null; onPick: (s: string) => void; model?: Model }) {
  const ideas = pagePath
    ? [t("Resumí esta página en 5 puntos"), t("Sacá las tareas pendientes de esta página"), t("¿Qué otras notas se relacionan con esta?"), t("Mejorá la redacción de esta página")]
    : [t("¿Qué escribí esta semana?"), t("Armá una página con un plan para mañana"), t("Buscá mis notas sobre…"), t("Ordená las páginas sueltas en carpetas")];
  return (
    <div className="ai-welcome">
      <div className="ai-welcome-mark">
        <Sparkle size={22} weight="fill" />
      </div>
      <h3>{t("¿En qué te ayudo?")}</h3>
      <p className="muted">
        {model?.provider === "OpenCue"
          ? t("Tu agente de OpenCue trabaja acá con su personalidad y su memoria, sobre tus páginas.")
          : t("Lee y edita tus páginas. Cada cambio queda en el historial y se puede deshacer.")}
      </p>
      <div className="ai-ideas">
        {ideas.map((i) => (
          <button key={i} className="idea" onClick={() => !i.endsWith("…") && onPick(i)}>
            <Lightning size={14} /> {i}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ m, last, busy, onRetry }: { m: Msg; last: boolean; busy: boolean; onRetry: () => void }) {
  const [think, setThink] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const html = useMemo(() => (m.role === "assistant" ? renderMd(m.text) : ""), [m.text, m.role]);
  const onClick = async (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const target = a.getAttribute("data-target");
    if (target) {
      const r = await api.resolve(target);
      if (r.path) useStore.getState().openPath(r.path);
      return;
    }
    const href = a.getAttribute("href");
    if (href && href !== "#") api.openUrl(href);
  };
  if (m.role === "user")
    return (
      <div className="msg user">
        <div className="bubble" dangerouslySetInnerHTML={{ __html: renderMd(m.text) }} />
        {!!(m.context?.length || m.files?.length) && (
          <div className="msg-ctx">
            {m.context?.map((c) => (
              <span key={c}>
                <FileText size={11} /> {stem(c)}
              </span>
            ))}
            {m.files?.map((f) => (
              <span key={f.id}>
                <Paperclip size={11} /> {f.name}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  const working = last && busy;
  const tools = m.tools ?? [];
  return (
    <div className="msg assistant">
      <div className="msg-model">
        <Brand name={providerOf(m.model ?? "")} size={13} />
        <span>{modelName(m.model ?? "")}</span>
      </div>
      {m.thinking && (
        <button className="thinking" onClick={() => setThink(!think)}>
          {think ? <CaretDown size={12} /> : <CaretRight size={12} />} {working && !m.text ? t("Pensando…") : t("Razonamiento")}
        </button>
      )}
      {think && m.thinking && <div className="thinking-body">{m.thinking}</div>}
      {tools.length > 0 && (
        <div className="tools">
          <button className="tools-head" onClick={() => setToolsOpen(!toolsOpen)}>
            <Wrench size={13} />
            <span>{tools.length === 1 ? toolLabel(tools[0]) : t("{n} pasos", { n: tools.length })}</span>
            {working && tools.some((x) => !x.done) ? <span className="dots" /> : toolsOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </button>
          {(toolsOpen || (working && tools.length > 1)) && (
            <div className="tools-list">
              {tools.map((x, i) => (
                <div key={i} className={`tool-row ${x.done ? (x.ok === false ? "bad" : "ok") : "run"}`}>
                  {x.done ? x.ok === false ? <WarningCircle size={13} /> : <Check size={13} /> : <span className="spin" />}
                  <span>{toolLabel(x)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {(m.edits ?? []).map((e, i) => (
        <EditCard key={i} e={e} />
      ))}
      {m.text ? (
        <div className="prose small answer" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      ) : working && !m.error ? (
        <div className="typing">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {m.error && (
        <div className="msg-error">
          <WarningCircle size={15} /> <span>{m.error}</span>
          <button className="btn ghost xs" onClick={onRetry}>
            <ArrowsClockwise size={13} /> {t("Reintentar")}
          </button>
        </div>
      )}
      {!working && m.text && (
        <div className="msg-actions">
          <button className="btn-icon xs" title={t("Copiar")} onClick={() => navigator.clipboard.writeText(m.text)}>
            <Copy size={13} />
          </button>
          <button className="btn-icon xs" title={t("Insertar en la página")} onClick={() => insertIntoPage(m.text)}>
            <FileText size={13} />
          </button>
          <button className="btn-icon xs" title={t("Otra respuesta")} onClick={onRetry}>
            <ArrowsClockwise size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

async function insertIntoPage(md: string) {
  const st = useStore.getState();
  const r = st.route;
  if (r.kind !== "page") {
    const p = await st.newPage("", t("Respuesta de la IA"), "");
    if (!p) return;
    await api.savePage(p, md, null);
    useStore.setState({ external: { n: st.external.n + 1, paths: [p] } });
    return;
  }
  const pg = await api.page(r.path);
  await api.savePage(r.path, pg.body.trimEnd() + "\n\n" + md.trim() + "\n", null);
  useStore.setState({ external: { n: useStore.getState().external.n + 1, paths: [r.path] } });
  st.toast(t("Agregado al final de la página."), "ok");
}

const EDIT_KIND: Record<string, [any, string]> = {
  create: [Plus, "Página nueva"],
  edit: [FileText, "Página editada"],
  folder: [FolderSimplePlus, "Carpeta nueva"],
  move: [ArrowRight, "Movida"],
  delete: [Trash, "En la papelera"],
  replace: [FileText, "Archivo reescrito"],
};

function EditCard({ e }: { e: any }) {
  const [undone, setUndone] = useState(false);
  const [I, label] = EDIT_KIND[e.action] ?? EDIT_KIND.edit;
  const isFile = e.path && !/\.(md|markdown)$/i.test(e.path) && e.action !== "folder";
  const where = e.action === "move" ? `${stem(e.from ?? "")} → ${e.path}` : "";
  return (
    <div className={`edit-card ${undone ? "undone" : ""}`}>
      <div className="edit-icon">{isFile && e.action === "create" ? <FileIcon size={14} /> : <I size={14} />}</div>
      <div className="edit-meta">
        <span>
          {isFile && e.action === "create"
            ? /\.html?$/i.test(e.path)
              ? t("Artefacto nuevo")
              : /\.(xlsx|csv|tsv)$/i.test(e.path)
                ? t("Planilla nueva")
                : t("Archivo guardado")
            : isFile && e.action === "edit"
              ? t("Archivo reescrito")
              : t(label)}
        </span>
        <b title={where || e.path}>{e.title}</b>
      </div>
      {!undone && (
        <>
          {e.action !== "delete" && (
            <button
              className="btn-icon xs"
              title={t("Abrir")}
              onClick={() => useStore.getState().openPath(e.path, e.action === "folder" ? "folder" : undefined)}
            >
              <ArrowSquareOut size={14} />
            </button>
          )}
          <button
            className="btn xs"
            onClick={async () => {
              try {
                await api.undo(e);
                setUndone(true);
                const st = useStore.getState();
                await st.refreshTree();
                useStore.setState({ external: { n: st.external.n + 1, paths: [e.path] } });
                const onIt = st.route.kind === "page" && st.route.path === e.path;
                if ((e.action === "create" || e.action === "folder") && onIt) st.go({ kind: "home" });
                if (e.action === "move" && onIt) st.go({ kind: "page", path: e.from });
              } catch (err: any) {
                useStore.getState().toast(err.message, "error");
              }
            }}
          >
            <ArrowCounterClockwise size={13} /> {t("Deshacer")}
          </button>
        </>
      )}
      {undone && <span className="muted xs">{t("Deshecho")}</span>}
    </div>
  );
}

function providerOf(id: string) {
  const p = id.split(":")[0];
  return (
    {
      ollama: "Ollama",
      local: "Gemma (local)",
      lmstudio: "LM Studio",
      claude: "Claude Code",
      codex: "Codex",
      anthropic: "Anthropic API",
      openai: "OpenAI",
      openrouter: "OpenRouter",
      opencue: "OpenCue",
    } as Record<string, string>
  )[p] ?? p;
}

function modelName(id: string) {
  const m = useStore.getState().models.find((x) => x.id === id);
  if (m) return `${m.provider} · ${m.name}`;
  return id.replace(":", " · ") || t("Modelo");
}

export function ModelPicker({ value, models, onChange, wide }: { value: string; models: Model[]; onChange: (id: string) => void; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const hidden: string[] = useStore((s) => s.settings?.ai?.hidden_models ?? []);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as any) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const cur = models.find((m) => m.id === value);
  const groups = useMemo(() => {
    const g = new Map<string, Model[]>();
    for (const m of models) {
      if (hidden.includes(m.id) && m.id !== value) continue;
      if (q && !(m.name + " " + m.provider).toLowerCase().includes(q.toLowerCase())) continue;
      if (!g.has(m.provider)) g.set(m.provider, []);
      g.get(m.provider)!.push(m);
    }
    return [...g.entries()];
  }, [models, q, hidden, value]);
  return (
    <div className={`model-picker ${wide ? "wide" : ""}`} ref={ref}>
      <button className="model-btn" onClick={() => setOpen(!open)}>
        {cur ? <Brand name={cur.provider} size={14} /> : <Sparkle size={14} />}
        <span>{cur ? cur.name : value ? value.split(":").slice(1).join(":") || value : t("Elegir modelo")}</span>
        <CaretDown size={11} />
      </button>
      {open && (
        <div className="model-menu">
          <div className="model-search">
            <MagnifyingGlass size={14} />
            <input autoFocus placeholder={t("Buscar modelo…")} value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-icon xs" title={t("Volver a buscar modelos")} onClick={() => useStore.getState().loadModels(true)}>
              <ArrowsClockwise size={13} />
            </button>
          </div>
          <div className="model-list">
            {!groups.length && (
              <div className="model-empty">
                <p>{t("No encontré modelos.")}</p>
                <p className="muted xs">{t("Abrí Ollama o LM Studio, instalá Claude Code o Codex, cargá una clave o descargá Gemma 4 para usarlo en tu equipo, en Ajustes → IA.")}</p>
                <button className="btn sm" onClick={() => useStore.setState({ settingsTab: "ai" })}>
                  {t("Ajustes de IA")}
                </button>
              </div>
            )}
            {groups.map(([prov, list]) => (
              <div key={prov} className="model-group">
                <div className="model-group-head">
                  <Brand name={prov} size={13} /> {prov}
                  {list[0]?.local && <span className="tag">{t("local")}</span>}
                </div>
                {list.map((m) => (
                  <button
                    key={m.id}
                    className={`model-item ${m.id === value ? "sel" : ""}`}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                  >
                    <span>{m.name}</span>
                    {m.id === value && <Check size={13} className="push-left" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="model-foot">
            <BrainIcon size={13} />
            <span>{t("Tus modelos, tus cuentas. OpenBlocks no tiene servidores.")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
