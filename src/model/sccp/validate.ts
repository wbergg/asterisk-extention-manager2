/**
 * chan_sccp2 candidate-inventory validation, run in the Worker before anything
 * is pushed.
 *
 * This exists because of a specific failure mode: chan_sccp2 persists an ARI
 * PUT to AstDB and *then* runs a complete reload in an async, void-returning
 * sorcery observer (exports.rs:332-342). If that reload rejects the inventory
 * it only emits `ast_log(Warning, "SCCP Sorcery reconciliation failed after
 * ...")`. The control plane already received 200, the object is persisted, and
 * it now poisons every subsequent reload until deleted.
 *
 * So every check below is one that chan_sccp2 performs at *reload* time, moved
 * forward to before the push. Error names match the Rust variants to make
 * cross-referencing easy.
 */

import {
  BUTTON_KINDS,
  DEVICE_ID_RE,
  FIELD_NAME_CHARSET,
  LIMITS,
  isRepeatable,
  lookupOption,
  normalizeName,
  splitIndexed,
  type SccpObjectType,
} from "./options.js";

export interface SccpObject {
  objectType: SccpObjectType;
  objectId: string;
  attrs: { attribute: string; value: string }[];
}

export interface SccpIssue {
  objectType: SccpObjectType;
  objectId: string;
  field?: string;
  /** Matches the Rust error variant name where one exists. */
  code: string;
  message: string;
}

export interface SccpValidateContext {
  /** softkey_profile names present in the rendered sccp.conf for this PBX. */
  softkeyProfiles: Set<string>;
  /** Section names retained from the static sccp.conf, for collision checks. */
  staticSections?: Set<string>;
}

const byteLen = (s: string) => new TextEncoder().encode(s).length;

/**
 * Validate one object in isolation. Returns the parsed line references it
 * declares, so the caller can do cross-object checks without re-parsing.
 */
