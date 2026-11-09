// A small spreadsheet formula engine, so the sheet editor shows results while you edit: numbers,
// text, cell references (A1, $B$2) and ranges (A1:C9), + - * / ^ & and comparisons, and the common
// functions (in English or Spanish): SUM/SUMA, AVERAGE/PROMEDIO, MIN, MAX, COUNT/CONTAR,
// COUNTA/CONTARA, IF/SI, AND/Y, OR/O, NOT/NO, ROUND/REDONDEAR, ABS, SQRT/RAIZ, POWER/POTENCIA,
// CONCAT/CONCATENAR, LEN/LARGO, UPPER/MAYUSC, LOWER/MINUSC, TRIM/ESPACIOS, TODAY/HOY.
// Anything else shows #NAME? here and is still saved for Excel to compute.
import type { Cell } from "./api";

type V = number | string | boolean | null | V[];

export class FormulaError extends Error {}

const err = (code: string) => new FormulaError(code);

export function colName(n: number): string {
  let o = "";
  n++;
  while (n > 0) {
    const m = (n - 1) % 26;
    o = String.fromCharCode(65 + m) + o;
    n = Math.floor((n - 1) / 26);
  }
  return o;
}

export function colIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

type Tok = { t: "num" | "str" | "ref" | "name" | "op" | "(" | ")" | "," | ":"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (src[j] === '"') break;
        else s += src[j++];
      }
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const ref = /^\$?([A-Za-z]{1,3})\$?(\d+)(?![\w(])/.exec(src.slice(i));
    if (ref) {
      out.push({ t: "ref", v: (ref[1] + ref[2]).toUpperCase() });
      i += ref[0].length;
      continue;
    }
    const name = /^[A-Za-zÁÉÍÓÚáéíóúÑñ_][\w.ÁÉÍÓÚáéíóúÑñ]*/.exec(src.slice(i));
    if (name) {
      out.push({ t: "name", v: name[0].toUpperCase() });
      i += name[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%".includes(c)) out.push({ t: "op", v: c });
    else if (c === "(" || c === ")" || c === ":") out.push({ t: c, v: c });
    else if (c === "," || c === ";") out.push({ t: ",", v: "," });
    else throw err("#ERROR!");
    i++;
  }
  return out;
}

type Get = (r: number, c: number) => V;

function parseRef(s: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(s)!;
  return [Number(m[2]) - 1, colIndex(m[1])];
}

function num(v: V): number {
  if (Array.isArray(v)) v = v[0] ?? null;
  if (v === null || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(",", "."));
  if (Number.isNaN(n)) throw err("#VALUE!");
  return n;
}

function text(v: V): string {
  if (Array.isArray(v)) v = v[0] ?? null;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function flat(args: V[]): V[] {
  const o: V[] = [];
  for (const a of args) Array.isArray(a) ? o.push(...flat(a)) : o.push(a);
  return o;
}

const nums = (args: V[]) => flat(args).filter((x) => typeof x === "number") as number[];

const FN: Record<string, (args: V[]) => V> = {
  SUM: (a) => nums(a).reduce((s, x) => s + x, 0),
  AVERAGE: (a) => {
    const n = nums(a);
    if (!n.length) throw err("#DIV/0!");
    return n.reduce((s, x) => s + x, 0) / n.length;
  },
  MIN: (a) => (nums(a).length ? Math.min(...nums(a)) : 0),
  MAX: (a) => (nums(a).length ? Math.max(...nums(a)) : 0),
  COUNT: (a) => nums(a).length,
  COUNTA: (a) => flat(a).filter((x) => x !== null && x !== "").length,
  ABS: (a) => Math.abs(num(a[0])),
  SQRT: (a) => Math.sqrt(num(a[0])),
  POWER: (a) => Math.pow(num(a[0]), num(a[1])),
  ROUND: (a) => {
    const f = Math.pow(10, a.length > 1 ? num(a[1]) : 0);
    return Math.round(num(a[0]) * f) / f;
  },
  CONCAT: (a) => flat(a).map(text).join(""),
  LEN: (a) => text(a[0]).length,
  UPPER: (a) => text(a[0]).toUpperCase(),
  LOWER: (a) => text(a[0]).toLowerCase(),
  TRIM: (a) => text(a[0]).trim().replace(/\s+/g, " "),
  AND: (a) => flat(a).every((x) => !!num(x)),
  OR: (a) => flat(a).some((x) => !!num(x)),
  NOT: (a) => !num(a[0]),
  TODAY: () => new Date().toISOString().slice(0, 10),
};
const ALIAS: Record<string, string> = {
  SUMA: "SUM",
  PROMEDIO: "AVERAGE",
  CONTAR: "COUNT",
  CONTARA: "COUNTA",
  REDONDEAR: "ROUND",
  RAIZ: "SQRT",
  POTENCIA: "POWER",
  CONCATENAR: "CONCAT",
  LARGO: "LEN",
  MAYUSC: "UPPER",
  MINUSC: "LOWER",
  ESPACIOS: "TRIM",
  Y: "AND",
  O: "OR",
  NO: "NOT",
  HOY: "TODAY",
  SI: "IF",
};

/** Evaluates a formula (with or without the leading =). */
export function evaluate(src: string, get: Get): V {
  const toks = lex(src.replace(/^=/, ""));
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];

  const expr = (): V => compare();
  const compare = (): V => {
    let a = concat();
    while (peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek().v)) {
      const op = take().v;
      const b = concat();
      const x = typeof a === "number" || typeof b === "number" ? num(a) : text(a).toLowerCase();
      const y = typeof a === "number" || typeof b === "number" ? num(b) : text(b).toLowerCase();
      a = op === "=" ? x === y : op === "<>" ? x !== y : op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
    }
    return a;
  };
  const concat = (): V => {
    let a = add();
    while (peek()?.t === "op" && peek().v === "&") {
      take();
      a = text(a) + text(add());
    }
    return a;
  };
  const add = (): V => {
    let a = mul();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = take().v;
      const b = mul();
      a = op === "+" ? num(a) + num(b) : num(a) - num(b);
    }
    return a;
  };
  const mul = (): V => {
    let a = pow();
    while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = take().v;
      const b = pow();
      if (op === "/" && num(b) === 0) throw err("#DIV/0!");
      a = op === "*" ? num(a) * num(b) : num(a) / num(b);
    }
    return a;
  };
  const pow = (): V => {
    let a = unary();
    while (peek()?.t === "op" && peek().v === "^") {
      take();
      a = Math.pow(num(a), num(unary()));
    }
    return a;
  };
  const unary = (): V => {
    if (peek()?.t === "op" && (peek().v === "-" || peek().v === "+")) {
      const op = take().v;
      const v = unary();
      return op === "-" ? -num(v) : num(v);
    }
    let v = atom();
    if (peek()?.t === "op" && peek().v === "%") {
      take();
      v = num(v) / 100;
    }
    return v;
  };
  const atom = (): V => {
    const tk = take();
    if (!tk) throw err("#ERROR!");
    if (tk.t === "num") return Number(tk.v);
    if (tk.t === "str") return tk.v;
    if (tk.t === "(") {
      const v = expr();
      if (take()?.t !== ")") throw err("#ERROR!");
      return v;
    }
    if (tk.t === "ref") {
      const [r, c] = parseRef(tk.v);
      if (peek()?.t === ":") {
        take();
        const end = take();
        if (end?.t !== "ref") throw err("#REF!");
        const [r2, c2] = parseRef(end.v);
        const out: V[] = [];
        for (let i = Math.min(r, r2); i <= Math.max(r, r2); i++) for (let j = Math.min(c, c2); j <= Math.max(c, c2); j++) out.push(get(i, j));
        return out;
      }
      return get(r, c);
    }
    if (tk.t === "name") {
      if (tk.v === "TRUE" || tk.v === "VERDADERO") return true;
      if (tk.v === "FALSE" || tk.v === "FALSO") return false;
      const name = ALIAS[tk.v] ?? tk.v;
      if (take()?.t !== "(") throw err("#NAME?");
      if (name === "IF") {
        const cond = expr();
        const args: V[] = [];
        while (peek()?.t === ",") {
          take();
          args.push(peek()?.t === "," || peek()?.t === ")" ? null : expr());
        }
        if (take()?.t !== ")") throw err("#ERROR!");
        return num(cond) ? (args[0] ?? true) : (args[1] ?? false);
      }
      const f = FN[name];
      const args: V[] = [];
      if (peek()?.t !== ")") {
        args.push(expr());
        while (peek()?.t === ",") {
          take();
          args.push(expr());
        }
      }
      if (take()?.t !== ")") throw err("#ERROR!");
      if (!f) throw err("#NAME?");
      return f(args);
    }
    throw err("#ERROR!");
  };
  const v = expr();
  if (p < toks.length) throw err("#ERROR!");
  return v;
}

