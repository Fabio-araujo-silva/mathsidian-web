# Mathsidian Web

Notas de matemática com **LaTeX de verdade**, no navegador. Cada pessoa cria a conta, já ganha um cofre com exemplos e guarda tudo na nuvem, com backups automáticos e download em `.zip` quando quiser.

É a versão web do [Mathsidian](https://github.com/Fabio-araujo-silva/mathsidian), escrita do zero. **Não contém código do Obsidian.** Do Mathsidian desktop vieram só as partes próprias: o motor de LaTeX, o preâmbulo em cascata e o importador de LaTeX.

## O que já funciona

- **Contas:** cadastro com código de convite (ou aberto, ou fechado), login, troca de senha, sessões de 30 dias.
- **Cofres na nuvem:** vários cofres por conta, pastas, notas, anexos (cole ou arraste uma imagem no editor).
- **LaTeX de verdade:** `$...$`, `$$...$$`, `align`, `tikz-cd`, blocos ` ```tikz ` e ` ```latex `, compilados pelo TeX no servidor e desenhados como SVG que segue o tema.
- **Preâmbulo em cascata:** `preamble.tex` na raiz vale para o cofre todo; numa pasta, vale para ela e as subpastas; a propriedade `preamble` vale só para a nota. O painel **Σ Preâmbulos** mostra as camadas em ordem, edita cada uma e confere com o TeX antes de salvar.
- **Ler, Escrever e Lado a lado**, com salvamento automático e aviso de conflito quando a mesma nota muda em dois lugares.
- **Callouts de teoria:** `> [!teorema] Título`, definição, prova (com ∎), exemplo, observação.
- **Links entre notas** com `[[Nome]]`; clicar num link para uma nota que não existe oferece criar.
- **Busca com `Ctrl + K`:** notas e comandos, ignorando acentos.
- **Importar LaTeX:** colar um documento com `\begin{document}` converte para Markdown e junta as definições ao `preamble.tex`.
- **Backups:** baixar o cofre em `.zip` a qualquer hora, cópias automáticas no servidor (as últimas 14), importar um `.zip` (inclusive um cofre do Obsidian/Mathsidian) como cofre novo.
- **Tema claro e escuro.** Em tela estreita, a lista de notas e o painel viram gavetas.

## Rodar no seu computador

Precisa de **Node 22.13+** e de um LaTeX com `latex` e `dvisvgm` (no Windows, o MiKTeX que o Mathsidian desktop instala serve).

    npm install
    npm run dev

Abra http://localhost:5173. No modo de desenvolvimento o cadastro é aberto. Os dados ficam na pasta `data/`.

Testes do servidor (incluem compilar LaTeX de verdade, se o TeX estiver instalado):

    npm test

## Colocar no ar

O jeito mais simples é um servidor Linux pequeno (VPS de 2 GB de RAM já atende um grupo de amigos) com Docker:

1. Aponte um domínio para o IP do servidor.
2. Copie `.env.example` para `.env` e troque `INVITE_CODES`.
3. Em `docker-compose.yml`, troque `mathsidian.exemplo.com` pelo seu domínio.
4. Rode `docker compose up -d --build`. O Caddy cuida do HTTPS sozinho.
5. Mande para os amigos o link `https://seu-dominio/?convite=SEU-CODIGO`.

Tudo o que importa fica no volume `mathsidian-data` (banco, cofres, backups e cache do LaTeX). Para um backup do servidor inteiro, copie esse volume.

> O `Dockerfile` e o `docker-compose.yml` ainda não foram testados num servidor de verdade: foram escritos e revisados, mas não executados (o computador onde o projeto nasceu não tem Docker).

## Como funciona

    web/      front-end (React + Vite, TypeScript)
    server/   API e LaTeX (Node + Fastify, SQLite embutido do Node)
    shared/   código usado pelos dois (documento TeX e chave de cache das fórmulas)

- **Armazenamento:** contas e lista de cofres num SQLite (`node:sqlite`, sem dependência nativa). O conteúdo de cada cofre é uma pasta comum em `DATA_DIR/vaults/<id>/`, com arquivos `.md` de verdade.
- **LaTeX:** `latex` → `dvisvgm` → SVG, em lotes, com 3 compilações em paralelo. O cabeçalho (pacotes + preâmbulo) vira um formato pré-compilado (`.fmt`) por preâmbulo. Um lote com erro é dividido ao meio até achar a fórmula culpada.
- **Preâmbulo:** resolvido no servidor (`server/src/preamble.js`), igual ao Mathsidian desktop.

### Otimizações

- **Cache de fórmulas em 4 níveis:** memória do navegador → IndexedDB → cache do servidor em memória → cache em disco. A chave é o SHA-1 de fórmula + preâmbulo, calculada igual no navegador e no servidor (`shared/tex.js`): reabrir uma nota não faz nenhum pedido de LaTeX.
- **Erros do TeX também ficam em cache** (são determinísticos); falha de rede e tempo esgotado, não.
- **Leitor incremental:** ao editar, só o bloco alterado é refeito; as fórmulas já desenhadas são reaproveitadas.
- **Digitando:** a prévia do KaTeX aparece na hora; o servidor só compila depois de uma pausa, então versões pela metade de uma fórmula nunca viram pedido.
- **Pedidos em lote**, as fórmulas do topo da nota primeiro, fórmulas repetidas pedidas uma vez só.
- **Código dividido:** a primeira visita baixa 128 KB (brotli). O editor (CodeMirror, 96 KB) e o KaTeX (64 KB) só são baixados quando usados; o editor é pré-carregado quando o navegador fica ocioso. O Markdown do editor usa o `@lezer/markdown` direto, sem os parsers de HTML/CSS/JS (−75 KB em gzip).
- **Entrega:** arquivos pré-comprimidos com brotli no nível máximo na hora do build; assets com hash em cache por um ano (`immutable`); notas com ETag (reabrir sem mudança responde 304).
- **Servidor:** índice de arquivos em memória por cofre (nada de varrer o disco a cada pedido), cache dos textos pequenos, respostas dinâmicas em brotli rápido, escrita atômica.
- **Notas longas:** blocos fora da tela não são desenhados (`content-visibility`).

### Segurança

- Senhas com scrypt; sessão em cookie `httpOnly`/`SameSite=Lax`, guardada no banco só como hash.
- Toda escrita exige o cabeçalho `x-mathsidian: 1` (bloqueia CSRF); limite de tentativas de login e de cadastros por IP.
- Caminhos de arquivo validados (sem `..`, sem caminho absoluto); cada usuário só enxerga os próprios cofres.
- O TeX roda código dos usuários: sem `shell-escape`, leitura e escrita só na pasta de trabalho (`openin_any=p`, `openout_any=p`), tempo máximo por compilação, processo sem root e com limite de memória/CPU no Docker.
- O SVG das fórmulas é sanitizado (DOMPurify) antes de entrar na página; Markdown sem HTML cru; CSP restritiva.

## Próximos passos

- Fórmulas desenhadas dentro do editor (como no modo "live preview").
- Atualizar os `[[links]]` ao renomear uma nota.
- Busca no texto das notas.
- Funcionar offline (PWA) e sincronizar quando voltar a conexão.
- Compartilhar uma nota por link e editar junto.
- Histórico de versões por nota.
