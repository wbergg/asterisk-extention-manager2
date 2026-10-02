import { describe, expect, it } from "vitest";

import {
  validateSccpInventory,
  type SccpObject,
} from "../src/model/sccp/validate.js";
import {
  isRepeatable,
  lookupOption,
  normalizeName,
  splitIndexed,
} from "../src/model/sccp/options.js";

const ctx = { softkeyProfiles: new Set(["default", "receptionist"]) };

function device(
  id: string,
  attrs: Record<string, string>,
): SccpObject {
  return {
    objectType: "device",
    objectId: id,
    attrs: Object.entries(attrs).map(([attribute, value]) => ({
      attribute,
      value,
    })),
  };
}

function line(id: string, attrs: Record<string, string> = {}): SccpObject {
  return {
    objectType: "line",
    objectId: id,
    attrs: Object.entries(attrs).map(([attribute, value]) => ({
      attribute,
      value,
    })),
  };
}

const codesOf = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("option name normalization", () => {
  it("strips non-alphanumerics and lowercases", () => {
    expect(normalizeName("forward_no_answer_timeout")).toBe(
      "forwardnoanswertimeout",
    );
    expect(normalizeName("ForwardNoAnswerTimeout")).toBe(
      "forwardnoanswertimeout",
    );
    expect(normalizeName("cfwd-no.answer")).toBe("cfwdnoanswer");
  });

  it("resolves aliases that normalization alone would not", () => {
    // These differ even after normalization, so the alias table is load-bearing.
    expect(lookupOption("line", "vmnum")?.canonical).toBe("voicemail_number");
    expect(lookupOption("line", "trnsfvm")?.canonical).toBe(
      "voicemail_transfer",
    );
    expect(lookupOption("device", "directrtp")?.canonical).toBe("direct_media");
    expect(lookupOption("device", "earlyrtp")?.canonical).toBe("early_media");
    expect(lookupOption("device", "signalingdscp")?.canonical).toBe("sccp_dscp");
  });

  it("accepts the snake_case and squashed spellings interchangeably", () => {
    expect(lookupOption("line", "call_group")?.canonical).toBe("call_group");
    expect(lookupOption("line", "callgroup")?.canonical).toBe("call_group");
    expect(lookupOption("line", "CallGroup")?.canonical).toBe("call_group");
  });

  it("rejects options belonging to the other object type", () => {
    expect(lookupOption("line", "button")).toBeUndefined();
    expect(lookupOption("device", "regexten")).toBeUndefined();
  });
});

describe("indexed field parsing", () => {
  it("splits base and position", () => {
    expect(splitIndexed("button.0002")).toEqual({
      base: "button",
      position: 2,
    });
    expect(splitIndexed("button")).toBeNull();
    expect(splitIndexed("button.")).toBeNull();
    expect(splitIndexed("button.abc")).toBeNull();
  });

  it("scopes device-only repeatables correctly", () => {
    // deny/permit are repeatable on devices but not on lines.
    expect(isRepeatable("device", "deny")).toBe(true);
    expect(isRepeatable("line", "deny")).toBe(false);
    // setvar/allow/disallow are repeatable on both; template always is.
    expect(isRepeatable("line", "setvar")).toBe(true);
    expect(isRepeatable("line", "template")).toBe(true);
  });
});

