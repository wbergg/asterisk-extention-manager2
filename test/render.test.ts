import { describe, expect, it } from "vitest";

import {
  renderAriConf,
  renderCdrConf,
  renderExtensionsConf,
  renderMusicOnHoldConf,
  renderPjsipConf,
  renderQueuesConf,
  renderSccpConf,
  renderSorceryConf,
  renderWebsocketClientConf,
} from "../src/render/files.js";
import { defaultSettings } from "../src/render/settings.js";

const S = defaultSettings("site42", "cp.example.net");
const REV = 37;

describe("websocket_client.conf", () => {
  const { content } = renderWebsocketClientConf(S, REV, "hunter2");

  it("uses a persistent connection so Asterisk retries forever", () => {
    // For persistent connections reconnect_attempts only controls log noise;
    // the connection itself self-heals indefinitely.
    expect(content).toContain("connection_type = persistent");
  });

  it("declares the ari subprotocol and the site URL", () => {
    expect(content).toContain("protocols = ari");
    expect(content).toContain("uri = wss://cp.example.net/pbx/site42");
  });

  it("carries the credentials Asterisk presents on the upgrade", () => {
    expect(content).toContain("username = site42");
    expect(content).toContain("password = hunter2");
  });

  // Asterisk does not fall back to the system trust store: verification with
  // no CA bundle fails as a bare "Unable to connect", which cost an afternoon
  // to diagnose once. There is no safe default path to emit, so the renderer
  // warns in-file instead — but only when the combination is actually broken.
  it("warns when verification is on but no CA bundle is set", () => {
    expect(content).toContain("no CA bundle is set");
    expect(content).not.toContain("ca_list_file =");
  });

  it("emits the CA bundle and drops the warning once one is configured", () => {
    const withCa = renderWebsocketClientConf(
      { ...S, ws: { ...S.ws, ca_list_file: "/etc/ssl/certs/ca-certificates.crt" } },
      REV,
      "hunter2",
    ).content;
    expect(withCa).toContain("ca_list_file = /etc/ssl/certs/ca-certificates.crt");
    expect(withCa).not.toContain("no CA bundle is set");
  });

  it("omits the warning when verification is off", () => {
    const noVerify = renderWebsocketClientConf(
      { ...S, ws: { ...S.ws, verify_server_cert: false } },
      REV,
      "hunter2",
    ).content;
    expect(noVerify).not.toContain("no CA bundle is set");
  });

  it("verifies the server certificate and hostname", () => {
    expect(content).toContain("tls_enabled = yes");
    expect(content).toContain("verify_server_cert = yes");
    expect(content).toContain("verify_server_hostname = yes");
  });
});

describe("ari.conf", () => {
  const { content } = renderAriConf(S, REV, "aripass");

  it("attaches CDR values as channelvars", () => {
    // The only way accounting data reaches the control plane: there is no CDR
    // event type in ARI.
    expect(content).toMatch(/^channelvars = .*CDR\(billsec\)/m);
    expect(content).toContain("CDR(disposition)");
    expect(content).toContain("HANGUPCAUSE");
  });

  it("subscribes to all events", () => {
    expect(content).toContain("subscribe_all = yes");
  });

  it("declares an outbound websocket bound to the client id", () => {
    expect(content).toContain("type = outbound_websocket");
    expect(content).toContain("websocket_client_id = aem_ws");
    expect(content).toContain("local_ari_user = aem_user");
  });

  it("makes the ARI user writable", () => {
    // A read_only user cannot push configuration at all.
    expect(content).toContain("read_only = no");
  });
});

describe("cdr.conf", () => {
  it("sets endbeforehexten, which defaults to no", () => {
    // Without it, disposition reads NO ANSWER and end reads epoch at
    // ChannelDestroyed, because channelvars are sampled before the async CDR
    // engine finalizes the record.
    expect(renderCdrConf(REV).content).toContain("endbeforehexten = yes");
  });
});

