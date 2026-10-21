// Rotas dos cofres: lista, arquivos, preâmbulos, renderização de LaTeX, backups.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { zipSync, unzipSync } from "fflate";
import { HttpError, TEXT_EXT, extOf, versionOf } from "./storage.js";
import { requireUser, newId } from "./auth.js";
import { preambleLayers, composePreamble, setInlinePreamble, splitFrontmatter, INLINE, PREAMBLE_NAME } from "./preamble.js";
import { extractMath, LIMITS } from "./latex/engine.js";
import { WELCOME_FILES } from "./welcome.js";

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf",
};

export function registerVaults(app, { db, config, storage, engine }) {
  const q = {
    list: db.prepare("select id, name, created_at, updated_at, snapshot_at from vaults where owner_id = ? order by created_at"),
    get: db.prepare("select * from vaults where id = ? and owner_id = ?"),
    insert: db.prepare("insert into vaults (id, owner_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)"),
    rename: db.prepare("update vaults set name = ? where id = ?"),
    touch: db.prepare("update vaults set updated_at = ? where id = ?"),
    remove: db.prepare("delete from vaults where id = ?"),
    snapDue: db.prepare("select id from vaults where updated_at > snapshot_at and snapshot_at < ?"),
    snapDone: db.prepare("update vaults set snapshot_at = ? where id = ?"),
  };

  function vaultOf(req) {
    const user = requireUser(req);
    const v = q.get.get(req.params.id, user.id);
    if (!v) throw new HttpError(404, "cofre não encontrado");
    return v;
  }

  function cleanName(name) {
    const n = String(name || "").trim().slice(0, 80);
    if (!n) throw new HttpError(400, "dê um nome ao cofre");
    return n;
  }

  async function createVault(userId, name, files) {
    const id = newId();
    const now = Date.now();
    await storage.createVaultDir(id);
    for (const [p, content] of Object.entries(files || {})) await storage.write(id, p, content);
    q.insert.run(id, userId, name, now, now);
    return { id, name, created_at: now, updated_at: now, snapshot_at: 0 };
  }

  // Conta nova já começa com um cofre de boas-vindas.
  const onUserCreated = (userId) => createVault(userId, "Meu cofre", WELCOME_FILES);

  // ---------- cofres ----------
  app.get("/api/vaults", async (req) => ({ vaults: q.list.all(requireUser(req).id) }));

  app.post("/api/vaults", async (req) => {
    const user = requireUser(req);
    if (q.list.all(user.id).length >= 50) throw new HttpError(400, "limite de cofres atingido");
    return { vault: await createVault(user.id, cleanName(req.body && req.body.name), {}) };
  });

  app.patch("/api/vaults/:id", async (req) => {
    const v = vaultOf(req);
    const name = cleanName(req.body && req.body.name);
    q.rename.run(name, v.id);
    return { vault: { ...v, name } };
  });

  app.delete("/api/vaults/:id", async (req) => {
    const v = vaultOf(req);
    await storage.trashVault(v.id);
    q.remove.run(v.id);
    return { ok: true };
  });

  // ---------- arquivos ----------
  app.get("/api/vaults/:id/tree", async (req) => {
    const v = vaultOf(req);
    return { entries: await storage.list(v.id), used: await storage.usedBytes(v.id), limit: config.maxVaultBytes };
  });

  // ETag = versão do conteúdo: reabrir uma nota que não mudou responde 304 sem corpo.
  app.get("/api/vaults/:id/file", async (req, reply) => {
    const v = vaultOf(req);
    const p = storage.safePath(v.id, req.query.path).rel;
    const buf = await storage.read(v.id, p);
    const version = versionOf(buf);
    reply.header("x-version", version);
    reply.header("etag", '"' + version + '"');
    reply.header("cache-control", "private, no-cache");
    if (req.headers["if-none-match"] === '"' + version + '"') return reply.code(304).send();
    const ext = extOf(p);
    if (TEXT_EXT.has(ext)) return reply.type("text/plain; charset=utf-8").send(buf.toString("utf8"));
    reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.type(MIME[ext] || "application/octet-stream").send(buf);
  });

  // corpo: texto (text/plain) ou binário (application/octet-stream). Cabeçalho x-base-version opcional.
  app.put("/api/vaults/:id/file", { bodyLimit: config.maxFileBytes + 1024 }, async (req) => {
    const v = vaultOf(req);
    const body = req.body == null ? "" : req.body;
    let res;
    try {
      res = await storage.write(v.id, req.query.path, body, {
        baseVersion: req.headers["x-base-version"] || undefined,
        maxVaultBytes: config.maxVaultBytes,
        maxFileBytes: config.maxFileBytes,
      });
    } catch (e) {
      if (e.statusCode === 409 && e.current) {
        const err = new HttpError(409, e.message);
        err.payload = { current: e.current };
        throw err;
      }
      throw e;
    }
    q.touch.run(Date.now(), v.id);
    if (extOf(res.path) === "md" && typeof body === "string") prewarm(v.id, res.path, body);
    return res;
  });

  app.post("/api/vaults/:id/folder", async (req) => {
    const v = vaultOf(req);
    const p = await storage.mkdir(v.id, req.body && req.body.path);
    q.touch.run(Date.now(), v.id);
    return { path: p };
  });

  app.post("/api/vaults/:id/move", async (req) => {
    const v = vaultOf(req);
    const { from, to } = req.body || {};
    const p = await storage.move(v.id, from, to);
    q.touch.run(Date.now(), v.id);
    return { path: p };
  });

  app.delete("/api/vaults/:id/entry", async (req) => {
    const v = vaultOf(req);
    await storage.remove(v.id, storage.safePath(v.id, req.query.path).rel);
    q.touch.run(Date.now(), v.id);
    return { ok: true };
  });

  // ---------- preâmbulos ----------
  // Tudo em memória depois da primeira vez (índice + cache de textos do storage).
  async function layersFor(vaultId, notePath, frontmatterRaw) {
    const files = await storage.filePaths(vaultId);
    const note = notePath ? storage.safePath(vaultId, notePath).rel : null;
    return preambleLayers({
      notePath: note,
      files,
      frontmatterRaw,
      readFile: (p) => storage.readText(vaultId, p),
    });
  }

  function overridesFrom(obj) {
    const m = new Map();
    for (const [k, val] of Object.entries(obj || {})) if (typeof val === "string") m.set(k === "inline" ? INLINE : k, val);
    return m;
  }

  // ?note=Pasta/nota.md -> { layers, preamble }
  app.get("/api/vaults/:id/preamble", async (req) => {
    const v = vaultOf(req);
    const layers = await layersFor(v.id, req.query.note || null);
    return { layers, preamble: composePreamble(layers) };
  });

  // Igual, mas com o cabeçalho YAML que está no editor (ainda não salvo). O cliente usa o texto do
  // preâmbulo pra calcular as chaves das fórmulas e achar no cache local sem perguntar ao servidor.
  app.post("/api/vaults/:id/preamble/resolve", async (req) => {
    const v = vaultOf(req);
    const { note, frontmatter } = req.body || {};
    const layers = await layersFor(v.id, note || null, typeof frontmatter === "string" || frontmatter === null ? frontmatter : undefined);
    return { layers, preamble: composePreamble(layers) };
  });

  // { note, overrides: { "Pasta/preamble.tex": "...", inline: "..." } } -> { error: null | "..." }
  app.post("/api/vaults/:id/preamble/check", async (req) => {
    const v = vaultOf(req);
    const { note, overrides } = req.body || {};
    const layers = await layersFor(v.id, note || null);
    const pre = composePreamble(layers, overridesFrom(overrides));
    return { error: await engine.checkPreamble(pre) };
  });

  // Grava o LaTeX direto da nota na propriedade "preamble" (mantém os arquivos citados).
  app.put("/api/vaults/:id/preamble/inline", async (req) => {
    const v = vaultOf(req);
    const { note, latex, baseVersion } = req.body || {};
    const p = storage.safePath(v.id, note).rel;
    const text = (await storage.readText(v.id, p)) ?? "";
    let next;
    try {
      next = setInlinePreamble(text, latex);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const res = await storage.write(v.id, p, next, { baseVersion, maxVaultBytes: config.maxVaultBytes });
    q.touch.run(Date.now(), v.id);
    return { ...res, text: next };
  });

  // ---------- LaTeX ----------
  // { note, frontmatter?, items: [{tex, display}] } -> { results: [...] }
  app.post("/api/vaults/:id/render", { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const v = vaultOf(req);
    const { note, frontmatter, items } = req.body || {};
    if (!Array.isArray(items) || items.length > LIMITS.itemsPerRequest) throw new HttpError(400, "lista de fórmulas inválida");
    const layers = await layersFor(v.id, note || null, typeof frontmatter === "string" || frontmatter === null ? frontmatter : undefined);
    const pre = composePreamble(layers);
    return { results: await engine.renderMath(items, pre) };
  });

  // { note, frontmatter?, lang: "tikz" | "latex", source } -> resultado
  app.post("/api/vaults/:id/render-block", { bodyLimit: 1024 * 1024 }, async (req) => {
    const v = vaultOf(req);
    const { note, frontmatter, lang, source } = req.body || {};
    if (lang !== "tikz" && lang !== "latex") throw new HttpError(400, "linguagem inválida");
    const layers = await layersFor(v.id, note || null, typeof frontmatter === "string" || frontmatter === null ? frontmatter : undefined);
    return engine.renderBlock(lang, String(source || ""), composePreamble(layers));
  });

  // Ao salvar uma nota, compila as fórmulas dela no fundo: quando o leitor abrir, já estão prontas.
  function prewarm(vaultId, notePath, text) {
    const items = extractMath(text).slice(0, 500);
    if (!items.length) return;
    layersFor(vaultId, notePath, splitFrontmatter(text).raw)
      .then((layers) => engine.renderMath(items, composePreamble(layers), { low: true }))
      .catch(() => {});
  }

  // ---------- backups ----------
  async function zipVault(vaultId) {
    const entries = await storage.list(vaultId);
    const files = {};
    for (const e of entries) {
      if (e.kind === "folder") files[e.path + "/"] = new Uint8Array(0);
      else files[e.path] = new Uint8Array(await storage.read(vaultId, e.path));
    }
    return Buffer.from(zipSync(files, { level: 6 }));
  }

  const safeFileName = (s) => s.replace(/[^\p{L}\p{N} _.-]+/gu, "_").trim() || "cofre";
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  app.get("/api/vaults/:id/backup", async (req, reply) => {
    const v = vaultOf(req);
    const buf = await zipVault(v.id);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(v.name) + "-" + stamp() + ".zip")}`);
    return reply.type("application/zip").send(buf);
  });

  // multipart: file (.zip) + name -> cofre novo com o conteúdo do zip
  app.post("/api/vaults/import", async (req) => {
    const user = requireUser(req);
    const part = await req.file({ limits: { fileSize: config.maxVaultBytes } });
    if (!part) throw new HttpError(400, "envie um arquivo .zip");
    const buf = await part.toBuffer();
    const name = cleanName((part.fields.name && part.fields.name.value) || part.filename.replace(/\.zip$/i, ""));
    let unzipped;
    try {
      unzipped = unzipSync(new Uint8Array(buf));
    } catch {
      throw new HttpError(400, "o arquivo não é um .zip válido");
    }
    // um zip de "Cofre/..." (pasta única no topo) importa o conteúdo da pasta
    const paths = Object.keys(unzipped).filter((p) => !p.endsWith("/") && !/(^|\/)(\.obsidian|\.trash|__MACOSX)(\/|$)/.test(p));
    const tops = new Set(paths.map((p) => p.split("/")[0]));
    const strip = tops.size === 1 && paths.every((p) => p.includes("/")) ? [...tops][0].length + 1 : 0;
    const files = {};
    let total = 0;
    for (const p of paths) {
      total += unzipped[p].length;
      if (total > config.maxVaultBytes) throw new HttpError(413, "o cofre passou do limite de espaço");
      files[p.slice(strip)] = Buffer.from(unzipped[p]);
    }
    const vault = await createVault(user.id, name, {});
    try {
      for (const [p, content] of Object.entries(files)) await storage.write(vault.id, p, content);
    } catch (e) {
      await storage.trashVault(vault.id);
      q.remove.run(vault.id);
      throw e;
    }
    return { vault, files: Object.keys(files).length };
  });

  // Snapshots automáticos no servidor: um .zip por cofre alterado, a cada SNAPSHOT_HOURS.
  const snapRoot = path.join(config.dataDir, "snapshots");
  const snapDir = (id) => path.join(snapRoot, id);

  async function takeSnapshot(vaultId) {
    const dir = snapDir(vaultId);
    await fsp.mkdir(dir, { recursive: true });
    const name = stamp() + ".zip";
    await fsp.writeFile(path.join(dir, name), await zipVault(vaultId));
    q.snapDone.run(Date.now(), vaultId);
    const all = (await fsp.readdir(dir)).filter((f) => f.endsWith(".zip")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - config.snapshotKeep))) await fsp.rm(path.join(dir, old), { force: true });
    return name;
  }

  app.get("/api/vaults/:id/snapshots", async (req) => {
    const v = vaultOf(req);
    let files = [];
    try {
      files = (await fsp.readdir(snapDir(v.id))).filter((f) => f.endsWith(".zip")).sort().reverse();
    } catch {}
    const list = await Promise.all(files.map(async (f) => ({ name: f, size: (await fsp.stat(path.join(snapDir(v.id), f))).size })));
    return { snapshots: list, everyHours: config.snapshotEveryHours, keep: config.snapshotKeep };
  });

  app.post("/api/vaults/:id/snapshots", async (req) => {
    const v = vaultOf(req);
    return { name: await takeSnapshot(v.id) };
  });

  app.get("/api/vaults/:id/snapshots/:name", async (req, reply) => {
    const v = vaultOf(req);
    const name = req.params.name;
    if (!/^[\d-]+\.zip$/.test(name)) throw new HttpError(400, "nome inválido");
    const file = path.join(snapDir(v.id), name);
    if (!fs.existsSync(file)) throw new HttpError(404, "snapshot não encontrado");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(v.name) + "-" + name)}`);
    return reply.type("application/zip").send(fs.createReadStream(file));
  });

  function startSnapshots() {
    const tick = async () => {
      const due = q.snapDue.all(Date.now() - config.snapshotEveryHours * 3600000);
      for (const { id } of due) {
        try {
          await takeSnapshot(id);
        } catch (e) {
          app.log.error({ err: e, vault: id }, "snapshot falhou");
        }
      }
    };
    const timer = setInterval(tick, 15 * 60 * 1000);
    timer.unref();
    return timer;
  }

  return { onUserCreated, startSnapshots, takeSnapshot, PREAMBLE_NAME };
}

