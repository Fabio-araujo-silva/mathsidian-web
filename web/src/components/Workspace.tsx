// Casca do app: barra superior (cofre, busca, ações, conta), lista de notas, nota aberta e painel de
// preâmbulos. O endereço reflete o que está aberto: /v/<cofre>/<caminho da nota>.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Entry, type User, type Vault } from "../api";
import { fold } from "../lib/fuzzy";
import { bumpPreambleEpoch } from "../lib/mathService";
import Sidebar from "./Sidebar";
import NoteView, { type Mode, type NoteApi } from "./NoteView";
import CommandPalette, { type Command } from "./CommandPalette";
import PreambleDock from "./PreambleDock";
import { Modal, MenuItem, Popover, useHotkey, useUi } from "./ui";


type Theme = "system" | "light" | "dark";

function parseUrl(): { vault: string | null; path: string | null } {
  const m = /^\/v\/([a-z0-9]+)(?:\/(.*))?$/.exec(location.pathname);
  if (!m) return { vault: null, path: null };
  let path: string | null = null;
  if (m[2]) {
    try {
      path = m[2].split("/").map(decodeURIComponent).join("/");
    } catch {}
  }
  return { vault: m[1], path };
}

function urlFor(vault: string, path: string | null) {
  return "/v/" + vault + (path ? "/" + path.split("/").map(encodeURIComponent).join("/") : "");
}

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export default function Workspace({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const ui = useUi();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [usage, setUsage] = useState({ used: 0, limit: 0 });
  const [path, setPath] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>(() => (store.get("ms-mode") as Mode) || "read");
  const [dock, setDock] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [frontmatter, setFrontmatter] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ kind: "vault" | "account"; anchor: HTMLElement } | null>(null);
  const [dialog, setDialog] = useState<"snapshots" | "password" | null>(null);
  const [theme, setThemeState] = useState<Theme>(() => (store.get("ms-theme") as Theme) || "system");
  const noteApi = useRef<NoteApi | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const vault = vaults.find((v) => v.id === vaultId) || null;

  // ---------- tema ----------
  const setTheme = (t: Theme) => {
    setThemeState(t);
    store.set("ms-theme", t);
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  };

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    store.set("ms-mode", m);
  }, []);

  // ---------- carregar cofres e rotas ----------
  const loadTree = useCallback(async (id: string) => {
    const t = await api.tree(id);
    setEntries(t.entries);
    setUsage({ used: t.used, limit: t.limit });
  }, []);

  useEffect(() => {
    api
      .vaults()
      .then(({ vaults }) => {
        setVaults(vaults);
        const fromUrl = parseUrl();
        const last = store.get("ms-vault");
        const pick = vaults.find((v) => v.id === fromUrl.vault) || vaults.find((v) => v.id === last) || vaults[0];
        if (!pick) return;
        setVaultId(pick.id);
        const p = fromUrl.vault === pick.id ? fromUrl.path : store.get("ms-last-" + pick.id) || "Bem-vindo.md";
        setPath(p);
        history.replaceState(null, "", urlFor(pick.id, p));
      })
      .catch((e) => ui.toast(e.message, true));
    const onPop = () => {
      const r = parseUrl();
      if (r.vault) setVaultId(r.vault);
      setPath(r.path);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [ui]);

  useEffect(() => {
    if (!vaultId) return;
    store.set("ms-vault", vaultId);
    loadTree(vaultId).catch((e) => ui.toast(e.message, true));
  }, [vaultId, loadTree, ui]);

  // nota aberta que não existe mais (ex.: "Bem-vindo.md" apagada) -> nenhuma
  useEffect(() => {
    if (path && entries.length && !entries.some((e) => e.path === path)) setPath(null);
  }, [entries, path]);

  const navigate = useCallback(
    (p: string | null, vid = vaultId) => {
      if (!vid) return;
      setPath(p);
      setSidebarOpen(false);
      if (p) {
        store.set("ms-last-" + vid, p);
        const key = "ms-recent-" + vid;
        let recent: string[] = [];
        try {
          recent = JSON.parse(store.get(key) || "[]");
        } catch {}
        store.set(key, JSON.stringify([p, ...recent.filter((r) => r !== p)].slice(0, 12)));
      }
      const url = urlFor(vid, p);
      if (location.pathname !== url) history.pushState(null, "", url);
    },
    [vaultId]
  );

  const switchVault = useCallback(
    (id: string) => {
      setVaultId(id);
      setEntries([]);
      const p = store.get("ms-last-" + id);
      navigate(p, id);
    },
    [navigate]
  );

  // pré-carrega o editor quando o navegador estiver ocioso (abrir "Escrever" fica instantâneo)
  useEffect(() => {
    const idle = (window as any).requestIdleCallback || ((f: () => void) => setTimeout(f, 1500));
    idle(() => import("./Editor"));
  }, []);

  // ---------- links entre notas ----------
  const linkIndex = useMemo(() => {
    const exact = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const e of entries) {
      if (e.kind !== "file") continue;
      exact.set(fold(e.path), e.path);
      const base = fold(e.path.split("/").pop()!.replace(/\.md$/i, ""));
      if (!byName.has(base) || e.path.endsWith(".md")) byName.set(base, e.path);
    }
    return { exact, byName };
  }, [entries]);

  const resolveLink = useCallback(
    (target: string) => {
      const t = fold(target.trim());
      return linkIndex.exact.get(t) || linkIndex.exact.get(t + ".md") || linkIndex.byName.get(t.split("/").pop()!) || null;
    },
    [linkIndex]
  );

  // ---------- ações de arquivos ----------
  const newNote = useCallback(
    async (folder: string) => {
      if (!vaultId) return;
      const name = await ui.prompt({ title: "Nova nota", label: "Nome", placeholder: "Ex.: Teorema de Stokes", confirm: "Criar" });
      if (!name) return;
      const p = (folder ? folder + "/" : "") + name.replace(/[\\/:*?"<>|]/g, "-") + (name.toLowerCase().endsWith(".md") ? "" : ".md");
      try {
        if (entries.some((e) => fold(e.path) === fold(p))) throw new Error("já existe uma nota com esse nome");
        await api.writeFile(vaultId, p, "");
        await loadTree(vaultId);
        setMode(mode === "read" ? "write" : mode);
        navigate(p);
      } catch (e: any) {
        ui.toast(e.message, true);
      }
    },
    [vaultId, ui, entries, loadTree, navigate, mode, setMode]
  );

  const openLink = useCallback(
    async (target: string) => {
      const found = resolveLink(target);
      if (found) return navigate(found);
      const ok = await ui.confirm({ title: `Criar “${target}”?`, description: "Essa nota ainda não existe.", confirm: "Criar nota" });
      if (!ok || !vaultId) return;
      const p = target.replace(/\.md$/i, "") + ".md";
      try {
        await api.writeFile(vaultId, p, "");
        await loadTree(vaultId);
        navigate(p);
      } catch (e: any) {
        ui.toast(e.message, true);
      }
    },
    [resolveLink, navigate, ui, vaultId, loadTree]
  );

  const newFolder = useCallback(
    async (folder: string) => {
      if (!vaultId) return;
      const name = await ui.prompt({ title: "Nova pasta", label: "Nome", confirm: "Criar" });
      if (!name) return;
      try {
        await api.mkdir(vaultId, (folder ? folder + "/" : "") + name.replace(/[\\/:*?"<>|]/g, "-"));
        await loadTree(vaultId);
      } catch (e: any) {
        ui.toast(e.message, true);
      }
    },
    [vaultId, ui, loadTree]
  );

  const rename = useCallback(
    async (from: string, to: string) => {
      if (!vaultId) return;
      const res = await api.move(vaultId, from, to);
      await loadTree(vaultId);
      if (path === from) navigate(res.path);
      else if (path && path.startsWith(from + "/")) navigate(res.path + path.slice(from.length));
      if (/(^|\/)preamble\.tex$/.test(from) || /(^|\/)preamble\.tex$/.test(to) || from.endsWith(".tex")) {
        bumpPreambleEpoch();
        setEpoch((e) => e + 1);
      }
    },
    [vaultId, loadTree, path, navigate]
  );

  const renameAsk = useCallback(
    async (p: string) => {
      const to = await ui.prompt({
        title: "Renomear ou mover",
        description: "Para mover, escreva o caminho com as pastas (ex.: Álgebra/Grupos.md).",
        label: "Caminho",
        value: p,
        confirm: "Salvar",
      });
      if (!to || to === p) return;
      try {
        await rename(p, to);
      } catch (e: any) {
        ui.toast(e.message, true);
      }
    },
    [ui, rename]
  );

  const remove = useCallback(
    async (p: string) => {
      if (!vaultId) return;
      const isFolder = entries.some((e) => e.path === p && e.kind === "folder");
      const ok = await ui.confirm({
        title: isFolder ? `Excluir a pasta “${p}”?` : `Excluir “${p.split("/").pop()}”?`,
        description: isFolder ? "Tudo dentro dela será apagado. Os backups automáticos ainda guardam as versões anteriores." : "Os backups automáticos ainda guardam as versões anteriores.",
        confirm: "Excluir",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.remove(vaultId, p);
        if (path === p || (path && path.startsWith(p + "/"))) navigate(null);
        await loadTree(vaultId);
        if (p.endsWith(".tex") || isFolder) {
          bumpPreambleEpoch();
          setEpoch((e) => e + 1);
        }
      } catch (e: any) {
        ui.toast(e.message, true);
      }
    },
    [vaultId, entries, ui, path, navigate, loadTree]
  );

  // ---------- cofres ----------
  const createVault = useCallback(async () => {
    const name = await ui.prompt({ title: "Novo cofre", label: "Nome do cofre", placeholder: "Ex.: Topologia", confirm: "Criar" });
    if (!name) return;
    try {
      const { vault } = await api.createVault(name);
      setVaults((v) => [...v, vault]);
      switchVault(vault.id);
    } catch (e: any) {
      ui.toast(e.message, true);
    }
  }, [ui, switchVault]);

  const renameVault = useCallback(async () => {
    if (!vault) return;
    const name = await ui.prompt({ title: "Renomear cofre", label: "Nome", value: vault.name, confirm: "Salvar" });
    if (!name) return;
    try {
      const r = await api.renameVault(vault.id, name);
      setVaults((vs) => vs.map((v) => (v.id === vault.id ? r.vault : v)));
    } catch (e: any) {
      ui.toast(e.message, true);
    }
  }, [vault, ui]);

  const deleteVault = useCallback(async () => {
    if (!vault) return;
    const ok = await ui.confirm({
      title: `Excluir o cofre “${vault.name}”?`,
      description: "Todas as notas dele somem da sua conta. Baixe um backup antes, se quiser guardar.",
      confirm: "Excluir cofre",
      danger: true,
      typeToConfirm: vault.name,
    });
    if (!ok) return;
    try {
      await api.deleteVault(vault.id);
      const rest = vaults.filter((v) => v.id !== vault.id);
      setVaults(rest);
      if (rest[0]) switchVault(rest[0].id);
      else {
        setVaultId(null);
        setEntries([]);
        setPath(null);
        history.replaceState(null, "", "/");
      }
    } catch (e: any) {
      ui.toast(e.message, true);
    }
  }, [vault, vaults, ui, switchVault]);

  const importVault = useCallback(
    async (file: File) => {
      try {
        const r = await api.importVault(file, file.name.replace(/\.zip$/i, ""));
        setVaults((v) => [...v, r.vault]);
        switchVault(r.vault.id);
        ui.toast(`Cofre importado: ${r.files} arquivos`);
      } catch (e: any) {
        ui.toast("Não deu pra importar: " + e.message, true);
      }
    },
    [ui, switchVault]
  );

  const signOut = useCallback(async () => {
    await noteApi.current?.save().catch(() => {});
    await api.logout().catch(() => {});
    onSignedOut();
    history.replaceState(null, "", "/");
  }, [onSignedOut]);

  // ---------- atalhos ----------
  useHotkey("k", () => setPalette((p) => !p));
  useHotkey("e", () => setMode(mode === "read" ? "write" : "read"), [mode]);
  useHotkey("s", () => noteApi.current?.save());

  const preambleChanged = useCallback(() => setEpoch((e) => e + 1), []);
  const registerApi = useCallback((a: NoteApi | null) => (noteApi.current = a), []);

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: "new-note", label: "Nova nota", run: () => newNote(path ? path.split("/").slice(0, -1).join("/") : "") },
      { id: "new-folder", label: "Nova pasta", run: () => newFolder("") },
      { id: "mode-read", label: "Modo: ler", hint: "Ctrl+E alterna", run: () => setMode("read") },
      { id: "mode-write", label: "Modo: escrever", hint: "Ctrl+E alterna", run: () => setMode("write") },
      { id: "mode-split", label: "Modo: lado a lado", run: () => setMode("split") },
      { id: "preambles", label: dock ? "Fechar preâmbulos" : "Editar preâmbulos", run: () => setDock(!dock) },
      { id: "backup", label: "Baixar backup do cofre (.zip)", run: () => vaultId && (location.href = api.backupUrl(vaultId)) },
      { id: "snapshots", label: "Backups automáticos do cofre", run: () => setDialog("snapshots") },
      { id: "import", label: "Importar cofre (.zip)", run: () => importInput.current?.click() },
      { id: "new-vault", label: "Novo cofre", run: createVault },
      { id: "rename-vault", label: "Renomear cofre", run: renameVault },
      { id: "theme-light", label: "Tema claro", run: () => setTheme("light") },
      { id: "theme-dark", label: "Tema escuro", run: () => setTheme("dark") },
      { id: "theme-system", label: "Tema do sistema", run: () => setTheme("system") },
      { id: "password", label: "Trocar senha", run: () => setDialog("password") },
      { id: "logout", label: "Sair da conta", run: signOut },
    ];
    for (const v of vaults) if (v.id !== vaultId) list.push({ id: "vault-" + v.id, label: "Abrir cofre: " + v.name, run: () => switchVault(v.id) });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, dock, vaultId, vaults, newNote, newFolder, createVault, renameVault, signOut, switchVault, setMode]);

  const files = useMemo(() => entries.filter((e) => e.kind === "file").map((e) => e.path), [entries]);
  const recent = useMemo(() => {
    try {
      return JSON.parse(store.get("ms-recent-" + vaultId) || "[]") as string[];
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, palette]);

  const initials = (user.name || user.email).trim().slice(0, 1).toUpperCase();
  const mdOpen = path && /\.md$/i.test(path) ? path : null;

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn menu-toggle" aria-label="Notas" onClick={() => setSidebarOpen((o) => !o)}>
          ☰
        </button>
        <div className="brand hide-narrow">
          <span className="brand-mark">∑</span>
        </div>
        <button className="vault-switch" onClick={(e) => setMenu({ kind: "vault", anchor: e.currentTarget })} aria-haspopup="menu">
          <span>{vault ? vault.name : "Sem cofre"}</span> ▾
        </button>
        <button className="search-pill" onClick={() => setPalette(true)} aria-label="Buscar notas e comandos">
          ⌕ <span>Buscar notas e comandos…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className={"btn btn-ghost hide-narrow" + (dock ? " toggle-on" : "")} onClick={() => setDock(!dock)} title="Preâmbulos (definições de LaTeX)">
          Σ Preâmbulos
        </button>
        <button className="avatar" onClick={(e) => setMenu({ kind: "account", anchor: e.currentTarget })} aria-label="Conta" aria-haspopup="menu">
          {initials}
        </button>
      </header>

      <div className="body">
        {vaultId && (
          <Sidebar
            vaultId={vaultId}
            entries={entries}
            activePath={path}
            used={usage.used}
            limit={usage.limit}
            open={sidebarOpen}
            onOpen={navigate}
            onNewNote={newNote}
            onNewFolder={newFolder}
            onRename={renameAsk}
            onDelete={remove}
            onBackup={() => setDialog("snapshots")}
          />
        )}
        <main className="main">
          {vaultId && path ? (
            <NoteView
              key={vaultId + "\0" + path}
              vaultId={vaultId}
              path={path}
              mode={mode}
              setMode={setMode}
              epoch={epoch}
              resolveLink={resolveLink}
              onOpenLink={openLink}
              onRename={rename}
              onDelete={remove}
              onFrontmatter={setFrontmatter}
              registerApi={registerApi}
              onTreeChanged={() => vaultId && loadTree(vaultId)}
              onPreambleChanged={preambleChanged}
            />
          ) : (
            <div className="empty">
              <div>
                <h2>{vault ? vault.name : "Nenhum cofre"}</h2>
                <p>{vault ? "Escolha uma nota na lista ou comece uma nova." : "Crie um cofre para começar."}</p>
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  {vault ? (
                    <button className="btn btn-primary" onClick={() => newNote("")}>
                      + Nova nota
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={createVault}>
                      + Novo cofre
                    </button>
                  )}
                  <button className="btn" onClick={() => setPalette(true)}>
                    Buscar <kbd>Ctrl K</kbd>
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
        {dock && vaultId && (
          <PreambleDock
            vaultId={vaultId}
            note={mdOpen}
            frontmatter={mdOpen ? frontmatter : null}
            epoch={epoch}
            noteApi={() => noteApi.current}
            onSaved={preambleChanged}
            onClose={() => setDock(false)}
          />
        )}
      </div>

      {menu?.kind === "vault" && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          <div className="menu-label">Seus cofres</div>
          {vaults.map((v) => (
            <MenuItem key={v.id} checked={v.id === vaultId} onClick={() => (setMenu(null), switchVault(v.id))}>
              {v.name}
            </MenuItem>
          ))}
          <MenuItem onClick={() => (setMenu(null), createVault())}>+ Novo cofre…</MenuItem>
          <div className="menu-sep" />
          <MenuItem onClick={() => (setMenu(null), vaultId && (location.href = api.backupUrl(vaultId)))}>Baixar backup (.zip)</MenuItem>
          <MenuItem onClick={() => (setMenu(null), setDialog("snapshots"))}>Backups automáticos…</MenuItem>
          <MenuItem onClick={() => (setMenu(null), importInput.current?.click())}>Importar cofre (.zip)…</MenuItem>
          <div className="menu-sep" />
          <MenuItem onClick={() => (setMenu(null), renameVault())}>Renomear cofre…</MenuItem>
          <MenuItem danger onClick={() => (setMenu(null), deleteVault())}>
            Excluir cofre…
          </MenuItem>
        </Popover>
      )}
      {menu?.kind === "account" && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} align="right">
          <div className="menu-label">{user.name}</div>
          <div style={{ padding: "0 10px 8px", fontSize: 13 }} className="muted">
            {user.email}
          </div>
          <div className="menu-sep" />
          <div className="menu-label">Tema</div>
          {(
            [
              ["system", "Do sistema"],
              ["light", "Claro"],
              ["dark", "Escuro"],
            ] as [Theme, string][]
          ).map(([t, label]) => (
            <MenuItem key={t} checked={theme === t} onClick={() => setTheme(t)}>
              {label}
            </MenuItem>
          ))}
          <div className="menu-sep" />
          <MenuItem onClick={() => (setMenu(null), setDialog("password"))}>Trocar senha…</MenuItem>
          <MenuItem onClick={() => (setMenu(null), signOut())}>Sair</MenuItem>
        </Popover>
      )}

      {palette && <CommandPalette notes={files} recent={recent} commands={commands} onOpen={navigate} onClose={() => setPalette(false)} />}
      {dialog === "snapshots" && vault && <SnapshotsDialog vault={vault} onClose={() => setDialog(null)} />}
      {dialog === "password" && <PasswordDialog onClose={() => setDialog(null)} />}

      <input
        ref={importInput}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) importVault(f);
        }}
      />
    </div>
  );
}

