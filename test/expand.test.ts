import { describe, expect, it } from "vitest";

import {
  expandPjsipExtension,
  expandSccpDevice,
  expandSccpLine,
  sanitizeValue,
  type ExtensionRow,
  type SccpDeviceRow,
} from "../src/model/expand.js";
import { canonicalAttrs, serializeAttrs } from "../src/model/compile.js";
import { pjsipStrays, tuplesMatch } from "../src/do/pbx.js";
import { isSecretTuple, type DesiredTuple } from "../src/types.js";

const baseExt = (over: Partial<ExtensionRow> = {}): ExtensionRow => ({
  id: 7,
  number: "1001",
  display_name: "John Doe",
  tech: "pjsip",
  context: "aem-internal",
  directory_only: 0,
  overrides_json: "{}",
  profile_attrs: {},
  ...over,
});

const attrMap = (attrs: DesiredTuple[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const a of attrs) {
    if (isSecretTuple(a)) continue; // secrets are references, not values
    out[a.attribute] = a.value;
  }
  return out;
};

describe("PJSIP expansion", () => {
  it("produces auth, aor and endpoint sharing one id", () => {
    const objs = expandPjsipExtension(baseExt());
    expect(objs.map((o) => o.objectType)).toEqual(["auth", "aor", "endpoint"]);
    expect(new Set(objs.map((o) => o.objectId))).toEqual(new Set(["1001"]));
  });

  it("orders by dependency: auth before aor before endpoint", () => {
    const objs = expandPjsipExtension(baseExt());
    const ranks = objs.map((o) => o.depRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks[0]).toBeLessThan(ranks[2]!);
  });

  it("sets type on every object (PJSIP requires it)", () => {
    const objs = expandPjsipExtension(baseExt());
    for (const o of objs) {
      expect(attrMap(o.attrs)["type"]).toBe(o.objectType);
    }
  });

  it("carries the password as a secret reference, never plaintext", () => {
    const auth = expandPjsipExtension(baseExt())[0]!;
    const pw = auth.attrs.find((a) => a.attribute === "password")!;
    expect(isSecretTuple(pw)).toBe(true);
    // The tuple carries only a reference; nothing resembling a secret value
    // is serialized into object_version.
    expect(pw).toEqual({ attribute: "password", secret_ref: 7 });
    expect(Object.keys(pw)).not.toContain("value");
  });

  it("links endpoint to its own auth and aor regardless of profile", () => {
    const objs = expandPjsipExtension(
      baseExt({
        profile_attrs: { endpoint: { auth: "wrong", aors: "wrong", context: "p" } },
      }),
    );
    const ep = attrMap(objs[2]!.attrs);
    expect(ep["auth"]).toBe("1001");
    expect(ep["aors"]).toBe("1001");
    // The expansion owns linkage, but the extension's own context still wins.
    expect(ep["context"]).toBe("aem-internal");
  });

  it("layers profile then override", () => {
    const objs = expandPjsipExtension(
      baseExt({
        profile_attrs: { endpoint: { allow: "ulaw", direct_media: "no" } },
        overrides_json: JSON.stringify({ endpoint: { allow: "g722,alaw" } }),
      }),
    );
    const ep = attrMap(objs[2]!.attrs);
    expect(ep["allow"]).toBe("g722,alaw");
    expect(ep["direct_media"]).toBe("no");
  });

  it("treats an empty override as removal", () => {
    const objs = expandPjsipExtension(
      baseExt({
        profile_attrs: { endpoint: { direct_media: "no" } },
        overrides_json: JSON.stringify({ endpoint: { direct_media: "" } }),
      }),
    );
    expect(attrMap(objs[2]!.attrs)).not.toHaveProperty("direct_media");
  });

  it("formats callerid and falls back to the number when unnamed", () => {
    expect(attrMap(expandPjsipExtension(baseExt())[2]!.attrs)["callerid"])
      .toBe("John Doe <1001>");
    expect(
      attrMap(
        expandPjsipExtension(baseExt({ display_name: "" }))[2]!.attrs,
      )["callerid"],
    ).toBe("1001 <1001>");
  });

  it("expands nothing for a directory-only entry", () => {
    expect(expandPjsipExtension(baseExt({ directory_only: 1 }))).toEqual([]);
  });

  it("names every object by the bare number, carrying no prefix", () => {
    // PJSIP identifies an endpoint by matching the incoming username against
    // the endpoint *id* — `identify_by=username` on the From header and
    // `identify_by=auth_username` on the Authorization header both compare
    // against the id, not against the auth object's `username` field. A phone
    // registering as 1001 therefore only ever resolves an endpoint literally
    // named `1001`, so any prefix makes it unreachable without reconfiguring
    // the handset. Ownership lives in the DO's mirror instead.
    for (const o of expandPjsipExtension(baseExt())) {
      expect(o.objectId).toBe("1001");
    }
  });

  it("keeps disallow ahead of allow, which the push order depends on", () => {
    // The two handlers mutate one shared codec list, so `disallow=all` applied
    // after `allow=...` empties it — and res_pjsip then refuses to materialize
    // the endpoint at all, leaving it in AstDB but invisible to
    // `pjsip show endpoint`. Sorted alphabetically, `allow` would land first.
    const objs = expandPjsipExtension(
      baseExt({
        profile_attrs: {
          endpoint: { disallow: "all", allow: "ulaw,alaw,g722" },
        },
      }),
    );
    const names = objs[2]!.attrs.map((a) => a.attribute);
    expect(names.indexOf("disallow")).toBeLessThan(names.indexOf("allow"));
  });
});

