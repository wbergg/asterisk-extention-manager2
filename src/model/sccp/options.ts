/**
 * chan_sccp2 option schema, ported from sccp-rs.
 *
 * Source of truth: asterisk-module/src/config/mod.rs — `LineOption` (:449-511)
 * and `DeviceOption` (:515-656). Both enums are `#[serde(rename_all =
 * "snake_case")]` with explicit `rename`/`alias` attributes, and names are
 * matched case-insensitively *after* `normalize_name` (:1907-1912), which
 * strips every non-alphanumeric character and lowercases the rest.
 *
 * That normalization makes many of the Rust aliases redundant (`call_group`
 * and `callgroup` both normalize to `callgroup`), but not all of them —
 * `vmnum` and `voicemail_number` genuinely differ. So aliases are listed here
 * in full and the lookup table is built over normalized forms.
 *
 * Keep this file in sync with sccp-rs. The Worker validates against it so a
 * malformed object is rejected before it reaches the PBX, where a failed
 * reconcile is currently only a log line.
 */

/** config/mod.rs:1907-1912 */
export function normalizeName(name: string): string {
  let out = "";
  for (const ch of name) {
    if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/** Hard limits enforced by object_validate / field_apply. */
export const LIMITS = {
  /** native/sorcery.rs:32 */
  MAX_FIELD_NAME_BYTES: 127,
  /** native/sorcery.rs:33 */
  MAX_OBJECT_ID_BYTES: 79,
  /** native/sorcery/object.rs:17 */
  MAX_FIELD_VALUE_BYTES: 4096,
  /** native/sorcery/object.rs:16 */
  MAX_OBJECT_FIELDS: 256,
  /** native/sorcery/object.rs:18 */
  MAX_OBJECT_BYTES: 64 * 1024,
  /** native/sorcery.rs:36 */
  MAX_SNAPSHOT_OBJECTS: 4096,
} as const;

/** native/sorcery/object.rs:200-207 */
export const FIELD_NAME_CHARSET = /^[A-Za-z0-9_.-]+$/;

/** config/parsing/device.rs:10-11 */
export const DEVICE_ID_RE = /^SEP[0-9A-Fa-f]{12}$/;

interface OptionDef {
  /** The name written to sorcery. */
  canonical: string;
  aliases?: string[];
  /** Rejected outright by the parser; sending it poisons the inventory. */
  obsolete?: boolean;
}

/** config/mod.rs:449-511 */
const LINE_OPTIONS: OptionDef[] = [
  { canonical: "label" },
  { canonical: "context" },
  { canonical: "callerid" },
  { canonical: "incoming_limit", aliases: ["incominglimit"] },
  { canonical: "language" },
  { canonical: "accountcode" },
  { canonical: "setvar" },
  { canonical: "mailbox" },
  { canonical: "voicemail_number", aliases: ["vmnum", "voicemailnumber"] },
  {
    canonical: "voicemail_transfer",
    aliases: ["trnsfvm", "voicemailtransfer", "transfertovoicemail"],
  },
  { canonical: "call_group", aliases: ["callgroup"] },
  { canonical: "pickup_group", aliases: ["pickupgroup"] },
  { canonical: "named_call_group", aliases: ["namedcallgroup"] },
  { canonical: "named_pickup_group", aliases: ["namedpickupgroup"] },
  { canonical: "directed_pickup", aliases: ["directedpickup"] },
  { canonical: "directed_pickup_context", aliases: ["directedpickupcontext"] },
  {
    canonical: "pickup_mode_answer",
    aliases: ["pickupmodeanswer", "directedpickupmodeanswer"],
  },
  { canonical: "parkinglot" },
  { canonical: "meetme" },
  { canonical: "meetmenum" },
  { canonical: "meetmeopts" },
  { canonical: "adhoc_number", aliases: ["adhocnumber"] },
  { canonical: "initial_dialtone_tone" },
  { canonical: "secondary_dialtone_digits" },
  { canonical: "secondary_dialtone_tone" },
  { canonical: "pin" },
  { canonical: "regexten" },
  { canonical: "allow" },
  { canonical: "disallow" },
  { canonical: "video_mode", aliases: ["videomode"] },
  { canonical: "audio_encryption", aliases: ["audioencryption"] },
  { canonical: "echocancel" },
  { canonical: "silencesuppression" },
];

/** config/mod.rs:515-656 */
const DEVICE_OPTIONS: OptionDef[] = [
  { canonical: "description" },
  { canonical: "softkey_profile", aliases: ["softkeyprofile"] },
  { canonical: "cfwdall", aliases: ["forwardallenabled", "forward_all_enabled"] },
  { canonical: "cfwdbusy", aliases: ["forwardbusyenabled", "forward_busy_enabled"] },
  {
    canonical: "cfwdnoanswer",
    aliases: ["forwardnoanswerenabled", "forward_no_answer_enabled"],
  },
  {
    canonical: "forward_no_answer_timeout",
    aliases: ["cfwdnoanswertimeout", "forwardnoanswertimeout"],
  },
  { canonical: "forward_all" },
  { canonical: "forward_busy" },
  { canonical: "forward_no_answer" },
  { canonical: "dnd_feature", aliases: ["dndfeature"] },
  { canonical: "dnd" },
  { canonical: "privacy_feature", aliases: ["private", "privacyfeature"] },
  { canonical: "privacy" },
  { canonical: "feature_default", aliases: ["featuredefault"] },
  { canonical: "setvar" },
  { canonical: "park" },
  { canonical: "conf_allow", aliases: ["confallow", "conference_allow"] },
  {
    canonical: "conf_music_on_hold_class",
    aliases: ["confmusiconholdclass", "conference_music_on_hold_class"],
  },
  { canonical: "conf_play_general_announce" },
  { canonical: "conf_play_part_announce" },
  { canonical: "conf_mute_on_entry" },
  { canonical: "conf_show_conflist" },
  { canonical: "meetme" },
  { canonical: "meetmeopts" },
  { canonical: "use_redial_menu", aliases: ["useredialmenu"] },
  { canonical: "allow_ringin_notification", aliases: ["allowringinnotification"] },
  { canonical: "mwi_lamp", aliases: ["mwilamp"] },
  { canonical: "mwi_on_call", aliases: ["mwioncall"] },
  { canonical: "phone_code_page", aliases: ["phonecodepage"] },
  { canonical: "allow_overlap", aliases: ["allowoverlap"] },
  { canonical: "force_dtmf_mode", aliases: ["forcedtmfmode", "force_dtmfmode"] },
  { canonical: "direct_media", aliases: ["directrtp"] },
  { canonical: "early_media", aliases: ["earlyrtp"] },
  { canonical: "audio_encryption", aliases: ["audioencryption"] },
  { canonical: "deny" },
  { canonical: "permit" },
  { canonical: "permit_host", aliases: ["permithost"] },
  { canonical: "nat" },
  {
    canonical: "transport",
    aliases: ["transportrequirement", "transport_requirement"],
  },
  { canonical: "sccp_tos", aliases: ["signalingtos"] },
  {
    canonical: "sccp_dscp",
    aliases: ["sccpdscp", "signalingdscp", "signaling_dscp"],
  },
  { canonical: "sccp_cos", aliases: ["signalingcos", "signaling_cos"] },
  { canonical: "audio_tos", aliases: ["audiotos"] },
  { canonical: "audio_dscp", aliases: ["audiodscp"] },
  { canonical: "audio_cos", aliases: ["audiocos"] },
  { canonical: "video_tos", aliases: ["videotos"] },
  { canonical: "video_dscp", aliases: ["videodscp"] },
  { canonical: "video_cos", aliases: ["videocos"] },
  { canonical: "allow" },
  { canonical: "disallow" },
  { canonical: "line" },
  { canonical: "button" },
  // config/parsing/device.rs:475-486 — both are hard-rejected as obsolete.
  { canonical: "trust_phone_ip", aliases: ["trustphoneip"], obsolete: true },
  { canonical: "dtmfmode", obsolete: true },
];

function buildLookup(defs: OptionDef[]): Map<string, OptionDef> {
  const map = new Map<string, OptionDef>();
  for (const def of defs) {
    map.set(normalizeName(def.canonical), def);
    for (const alias of def.aliases ?? []) {
      map.set(normalizeName(alias), def);
    }
  }
  return map;
}

export const LINE_LOOKUP = buildLookup(LINE_OPTIONS);
export const DEVICE_LOOKUP = buildLookup(DEVICE_OPTIONS);

export type SccpObjectType = "device" | "line";

export function lookupOption(
  kind: SccpObjectType,
  name: string,
): OptionDef | undefined {
  return (kind === "device" ? DEVICE_LOOKUP : LINE_LOOKUP).get(
    normalizeName(name),
  );
}

/**
 * Repeatable options require a `.NNNN` positional suffix; scalars must not
 * have one. config/sorcery.rs:310-421 — note `deny`/`permit`/`permit_host`/
 * `feature_default`/`line`/`button` are repeatable on devices only, and
 * `template` is repeatable on both.
 */
export function isRepeatable(kind: SccpObjectType, canonical: string): boolean {
  const n = normalizeName(canonical);
  if (n === "template") return true;
  if (n === "setvar" || n === "allow" || n === "disallow") return true;
  if (kind === "device") {
    return (
      n === "deny" ||
      n === "permit" ||
      n === "permithost" ||
      n === "featuredefault" ||
      n === "line" ||
      n === "button"
    );
  }
  return false;
}

/** Split "button.0002" into base + position. */
export function splitIndexed(
  field: string,
): { base: string; position: number } | null {
  const dot = field.indexOf(".");
  if (dot < 0) return null;
  const suffix = field.slice(dot + 1);
  if (suffix.length === 0 || !/^[0-9]+$/.test(suffix)) return null;
  return { base: field.slice(0, dot), position: Number(suffix) };
}

/** button.NNNN grammar — config/parsing/button.rs:72-191. */
export const BUTTON_KINDS = {
  line: { minArgs: 2 },
  speed_dial: { minArgs: 3 },
  blf: { minArgs: 4 },
  blf_speed_dial: { minArgs: 4 },
  feature: { minArgs: 3 },
  service: { minArgs: 3 },
  addon: { minArgs: 3 },
  addon_module: { minArgs: 3 },
  empty: { minArgs: 1 },
  unused: { minArgs: 1 },
} as const;
