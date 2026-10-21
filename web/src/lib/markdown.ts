// Markdown -> HTML (markdown-it, com HTML cru desligado: nada do texto vira tag).
// Extensões: $...$ e $$...$$ (viram marcadores que o mathService preenche), [[links]] entre notas,
// callouts "> [!teorema] Título", blocos ```tikz / ```latex.
// renderBlocks() devolve o HTML de cada bloco de nível superior separado: o leitor reaproveita os
// blocos que não mudaram (com as fórmulas já desenhadas) e só refaz o que foi editado.
import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type Token from "markdown-it/lib/token.mjs";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
const esc = md.utils.escapeHtml;

// ---------- matemática ----------

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
  if (src.charCodeAt(start + 1) === 0x24) return false; // $$ no meio da linha: deixa como texto
  if (start > 0 && src.charCodeAt(start - 1) === 0x5c /* \ */) return false;
  const first = src.charCodeAt(start + 1);
  if (!first || first === 0x20 || first === 0x0a || first === 0x09) return false;
  let pos = start + 1;
  while (pos < state.posMax) {
    const c = src.charCodeAt(pos);
    if (c === 0x5c) {
      pos += 2;
      continue;
    }
    if (c === 0x0a) return false;
    if (c === 0x24) break;
    pos++;
  }
  if (pos >= state.posMax) return false;
  const prev = src.charCodeAt(pos - 1);
  if (prev === 0x20 || prev === 0x09) return false;
  const next = src.charCodeAt(pos + 1);
  if (next >= 0x30 && next <= 0x39) return false; // "$5 e $6": dinheiro, não fórmula
  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = src.slice(start + 1, pos);
    token.markup = "$";
  }
  state.pos = pos + 1;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.slice(pos, pos + 2) !== "$$") return false;
  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let content = "";
  let line = startLine;
  let found = false;
  if (firstLine.trim().endsWith("$$")) {
    // $$ x $$ numa linha só
    content = firstLine.trim().slice(0, -2);
    found = true;
  } else {
    const lines: string[] = [];
    if (firstLine.trim()) lines.push(firstLine);
    while (++line < endLine) {
      pos = state.bMarks[line] + state.tShift[line];
      max = state.eMarks[line];
      if (pos < max && state.sCount[line] < state.blkIndent) break;
      const text = state.src.slice(pos, max);
      const end = text.indexOf("$$");
      if (end >= 0) {
        if (text.slice(0, end).trim()) lines.push(text.slice(0, end));
        found = true;
        break;
      }
      lines.push(state.src.slice(state.bMarks[line] + Math.min(state.tShift[line], state.blkIndent), max));
    }
    content = lines.join("\n");
  }
  if (!found) return false;
  if (silent) return true;
  state.line = line + 1;
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, state.line];
  token.markup = "$$";
  return true;
}

md.inline.ruler.after("escape", "math_inline", mathInline);
md.block.ruler.after("blockquote", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
md.renderer.rules.math_inline = (tokens, idx) => `<span class="mx" data-tex="${esc(tokens[idx].content)}">${esc("$" + tokens[idx].content + "$")}</span>`;
md.renderer.rules.math_block = (tokens, idx) => `<div class="mx mx-d" data-tex="${esc(tokens[idx].content)}">${esc(tokens[idx].content)}</div>\n`;

// ---------- [[links]] ----------

function wikilink(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let start = state.pos;
  const embed = src.charCodeAt(start) === 0x21; /* ! */
  if (embed) start++;
  if (src.slice(start, start + 2) !== "[[") return false;
  const end = src.indexOf("]]", start + 2);
  if (end < 0 || end > state.posMax) return false;
  const inner = src.slice(start + 2, end);
  if (!inner || inner.includes("\n") || inner.includes("[[")) return false;
  if (!silent) {
    const [target, alias] = inner.split("|");
    const token = state.push("wikilink", "a", 0);
    token.meta = { target: target.trim(), label: (alias || target).trim() };
  }
  state.pos = end + 2;
  return true;
}
md.inline.ruler.before("link", "wikilink", wikilink);
md.renderer.rules.wikilink = (tokens, idx) => {
  const { target, label } = tokens[idx].meta;
  const name = target.split("#")[0];
  return `<a class="wl" href="#" data-target="${esc(name)}">${esc(label.split("#")[0] || label)}</a>`;
};

// ---------- callouts ----------

export const CALLOUT_LABELS: Record<string, string> = {
  teorema: "Teorema", theorem: "Teorema", lema: "Lema", lemma: "Lema", corolario: "Corolário", corollary: "Corolário",
  proposicao: "Proposição", proposition: "Proposição", definicao: "Definição", definition: "Definição",
  exemplo: "Exemplo", example: "Exemplo", observacao: "Observação", remark: "Observação", note: "Nota", nota: "Nota",
  prova: "Demonstração", proof: "Demonstração", demonstracao: "Demonstração", info: "Info", tip: "Dica", dica: "Dica",
  warning: "Atenção", atencao: "Atenção", exercicio: "Exercício", exercise: "Exercício",
};
// família visual de cada tipo (cor no CSS)
const CALLOUT_FAMILY: Record<string, string> = {
  teorema: "thm", theorem: "thm", lema: "thm", lemma: "thm", corolario: "thm", corollary: "thm", proposicao: "thm", proposition: "thm",
  definicao: "def", definition: "def", exemplo: "ex", example: "ex", exercicio: "ex", exercise: "ex",
  prova: "proof", proof: "proof", demonstracao: "proof", warning: "warn", atencao: "warn",
};

function callouts(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "blockquote_open") continue;
    const p = tokens[i + 1];
    const inline = tokens[i + 2];
    if (!p || p.type !== "paragraph_open" || !inline || inline.type !== "inline") continue;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/m.exec(inline.content);
    if (!m || m.index !== 0) continue;
    const type = m[1].toLowerCase();
    tokens[i].meta = { callout: type, title: m[3].trim() };
    // tira a linha do título; o parágrafo fica com o resto (ou vazio)
    const rest = inline.content.slice(m[0].length).replace(/^\n/, "");
    inline.content = rest;
    if (!rest.trim()) {
      p.hidden = true;
      tokens[i + 3].hidden = true;
    }
  }
}
md.core.ruler.before("inline", "callouts", callouts);

