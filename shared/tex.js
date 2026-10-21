// Código compartilhado entre servidor e navegador: monta os documentos TeX e o texto que vira a chave
// de cache de cada fórmula. O navegador calcula a mesma chave (SHA-1 desse texto) e acha a fórmula no
// cache local sem perguntar ao servidor. Mudar qualquer coisa aqui muda as chaves: suba MATH_LAYOUT.

export const MATH_LAYOUT = "v2";

export const MATH_PACKAGES = [
  "\\usepackage{amsmath,amssymb,amsthm,mathtools,bm,cancel,xcolor,varwidth}",
  "\\usepackage[version=4]{mhchem}",
  "\\def\\pgfsysdriver{pgfsys-dvisvgm.def}",
  "\\usepackage{tikz-cd}",
].join("\n");

const DISPLAY_ENV = /^\s*\\begin\{(align|alignat|equation|gather|multline|flalign|eqnarray)\*?\}/;
const TIGHT_ENV = { "align*": "aligned", "gather*": "gathered", "alignat*": "alignedat", "equation*": null };

// Toda fórmula vira uma caixa do tamanho exato dela. Só fica na largura da linha o que precisa:
// ambientes numerados, \tag e split.
export function snippet(source, display) {
  if (!display) return "\\begin{preview}$" + source + "$\\end{preview}";
  const env = source.match(/^\s*\\begin\{([a-z]+\*?)\}([\s\S]*)\\end\{\1\}\s*$/);
  if (env && env[1] in TIGHT_ENV && !/\\tag|\\label/.test(source)) {
    const inner = TIGHT_ENV[env[1]];
    const body = inner ? "\\begin{" + inner + "}" + env[2] + "\\end{" + inner + "}" : env[2];
    return "\\begin{preview}$\\displaystyle " + body + "$\\end{preview}";
  }
  if (!DISPLAY_ENV.test(source) && !/\\tag|\\label|\\begin\{split\}/.test(source))
    return "\\begin{preview}$\\displaystyle " + source + "$\\end{preview}";
  const full = DISPLAY_ENV.test(source) ? source : "\\[" + source + "\\]";
  return "\\begin{preview}\\begin{varwidth}{\\linewidth}" + full + "\\end{varwidth}\\end{preview}";
}

export function mathHeader(pre) {
  return ["\\documentclass{article}", MATH_PACKAGES, pre, "\\usepackage[active,tightpage]{preview}"].join("\n");
}

export function mathBody(snippets) {
  return "\\begin{document}\n" + snippets.join("\n\n") + "\n\\end{document}\n";
}

// Texto cujo SHA-1 é a chave da fórmula.
export function mathKeyInput(source, display, pre) {
  return MATH_LAYOUT + "\0" + pre + "\0" + (display ? "D" : "I") + "\0" + source;
}

// Documento de um bloco ```tikz / ```latex (a chave é o SHA-1 dele).
export function blockDocument(lang, body, pre) {
  if (/\\documentclass/.test(body)) return body;
  const isTikz = lang === "tikz";
  if (isTikz && !/\\begin\{(tikzpicture|tikzcd)\}/.test(body)) body = "\\begin{tikzpicture}\n" + body + "\n\\end{tikzpicture}";
  return [
    "\\documentclass{article}",
    MATH_PACKAGES,
    "\\usepackage{pgfplots}",
    "\\pgfplotsset{compat=newest}",
    "\\usetikzlibrary{arrows.meta,calc,positioning,decorations.pathreplacing,patterns,shapes}",
    pre,
    "\\usepackage[active,tightpage]{preview}",
    "\\begin{document}",
    "\\begin{preview}" + (isTikz ? body : "\\begin{varwidth}{\\linewidth}" + body + "\\end{varwidth}") + "\\end{preview}",
    "\\end{document}",
    "",
  ].join("\n");
}

// Acha as fórmulas de uma nota do jeito que o leitor de Markdown as entrega.
export function extractMath(text) {
  const found = [];
  text = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/^(\s*>)+ ?/gm, "")
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/`[^`\n]*`/g, "");
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, src) => {
    found.push({ tex: src.trim(), display: true });
    return " ";
  });
  text.replace(/(^|[^\\$])\$(?=\S)((?:\\.|[^$\\\n])+?)\$(?!\d)/g, (_, pre, src) => {
    if (!/\s$/.test(src)) found.push({ tex: src.trim(), display: false });
  });
  return found;
}

// Só as definições entram no KaTeX (prévia); \usepackage e afins ficam para o TeX.
export function katexDefinitions(src) {
  return src
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])%.*$/, "$1"))
    .filter((line) => /\\(newcommand|renewcommand|providecommand|def|gdef|let|DeclareMathOperator)/.test(line))
    .join("\n")
    .replace(/\\DeclareMathOperator\*\s*\{?\s*(\\[A-Za-z]+)\s*\}?\s*\{([^}]*)\}/g, "\\newcommand{$1}{\\operatorname*{$2}}")
    .replace(/\\DeclareMathOperator\s*\{?\s*(\\[A-Za-z]+)\s*\}?\s*\{([^}]*)\}/g, "\\newcommand{$1}{\\operatorname{$2}}")
    .replace(/\\(renewcommand|providecommand)/g, "\\newcommand");
}
