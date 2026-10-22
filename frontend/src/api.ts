/**
 * API client.
 *
 * No token handling: Cloudflare Access authenticates at the edge and injects
 * the assertion header on every request. If the page loaded at all, the
 * browser already has an Access session — so a 401 here means the session
 * expired mid-visit, and the fix is a reload to re-trigger the Access flow.
 */

export interface Identity {
  email: string;
  role: "admin" | "user";
  minExt: number | null;
  maxExt: number | null;
  callLogAccess: boolean;
  /** The admin actually signed in, when this identity is being viewed as. */
  impersonatedBy?: string;
}

export interface Pbx {
  id: string;
  name: string;
  prefix: string;
  sccp_enabled: number;
  file_rev: number;
  observed_file_rev: number | null;
  state:
    | "never_connected"
    | "connecting"
    | "blocked"
    | "syncing"
    | "converged"
    | "degraded";
  last_error: string | null;
  last_seen_at: string | null;
  acked_seq: number;
  seconds_since_seen: number | null;
}

export interface PbxStatus {
  connected: boolean;
  state: Pbx["state"];
  ackedSeq: number;
  desiredSeq: number;
  behind: number;
  lastError: string | null;
  observedFileRev: number | null;
  quarantined: {
    config_class: string;
    object_type: string;
    object_id: string;
    attempts: number;
    status_code: number | null;
    reason: string | null;
  }[];
}

export interface Extension {
  id: number;
  pbx_id: string;
  number: string;
  display_name: string;
  tech: "pjsip" | "sccp";
  profile_id: string | null;
  context: string;
  directory_only: number;
  owner_email: string | null;
  created_at: string;
  secret_set: number;
}

export interface AppUser {
  email: string;
  role: "admin" | "user";
  display_name: string;
  min_ext: number | null;
  max_ext: number | null;
  call_log_access: number;
  created_at: string;
}

export interface Profile {
  id: string;
  tech: "pjsip" | "sccp";
  name: string;
  attrs_json: string;
  no_answer_target: string;
  ring_timeout: number;
}

/** What the extension form's profile picker needs, and no more. The attribute
 *  bags are admin-only; picking a profile is not. */
export type ProfileOption = Pick<Profile, "id" | "tech" | "name">;

/** Mirror of PbxSettings in src/render/settings.ts — the renderer's inputs. */
export interface PbxSettings {
  ws: {
    uri: string;
    username: string;
    connection_timeout: number;
    reconnect_interval: number;
    reconnect_attempts: number;
    tls_enabled: boolean;
    ca_list_file?: string;
    ca_list_path?: string;
    verify_server_cert: boolean;
    verify_server_hostname: boolean;
    enable_pingpongs: boolean;
    pingpong_interval: number;
    pingpong_probes: number;
    proxy_host?: string;
  };
  ari: { user: string; app: string; channelvars: string[] };
  dialplan: { context: string; includes: string[] };
  sccp_general: Record<string, string>;
  pjsip_global: Record<string, string>;
  asterisk_config_dir: string;
}

/** button.NNNN grammar; `args` excludes the kind itself. */
export interface SccpButton {
  position: number;
  kind:
    | "line"
    | "speed_dial"
    | "blf"
    | "blf_speed_dial"
    | "feature"
    | "service"
    | "addon"
    | "empty";
  args: string[];
}

export interface SccpDevice {
  id: number;
  pbx_id: string;
  sep_id: string;
  description: string;
  profile_id: string | null;
  softkey_profile: string;
  overrides_json: string;
  created_at: string;
  buttons: SccpButton[];
}

export interface SccpStatic {
  id: number;
  pbx_id: string;
  section_type: "softkey_profile" | "template";
  name: string;
  attrs_json: string;
}

export interface Blocked {
  pbx_id: string;
  number: string;
  reason: string;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  detail: string;
  created_at: string;
}

