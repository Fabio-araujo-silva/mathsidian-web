import { useEffect, useState } from "react";
import { api, type User } from "../api";

export default function AuthScreen({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [registration, setRegistration] = useState<"open" | "invite" | "closed">("invite");
  const [form, setForm] = useState({ email: "", name: "", password: "", invite: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config().then((c) => setRegistration(c.registration)).catch(() => {});
    // convite pelo link: /?convite=CODIGO
    const code = new URLSearchParams(location.search).get("convite");
    if (code) {
      setForm((f) => ({ ...f, invite: code }));
      setTab("register");
    }
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r =
        tab === "login"
          ? await api.login(form.email, form.password)
          : await api.register({ email: form.email, name: form.name, password: form.password, invite: form.invite });
      onSignedIn(r.user);
    } catch (err: any) {
      setError(err.message || "não deu certo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">∑</span> Mathsidian
        </div>
        <h1>{tab === "login" ? "Entrar" : "Criar sua conta"}</h1>
        <p className="lead">Notas de matemática com LaTeX de verdade, guardadas na nuvem.</p>
        {registration !== "closed" && (
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "login"} onClick={() => setTab("login")}>
              Entrar
            </button>
            <button type="button" role="tab" aria-selected={tab === "register"} onClick={() => setTab("register")}>
              Criar conta
            </button>
          </div>
        )}
        {tab === "register" && (
          <div className="field">
            <label htmlFor="name">Seu nome</label>
            <input id="name" className="input" autoComplete="name" value={form.name} onChange={set("name")} />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">E-mail</label>
          <input id="email" className="input" type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
        </div>
        <div className="field">
          <label htmlFor="password">Senha</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={tab === "login" ? "current-password" : "new-password"}
            required
            minLength={tab === "register" ? 8 : undefined}
            value={form.password}
            onChange={set("password")}
          />
        </div>
        {tab === "register" && registration === "invite" && (
          <div className="field">
            <label htmlFor="invite">Código de convite</label>
            <input id="invite" className="input" required value={form.invite} onChange={set("invite")} />
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", height: 40 }} disabled={busy}>
          {busy ? "Aguarde…" : tab === "login" ? "Entrar" : "Criar conta"}
        </button>
      </form>
    </main>
  );
}
