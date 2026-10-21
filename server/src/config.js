// Configuração por variáveis de ambiente (veja .env.example na raiz).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const list = (s) =>
  (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.DATA_DIR || path.join(here, "..", "..", "data")),
    webDist: path.resolve(env.WEB_DIST || path.join(here, "..", "..", "web", "dist")),
    production: env.NODE_ENV === "production",
    // "open": qualquer um cria conta; "invite": precisa de um código de INVITE_CODES; "closed": ninguém
    registration: env.REGISTRATION || "invite",
    inviteCodes: list(env.INVITE_CODES),
    sessionDays: Number(env.SESSION_DAYS || 30),
    signupsPerHour: Number(env.SIGNUPS_PER_HOUR || 5), // contas novas por IP por hora
    texWorkers: Number(env.TEX_WORKERS || 3),
    texTimeoutMs: Number(env.TEX_TIMEOUT_MS || 20000),
    maxVaultBytes: Number(env.MAX_VAULT_MB || 200) * 1024 * 1024,
    maxFileBytes: Number(env.MAX_FILE_MB || 20) * 1024 * 1024,
    snapshotEveryHours: Number(env.SNAPSHOT_HOURS || 24),
    snapshotKeep: Number(env.SNAPSHOT_KEEP || 14),
  };
}