describe("SCCP expansion", () => {
  it("names the line by the bare number, with no prefix and no type", () => {
    const objs = expandSccpLine(baseExt({ tech: "sccp" }));
    expect(objs).toHaveLength(1);
    expect(objs[0]!.objectId).toBe("1001");
    // chan_sccp2 rejects `type`, unlike every other sorcery class.
    expect(attrMap(objs[0]!.attrs)).not.toHaveProperty("type");
  });

  it("quotes the caller name, matching SCCP's callerid grammar", () => {
    const objs = expandSccpLine(baseExt({ tech: "sccp" }));
    expect(attrMap(objs[0]!.attrs)["callerid"]).toBe('"John Doe" <1001>');
  });

  const device = (over: Partial<SccpDeviceRow> = {}): SccpDeviceRow => ({
    id: 1,
    sep_id: "SEP001122334455",
    description: "Reception",
    softkey_profile: "default",
    overrides_json: "{}",
    profile_attrs: {},
    buttons: [{ position: 1, kind: "line", args: ["1001"] }],
    ...over,
  });

  it("emits zero-padded button.NNNN entries in position order", () => {
    const obj = expandSccpDevice(
      device({
        buttons: [
          { position: 3, kind: "speed_dial", args: ["Front", "2000"] },
          { position: 1, kind: "line", args: ["1001"] },
        ],
      }),
    );
    const names = obj.attrs.map((a) => a.attribute).filter((n) => n.startsWith("button."));
    expect(names).toEqual(["button.0001", "button.0003"]);
    expect(attrMap(obj.attrs)["button.0001"]).toBe("line,1001");
    expect(attrMap(obj.attrs)["button.0003"]).toBe("speed_dial,Front,2000");
  });

  it("ranks lines before devices so a device never precedes its line", () => {
    const line = expandSccpLine(baseExt({ tech: "sccp" }))[0]!;
    expect(line.depRank).toBeLessThan(expandSccpDevice(device()).depRank);
  });

  it("does not emit type on the device either", () => {
    expect(attrMap(expandSccpDevice(device()).attrs)).not.toHaveProperty("type");
  });
});

describe("value sanitization", () => {
  it("strips newlines that would corrupt a config value", () => {
    // v1 interpolated caller IDs into pjsip.conf with no escaping at all.
    expect(sanitizeValue("Evil\nName")).toBe("Evil Name");
    expect(sanitizeValue("  padded  ")).toBe("padded");
  });

  it("keeps a newline out of a generated callerid", () => {
    const objs = expandPjsipExtension(
      baseExt({ display_name: "Bad\nActor" }),
    );
    expect(attrMap(objs[2]!.attrs)["callerid"]).not.toContain("\n");
  });
});

