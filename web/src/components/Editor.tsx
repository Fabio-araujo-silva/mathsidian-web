// Editor de Markdown (CodeMirror 6). Carregado sob demanda (React.lazy): quem só lê não baixa.
// Não transforma o documento em texto a cada tecla: avisa que mudou (onChange) e quem precisa do
// texto chama getText() quando for salvar ou atualizar a prévia.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, HighlightStyle, indentOnInput, Language, LanguageSupport, defineLanguageFacet } from "@codemirror/language";
import { parser as markdownParser, GFM, type MarkdownConfig } from "@lezer/markdown";
import { tags as t, Tag } from "@lezer/highlight";

// $...$ e $$...$$ fazem parte da gramática: o realce vem da árvore de sintaxe (incremental, sem
// varrer o texto com regex a cada edição) e nada dentro da fórmula vira link/ênfase do Markdown.
const mathTag = Tag.define();
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const MathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: mathTag },
    { name: "BlockMath", block: true, style: mathTag },
  ],
  parseInline: [
    {
      name: "InlineMath",
      before: "Escape",
      parse(cx, next, pos) {
        if (next !== 36 /* $ */ || cx.char(pos + 1) === 36 || (pos > cx.offset && cx.char(pos - 1) === 92)) return -1;
        if (pos + 1 >= cx.end || isSpace(cx.char(pos + 1))) return -1;
        let end = pos + 1;
        for (; end < cx.end; end++) {
          const c = cx.char(end);
          if (c === 92) end++;
          else if (c === 36) break;
          else if (c === 10) return -1;
        }
        if (end >= cx.end || isSpace(cx.char(end - 1))) return -1;
        return cx.addElement(cx.elt("InlineMath", pos, end + 1));
      },
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      before: "FencedCode",
      parse(cx, line) {
        if (line.next !== 36 || line.text.charCodeAt(line.pos + 1) !== 36) return false;
        const start = cx.lineStart + line.pos;
        if (line.text.indexOf("$$", line.pos + 2) >= 0) {
          cx.nextLine();
          cx.addElement(cx.elt("BlockMath", start, cx.prevLineEnd()));
          return true;
        }
        while (cx.nextLine()) {
          if (line.text.includes("$$")) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("BlockMath", start, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};

// Cabeçalho YAML (--- ... ---) no começo da nota: um bloco só, sem virar título do Markdown.
const Frontmatter: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true, style: t.meta }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text !== "---") return false;
        const start = cx.lineStart;
        while (cx.nextLine()) {
          if (line.text === "---") {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("Frontmatter", start, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};

// Markdown direto do @lezer/markdown (já vem com o realce). O @codemirror/lang-markdown puxaria
// também os parsers de HTML, CSS e JavaScript (~300 KB) que uma nota não usa.
const markdownLanguage = new Language(defineLanguageFacet(), markdownParser.configure([GFM, Frontmatter, MathSyntax]), [], "markdown");
const markdown = () => new LanguageSupport(markdownLanguage);

export type EditorHandle = {
  getText: () => string;
  setText: (text: string) => void;
  focus: () => void;
  insert: (text: string) => void;
};

type Props = {
  initial: string;
  onChange: () => void;
  onSave: () => void;
  onPasteText?: (text: string) => Promise<string | null>; // devolve o que inserir (ou null pra colar normal)
  onPasteFiles?: (files: File[]) => Promise<string | null>;
  plain?: boolean; // .tex/.txt: sem Markdown
};

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.35em" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.2em" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent-strong)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: t.quote, color: "var(--muted)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--faint)" },
  { tag: t.list, color: "var(--accent-strong)" },
  { tag: mathTag, class: "cm-math" },
]);

const Editor = forwardRef<EditorHandle, Props>(function Editor({ initial, onChange, onSave, onPasteText, onPasteFiles, plain }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave, onPasteText, onPasteFiles });
  cb.current = { onChange, onSave, onPasteText, onPasteFiles };
  const silent = useRef(false);

  useEffect(() => {
    const lang = new Compartment();
    const state = EditorState.create({
      doc: initial,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        placeholder(plain ? "" : "Escreva aqui. Fórmulas entre $...$ ou $$...$$."),
        lang.of(plain ? [] : markdown()),
        syntaxHighlighting(highlight),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !silent.current) cb.current.onChange();
        }),
        EditorView.domEventHandlers({
          paste(e, v) {
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length && cb.current.onPasteFiles) {
              e.preventDefault();
              cb.current.onPasteFiles(files).then((md) => md && v.dispatch(v.state.replaceSelection(md)));
              return true;
            }
            const text = e.clipboardData?.getData("text/plain") || "";
            if (!cb.current.onPasteText || !/\\begin\{document\}/.test(text)) return false;
            e.preventDefault();
            cb.current.onPasteText(text).then((md) => v.dispatch(v.state.replaceSelection(md ?? text)));
            return true;
          },
          drop(e, v) {
            const files = Array.from(e.dataTransfer?.files || []);
            if (!files.length || !cb.current.onPasteFiles) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            cb.current.onPasteFiles(files).then((md) => md && v.dispatch({ changes: { from: pos, insert: md } }));
            return true;
          },
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // o editor é criado uma vez por nota (a key do componente muda junto)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    getText: () => view.current?.state.doc.toString() ?? "",
    setText: (text: string) => {
      const v = view.current;
      if (!v || v.state.doc.toString() === text) return;
      silent.current = true;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      silent.current = false;
    },
    focus: () => view.current?.focus(),
    insert: (text: string) => {
      const v = view.current;
      if (v) v.dispatch(v.state.replaceSelection(text));
    },
  }));

  return <div ref={host} className="editor-host" />;
});

export default Editor;
