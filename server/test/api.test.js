// Testes de ponta a ponta da API (node --test). Usa uma pasta de dados temporária.
// As partes de LaTeX rodam só se latex e dvisvgm estiverem instalados.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { buildApp } from "../src/index.js";
import { setInlinePreamble, resolveLink, folderChain } from "../src/preamble.js";

let ctx;
let dataDir;
let hasTex = false;
const H = { "x-mathsidian": "1" };

function cookieOf(res) {
  const c = res.headers["set-cookie"];
  const first = Array.isArray(c) ? c[0] : c;
  return first.split(";")[0];
}

async function api(method, url, { cookie, body, headers = {}, raw } = {}) {
  const opts = { method, url, headers: { ...H, ...headers } };
  if (cookie) opts.headers.cookie = cookie;
  if (raw !== undefined) {
    opts.payload = raw;
  } else if (body !== undefined) {
    opts.payload = body;
  }
  return ctx.app.inject(opts);
}

async function register(email, invite = "amigos") {
  const res = await api("POST", "/api/auth/register", { body: { email, name: "Teste", password: "senha-forte-123", invite } });
  assert.equal(res.statusCode, 200, res.body);
  return cookieOf(res);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mathsidian-web-test-"));
  ctx = await buildApp({ dataDir, registration: "invite", inviteCodes: ["amigos"], signupsPerHour: 1000, logger: false, webDist: path.join(dataDir, "sem-web") });
  hasTex = await ctx.engine.available();
});

after(async () => {
  await ctx.app.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test("escrita sem o cabeçalho anti-CSRF é recusada", async () => {
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "a@b.co", password: "12345678", invite: "amigos" } });
  assert.equal(res.statusCode, 403);
});

test("cadastro exige convite válido e senha de 8+", async () => {
  let res = await api("POST", "/api/auth/register", { body: { email: "x@y.co", password: "senha-forte-123", invite: "errado" } });
  assert.equal(res.statusCode, 403);
  res = await api("POST", "/api/auth/register", { body: { email: "x@y.co", password: "curta", invite: "amigos" } });
  assert.equal(res.statusCode, 400);
});

test("conta nova já vem com o cofre de boas-vindas", async () => {
  const cookie = await register("ana@exemplo.com");
  const me = await api("GET", "/api/auth/me", { cookie });
  assert.equal(me.json().user.email, "ana@exemplo.com");
  const { vaults } = (await api("GET", "/api/vaults", { cookie })).json();
  assert.equal(vaults.length, 1);
  const tree = (await api("GET", `/api/vaults/${vaults[0].id}/tree`, { cookie })).json();
  const paths = tree.entries.map((e) => e.path);
  for (const p of ["Bem-vindo.md", "preamble.tex", "Álgebra", "Álgebra/Grupos.md", "Álgebra/preamble.tex"]) assert.ok(paths.includes(p), p);
});

test("login, senha errada e sair", async () => {
  await register("bia@exemplo.com");
  let res = await api("POST", "/api/auth/login", { body: { email: "bia@exemplo.com", password: "errada-errada" } });
  assert.equal(res.statusCode, 401);
  res = await api("POST", "/api/auth/login", { body: { email: "BIA@exemplo.com", password: "senha-forte-123" } });
  assert.equal(res.statusCode, 200);
  const cookie = cookieOf(res);
  assert.equal((await api("POST", "/api/auth/logout", { cookie })).statusCode, 200);
  assert.equal((await api("GET", "/api/auth/me", { cookie })).json().user, null);
});

