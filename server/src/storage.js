// Arquivos dos cofres: DATA_DIR/vaults/<id>/<caminho>. Todo caminho que vem do cliente passa por
// safePath(), que recusa "..", caminhos absolutos e caracteres proibidos no Windows.
//
// Otimizações: cada cofre tem um índice em memória (lista de arquivos com tamanho e data) e um cache
// dos textos pequenos (.tex, .md: o que os preâmbulos leem a cada renderização). Toda escrita passa
// por aqui, então o índice é atualizado na hora em vez de reler o disco. Um processo só por DATA_DIR.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

const BAD_SEGMENT = /[\x00-\x1f<>:"|?*\\]/;
export const TEXT_EXT = new Set(["md", "tex", "txt", "bib", "sty", "cls", "json", "csv", "yaml", "yml"]);
const CACHE_TEXT_MAX = 256 * 1024; // só textos até esse tamanho entram no cache
const CACHE_TOTAL_MAX = 64 * 1024 * 1024; // teto do cache de textos (todos os cofres)

export function extOf(p) {
  const m = /\.([^./]+)$/.exec(p);
  return m ? m[1].toLowerCase() : "";
}

export function versionOf(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
}

export function createStorage(dataDir) {
  const root = path.join(dataDir, "vaults");
  fs.mkdirSync(root, { recursive: true });

  // vaultId -> { entries: Map(path -> entry), bytes, loading: Promise|null }
  const indexes = new Map();
  // "vaultId\0path" -> string (LRU pela ordem de inserção do Map)
  const texts = new Map();
  let textBytes = 0;

  function vaultDir(id) {
    if (!/^[a-z0-9]{8,40}$/.test(id)) throw new HttpError(400, "cofre inválido");
    return path.join(root, id);
  }

  // "Pasta/nota.md" -> { rel, abs }. rel "" é a raiz do cofre (só quando allowRoot).
  function safePath(vaultId, rel, { allowRoot = false } = {}) {
    if (typeof rel !== "string") throw new HttpError(400, "caminho ausente");
    rel = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").normalize("NFC");
    const base = vaultDir(vaultId);
    if (!rel) {
      if (allowRoot) return { rel: "", abs: base };
      throw new HttpError(400, "caminho vazio");
    }
    const parts = rel.split("/");
    if (rel.length > 400 || parts.some((p) => !p || p === "." || p === ".." || p.length > 120 || BAD_SEGMENT.test(p) || /[. ]$/.test(p)))
      throw new HttpError(400, "caminho inválido: " + rel);
    const abs = path.join(base, ...parts);
    if (!abs.startsWith(base + path.sep)) throw new HttpError(400, "caminho inválido");
    return { rel: parts.join("/"), abs };
  }

  // ---------- cache de textos ----------
  const tkey = (vaultId, rel) => vaultId + "\0" + rel;

  function cacheText(vaultId, rel, text) {
    const k = tkey(vaultId, rel);
    dropText(k);
    if (text.length > CACHE_TEXT_MAX) return;
    texts.set(k, text);
    textBytes += text.length;
    while (textBytes > CACHE_TOTAL_MAX && texts.size) dropText(texts.keys().next().value);
  }

  function dropText(k) {
    const old = texts.get(k);
    if (old === undefined) return;
    textBytes -= old.length;
    texts.delete(k);
  }

  function dropVaultTexts(vaultId, prefix) {
    const start = vaultId + "\0" + (prefix || "");
    for (const k of [...texts.keys()]) if (k.startsWith(start)) dropText(k);
  }

  // ---------- índice ----------
  async function scan(vaultId) {
    const base = vaultDir(vaultId);
    const entries = new Map();
    async function walk(dir, prefix) {
      let list;
      try {
        list = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      await Promise.all(
        list.map(async (ent) => {
          if (ent.name.startsWith(".tmp-")) return;
          const rel = prefix ? prefix + "/" + ent.name : ent.name;
          const abs = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            entries.set(rel, { path: rel, kind: "folder" });
            await walk(abs, rel);
          } else if (ent.isFile()) {
            const st = await fsp.stat(abs);
            entries.set(rel, { path: rel, kind: "file", size: st.size, mtime: Math.round(st.mtimeMs) });
          }
        })
      );
    }
    await walk(base, "");
    let bytes = 0;
    for (const e of entries.values()) bytes += e.size || 0;
    return { entries, bytes };
  }

  async function index(vaultId) {
    let idx = indexes.get(vaultId);
    if (idx && idx.ready) return idx;
    if (idx && idx.loading) return idx.loading;
    idx = { ready: false, loading: null };
    indexes.set(vaultId, idx);
    idx.loading = scan(vaultId).then(
      (r) => {
        Object.assign(idx, r, { ready: true, loading: null });
        return idx;
      },
      (e) => {
        indexes.delete(vaultId);
        throw e;
      }
    );
    return idx.loading;
  }

  function invalidate(vaultId) {
    indexes.delete(vaultId);
    dropVaultTexts(vaultId);
  }

  // pastas-mãe de "a/b/c.md": "a", "a/b"
  function addParents(idx, rel) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!idx.entries.has(p)) idx.entries.set(p, { path: p, kind: "folder" });
    }
  }

  async function createVaultDir(id) {
    await fsp.mkdir(vaultDir(id), { recursive: true });
  }

  // [{ path, kind: "file" | "folder", size, mtime }], ordenado por caminho
  async function list(vaultId) {
    const idx = await index(vaultId);
    return [...idx.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async function filePaths(vaultId) {
    const idx = await index(vaultId);
    const out = [];
    for (const e of idx.entries.values()) if (e.kind === "file") out.push(e.path);
    return out;
  }

  async function usedBytes(vaultId) {
    return (await index(vaultId)).bytes;
  }

  async function read(vaultId, rel) {
    const { abs, rel: clean } = safePath(vaultId, rel);
    try {
      return await fsp.readFile(abs);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR") throw new HttpError(404, "não encontrado: " + clean);
      throw e;
    }
  }

  // Texto do arquivo, ou null se não existe. Usa o índice pra não ir ao disco atrás de arquivo que
  // não existe (os preamble.tex de cada pasta, na maioria das vezes).
  async function readText(vaultId, rel) {
    const clean = safePath(vaultId, rel).rel;
    const idx = await index(vaultId);
    const entry = idx.entries.get(clean);
    if (!entry || entry.kind !== "file") return null;
    const k = tkey(vaultId, clean);
    const hit = texts.get(k);
    if (hit !== undefined) {
      texts.delete(k); // renova no LRU
      texts.set(k, hit);
      return hit;
    }
    let text;
    try {
      text = (await read(vaultId, clean)).toString("utf8");
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
    cacheText(vaultId, clean, text);
    return text;
  }

  async function exists(vaultId, rel) {
    const clean = safePath(vaultId, rel).rel;
    return (await index(vaultId)).entries.has(clean);
  }

  // Grava de forma atômica (arquivo temporário + rename). baseVersion: se veio, o arquivo atual
  // tem que estar nessa versão; senão 409 (outra aba/aparelho salvou antes).
  async function write(vaultId, rel, data, { baseVersion, maxVaultBytes, maxFileBytes } = {}) {
    const { abs, rel: clean } = safePath(vaultId, rel);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    if (maxFileBytes && buf.length > maxFileBytes) throw new HttpError(413, "arquivo grande demais");
    const idx = await index(vaultId);
    const prev = idx.entries.get(clean);
    if (prev && prev.kind === "folder") throw new HttpError(409, "já existe uma pasta com esse nome");
    if (baseVersion && prev) {
      const old = await fsp.readFile(abs);
      if (versionOf(old) !== baseVersion) {
        const err = new HttpError(409, "o arquivo mudou em outro lugar");
        err.current = { version: versionOf(old), text: TEXT_EXT.has(extOf(clean)) ? old.toString("utf8") : null };
        throw err;
      }
    }
    const oldSize = prev ? prev.size : 0;
    const after = idx.bytes - oldSize + buf.length;
    if (maxVaultBytes && after > maxVaultBytes) throw new HttpError(413, "o cofre passou do limite de espaço");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), ".tmp-" + crypto.randomBytes(6).toString("hex"));
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, abs);
    // atualiza o índice e o cache sem reler o disco
    addParents(idx, clean);
    idx.entries.set(clean, { path: clean, kind: "file", size: buf.length, mtime: Date.now() });
    idx.bytes = after;
    if (TEXT_EXT.has(extOf(clean))) cacheText(vaultId, clean, buf.toString("utf8"));
    else dropText(tkey(vaultId, clean));
    return { path: clean, version: versionOf(buf), size: buf.length, created: !prev };
  }

  async function mkdir(vaultId, rel) {
    const { abs, rel: clean } = safePath(vaultId, rel);
    const idx = await index(vaultId);
    const prev = idx.entries.get(clean);
    if (prev && prev.kind === "file") throw new HttpError(409, "já existe um arquivo com esse nome");
    await fsp.mkdir(abs, { recursive: true });
    addParents(idx, clean);
    idx.entries.set(clean, { path: clean, kind: "folder" });
    return clean;
  }

  async function remove(vaultId, rel) {
    const { abs } = safePath(vaultId, rel);
    await fsp.rm(abs, { recursive: true, force: true });
    invalidate(vaultId);
  }

  async function move(vaultId, from, to) {
    const a = safePath(vaultId, from);
    const b = safePath(vaultId, to);
    if (a.rel === b.rel) return b.rel;
    if (b.abs.startsWith(a.abs + path.sep)) throw new HttpError(400, "não dá pra mover uma pasta pra dentro dela mesma");
    const idx = await index(vaultId);
    if (!idx.entries.has(a.rel)) throw new HttpError(404, "não encontrado: " + a.rel);
    // no Windows "Nota.md" -> "nota.md" é o mesmo arquivo: só recusa se for outro
    if (idx.entries.has(b.rel) && a.rel.toLowerCase() !== b.rel.toLowerCase()) throw new HttpError(409, "já existe algo em " + b.rel);
    await fsp.mkdir(path.dirname(b.abs), { recursive: true });
    await fsp.rename(a.abs, b.abs);
    invalidate(vaultId);
    return b.rel;
  }

  // Apaga o cofre movendo a pasta pra lixeira (dá pra recuperar à mão).
  async function trashVault(vaultId) {
    const trash = path.join(dataDir, "trash");
    await fsp.mkdir(trash, { recursive: true });
    try {
      await fsp.rename(vaultDir(vaultId), path.join(trash, vaultId + "-" + Date.now()));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    invalidate(vaultId);
  }

  return { vaultDir, safePath, createVaultDir, list, filePaths, usedBytes, read, readText, exists, write, mkdir, remove, move, trashVault };
}