function validateObject(
  obj: SccpObject,
  issues: SccpIssue[],
): { lineRefs: string[]; hasLineButton: boolean; softkeyProfile?: string } {
  const push = (code: string, message: string, field?: string) =>
    issues.push({
      objectType: obj.objectType,
      objectId: obj.objectId,
      code,
      message,
      ...(field ? { field } : {}),
    });

  // --- object id ---------------------------------------------------------
  if (obj.objectId.length === 0) {
    push("InvalidObjectId", "object id must not be empty");
  } else if (byteLen(obj.objectId) > LIMITS.MAX_OBJECT_ID_BYTES) {
    push(
      "InvalidObjectId",
      `object id exceeds ${LIMITS.MAX_OBJECT_ID_BYTES} bytes`,
    );
  }
  if (obj.objectType === "device" && !DEVICE_ID_RE.test(obj.objectId)) {
    push(
      "InvalidDevice",
      `device id must be SEP followed by 12 hex digits (got "${obj.objectId}")`,
    );
  }

  // --- field-level -------------------------------------------------------
  if (obj.attrs.length > LIMITS.MAX_OBJECT_FIELDS) {
    push(
      "TooManyFields",
      `${obj.attrs.length} fields exceeds the limit of ${LIMITS.MAX_OBJECT_FIELDS}`,
    );
  }

  let totalBytes = 0;
  const seenPositions = new Map<string, Set<number>>();
  const seenScalars = new Set<string>();
  const lineRefs: string[] = [];
  let hasLineButton = false;
  let softkeyProfile: string | undefined;

  for (const { attribute, value } of obj.attrs) {
    totalBytes += byteLen(attribute) + byteLen(value);

    if (!FIELD_NAME_CHARSET.test(attribute)) {
      push(
        "InvalidFieldName",
        `field name must match [A-Za-z0-9_.-]+ (got "${attribute}")`,
        attribute,
      );
      continue;
    }
    if (byteLen(attribute) > LIMITS.MAX_FIELD_NAME_BYTES) {
      push(
        "InvalidFieldName",
        `field name exceeds ${LIMITS.MAX_FIELD_NAME_BYTES} bytes`,
        attribute,
      );
      continue;
    }
    if (byteLen(value) > LIMITS.MAX_FIELD_VALUE_BYTES) {
      push(
        "InvalidFieldValue",
        `value exceeds ${LIMITS.MAX_FIELD_VALUE_BYTES} bytes`,
        attribute,
      );
    }

    const indexed = splitIndexed(attribute);
    const base = indexed ? indexed.base : attribute;
    const normalized = normalizeName(base);

    // chan_sccp2 is the odd one out: every other sorcery class requires
    // `type=`, this one rejects it — and only at reload time, so the bad
    // object persists and breaks every later reload.
    if (normalized === "type") {
      push(
        "ExplicitType",
        "the `type` field must be omitted; it is implicit in the sorcery object path",
        attribute,
      );
      continue;
    }

    // `template.NNNN` references a (!) template section in sccp.conf rather
    // than a device/line option, so it is not in the option tables.
    const isTemplate = normalized === "template";
    const def = isTemplate ? undefined : lookupOption(obj.objectType, base);

    if (!isTemplate && !def) {
      push(
        "UnknownOption",
        `"${base}" is not a valid ${obj.objectType} option`,
        attribute,
      );
      continue;
    }
    if (def?.obsolete) {
      push(
        "ObsoleteOption",
        `"${base}" is rejected as obsolete${
          normalizeName(base) === "dtmfmode" ? "; use force_dtmf_mode" : ""
        }`,
        attribute,
      );
      continue;
    }

    const canonical = def?.canonical ?? "template";
    const repeatable = isRepeatable(obj.objectType, canonical);

    if (repeatable && !indexed) {
      push(
        "MissingPosition",
        `"${canonical}" is repeatable and requires a .NNNN suffix (e.g. ${canonical}.0001)`,
        attribute,
      );
      continue;
    }
    if (!repeatable && indexed) {
      push(
        "IndexedScalar",
        `"${canonical}" is a scalar option and must not carry a .NNNN suffix`,
        attribute,
      );
      continue;
    }

    if (indexed) {
      // An empty value on an indexed field is a tombstone at PUT time, but an
      // empty indexed value present in the inventory is an error.
      if (value.length === 0) {
        push(
          "EmptyIndexedValue",
          `"${attribute}" has an empty value; to remove it, send the tombstone as a separate PUT`,
          attribute,
        );
      }
      let positions = seenPositions.get(normalized);
      if (!positions) {
        positions = new Set();
        seenPositions.set(normalized, positions);
      }
      if (positions.has(indexed.position)) {
        push(
          "DuplicatePosition",
          `duplicate position ${indexed.position} for "${canonical}"`,
          attribute,
        );
      }
      positions.add(indexed.position);
    } else {
      if (seenScalars.has(normalized)) {
        push("DuplicateField", `"${canonical}" appears more than once`, attribute);
      }
      seenScalars.add(normalized);
    }

    // --- collect cross-object references --------------------------------
    if (obj.objectType === "device") {
      if (normalized === "line") {
        // `line.NNNN = <number>[, key=value...]`
        const target = value.split(",")[0]?.trim();
        if (target) lineRefs.push(target);
        hasLineButton = true;
      } else if (normalized === "button") {
        const parts = value.split(",").map((p) => p.trim());
        const kind = normalizeName(parts[0] ?? "");
        const kindKey = Object.keys(BUTTON_KINDS).find(
          (k) => normalizeName(k) === kind,
        ) as keyof typeof BUTTON_KINDS | undefined;
        if (!kindKey) {
          push(
            "InvalidButton",
            `unknown button kind "${parts[0] ?? ""}"`,
            attribute,
          );
        } else {
          const spec = BUTTON_KINDS[kindKey];
          if (parts.length < spec.minArgs) {
            push(
              "InvalidButton",
              `button kind "${kindKey}" needs at least ${spec.minArgs} comma-separated fields, got ${parts.length}`,
              attribute,
            );
          } else if (kindKey === "line") {
            const target = parts[1];
            if (target) lineRefs.push(target);
            hasLineButton = true;
          }
        }
      } else if (normalized === "softkeyprofile") {
        softkeyProfile = value.trim();
      }
    }
  }

  if (totalBytes > LIMITS.MAX_OBJECT_BYTES) {
    push(
      "ObjectTooLarge",
      `object is ${totalBytes} bytes, over the ${LIMITS.MAX_OBJECT_BYTES} byte limit`,
    );
  }

  return {
    lineRefs,
    hasLineButton,
    ...(softkeyProfile !== undefined ? { softkeyProfile } : {}),
  };
}

