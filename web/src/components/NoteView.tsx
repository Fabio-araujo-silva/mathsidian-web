// Uma nota aberta: título, barra (Ler / Escrever / Lado a lado, estado do salvamento) e conteúdo.
// Salva sozinho (0,8 s depois de parar de digitar, no máximo a cada 5 s digitando) com controle de
// versão: se outra aba/aparelho salvou antes, mostra o conflito em vez de sobrescrever.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { splitFrontmatter } from "../lib/markdown";
import { displayProps } from "../lib/props";
import { bumpPreambleEpoch } from "../lib/mathService";
import Reader from "./Reader";
import type { EditorHandle } from "./Editor";
import { useUi } from "./ui";

const Editor = lazy(() => import("./Editor"));

export type Mode = "read" | "write" | "split";
export type NoteApi = {
  save: () => Promise<void>;
  version: () => string;
  replaceText: (text: string, version: string) => void;
};

type Props = {
  vaultId: string;
  path: string;
  mode: Mode;
  setMode: (m: Mode) => void;
  epoch: number;
  resolveLink: (target: string) => string | null;
  onOpenLink: (target: string) => void;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (path: string) => void;
  onFrontmatter: (raw: string | null) => void;
  registerApi: (api: NoteApi | null) => void;
  onTreeChanged: () => void;
  onPreambleChanged: () => void;
};

const TEXT_EXT = /\.(md|tex|txt|bib|sty|cls|json|csv|ya?ml)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

