// Servidor do Mathsidian web: API (contas, cofres, LaTeX) + o front-end compilado (web/dist).
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createStorage, HttpError } from "./storage.js";
import { registerAuth } from "./auth.js";
import { registerVaults } from "./vaults.js";
import { createEngine } from "./latex/engine.js";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // KaTeX e os SVGs das fórmulas usam estilo inline
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export async function buildApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const app = Fastify({
    logger: overrides.logger ?? { level: config.production ? "info" : "warn" },
    trustProxy: process.env.TRUST_PROXY === "1",
    bodyLimit: 1024 * 1024,
  });

  const db = openDb(config.dataDir);
  const storage = createStorage(config.dataDir);
  const engine = createEngine({ dataDir: config.dataDir, workers: config.texWorkers, timeoutMs: config.texTimeoutMs, log: app.log });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxVaultBytes, files: 1, fields: 5 } });
  // brotli com qualidade baixa: comprime bem o JSON/SVG das fórmulas sem gastar CPU (qualidade 11 é lenta demais pra resposta dinâmica)
  await app.register(compress, {
    threshold: 1024,
    encodings: ["br", "gzip"],
    brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
    zlibOptions: { level: 5 },
  });

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: config.maxFileBytes + 1024 }, (req, body, done) =>
    done(null, body)
  );

  // Toda escrita na API exige um cabeçalho que formulários de outros sites não conseguem mandar (CSRF).
  app.addHook("onRequest", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || !req.url.startsWith("/api/")) return;
    if (req.headers["x-mathsidian"] !== "1") throw new HttpError(403, "requisição recusada");
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    if (!req.url.startsWith("/api/")) {
      reply.header("content-security-policy", CSP);
      reply.header("x-frame-options", "DENY");
    } else if (!reply.getHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    if (status >= 500) req.log.error(err);
    const body = { error: status >= 500 && !(err instanceof HttpError) ? "erro interno" : err.message };
    if (err.payload) Object.assign(body, err.payload);
    reply.code(status).send(body);
  });

  const vaults = registerVaults(app, { db, config, storage, engine });
  registerAuth(app, { db, config, onUserCreated: vaults.onUserCreated });

  app.get("/api/health", async () => ({ ok: true, tex: await engine.available() }));

  // Front-end: arquivos com hash no nome (assets/) ficam em cache pra sempre; o resto revalida.
  const hasWeb = fs.existsSync(config.webDist);
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      preCompressed: true,
      wildcard: false,
      cacheControl: false, // o padrão (max-age=0) sobrescreveria o setHeaders abaixo
      // @fastify/static 10: recebe o reply do Fastify (não o res cru do Node)
      setHeaders(reply, filePath) {
        reply.header("cache-control", /[\\/]assets[\\/]/.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === "GET" && !req.url.startsWith("/api/")) {
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "não encontrado" });
  });

  app.addHook("onClose", async () => db.close());
  return { app, config, db, storage, engine, vaults };
}

async function main() {
  const { app, config, vaults } = await buildApp();
  vaults.startSnapshots();
  await app.listen({ port: config.port, host: config.host });
  console.log(`Mathsidian web em http://localhost:${config.port} (dados em ${config.dataDir})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
