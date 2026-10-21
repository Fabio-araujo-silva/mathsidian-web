// Desenha as fórmulas e blocos TeX de um trecho já renderizado do Markdown.
//
// Caminho de cada fórmula, do mais rápido pro mais lento:
//   1. memória (Map LRU, SVG já sanitizado);
//   2. IndexedDB (sobrevive a recarregar a página; lido em lote numa transação);
//   3. servidor (pedidos em lote, as de cima da nota primeiro; o servidor também tem cache em disco).
// A chave é o SHA-1 de (layout + preâmbulo + modo + fórmula), igual à do servidor: o navegador sabe
// se tem a fórmula sem perguntar. Erros do TeX também entram no cache (são determinísticos); falha
// de rede e tempo esgotado não.
// Enquanto o servidor compila, o KaTeX mostra uma prévia (só é baixado se faltar algo no cache).
// Digitando no modo lado a lado (serverDelay), o servidor só é chamado depois de uma pausa: as
// versões intermediárias de uma fórmula ficam só na prévia do KaTeX.
import DOMPurify from "dompurify";
import { api, type RenderResult } from "../api";
import { getMany, putLater, type CachedSvg } from "./idb";
import { mathKeyInput, blockDocument, katexDefinitions } from "@shared/tex.js";

const EM_PER_PT = 0.112; // 10pt do TeX ≈ 1.12em do texto
const CHUNK = 60; // fórmulas por pedido ao servidor
const PARALLEL = 3; // pedidos simultâneos

export type NoteCtx = { vaultId: string; note: string | null; frontmatter: string | null };

// ---------- utilidades ----------

const encoder = new TextEncoder();
async function sha1(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", encoder.encode(s));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const memory = new Map<string, CachedSvg>();
const MEMORY_MAX = 3000;
function remember(key: string, v: CachedSvg) {
  memory.delete(key);
  memory.set(key, v);
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
}

// SVG do dvisvgm pode trazer SVG cru do usuário (\special{dvisvgm:raw}): sanitiza uma vez só, antes de guardar.
function sanitize(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["use"], ADD_ATTR: ["xlink:href", "href"] }) as string;
}

// Resultado do servidor -> o que vai pro cache (null = não guardar: falha passageira).
function fromServer(r: RenderResult): CachedSvg | null {
  if (r.svg) return { svg: sanitize(r.svg), width: r.width!, height: r.height!, depth: r.depth! };
  if (r.error && r.error.startsWith("!")) return { error: r.error };
  return null;
}

function paint(el: HTMLElement, page: CachedSvg) {
  if ("error" in page) return paintError(el, page.error);
  el.classList.remove("is-pending", "mx-error", "tex-block-error");
  el.removeAttribute("title");
  el.innerHTML = page.svg;
  const svg = el.firstElementChild as SVGElement | null;
  if (!svg) return;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = page.width * EM_PER_PT + "em";
  svg.style.height = (page.height + page.depth) * EM_PER_PT + "em";
  svg.style.verticalAlign = -page.depth * EM_PER_PT + "em";
  svg.setAttribute("aria-hidden", "true");
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", el.dataset.tex || "");
}

function paintError(el: HTMLElement, message: string) {
  el.classList.remove("is-pending");
  if (el.classList.contains("tex-block")) {
    el.classList.add("tex-block-error");
    el.textContent = message;
    return;
  }
  el.classList.add("mx-error");
  el.title = message;
  el.textContent = el.dataset.tex || "";
}

// ---------- preâmbulo (texto + macros do KaTeX) ----------

type Pre = { text: string; macros?: Record<string, string> };
const preCache = new Map<string, Promise<Pre>>();
let epoch = 0;

// Chame quando um preâmbulo for salvo: tudo é recalculado.
export function bumpPreambleEpoch() {
  epoch++;
  preCache.clear();
}

export function preambleFor(ctx: NoteCtx): Promise<Pre> {
  const k = epoch + "\0" + ctx.vaultId + "\0" + (ctx.note || "") + "\0" + (ctx.frontmatter ?? "\u0001");
  let p = preCache.get(k);
  if (!p) {
    p = api.preamble(ctx.vaultId, ctx.note, ctx.frontmatter).then((r) => ({ text: r.preamble }));
    p.catch(() => preCache.delete(k));
    preCache.set(k, p);
    if (preCache.size > 200) preCache.delete(preCache.keys().next().value!);
  }
  return p;
}

// ---------- KaTeX (prévia), carregado sob demanda ----------

let katexPromise: Promise<typeof import("katex").default> | null = null;
function loadKatex() {
  if (!katexPromise) katexPromise = Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => m.default);
  return katexPromise;
}