function SnapshotsDialog({ vault, onClose }: { vault: Vault; onClose: () => void }) {
  const ui = useUi();
  const [data, setData] = useState<{ snapshots: { name: string; size: number }[]; everyHours: number; keep: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.snapshots(vault.id).then(setData), [vault.id]);
  useEffect(() => {
    load().catch((e) => ui.toast(e.message, true));
  }, [load, ui]);
  const fmt = (name: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(name);
    return m ? `${m[3]}/${m[2]}/${m[1]} às ${m[4]}:${m[5]} (UTC)` : name;
  };
  return (
    <Modal onClose={onClose} label="Backups">
      <div className="dialog" style={{ width: "min(560px, 100%)" }}>
        <h3>Backups de “{vault.name}”</h3>
        <p>
          O servidor guarda uma cópia do cofre a cada {data?.everyHours ?? 24} h quando algo muda, e mantém as últimas {data?.keep ?? 14}. Você também pode baixar
          tudo agora num .zip.
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <a className="btn btn-primary" href={api.backupUrl(vault.id)}>
            Baixar agora (.zip)
          </a>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.takeSnapshot(vault.id);
                await load();
                ui.toast("Cópia guardada no servidor");
              } catch (e: any) {
                ui.toast(e.message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Guardar uma cópia no servidor
          </button>
        </div>
        <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
          {data && !data.snapshots.length && <p className="muted" style={{ padding: 14, margin: 0 }}>Nenhuma cópia ainda.</p>}
          {data?.snapshots.map((s) => (
            <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
              <span style={{ flex: 1 }}>{fmt(s.name)}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {(s.size / 1024).toFixed(0)} KB
              </span>
              <a className="btn btn-sm" href={api.snapshotUrl(vault.id, s.name)}>
                Baixar
              </a>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal onClose={onClose} label="Trocar senha">
      <form
        className="dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await api.changePassword(current, next);
            ui.toast("Senha trocada. Outras sessões foram encerradas.");
            onClose();
          } catch (err: any) {
            setError(err.message);
          }
        }}
      >
        <h3>Trocar senha</h3>
        <div className="field">
          <label htmlFor="pw-current">Senha atual</label>
          <input id="pw-current" className="input" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pw-next">Senha nova (8 ou mais caracteres)</label>
          <input id="pw-next" className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!current || next.length < 8}>
            Trocar
          </button>
        </div>
      </form>
    </Modal>
  );
}
