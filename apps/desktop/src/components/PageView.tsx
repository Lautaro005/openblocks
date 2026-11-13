import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, LinkSimple, ArrowBendDownRight, CalendarBlank, Hash, TextAa, CheckSquare, ListBullets, NumberCircleOne } from "@phosphor-icons/react";
import { api, ApiError, dirOf, type Page, type Prop } from "../lib/api";
import { useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { Editor, type EditorHandle } from "../editor/Editor";

export type SaveState = "saved" | "saving" | "dirty" | "error" | "conflict";

export function PageView({ path, onSaveState }: { path: string; onSaveState: (s: SaveState, at?: number) => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState("");
  const external = useStore((s) => s.external);
  const settings = useStore((s) => s.settings);
  const renaming = useStore((s) => s.renaming);
  const ed = useRef<EditorHandle>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<number>(0);
  const base = useRef(0);
  const lastSaved = useRef("");
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async (p: string) => {
    try {
      const pg = await api.page(p);
      base.current = pg.mtime;
      lastSaved.current = pg.body;
      setPage(pg);
      setErr("");
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const body = pending.current;
    const p = pathRef.current;
    if (body == null) return;
    pending.current = null;
    if (body === lastSaved.current) {
      onSaveState("saved");
      return;
    }
    onSaveState("saving");
    try {
      const r = await api.savePage(p, body, null, base.current);
      base.current = r.mtime;
      lastSaved.current = body;
      onSaveState("saved", Date.now() / 1000);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        onSaveState("conflict");
        useStore.getState().toast(t("La página cambió afuera de OpenBlocks."), "error", {
          label: t("Usar la del disco"),
          run: () => load(p),
        });
        // Keep the user's text: retry without the check if they keep typing.
        base.current = Number.MAX_SAFE_INTEGER / 2;
      } else {
        onSaveState("error");
        pending.current = body;
      }
    }
  }, [load, onSaveState]);

  useEffect(() => {
    setPage(null);
    load(path);
    return () => {
      // Save what is left when leaving the page.
      if (pending.current != null) flush();
    };
  }, [path, load, flush]);

  useEffect(() => {
    const before = () => {
      if (pending.current != null) flush();
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [flush]);

  // Edited by another program or an agent: reload if we have nothing unsaved.
  useEffect(() => {
    if (!external.n || !external.paths.includes(path)) return;
    if (pending.current == null) load(path);
  }, [external, path, load]);

  const onChange = useCallback(
    (md: string) => {
      pending.current = md;
      onSaveState("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 700);
    },
    [flush, onSaveState],
  );

  if (err)
    return (
      <div className="page-empty">
        <p>{err}</p>
      </div>
    );
  if (!page) return <div className="page-loading" />;
  if (focusNext === page.path) {
    focusNext = null;
    setTimeout(() => ed.current?.focusStart(), 30);
  }

  return (
    <article className="page">
      <Title key={page.path} page={page} autoFocus={renaming === page.path} onEnter={() => ed.current?.focusStart()} />
      <Properties page={page} onChanged={() => load(path)} />
      <Editor key={page.path} ref={ed} page={page} onChange={onChange} spellcheck={settings?.spellcheck !== false} />
      <Backlinks path={page.path} />
    </article>
  );
}

/** The page whose text gets the cursor when it opens (after Enter in the title renamed it). */
let focusNext: string | null = null;

function Title({ page, autoFocus, onEnter }: { page: Page; autoFocus: boolean; onEnter: () => void }) {
  const [v, setV] = useState(page.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(page.title), [page.title]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = el.scrollHeight + "px";
  }, [v]);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [autoFocus]);
  const entering = useRef(false);
  const commit = async () => {
    const name = v.trim().replace(/[\\/:*?"<>|#^[\]]/g, "-");
    const enter = entering.current;
    entering.current = false;
    useStore.setState({ renaming: null });
    if (!name || name === page.title) {
      setV(page.title);
      if (enter) setTimeout(onEnter, 30);
      return;
    }
    // Renaming reopens the page under its new name: the text gets the cursor once it has, so
    // what's typed right after Enter isn't saved to the old name and lost.
    const dir = dirOf(page.path);
    try {
      const r = await api.move(page.path, (dir ? dir + "/" : "") + name);
      if (enter) focusNext = r.path;
      const st = useStore.getState();
      await st.refreshTree();
      st.go({ kind: "page", path: r.path }, { replace: true });
      if (r.fixed) st.toast(t("Renombrada. Se actualizaron los enlaces en {n} páginas.", { n: r.fixed }), "ok");
    } catch (e: any) {
      useStore.getState().toast(e.message, "error");
      setV(page.title);
    }
  };
  return (
    <textarea
      ref={ref}
      className="page-title"
      value={v}
      rows={1}
      spellCheck={false}
      placeholder={t("Sin título")}
      onChange={(e) => setV(e.target.value.replace(/\n/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          entering.current = true;
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setV(page.title);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

// ---------- properties (YAML frontmatter) ----------

function kindOf(key: string, v: unknown): "list" | "bool" | "number" | "date" | "text" {
  if (Array.isArray(v) || /^(tags?|aliases|etiquetas)$/i.test(key)) return "list";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
  return "text";
}

const KIND_ICON = { list: ListBullets, bool: CheckSquare, number: NumberCircleOne, date: CalendarBlank, text: TextAa };

function Properties({ page, onChanged }: { page: Page; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const save = async (key: string, value: unknown, remove = false) => {
    try {
      await api.setProp(page.path, key, value, remove);
      onChanged();
    } catch (e: any) {
      useStore.getState().toast(e.message, "error");
    }
  };
  if (!page.props.length && !adding)
    return (
      <div className="props-empty">
        <button className="btn ghost xs" onClick={() => setAdding(true)} disabled={page.complex}>
          <Plus size={13} /> {t("Agregar propiedad")}
        </button>
      </div>
    );
  return (
    <div className="props">
      {page.props.map((p) => (
        <PropRow key={p.key} p={p} disabled={page.complex} onSave={(v) => save(p.key, v)} onRemove={() => save(p.key, null, true)} />
      ))}
      {adding ? (
        <form
          className="prop-row adding"
          onSubmit={(e) => {
            e.preventDefault();
            const k = newKey.trim();
            if (k) save(k, /^(tags?|etiquetas)$/i.test(k) ? [] : "");
            setNewKey("");
            setAdding(false);
          }}
        >
          <Hash size={14} className="prop-icon" />
          <input autoFocus className="prop-key-input" placeholder={t("Nombre (status, tags, due…)")} value={newKey} onChange={(e) => setNewKey(e.target.value)} onBlur={() => !newKey && setAdding(false)} />
        </form>
      ) : (
        !page.complex && (
          <button className="btn ghost xs add-prop" onClick={() => setAdding(true)}>
            <Plus size={13} /> {t("Agregar propiedad")}
          </button>
        )
      )}
      {page.complex && <div className="props-note">{t("Estas propiedades tienen un formato avanzado: se muestran y se guardan tal cual.")}</div>}
    </div>
  );
}

function PropRow({ p, disabled, onSave, onRemove }: { p: Prop; disabled: boolean; onSave: (v: unknown) => void; onRemove: () => void }) {
  const k = kindOf(p.key, p.value);
  const I = KIND_ICON[k];
  const [text, setText] = useState(Array.isArray(p.value) ? "" : String(p.value ?? ""));
  useEffect(() => setText(Array.isArray(p.value) ? "" : String(p.value ?? "")), [p.value]);
  return (
    <div className="prop-row">
      <I size={14} className="prop-icon" />
      <span className="prop-key">{p.key}</span>
      <div className="prop-value">
        {k === "list" ? (
          <div className="chips">
            {(Array.isArray(p.value) ? p.value : String(p.value ?? "").split(",").filter(Boolean)).map((x: any, i: number) => (
              <span className="chip" key={i}>
                {String(x)}
                {!disabled && (
                  <button
                    onClick={() => {
                      const arr = (Array.isArray(p.value) ? [...p.value] : []) as unknown[];
                      arr.splice(i, 1);
                      onSave(arr);
                    }}
                  >
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
            {!disabled && (
              <input
                className="chip-input"
                placeholder={t("Agregar…")}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === ",") && text.trim()) {
                    e.preventDefault();
                    const arr = Array.isArray(p.value) ? [...p.value] : [];
                    onSave([...arr, text.trim()]);
                    setText("");
                  }
                }}
              />
            )}
          </div>
        ) : k === "bool" ? (
          <input type="checkbox" checked={!!p.value} disabled={disabled} onChange={(e) => onSave(e.target.checked)} />
        ) : (
          <input
            className="prop-input"
            type={k === "date" ? "date" : k === "number" ? "number" : "text"}
            value={k === "date" ? text.slice(0, 10) : text}
            disabled={disabled}
            placeholder={t("Vacío")}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              if (text === String(p.value ?? "")) return;
              onSave(k === "number" && text !== "" ? Number(text) : text);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        )}
      </div>
      {!disabled && (
        <button className="btn-icon xs prop-remove" onClick={onRemove} title={t("Quitar")}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ---------- backlinks ----------

function Backlinks({ path }: { path: string }) {
  const [b, setB] = useState<{ linked: any[]; unlinked: any[] } | null>(null);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const tree = useStore((s) => s.tree);
  useEffect(() => {
    api.backlinks(path).then(setB).catch(() => setB(null));
  }, [path, tree]);
  if (!b || (!b.linked.length && !b.unlinked.length)) return null;
  const go = (p: string) => useStore.getState().go({ kind: "page", path: p });
  return (
    <section className="backlinks">
      {b.linked.length > 0 && (
        <>
          <h4>
            <LinkSimple size={14} /> {t("Enlazada desde {n}", { n: b.linked.length })}
          </h4>
          {b.linked.map((x) => (
            <button key={x.path} className="backlink" onClick={() => go(x.path)}>
              <b>{x.title}</b>
              <span>{x.snippet}</span>
            </button>
          ))}
        </>
      )}
      {b.unlinked.length > 0 && (
        <>
          <button className="backlinks-toggle" onClick={() => setShowUnlinked(!showUnlinked)}>
            <ArrowBendDownRight size={14} /> {t("Menciones sin enlace ({n})", { n: b.unlinked.length })}
          </button>
          {showUnlinked &&
            b.unlinked.map((x) => (
              <button key={x.path} className="backlink muted" onClick={() => go(x.path)}>
                <b>{x.title}</b>
                <span>{x.snippet}</span>
              </button>
            ))}
        </>
      )}
    </section>
  );
}