function macrosOf(katex: typeof import("katex").default, pre: Pre): Record<string, string> {
  if (pre.macros) return pre.macros;
  const macros: Record<string, string> = {};
  for (const def of katexDefinitions(pre.text).split("\n")) {
    if (!def.trim()) continue;
    const name = def.match(/\\(?:newcommand|def|gdef|let)\*?\s*\{?\s*(\\[A-Za-z@]+)/);
    if (name) delete macros[name[1]];
    try {
      katex.renderToString(def, { globalGroup: true, macros, throwOnError: true, strict: "ignore" });
    } catch {}
  }
  return (pre.macros = macros);
}

async function preview(els: HTMLElement[], pre: Pre) {
  const katex = await loadKatex();
  const macros = macrosOf(katex, pre);
  for (const el of els) {
    if (!el.classList.contains("is-pending")) continue;
    try {
      katex.render(el.dataset.tex || "", el, {
        displayMode: el.classList.contains("mx-d"),
        throwOnError: true,
        strict: "ignore",
        macros: { ...macros },
        output: "htmlAndMathml",
      });
    } catch {
      el.textContent = el.dataset.tex || "";
    }
  }
}

// ---------- fórmulas ----------

export type HydrateOpts = { alive?: () => boolean; serverDelay?: number };

// Desenha todas as fórmulas ainda não desenhadas dentro de root.
// alive(): false se o leitor já mudou de nota (resultados atrasados são descartados).
export async function hydrate(root: HTMLElement, ctx: NoteCtx, { alive = () => true, serverDelay = 0 }: HydrateOpts = {}) {
  const els = Array.from(root.querySelectorAll<HTMLElement>(".mx[data-tex]:not([data-key])"));
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".tex-block:not([data-key])"));
  if (!els.length && !blocks.length) return;
  let pre: Pre;
  try {
    pre = await preambleFor(ctx);
  } catch {
    return;
  }
  if (!alive()) return;
  if (blocks.length) hydrateBlocks(blocks, ctx, pre, alive, serverDelay);
  if (!els.length) return;

  const keys = await Promise.all(els.map((el) => sha1(mathKeyInput((el.dataset.tex || "").trim(), el.classList.contains("mx-d"), pre.text))));
  const misses: number[] = [];
  els.forEach((el, i) => {
    el.dataset.key = keys[i];
    const hit = memory.get(keys[i]);
    if (hit) paint(el, hit);
    else misses.push(i);
  });
  if (!misses.length) return;

  const stored = await getMany(misses.map((i) => keys[i]));
  let remote: number[] = [];
  misses.forEach((i, j) => {
    const hit = stored[j];
    if (hit) {
      remember(keys[i], hit);
      if (els[i].dataset.key === keys[i]) paint(els[i], hit);
    } else remote.push(i);
  });
  if (!remote.length || !alive()) return;

  for (const i of remote) els[i].classList.add("is-pending");
  preview(remote.map((i) => els[i]), pre);

  // digitando: espera uma pausa; o que já saiu da tela (versão intermediária) não vai pro servidor
  if (serverDelay) {
    await sleep(serverDelay);
    if (!alive()) return;
    remote = remote.filter((i) => els[i].isConnected && els[i].dataset.key === keys[i]);
    if (!remote.length) return;
  }

  // mesma fórmula várias vezes na nota: pede uma vez só
  const unique = new Map<string, number[]>();
  for (const i of remote) {
    const list = unique.get(keys[i]);
    if (list) list.push(i);
    else unique.set(keys[i], [i]);
  }
  const groups = Array.from(unique.values());
  const chunks: number[][][] = [];
  for (let i = 0; i < groups.length; i += CHUNK) chunks.push(groups.slice(i, i + CHUNK));

  let next = 0;
  const worker = async () => {
    while (next < chunks.length && alive()) {
      const chunk = chunks[next++];
      let results: RenderResult[];
      try {
        results = (
          await api.render(
            ctx.vaultId,
            ctx.note,
            ctx.frontmatter,
            chunk.map((g) => ({ tex: (els[g[0]].dataset.tex || "").trim(), display: els[g[0]].classList.contains("mx-d") }))
          )
        ).results;
      } catch (e: any) {
        chunk.forEach((g) => g.forEach((i) => paintError(els[i], "Sem conexão com o servidor: " + (e && e.message))));
        continue;
      }
      chunk.forEach((g, j) => {
        const r = results[j];
        const page = fromServer(r);
        // o servidor responde com a chave dele (a do preâmbulo com que compilou): guarda por ela
        if (page) {
          remember(r.key, page);
          putLater(r.key, page);
        }
        for (const i of g) {
          if (els[i].dataset.key !== keys[i]) continue;
          if (page) paint(els[i], page);
          else paintError(els[i], r.error || "erro");
        }
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
}

// ---------- blocos ```tikz / ```latex ----------

async function hydrateBlocks(blocks: HTMLElement[], ctx: NoteCtx, pre: Pre, alive: () => boolean, serverDelay: number) {
  await Promise.all(
    blocks.map(async (box) => {
      const lang = box.dataset.lang || "tikz";
      const src = box.dataset.src || "";
      const key = await sha1(blockDocument(lang, src, pre.text));
      box.dataset.key = key;
      const cached = memory.get(key) || (await getMany([key]))[0];
      if (cached) {
        remember(key, cached);
        if (box.dataset.key === key) paint(box, cached);
        return;
      }
      if (serverDelay) {
        await sleep(serverDelay * 2); // compilar um desenho custa mais: espera mais
        if (!alive() || !box.isConnected || box.dataset.key !== key) return;
      }
      let r: RenderResult;
      try {
        r = await api.renderBlock(ctx.vaultId, ctx.note, ctx.frontmatter, lang, src);
      } catch (e: any) {
        r = { key, error: "Sem conexão com o servidor: " + (e && e.message) };
      }
      if (!alive() || box.dataset.key !== key) return;
      const page = fromServer(r);
      if (page) {
        remember(r.key, page);
        putLater(r.key, page);
        paint(box, page);
      } else paintError(box, r.error || "erro");
    })
  );
}
