// The find & replace bar of a page (⌘F / Ctrl+F; ⌘⌥F / Ctrl+H opens it with replace).
import { useEffect, useRef, useState } from "react";
import type { Editor as TEditor } from "@tiptap/react";
import { CaretDown, CaretUp, CaretRight, X, TextAa, BracketsCurly, ArrowsLeftRight, Trash, Eraser } from "@phosphor-icons/react";
import { clearFind, deleteBlocks, findState, replaceAll, replaceCurrent, setQuery, step, type FindOpts } from "./find";
import { t } from "../lib/i18n";
import { mod, useStore } from "../lib/store";

export function FindBar({ editor, replace: startReplace, seed, n: opened, onClose }: { editor: TEditor; replace: boolean; seed: string; n: number; onClose: () => void }) {
  const [q, setQ] = useState(seed);
  const [rep, setRep] = useState("");
  const [showRep, setShowRep] = useState(startReplace);
  const [opts, setOpts] = useState<FindOpts>({ caseSensitive: false, wholeWord: false, regex: false });
  const [, force] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setShowRep((s) => s || startReplace), [startReplace]);
  // Each ⌘F: search the selected text (if any) and focus the box.
  useEffect(() => {
    if (seed) setQ(seed);
    input.current?.focus();
    input.current?.select();
  }, [opened]);
  useEffect(() => {
    setQuery(editor.view, q, opts);
  }, [q, opts]);
  // Count and position follow the document as it changes.
  useEffect(() => {
    const up = () => force((n) => n + 1);
    editor.on("transaction", up);
    return () => {
      editor.off("transaction", up);
    };
  }, [editor]);
  useEffect(() => () => clearFind(editor.view), [editor]);

  const s = findState(editor.state);
  const n = s.matches.length;
  const toast = useStore.getState().toast;
  const close = () => {
    clearFind(editor.view);
    onClose();
    editor.commands.focus();
  };
  const opt = (k: keyof FindOpts) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const keys = (e: React.KeyboardEvent, inReplace: boolean) => {
    if (e.key === "Escape") return (e.preventDefault(), close());
    if (e.key === "Enter") {
      e.preventDefault();
      if (inReplace) {
        if (e.metaKey || e.ctrlKey) toast(t("{n} reemplazos", { n: replaceAll(editor.view, rep) }), "ok");
        else replaceCurrent(editor.view, rep);
      } else step(editor.view, e.shiftKey ? -1 : 1);
    }
  };

  return (
    <div className="find-bar" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <button className={`btn-icon xs find-toggle ${showRep ? "open" : ""}`} onClick={() => setShowRep(!showRep)} title={t("Reemplazar")}>
        <CaretRight size={12} weight="bold" />
      </button>
      <div className="find-rows">
        <div className="find-row">
          <div className={`find-input ${s.error ? "bad" : ""}`}>
            <input
              ref={input}
              value={q}
              placeholder={t("Buscar en la página")}
              spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => keys(e, false)}
            />
            <button className={`find-opt ${opts.caseSensitive ? "on" : ""}`} onClick={() => opt("caseSensitive")} title={t("Distinguir mayúsculas")}>
              <TextAa size={15} />
            </button>
            <button className={`find-opt word ${opts.wholeWord ? "on" : ""}`} onClick={() => opt("wholeWord")} title={t("Palabra completa")}>
              ab
            </button>
            <button className={`find-opt ${opts.regex ? "on" : ""}`} onClick={() => opt("regex")} title={t("Expresión regular")}>
              <BracketsCurly size={15} />
            </button>
          </div>
          <span className={`find-count ${q && !n ? "none" : ""}`}>
            {s.error ? t("Expresión inválida") : q ? (n ? `${s.index + 1} / ${n}` : t("Sin resultados")) : ""}
          </span>
          <button className="btn-icon xs" disabled={!n} onClick={() => step(editor.view, -1)} title={t("Anterior") + " (⇧↵)"}>
            <CaretUp size={14} />
          </button>
          <button className="btn-icon xs" disabled={!n} onClick={() => step(editor.view, 1)} title={t("Siguiente") + " (↵)"}>
            <CaretDown size={14} />
          </button>
          <button className="btn-icon xs" onClick={close} title={t("Cerrar") + " (Esc)"}>
            <X size={14} />
          </button>
        </div>
        {showRep && (
          <div className="find-row">
            <div className="find-input">
              <input
                value={rep}
                placeholder={t("Reemplazar con…")}
                spellCheck={false}
                onChange={(e) => setRep(e.target.value)}
                onKeyDown={(e) => keys(e, true)}
              />
            </div>
            <button className="btn xs" disabled={!n} onClick={() => replaceCurrent(editor.view, rep)} title={t("Reemplazar esta") + " (↵)"}>
              <ArrowsLeftRight size={13} /> {t("Reemplazar")}
            </button>
            <button
              className="btn xs"
              disabled={!n}
              onClick={() => toast(t("{n} reemplazos", { n: replaceAll(editor.view, rep) }), "ok")}
              title={t("Reemplazar todas") + ` (${mod}↵)`}
            >
              {t("Todas")}
            </button>
            <span className="find-sep" />
            <button
              className="btn-icon xs"
              disabled={!n}
              onClick={() => toast(t("{n} coincidencias borradas", { n: replaceAll(editor.view, "") }), "ok")}
              title={t("Borrar las coincidencias")}
            >
              <Eraser size={15} />
            </button>
            <button
              className="btn-icon xs danger"
              disabled={!n}
              onClick={() => toast(t("{n} bloques borrados", { n: deleteBlocks(editor.view) }), "ok")}
              title={t("Borrar los bloques que las tienen")}
            >
              <Trash size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
