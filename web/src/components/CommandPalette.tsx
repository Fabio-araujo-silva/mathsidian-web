// Ctrl+K: busca notas e comandos ao mesmo tempo, ignorando acentos.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyMatch } from "../lib/fuzzy";
import { Modal } from "./ui";

export type Command = { id: string; label: string; run: () => void; hint?: string };

type Item = { key: string; tag: string; label: string; sub?: string; ranges: [number, number][]; score: number; run: () => void };

type Props = {
  notes: string[]; // caminhos
  recent: string[];
  commands: Command[];
  onOpen: (path: string) => void;
  onClose: () => void;
};

function highlight(text: string, ranges: [number, number][]) {
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([a, b], i) => {
    if (a > last) out.push(text.slice(last, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    last = b;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const display = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");

export default function CommandPalette({ notes, recent, commands, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const out: Item[] = [];
    if (!q) {
      for (const p of recent.filter((r) => notes.includes(r)).slice(0, 6))
        out.push({ key: "n:" + p, tag: "Recente", label: display(p), sub: p, ranges: [], score: 0, run: () => onOpen(p) });
      for (const c of commands) out.push({ key: "c:" + c.id, tag: "Comando", label: c.label, sub: c.hint, ranges: [], score: 0, run: c.run });
      return out;
    }
    for (const p of notes) {
      const name = display(p);
      const m = fuzzyMatch(q, name);
      const mp = m ? null : fuzzyMatch(q, p);
      if (m) out.push({ key: "n:" + p, tag: "Nota", label: name, sub: p, ranges: m.ranges, score: m.score + 5, run: () => onOpen(p) });
      else if (mp) out.push({ key: "n:" + p, tag: "Nota", label: name, sub: p, ranges: [], score: mp.score - 20, run: () => onOpen(p) });
    }
    for (const c of commands) {
      const m = fuzzyMatch(q, c.label);
      if (m) out.push({ key: "c:" + c.id, tag: "Comando", label: c.label, sub: c.hint, ranges: m.ranges, score: m.score, run: c.run });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 60);
  }, [query, notes, recent, commands, onOpen]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <Modal onClose={onClose} label="Buscar notas e comandos">
      <div className="palette">
        <input
          autoFocus
          placeholder="Buscar notas e comandos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(active);
            }
          }}
          aria-label="Buscar"
          aria-controls="palette-list"
        />
        <div className="palette-list" id="palette-list" ref={list} role="listbox">
          {items.map((it, i) => (
            <div
              key={it.key}
              className={"palette-item" + (i === active ? " active" : "")}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => run(i)}
            >
              <span className="tag">{it.tag}</span>
              <span className="text">
                {highlight(it.label, it.ranges)}
                {it.sub && it.sub !== it.label && <div className="sub">{it.sub}</div>}
              </span>
            </div>
          ))}
          {!items.length && <div className="palette-empty">Nada encontrado para “{query}”.</div>}
        </div>
      </div>
    </Modal>
  );
}
