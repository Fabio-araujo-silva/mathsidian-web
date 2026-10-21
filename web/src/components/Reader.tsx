// Leitor: Markdown -> DOM, reaproveitando os blocos que não mudaram (com as fórmulas já desenhadas).
// Ao editar no modo "lado a lado", só o bloco editado é recriado e redesenhado.
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { renderBlocks } from "../lib/markdown";
import { hydrate, type NoteCtx } from "../lib/mathService";
import { api } from "../api";

type Props = {
  body: string;
  ctx: NoteCtx;
  epoch: number;
  debounceMs: number;
  resolveLink: (target: string) => string | null;
  onOpenLink: (target: string) => void;
};

function Reader({ body, ctx, epoch, debounceMs, resolveLink, onOpenLink }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pool = useRef(new Map<string, Element[][]>()); // HTML do bloco -> nós já desenhados
  const ctxKey = useRef("");
  const gen = useRef(0);
  const timer = useRef<number | null>(null);
  const latest = useRef({ body, ctx, epoch, resolveLink });
  latest.current = { body, ctx, epoch, resolveLink };
  const debounceRef = useRef(debounceMs);
  debounceRef.current = debounceMs;

  function draw() {
    timer.current = null;
    const root = ref.current;
    if (!root) return;
    const { body, ctx, epoch, resolveLink } = latest.current;
    const key = epoch + "\0" + ctx.vaultId + "\0" + (ctx.note || "") + "\0" + (ctx.frontmatter ?? "");
    // preâmbulo/nota mudou: os desenhos antigos não servem mais
    const sameNote = key === ctxKey.current;
    const reuse = sameNote ? pool.current : new Map<string, Element[][]>();
    if (!sameNote) gen.current++;
    // redesenho por digitação (lado a lado): o servidor só compila depois de uma pausa
    const typing = sameNote && debounceRef.current > 0;
    ctxKey.current = key;
    const myGen = gen.current;

    const next = new Map<string, Element[][]>();
    const nodes: Element[] = [];
    const tpl = document.createElement("template");
    for (const html of renderBlocks(body)) {
      let group = reuse.get(html)?.pop();
      if (!group) {
        tpl.innerHTML = html;
        group = Array.from(tpl.content.children);
        markLinks(group, resolveLink);
        fixImages(group, ctx.vaultId); // ainda dentro do <template>: nada foi baixado
      }
      const list = next.get(html);
      if (list) list.push(group);
      else next.set(html, [group]);
      nodes.push(...group);
    }
    pool.current = next;

    // encaixa na ordem certa movendo o mínimo
    for (let i = 0; i < nodes.length; i++) {
      const at = root.children[i];
      if (at !== nodes[i]) root.insertBefore(nodes[i], at || null);
    }
    while (root.children.length > nodes.length) root.lastElementChild!.remove();

    hydrate(root, ctx, { alive: () => gen.current === myGen && ref.current === root, serverDelay: typing ? 700 : 0 });
  }

  // primeira pintura sem atraso; depois, com debounce (digitação no modo lado a lado)
  useLayoutEffect(() => {
    if (!ctxKey.current) {
      draw();
      return;
    }
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = window.setTimeout(draw, debounceMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, ctx.vaultId, ctx.note, ctx.frontmatter, epoch]);

  useEffect(
    () => () => {
      gen.current++;
      if (timer.current != null) clearTimeout(timer.current);
    },
    []
  );

  // imagens do cofre e links entre notas
  useEffect(() => {
    const root = ref.current!;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element).closest("a.wl") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      onOpenLink(a.dataset.target || "");
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [onOpenLink]);

  return <div ref={ref} className="reader" />;
}

// Imagens com caminho do cofre ("anexos/x.png") vêm da API; todas com carregamento preguiçoso.
function fixImages(group: Element[], vaultId: string) {
  for (const el of group)
    for (const img of Array.from(el.querySelectorAll<HTMLImageElement>("img[src]"))) {
      const src = img.getAttribute("src") || "";
      img.loading = "lazy";
      img.decoding = "async";
      if (/^(https?:|data:|blob:)/i.test(src)) continue;
      let path = src.replace(/^\.?\//, "");
      try {
        path = decodeURIComponent(path);
      } catch {}
      img.setAttribute("src", api.fileUrl(vaultId, path));
    }
}

function markLinks(group: Element[], resolve: (t: string) => string | null) {
  for (const el of group)
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a.wl"))) if (!resolve(a.dataset.target || "")) a.classList.add("missing");
}

export default memo(Reader);
