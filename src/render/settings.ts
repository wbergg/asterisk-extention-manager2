/**
 * Shape of `pbx.settings_json` — the renderer's inputs.
 *
 * Deliberately owned by the renderer rather than by SQL columns: these are
 * per-site knobs that change shape as the config surface grows, and a JSON
 * blob avoids a migration every time one is added.
 */

export interface WsSettings {
  /** Full wss:// URL including the /pbx/{id} path segment. */
  uri: string;
  /** Basic username. Conventionally the pbx id. */
  username: string;
  connection_timeout: number;
  reconnect_interval: number;
  reconnect_attempts: number;
  tls_enabled: boolean;
  /**
   * CA bundle Asterisk verifies the server against. Unset by default, and
   * there is no safe default to pick: the path is distro-specific
   * (`/etc/ssl/certs/ca-certificates.crt` on Debian, `/etc/pki/tls/cert.pem` on
   * RHEL) and naming one that does not exist fails exactly like naming none.
   *
   * Asterisk does not fall back to the system trust store, so with
   * verification on and neither of these set the connection fails with a bare
   * "Unable to connect" — see the hint rendered into websocket_client.conf.
   */
  ca_list_file?: string;
  /** Directory of hashed CA certificates; alternative to `ca_list_file`. */
  ca_list_path?: string;
  verify_server_cert: boolean;
  verify_server_hostname: boolean;
  enable_pingpongs: boolean;
  pingpong_interval: number;
  pingpong_probes: number;
  proxy_host?: string;
}

export interface AriSettings {
  /** Local ARI user name; referenced by outbound_websocket.local_ari_user. */
  user: string;
  /** Stasis application name. Must be unique per connection on this PBX. */
  app: string;
  /** CDR/channel variables attached to every channel event. */
  channelvars: string[];
}

export interface DialplanSettings {
  /** Context the generated extensions live in. */
  context: string;
  /** Contexts to include from the generated context, in order. */
  includes: string[];
}

export interface PbxSettings {
  ws: WsSettings;
  ari: AriSettings;
  dialplan: DialplanSettings;
  /** Raw [general] key/values for sccp.conf. Unreachable via ARI. */
  sccp_general: Record<string, string>;
  /** Extra pjsip.conf [global]/[system] settings. */
  pjsip_global: Record<string, string>;
  asterisk_config_dir: string;
}

export const DEFAULT_CHANNELVARS = [
  "CDR(billsec)",
  "CDR(duration)",
  "CDR(disposition)",
  "CDR(start)",
  "CDR(answer)",
  "CDR(end)",
  "CDR(src)",
  "CDR(dst)",
  "CDR(linkedid)",
  "HANGUPCAUSE",
];

export function defaultSettings(pbxId: string, host: string): PbxSettings {
  return {
    ws: {
      uri: `wss://${host}/pbx/${pbxId}`,
      username: pbxId,
      connection_timeout: 500,
      reconnect_interval: 2000,
      reconnect_attempts: 5,
      tls_enabled: true,
      verify_server_cert: true,
      verify_server_hostname: true,
      enable_pingpongs: true,
      pingpong_interval: 20,
      pingpong_probes: 3,
    },
    ari: {
      user: "aem_user",
      app: "aem",
      channelvars: [...DEFAULT_CHANNELVARS],
    },
    dialplan: {
      context: "aem-internal",
      includes: [],
    },
    sccp_general: {},
    pjsip_global: {},
    asterisk_config_dir: "/etc/asterisk",
  };
}

export function parseSettings(
  json: string,
  pbxId: string,
  host: string,
): PbxSettings {
  const base = defaultSettings(pbxId, host);
  let parsed: Partial<PbxSettings>;
  try {
    parsed = JSON.parse(json) as Partial<PbxSettings>;
  } catch {
    return base;
  }
  return {
    ws: { ...base.ws, ...parsed.ws },
    ari: { ...base.ari, ...parsed.ari },
    dialplan: { ...base.dialplan, ...parsed.dialplan },
    sccp_general: { ...base.sccp_general, ...parsed.sccp_general },
    pjsip_global: { ...base.pjsip_global, ...parsed.pjsip_global },
    asterisk_config_dir:
      parsed.asterisk_config_dir ?? base.asterisk_config_dir,
  };
}
