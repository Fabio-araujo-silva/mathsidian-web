// Leitura simples do cabeçalho YAML, só pra mostrar as propriedades em etiquetas. Cobre o que as
// notas usam (chave: valor, listas com "-" ou [a, b], texto em bloco com | ou >). O YAML de verdade
// é interpretado no servidor; aqui não vale baixar um parser de 100 KB pra desenhar etiquetas.

const unquote = (s: string) => {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
};

function inlineList(v: string): string | null {
  const m = /^\[(.*)\]$/.exec(v.trim());
  if (!m) return null;
  // [[link]] sem aspas vira lista dentro de lista no YAML: mostra como link
  if (/^\[.*\]$/.test(m[1].trim()) && !m[1].includes(",")) return m[1].trim();
  return m[1]
    .split(",")
    .map(unquote)
    .filter(Boolean)
    .join(", ");
}

export function displayProps(raw: string): [string, string][] {
  const out: [string, string][] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s#:][^:]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].trim();
    const value = (m[2] || "").trim();
    const nested: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) nested.push(lines[++i]);
    let shown: string;
    if (value === "|" || value === ">" || /^[|>][+-]?$/.test(value)) shown = nested.map((l) => l.trim()).filter(Boolean).join(value.startsWith(">") ? " " : " ⏎ ");
    else if (!value && nested.some((l) => /^\s*-\s/.test(l)))
      shown = nested
        .filter((l) => /^\s*-\s/.test(l))
        .map((l) => unquote(l.replace(/^\s*-\s/, "")))
        .join(", ");
    else shown = inlineList(value) ?? unquote(value);
    out.push([key, shown]);
  }
  return out;
}
