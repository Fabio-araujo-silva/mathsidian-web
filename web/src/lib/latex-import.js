// Importar LaTeX: converte um documento (ou trecho) .tex em Markdown do Mathsidian.
// Portado do Mathsidian desktop (fonte-nucleo/lib/mathsidian-math/import.js), mesmo comportamento:
// - \[..\], equation/align/... -> $$ ... $$; teorema/lema/prova... -> callouts; \section -> ##
// - \newcommand/\DeclareMathOperator/\usetikzlibrary do preâmbulo -> defs/libs, pra mesclar no preamble.tex
/* eslint-disable */

var MATH_ENVS = "equation|align|alignat|gather|multline|flalign|eqnarray|tikzcd";

var CALLOUT_TYPES = {
  theorem: "teorema", teorema: "teorema", thm: "teorema",
  lemma: "lema", lema: "lema", lem: "lema",
  corollary: "corolario", corolario: "corolario", cor: "corolario",
  proposition: "proposicao", proposicao: "proposicao", prop: "proposicao",
  definition: "definicao", definicao: "definicao", defn: "definicao", def: "definicao",
  example: "exemplo", exemplo: "exemplo", ex: "exemplo",
  remark: "observacao", observacao: "observacao", obs: "observacao", nota: "observacao",
  proof: "prova", prova: "prova", demonstracao: "prova",
};

var DEFAULT_TITLES = {
  teorema: "Teorema", lema: "Lema", corolario: "Corolário", proposicao: "Proposição",
  definicao: "Definição", exemplo: "Exemplo", observacao: "Observação", prova: "Demonstração",
};

function stripComments(src) {
  return src
    .split(/\r?\n/)
    .map(function (line) {
      return line.replace(/(^|[^\\])%.*$/, "$1");
    })
    .join("\n");
}

// Lê o argumento {…} balanceado começando em s[i] === "{"; devolve [conteúdo, índice depois do }].
function readGroup(s, i) {
  if (s[i] !== "{") return null;
  var depth = 0;
  for (var j = i; j < s.length; j++) {
    var ch = s[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}

// Troca \cmd{arg} (argumento balanceado, opcional [..] antes) por fn(arg).
function replaceCommand(s, name, fn) {
  var re = new RegExp("\\\\" + name + "\\*?\\s*(\\[[^\\]]*\\])?\\s*(?=\\{)", "g");
  var out = "";
  var last = 0;
  var m;
  while ((m = re.exec(s))) {
    var g = readGroup(s, re.lastIndex);
    if (!g) continue;
    out += s.slice(last, m.index) + fn(g[0]);
    last = re.lastIndex = g[1];
  }
  return out + s.slice(last);
}

function parsePreamble(pre) {
  var defs = [];
  var libs = [];
  var theorems = {};
  pre.split("\n").forEach(function (line) {
    var t = line.trim();
    if (/^\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def|let)\b/.test(t)) defs.push(t);
    var lib = t.match(/^\\usetikzlibrary\{([^}]*)\}/);
    if (lib)
      lib[1].split(",").forEach(function (l) {
        l = l.trim();
        if (l && l !== "babel" && libs.indexOf(l) < 0) libs.push(l);
      });
  });
  // \newtheorem{nome}{Título} e \newtheorem{nome}[contador]{Título}
  pre.replace(/\\newtheorem\*?\{([^}]+)\}(?:\[[^\]]*\])?\{([^}]+)\}/g, function (_, name, title) {
    theorems[name] = title;
  });
  return { defs: defs, libs: libs, theorems: theorems };
}

