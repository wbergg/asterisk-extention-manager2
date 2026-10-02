import type { PbxController } from "./do/pbx.js";

export interface Env {
  DB: D1Database;
  PBX: DurableObjectNamespace<PbxController>;
  ASSETS: Fetcher;

  /** base64 32-byte AES-GCM key; encrypts extension secrets at rest in D1. */
  SECRET_KEY: string;
  /** base64 32-byte HMAC key; signs rendered config bundles. */
  BUNDLE_KEY: string;

  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
  DEV_AUTH_BYPASS: string;
  DEV_ADMIN_EMAIL: string;
}

export type Tech = "pjsip" | "sccp";

/** Sorcery module namespace, used verbatim as the ARI configClass. */
export type ConfigClass =
  | "res_pjsip"
  | "res_pjsip_endpoint_identifier_ip"
  | "res_pjsip_outbound_registration"
  | "chan_sccp2";

export type ObjectType =
  // res_pjsip
  | "endpoint"
  | "aor"
  | "auth"
  // chan_sccp2
  | "device"
  | "line";

/** One ARI ConfigTuple. */
export interface ConfigTuple {
  attribute: string;
  value: string;
}

/**
 * A desired attribute whose value is a secret. Stored in D1 in this form so
 * plaintext credentials never land in object_version; the Durable Object
 * resolves and decrypts it immediately before the push.
 */
export interface SecretTuple {
  attribute: string;
  secret_ref: number; // extension.id
}

export type DesiredTuple = ConfigTuple | SecretTuple;

export function isSecretTuple(t: DesiredTuple): t is SecretTuple {
  return "secret_ref" in t;
}

/** A single sorcery object in the desired state. */
export interface DesiredObject {
  configClass: ConfigClass;
  objectType: ObjectType;
  objectId: string;
  attrs: DesiredTuple[];
  /**
   * Dependency rank. Applied ascending on create/update and descending on
   * delete. auth(10) -> aor(20) -> endpoint(30); line(10) -> device(20).
   */
  depRank: number;
}

export type ReconcileState =
  | "never_connected"
  | "connecting"
  | "blocked"
  | "syncing"
  | "converged"
  | "degraded";

export interface OpRow {
  seq: number;
  pbx_id: string;
  op: "upsert" | "delete";
  config_class: ConfigClass;
  object_type: ObjectType;
  object_id: string;
}