test("arquivos: gravar, ler com ETag/304, conflito de versão, caminhos maliciosos", async () => {
  const cookie = await register("caio@exemplo.com");
  const vault = (await api("GET", "/api/vaults", { cookie })).json().vaults[0];
  const base = `/api/vaults/${vault.id}`;
  const enc = encodeURIComponent;

  let res = await api("PUT", `${base}/file?path=${enc("Notas/Teste.md")}`, { cookie, raw: "# Oi\n\n$x^2$\n", headers: { "content-type": "text/plain" } });
  assert.equal(res.statusCode, 200, res.body);
  const v1 = res.json().version;

  res = await api("GET", `${base}/file?path=${enc("Notas/Teste.md")}`, { cookie });
  assert.equal(res.body, "# Oi\n\n$x^2$\n");
  assert.equal(res.headers["x-version"], v1);
  res = await api("GET", `${base}/file?path=${enc("Notas/Teste.md")}`, { cookie, headers: { "if-none-match": `"${v1}"` } });
  assert.equal(res.statusCode, 304);

  res = await api("PUT", `${base}/file?path=${enc("Notas/Teste.md")}`, { cookie, raw: "versão 2", headers: { "content-type": "text/plain", "x-base-version": v1 } });
  assert.equal(res.statusCode, 200);
  res = await api("PUT", `${base}/file?path=${enc("Notas/Teste.md")}`, { cookie, raw: "versão velha", headers: { "content-type": "text/plain", "x-base-version": v1 } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().current.text, "versão 2");

  for (const bad of ["../fora.md", "a/../../fora.md", "C:\\x.md", "a//b.md", "con:x.md", "..", "a/./b.md"]) {
    res = await api("GET", `${base}/file?path=${enc(bad)}`, { cookie });
    assert.equal(res.statusCode, 400, bad);
  }
  // barra no começo vale como raiz do cofre: "/etc/passwd" é "etc/passwd" dentro do cofre (não existe)
  res = await api("GET", `${base}/file?path=${enc("/etc/passwd")}`, { cookie });
  assert.equal(res.statusCode, 404);

  res = await api("POST", `${base}/move`, { cookie, body: { from: "Notas/Teste.md", to: "Outra/Renomeada.md" } });
  assert.equal(res.statusCode, 200);
  const tree = (await api("GET", `${base}/tree`, { cookie })).json().entries.map((e) => e.path);
  assert.ok(tree.includes("Outra/Renomeada.md") && !tree.includes("Notas/Teste.md"));
  res = await api("DELETE", `${base}/entry?path=Outra`, { cookie });
  assert.equal(res.statusCode, 200);
  assert.ok(!(await api("GET", `${base}/tree`, { cookie })).json().entries.some((e) => e.path.startsWith("Outra")));
});

test("um usuário não enxerga o cofre do outro", async () => {
  const a = await register("dani@exemplo.com");
  const b = await register("edu@exemplo.com");
  const va = (await api("GET", "/api/vaults", { cookie: a })).json().vaults[0];
  const res = await api("GET", `/api/vaults/${va.id}/tree`, { cookie: b });
  assert.equal(res.statusCode, 404);
  assert.equal((await api("GET", `/api/vaults/${va.id}/tree`)).statusCode, 401);
});

test("preâmbulo em cascata: raiz, pasta, arquivo citado e LaTeX da nota", async () => {
  const cookie = await register("fe@exemplo.com");
  const vault = (await api("GET", "/api/vaults", { cookie })).json().vaults[0];
  const base = `/api/vaults/${vault.id}`;
  const enc = encodeURIComponent;

  let r = (await api("GET", `${base}/preamble?note=${enc("Álgebra/Grupos.md")}`, { cookie })).json();
  assert.deepEqual(
    r.layers.map((l) => l.kind + ":" + l.path),
    ["vault:preamble.tex", "folder:Álgebra/preamble.tex", "inline:Álgebra/Grupos.md"]
  );
  assert.match(r.preamble, /\\newcommand\{\\R\}/);
  assert.match(r.preamble, /\\newcommand\{\\G\}/);

  r = (await api("GET", `${base}/preamble?note=${enc("Bem-vindo.md")}`, { cookie })).json();
  assert.match(r.preamble, /\\eps/);
  assert.doesNotMatch(r.preamble, /\\G\}/);

  await api("PUT", `${base}/file?path=${enc("extras/topologia.tex")}`, { cookie, raw: "\\newcommand{\\T}{\\mathcal{T}}\n", headers: { "content-type": "text/plain" } });
  r = (await api("POST", `${base}/preamble/resolve`, { cookie, body: { note: "Bem-vindo.md", frontmatter: 'preamble: "[[topologia]]"' } })).json();
  assert.ok(r.layers.some((l) => l.kind === "link" && l.path === "extras/topologia.tex" && l.exists));
  assert.match(r.preamble, /\\mathcal\{T\}/);
  assert.doesNotMatch(r.preamble, /\\eps/); // o cabeçalho enviado substitui o salvo

  const res = await api("PUT", `${base}/preamble/inline`, { cookie, body: { note: "Bem-vindo.md", latex: "\\newcommand{\\Q}{\\mathbb{Q}}" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().text, /^---\npreamble: \|?-?\s*\n?\s*\\newcommand\{\\Q\}/);
});

test("funções de preâmbulo", () => {
  assert.deepEqual(folderChain("a/b/n.md"), ["preamble.tex", "a/preamble.tex", "a/b/preamble.tex"]);
  const files = ["x/topologia.tex", "topologia.tex", "y/z/medida.tex"];
  assert.equal(resolveLink("[[topologia]]", files), "topologia.tex");
  assert.equal(resolveLink("medida", files), "y/z/medida.tex");
  assert.equal(resolveLink("x/topologia", files), "x/topologia.tex");
  assert.equal(resolveLink("[[nada]]", files), null);
  const t = setInlinePreamble('---\ntags: [a]\npreamble: ["[[topologia]]", "\\\\def\\\\a{1}"]\n---\ncorpo', "\\def\\b{2}");
  assert.match(t, /tags:/);
  assert.match(t, /\[\[topologia\]\]/);
  assert.match(t, /\\def\\b\{2\}/);
  assert.doesNotMatch(t, /\\def\\a/);
  assert.equal(setInlinePreamble("---\npreamble: \\x\n---\ncorpo", ""), "corpo");
  assert.equal(setInlinePreamble("sem cabeçalho", ""), "sem cabeçalho");
});

test("backup .zip, importação e snapshots", async () => {
  const cookie = await register("gui@exemplo.com");
  const vault = (await api("GET", "/api/vaults", { cookie })).json().vaults[0];
  let res = await api("GET", `/api/vaults/${vault.id}/backup`, { cookie });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/zip");
  const files = unzipSync(new Uint8Array(res.rawPayload));
  assert.match(strFromU8(files["Bem-vindo.md"]), /Bem-vindo/);

  const zip = zipSync({ "Meu Cofre/A.md": strToU8("# A"), "Meu Cofre/sub/B.md": strToU8("# B"), "Meu Cofre/.obsidian/app.json": strToU8("{}") });
  const boundary = "----ms" + Date.now();
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nImportado\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cofre.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    Buffer.from(zip),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  res = await api("POST", "/api/vaults/import", { cookie, raw: payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().files, 2);
  const tree = (await api("GET", `/api/vaults/${res.json().vault.id}/tree`, { cookie })).json().entries.map((e) => e.path);
  assert.ok(tree.includes("A.md") && tree.includes("sub/B.md") && !tree.some((p) => p.includes(".obsidian")));

  res = await api("POST", `/api/vaults/${vault.id}/snapshots`, { cookie });
  assert.equal(res.statusCode, 200);
  const snaps = (await api("GET", `/api/vaults/${vault.id}/snapshots`, { cookie })).json().snapshots;
  assert.equal(snaps.length, 1);
  res = await api("GET", `/api/vaults/${vault.id}/snapshots/${snaps[0].name}`, { cookie });
  assert.equal(res.statusCode, 200);
  assert.ok(unzipSync(new Uint8Array(res.rawPayload))["Bem-vindo.md"]);
});

test("LaTeX: fórmulas com o preâmbulo certo, blocos e verificação", { timeout: 240000 }, async (t) => {
  if (!hasTex) return t.skip("latex/dvisvgm não instalados");
  const cookie = await register("hel@exemplo.com");
  const vault = (await api("GET", "/api/vaults", { cookie })).json().vaults[0];
  const base = `/api/vaults/${vault.id}`;

  let res = await api("POST", `${base}/render`, {
    cookie,
    body: { note: "Álgebra/Grupos.md", items: [{ tex: "\\G \\times \\R", display: false }, { tex: "\\int_0^1 x\\,dx", display: true }, { tex: "\\naoexiste", display: false }] },
  });
  assert.equal(res.statusCode, 200, res.body);
  let r = res.json().results;
  assert.ok(r[0].svg && r[0].svg.startsWith("<svg"), JSON.stringify(r[0]).slice(0, 200));
  assert.ok(r[1].svg && r[1].width > 0);
  assert.match(r[2].error, /Undefined control sequence/);
  assert.equal(r[0].key.length, 40);

  // \G não existe fora da pasta Álgebra
  r = (await api("POST", `${base}/render`, { cookie, body: { note: "Bem-vindo.md", items: [{ tex: "\\G", display: false }, { tex: "\\eps", display: false }] } })).json().results;
  assert.ok(r[0].error);
  assert.ok(r[1].svg);

  // a mesma fórmula de novo sai do cache, na hora
  const t0 = Date.now();
  r = (await api("POST", `${base}/render`, { cookie, body: { note: "Álgebra/Grupos.md", items: [{ tex: "\\G \\times \\R", display: false }] } })).json().results;
  assert.ok(r[0].svg);
  assert.ok(Date.now() - t0 < 500, "cache lento: " + (Date.now() - t0) + " ms");

  res = await api("POST", `${base}/render-block`, { cookie, body: { note: "Bem-vindo.md", lang: "tikz", source: "\\draw (0,0) circle (1);" } });
  assert.ok(res.json().svg, res.body.slice(0, 300));

  r = (await api("POST", `${base}/preamble/check`, { cookie, body: { note: "Álgebra/Grupos.md", overrides: { "Álgebra/preamble.tex": "\\newcommand{\\R}{x}" } } })).json();
  assert.match(r.error, /already defined/);
  r = (await api("POST", `${base}/preamble/check`, { cookie, body: { note: "Álgebra/Grupos.md" } })).json();
  assert.equal(r.error, null);
});
