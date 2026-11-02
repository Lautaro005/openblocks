import { useEffect, useState } from "react";
import { FolderOpen, ArrowRight, ArrowLeft, Check, Sparkle, FolderSimple, CheckCircle, Circle } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { Logo } from "./Logo";
import { Brand } from "./Brand";
import { ModelPicker } from "./AiPanel";

/** First run: language, where the vault lives, its name, AI and the family apps. */
export function Walkthrough({ onDone }: { onDone: () => void }) {
  const st = useStore();
  const [step, setStep] = useState(0);
  const [path, setPath] = useState(st.status?.vault?.path ?? "");
  const [name, setName] = useState(st.status?.vault?.name ?? "");
  const [guide, setGuide] = useState(true);
  const [recent, setRecent] = useState<any[]>([]);
  const [family, setFamily] = useState<any>(null);
  const [registerWs, setRegisterWs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.vaults().then((v) => setRecent(v.filter((x) => x.exists))).catch(() => {});
    api.family().then(setFamily).catch(() => {});
    st.loadModels(true);
  }, []);

  const pick = async () => {
    const r = await api.pickFolder();
    if (r.path) {
      setPath(r.path);
      if (!name) setName(r.path.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  };

  const finish = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.openVault(path, name, guide);
      if (family?.workstudio?.installed && registerWs && !family.workstudio.registered) await api.workstudio(true).catch(() => {});
      localStorage.removeItem("ob-walk");
      await st.refreshStatus();
      onDone();
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const steps = [t("Idioma"), t("Carpeta"), t("Nombre"), t("IA"), t("Listo")];
  return (
    <div className="walk">
      <div className="walk-card">
        <div className="walk-brand">
          <Logo size={34} />
          <span>OpenBlocks</span>
        </div>
        <ol className="walk-steps">
          {steps.map((s, i) => (
            <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
              {i < step ? <CheckCircle size={14} weight="fill" /> : <Circle size={14} weight={i === step ? "fill" : "regular"} />} {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="walk-body">
            <h1>{t("Tus notas en bloques, en tu carpeta.")}</h1>
            <p>{t("OpenBlocks escribe como Notion y guarda como Obsidian: cada página es un archivo Markdown en una carpeta que elegís vos. Sin cuentas ni nube.")}</p>
            <div className="walk-choices">
              {[
                ["es", "Español"],
                ["en", "English"],
              ].map(([v, l]) => (
                <button key={v} className={`choice ${st.lang === v ? "on" : ""}`} onClick={() => st.saveSettings({ language: v })}>
                  {st.lang === v && <Check size={15} />} {l}
                </button>
              ))}
            </div>
            <div className="walk-choices">
              {[
                ["system", t("Tema del sistema")],
                ["light", t("Claro")],
                ["dark", t("Oscuro")],
              ].map(([v, l]) => (
                <button key={v} className={`choice sm ${(st.settings.theme || "system") === v ? "on" : ""}`} onClick={() => st.saveSettings({ theme: v })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="walk-body">
            <h1>{t("¿Dónde va a vivir tu vault?")}</h1>
            <p>{t("Elegí una carpeta vacía para empezar de cero, o una que ya tenga notas (por ejemplo tu vault de Obsidian). OpenBlocks no mueve tus archivos.")}</p>
            <div className="walk-path">
              <FolderSimple size={18} />
              <input className="input" value={path} placeholder={t("/ruta/a/la/carpeta")} onChange={(e) => setPath(e.target.value)} />
              <button className="btn primary" onClick={pick}>
                <FolderOpen size={16} /> {t("Elegir…")}
              </button>
            </div>
            {recent.length > 0 && (
              <div className="walk-recent">
                <span className="muted xs">{t("Usados antes")}</span>
                {recent.slice(0, 4).map((r) => (
                  <button key={r.path} className={`choice sm ${path === r.path ? "on" : ""}`} onClick={() => (setPath(r.path), setName(r.name))}>
                    {r.name} <span className="muted xs">{r.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="walk-body">
            <h1>{t("¿Cómo se llama tu organización?")}</h1>
            <p>{t("Es el nombre del vault y queda arriba en la barra lateral. Lo podés cambiar cuando quieras.")}</p>
            <input className="input big" autoFocus value={name} placeholder={t("Por ejemplo: Estudio, Personal, Facultad")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && setStep(3)} />
            <label className="check">
              <input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} />
              {t("Crear una página de bienvenida con los atajos (si la carpeta está vacía)")}
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="walk-body">
            <h1>
              <Sparkle size={26} weight="fill" className="ai-mark" /> {t("Tu IA, tus modelos")}
            </h1>
            <p>{t("El chat lee y edita tus páginas. Usa lo que ya tenés instalado o tus propias claves; con un modelo local nada sale de tu equipo.")}</p>
            <div className="walk-model">
              <ModelPicker value={st.settings.ai?.model ?? ""} models={st.models} onChange={(id) => st.saveSettings({ ai: { model: id } })} wide />
              <span className="muted xs">{t("{n} modelos encontrados", { n: st.models.length })}</span>
            </div>
            {family && (
              <div className="walk-family">
                <span className="muted xs">{t("La familia WorkStudio en este equipo")}</span>
                {[
                  ["workstudio", "AI WorkStudio"],
                  ["brain", "brain"],
                  ["lumina", "Lumina"],
                  ["opencue", "OpenCue"],
                ].map(([id, n]) => (
                  <div key={id} className="walk-fam">
                    <Brand name={id} size={18} />
                    <b>{n}</b>
                    <span className={`status ${family[id]?.installed ? "on" : "off"}`}>{family[id]?.installed ? t("Encontrada") : t("No instalada")}</span>
                  </div>
                ))}
                {family.workstudio?.installed && (
                  <label className="check">
                    <input type="checkbox" checked={registerWs} onChange={(e) => setRegisterWs(e.target.checked)} />
                    {t("Mostrar OpenBlocks dentro de AI WorkStudio")}
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="walk-body">
            <h1>{t("Todo listo.")}</h1>
            <ul className="walk-tips">
              <li>
                <kbd>/</kbd> {t("inserta bloques: títulos, tareas, tablas, notas destacadas, archivos")}
              </li>
              <li>
                <kbd>[[</kbd> {t("enlaza otra página")}
              </li>
              <li>
                <kbd>⌘K</kbd> {t("busca y ejecuta comandos")}
              </li>
              <li>
                <kbd>⌘J</kbd> {t("abre el chat de IA")}
              </li>
            </ul>
            <div className="walk-summary">
              <span>
                <FolderSimple size={14} /> {path}
              </span>
              <span>
                <b>{name || t("Vault")}</b>
              </span>
            </div>
            {err && <p className="error">{err}</p>}
          </div>
        )}

        <div className="walk-actions">
          {step > 0 && (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              <ArrowLeft size={15} /> {t("Atrás")}
            </button>
          )}
          <div className="push" />
          {step < 4 ? (
            <button className="btn primary" disabled={(step === 1 && !path.trim()) || (step === 2 && !name.trim())} onClick={() => setStep(step + 1)}>
              {t("Continuar")} <ArrowRight size={15} />
            </button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={finish}>
              {busy ? t("Abriendo…") : t("Abrir mi vault")} <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
