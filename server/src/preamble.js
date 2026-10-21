// Preâmbulo em cascata (mesma regra do Mathsidian desktop). O preâmbulo de uma nota junta:
//   1. preamble.tex da raiz do cofre (todas as notas);
//   2. preamble.tex de cada pasta até a nota (a pasta e as subpastas);
//   3. a propriedade "preamble" da nota: primeiro os arquivos .tex citados (caminho ou nome, com ou
//      sem [[ ]]), depois o LaTeX direto (qualquer valor com "\").
import YAML from "yaml";

export const PREAMBLE_NAME = "preamble.tex";
export const PREAMBLE_PROP = "preamble";
export const INLINE = "\0inline";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function splitFrontmatter(text) {
  const m = FRONTMATTER.exec(text || "");
  return m ? { raw: m[1], body: text.slice(m[0].length) } : { raw: null, body: text || "" };
}

export function parseFrontmatter(raw) {
  if (!raw) return {};
  try {
    const data = YAML.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// preamble: [[x]] sem aspas vira lista dentro de lista no YAML: achata tudo.
export function flatten(v) {
  if (Array.isArray(v)) return v.flatMap(flatten);
  return v == null || v === "" || v === false ? [] : [String(v)];
}

export function folderChain(notePath) {
  const dirs = (notePath || "").split("/").slice(0, -1);
  const files = [PREAMBLE_NAME];
  for (let i = 1; i <= dirs.length; i++) files.push(dirs.slice(0, i).join("/") + "/" + PREAMBLE_NAME);
  return files;
}

function linkTarget(entry) {
  return entry.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
}

// Resolve um valor da propriedade pra um arquivo .tex do cofre (files: lista de caminhos).
export function resolveLink(entry, files) {
  const link = linkTarget(entry);
  if (!link) return null;
  const set = new Set(files);
  const names = /\.tex$/i.test(link) ? [link] : [link + ".tex", link];
  for (const n of names) if (set.has(n)) return n;
  // só o nome: procura em qualquer pasta, o mais raso primeiro
  const base = (/\.tex$/i.test(link) ? link : link + ".tex").split("/").pop().toLowerCase();
  const hits = files.filter((f) => f.split("/").pop().toLowerCase() === base).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return hits[0] || null;
}

// Onde criar um arquivo citado que ainda não existe.
export function linkCreatePath(entry) {
  let p = linkTarget(entry);
  if (!/\.tex$/i.test(p)) p += ".tex";
  return p;
}

// Camadas do preâmbulo de uma nota, em ordem. readFile(path) -> texto ou null.
// frontmatterRaw: se vier (texto ainda não salvo no editor), usa ele no lugar do arquivo.
export async function preambleLayers({ notePath, files, readFile, frontmatterRaw }) {
  const layers = [];
  const seen = new Set();
  for (const [i, p] of folderChain(notePath).entries()) {
    const text = await readFile(p);
    seen.add(p);
    layers.push({ kind: i ? "folder" : "vault", path: p, exists: text != null, text: text || "" });
  }
  if (!notePath) return layers;
  let raw = frontmatterRaw;
  if (raw === undefined) raw = splitFrontmatter((await readFile(notePath)) || "").raw;
  const entries = flatten(parseFrontmatter(raw)[PREAMBLE_PROP]);
  const inline = [];
  for (const entry of entries) {
    if (entry.includes("\\")) {
      inline.push(entry);
      continue;
    }
    const resolved = resolveLink(entry, files);
    const p = resolved || linkCreatePath(entry);
    if (seen.has(p)) continue;
    seen.add(p);
    const text = resolved ? await readFile(resolved) : null;
    layers.push({ kind: "link", path: p, entry, exists: !!resolved, text: text || "" });
  }
  layers.push({ kind: "inline", path: notePath, exists: inline.length > 0, text: inline.join("\n") });
  return layers;
}

// Junta as camadas. overrides: Map caminho -> texto (rascunho), INLINE -> LaTeX da nota.
export function composePreamble(layers, overrides) {
  const parts = [];
  for (const l of layers) {
    const key = l.kind === "inline" ? INLINE : l.path;
    const text = overrides && overrides.has(key) ? overrides.get(key) : l.text;
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

// Troca o LaTeX direto da propriedade "preamble" da nota, mantendo os arquivos citados e o resto do YAML.
export function setInlinePreamble(noteText, latex) {
  const { raw, body } = splitFrontmatter(noteText);
  const doc = raw != null ? YAML.parseDocument(raw) : new YAML.Document({});
  if (doc.errors && doc.errors.length) throw new Error("o cabeçalho YAML da nota tem erro de sintaxe");
  const current = flatten(doc.toJSON() ? doc.toJSON()[PREAMBLE_PROP] : undefined);
  const links = current.filter((e) => !e.includes("\\"));
  const src = String(latex || "").replace(/\s+$/, "");
  const value = src ? [...links, src] : links;
  if (!value.length) doc.delete(PREAMBLE_PROP);
  else doc.set(PREAMBLE_PROP, value.length === 1 ? value[0] : value);
  const yaml = String(doc).trim();
  const empty = !yaml || yaml === "{}";
  if (empty) return raw != null ? body : noteText;
  return "---\n" + yaml + "\n---\n" + body;
}