describe("validateSccpInventory", () => {
  const goodDevice = () =>
    device("SEP001122334455", {
      description: "Reception",
      softkey_profile: "receptionist",
      "button.0001": "line,1001",
    });

  it("accepts a well-formed device and line", () => {
    const issues = validateSccpInventory([line("1001"), goodDevice()], ctx);
    expect(issues).toEqual([]);
  });

  it("rejects a `type` attribute", () => {
    // Every other sorcery class requires type=; chan_sccp2 rejects it, and
    // only at reload time — so this check has to happen before the push.
    const issues = validateSccpInventory(
      [line("1001"), device("SEP001122334455", {
        type: "device",
        "button.0001": "line,1001",
      })],
      ctx,
    );
    expect(codesOf(issues)).toContain("ExplicitType");
  });

  it("rejects a device id that is not SEP + 12 hex", () => {
    const issues = validateSccpInventory(
      [line("1001"), device("aem-SEP001122334455", { "button.0001": "line,1001" })],
      ctx,
    );
    expect(codesOf(issues)).toContain("InvalidDevice");
  });

  it("rejects a device with no line button", () => {
    const issues = validateSccpInventory(
      [device("SEP001122334455", { description: "Lonely" })],
      ctx,
    );
    expect(codesOf(issues)).toContain("DeviceWithoutLines");
  });

  it("rejects a button referencing a line not in the inventory", () => {
    const issues = validateSccpInventory(
      [device("SEP001122334455", { "button.0001": "line,9999" })],
      ctx,
    );
    expect(codesOf(issues)).toContain("UnknownLine");
  });

  it("rejects an unknown softkey profile", () => {
    const issues = validateSccpInventory(
      [
        line("1001"),
        device("SEP001122334455", {
          softkey_profile: "does-not-exist",
          "button.0001": "line,1001",
        }),
      ],
      ctx,
    );
    expect(codesOf(issues)).toContain("UnknownSoftKeyProfile");
  });

  it("requires a .NNNN suffix on repeatable options", () => {
    const issues = validateSccpInventory([line("1001", { allow: "ulaw" })], ctx);
    expect(codesOf(issues)).toContain("MissingPosition");
  });

  it("forbids a .NNNN suffix on scalar options", () => {
    const issues = validateSccpInventory(
      [line("1001", { "context.0001": "internal" })],
      ctx,
    );
    expect(codesOf(issues)).toContain("IndexedScalar");
  });

  it("rejects duplicate positions for one base", () => {
    const issues = validateSccpInventory(
      [
        line("1001"),
        {
          objectType: "device",
          objectId: "SEP001122334455",
          attrs: [
            { attribute: "button.0001", value: "line,1001" },
            { attribute: "button.0001", value: "speed_dial,Front,2000" },
          ],
        },
      ],
      ctx,
    );
    expect(codesOf(issues)).toContain("DuplicatePosition");
  });

  it("rejects ids reused across device and line", () => {
    // Sorcery and AstDB accept both writes happily; the failure only appears
    // at reload, which is exactly the silent path we are guarding.
    const issues = validateSccpInventory(
      [line("SEP001122334455"), device("SEP001122334455", { "button.0001": "line,SEP001122334455" })],
      ctx,
    );
    expect(codesOf(issues)).toContain("DuplicateObject");
  });

  it("rejects obsolete options", () => {
    const issues = validateSccpInventory(
      [
        line("1001"),
        device("SEP001122334455", {
          dtmfmode: "rfc2833",
          "button.0001": "line,1001",
        }),
      ],
      ctx,
    );
    expect(codesOf(issues)).toContain("ObsoleteOption");
  });

  it("rejects unknown options", () => {
    const issues = validateSccpInventory(
      [line("1001", { nosuchoption: "1" })],
      ctx,
    );
    expect(codesOf(issues)).toContain("UnknownOption");
  });

  it("rejects a field name outside the allowed charset", () => {
    const issues = validateSccpInventory(
      [line("1001", { "bad name": "x" })],
      ctx,
    );
    expect(codesOf(issues)).toContain("InvalidFieldName");
  });

  it("rejects an over-long object id", () => {
    const issues = validateSccpInventory([line("9".repeat(80))], ctx);
    expect(codesOf(issues)).toContain("InvalidObjectId");
  });

  it("accepts an inline line.NNNN shorthand as a line reference", () => {
    const issues = validateSccpInventory(
      [
        line("1001"),
        device("SEP001122334455", { "line.0001": "1001,label=Front" }),
      ],
      ctx,
    );
    expect(issues).toEqual([]);
  });

  it("validates button arity", () => {
    const issues = validateSccpInventory(
      [
        line("1001"),
        {
          objectType: "device",
          objectId: "SEP001122334455",
          attrs: [
            { attribute: "button.0001", value: "line,1001" },
            { attribute: "button.0002", value: "blf,Front" }, // needs 4 fields
          ],
        },
      ],
      ctx,
    );
    expect(codesOf(issues)).toContain("InvalidButton");
  });
});