export interface CallLeg {
  pbx_id: string;
  channel_id: string;
  src: string | null;
  dst: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  disposition: string | null;
  billsec: number | null;
  duration: number | null;
  cause_txt: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * "View as another user", for admins.
 *
 * Held here rather than in `state` because it belongs to every request, not to
 * a component: the server re-resolves authorization from this header, so the
 * screen an admin sees while it is set is genuinely that user's screen and not
 * a rendering of what the frontend guesses they may do.
 *
 * sessionStorage, so it survives a reload (the switch is a reload) but never
 * outlives the tab — an impersonation an admin has forgotten about is the one
 * failure mode worth designing out.
 */
const VIEW_AS_KEY = "aem.view-as";

function storedViewAs(): string | null {
  try {
    return sessionStorage.getItem(VIEW_AS_KEY);
  } catch {
    return null; // storage blocked; impersonation is simply unavailable
  }
}

let viewAs: string | null = storedViewAs();

export const viewingAs = (): string | null => viewAs;

export function setViewAs(email: string | null): void {
  viewAs = email;
  try {
    if (email) sessionStorage.setItem(VIEW_AS_KEY, email);
    else sessionStorage.removeItem(VIEW_AS_KEY);
  } catch {
    /* the in-memory value still applies for this page's lifetime */
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(viewAs ? { "X-Impersonate": viewAs } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body: unknown) =>
  request<T>(p, { method: "POST", body: JSON.stringify(body) });
const put = <T>(p: string, body: unknown) =>
  request<T>(p, { method: "PUT", body: JSON.stringify(body) });
const del = <T>(p: string) => request<T>(p, { method: "DELETE" });

export const api = {
  me: () => get<Identity>("/me"),

  listPbx: () => get<Pbx[]>("/pbx"),
  pbxStatus: (id: string) => get<PbxStatus>(`/pbx/${id}/status`),
  resync: (id: string) =>
    post<{ ok: boolean; error?: string; quarantineReleased: number }>(
      `/admin/pbx/${id}/resync`,
      {},
    ),
  // `prefix` is deliberately absent from both: it reaches no object id, no
  // rendered file and no sweep, so offering it would invite setting a value
  // that does nothing. The server still defaults the column.
  createPbx: (body: { id: string; name: string; sccp_enabled: boolean }) =>
    post<{ id: string; ws_secret: string; ari_secret: string }>(
      "/admin/pbx",
      body,
    ),
  updatePbx: (
    id: string,
    body: { name?: string; sccp_enabled?: boolean },
  ) => put<{ ok: boolean }>(`/admin/pbx/${encodeURIComponent(id)}`, body),
  pbxSettings: (id: string) =>
    get<PbxSettings>(`/admin/pbx/${encodeURIComponent(id)}/settings`),
  savePbxSettings: (id: string, body: PbxSettings) =>
    put<{ ok: boolean }>(`/admin/pbx/${encodeURIComponent(id)}/settings`, body),
  rotatePbxSecrets: (id: string) =>
    put<{ ok: boolean; ws_secret: string; ari_secret: string }>(
      `/admin/pbx/${encodeURIComponent(id)}`,
      { rotate_secrets: true },
    ),
  deletePbx: (id: string, purge: boolean) =>
    del<{
      ok: boolean;
      deleted: { extensions: number; devices: number; calls: number };
      purged: boolean;
      purgeError?: string;
    }>(`/admin/pbx/${encodeURIComponent(id)}${purge ? "?purge=1" : ""}`),
  configBundle: (id: string) =>
    get<{
      pbxId: string;
      fileRev: number;
      signature: string;
      generatedAt: string;
      files: { path: string; content: string }[];
    }>(`/pbx/${id}/config-bundle`),
  releaseQuarantine: (
    id: string,
    cls: string,
    type: string,
    objectId: string,
  ) =>
    del<{ ok: boolean }>(
      `/admin/pbx/${id}/quarantine/${cls}/${type}/${encodeURIComponent(objectId)}`,
    ),

  listExtensions: (pbx?: string) =>
    get<Extension[]>(`/extensions${pbx ? `?pbx=${encodeURIComponent(pbx)}` : ""}`),
  createExtension: (body: Record<string, unknown>) =>
    post<{
      pbx_id: string;
      number: string;
      /** Present only when the server generated one. */
      secret: string | null;
      generated: boolean;
    }>("/extensions", body),
  updateExtension: (pbx: string, number: string, body: Record<string, unknown>) =>
    put<{ ok: boolean; secret?: string }>(`/extensions/${pbx}/${number}`, body),
  deleteExtension: (pbx: string, number: string) =>
    del<{ ok: boolean }>(`/extensions/${pbx}/${number}`),

  listUsers: () => get<AppUser[]>("/admin/users"),
  upsertUser: (body: Record<string, unknown>) =>
    post<{ ok: boolean }>("/admin/users", body),
  deleteUser: (email: string) =>
    del<{ ok: boolean; orphanedExtensions: number }>(
      `/admin/users/${encodeURIComponent(email)}`,
    ),

  /** Every role; feeds the extension form's picker. */
  listProfileOptions: () => get<ProfileOption[]>("/profiles"),
  listProfiles: () => get<Profile[]>("/admin/profiles"),
  upsertProfile: (body: Record<string, unknown>) =>
    post<{ ok: boolean }>("/admin/profiles", body),

  listSccpDevices: (pbx?: string) =>
    get<SccpDevice[]>(
      `/admin/sccp/devices${pbx ? `?pbx=${encodeURIComponent(pbx)}` : ""}`,
    ),
  createSccpDevice: (body: Record<string, unknown>) =>
    post<{ id: number; pbx_id: string; sep_id: string }>(
      "/admin/sccp/devices",
      body,
    ),
  updateSccpDevice: (pbx: string, sepId: string, body: Record<string, unknown>) =>
    put<{ ok: boolean }>(
      `/admin/sccp/devices/${encodeURIComponent(pbx)}/${encodeURIComponent(sepId)}`,
      body,
    ),
  /** Parse one button as chan_sccp2 would, without saving. */
  checkSccpButton: (body: { pbx_id: string; kind: string; args: string[] }) =>
    post<{ ok: boolean; error?: string }>("/admin/sccp/buttons/check", body),
  deleteSccpDevice: (pbx: string, sepId: string) =>
    del<{ ok: boolean }>(
      `/admin/sccp/devices/${encodeURIComponent(pbx)}/${encodeURIComponent(sepId)}`,
    ),

  listSccpStatic: (pbx?: string) =>
    get<SccpStatic[]>(
      `/admin/sccp/static${pbx ? `?pbx=${encodeURIComponent(pbx)}` : ""}`,
    ),
  upsertSccpStatic: (body: Record<string, unknown>) =>
    post<{ ok: boolean }>("/admin/sccp/static", body),
  deleteSccpStatic: (pbx: string, type: string, name: string) =>
    del<{ ok: boolean }>(
      `/admin/sccp/static/${encodeURIComponent(pbx)}/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
    ),

  listBlocked: (pbx?: string) =>
    get<Blocked[]>(`/admin/blocked${pbx ? `?pbx=${encodeURIComponent(pbx)}` : ""}`),
  block: (body: { pbx_id: string; number: string; reason: string }) =>
    post<{ ok: boolean }>("/admin/blocked", body),
  unblock: (pbx: string, number: string) =>
    del<{ ok: boolean }>(`/admin/blocked/${pbx}/${number}`),

  audit: (limit = 100) => get<AuditEntry[]>(`/admin/audit?limit=${limit}`),
  cdr: (pbx?: string, limit = 100) =>
    get<CallLeg[]>(
      `/cdr?limit=${limit}${pbx ? `&pbx=${encodeURIComponent(pbx)}` : ""}`,
    ),
};
