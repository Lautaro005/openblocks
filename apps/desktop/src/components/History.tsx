import { useEffect, useState } from "react";
import { X, ClockCounterClockwise, Sparkle, PencilSimple, ArrowCounterClockwise, Sliders } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { t, getLang } from "../lib/i18n";
import { renderMd } from "../lib/render";
import { PanelResizer, panelStyle } from "./Preview";

function when(stamp: string) {
  // 20261102T153012
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return stamp;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return d.toLocaleString(getLang() === "en" ? "en-US" : "es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const REASON: Record<string, [string, any]> = {
  edit: ["Edición", PencilSimple],
  ai: ["Antes de un cambio de la IA", Sparkle],
  restore: ["Antes de restaurar", ArrowCounterClockwise],
  props: ["Propiedades", Sliders],
};

export function HistoryPanel({ path }: { path: string }) {
  useStore((s) => s.panelW.history);
  const [list, setList] = useState<any[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const load = () => api.history(path).then(setList).catch(() => setList([]));
  useEffect(() => {
    setSel(null);
    load();
  }, [path]);
  useEffect(() => {
    if (!sel) return;
    api.historyVersion(path, sel).then((v) => setBody(v.body));
  }, [sel, path]);
  return (
    <aside className="history-panel" style={panelStyle("history")}>
      <PanelResizer kind="history" />
      <header className="panel-head">
        <ClockCounterClockwise size={16} />
        <span className="panel-title">{t("Historial")}</span>
        <div className="push" />
        <button className="btn-icon" onClick={() => useStore.getState().setPanel(null)}>
          <X size={17} />
        </button>
      </header>
      <div className="history-list">
        {list && !list.length && <p className="muted pad">{t("Todavía no hay versiones guardadas. OpenBlocks guarda una copia cada diez minutos de edición y antes de cada cambio de la IA.")}</p>}
        {list?.map((v) => {
          const [label, I] = REASON[v.reason] ?? [v.reason, PencilSimple];
          return (
            <button key={v.id} className={`history-row ${sel === v.id ? "sel" : ""}`} onClick={() => setSel(v.id)}>
              <I size={14} />
              <div>
                <b>{when(v.stamp)}</b>
                <span>{t(label)}</span>
              </div>
            </button>
          );
        })}
      </div>
      {sel && (
        <div className="history-view">
          <div className="history-actions">
            <span className="muted xs">{t("Así estaba la página")}</span>
            <button
              className="btn primary sm"
              onClick={async () => {
                await api.restoreVersion(path, sel);
                const s = useStore.getState();
                useStore.setState({ external: { n: s.external.n + 1, paths: [path] } });
                s.toast(t("Versión restaurada. La anterior quedó en el historial."), "ok");
                load();
              }}
            >
              <ArrowCounterClockwise size={14} /> {t("Restaurar")}
            </button>
          </div>
          <div className="prose small history-body" dangerouslySetInnerHTML={{ __html: renderMd(body) }} />
        </div>
      )}
    </aside>
  );
}
