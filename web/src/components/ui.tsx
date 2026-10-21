// Peças de interface: diálogos (pergunta, confirmação), menus flutuantes e avisos.
// Tudo dentro do app: nada de window.prompt/confirm, que travam a página.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type PromptOpts = { title: string; label?: string; value?: string; confirm?: string; placeholder?: string; description?: string };
type ConfirmOpts = { title: string; description?: string; confirm?: string; danger?: boolean; typeToConfirm?: string };
type Toast = { id: number; text: string; error?: boolean };

type UiApi = {
  prompt: (o: PromptOpts) => Promise<string | null>;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  toast: (text: string, error?: boolean) => void;
};

const UiContext = createContext<UiApi | null>(null);
export const useUi = () => useContext(UiContext)!;

type Pending =
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void };

export function UiProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const api: UiApi = useRef<UiApi>({
    prompt: (opts) => new Promise((resolve) => setPending({ kind: "prompt", opts, resolve })),
    confirm: (opts) => new Promise((resolve) => setPending({ kind: "confirm", opts, resolve })),
    toast: (text, error) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, text, error }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 2800);
    },
  }).current;

  return (
    <UiContext.Provider value={api}>
      {children}
      {pending && pending.kind === "prompt" && (
        <PromptDialog
          opts={pending.opts}
          onDone={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
      {pending && pending.kind === "confirm" && (
        <ConfirmDialog
          opts={pending.opts}
          onDone={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={"toast" + (t.error ? " error" : "")}>
            {t.text}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  );
}

export function Modal({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label={label}>
      {children}
    </div>
  );
}

function PromptDialog({ opts, onDone }: { opts: PromptOpts; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.value || "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current!;
    el.focus();
    // seleciona o nome sem a extensão
    const dot = el.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }, []);
  const cancel = useCallback(() => onDone(null), [onDone]);
  return (
    <Modal onClose={cancel} label={opts.title}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onDone(value.trim());
        }}
      >
        <h3>{opts.title}</h3>
        {opts.description && <p>{opts.description}</p>}
        <div className="field">
          {opts.label && <label htmlFor="prompt-input">{opts.label}</label>}
          <input id="prompt-input" ref={input} className="input" value={value} placeholder={opts.placeholder} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!value.trim()}>
            {opts.confirm || "OK"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ opts, onDone }: { opts: ConfirmOpts; onDone: (v: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const ok = !opts.typeToConfirm || typed.trim() === opts.typeToConfirm;
  const cancel = useCallback(() => onDone(false), [onDone]);
  return (
    <Modal onClose={cancel} label={opts.title}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onDone(true);
        }}
      >
        <h3>{opts.title}</h3>
        {opts.description && <p>{opts.description}</p>}
        {opts.typeToConfirm && (
          <div className="field">
            <label htmlFor="confirm-input">Digite “{opts.typeToConfirm}” para confirmar</label>
            <input id="confirm-input" className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={cancel} autoFocus={!opts.typeToConfirm}>
            Cancelar
          </button>
          <button className={"btn " + (opts.danger ? "btn-danger" : "btn-primary")} disabled={!ok}>
            {opts.confirm || "Confirmar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Menu flutuante preso a um elemento (abre abaixo dele, sem sair da tela).
export function Popover({ anchor, onClose, children, align = "left" }: { anchor: HTMLElement; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === "right" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current!.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  return (
    <div ref={ref} className="popover" role="menu" style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}>
      {children}
    </div>
  );
}

export function MenuItem({ children, onClick, danger, checked }: { children: ReactNode; onClick: () => void; danger?: boolean; checked?: boolean }) {
  return (
    <button className={"menu-item" + (danger ? " danger" : "")} role="menuitem" onClick={onClick}>
      {children}
      {checked && <span className="check-mark">✓</span>}
    </button>
  );
}

// Atalho global de teclado (Ctrl no Windows/Linux, Cmd no Mac).
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, deps: unknown[] = []) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === key) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
