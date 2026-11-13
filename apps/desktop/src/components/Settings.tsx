import { useEffect, useState } from "react";
import {
  X,
  GearSix,
  FolderSimple,
  Sparkle,
  UsersThree,
  Keyboard,
  Info,
  Copy,
  ArrowSquareOut,
  ArrowsClockwise,
  Check,
  Eye,
  EyeSlash,
  Trash,
  Plus,
  ArrowCircleUp,
  FolderOpen,
  FileDashed,
  PencilSimple,
  Star,
  FilePlus,
  FileText,
  Globe,
  DownloadSimple,
  NotionLogo,
  FileZip,
  PaintBrush,
  Minus,
} from "@phosphor-icons/react";
import { api, type ImportStatus } from "../lib/api";
import { isMac, mod, useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { Brand } from "./Brand";
import { ModelPicker } from "./AiPanel";
import { Logo } from "./Logo";
import { DEFAULT_AI_KEY, comboFromEvent, showCombo } from "../lib/keys";
import { ACCENTS, DEFAULT_APPEARANCE, appearanceOf, nextZoom, type Appearance } from "../lib/appearance";

const TABS: [string, string, any][] = [
  ["general", "General", GearSix],
  ["look", "Apariencia", PaintBrush],
  ["vault", "Vault", FolderSimple],
  ["templates", "Plantillas", FileDashed],
  ["import", "Importar", DownloadSimple],
  ["ai", "IA", Sparkle],
  ["family", "Familia WorkStudio", UsersThree],
  ["keys", "Atajos", Keyboard],
  ["about", "Acerca de", Info],
];

export function Settings() {
  const st = useStore();
  const tab = st.settingsTab ?? "general";
  const close = () => useStore.setState({ settingsTab: null });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <h2>{t("Ajustes")}</h2>
          {TABS.map(([id, label, I]) => (
            <button key={id} className={`side-item ${tab === id ? "active" : ""}`} onClick={() => useStore.setState({ settingsTab: id })}>
              <I size={17} /> <span>{t(label)}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="btn-icon settings-close" onClick={close}>
            <X size={18} />
          </button>
          {tab === "general" && <General />}
          {tab === "look" && <Look />}
          {tab === "vault" && <VaultTab />}
          {tab === "templates" && <TemplatesTab />}
          {tab === "import" && <ImportTab />}
          {tab === "ai" && <AiTab />}
          {tab === "family" && <FamilyTab />}
          {tab === "keys" && <Keys />}
          {tab === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

function Row({ label, hint, children, stack }: { label: string; hint?: string; children: React.ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row ${stack ? "stack" : ""}`}>
      <div className="set-label">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`toggle-sw ${on ? "on" : ""}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

const PALETTES: [string, string, string[]][] = [
  ["warm", "Cálida", ["#fbfaf7", "#f4f2ed", "#1d1c1a", "#c2410c"]],
  ["neutral", "Neutra", ["#fafafa", "#f3f4f6", "#16181d", "#c2410c"]],
  ["sepia", "Sepia", ["#f6efe2", "#efe6d5", "#3b2f22", "#c2410c"]],
  ["contrast", "Alto contraste", ["#ffffff", "#ebebeb", "#000000", "#c2410c"]],
];

function Look() {
  const st = useStore();
  const s = st.settings;
  const a = appearanceOf(s);
  const set = (patch: Partial<Appearance>) => st.saveSettings({ appearance: patch });
  const [custom, setCustom] = useState(a.customFont);
  const dark = document.documentElement.dataset.theme === "dark";
  return (
    <section>
      <h3>{t("Apariencia")}</h3>
      <Row label={t("Tema")}>
        <Seg value={s.theme} options={[["system", t("Sistema")], ["light", t("Claro")], ["dark", t("Oscuro")]]} onChange={(v) => st.saveSettings({ theme: v })} />
      </Row>
      <Row label={t("Paleta")} hint={t("Los colores de fondo, líneas y texto, en claro y en oscuro.")} stack>
        <div className="palettes">
          {PALETTES.map(([id, label, c]) => (
            <button key={id} className={`palette-opt ${a.palette === id ? "on" : ""}`} onClick={() => set({ palette: id as Appearance["palette"] })}>
              <span className="palette-swatch">
                {(dark ? [c[2], c[1], c[0], c[3]] : c).map((x, i) => (
                  <span key={i} style={{ background: x }} />
                ))}
              </span>
              {t(label)}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t("Color de acento")} hint={t("Botones, selección y marcas.")}>
        <div className="accents">
          {ACCENTS.map(([hex, name]) => (
            <button
              key={hex || "default"}
              className={`accent-dot ${a.accent === hex ? "on" : ""}`}
              title={t(name)}
              style={{ background: hex || "#c2410c" }}
              onClick={() => set({ accent: hex })}
            />
          ))}
          <input
            type="color"
            className="accent-custom"
            title={t("Otro color")}
            value={a.accent || "#c2410c"}
            onChange={(e) => set({ accent: e.target.value })}
          />
        </div>
      </Row>

      <h4 className="set-sub">{t("Letra")}</h4>
      <Row label={t("Texto de las páginas")} stack>
        <div className="set-col">
          <Seg
            value={a.textFont}
            options={[["sans", "Source Sans"], ["system", t("Sistema")], ["serif", "Serif"], ["mono", "Mono"], ["custom", t("Otra…")]]}
            onChange={(v) => set({ textFont: v as Appearance["textFont"] })}
          />
          {a.textFont === "custom" && (
            <input
              className="input sm"
              placeholder={t("Nombre de una letra instalada, p. ej. Inter")}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => set({ customFont: custom.trim() })}
              onKeyDown={(e) => e.key === "Enter" && set({ customFont: custom.trim() })}
            />
          )}
        </div>
      </Row>
      <Row label={t("Títulos")}>
        <Seg
          value={a.headingFont}
          options={[["rounded", "Nunito"], ["same", t("Como el texto")], ["serif", "Serif"], ["system", t("Sistema")]]}
          onChange={(v) => set({ headingFont: v as Appearance["headingFont"] })}
        />
      </Row>
      <Row label={t("Interfaz")} hint={t("Menús, barra lateral y botones.")}>
        <Seg value={a.uiFont} options={[["sans", "Source Sans"], ["system", t("Sistema")]]} onChange={(v) => set({ uiFont: v as Appearance["uiFont"] })} />
      </Row>
      <Row label={t("Tamaño del texto")}>
        <div className="stepper">
          <button className="btn-icon sm" onClick={() => set({ textSize: Math.max(12, Math.round((a.textSize - 0.5) * 2) / 2) })}>
            <Minus size={14} />
          </button>
          <input type="range" className="range" min={12} max={24} step={0.5} value={a.textSize} onChange={(e) => set({ textSize: Number(e.target.value) })} />
          <button className="btn-icon sm" onClick={() => set({ textSize: Math.min(24, Math.round((a.textSize + 0.5) * 2) / 2) })}>
            <Plus size={14} />
          </button>
          <span className="zoom-val">{a.textSize} px</span>
        </div>
      </Row>
      <Row label={t("Interlineado")}>
        <Seg value={a.lineHeight} options={[["compact", t("Compacto")], ["normal", t("Normal")], ["relaxed", t("Amplio")]]} onChange={(v) => set({ lineHeight: v as Appearance["lineHeight"] })} />
      </Row>
      <Row label={t("Ancho de la página")}>
        <Seg value={s.width} options={[["normal", t("Normal")], ["wide", t("Ancho")], ["full", t("Completo")]]} onChange={(v) => st.saveSettings({ width: v })} />
      </Row>

      <h4 className="set-sub">{t("Tamaño")}</h4>
      <Row label={t("Tamaño de la interfaz")} hint={t("Todo más grande o más chico. También con {m}+ y {m}− ({m}0 vuelve al 100%).", { m: mod })}>
        <div className="stepper">
          <button className="btn-icon sm" onClick={() => set({ zoom: nextZoom(a.zoom, -1) })} title={t("Alejar")}>
            <Minus size={14} />
          </button>
          <button className="zoom-val" onClick={() => set({ zoom: 1 })} title={t("Volver al 100%")}>
            {Math.round(a.zoom * 100)}%
          </button>
          <button className="btn-icon sm" onClick={() => set({ zoom: nextZoom(a.zoom, 1) })} title={t("Acercar")}>
            <Plus size={14} />
          </button>
        </div>
      </Row>

      <div className="look-preview prose">
        <h2>{t("Así se ve una página")}</h2>
        <p>
          {t("Un párrafo de ejemplo con")} <strong>{t("negrita")}</strong>, <em>{t("cursiva")}</em>, <mark>{t("resaltado")}</mark> {t("y un")} <a>{t("enlace")}</a>.
        </p>
      </div>
      <p>
        <button className="btn ghost sm" onClick={() => st.saveSettings({ appearance: DEFAULT_APPEARANCE, theme: "system", width: "normal" })}>
          <ArrowsClockwise size={14} /> {t("Volver a la apariencia original")}
        </button>
      </p>
    </section>
  );
}

function General() {
  const st = useStore();
  const s = st.settings;
  return (
    <section>
      <h3>{t("General")}</h3>
      <Row label={t("Idioma")}>
        <Seg value={s.language} options={[["system", t("Sistema")], ["es", "Español"], ["en", "English"]]} onChange={(v) => st.saveSettings({ language: v })} />
      </Row>
      <Row label={t("Tema, letra y tamaño")} hint={t("Están en Apariencia.")}>
        <button className="btn sm" onClick={() => useStore.setState({ settingsTab: "look" })}>
          <PaintBrush size={14} /> {t("Apariencia")}
        </button>
      </Row>
      <Row label={t("Pestañas")} hint={t("Varias páginas abiertas a la vez, arriba. {m}+clic en la barra lateral abre en una pestaña nueva.", { m: mod })}>
        <Toggle
          on={!!s.tabs}
          onChange={(v) => {
            if (!v) {
              // Off: only the page in front stays open.
              const cur = useStore.getState();
              useStore.setState({ tabs: [{ id: Date.now(), route: cur.route, back: cur.back, forward: cur.forward }], tabIdx: 0 });
            }
            st.saveSettings({ tabs: v });
          }}
        />
      </Row>
      <Row label={t("Corrector ortográfico")}>
        <Toggle on={s.spellcheck !== false} onChange={(v) => st.saveSettings({ spellcheck: v })} />
      </Row>
      <Row label={t("Carpeta de notas del día")} hint={t("Cada día tiene su página, con la fecha como nombre.")}>
        <input className="input" defaultValue={s.daily_folder} onBlur={(e) => st.saveSettings({ daily_folder: e.target.value.trim() })} />
      </Row>
      <Row label={t("Buscar actualizaciones")}>
        <Toggle on={s.check_updates !== false} onChange={(v) => st.saveSettings({ check_updates: v })} />
      </Row>
      <Row label={t("Volver a ver el inicio")} hint={t("Repite el recorrido de bienvenida.")}>
        <button
          className="btn sm"
          onClick={async () => {
            localStorage.setItem("ob-walk", "1");
            location.reload();
          }}
        >
          {t("Ver el inicio")}
        </button>
      </Row>
    </section>
  );
}

function VaultTab() {
  const st = useStore();
  const v = st.status?.vault;
  const [name, setName] = useState(v?.name ?? "");
  return (
    <section>
      <h3>{t("Vault")}</h3>
      <Row label={t("Nombre")} hint={t("Es el nombre de tu organización. Aparece arriba en la barra lateral.")}>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={async () => {
            await api.post("/api/vault/rename", { name });
            st.refreshStatus();
          }}
        />
      </Row>
      <Row label={t("Carpeta")} hint={t("Tus páginas son archivos .md en esta carpeta. Podés abrirla con Obsidian o sincronizarla con lo que quieras.")}>
        <div className="path-box">
          <code>{v?.path}</code>
          <button className="btn-icon sm" onClick={() => api.open("", true)} title={t("Mostrar en el sistema")}>
            <ArrowSquareOut size={15} />
          </button>
        </div>
      </Row>
      <Row label={t("Contenido")}>
        <span className="muted">{t("{p} páginas · {f} archivos · {w} palabras", { p: v?.stats.pages ?? 0, f: v?.stats.files ?? 0, w: (v?.stats.words ?? 0).toLocaleString() })}</span>
      </Row>
      <Row label={t("Abrir otro vault")}>
        <button
          className="btn sm"
          onClick={async () => {
            const r = await api.pickFolder();
            if (r.path) {
              await api.openVault(r.path);
              location.reload();
            }
          }}
        >
          <FolderOpen size={15} /> {t("Elegir carpeta…")}
        </button>
      </Row>
      <p className="muted xs">{t("OpenBlocks guarda su historial, papelera y chats en la carpeta oculta .openblocks dentro del vault.")}</p>
    </section>
  );
}

const SAMPLE_TEMPLATES: [string, string][] = [
  [
    "Reunión",
    "---\ntags: [reunion]\nfecha: {{date}}\n---\n\n## Participantes\n\n- \n\n## Temas\n\n- \n\n## Decisiones\n\n- \n\n## Próximos pasos\n\n- [ ] \n",
  ],
  [
    "Proyecto",
    "---\nstatus: En curso\ntags: [proyecto]\n---\n\n> [!note] Objetivo\n> Qué queremos lograr y para cuándo.\n\n## Contexto\n\n## Tareas\n\n- [ ] \n\n## Notas\n",
  ],
  ["Diario", "## {{date}}\n\n### Qué hice\n\n- \n\n### Qué aprendí\n\n- \n\n### Mañana\n\n- [ ] \n"],
];

function TemplatesTab() {
  const st = useStore();
  const s = st.settings;
  const folder = s.templates_folder || "Plantillas";
  const [items, setItems] = useState<{ path: string; title: string }[] | null>(null);
  const load = () => api.templates().then(setItems).catch(() => setItems([]));
  useEffect(() => {
    load();
  }, [folder]);
  const def: string = s.default_template ?? "";
  const setDefault = (path: string) => st.saveSettings({ default_template: path });
  const openPage = (path: string) => {
    useStore.setState({ settingsTab: null });
    st.go({ kind: "page", path });
  };
  const create = async (title: string, body = "", open = true) => {
    const r = await api.createPage(folder, title, body, "");
    await st.refreshTree();
    if (open) {
      useStore.setState({ settingsTab: null });
      st.go({ kind: "page", path: r.path });
      useStore.setState({ renaming: r.path });
    }
    return r.path;
  };
  const route = st.route;
  return (
    <section>
      <h3>{t("Plantillas")}</h3>
      <p className="muted">{t("Cada página nueva empieza con la plantilla predeterminada. Las plantillas son páginas normales de tu vault: editalas como cualquier página. Usan {{title}}, {{date}} y {{time}}.")}</p>
      <div className="tpl-list">
        <div className={`tpl-row ${def === "" ? "on" : ""}`}>
          <button className="tpl-pick" onClick={() => setDefault("")} title={t("Usar por defecto")}>
            <span className="radio" />
            <FileDashed size={17} />
            <span className="tpl-name">{t("Página en blanco")}</span>
          </button>
          {def === "" && <span className="tag">{t("Predeterminada")}</span>}
        </div>
        {items === null && <div className="tpl-row muted">{t("Cargando…")}</div>}
        {items?.map((it) => (
          <div key={it.path} className={`tpl-row ${def === it.path ? "on" : ""}`}>
            <button className="tpl-pick" onClick={() => setDefault(it.path)} title={t("Usar por defecto")}>
              <span className="radio" />
              <FileText size={17} />
              <span className="tpl-name">{it.title}</span>
            </button>
            {def === it.path && <span className="tag">{t("Predeterminada")}</span>}
            <button className="btn-icon sm" title={t("Editar")} onClick={() => openPage(it.path)}>
              <PencilSimple size={15} />
            </button>
            <button
              className="btn-icon sm"
              title={t("Borrar")}
              onClick={async () => {
                await api.trash(it.path);
                if (def === it.path) await setDefault("");
                await st.refreshTree();
                load();
              }}
            >
              <Trash size={15} />
            </button>
          </div>
        ))}
      </div>
      <div className="tpl-actions">
        <button className="btn sm primary" onClick={() => create(t("Nueva plantilla"))}>
          <Plus size={14} /> {t("Nueva plantilla")}
        </button>
        {route.kind === "page" && !route.path.startsWith(folder + "/") && (
          <button
            className="btn sm"
            onClick={async () => {
              const p = await api.page(route.path);
              const path = await create(p.title, p.body, false);
              load();
              st.toast(t("Guardada como plantilla: {n}", { n: p.title }), "ok", { label: t("Editar"), run: () => st.go({ kind: "page", path }) });
            }}
          >
            <FilePlus size={14} /> {t("Guardar la página abierta como plantilla")}
          </button>
        )}
        {items !== null && items.length === 0 && (
          <button
            className="btn sm ghost"
            onClick={async () => {
              for (const [n, b] of SAMPLE_TEMPLATES) await create(t(n), b, false);
              load();
            }}
          >
            <Star size={14} /> {t("Agregar ejemplos")}
          </button>
        )}
      </div>
      <Row label={t("Carpeta de plantillas")} hint={t("Las páginas de esta carpeta son tus plantillas. También aparecen en / → Plantilla.")}>
        <input className="input" defaultValue={folder} onBlur={(e) => e.target.value.trim() && st.saveSettings({ templates_folder: e.target.value.trim() })} />
      </Row>
    </section>
  );
}

const NOTION_INTEGRATIONS = "https://www.notion.so/profile/integrations";

function ImportTab() {
  const st = useStore();
  const [mode, setMode] = useState<"token" | "export">("token");
  const [token, setToken] = useState("");
  const [folder, setFolder] = useState("Notion");
  const [s, setS] = useState<ImportStatus | null>(null);
  const [drag, setDrag] = useState(false);
  const load = () => api.importStatus().then(setS).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!s?.running) return;
    const i = setInterval(load, 700);
    return () => clearInterval(i);
  }, [s?.running]);
  const start = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setToken("");
      await load();
    } catch (e: any) {
      st.toast(e.message, "error");
    }
  };
  const pick = async (kind: "zip" | "folder") => {
    const r = await api.importPick(kind).catch((e) => (st.toast(e.message, "error"), null));
    if (r?.paths.length) start(() => api.importExport(r.paths, folder));
  };
  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(false);
    const f = [...e.dataTransfer.files].find((x) => /\.zip$/i.test(x.name));
    if (!f) return st.toast(t("Soltá el .zip que bajaste de Notion."), "error");
    start(() => api.importUpload(f, folder));
  };
  const running = !!s?.running;
  const pct = s?.total ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0;
  const n = (k: number, one: string, many: string) => `${k} ${t(k === 1 ? one : many)}`;
  const counts = s && [n(s.pages, "página", "páginas"), n(s.databases, "base de datos", "bases de datos"), n(s.files, "archivo", "archivos")].join(" · ");
  return (
    <>
      <h3>{t("Importar")}</h3>
      <p className="muted">{t("Traé tus páginas de otras apps al vault abierto. En la app de origen no se toca nada.")}</p>
      <div className="fam-card import-card">
        <div className="fam-head">
          <span className="fam-logo">
            <NotionLogo size={24} />
          </span>
          <div className="fam-title">
            <b>Notion</b>
            <span className="muted xs">{t("Páginas, subpáginas, bases de datos con sus propiedades, imágenes y archivos.")}</span>
          </div>
        </div>
        {running ? (
          <div className="import-run">
            <div className="import-phase">
              <b>{t(s!.phase || "Preparando…")}</b>
              <span className="muted xs">{s!.total ? `${s!.done} / ${s!.total}` : ""}</span>
            </div>
            <div className={`bar ${s!.total ? "" : "indeterminate"}`}>
              <span style={{ width: s!.total ? `${pct}%` : undefined }} />
            </div>
            <div className="tpl-actions">
              <span className="muted xs">{counts}</span>
              <button className="btn sm ghost push" onClick={() => api.importCancel().then(load)}>
                {t("Cancelar")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <Seg
              value={mode}
              options={[
                ["token", t("Con un token (recomendado)")],
                ["export", t("Con la exportación .zip")],
              ]}
              onChange={(v) => setMode(v as any)}
            />
            {mode === "token" ? (
              <>
                <ol className="import-steps">
                  <li>
                    {t("Creá una integración interna en Notion (Nueva integración → Interna).")}{" "}
                    <button className="btn-link" onClick={() => api.openUrl(NOTION_INTEGRATIONS)}>
                      {t("Abrir integraciones")} <ArrowSquareOut size={12} />
                    </button>
                  </li>
                  <li>{t("En la pestaña «Acceso», elegí las páginas a traer. Con las de arriba de todo viene todo lo que tienen adentro.")}</li>
                  <li>{t("Copiá el «Secreto de integración interna» y pegalo acá.")}</li>
                </ol>
                <div className="import-token">
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="ntn_…"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && token.trim() && start(() => api.importToken(token, folder))}
                  />
                  <button className="btn primary" disabled={!token.trim()} onClick={() => start(() => api.importToken(token, folder))}>
                    {t("Importar")}
                  </button>
                </div>
                <p className="muted xs">{t("El token se usa solo para esta importación: no se guarda. Después podés borrar la integración en Notion.")}</p>
              </>
            ) : (
              <>
                <ol className="import-steps">
                  <li>{t("En Notion: Configuración → General → «Exportar todo el contenido del espacio de trabajo» (o «Exportar» en el menú ··· de una página).")}</li>
                  <li>{t("Formato «Markdown y CSV», con «Incluir subpáginas» y «Crear carpetas para subpáginas».")}</li>
                  <li>{t("Bajá el .zip que te manda Notion y soltalo acá.")}</li>
                </ol>
                <div
                  className={`import-drop ${drag ? "over" : ""}`}
                  onDragOver={(e) => (e.preventDefault(), e.stopPropagation(), setDrag(true))}
                  onDragLeave={() => setDrag(false)}
                  onDrop={drop}
                >
                  <FileZip size={28} />
                  <span>{t("Soltá el .zip acá")}</span>
                  <div className="tpl-actions">
                    <button className="btn sm primary" onClick={() => pick("zip")}>
                      {t("Elegir .zip")}
                    </button>
                    <button className="btn sm ghost" onClick={() => pick("folder")}>
                      {t("Elegir carpeta")}
                    </button>
                  </div>
                  <span className="muted xs">{t("Si tu navegador lo descomprimió, elegí la carpeta. Si son varias partes, elegilas todas juntas.")}</span>
                </div>
              </>
            )}
            <Row label={t("Carpeta de destino")} hint={t("Se crea en el vault. Si ya existe, se usa «Notion 2».")}>
              <input className="input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Notion" />
            </Row>
          </>
        )}
        {s?.finished && !running && (
          <div className={`import-result ${s.error ? "bad" : ""}`}>
            {s.error ? (
              <span className="bad-text">{s.error}</span>
            ) : s.cancelled ? (
              <span>{t("Importación cancelada. Lo que ya se copió quedó en «{f}».", { f: s.folder ?? "" })}</span>
            ) : (
              <span>
                <Check size={14} /> {t("Listo: {c} en «{f}».", { c: counts ?? "", f: s.folder ?? "" })}
              </span>
            )}
            {s.folder && !s.error && (
              <button
                className="btn sm"
                onClick={() => {
                  useStore.setState({ settingsTab: null });
                  st.refreshTree().then(() => st.go({ kind: "folder", path: s.folder! }));
                }}
              >
                <FolderOpen size={14} /> {t("Abrir carpeta")}
              </button>
            )}
          </div>
        )}
        {!!s?.warnings.length && !running && (
          <details className="import-warn">
            <summary>{t("{n} cosas no se pudieron traer", { n: s.warnings.length })}</summary>
            <ul>
              {s.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </>
  );
}

function Secret({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const [show, setShow] = useState(false);
  useEffect(() => setV(value), [value]);
  return (
    <div className="secret">
      <input className="input" type={show ? "text" : "password"} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
      <button className="btn-icon sm" onClick={() => setShow(!show)}>
        {show ? <EyeSlash size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

function AiTab() {
  const st = useStore();
  const ai = st.settings.ai ?? {};
  const save = (patch: any) => st.saveSettings({ ai: patch }).then(() => st.loadModels(true));
  const [custom, setCustom] = useState("");
  const providers = [...new Set(st.models.map((m) => m.provider))];
  return (
    <section>
      <h3>{t("IA")}</h3>
      <p className="muted">{t("OpenBlocks no tiene servidores ni cuentas: usa los modelos que ya tenés. Con Ollama o LM Studio nada sale de tu equipo.")}</p>
      <Row label={t("Modelo predeterminado")} hint={t("Para el chat y las acciones del editor.")}>
        <ModelPicker value={ai.model} models={st.models} onChange={(id) => save({ model: id })} wide />
      </Row>
      <Row label={t("Los agentes pueden editar")} hint={t("Si está apagado, la IA solo lee tus páginas y propone el texto en el chat.")}>
        <Toggle on={ai.edits !== "read"} onChange={(v) => save({ edits: v ? "edit" : "read" })} />
      </Row>
      <Row label={t("Instrucciones personales")} hint={t("Van en cada conversación. Por ejemplo: cómo te gusta que escriba, en qué trabajás.")}>
        <textarea className="input" rows={3} defaultValue={ai.instructions} onBlur={(e) => save({ instructions: e.target.value })} />
      </Row>

      <h4 className="set-sub">{t("Detectados")}</h4>
      <div className="prov-list">
        {providers.length === 0 && <p className="muted">{t("Todavía no encontré modelos.")}</p>}
        {providers.map((p) => (
          <span key={p} className="prov-chip">
            <Brand name={p} size={15} /> {p} <span className="muted">{st.models.filter((m) => m.provider === p).length}</span>
          </span>
        ))}
        <button className="btn ghost xs" onClick={() => st.loadModels(true)}>
          <ArrowsClockwise size={13} /> {t("Buscar otra vez")}
        </button>
      </div>

      <h4 className="set-sub">{t("Locales")}</h4>
      <Row label="Ollama" hint="ollama.com">
        <input className="input" defaultValue={ai.ollama_url} onBlur={(e) => save({ ollama_url: e.target.value.trim() })} />
      </Row>
      <Row label="LM Studio" hint="lmstudio.ai">
        <input className="input" defaultValue={ai.lmstudio_url} onBlur={(e) => save({ lmstudio_url: e.target.value.trim() })} />
      </Row>
      <p className="muted xs">{t("Claude Code y Codex se detectan solos si están instalados: usan tu sesión y tu suscripción.")}</p>
      <LocalModels />

      <h4 className="set-sub">{t("Claves de API")}</h4>
      <Row label="Anthropic" hint="console.anthropic.com">
        <Secret value={ai.anthropic_key} placeholder="sk-ant-…" onSave={(v) => save({ anthropic_key: v })} />
      </Row>
      <Row label="OpenAI" hint={t("o cualquier API compatible")}>
        <Secret value={ai.openai_key} placeholder="sk-…" onSave={(v) => save({ openai_key: v })} />
      </Row>
      <Row label={t("URL de la API compatible")}>
        <input className="input" defaultValue={ai.openai_base} onBlur={(e) => save({ openai_base: e.target.value.trim() })} />
      </Row>
      <Row label="OpenRouter" hint={t("Sumá modelos abajo como openrouter:proveedor/modelo")}>
        <Secret value={ai.openrouter_key} placeholder="sk-or-…" onSave={(v) => save({ openrouter_key: v })} />
      </Row>
      <p className="muted xs">{t("Las claves se guardan solo en ~/.openblocks/settings.json, con permisos de lectura para tu usuario.")}</p>

      <h4 className="set-sub">{t("Modelos agregados a mano")}</h4>
      <div className="custom-models">
        {(ai.custom_models ?? []).map((m: string) => (
          <span key={m} className="chip">
            {m}
            <button onClick={() => save({ custom_models: ai.custom_models.filter((x: string) => x !== m) })}>
              <X size={10} />
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = custom.trim();
            if (v && v.includes(":")) save({ custom_models: [...(ai.custom_models ?? []), v] });
            setCustom("");
          }}
        >
          <input className="input sm" placeholder="openrouter:deepseek/deepseek-chat" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button className="btn sm">
            <Plus size={13} />
          </button>
        </form>
      </div>
      <h4 className="set-sub">{t("Mostrar en el selector")}</h4>
      <div className="model-toggles">
        {st.models.map((m) => {
          const hidden = (ai.hidden_models ?? []).includes(m.id);
          return (
            <label key={m.id} className="model-toggle">
              <input
                type="checkbox"
                checked={!hidden}
                onChange={() => save({ hidden_models: hidden ? ai.hidden_models.filter((x: string) => x !== m.id) : [...(ai.hidden_models ?? []), m.id] })}
              />
              <Brand name={m.provider} size={13} /> <span>{m.name}</span> <span className="muted xs">{m.provider}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="cmd">
      <code>{cmd}</code>
      <button
        className="btn-icon sm"
        onClick={() => {
          navigator.clipboard.writeText(cmd);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        }}
      >
        {ok ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function FamilyTab() {
  const st = useStore();
  const [f, setF] = useState<any>(null);
  const load = () => api.family().then(setF);
  useEffect(() => {
    load();
  }, []);
  const fam = st.settings.family ?? {};
  const save = (patch: any) => st.saveSettings({ family: patch }).then(load);
  if (!f) return <div className="page-loading" />;
  const apps: [string, string, string, string][] = [
    ["workstudio", "AI WorkStudio", "workstudio", t("El espacio que junta todas las apps. Con el registro, OpenBlocks aparece en su inicio, se abre adentro y sus herramientas entran en el servidor MCP único.")],
    ["brain", "brain", "brain", t("Tu memoria a largo plazo. La pill brain del chat busca ahí, y cada página se puede guardar en brain desde el menú ⋯.")],
    ["lumina", "Lumina", "lumina", t("Tus reuniones y transcripciones. La pill Lumina del chat busca ahí.")],
    ["opencue", "OpenCue", "opencue", t("Tus agentes. Aparecen en el selector de modelos del chat y pueden recibir una página desde el menú ⋯.")],
  ];
  const exe = "openblocks";
  return (
    <section>
      <h3>{t("Familia WorkStudio")}</h3>
      <p className="muted">{t("OpenBlocks se conecta con las otras apps de la familia por su puerto local, su comando y su servidor MCP. No copia sus datos.")}</p>
      {apps.map(([id, name, brand, desc]) => {
        const a = f[id] ?? {};
        return (
          <div key={id} className="fam-card">
            <div className="fam-head">
              <span className="fam-logo">
                <Brand name={brand} size={26} />
              </span>
              <div className="fam-title">
                <b>{name}</b>
                <span className={`status ${a.running ? "on" : a.installed ? "idle" : "off"}`}>
                  {a.running ? t("Abierta") : a.installed ? t("Instalada") : t("No instalada")}
                  {a.version ? ` · v${String(a.version).replace(/^v/, "")}` : ""}
                  {id === "opencue" && a.agents?.length ? ` · ${t("{n} agentes", { n: a.agents.length })}` : ""}
                </span>
              </div>
              <div className="push" />
              {a.installed && (
                <button className="btn sm" onClick={() => api.familyOpen(id).catch((e) => st.toast(e.message, "error"))}>
                  <ArrowSquareOut size={14} /> {t("Abrir")}
                </button>
              )}
              {id !== "workstudio" && <Toggle on={fam[id] !== false} onChange={(v) => save({ [id]: v })} />}
            </div>
            <p className="fam-desc">{desc}</p>
            {id === "workstudio" && a.installed && (
              <div className="fam-extra">
                <span>{a.registered ? t("OpenBlocks está registrado en WorkStudio.") : t("OpenBlocks todavía no aparece en WorkStudio.")}</span>
                <button
                  className={`btn sm ${a.registered ? "" : "primary"}`}
                  onClick={async () => {
                    await api.workstudio(!a.registered);
                    load();
                    st.toast(a.registered ? t("Quitado de WorkStudio.") : t("Listo. Reiniciá WorkStudio para verlo."), "ok");
                  }}
                >
                  {a.registered ? t("Quitar") : t("Agregar a WorkStudio")}
                </button>
              </div>
            )}
            {!a.installed && <CopyCmd cmd={a.install} />}
          </div>
        );
      })}
      <h4 className="set-sub">{t("OpenBlocks como servidor MCP")}</h4>
      <Row label={t("Vaults que ofrece")} hint={t("Con «Todos», los agentes eligen el vault en cada herramienta.")}>
        <Seg
          value={st.settings.mcp_scope === "all" ? "all" : "current"}
          options={[
            ["current", t("El abierto")],
            ["all", t("Todos")],
          ]}
          onChange={(v) => st.saveSettings({ mcp_scope: v })}
        />
      </Row>
      <p className="muted xs">{t("Para que Claude Code, Codex, Cursor u OpenCue lean y editen tus vaults con las mismas herramientas que el chat:")}</p>
      <CopyCmd cmd={`claude mcp add openblocks -- ${exe} mcp`} />
      <CopyCmd cmd={`codex mcp add openblocks -- ${exe} mcp`} />
      <CopyCmd cmd={`{"mcpServers": {"openblocks": {"command": "${exe}", "args": ["mcp"]}}}`} />
      <p className="muted xs">{t("Sin opciones sigue lo elegido arriba. También: --all para todos los vaults, --vault <carpeta> para uno, --read-only para solo lectura.")}</p>
      <RemoteCard />
    </section>
  );
}

function RemoteCard() {
  const st = useStore();
  const [r, setR] = useState<any>(null);
  const [host, setHost] = useState("");
  const [tun, setTun] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.remote().then((x) => {
      setR(x);
      setHost((h) => h || x.hostname || "");
    });
  useEffect(() => {
    load();
    const i = setInterval(load, 2500);
    return () => clearInterval(i);
  }, []);
  if (!r) return null;
  const set = async (patch: any) => {
    setBusy(true);
    try {
      setR(await api.remoteSet(patch));
    } catch (e: any) {
      st.toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fam-card remote">
      <div className="fam-head">
        <span className="fam-logo">
          <Globe size={22} />
        </span>
        <div className="fam-title">
          <b>{t("Acceso remoto por URL")}</b>
          <span className={`status ${r.url ? "on" : r.enabled ? "idle" : "off"}`}>
            {r.url ? t("Publicado") : r.enabled ? t("Conectando…") : t("Apagado")}
          </span>
        </div>
        <div className="push" />
        <Toggle on={r.enabled} onChange={(v) => !busy && set({ enabled: v })} />
      </div>
      <p className="fam-desc">{t("Publica el servidor MCP con un túnel de Cloudflare para usarlo desde agentes en la nube (Claude.ai, ChatGPT…) u otra compu. La URL lleva un token secreto: sin él, todo responde 404.")}</p>
      {!r.cloudflared && (
        <div className="fam-extra">
          <span>{r.installing ? t("Instalando cloudflared…") : t("Hace falta cloudflared (se baja de Cloudflare y se verifica su SHA256).")}</span>
          <button className="btn sm primary" disabled={r.installing} onClick={() => api.remoteInstall().then(load)}>
            {t("Instalar cloudflared")}
          </button>
        </div>
      )}
      {r.url && <CopyCmd cmd={r.url} />}
      {r.enabled && !r.url && !r.error && <p className="muted xs">{t("Abriendo el túnel…")}</p>}
      {r.error && <p className="bad-text xs">{r.error}</p>}
      <div className="remote-grid">
        <Row label={t("Solo lectura")} hint={t("Los agentes remotos pueden buscar y leer, pero no cambiar nada.")}>
          <Toggle on={r.read_only} onChange={(v) => set({ read_only: v })} />
        </Row>
        <Row label={t("Que la compu no se duerma")} hint={t("Mientras el acceso remoto está prendido.")}>
          <Toggle on={r.keep_awake} onChange={(v) => set({ keep_awake: v })} />
        </Row>
        <Row label={t("Túnel")} hint={r.mode === "named" ? t("Un túnel de tu cuenta de Cloudflare, con tu dominio fijo.") : t("Sin cuenta: la URL cambia cada vez que se prende.")}>
          <Seg
            value={r.mode}
            options={[
              ["quick", t("Rápido")],
              ["named", t("Con mi dominio")],
            ]}
            onChange={(v) => (v === "named" && !(r.hostname && r.has_tunnel_token) ? setR({ ...r, mode: v }) : set({ mode: v }))}
          />
        </Row>
        {r.mode === "named" && (
          <>
            <Row label={t("Dominio")}>
              <input className="input" placeholder="mcp.midominio.com" value={host} onChange={(e) => setHost(e.target.value)} />
            </Row>
            <Row label={t("Token del túnel")} hint={t("En Cloudflare → Zero Trust → Networks → Tunnels. Pegá el comando entero si querés.")}>
              <input className="input" type="password" placeholder={r.has_tunnel_token ? "•••" : "eyJ…"} value={tun} onChange={(e) => setTun(e.target.value)} />
            </Row>
            <div className="tpl-actions">
              <button className="btn sm primary" onClick={() => set({ mode: "named", hostname: host, ...(tun ? { tunnel_token: tun } : {}) }).then(() => setTun(""))}>
                {t("Guardar túnel")}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="tpl-actions">
        <button
          className="btn sm"
          onClick={async () => {
            if (confirm(t("¿Cambiar el token? La URL actual deja de funcionar al instante."))) setR(await api.remoteToken());
          }}
        >
          <ArrowsClockwise size={14} /> {t("Cambiar el token")}
        </button>
        {r.enabled && (
          <button className="btn sm ghost" onClick={() => api.remoteReconnect().then(setR).catch((e) => st.toast(e.message, "error"))}>
            {t("Reconectar")}
          </button>
        )}
        <span className="muted xs push">{t("Local: {u}", { u: `127.0.0.1:${r.port}` })}</span>
      </div>
    </div>
  );
}

function fmtSize(b: number) {
  return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
}

function LocalModels() {
  const st = useStore();
  const [m, setM] = useState<any>(null);
  const load = () => api.local().then(setM).catch(() => {});
  useEffect(() => {
    load();
    const i = setInterval(load, 1500);
    return () => clearInterval(i);
  }, []);
  const wasRunning = useState<Record<string, boolean>>({})[0];
  useEffect(() => {
    // When a download finishes, the model picker learns about it.
    for (const it of m?.items ?? []) {
      const run = !!it.progress?.running;
      if (wasRunning[it.id] && !run) st.loadModels(true);
      wasRunning[it.id] = run;
    }
  }, [m]);
  if (!m) return null;
  const ROLE: Record<string, string> = {
    engine: "Motor para correr los modelos.",
    chat: "Modelo de chat que funciona sin nada más instalado.",
    vision: "Lee el texto de imágenes y PDFs escaneados, y los describe.",
    embed: "Busca imágenes del vault por lo que muestran.",
  };
  return (
    <>
      <h4 className="set-sub">{t("Modelos locales")}</h4>
      <p className="muted xs">
        {m.lumina ? t("Lumina está instalada: OpenBlocks usa su llama.cpp y su Gemma 4 sin bajarlos de nuevo.") : t("Corren en tu equipo con llama.cpp. Si instalás Lumina, OpenBlocks usa sus modelos.")}
      </p>
      <div className="tpl-list">
        {m.items.map((it: any) => {
          const p = it.progress;
          const pct = p?.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
          return (
            <div key={it.id} className="tpl-row local-row">
              <div className="local-meta">
                <b>{it.label}</b>
                <span className="muted xs">{t(ROLE[it.role] ?? "")}</span>
                {p?.running && (
                  <div className="bar">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                )}
                {p?.error && <span className="bad-text xs">{p.error}</span>}
              </div>
              {it.installed ? (
                <span className="tag">{it.source === "lumina" ? t("De Lumina") : t("Instalado")}</span>
              ) : p?.running ? (
                <span className="muted xs">{pct}%</span>
              ) : (
                <button className="btn sm" onClick={() => api.localDownload(it.id).then(load).catch((e) => st.toast(e.message, "error"))}>
                  {t("Descargar")} · {fmtSize(it.size)}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function KeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRec(false);
      const c = comboFromEvent(e);
      if (c) {
        onChange(c);
        setRec(false);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [rec]);
  return (
    <button className={`key-rec ${rec ? "on" : ""}`} onClick={() => setRec(!rec)} title={t("Clic y apretá la combinación nueva")}>
      {rec ? t("Apretá las teclas…") : <kbd>{showCombo(value)}</kbd>}
    </button>
  );
}

function Keys() {
  const st = useStore();
  const aiKey: string = st.settings.ai_shortcut || DEFAULT_AI_KEY;
  const rows: [string, string][] = [
    [`${mod} K`, "Buscar páginas y comandos"],
    [`${mod} P`, "Ir a una página"],
    [`${mod} N`, "Nueva página"],
    [`${mod} J`, "Abrir el chat de IA"],
    [`${mod} D`, "Nota del día"],
    [`${mod} G`, "Grafo"],
    [`${mod} \\`, "Mostrar u ocultar la barra lateral"],
    [`${mod} [  ·  ${mod} ]`, "Atrás · Adelante"],
    [`${mod} ,`, "Ajustes"],
    ["/", "Insertar un bloque"],
    ["[[", "Enlazar una página"],
    ["@", "Sumar una página al chat"],
    [`${mod} B · I · E`, "Negrita · cursiva · código"],
    [`${mod} ⇧ H`, "Resaltar"],
    [`${mod} F`, "Buscar en la página"],
    [isMac ? `${mod} ⌥ F` : `${mod} H`, "Buscar y reemplazar"],
    [`${mod} ⌥ 1 · 2 · 3 · 4`, "Títulos"],
    [`${mod} +  ·  ${mod} −  ·  ${mod} 0`, "Tamaño de la interfaz"],
    [`${mod} T  ·  ${isMac ? "⌘ ⌥ W" : "Ctrl W"}`, "Pestaña nueva · cerrar la pestaña"],
    [`Ctrl Tab  ·  ${mod} 1…9`, "Cambiar de pestaña"],
    ["Esc", "Cerrar menús y ventanas"],
  ];
  return (
    <section>
      <h3>{t("Atajos")}</h3>
      <Row label={t("Escribir con IA en la línea")} hint={t("Abre una caja debajo de la línea para pedirle a la IA qué escribir o cambiar en esa nota.")}>
        <div className="key-set">
          <KeyRecorder value={aiKey} onChange={(v) => st.saveSettings({ ai_shortcut: v })} />
          {aiKey !== DEFAULT_AI_KEY && (
            <button className="btn ghost xs" onClick={() => st.saveSettings({ ai_shortcut: DEFAULT_AI_KEY })}>
              {t("Restablecer")}
            </button>
          )}
        </div>
      </Row>
      <h4 className="set-sub">{t("Fijos")}</h4>
      <div className="keys">
        {rows.map(([k, l]) => (
          <div key={l} className="key-row">
            <span>{t(l)}</span>
            <kbd>{k}</kbd>
          </div>
        ))}
      </div>
      <p className="muted xs">{t("Markdown también funciona mientras escribís: #, -, 1., [ ], >, ``` y ---.")}</p>
    </section>
  );
}

function About() {
  const st = useStore();
  const [u, setU] = useState<any>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    api.updateCheck().then(setU).catch(() => setU({ current: st.status?.version, latest: null }));
  }, []);
  const links: [string, string][] = [
    ["Sitio", "https://lautaro005.github.io/openblocks/"],
    ["Documentación", "https://lautaro005.github.io/openblocks/docs.html"],
    ["Novedades", "https://lautaro005.github.io/openblocks/changelog.html"],
    ["Privacidad", "https://lautaro005.github.io/openblocks/privacy.html"],
    ["GitHub", "https://github.com/Lautaro005/openblocks"],
  ];
  return (
    <section>
      <div className="about-head">
        <Logo size={48} />
        <div>
          <h3>OpenBlocks</h3>
          <span className="muted">
            {t("Versión {v}", { v: st.status?.version ?? "" })} · {st.status?.platform}
          </span>
        </div>
      </div>
      <p>{t("Notas en bloques sobre tu propia carpeta de Markdown. Parte de la familia AI WorkStudio.")}</p>
      <div className="update-box">
        {u?.update ? (
          <>
            <ArrowCircleUp size={20} weight="duotone" />
            <span>{t("Hay una versión nueva: {v}", { v: u.latest })}</span>
            <button
              className="btn primary sm"
              disabled={running}
              onClick={async () => {
                setRunning(true);
                await api.updateRun();
                st.toast(t("Instalando la versión nueva. La app se va a reiniciar."), "ok");
              }}
            >
              {running ? t("Actualizando…") : t("Actualizar")}
            </button>
          </>
        ) : (
          <>
            <Check size={18} />
            <span>{u ? (u.latest ? t("Tenés la última versión.") : t("No pude consultar GitHub.")) : t("Buscando actualizaciones…")}</span>
          </>
        )}
      </div>
      <div className="about-links">
        {links.map(([l, url]) => (
          <button key={url} className="btn ghost sm" onClick={() => api.openUrl(url)}>
            {t(l)} <ArrowSquareOut size={12} />
          </button>
        ))}
      </div>
      <p className="muted xs">{t("Licencia Apache 2.0 con Commons Clause: libre para usar, modificar y compartir; no se puede vender.")}</p>
      <p className="muted xs">
        <Trash size={11} /> {t("Desinstalar: openblocks uninstall (tus vaults no se tocan).")}
      </p>
    </section>
  );
}
