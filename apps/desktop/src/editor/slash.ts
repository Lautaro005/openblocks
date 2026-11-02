// The "/" menu: every block the editor can insert, plus AI and file actions.
import type { Editor, Range } from "@tiptap/core";
import { t } from "../lib/i18n";
import type { SuggestItem } from "./extensions";

export type SlashHooks = {
  attach: (editor: Editor) => void;
  linkPage: (editor: Editor) => void;
  ai: (editor: Editor) => void;
  template: (editor: Editor) => void;
};

const del = (e: Editor, r: Range) => e.chain().focus().deleteRange(r);

export function slashItems(hooks: SlashHooks) {
  const all: Omit<SuggestItem, "id">[] = [
    { group: "Básicos", title: "Texto", hint: "Párrafo", icon: "text", run: (e, r) => del(e, r).setParagraph().run() },
    { group: "Básicos", title: "Título 1", hint: "#", icon: "h1", run: (e, r) => del(e, r).setHeading({ level: 1 }).run() },
    { group: "Básicos", title: "Título 2", hint: "##", icon: "h2", run: (e, r) => del(e, r).setHeading({ level: 2 }).run() },
    { group: "Básicos", title: "Título 3", hint: "###", icon: "h3", run: (e, r) => del(e, r).setHeading({ level: 3 }).run() },
    { group: "Básicos", title: "Lista", hint: "-", icon: "list", run: (e, r) => del(e, r).toggleBulletList().run() },
    { group: "Básicos", title: "Lista numerada", hint: "1.", icon: "numbered", run: (e, r) => del(e, r).toggleOrderedList().run() },
    { group: "Básicos", title: "Tareas", hint: "[ ]", icon: "task", run: (e, r) => del(e, r).toggleTaskList().run() },
    { group: "Básicos", title: "Cita", hint: ">", icon: "quote", run: (e, r) => del(e, r).toggleBlockquote().run() },
    {
      group: "Bloques",
      title: "Nota destacada",
      hint: "> [!note]",
      icon: "callout",
      run: (e, r) => del(e, r).setParagraph().wrapIn("callout", { kind: "note" }).run(),
    },
    {
      group: "Bloques",
      title: "Desplegable",
      hint: "toggle",
      icon: "toggle",
      run: (e, r) => del(e, r).setDetails().run(),
    },
    { group: "Bloques", title: "Código", hint: "```", icon: "code", run: (e, r) => del(e, r).toggleCodeBlock().run() },
    {
      group: "Bloques",
      title: "Tabla",
      hint: "3×3",
      icon: "table",
      run: (e, r) => del(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    { group: "Bloques", title: "Separador", hint: "---", icon: "divider", run: (e, r) => del(e, r).setHorizontalRule().run() },
    {
      group: "Insertar",
      title: "Enlace a una página",
      hint: "[[",
      icon: "link",
      run: (e, r) => {
        del(e, r).run();
        hooks.linkPage(e);
      },
    },
    {
      group: "Insertar",
      title: "Archivo o imagen",
      hint: "PDF, Office, imagen…",
      icon: "file",
      run: (e, r) => {
        del(e, r).run();
        hooks.attach(e);
      },
    },
    {
      group: "Insertar",
      title: "Fecha de hoy",
      hint: "YYYY-MM-DD",
      icon: "date",
      run: (e, r) => del(e, r).insertContent(new Date().toISOString().slice(0, 10)).run(),
    },
    {
      group: "Insertar",
      title: "Plantilla",
      hint: "",
      icon: "template",
      run: (e, r) => {
        del(e, r).run();
        hooks.template(e);
      },
    },
    {
      group: "IA",
      title: "Preguntarle a la IA",
      hint: "⌘J",
      icon: "ai",
      run: (e, r) => {
        del(e, r).run();
        hooks.ai(e);
      },
    },
  ];
  const aliases: Record<string, string> = {
    Texto: "text paragraph parrafo",
    "Título 1": "h1 heading title titulo",
    "Título 2": "h2 heading subtitulo",
    "Título 3": "h3 heading",
    Lista: "bullet list ul",
    "Lista numerada": "numbered ordered ol",
    Tareas: "todo task checkbox check tarea",
    Cita: "quote blockquote",
    "Nota destacada": "callout note tip warning destacado aviso",
    Desplegable: "toggle details collapse fold",
    Código: "code codigo snippet",
    Tabla: "table grid",
    Separador: "divider hr line rule",
    "Enlace a una página": "link page wikilink enlace",
    "Archivo o imagen": "file upload image pdf attach adjuntar imagen archivo",
    "Fecha de hoy": "date today fecha hoy",
    Plantilla: "template plantilla",
    "Preguntarle a la IA": "ai ask chat ia claude gpt",
  };
  return (query: string): SuggestItem[] => {
    const q = query.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return all
      .filter((i) => {
        if (!q) return true;
        const hay = (t(i.title) + " " + i.title + " " + (aliases[i.title] ?? "")).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
        return hay.includes(q);
      })
      .map((i, n) => ({ ...i, id: String(n), title: t(i.title), hint: i.hint ? t(i.hint) : "", group: t(i.group ?? "") }));
  };
}
