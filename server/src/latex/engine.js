// Motor de LaTeX no servidor (portado do math.js do Mathsidian desktop).
// - Fórmulas ($...$ / $$...$$) são compiladas em lotes: latex -> dvisvgm -> SVG, com cache em disco
//   endereçado pelo conteúdo (o mesmo preâmbulo + fórmula dá o mesmo arquivo pra todo mundo).
// - O cabeçalho (pacotes + preâmbulo) vira um .fmt pré-compilado; um lote com erro é dividido ao meio
//   até isolar a fórmula culpada.
// - Blocos ```tikz / ```latex são documentos inteiros.
// Segurança (o TeX roda código do usuário): sem shell-escape, leitura/escrita só na pasta de trabalho
// (openin_any/openout_any = p, TeX Live), tempo máximo por compilação e limites de tamanho.
// O SVG ainda é sanitizado no navegador (DOMPurify), porque \special{dvisvgm:raw} injeta SVG cru.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

import { snippet, mathHeader, mathBody, mathKeyInput, blockDocument, extractMath } from "../../../shared/tex.js";

export { extractMath };

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

export const LIMITS = { formulaChars: 20000, preambleChars: 100000, blockChars: 100000, itemsPerRequest: 300 };

export function mathKey(source, display, pre) {
  return sha1(mathKeyInput(source, display, pre));
}