/** Values of every formula cell of a sheet, computed in dependency order (cycles give #REF!). */
export function computeSheet(rows: Cell[][], formulas: Record<string, string>): Map<string, Cell> {
  const out = new Map<string, Cell>();
  const busy = new Set<string>();
  const cell = (r: number, c: number): V => {
    const k = `${r},${c}`;
    const f = formulas[k];
    if (!f) return rows[r]?.[c] ?? null;
    if (out.has(k)) {
      const v = out.get(k)!;
      if (typeof v === "string" && /^#[A-Z/0!?]+$/.test(v)) throw err(v);
      return v;
    }
    if (busy.has(k)) throw err("#REF!");
    busy.add(k);
    let v: Cell;
    try {
      const r0 = evaluate(f, cell);
      const x = Array.isArray(r0) ? (flat(r0)[0] ?? null) : r0;
      v = typeof x === "number" && !Number.isFinite(x) ? "#NUM!" : (x as Cell);
      if (typeof v === "number") v = Math.round(v * 1e10) / 1e10;
    } catch (e) {
      v = e instanceof FormulaError ? e.message : "#ERROR!";
    }
    // A function this engine doesn't know: keep the result the file came with.
    if (v === "#NAME?" && rows[r]?.[c] != null) v = rows[r][c];
    busy.delete(k);
    out.set(k, v);
    return v;
  };
  for (const k of Object.keys(formulas)) {
    const [r, c] = k.split(",").map(Number);
    try {
      cell(r, c);
    } catch {}
  }
  return out;
}
