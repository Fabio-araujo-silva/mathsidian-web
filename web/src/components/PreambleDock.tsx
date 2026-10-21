// Painel de preâmbulos (encaixado à direita). Mostra, em ordem, as camadas que formam o preâmbulo da
// nota aberta: cofre, pastas, arquivos citados e o LaTeX da própria nota. Rascunhos por camada,
// "Verificar" compila com o TeX do servidor sem salvar, "Salvar" grava e verifica.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Layer } from "../api";
import { bumpPreambleEpoch } from "../lib/mathService";
import type { NoteApi } from "./NoteView";
import { useUi } from "./ui";

type Draft = { layer: Layer; text: string; saved: string; version?: string };

type Props = {
  vaultId: string;
  note: string | null; // nota .md aberta
  frontmatter: string | null;
  epoch: number;
  noteApi: () => NoteApi | null;
  onSaved: () => void;
  onClose: () => void;
};

const idOf = (l: Layer) => (l.kind === "inline" ? "inline:" + l.path : l.path);

function describe(l: Layer): { name: string; scope: string } {
  if (l.kind === "vault") return { name: "Cofre inteiro", scope: "preamble.tex · todas as notas" };
  if (l.kind === "folder") {
    const dir = l.path.split("/").slice(0, -1);
    return { name: dir[dir.length - 1] + "/", scope: "preamble.tex · esta pasta e subpastas" };
  }
  if (l.kind === "link") return { name: l.path.split("/").pop()!, scope: (l.exists ? l.path : "ainda não existe") + " · citado na propriedade preamble" };
  return { name: "Só esta nota", scope: "LaTeX na propriedade preamble" };
}

export default function PreambleDock({ vaultId, note, frontmatter, epoch, noteApi, onSaved, onClose }: Props) {
  const ui = useUi();
  const [layers, setLayers] = useState<Layer[]>([]);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);

  // camadas da nota (com o cabeçalho que está no editor, mesmo antes de salvar)
  useEffect(() => {
    const id = ++reqId.current;
    const t = window.setTimeout(() => {
      api
        .preamble(vaultId, note, frontmatter)
        .then((r) => {
          if (id !== reqId.current) return;
          setLayers(r.layers);
          setDrafts((prev) => {
            const next = new Map(prev);
            for (const l of r.layers) {
              const d = next.get(idOf(l));
              // camada sem rascunho alterado acompanha o servidor
              if (!d || d.text === d.saved) next.set(idOf(l), { layer: l, text: l.text, saved: l.text, version: d?.version });
              else next.set(idOf(l), { ...d, layer: l });
            }
            return next;
          });
          setSelected((s) => (s && r.layers.some((l) => idOf(l) === s) ? s : idOf(r.layers[r.layers.length > 1 ? r.layers.length - 1 : 0])));
        })
        .catch((e) => ui.toast(e.message, true));
    }, 250);
    return () => clearTimeout(t);
  }, [vaultId, note, frontmatter, epoch, ui]);

  const current = selected ? drafts.get(selected) : undefined;

  const setText = (text: string) => {
    if (!selected || !current) return;
    setDrafts((prev) => new Map(prev).set(selected, { ...current, text }));
    setCheck(null);
  };

  const verify = useCallback(
    async (prefix = "") => {
      const overrides: Record<string, string> = {};
      drafts.forEach((d) => {
        overrides[d.layer.kind === "inline" ? "inline" : d.layer.path] = d.text;
      });
      setCheck({ ok: true, text: prefix + "Compilando com o LaTeX…" });
      try {
        const r = await api.checkPreamble(vaultId, note, overrides);
        setCheck(r.error ? { ok: false, text: prefix + r.error } : { ok: true, text: prefix + "✓ O preâmbulo compila." });
      } catch (e: any) {
        setCheck({ ok: false, text: e.message });
      }
    },
    [drafts, vaultId, note]
  );

  async function save() {
    if (!current || !selected) return;
    setBusy(true);
    try {
      const l = current.layer;
      if (l.kind === "inline") {
        const na = noteApi();
        if (!na || !note) throw new Error("abra a nota pra salvar o LaTeX dela");
        await na.save(); // grava o que estiver pendente no editor antes
        const r = await api.setInlinePreamble(vaultId, note, current.text, na.version());
        na.replaceText(r.text, r.version);
      } else {
        let base = current.version;
        if (l.exists && !base) base = (await api.readFile(vaultId, l.path)).version;
        const r = await api.writeFile(vaultId, l.path, current.text, l.exists ? base : undefined);
        setDrafts((prev) => new Map(prev).set(selected, { ...current, saved: current.text, version: r.version, layer: { ...l, exists: true } }));
      }
      setDrafts((prev) => {
        const d = prev.get(selected);
        return d ? new Map(prev).set(selected, { ...d, saved: d.text }) : prev;
      });
      bumpPreambleEpoch();
      onSaved();
      await verify("Salvo. ");
    } catch (e: any) {
      setCheck({ ok: false, text: "Não deu pra salvar: " + e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="dock" aria-label="Preâmbulos">
      <div className="dock-head">
        <h2>Preâmbulos</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar painel" title="Fechar">
          ✕
        </button>
      </div>
      <div className="dock-body">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {note ? (
            <>
              Somados nesta ordem para <b>{note.replace(/\.md$/, "")}</b>.
            </>
          ) : (
            "Abra uma nota para ver as camadas dela."
          )}
        </p>
        <div className="layer-list">
          {layers.map((l, i) => {
            const id = idOf(l);
            const d = drafts.get(id);
            const { name, scope } = describe(l);
            const dirty = d && d.text !== d.saved;
            return (
              <button
                key={id}
                className={"layer" + (id === selected ? " selected" : "") + (!l.exists && !dirty ? " missing" : "")}
                onClick={() => {
                  setSelected(id);
                  setCheck(null);
                }}
              >
                <span className="step">{i + 1}</span>
                <span>
                  <div className="name">{name}</div>
                  <div className="scope">{scope}</div>
                </span>
                {dirty ? <span className="dot" title="Não salvo" /> : <span />}
              </button>
            );
          })}
        </div>
        {current && (
          <>
            <textarea
              className="textarea"
              spellCheck={false}
              value={current.text}
              placeholder={current.layer.kind === "inline" ? "\\newcommand{\\X}{...}   (só esta nota)" : "\\newcommand{\\R}{\\mathbb{R}}"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  e.stopPropagation();
                  save();
                }
              }}
              aria-label="Texto do preâmbulo"
            />
            <div className="dock-actions">
              <button className="btn btn-sm" onClick={() => verify()} disabled={busy}>
                Verificar
              </button>
              <button className="btn btn-sm btn-primary" onClick={save} disabled={busy || current.text === current.saved}>
                {busy ? "Salvando…" : "Salvar"}
              </button>
            </div>
            {check && <div className={"check " + (check.ok ? "ok" : "bad")}>{check.text}</div>}
          </>
        )}
      </div>
    </aside>
  );
}
