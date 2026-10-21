// Entrega do front-end: cache dos assets com hash, HTML sempre revalidado, brotli pré-comprimido,
// rotas do app caindo no index.html e nada fora da pasta do build.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { buildApp } from "../src/index.js";

let ctx;
let root;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mathsidian-static-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
  const js = "console.log('mathsidian');".repeat(100);
  fs.writeFileSync(path.join(dist, "assets", "app-abc123.js"), js);
  fs.writeFileSync(path.join(dist, "assets", "app-abc123.js.br"), zlib.brotliCompressSync(js));
  fs.writeFileSync(path.join(root, "segredo.txt"), "não pode sair");
  ctx = await buildApp({ dataDir: path.join(root, "data"), webDist: dist, logger: false });
});

after(async () => {
  await ctx.app.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test("assets com hash: cache de um ano e brotli pré-comprimido", async () => {
  const res = await ctx.app.inject({ url: "/assets/app-abc123.js", headers: { "accept-encoding": "br, gzip" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(res.headers["content-encoding"], "br");
  assert.match(res.headers["vary"] || "", /accept-encoding/i);
});

test("index.html revalida sempre e leva a CSP", async () => {
  const res = await ctx.app.inject({ url: "/" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.match(res.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(res.headers["x-frame-options"], "DENY");
});

test("rotas do app devolvem o index.html; API desconhecida é 404 em JSON", async () => {
  let res = await ctx.app.inject({ url: "/v/abc123def456/Pasta/Nota.md" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<title>app<\/title>/);
  res = await ctx.app.inject({ url: "/api/nao-existe" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "não encontrado");
});

test("nada fora da pasta do build é servido", async () => {
  for (const url of ["/../segredo.txt", "/assets/../../segredo.txt", "/%2e%2e/segredo.txt", "/assets/%2e%2e/%2e%2e/segredo.txt", "/..%2fsegredo.txt"]) {
    const res = await ctx.app.inject({ url });
    assert.doesNotMatch(res.body, /não pode sair/, url);
  }
});