md.renderer.rules.blockquote_open = (tokens, idx, _opts, env) => {
  const meta = tokens[idx].meta;
  if (!meta || !meta.callout) return "<blockquote>\n";
  const type = meta.callout as string;
  const label = CALLOUT_LABELS[type] || type.charAt(0).toUpperCase() + type.slice(1);
  const fam = CALLOUT_FAMILY[type] || "note";
  const title = meta.title ? md.renderInline(meta.title, env) : "";
  // "Teorema 4.2 (Stokes)" já diz o tipo: não repete o rótulo
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const showLabel = !meta.title || !fold(meta.title).startsWith(fold(label));
  return `<div class="callout callout-${fam}" data-callout="${esc(type)}"><div class="callout-head">${
    showLabel ? `<span class="callout-label">${esc(label)}</span>` : ""
  }${title ? `<span class="callout-title">${title}</span>` : ""}</div><div class="callout-body">\n`;
};
md.renderer.rules.blockquote_close = (tokens, idx) => {
  // acha o blockquote_open correspondente
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    if (tokens[i].type === "blockquote_close") depth++;
    else if (tokens[i].type === "blockquote_open" && --depth === 0) return tokens[i].meta && tokens[i].meta.callout ? "</div></div>\n" : "</blockquote>\n";
  }
  return "</blockquote>\n";
};

// ---------- blocos de código ----------

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0].toLowerCase();
  if (lang === "tikz" || lang === "latex")
    return `<div class="tex-block" data-lang="${lang}" data-src="${esc(t.content)}"><span class="tex-block-wait">compilando ${lang}…</span></div>\n`;
  return defaultFence(tokens, idx, opts, env, self);
};

// links externos abrem em outra aba, sem passar referência
md.renderer.rules.link_open = (tokens, idx, opts, _env, self) => {
  const href = tokens[idx].attrGet("href") || "";
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return self.renderToken(tokens, idx, opts);
};

// ---------- API ----------

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function splitFrontmatter(text: string): { raw: string | null; body: string; offsetLines: number } {
  const m = FRONTMATTER.exec(text);
  if (!m) return { raw: null, body: text, offsetLines: 0 };
  return { raw: m[1], body: text.slice(m[0].length), offsetLines: m[0].split("\n").length - 1 };
}

// HTML de cada bloco de nível superior, na ordem.
export function renderBlocks(body: string): string[] {
  const env = {};
  const tokens = md.parse(body, env);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    if (tokens[i].nesting === 1) {
      let depth = 0;
      for (; i < tokens.length; i++) {
        depth += tokens[i].nesting;
        if (depth === 0) break;
      }
    }
    i++;
    const slice = tokens.slice(start, i) as Token[];
    const html = md.renderer.render(slice, md.options, env);
    if (html.trim()) out.push(html);
  }
  return out;
}

export function renderInline(text: string): string {
  return md.renderInline(text);
}