describe("sorcery.conf", () => {
  it("maps the writable types to astdb before the read-only flat file", () => {
    const { content } = renderSorceryConf(REV, false);
    for (const type of ["endpoint", "auth", "aor"]) {
      const astdb = content.indexOf(`${type} = astdb`);
      const file = content.indexOf(`${type} = config,pjsip.conf`);
      expect(astdb).toBeGreaterThan(-1);
      expect(file).toBeGreaterThan(-1);
      // Mapping order is lookup order: astdb must win for managed objects.
      expect(astdb).toBeLessThan(file);
    }
  });

  it("omits the SCCP section when SCCP is disabled", () => {
    expect(renderSorceryConf(REV, false).content).not.toContain("[chan_sccp2]");
    expect(renderSorceryConf(REV, true).content).toContain("[chan_sccp2]");
  });
});

describe("sccp.conf", () => {
  it("selects the sorcery configuration source", () => {
    // In "file" mode chan_sccp2 opens no sorcery instance at all and nothing
    // is manageable over ARI.
    const { content } = renderSccpConf(REV, {}, []);
    expect(content).toContain("configuration_source = sorcery");
  });

  it("always emits a default softkey profile", () => {
    // Every device references one, and a missing profile fails the reload —
    // silently, because SCCP writes ack 200 regardless.
    const { content } = renderSccpConf(REV, {}, []);
    expect(content).toContain("[default]");
    expect(content).toContain("type = softkey_profile");
  });

  it("marks template sections with (!)", () => {
    const { content } = renderSccpConf(REV, {}, [
      { section_type: "template", name: "desk", attrs: { context: "internal" } },
    ]);
    expect(content).toContain("[desk(!)]");
  });
});