describe("change detection", () => {
  it("canonicalAttrs is order-independent", () => {
    const a = canonicalAttrs([
      { attribute: "b", value: "2" },
      { attribute: "a", value: "1" },
    ]);
    const b = canonicalAttrs([
      { attribute: "a", value: "1" },
      { attribute: "b", value: "2" },
    ]);
    expect(a).toBe(b);
  });

  it("canonicalAttrs still notices a value change", () => {
    expect(canonicalAttrs([{ attribute: "a", value: "1" }])).not.toBe(
      canonicalAttrs([{ attribute: "a", value: "2" }]),
    );
  });

  it("serializeAttrs preserves order where canonicalAttrs discards it", () => {
    // The split exists because the stored form is the pushed form. Sorting for
    // comparison is right; sorting what gets pushed reordered disallow/allow
    // and silently stripped every endpoint's codecs.
    const ordered: DesiredTuple[] = [
      { attribute: "disallow", value: "all" },
      { attribute: "allow", value: "ulaw" },
    ];
    const reversed = [...ordered].reverse();

    expect(canonicalAttrs(ordered)).toBe(canonicalAttrs(reversed));
    expect(serializeAttrs(ordered)).not.toBe(serializeAttrs(reversed));
    expect(
      (JSON.parse(serializeAttrs(ordered)) as DesiredTuple[]).map(
        (a) => a.attribute,
      ),
    ).toEqual(["disallow", "allow"]);
  });

  it("re-expanding identical input yields an identical fingerprint", () => {
    // This is what makes a resync with no changes apply zero ops.
    const one = expandPjsipExtension(baseExt());
    const two = expandPjsipExtension(baseExt());
    expect(one.map((o) => canonicalAttrs(o.attrs))).toEqual(
      two.map((o) => canonicalAttrs(o.attrs)),
    );
  });
});

describe("pjsipStrays", () => {
  const ep = (object_id: string) => ({
    config_class: "res_pjsip",
    object_type: "endpoint",
    object_id,
  });

  it("deletes only what this PBX previously pushed and no longer wants", () => {
    const out = pjsipStrays([ep("1001")], [ep("1001"), ep("1002")], new Set());
    expect(out.deletable).toEqual(["1002"]);
    expect(out.protected).toEqual([]);
  });

  it("never touches an id absent from the mirror", () => {
    // With bare ids there is no naming rule separating a managed extension from
    // a trunk, so "we wrote it once" is the entire ownership claim. A trunk the
    // reconciler has never written is invisible to the sweep.
    const out = pjsipStrays([], [], new Set());
    expect(out.deletable).toEqual([]);
  });

  it("refuses a file-layer id even when the mirror names it", () => {
    const out = pjsipStrays(
      [],
      [ep("minisrv-trunk"), ep("1002")],
      new Set(["minisrv-trunk"]),
    );
    expect(out.deletable).toEqual(["1002"]);
    expect(out.protected).toEqual(["minisrv-trunk"]);
  });

  it("ignores non-endpoint and non-PJSIP mirror rows", () => {
    // One stray endpoint id already implies its sibling aor and auth, so
    // counting those separately would delete each object three times.
    const out = pjsipStrays(
      [],
      [
        { config_class: "res_pjsip", object_type: "aor", object_id: "1002" },
        { config_class: "res_pjsip", object_type: "auth", object_id: "1002" },
        { config_class: "chan_sccp2", object_type: "line", object_id: "2001" },
        ep("1002"),
      ],
      new Set(),
    );
    expect(out.deletable).toEqual(["1002"]);
  });
});

describe("tuplesMatch", () => {
  it("ignores attributes present on the PBX but not desired", () => {
    // A GET returns the full flattened object including defaults, while
    // desired state is a subset, so extra actual attributes are not drift.
    expect(
      tuplesMatch(
        [{ attribute: "context", value: "internal" }],
        [
          { attribute: "context", value: "internal" },
          { attribute: "tos_audio", value: "0" },
        ],
      ),
    ).toBe(true);
  });

  it("detects a changed value", () => {
    expect(
      tuplesMatch(
        [{ attribute: "context", value: "internal" }],
        [{ attribute: "context", value: "other" }],
      ),
    ).toBe(false);
  });

  it("detects a missing attribute", () => {
    expect(tuplesMatch([{ attribute: "allow", value: "ulaw" }], [])).toBe(false);
  });

  it("compares attribute names case-insensitively", () => {
    expect(
      tuplesMatch(
        [{ attribute: "Context", value: "internal" }],
        [{ attribute: "context", value: "internal" }],
      ),
    ).toBe(true);
  });
});
