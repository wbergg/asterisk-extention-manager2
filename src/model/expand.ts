/**
 * Compile the product model (extensions, devices, profiles) down to concrete
 * sorcery objects.
 *
 * This is where the "extension is the unit" decision is enforced: an operator
 * never creates an endpoint without its auth and aor, because all three fall
 * out of one expansion and share one id. That shared id is also what makes
 * stray detection work — ARI cannot enumerate sorcery objects, so the only
 * discoverable thing is the endpoint list, and a stray endpoint id tells us
 * exactly which sibling aor and auth to delete alongside it.
 */

import type {
  ConfigClass,
  DesiredObject,
  DesiredTuple,
  ObjectType,
} from "../types.js";

/** Dependency ranks. Ascending on create/update, descending on delete. */
export const DEP_RANK: Record<string, number> = {
  auth: 10,
  aor: 20,
  endpoint: 30,
  line: 10,
  device: 20,
};

export interface ProfileAttrs {
  endpoint?: Record<string, string>;
  aor?: Record<string, string>;
  auth?: Record<string, string>;
  device?: Record<string, string>;
  line?: Record<string, string>;
}

export interface ExtensionRow {
  id: number;
  number: string;
  display_name: string;
  tech: "pjsip" | "sccp";
  context: string;
  directory_only: number;
  overrides_json: string;
  profile_attrs: ProfileAttrs;
}

export interface SccpDeviceRow {
  id: number;
  sep_id: string;
  description: string;
  softkey_profile: string;
  overrides_json: string;
  profile_attrs: ProfileAttrs;
  buttons: { position: number; kind: string; args: string[] }[];
}

/**
 * Strip characters that would corrupt a config value. v1 interpolated caller
 * IDs into pjsip.conf with no escaping at all, so a name containing a newline
 * or a semicolon silently broke the file.
 */
export function sanitizeValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

function tuples(
  base: Record<string, string> | undefined,
  ...overlays: (Record<string, string> | undefined)[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const src of [base, ...overlays]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      // An explicitly empty override removes the attribute entirely rather
      // than pushing an empty string, which several PJSIP options reject.
      if (v === "") out.delete(k);
      else out.set(k, sanitizeValue(v));
    }
  }
  return out;
}

function toTuples(m: Map<string, string>): DesiredTuple[] {
  return [...m.entries()].map(([attribute, value]) => ({ attribute, value }));
}

function parseOverrides(json: string): ProfileAttrs {
  try {
    return JSON.parse(json) as ProfileAttrs;
  } catch {
    return {};
  }
}

/**
 * Expand one PJSIP extension into auth + aor + endpoint.
 *
 * The object id is the bare extension number, shared by all three objects.
 *
 * It cannot carry an ownership prefix, because PJSIP identifies an endpoint by
 * matching the incoming username against the endpoint *id*: both
 * `identify_by=username` (From header) and `identify_by=auth_username`
 * (Authorization header) compare against the id, not against the auth object's
 * `username` field. A phone registering as 1001 therefore only ever resolves an
 * endpoint literally named `1001`, and a prefixed id is unreachable without
 * reconfiguring every handset. Ownership is tracked through the DO's mirror
 * instead — see `deletePjsipStrays`, and `expandSccpLine` for the same model.
 *
 * Note `type` IS required here — the opposite of chan_sccp2, which rejects it.
 */
export function expandPjsipExtension(ext: ExtensionRow): DesiredObject[] {
  if (ext.directory_only) return [];

  const id = ext.number;
  const ov = parseOverrides(ext.overrides_json);
  const callerName = sanitizeValue(ext.display_name || ext.number);

  const auth = tuples(
    { type: "auth", auth_type: "userpass", username: ext.number },
    ext.profile_attrs.auth,
    ov.auth,
  );
  const aor = tuples(
    { type: "aor", max_contacts: "1", remove_existing: "yes" },
    ext.profile_attrs.aor,
    ov.aor,
  );
  const endpoint = tuples(
    { type: "endpoint" },
    ext.profile_attrs.endpoint,
    ov.endpoint,
    {
      // Derived fields win over the profile: the expansion owns the linkage.
      auth: id,
      aors: id,
      callerid: `${callerName} <${ext.number}>`,
      context: ext.context,
    },
  );

  const mk = (
    objectType: ObjectType,
    attrs: DesiredTuple[],
  ): DesiredObject => ({
    configClass: "res_pjsip" as ConfigClass,
    objectType,
    objectId: id,
    attrs,
    depRank: DEP_RANK[objectType]!,
  });

  return [
    // The password never appears in D1's object_version; the DO resolves and
    // decrypts secret_ref immediately before the push.
    mk("auth", [...toTuples(auth), { attribute: "password", secret_ref: ext.id }]),
    mk("aor", toTuples(aor)),
    mk("endpoint", toTuples(endpoint)),
  ];
}

/**
 * Expand one SCCP extension into a `line` object.
 *
 * Line ids are the bare extension number, for the same reason PJSIP ids are:
 * ownership is "D1's desired set is the owned set", tracked through the mirror
 * rather than encoded in the id.
 * `type` is deliberately absent: chan_sccp2 rejects it (config/sorcery.rs:332).
 */
export function expandSccpLine(ext: ExtensionRow): DesiredObject[] {
  if (ext.directory_only) return [];

  const ov = parseOverrides(ext.overrides_json);
  const callerName = sanitizeValue(ext.display_name || ext.number);

  const line = tuples(
    { label: ext.number },
    ext.profile_attrs.line,
    ov.line,
    {
      callerid: `"${callerName}" <${ext.number}>`,
      context: ext.context,
    },
  );

  return [
    {
      configClass: "chan_sccp2",
      objectType: "line",
      objectId: ext.number,
      attrs: toTuples(line),
      depRank: DEP_RANK["line"]!,
    },
  ];
}

/** Expand one SCCP device, including its repeatable button.NNNN entries. */
export function expandSccpDevice(dev: SccpDeviceRow): DesiredObject {
  const ov = parseOverrides(dev.overrides_json);

  const attrs = tuples(
    { description: dev.description || dev.sep_id },
    dev.profile_attrs.device,
    ov.device,
    { softkey_profile: dev.softkey_profile },
  );

  const out: DesiredTuple[] = toTuples(attrs);

  // Repeatable options need a zero-padded .NNNN suffix; ordering of
  // interleaved entries is driven purely by that index.
  for (const btn of [...dev.buttons].sort((a, b) => a.position - b.position)) {
    const suffix = String(btn.position).padStart(4, "0");
    const value = [btn.kind, ...btn.args].map(sanitizeValue).join(",");
    out.push({ attribute: `button.${suffix}`, value });
  }

  return {
    configClass: "chan_sccp2",
    objectType: "device",
    objectId: dev.sep_id,
    attrs: out,
    depRank: DEP_RANK["device"]!,
  };
}

export function expandExtension(ext: ExtensionRow): DesiredObject[] {
  return ext.tech === "pjsip"
    ? expandPjsipExtension(ext)
    : expandSccpLine(ext);
}