describe("extensions.conf", () => {
  const rendered = renderExtensionsConf(REV, S, {
    extensions: [
      {
        number: "1001",
        tech: "pjsip",
        dialId: "aem-1001",
        directory_only: 0,
        ring_timeout: 20,
        no_answer_target: "Hangup()",
      },
      {
        number: "2001",
        tech: "sccp",
        dialId: "2001",
        directory_only: 0,
        ring_timeout: 25,
        no_answer_target: "Hangup()",
      },
      {
        number: "1500",
        tech: "pjsip",
        dialId: "aem-1500",
        directory_only: 1,
        ring_timeout: 20,
        no_answer_target: "Hangup()",
      },
    ],
    ringGroups: [
      {
        number: "600",
        name: "Support",
        ring_time: 30,
        no_answer_target: "Hangup()",
        members: [
          { tech: "pjsip", dialId: "aem-1001" },
          { tech: "sccp", dialId: "2001" },
        ],
      },
    ],
    queues: [{ number: "700", name: "sales" }],
    ivrs: [
      {
        number: "800",
        name: "Main",
        greeting: "welcome",
        timeout: 10,
        invalid_target: "Hangup()",
        timeout_target: "Hangup()",
        entries: [{ digit: "1", target: "Goto(aem-internal,1001,1)" }],
      },
    ],
    timeConditions: [
      {
        number: "900",
        name: "Office hours",
        time_spec: "08:00-17:00,mon-fri,*,*",
        match_target: "Goto(aem-internal,800,1)",
        nomatch_target: "Hangup()",
      },
    ],
  });

  const content = rendered.content;

  it("stamps the file revision as a global the DO can read back", () => {
    expect(content).toContain("[globals]");
    expect(content).toContain(`AEM_FILE_REV = ${REV}`);
  });

  it("dials the right technology for each extension", () => {
    expect(content).toContain("exten => 1001,1,Dial(PJSIP/aem-1001,20)");
    expect(content).toContain("exten => 2001,1,Dial(SCCP/2001,25)");
  });

  it("emits hints for BLF and device state", () => {
    expect(content).toContain("exten => 1001,hint,PJSIP/aem-1001");
    // SCCP device state keys on the line number, not the device id.
    expect(content).toContain("exten => 2001,hint,SCCP/2001");
  });

  it("skips directory-only entries entirely", () => {
    expect(content).not.toContain("aem-1500");
    expect(content).not.toContain("exten => 1500");
  });

  it("does not emit Voicemail(), which is deferred to v2", () => {
    expect(content).not.toContain("Voicemail(");
    expect(content).toContain("same => n,Hangup()");
  });

  it("joins ring group members with &", () => {
    expect(content).toContain("Dial(PJSIP/aem-1001&SCCP/2001,30)");
  });

  it("renders queues, IVRs and time conditions", () => {
    expect(content).toContain("Queue(sales)");
    expect(content).toContain("[aem-internal-ivr-800]");
    expect(content).toContain("Background(welcome)");
    expect(content).toContain("GotoIfTime(08:00-17:00,mon-fri,*,*?");
  });

  it("offers a local include escape hatch", () => {
    expect(content).toContain('#tryinclude "extensions_local.conf"');
  });

  // A plain #include of a file that does not exist invalidates the whole
  // enclosing config, which for a sorcery-backed file means the objects in it
  // are never created. None of these _local.conf files exists until an operator
  // creates one, so this must never regress to #include.
  it("uses tryinclude so a missing local file is not fatal", () => {
    expect(content).not.toMatch(/^#include\b/m);
  });
});

describe("pjsip.conf", () => {
  it("orders sections by dependency", () => {
    const { content } = renderPjsipConf(
      REV,
      [
        {
          object_type: "endpoint",
          object_id: "trunk-telia",
          attrs: { context: "from-trunk" },
          sort_order: 0,
        },
        {
          object_type: "transport",
          object_id: "transport-udp",
          attrs: { protocol: "udp", bind: "0.0.0.0:5060" },
          sort_order: 0,
        },
        {
          object_type: "auth",
          object_id: "auth-telia",
          attrs: { username: "x" },
          sort_order: 0,
        },
      ],
      {},
    );
    const idx = (s: string) => content.indexOf(s);
    expect(idx("[transport-udp]")).toBeLessThan(idx("[auth-telia]"));
    expect(idx("[auth-telia]")).toBeLessThan(idx("[trunk-telia]"));
  });

  it("says plainly that extensions do not live here", () => {
    const { content } = renderPjsipConf(REV, [], {});
    expect(content).toMatch(/Extensions are managed over/);
  });
});

describe("queues.conf", () => {
  it("emits member lines with the right technology and penalty", () => {
    const { content } = renderQueuesConf(REV, [
      {
        name: "sales",
        strategy: "rrmemory",
        timeout: 15,
        musicclass: "default",
        attrs: {},
        members: [
          { tech: "pjsip", dialId: "aem-1001", penalty: 0 },
          { tech: "sccp", dialId: "2001", penalty: 1 },
        ],
      },
    ]);
    expect(content).toContain("member => PJSIP/aem-1001,0");
    expect(content).toContain("member => SCCP/2001,1");
    expect(content).toContain("strategy = rrmemory");
  });
});

/**
 * Commissioning regression.
 *
 * A `#include` naming a file that does not exist invalidates the *entire*
 * enclosing config. For a sorcery-backed file that is fatal — the objects in it
 * are never created — and the only symptom is a log line on the PBX:
 *
 *   res_sorcery_config.c: Contents of config file 'websocket_client.conf' are
 *                         invalid and cannot be parsed
 *
 * which in turn left `[aem]` uncreated and Asterisk dialling nothing, showing
 * up in the GUI as a site stuck on `never_connected`. These _local.conf files
 * are an escape hatch nobody has created yet on a fresh box, so every one of
 * them must be a `#tryinclude`. One file getting this wrong breaks that file,
 * so the guard covers all of them rather than a representative sample.
 */
describe("every generated file", () => {
  const all: [string, string][] = [
    ["websocket_client.conf", renderWebsocketClientConf(S, REV, "hunter2").content],
    ["ari.conf", renderAriConf(S, REV, "hunter2").content],
    ["cdr.conf", renderCdrConf(REV).content],
    ["sorcery.conf", renderSorceryConf(REV, true).content],
    ["pjsip.conf", renderPjsipConf(REV, [], {}).content],
    ["sccp.conf", renderSccpConf(REV, {}, []).content],
    [
      "extensions.conf",
      renderExtensionsConf(REV, S, {
        extensions: [],
        ringGroups: [],
        queues: [],
        ivrs: [],
        timeConditions: [],
      }).content,
    ],
    ["musiconhold.conf", renderMusicOnHoldConf(REV, []).content],
    ["queues.conf", renderQueuesConf(REV, []).content],
  ];

  it.each(all)("%s uses #tryinclude, never a bare #include", (_name, content) => {
    expect(content).not.toMatch(/^#include\b/m);
    expect(content).toMatch(/^#tryinclude "[a-z_]+_local\.conf"$/m);
  });
});