// Limpa o SVG do dvisvgm: ids com prefixo (várias fórmulas na mesma página) e preto -> currentColor.
function cleanSvg(svg, key) {
  const prefix = "m" + key.slice(0, 10) + "-";
  return svg
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/id='/g, "id='" + prefix)
    .replace(/href='#/g, "href='#" + prefix)
    .replace(/(fill|stroke)='#000(000)?'/g, "$1='currentColor'")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .trim();
}

export function createEngine({ dataDir, workers = 3, timeoutMs = 20000, log = console }) {
  const cacheRoot = path.join(dataDir, "latex-cache");
  const dirs = {};
  for (const sub of ["math", "blocks", "fmt", "work"]) fs.mkdirSync((dirs[sub] = path.join(cacheRoot, sub)), { recursive: true });

  // TeX instalado: no Windows (desenvolvimento) procura o MiKTeX nos lugares padrão.
  function texEnv() {
    const env = { ...process.env, openin_any: "p", openout_any: "p", shell_escape: "f" };
    if (process.platform !== "win32") return env;
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    const extra = [
      path.join(env.LOCALAPPDATA || "", "Programs", "MiKTeX", "miktex", "bin", "x64"),
      path.join(env.ProgramFiles || "C:\\Program Files", "MiKTeX", "miktex", "bin", "x64"),
    ].filter((d) => fs.existsSync(path.join(d, "latex.exe")));
    env[key] = extra.concat([env[key] || ""]).join(path.delimiter);
    return env;
  }
  const ENV = texEnv();

  function run(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, env: ENV, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = String(stdout || "") + String(stderr || "");
        if (err) {
          err.output = out;
          reject(err);
        } else resolve(out);
      });
    });
  }

  function errorSummary(dir, err) {
    if (err.killed || err.signal === "SIGTERM") return "Tempo esgotado: o LaTeX demorou demais.";
    let log = "";
    try {
      log = fs.readFileSync(path.join(dir, "doc.log"), "utf8");
    } catch {}
    const lines = (log || err.output || "").split(/\r?\n/);
    const idx = lines.findIndex((l) => l.startsWith("!"));
    if (idx >= 0) return lines.slice(idx, idx + 4).join("\n");
    if (err.code === "ENOENT") return "TeX não encontrado no servidor (precisa de latex e dvisvgm).";
    return String(err.message || err).slice(0, 500);
  }

  // ---------- workers com prioridade ----------
  const freeSlots = Array.from({ length: workers }, (_, i) => i);
  const waiting = { high: [], low: [] };
  const backgroundMax = Math.max(1, workers - 1);
  let busyLow = 0;

  function pump() {
    while (freeSlots.length) {
      let next = waiting.high.shift();
      if (!next && busyLow < backgroundMax) next = waiting.low.shift();
      if (!next) return;
      const slot = freeSlots.shift();
      if (next.low) busyLow++;
      next.resolve(slot);
    }
  }

  async function withSlot(low, job) {
    const slot = await new Promise((resolve) => {
      (low ? waiting.low : waiting.high).push({ low, resolve });
      pump();
    });
    try {
      return await job(slot);
    } finally {
      if (low) busyLow--;
      freeSlots.push(slot);
      pump();
    }
  }

  function slotDir(slot) {
    const d = path.join(dirs.work, "w" + slot);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  // ---------- formato pré-compilado ----------
  const formats = new Map();
  function ensureFormat(header) {
    const name = "m" + sha1(header).slice(0, 12);
    if (formats.has(name)) return formats.get(name);
    const job = fs.existsSync(path.join(dirs.fmt, name + ".fmt"))
      ? Promise.resolve(name)
      : withSlot(false, async () => {
          fs.writeFileSync(path.join(dirs.fmt, name + ".tex"), header + "\n\\dump\n");
          try {
            await run("latex", ["-ini", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-jobname=" + name, "&latex", name + ".tex"], dirs.fmt);
            return name;
          } catch {
            return null;
          }
        });
    formats.set(name, job);
    if (formats.size > 500) formats.delete(formats.keys().next().value);
    return job;
  }

  function clearDir(dir) {
    for (const f of fs.readdirSync(dir)) if (!f.endsWith(".fmt")) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  }

  async function compileDocument(doc, slot, fmt) {
    const dir = slotDir(slot);
    clearDir(dir);
    fs.writeFileSync(path.join(dir, "doc.tex"), doc);
    const args = ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "doc.tex"];
    if (fmt) {
      const target = path.join(dir, fmt + ".fmt");
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(dirs.fmt, fmt + ".fmt"), target);
      args.unshift("-fmt=" + fmt);
    }
    try {
      await run("latex", args, dir);
      const out = await run("dvisvgm", ["--no-fonts", "--currentcolor", "--bbox=preview", "--page=1-", "--output=p%p.svg", "doc.dvi"], dir);
      const dims = [];
      out.replace(/width=([\d.]+)pt, height=([\d.]+)pt, depth=([\d.]+)pt/g, (_, w, h, d) => {
        dims.push({ width: +w, height: +h, depth: +d });
      });
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^p\d+\.svg$/.test(f))
        .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
      return dims.map((dim, i) => ({ ...dim, svg: fs.readFileSync(path.join(dir, files[i]), "utf8") }));
    } catch (err) {
      const e = new Error(errorSummary(dir, err));
      e.timeout = !!(err.killed || err.signal === "SIGTERM");
      throw e;
    }
  }

  // ---------- fórmulas ----------
  const memory = new Map(); // key -> resultado (LRU simples)
  const MEMORY_MAX = 5000;
  const inflight = new Map(); // key -> Promise
  const pending = new Map(); // key -> {tex, display, pre, low, resolve}
  let timer = null;

  function remember(key, result) {
    memory.delete(key);
    memory.set(key, result);
    if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
  }

  function cached(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      const page = JSON.parse(fs.readFileSync(path.join(dirs.math, key + ".json"), "utf8"));
      remember(key, page);
      return page;
    } catch {
      return null;
    }
  }

  function settle(key, result) {
    if (!result.error) fs.writeFile(path.join(dirs.math, key + ".json"), JSON.stringify(result), () => {});
    remember(key, result);
    const p = pending.get(key);
    pending.delete(key);
    if (p) p.resolve(result);
  }

  async function compileBatch(items, slot, fmt) {
    const body = mathBody(items.map((it) => snippet(it.tex, it.display)));
    let pages;
    try {
      pages = await compileDocument(fmt ? body : mathHeader(items[0].pre) + "\n" + body, slot, fmt);
      if (pages.length !== items.length) throw new Error("número de páginas inesperado");
    } catch (err) {
      // tempo esgotado não se divide (seria multiplicar o custo de uma fórmula abusiva)
      if (items.length === 1 || err.timeout) {
        for (const it of items) settle(it.key, { error: err.message });
        return;
      }
      const mid = Math.ceil(items.length / 2);
      await compileBatch(items.slice(0, mid), slot, fmt);
      await compileBatch(items.slice(mid), slot, fmt);
      return;
    }
    items.forEach((it, i) => {
      const p = pages[i];
      settle(it.key, { width: p.width, height: p.height, depth: p.depth, svg: cleanSvg(p.svg, it.key) });
    });
  }

  function flush() {
    timer = null;
    const groups = new Map();
    for (const [key, it] of pending) {
      if (it.scheduled) continue;
      it.scheduled = true;
      const g = it.pre + "\0" + (it.low ? "L" : "H");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ key, ...it });
    }
    for (const group of groups.values()) {
      const low = group[0].low;
      const size = low ? 60 : Math.max(8, Math.ceil(group.length / workers));
      const fmtJob = ensureFormat(mathHeader(group[0].pre));
      for (let i = 0; i < group.length; i += size) {
        const chunk = group.slice(i, i + size);
        fmtJob
          .then((fmt) => withSlot(low, (slot) => compileBatch(chunk, slot, fmt)))
          .catch((err) => {
            log.error && log.error(err);
            for (const it of chunk) settle(it.key, { error: "erro interno ao compilar" });
          });
      }
    }
  }

  // items: [{tex, display}] -> Promise<[{key, svg, width, height, depth} | {key, error}]>
  function renderMath(items, pre, { low = false } = {}) {
    if (pre.length > LIMITS.preambleChars) return Promise.resolve(items.map(() => ({ error: "preâmbulo grande demais" })));
    return Promise.all(
      items.map((it) => {
        const tex = String(it.tex || "").trim();
        const display = !!it.display;
        if (!tex) return { key: "", error: "fórmula vazia" };
        if (tex.length > LIMITS.formulaChars) return { key: "", error: "fórmula grande demais" };
        const key = mathKey(tex, display, pre);
        const hit = cached(key);
        if (hit) return { key, ...hit };
        if (inflight.has(key)) return inflight.get(key);
        const p = new Promise((resolve) => {
          pending.set(key, { tex, display, pre, low, resolve: (r) => resolve({ key, ...r }) });
          if (!timer) timer = setTimeout(flush, 30);
        }).finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
      })
    );
  }

  // ---------- blocos ----------
  const blockJobs = new Map();
  function renderBlock(lang, body, pre) {
    if (body.length > LIMITS.blockChars) return Promise.resolve({ error: "bloco grande demais" });
    const doc = blockDocument(lang, body, pre);
    const key = sha1(doc);
    const file = path.join(dirs.blocks, key + ".json");
    try {
      return Promise.resolve({ key, ...JSON.parse(fs.readFileSync(file, "utf8")) });
    } catch {}
    if (blockJobs.has(key)) return blockJobs.get(key);
    const job = withSlot(false, (slot) => compileDocument(doc, slot))
      .then((pages) => {
        const p = pages[0];
        if (!p) throw new Error("o bloco não gerou nada");
        const result = { width: p.width, height: p.height, depth: p.depth, svg: cleanSvg(p.svg, key) };
        fs.writeFileSync(file, JSON.stringify(result));
        return { key, ...result };
      })
      .catch((err) => ({ key, error: err.message }))
      .finally(() => blockJobs.delete(key));
    blockJobs.set(key, job);
    return job;
  }

  // Compila o preâmbulo com uma fórmula de teste: null se compilou, senão a mensagem do TeX.
  async function checkPreamble(pre) {
    if (pre.length > LIMITS.preambleChars) return "preâmbulo grande demais";
    const doc = mathHeader(pre) + "\n" + mathBody([snippet("x", false)]);
    try {
      await withSlot(false, (slot) => compileDocument(doc, slot));
      return null;
    } catch (err) {
      return err.message;
    }
  }

  async function available() {
    try {
      await run("latex", ["--version"], dirs.work);
      await run("dvisvgm", ["--version"], dirs.work);
      return true;
    } catch {
      return false;
    }
  }

  return { renderMath, renderBlock, checkPreamble, available };
}