// Salvamentos em andamento de notas já fechadas: reabrir espera eles terminarem.
const inflight = new Map<string, Promise<unknown>>();

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export default function NoteView(props: Props) {
  const { vaultId, path, mode, setMode, epoch, resolveLink, onOpenLink, onRename, onDelete, onFrontmatter, registerApi, onTreeChanged, onPreambleChanged } = props;
  const ui = useUi();
  const isMd = /\.md$/i.test(path);
  const isText = TEXT_EXT.test(path);
  const name = path.split("/").pop()!;
  const folder = path.split("/").slice(0, -1);

  const [loaded, setLoaded] = useState<{ text: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [body, setBody] = useState("");
  const [frontmatter, setFrontmatter] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState<{ version: string; text: string | null } | null>(null);
  const [props_, setProps] = useState<[string, string][]>([]);

  const editor = useRef<EditorHandle | null>(null);
  const version = useRef("");
  const savedText = useRef("");
  const knownText = useRef(""); // texto atual quando o editor não está aberto
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  const timers = useRef<{ save?: number; maxWait?: number; preview?: number; retry?: number }>({});
  const alive = useRef(true);

  const getText = useCallback(() => (editor.current ? editor.current.getText() : knownText.current), []);

  // Quando o editor sai da tela (trocar pra "Ler"), guarda o texto dele antes de ele ser destruído:
  // o React solta a referência antes de rodar a limpeza que destrói o CodeMirror.
  const editorRef = useCallback((h: EditorHandle | null) => {
    if (h) editor.current = h;
    else {
      if (editor.current) knownText.current = editor.current.getText();
      editor.current = null;
    }
  }, []);

  // ---------- carregar ----------
  useEffect(() => {
    alive.current = true;
    if (!isText) return;
    (async () => {
      try {
        await inflight.get(vaultId + "\0" + path);
        const r = await api.readFile(vaultId, path);
        if (!alive.current) return;
        version.current = r.version;
        savedText.current = knownText.current = r.text;
        const fm = isMd ? splitFrontmatter(r.text) : { raw: null, body: r.text };
        setBody(fm.body);
        setFrontmatter(fm.raw);
        setLoaded({ text: r.text });
      } catch (e: any) {
        if (alive.current) setLoadError(e.message || "não deu pra abrir");
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [vaultId, path, isText, isMd]);

  useEffect(() => onFrontmatter(isMd ? frontmatter : null), [frontmatter, isMd, onFrontmatter]);

  // propriedades (cabeçalho YAML) como etiquetas
  useEffect(() => setProps(frontmatter ? displayProps(frontmatter) : []), [frontmatter]);

  // ---------- salvar ----------
  const save = useCallback(
    async (force = false): Promise<void> => {
      if (saving.current) {
        queued.current = true;
        return saving.current;
      }
      const t = timers.current;
      clearTimeout(t.save);
      clearTimeout(t.maxWait);
      t.save = t.maxWait = undefined;
      const text = getText();
      if (text === savedText.current) {
        dirty.current = false;
        setState("saved");
        return;
      }
      setState("saving");
      const job = api
        .writeFile(vaultId, path, text, force ? undefined : version.current)
        .then((res) => {
          version.current = res.version;
          savedText.current = text;
          if (getText() === text) {
            dirty.current = false;
            setState("saved");
          } else setState("dirty");
        })
        .catch((e: ApiError) => {
          if (e.status === 409 && e.payload?.current) {
            setConflict(e.payload.current);
            setState("conflict");
          } else {
            setState("error");
            clearTimeout(t.retry);
            t.retry = window.setTimeout(() => dirty.current && save(), 5000);
          }
        })
        .finally(() => {
          saving.current = null;
          if (queued.current) {
            queued.current = false;
            if (dirty.current) save();
          }
        });
      saving.current = job;
      return job;
    },
    [vaultId, path, getText]
  );

  const scheduleSave = useCallback(() => {
    const t = timers.current;
    clearTimeout(t.save);
    t.save = window.setTimeout(() => save(), 800);
    if (t.maxWait == null) t.maxWait = window.setTimeout(() => save(), 5000);
  }, [save]);

  // digitou: marca, agenda o salvamento e (lado a lado) a prévia
  const refreshFromEditor = useCallback(() => {
    const text = getText();
    const fm = isMd ? splitFrontmatter(text) : { raw: null, body: text };
    setBody(fm.body);
    setFrontmatter(fm.raw);
  }, [getText, isMd]);

  const onChange = useCallback(() => {
    dirty.current = true;
    setState((s) => (s === "conflict" ? s : "dirty"));
    scheduleSave();
    const t = timers.current;
    clearTimeout(t.preview);
    t.preview = window.setTimeout(refreshFromEditor, mode === "split" ? 150 : 600);
  }, [scheduleSave, refreshFromEditor, mode]);

  // sair da nota (ou fechar a aba) com algo por salvar: manda em segundo plano (keepalive)
  useEffect(() => {
    const flush = () => {
      if (!dirty.current || saving.current) return;
      const text = getText();
      if (text === savedText.current) return;
      const p = api.writeFile(vaultId, path, text, version.current, true).catch(() => {});
      const k = vaultId + "\0" + path;
      inflight.set(k, p);
      p.finally(() => inflight.get(k) === p && inflight.delete(k));
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
      Object.values(timers.current).forEach((id) => clearTimeout(id));
    };
  }, [vaultId, path, getText]);

  // API pra Workspace / painel de preâmbulos
  useEffect(() => {
    registerApi({
      save: () => save(),
      version: () => version.current,
      replaceText: (text, v) => {
        version.current = v;
        savedText.current = knownText.current = text;
        dirty.current = false;
        editor.current?.setText(text);
        const fm = splitFrontmatter(text);
        setBody(fm.body);
        setFrontmatter(fm.raw);
        setState("saved");
      },
    });
    return () => registerApi(null);
  }, [registerApi, save]);

  // trocar de modo: o texto do editor passa pro leitor
  useEffect(() => {
    if (editor.current) knownText.current = editor.current.getText();
    if (loaded) refreshFromEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ---------- conflito ----------
  async function keepMine() {
    setConflict(null);
    await save(true);
  }
  function useTheirs() {
    if (!conflict || conflict.text == null) return;
    version.current = conflict.version;
    savedText.current = knownText.current = conflict.text;
    dirty.current = false;
    editor.current?.setText(conflict.text);
    const fm = splitFrontmatter(conflict.text);
    setBody(fm.body);
    setFrontmatter(fm.raw);
    setConflict(null);
    setState("saved");
  }

  // ---------- título = nome do arquivo ----------
  const baseName = isMd ? name.replace(/\.md$/i, "") : name;
  const [title, setTitle] = useState(baseName);
  useEffect(() => setTitle(baseName), [baseName]);
  async function commitTitle() {
    const clean = title.trim().replace(/[\\/:*?"<>|]/g, "-");
    if (!clean || clean === baseName) return setTitle(baseName);
    const to = [...folder, isMd ? clean + ".md" : clean].join("/");
    try {
      await save();
      await onRename(path, to);
    } catch (e: any) {
      ui.toast(e.message, true);
      setTitle(baseName);
    }
  }

  // ---------- colar documento LaTeX / anexos ----------
  const onPasteText = useCallback(
    async (latex: string) => {
      const { convert, mergeIntoPreamble } = await import("../lib/latex-import.js");
      const res = convert(latex);
      if (res.defs.length || res.libs.length) {
        let current = "";
        let base: string | undefined;
        try {
          const r = await api.readFile(vaultId, "preamble.tex");
          current = r.text;
          base = r.version;
        } catch {}
        const merged = mergeIntoPreamble(current, res.defs, res.libs);
        if (merged.added) {
          try {
            await api.writeFile(vaultId, "preamble.tex", merged.text, base);
            bumpPreambleEpoch();
            onPreambleChanged();
            onTreeChanged();
            ui.toast(`LaTeX importado: ${merged.added} definição(ões) no preamble.tex`);
          } catch (e: any) {
            ui.toast("LaTeX importado, mas o preamble.tex não foi atualizado: " + e.message, true);
          }
          return res.markdown;
        }
      }
      ui.toast("LaTeX importado");
      return res.markdown;
    },
    [vaultId, ui, onPreambleChanged, onTreeChanged]
  );

  const onPasteFiles = useCallback(
    async (files: File[]) => {
      const out: string[] = [];
      for (const f of files) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const safe = (f.name || "imagem.png").replace(/[^\p{L}\p{N}._-]+/gu, "-");
        const target = `anexos/${stamp}-${safe}`;
        try {
          await api.uploadFile(vaultId, target, f);
          const link = target.split("/").map(encodeURIComponent).join("/");
          out.push(f.type.startsWith("image/") ? `![${safe}](${link})` : `[${safe}](${link})`);
        } catch (e: any) {
          ui.toast(`Não deu pra enviar ${f.name}: ${e.message}`, true);
        }
      }
      if (out.length) onTreeChanged();
      return out.length ? out.join("\n") + "\n" : null;
    },
    [vaultId, ui, onTreeChanged]
  );

  const ctx = useMemo(() => ({ vaultId, note: path, frontmatter }), [vaultId, path, frontmatter]);

  // ---------- render ----------
  const stateLabel: Record<SaveState, string> = {
    saved: "Salvo",
    dirty: "Alterações não salvas",
    saving: "Salvando…",
    error: "Sem conexão: tentando de novo",
    conflict: "Conflito de versão",
  };

  const header = (
    <>
      <div className="crumbs">
        {folder.length ? folder.map((f, i) => <span key={i}>{f}</span>) : <span>raiz do cofre</span>}
      </div>
      <input
        className="note-title"
        value={title}
        aria-label="Título da nota"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") setTitle(baseName);
        }}
      />
      <div className="note-bar">
        {isMd && (
          <div className="segmented" role="group" aria-label="Modo">
            {(
              [
                ["read", "Ler"],
                ["write", "Escrever"],
                ["split", "Lado a lado"],
              ] as [Mode, string][]
            ).map(([m, label]) => (
              <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {isText && <span className={"save-state" + (state === "saved" ? "" : state === "error" || state === "conflict" ? " error" : " dirty")}>{stateLabel[state]}</span>}
        <span className="spacer" />
        <a className="btn btn-ghost btn-sm" href={api.fileUrl(vaultId, path)} download={name}>
          Baixar
        </a>
        <button className="btn btn-ghost btn-sm btn-danger" onClick={() => onDelete(path)}>
          Excluir
        </button>
      </div>
      {conflict && (
        <div className="banner" role="alert">
          <span style={{ flex: 1 }}>Esta nota foi alterada em outro lugar enquanto você editava.</span>
          <button className="btn btn-sm" onClick={keepMine}>
            Manter a minha versão
          </button>
          {conflict.text != null && (
            <button className="btn btn-sm" onClick={useTheirs}>
              Usar a outra
            </button>
          )}
        </div>
      )}
    </>
  );

  if (!isText) {
    const url = api.fileUrl(vaultId, path);
    return (
      <div className="note">
        {header}
        {IMAGE_EXT.test(path) ? (
          <img src={url} alt={name} style={{ maxWidth: "100%", borderRadius: 10 }} />
        ) : /\.pdf$/i.test(path) ? (
          <iframe title={name} src={url} style={{ width: "100%", height: "80vh", border: 0, borderRadius: 10 }} />
        ) : (
          <p className="muted">Este tipo de arquivo não tem visualização. Use “Baixar”.</p>
        )}
      </div>
    );
  }

  if (loadError)
    return (
      <div className="note">
        {header}
        <p className="error-text">{loadError}</p>
      </div>
    );
  if (!loaded) return <div className="note">{header}</div>;

  const showReader = isMd && mode !== "write";
  const showEditor = !isMd || mode !== "read";
  const reader = showReader && (
    <div>
      {props_.length > 0 && (
        <div className="props">
          {props_.map(([k, v]) => (
            <span className="prop" key={k}>
              <b>{k}</b>
              <span title={v}>{v}</span>
            </span>
          ))}
        </div>
      )}
      <Reader body={body} ctx={ctx} epoch={epoch} debounceMs={mode === "split" ? 120 : 0} resolveLink={resolveLink} onOpenLink={onOpenLink} />
    </div>
  );
  const editorEl = showEditor && (
    <Suspense fallback={<div className="editor-host muted">Abrindo o editor…</div>}>
      <Editor
        ref={editorRef}
        initial={knownText.current}
        onChange={onChange}
        onSave={() => save()}
        onPasteText={isMd ? onPasteText : undefined}
        onPasteFiles={isMd ? onPasteFiles : undefined}
        plain={!isMd}
      />
    </Suspense>
  );

  return (
    <div className={"note" + (mode === "split" && isMd ? " split" : "")}>
      {header}
      {mode === "split" && isMd ? (
        <div className="split-grid">
          {editorEl}
          {reader}
        </div>
      ) : (
        <>
          {editorEl}
          {reader}
        </>
      )}
    </div>
  );
}