function convert(src) {
  src = stripComments(src.replace(/\r\n?/g, "\n"));
  var pre = "";
  var body = src;
  var begin = src.indexOf("\\begin{document}");
  if (begin >= 0) {
    pre = src.slice(0, begin);
    body = src.slice(begin + "\\begin{document}".length);
    var end = body.indexOf("\\end{document}");
    if (end >= 0) body = body.slice(0, end);
  }
  var meta = parsePreamble(pre);

  // Indentação vira bloco de código no Markdown: tira.
  body = body
    .split("\n")
    .map(function (l) {
      return l.trim();
    })
    .join("\n");

  // 1. Protege a matemática com marcadores, pra nada abaixo mexer nela.
  var slots = [];
  function stash(md) {
    slots.push(md);
    return "\u0000" + (slots.length - 1) + "\u0000";
  }
  function blockMath(content) {
    content = content.trim().replace(/\n\s*\n+/g, "\n");
    return stash("\n$$\n" + content + "\n$$\n");
  }
  body = body.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, function (m) {
    return stash("\n```tikz\n" + m.trim() + "\n```\n");
  });
  body = body.replace(/\$\$([\s\S]*?)\$\$/g, function (_, c) {
    return blockMath(c);
  });
  body = body.replace(/\\\[([\s\S]*?)\\\]/g, function (_, c) {
    return blockMath(c);
  });
  body = body.replace(new RegExp("\\\\begin\\{(" + MATH_ENVS + ")(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}", "g"), function (m) {
    return blockMath(m);
  });
  body = body.replace(/\\\(([\s\S]*?)\\\)/g, function (_, c) {
    return stash("$" + c.trim().replace(/\s*\n\s*/g, " ") + "$");
  });
  body = body.replace(/(^|[^\\])\$((?:\\.|[^$\\])+)\$/g, function (_, before, c) {
    return before + stash("$" + c.trim().replace(/\s*\n\s*/g, " ") + "$");
  });

  // 2. Texto.
  body = replaceCommand(body, "section", function (a) {
    return "\n## " + a + "\n";
  });
  body = replaceCommand(body, "subsection", function (a) {
    return "\n### " + a + "\n";
  });
  body = replaceCommand(body, "subsubsection", function (a) {
    return "\n#### " + a + "\n";
  });
  body = replaceCommand(body, "paragraph", function (a) {
    return "**" + a + "** ";
  });
  ["title", "author", "date", "label", "vspace", "hspace", "thispagestyle", "pagestyle"].forEach(function (c) {
    body = replaceCommand(body, c, function () {
      return "";
    });
  });
  ["textbf", "textsc"].forEach(function (c) {
    body = replaceCommand(body, c, function (a) {
      return "**" + a + "**";
    });
  });
  ["emph", "textit", "textsl"].forEach(function (c) {
    body = replaceCommand(body, c, function (a) {
      return "*" + a + "*";
    });
  });
  body = replaceCommand(body, "texttt", function (a) {
    return "`" + a + "`";
  });
  ["underline", "text", "mbox", "textrm", "textup"].forEach(function (c) {
    body = replaceCommand(body, c, function (a) {
      return a;
    });
  });
  body = replaceCommand(body, "footnote", function (a) {
    return " (" + a + ")";
  });
  body = replaceCommand(body, "(?:eq)?ref", function (a) {
    return "(" + a + ")";
  });
  body = body
    .replace(/\\(medskip|bigskip|smallskip|noindent|par|newpage|clearpage|maketitle|centering|indent|tableofcontents|qed|qedhere)\b\s*/g, "")
    .replace(/\\begin\{(center|flushleft|flushright|quote|quotation)\}|\\end\{(center|flushleft|flushright|quote|quotation)\}/g, "")
    .replace(/\\begin\{itemize\}|\\end\{itemize\}/g, "\n")
    .replace(/``/g, "“")
    .replace(/''/g, "”")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/(^|[^\\])~/g, "$1 ")
    .replace(/\\\\(\[[^\]]*\])?/g, "  \n")
    .replace(/\\([%&#_{}$])/g, "$1")
    .replace(/\\ldots|\\dots/g, "…");
  // itens: dentro de enumerate viram "1." (ou "- **(i)**" quando o item tem rótulo próprio), senão "-"
  body = body.replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, function (_, list) {
    return (
      "\n" +
      list.replace(/\\item\b(?:\[([^\]]*)\])?\s*/g, function (_, label) {
        return label ? "\n- **" + label + "** " : "\n1. ";
      }) +
      "\n"
    );
  });
  body = body.replace(/\\item\b(?:\[([^\]]*)\])?\s*/g, function (_, label) {
    return "\n- " + (label ? "**" + label + "** " : "");
  });

  // 3. Ambientes de teorema -> callouts (de dentro pra fora, pra aninhar).
  function expand(s) {
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return slots[+i];
    });
  }
  var names = Object.keys(meta.theorems).concat(Object.keys(CALLOUT_TYPES));
  var envRe = new RegExp(
    "\\\\begin\\{(" + names.map(function (n) { return n.replace(/\*/g, "\\*"); }).join("|") + ")\\}(?:\\[([^\\]]*)\\])?((?:(?!\\\\begin\\{(?:" + names.join("|") + ")\\})[\\s\\S])*?)\\\\end\\{\\1\\}",
    "g"
  );
  var guard = 0;
  while (envRe.test(body) && guard++ < 50) {
    envRe.lastIndex = 0;
    body = body.replace(envRe, function (_, name, opt, content) {
      var type = CALLOUT_TYPES[name.toLowerCase()] || CALLOUT_TYPES[(meta.theorems[name] || "").toLowerCase()] || name.toLowerCase();
      var title = meta.theorems[name] || DEFAULT_TITLES[type] || name;
      if (opt) title += " (" + opt.trim() + ")";
      var inner = expand(content)
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .split("\n")
        .map(function (l) {
          return l ? "> " + l : ">";
        })
        .join("\n");
      return "\n\n> [!" + type + "] " + title + "\n" + inner + "\n\n";
    });
  }

  var markdown = expand(body)
    .split("\n")
    .map(function (l) {
      return l.replace(/[ \t]+$/, function (sp) {
        return sp.length >= 2 ? "  " : "";
      });
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { markdown: markdown + "\n", defs: meta.defs, libs: meta.libs };
}

// Nome definido por uma linha do preâmbulo (\newcommand{\R}... -> "\R").
function definedName(line) {
  var m = line.match(/^\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator\*?|def|let)\s*\{?\s*(\\[A-Za-z@]+)/);
  return m ? m[1] : null;
}

// Junta ao texto do preamble.tex as definições e bibliotecas que ainda não estão lá.
// Devolve { text, added } (added = quantas linhas entraram).
export function mergeIntoPreamble(current, defs, libs) {
  current = current || "";
  var add = [];
  defs.forEach(function (d) {
    var name = definedName(d);
    var already = name && new RegExp("\\" + name.replace(/[@]/g, "\\$&") + "(?![A-Za-z@])").test(current);
    if (!already && current.indexOf(d) < 0) add.push(d);
  });
  var missingLibs = libs.filter(function (l) {
    return !new RegExp("\\\\usetikzlibrary\\{[^}]*\\b" + l + "\\b").test(current);
  });
  if (missingLibs.length) add.unshift("\\usetikzlibrary{" + missingLibs.join(",") + "}");
  if (!add.length) return { text: current, added: 0 };
  var text = (current && !current.endsWith("\n") ? current + "\n" : current) + add.join("\n") + "\n";
  return { text: text, added: add.length };
}

export { convert };
