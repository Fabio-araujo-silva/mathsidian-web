// Cliente da API. Toda escrita leva o cabeçalho x-mathsidian (proteção contra CSRF no servidor).

export class ApiError extends Error {
  status: number;
  payload: any;
  constructor(status: number, message: string, payload?: any) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export type User = { id: string; email: string; name: string; created_at: number };
export type Vault = { id: string; name: string; created_at: number; updated_at: number; snapshot_at: number };
export type Entry = { path: string; kind: "file" | "folder"; size?: number; mtime?: number };
export type Layer = { kind: "vault" | "folder" | "link" | "inline"; path: string; exists: boolean; text: string; entry?: string };
export type RenderResult = { key: string; svg?: string; width?: number; height?: number; depth?: number; error?: string };

async function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, init: RequestInit = {}) {
  const h: Record<string, string> = { ...headers };
  let payload: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") h["x-mathsidian"] = "1";
  if (body instanceof FormData || body instanceof Blob || typeof body === "string") payload = body as BodyInit;
  else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers: h, body: payload, credentials: "same-origin", ...init });
  if (!res.ok && res.status !== 304) {
    let data: any = null;
    try {
      data = await res.json();
    } catch {}
    throw new ApiError(res.status, (data && data.error) || res.statusText || "erro de rede", data);
  }
  return res;
}

const json = async <T>(p: Promise<Response>): Promise<T> => (await p).json();
const enc = encodeURIComponent;
const v = (id: string) => "/api/vaults/" + id;

export const api = {
  config: () => json<{ registration: "open" | "invite" | "closed" }>(request("GET", "/api/config")),
  me: () => json<{ user: User | null }>(request("GET", "/api/auth/me")),
  login: (email: string, password: string) => json<{ user: User }>(request("POST", "/api/auth/login", { email, password })),
  register: (data: { email: string; name: string; password: string; invite?: string }) =>
    json<{ user: User }>(request("POST", "/api/auth/register", data)),
  logout: () => request("POST", "/api/auth/logout"),
  changePassword: (current: string, next: string) => request("POST", "/api/auth/password", { current, next }),

  vaults: () => json<{ vaults: Vault[] }>(request("GET", "/api/vaults")),
  createVault: (name: string) => json<{ vault: Vault }>(request("POST", "/api/vaults", { name })),
  renameVault: (id: string, name: string) => json<{ vault: Vault }>(request("PATCH", v(id), { name })),
  deleteVault: (id: string) => request("DELETE", v(id)),
  tree: (id: string) => json<{ entries: Entry[]; used: number; limit: number }>(request("GET", v(id) + "/tree")),

  // texto + versão; usa o cache HTTP (ETag) do navegador: nota que não mudou volta como 304
  async readFile(id: string, path: string): Promise<{ text: string; version: string }> {
    const res = await request("GET", v(id) + "/file?path=" + enc(path), undefined, {}, { cache: "no-cache" });
    return { text: await res.text(), version: res.headers.get("x-version") || "" };
  },
  fileUrl: (id: string, path: string) => v(id) + "/file?path=" + enc(path),
  writeFile: (id: string, path: string, text: string, baseVersion?: string, keepalive = false) =>
    json<{ path: string; version: string; created: boolean }>(
      request("PUT", v(id) + "/file?path=" + enc(path), text, { "content-type": "text/plain; charset=utf-8", ...(baseVersion ? { "x-base-version": baseVersion } : {}) }, { keepalive })
    ),
  uploadFile: (id: string, path: string, blob: Blob) =>
    json<{ path: string; version: string }>(request("PUT", v(id) + "/file?path=" + enc(path), blob, { "content-type": "application/octet-stream" })),
  mkdir: (id: string, path: string) => json<{ path: string }>(request("POST", v(id) + "/folder", { path })),
  move: (id: string, from: string, to: string) => json<{ path: string }>(request("POST", v(id) + "/move", { from, to })),
  remove: (id: string, path: string) => request("DELETE", v(id) + "/entry?path=" + enc(path)),

  preamble: (id: string, note: string | null, frontmatter?: string | null) =>
    json<{ layers: Layer[]; preamble: string }>(request("POST", v(id) + "/preamble/resolve", { note, frontmatter })),
  checkPreamble: (id: string, note: string | null, overrides: Record<string, string>) =>
    json<{ error: string | null }>(request("POST", v(id) + "/preamble/check", { note, overrides })),
  setInlinePreamble: (id: string, note: string, latex: string, baseVersion?: string) =>
    json<{ version: string; text: string }>(request("PUT", v(id) + "/preamble/inline", { note, latex, baseVersion })),

  render: (id: string, note: string | null, frontmatter: string | null, items: { tex: string; display: boolean }[]) =>
    json<{ results: RenderResult[] }>(request("POST", v(id) + "/render", { note, frontmatter, items })),
  renderBlock: (id: string, note: string | null, frontmatter: string | null, lang: string, source: string) =>
    json<RenderResult>(request("POST", v(id) + "/render-block", { note, frontmatter, lang, source })),

  backupUrl: (id: string) => v(id) + "/backup",
  importVault: (file: File, name: string) => {
    const form = new FormData();
    form.append("name", name);
    form.append("file", file);
    return json<{ vault: Vault; files: number }>(request("POST", "/api/vaults/import", form));
  },
  snapshots: (id: string) => json<{ snapshots: { name: string; size: number }[]; everyHours: number; keep: number }>(request("GET", v(id) + "/snapshots")),
  takeSnapshot: (id: string) => json<{ name: string }>(request("POST", v(id) + "/snapshots")),
  snapshotUrl: (id: string, name: string) => v(id) + "/snapshots/" + enc(name),
};
