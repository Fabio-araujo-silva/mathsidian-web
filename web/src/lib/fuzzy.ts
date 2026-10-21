// Busca aproximada que ignora acentos e maiúsculas ("preambulo" acha "Preâmbulos").
// fold() mantém o comprimento do texto, pra os trechos destacados caírem nas posições certas.

const MARKS = /[̀-ͯ]/g;
const NON_ASCII = /[^\u0000-\u007f]/;

export function fold(s: string): string {
  const lower = s.toLowerCase();
  if (!NON_ASCII.test(lower)) return lower;
  const quick = lower.normalize("NFD").replace(MARKS, "");
  if (quick.length === lower.length) return quick;
  let out = "";
  for (const ch of lower) {
    const d = ch.normalize("NFD").replace(MARKS, "");
    out += d.length === ch.length ? d : ch;
  }
  return out;
}

export type Match = { score: number; ranges: [number, number][] };

// Cada letra da busca precisa aparecer em ordem. Pontua sequências seguidas, começo de palavra e
// texto curto; penaliza buracos.
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = fold(query).replace(/\s+/g, "");
  if (!q) return { score: 0, ranges: [] };
  const t = fold(text);
  // atalho: trecho contíguo ganha de tudo
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const wordStart = direct === 0 || /[\s/_\-.(]/.test(t[direct - 1]);
    return { score: 1000 - direct - t.length / 10 + (wordStart ? 200 : 0), ranges: [[direct, direct + q.length]] };
  }
  const ranges: [number, number][] = [];
  let score = 0;
  let ti = 0;
  let last = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx < 0) return null;
    if (idx === last + 1 && ranges.length) {
      ranges[ranges.length - 1][1] = idx + 1;
      score += 8;
    } else {
      ranges.push([idx, idx + 1]);
      score -= Math.min(idx - ti, 10);
      if (idx === 0 || /[\s/_\-.(]/.test(t[idx - 1])) score += 6;
    }
    last = idx;
    ti = idx + 1;
  }
  return { score: score - t.length / 20, ranges };
}
