// Contas e sessões. Senha com scrypt (node:crypto); a sessão é um token aleatório num cookie
// httpOnly, guardado no banco só como hash.
import crypto from "node:crypto";
import { HttpError } from "./storage.js";

const COOKIE = "ms_session";
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function newId() {
  return crypto.randomBytes(12).toString("hex");
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(expected, got);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Limite simples de tentativas de login por IP+e-mail (em memória).
function createLimiter(max, windowMs) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || now - h.start > windowMs) {
        hits.set(key, { start: now, n: 1 });
        return true;
      }
      h.n++;
      return h.n <= max;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export function registerAuth(app, { db, config, onUserCreated }) {
  const loginLimiter = createLimiter(10, 15 * 60 * 1000);
  const signupLimiter = createLimiter(config.signupsPerHour, 60 * 60 * 1000);
  const q = {
    userByEmail: db.prepare("select * from users where email = ?"),
    userById: db.prepare("select id, email, name, created_at from users where id = ?"),
    insertUser: db.prepare("insert into users (id, email, name, pass_hash, created_at) values (?, ?, ?, ?, ?)"),
    insertSession: db.prepare("insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)"),
    session: db.prepare("select user_id, expires_at from sessions where token_hash = ?"),
    deleteSession: db.prepare("delete from sessions where token_hash = ?"),
    deleteExpired: db.prepare("delete from sessions where expires_at < ?"),
    updatePass: db.prepare("update users set pass_hash = ? where id = ?"),
    deleteOtherSessions: db.prepare("delete from sessions where user_id = ? and token_hash != ?"),
  };

  function startSession(reply, userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const expires = now + config.sessionDays * 86400000;
    q.insertSession.run(sha256(token), userId, now, expires);
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.production,
      expires: new Date(expires),
    });
  }

  // Preenche req.user em toda requisição com cookie válido.
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[COOKIE];
    if (!token) return;
    const s = q.session.get(sha256(token));
    if (!s || s.expires_at < Date.now()) return;
    req.user = q.userById.get(s.user_id) || null;
    req.sessionHash = sha256(token);
  });
  setInterval(() => q.deleteExpired.run(Date.now()), 3600000).unref();

  const normEmail = (e) => String(e || "").trim().toLowerCase();

  app.get("/api/config", async () => ({
    registration: config.registration,
  }));

  app.post("/api/auth/register", async (req, reply) => {
    const { email, name, password, invite } = req.body || {};
    if (config.registration === "closed") throw new HttpError(403, "cadastro fechado");
    if (config.registration === "invite" && !config.inviteCodes.includes(String(invite || "").trim()))
      throw new HttpError(403, "código de convite inválido");
    if (!signupLimiter.check(req.ip)) throw new HttpError(429, "muitas contas criadas daqui; tente mais tarde");
    const mail = normEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 200) throw new HttpError(400, "e-mail inválido");
    const nick = String(name || "").trim().slice(0, 80) || mail.split("@")[0];
    if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "a senha precisa ter pelo menos 8 caracteres");
    if (q.userByEmail.get(mail)) throw new HttpError(409, "já existe uma conta com esse e-mail");
    const id = newId();
    q.insertUser.run(id, mail, nick, hashPassword(password), Date.now());
    if (onUserCreated) await onUserCreated(id);
    startSession(reply, id);
    return { user: q.userById.get(id) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = req.body || {};
    const mail = normEmail(email);
    const key = req.ip + "|" + mail;
    if (!loginLimiter.check(key)) throw new HttpError(429, "muitas tentativas; espere alguns minutos");
    const user = q.userByEmail.get(mail);
    if (!user || typeof password !== "string" || !verifyPassword(password, user.pass_hash))
      throw new HttpError(401, "e-mail ou senha incorretos");
    loginLimiter.reset(key);
    startSession(reply, user.id);
    return { user: q.userById.get(user.id) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionHash) q.deleteSession.run(req.sessionHash);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ user: req.user }));

  app.post("/api/auth/password", async (req) => {
    const user = requireUser(req);
    const { current, next } = req.body || {};
    const full = q.userByEmail.get(user.email);
    if (typeof current !== "string" || !verifyPassword(current, full.pass_hash)) throw new HttpError(401, "senha atual incorreta");
    if (typeof next !== "string" || next.length < 8) throw new HttpError(400, "a senha nova precisa ter pelo menos 8 caracteres");
    q.updatePass.run(hashPassword(next), user.id);
    q.deleteOtherSessions.run(user.id, req.sessionHash);
    return { ok: true };
  });
}

export function requireUser(req) {
  if (!req.user) throw new HttpError(401, "entre na sua conta");
  return req.user;
}
