// Spanish strings are the keys; `en.ts` has the English for each one.
import { EN } from "./en";

export type Lang = "es" | "en";
let lang: Lang = "es";

export function resolveLang(setting: string | undefined): Lang {
  if (setting === "es" || setting === "en") return setting;
  return (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
}

export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l;
}

export const getLang = () => lang;

export function t(s: string, vars?: Record<string, string | number>): string {
  let r = lang === "en" ? EN[s] ?? s : s;
  if (vars) for (const [k, v] of Object.entries(vars)) r = r.split(`{${k}}`).join(String(v));
  return r;
}

export function timeAgo(secs: number): string {
  const d = Math.max(0, Date.now() / 1000 - secs);
  if (d < 60) return t("recién");
  if (d < 3600) return t("hace {n} min", { n: Math.floor(d / 60) });
  if (d < 86400) return t("hace {n} h", { n: Math.floor(d / 3600) });
  if (d < 86400 * 7) return t("hace {n} d", { n: Math.floor(d / 86400) });
  return new Date(secs * 1000).toLocaleDateString(lang === "en" ? "en-US" : "es-AR", { day: "numeric", month: "short", year: "numeric" });
}
