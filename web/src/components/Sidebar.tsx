// Lista de notas: pastas recolhíveis, ações aparecem ao passar o mouse, uso de espaço no rodapé.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "../api";
import { Popover, MenuItem } from "./ui";

type Node = { name: string; path: string; kind: "file" | "folder"; children: Node[] };

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

function buildTree(entries: Entry[]): Node[] {
  const root: Node = { name: "", path: "", kind: "folder", children: [] };
  const folders = new Map<string, Node>([["", root]]);
  const ensure = (p: string): Node => {
    let n = folders.get(p);
    if (n) return n;
    const parent = ensure(p.split("/").slice(0, -1).join("/"));
    n = { name: p.split("/").pop()!, path: p, kind: "folder", children: [] };
    parent.children.push(n);
    folders.set(p, n);
    return n;
  };
  for (const e of entries) {
    if (e.kind === "folder") ensure(e.path);
    else ensure(e.path.split("/").slice(0, -1).join("/")).children.push({ name: e.path.split("/").pop()!, path: e.path, kind: "file", children: [] });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : collator.compare(a.name, b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

type Props = {
  vaultId: string;
  entries: Entry[];
  activePath: string | null;
  used: number;
  limit: number;
  open: boolean;
  onOpen: (path: string) => void;
  onNewNote: (folder: string) => void;
  onNewFolder: (folder: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onBackup: () => void;
};

function Sidebar({ vaultId, entries, activePath, used, limit, open, onOpen, onNewNote, onNewFolder, onRename, onDelete, onBackup }: Props) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const storeKey = "ms-open-" + vaultId;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storeKey) || "[]"));
    } catch {
      return new Set();
    }
  });
  const [menu, setMenu] = useState<{ anchor: HTMLElement; node: Node } | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify([...expanded]));
    } catch {}
  }, [expanded, storeKey]);

  // abre as pastas até a nota ativa
  useEffect(() => {
    if (!activePath) return;
    const parts = activePath.split("/").slice(0, -1);
    if (!parts.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePath]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePath]);

  const toggle = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  // achata a árvore visível numa lista de linhas
  const rows: { node: Node; depth: number }[] = [];
  const walk = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.kind === "folder" && expanded.has(n.path)) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);

  const notes = entries.filter((e) => e.kind === "file" && e.path.endsWith(".md")).length;
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";

  return (
    <aside className={"sidebar" + (open ? " open" : "")} aria-label="Notas">
      <div className="sidebar-head">
        <h2>Notas · {notes}</h2>
      </div>
      <div className="sidebar-actions">
        <button className="btn btn-sm btn-primary" onClick={() => onNewNote("")}>
          + Nova nota
        </button>
        <button className="btn btn-sm" onClick={() => onNewFolder("")}>
          + Pasta
        </button>
      </div>
      <div className="tree" role="tree">
        {rows.map(({ node, depth }) => {
          const isFolder = node.kind === "folder";
          const isMd = node.name.toLowerCase().endsWith(".md");
          const active = node.path === activePath;
          const ext = !isFolder && !isMd ? node.name.split(".").pop() : "";
          return (
            <div
              key={node.path}
              ref={active ? activeRef : undefined}
              className={"tree-row" + (isFolder ? " tree-folder" : isMd ? "" : " tree-other") + (active ? " active" : "")}
              style={{ paddingLeft: 6 + depth * 14 }}
              role="treeitem"
              aria-expanded={isFolder ? expanded.has(node.path) : undefined}
              aria-selected={active}
              tabIndex={0}
              onClick={() => (isFolder ? toggle(node.path) : onOpen(node.path))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  isFolder ? toggle(node.path) : onOpen(node.path);
                }
              }}
            >
              <span className={"twisty" + (isFolder && expanded.has(node.path) ? " open" : "")}>{isFolder ? "▸" : ""}</span>
              <span className="label" title={node.path}>
                {isMd ? node.name.slice(0, -3) : node.name}
              </span>
              {ext && <span className="kind">{node.name === "preamble.tex" ? "Σ" : ext}</span>}
              <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                {isFolder && (
                  <button className="icon-btn" title="Nova nota nesta pasta" aria-label="Nova nota nesta pasta" onClick={() => onNewNote(node.path)}>
                    +
                  </button>
                )}
                <button className="icon-btn" title="Mais ações" aria-label="Mais ações" onClick={(e) => setMenu({ anchor: e.currentTarget, node })}>
                  ⋯
                </button>
              </span>
            </div>
          );
        })}
        {!rows.length && <p className="muted" style={{ padding: "8px 10px", fontSize: 14 }}>Nenhuma nota ainda.</p>}
      </div>
      <div className="sidebar-foot">
        <div>
          {mb(used)} de {mb(limit)}
        </div>
        <div className="meter" aria-hidden="true">
          <div style={{ width: pct + "%" }} />
        </div>
        <button className="btn btn-sm" style={{ width: "100%", justifyContent: "center" }} onClick={onBackup}>
          Backups do cofre
        </button>
      </div>
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          {menu.node.kind === "folder" && (
            <>
              <MenuItem onClick={() => (setMenu(null), onNewNote(menu.node.path))}>Nova nota aqui</MenuItem>
              <MenuItem onClick={() => (setMenu(null), onNewFolder(menu.node.path))}>Nova pasta aqui</MenuItem>
              <div className="menu-sep" />
            </>
          )}
          <MenuItem onClick={() => (setMenu(null), onRename(menu.node.path))}>Renomear ou mover…</MenuItem>
          <MenuItem danger onClick={() => (setMenu(null), onDelete(menu.node.path))}>
            Excluir…
          </MenuItem>
        </Popover>
      )}
    </aside>
  );
}

export default memo(Sidebar);
