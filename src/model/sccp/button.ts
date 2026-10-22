/**
 * button.NNNN grammar, ported from sccp-rs so a button is judged exactly as
 * chan_sccp2 will judge it at reload.
 *
 * Source of truth: asterisk-module/src/config/parsing/button.rs
 * (`parse_button`, `parse_line_button`), plus `parse_feature` (mod.rs:1818),
 * `parse_addon_type` (mod.rs:1866), `parse_bool` (mod.rs:2948) and
 * `HintTarget::parse` (model.rs:711). The arity rules are exact, not minimums:
 * a `blf` with a fifth field, or an `empty` with any argument, is rejected.
 *
 * Keep this file in sync with sccp-rs.
 */

import { normalizeName } from "./options.js";

const FEATURES = new Set(
  [
    "redial", "lastnumberredial", "hold", "transfer", "forwardall", "cfwdall",
    "forwardbusy", "cfwdbusy", "forwardnoanswer", "cfwdnoanswer", "video",
    "voicemail", "answerrelease", "autoanswer", "select", "feature",
    "maliciouscall", "meetme", "meetmeconference", "conference", "park",
    "callpark", "pickup", "callpickup", "grouppickup", "groupcallpickup",
    "mobility", "dnd", "donotdisturb", "conferencelist", "removelastparticipant",
    "qualityreport", "qualityreporttool", "callback", "otherpickup", "videomode",
    "newcall", "endcall", "huntgrouplogin", "queue", "queuing", "parkinglot",
    "messages", "directory", "application", "headset", "echocancellation",
    "acousticechocancellation",
  ],
);

const ADDON_TYPES = new Set([
  "7914", "cisco7914", "ciscoaddon7914",
  "791512", "cisco791512", "ciscoaddon791512",
  "791524", "cisco791524", "ciscoaddon791524",
  "791612", "cisco791612", "ciscoaddon791612",
  "791624", "cisco791624", "ciscoaddon791624",
  "spa500s", "addonspa500s",
  "spa500ds", "addonspa500ds",
  "spa932ds", "addonspa932ds",
]);

const BOOLS = new Set(["true", "yes", "on", "1", "false", "no", "off", "0"]);

const RING_MODES = new Set(["normal", "silent", "disabled", "off"]);

/** model.rs:711 — `extension@context`, both halves non-empty, one `@`. */
function blfHintProblem(field: string): string | null {
  const at = field.indexOf("@");
  if (at < 0) return `BLF hint "${field}" must be extension@context`;
  const ext = field.slice(0, at).trim();
  const ctx = field.slice(at + 1).trim();
  if (!ext || !ctx || ctx.includes("@")) {
    return `BLF hint "${field}" must be extension@context`;
  }
  return null;
}

/** button.rs `parse_line_button`: `number[, key=value...]`. */
function lineProblem(fields: string[], lines?: ReadonlySet<string>): string | null {
  const number = fields[0]!;
  if (lines && !lines.has(number)) {
    return `line ${number} is not an SCCP extension on this PBX`;
  }
  const seen = new Set<string>();
  for (const option of fields.slice(1)) {
    const eq = option.indexOf("=");
    if (eq < 0) return `"${option}" must be key=value`;
    const key = normalizeName(option.slice(0, eq).trim());
    const value = option.slice(eq + 1).trim();
    if (!key || !value) return `"${option}" must be key=value with both sides set`;
    if (seen.has(key)) return `"${option.slice(0, eq).trim()}" is given more than once`;
    seen.add(key);
    switch (key) {
      case "label":
      case "callername":
      case "callernumber":
      case "subscription":
      case "subscriptionidentity":
        break;
      case "ring":
      case "ringmode":
        if (!RING_MODES.has(normalizeName(value))) {
          return `ring must be normal, silent or disabled (got "${value}")`;
        }
        break;
      case "privacy":
        if (!BOOLS.has(value.toLowerCase())) {
          return `privacy must be yes or no (got "${value}")`;
        }
        break;
      default:
        return (
          `unknown line option "${option.slice(0, eq).trim()}" — expected label, ` +
          "caller_name, caller_number, ring, subscription or privacy"
        );
    }
  }
  return null;
}

/**
 * Why chan_sccp2 would reject this button, or null if it parses.
 *
 * `args` are the fields after the kind. Pass `lines` (the PBX's SCCP line
 * numbers) to also check that a line button names a real line; without it only
 * the syntax is checked.
 */
export function buttonProblem(
  kind: string,
  args: readonly string[],
  lines?: ReadonlySet<string>,
): string | null {
  const fields = [kind, ...args].map((f) => f.trim());
  const n = fields.length;
  // Every field the parser reads is `required_button_field`: blank is invalid.
  const blank = fields.findIndex((f) => f.length === 0);

  switch (normalizeName(kind)) {
    case "line":
      if (n < 2) return "line needs the line number";
      if (blank >= 0) return "fields must not be blank";
      return lineProblem(fields.slice(1), lines);

    case "speeddial":
      if (n !== 3 && n !== 4) return "speed_dial needs label, number[, hint@context]";
      if (blank >= 0) return "fields must not be blank";
      return n === 4 ? blfHintProblem(fields[3]!) : null;

    case "blf":
    case "blfspeeddial":
      if (n !== 4) return `${kind} needs exactly label, number, hint@context`;
      if (blank >= 0) return "fields must not be blank";
      return blfHintProblem(fields[3]!);

    case "feature": {
      if (n < 3) return "feature needs label, feature[, argument]";
      if (!fields[1] || !fields[2]) return "fields must not be blank";
      if (!FEATURES.has(normalizeName(fields[2]))) {
        return `unknown feature "${fields[2]}"`;
      }
      return n > 3 && !fields.slice(3).join(",").trim()
        ? "feature argument must not be blank"
        : null;
    }

    case "service":
      if (n < 3) return "service needs label, url";
      if (!fields[1] || !fields.slice(2).join(",").trim()) {
        return "fields must not be blank";
      }
      return null;

    case "empty":
    case "unused":
      return n === 1 ? null : `${kind} takes no arguments`;

    case "addon":
    case "addonmodule": {
      if (n !== 3) return `${kind} needs exactly slot, type`;
      if (blank >= 0) return "fields must not be blank";
      const slot = Number(fields[1]);
      if (!/^\d+$/.test(fields[1]!) || slot < 1 || slot > 56) {
        return `addon slot must be 1-56 (got "${fields[1]}")`;
      }
      return ADDON_TYPES.has(normalizeName(fields[2]!))
        ? null
        : `unknown addon type "${fields[2]}"`;
    }

    default:
      return `unknown button kind "${kind}"`;
  }
}