/**
 * Validate a complete candidate inventory. Cross-object checks need the whole
 * set, which is exactly why chan_sccp2 does them at reload time — we do the
 * same work earlier, against the desired state, so the push never happens.
 */
export function validateSccpInventory(
  objects: SccpObject[],
  ctx: SccpValidateContext,
): SccpIssue[] {
  const issues: SccpIssue[] = [];

  const lineIds = new Set<string>();
  const deviceIds = new Set<string>();
  // config/sorcery.rs:296-303 — ids must be unique across BOTH types.
  const allIds = new Map<string, SccpObjectType>();

  for (const obj of objects) {
    const prior = allIds.get(obj.objectId);
    if (prior) {
      issues.push({
        objectType: obj.objectType,
        objectId: obj.objectId,
        code: "DuplicateObject",
        message: `id "${obj.objectId}" is already used by a ${prior}; ids must be unique across device and line`,
      });
    } else {
      allIds.set(obj.objectId, obj.objectType);
    }
    if (ctx.staticSections?.has(obj.objectId)) {
      issues.push({
        objectType: obj.objectType,
        objectId: obj.objectId,
        code: "DuplicateSection",
        message: `id "${obj.objectId}" collides with a static section in sccp.conf`,
      });
    }
    (obj.objectType === "line" ? lineIds : deviceIds).add(obj.objectId);
  }

  for (const [type, ids] of [
    ["line", lineIds],
    ["device", deviceIds],
  ] as const) {
    if (ids.size > LIMITS.MAX_SNAPSHOT_OBJECTS) {
      issues.push({
        objectType: type,
        objectId: "*",
        code: "TooManyObjects",
        message: `${ids.size} ${type} objects exceeds the per-type limit of ${LIMITS.MAX_SNAPSHOT_OBJECTS}`,
      });
    }
  }

  for (const obj of objects) {
    const { lineRefs, hasLineButton, softkeyProfile } = validateObject(
      obj,
      issues,
    );

    if (obj.objectType !== "device") continue;

    // config/parsing/device.rs:533-537
    if (!hasLineButton) {
      issues.push({
        objectType: "device",
        objectId: obj.objectId,
        code: "DeviceWithoutLines",
        message: "a device must declare at least one line button",
      });
    }

    for (const ref of lineRefs) {
      if (!lineIds.has(ref)) {
        issues.push({
          objectType: "device",
          objectId: obj.objectId,
          code: "UnknownLine",
          message: `references line "${ref}", which is not in the desired inventory`,
        });
      }
    }

    // config/parsing/device.rs:38-44 — a missing profile is a hard failure,
    // and softkey profiles live only in the rendered sccp.conf.
    const profile = softkeyProfile ?? "default";
    if (!ctx.softkeyProfiles.has(profile)) {
      issues.push({
        objectType: "device",
        objectId: obj.objectId,
        code: "UnknownSoftKeyProfile",
        message: `softkey_profile "${profile}" is not defined in the rendered sccp.conf`,
      });
    }
  }

  return issues;
}
