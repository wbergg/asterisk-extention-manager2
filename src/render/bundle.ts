/**
 * Assemble the rendered config bundle for one PBX.
 *
 * The bundle is the delivery mechanism for everything ARI cannot push. The
 * operator's Ansible/CI pulls it and applies it; the DO then verifies it
 * landed by reading AEM_FILE_REV back over ARI.
 *
 * `file_rev` is bumped from a hash of the renderer *inputs* rather than of the
 * output, because the revision number is itself embedded in the output —
 * hashing the output would never reach a fixed point.
 */

import { decryptSecret, signBundle } from "../lib/crypto.js";
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
  type DialplanExtension,
  type DialplanIvr,
  type DialplanQueue,
  type DialplanRingGroup,
  type DialplanTimeCondition,
  type MohClass,
  type QueueDef,
  type RenderedFile,
  type SccpStaticSection,
  type StaticObject,
} from "./files.js";
import { parseSettings } from "./settings.js";
import type { Env } from "../types.js";

export interface Bundle {
  pbxId: string;
  fileRev: number;
  files: RenderedFile[];
  /** HMAC-SHA256 over the concatenated files, hex. */
  signature: string;
  generatedAt: string;
}

interface PbxRow {
  id: string;
  prefix: string;
  file_rev: number;
  file_input_hash: string;
  sccp_enabled: number;
  settings_json: string;
  ws_secret_enc: string;
  ari_secret_enc: string;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Everything the renderers read, gathered once. */
async function gather(db: D1Database, pbxId: string) {
  const batch = await db.batch([
    db
      .prepare(
        `SELECT e.number, e.tech, e.directory_only, e.profile_id,
                p.ring_timeout, p.no_answer_target
           FROM extension e LEFT JOIN profile p ON p.id = e.profile_id
          WHERE e.pbx_id = ? ORDER BY e.number`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT object_type, object_id, attrs_json, sort_order
           FROM pjsip_static WHERE pbx_id = ? ORDER BY sort_order, object_id`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT section_type, name, attrs_json
           FROM sccp_static WHERE pbx_id = ? ORDER BY section_type, name`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT id, number, name, ring_time, no_answer_target
           FROM ring_group WHERE pbx_id = ? ORDER BY number`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT m.ring_group_id, m.position, m.extension_number
           FROM ring_group_member m
           JOIN ring_group g ON g.id = m.ring_group_id
          WHERE g.pbx_id = ? ORDER BY m.ring_group_id, m.position`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT name, mode, directory, sort_mode FROM moh_class
          WHERE pbx_id = ? ORDER BY name`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT id, number, name, strategy, timeout, musicclass, attrs_json
           FROM queue WHERE pbx_id = ? ORDER BY number`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT m.queue_id, m.position, m.extension_number, m.penalty
           FROM queue_member m JOIN queue q ON q.id = m.queue_id
          WHERE q.pbx_id = ? ORDER BY m.queue_id, m.position`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT id, number, name, greeting, timeout, invalid_target, timeout_target
           FROM ivr WHERE pbx_id = ? ORDER BY number`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT e.ivr_id, e.digit, e.target FROM ivr_entry e
           JOIN ivr i ON i.id = e.ivr_id
          WHERE i.pbx_id = ? ORDER BY e.ivr_id, e.digit`,
      )
      .bind(pbxId),
    db
      .prepare(
        `SELECT number, name, time_spec, match_target, nomatch_target
           FROM time_condition WHERE pbx_id = ? ORDER BY number`,
      )
      .bind(pbxId),
    db.prepare(`SELECT id, ring_timeout, no_answer_target FROM profile`),
  ]);

  const rows = <T>(i: number): T[] => (batch[i]?.results ?? []) as T[];

  return {
    extensions: rows<{
      number: string;
      tech: "pjsip" | "sccp";
      directory_only: number;
      profile_id: string | null;
      ring_timeout: number | null;
      no_answer_target: string | null;
    }>(0),
    pjsipStatic: rows<{
      object_type: string;
      object_id: string;
      attrs_json: string;
      sort_order: number;
    }>(1),
    sccpStatic: rows<{
      section_type: "softkey_profile" | "template";
      name: string;
      attrs_json: string;
    }>(2),
    ringGroups: rows<{
      id: number;
      number: string;
      name: string;
      ring_time: number;
      no_answer_target: string;
    }>(3),
    rgMembers: rows<{
      ring_group_id: number;
      position: number;
      extension_number: string;
    }>(4),
    mohClasses: rows<MohClass>(5),
    queues: rows<{
      id: number;
      number: string;
      name: string;
      strategy: string;
      timeout: number;
      musicclass: string;
      attrs_json: string;
    }>(6),
    queueMembers: rows<{
      queue_id: number;
      position: number;
      extension_number: string;
      penalty: number;
    }>(7),
    ivrs: rows<{
      id: number;
      number: string;
      name: string;
      greeting: string;
      timeout: number;
      invalid_target: string;
      timeout_target: string;
    }>(8),
    ivrEntries: rows<{
      ivr_id: number;
      digit: string;
      target: string;
    }>(9),
    timeConditions: rows<DialplanTimeCondition>(10),
    profiles: rows<{
      id: string;
      ring_timeout: number;
      no_answer_target: string;
    }>(11),
  };
}

export async function renderBundle(
  db: D1Database,
  env: Env,
  pbxId: string,
  host: string,
): Promise<Bundle> {
  const pbx = await db
    .prepare(
      `SELECT id, prefix, file_rev, file_input_hash, sccp_enabled, settings_json,
              ws_secret_enc, ari_secret_enc
         FROM pbx WHERE id = ?`,
    )
    .bind(pbxId)
    .first<PbxRow>();
  if (!pbx) throw new Error(`unknown pbx: ${pbxId}`);

  const settings = parseSettings(pbx.settings_json, pbx.id, host);
  const data = await gather(db, pbxId);

  // Decrypted here rather than at render time so they can feed the input hash.
  // They are genuine bundle inputs — websocket_client.conf and ari.conf embed
  // them verbatim — so a rotation changes the rendered files and must bump the
  // revision, or the PBX keeps reporting the old rev as current and never
  // learns to re-apply. The *plaintext* is hashed deliberately: AES-GCM uses a
  // fresh IV per call, so hashing the ciphertext would bump the revision on
  // every single render.
  const wsSecret = await decryptSecret(env.SECRET_KEY, pbx.ws_secret_enc);
  const ariSecret = await decryptSecret(env.SECRET_KEY, pbx.ari_secret_enc);

  // Bump the revision only when an input actually changed.
  // `pbx.prefix` is deliberately absent: it no longer reaches any rendered
  // file, so including it would bump the revision for a change the PBX cannot
  // observe. Its removal here is also what bumps the revision once on the
  // deploy that dropped the prefix — the dialplan's Dial and hint targets
  // changed while every other input stayed identical, and without a bump the
  // PBX would keep serving a dialplan pointing at the old object ids.
  const inputHash = await sha256Hex(
    JSON.stringify({
      settings,
      data,
      sccp: pbx.sccp_enabled,
      secrets: [wsSecret, ariSecret],
    }),
  );
  let fileRev = pbx.file_rev;
  if (inputHash !== pbx.file_input_hash) {
    fileRev = pbx.file_rev + 1;
    await db
      .prepare("UPDATE pbx SET file_rev = ?, file_input_hash = ? WHERE id = ?")
      .bind(fileRev, inputHash, pbxId)
      .run();
  }

  // --- shape the dialplan inputs -----------------------------------------

  const profileById = new Map(data.profiles.map((p) => [p.id, p]));
  // Both techs dial the bare extension number: sorcery object ids carry no
  // ownership prefix. See `expandPjsipExtension` for why PJSIP cannot.
  const dialIdOf = (number: string, _tech: "pjsip" | "sccp") => number;
  const techOf = new Map(data.extensions.map((e) => [e.number, e.tech]));

  const extensions: DialplanExtension[] = data.extensions.map((e) => {
    const prof = e.profile_id ? profileById.get(e.profile_id) : undefined;
    return {
      number: e.number,
      tech: e.tech,
      dialId: dialIdOf(e.number, e.tech),
      directory_only: e.directory_only,
      ring_timeout: e.ring_timeout ?? prof?.ring_timeout ?? 20,
      no_answer_target: e.no_answer_target ?? prof?.no_answer_target ?? "Hangup()",
    };
  });

  const membersByGroup = new Map<number, { tech: "pjsip" | "sccp"; dialId: string }[]>();
  for (const m of data.rgMembers) {
    const tech = techOf.get(m.extension_number);
    if (!tech) continue; // member points at an extension that no longer exists
    const list = membersByGroup.get(m.ring_group_id) ?? [];
    list.push({ tech, dialId: dialIdOf(m.extension_number, tech) });
    membersByGroup.set(m.ring_group_id, list);
  }

  const ringGroups: DialplanRingGroup[] = data.ringGroups.map((g) => ({
    number: g.number,
    name: g.name,
    ring_time: g.ring_time,
    no_answer_target: g.no_answer_target,
    members: membersByGroup.get(g.id) ?? [],
  }));

  const entriesByIvr = new Map<number, { digit: string; target: string }[]>();
  for (const e of data.ivrEntries) {
    const list = entriesByIvr.get(e.ivr_id) ?? [];
    list.push({ digit: e.digit, target: e.target });
    entriesByIvr.set(e.ivr_id, list);
  }

  const ivrs: DialplanIvr[] = data.ivrs.map((i) => ({
    number: i.number,
    name: i.name,
    greeting: i.greeting,
    timeout: i.timeout,
    invalid_target: i.invalid_target,
    timeout_target: i.timeout_target,
    entries: entriesByIvr.get(i.id) ?? [],
  }));

  const qMembersByQueue = new Map<
    number,
    { tech: "pjsip" | "sccp"; dialId: string; penalty: number }[]
  >();
  for (const m of data.queueMembers) {
    const tech = techOf.get(m.extension_number);
    if (!tech) continue;
    const list = qMembersByQueue.get(m.queue_id) ?? [];
    list.push({
      tech,
      dialId: dialIdOf(m.extension_number, tech),
      penalty: m.penalty,
    });
    qMembersByQueue.set(m.queue_id, list);
  }

  const queueDefs: QueueDef[] = data.queues.map((q) => ({
    name: q.name,
    strategy: q.strategy,
    timeout: q.timeout,
    musicclass: q.musicclass,
    attrs: parseJson<Record<string, string>>(q.attrs_json, {}),
    members: qMembersByQueue.get(q.id) ?? [],
  }));

  const dialplanQueues: DialplanQueue[] = data.queues.map((q) => ({
    number: q.number,
    name: q.name,
  }));

  const pjsipObjects: StaticObject[] = data.pjsipStatic.map((o) => ({
    object_type: o.object_type,
    object_id: o.object_id,
    attrs: parseJson<Record<string, string>>(o.attrs_json, {}),
    sort_order: o.sort_order,
  }));

  const sccpSections: SccpStaticSection[] = data.sccpStatic.map((s) => ({
    section_type: s.section_type,
    name: s.name,
    attrs: parseJson<Record<string, string>>(s.attrs_json, {}),
  }));

  // --- render -------------------------------------------------------------

  const files: RenderedFile[] = [
    renderWebsocketClientConf(settings, fileRev, wsSecret),
    renderAriConf(settings, fileRev, ariSecret),
    renderCdrConf(fileRev),
    renderSorceryConf(fileRev, pbx.sccp_enabled === 1),
    renderPjsipConf(fileRev, pjsipObjects, settings.pjsip_global),
    renderExtensionsConf(fileRev, settings, {
      extensions,
      ringGroups,
      queues: dialplanQueues,
      ivrs,
      timeConditions: data.timeConditions,
    }),
    renderMusicOnHoldConf(fileRev, data.mohClasses),
    renderQueuesConf(fileRev, queueDefs),
  ];

  if (pbx.sccp_enabled === 1) {
    files.push(
      renderSccpConf(fileRev, settings.sccp_general, sccpSections),
    );
  }

  await recordFileHashes(db, pbxId, fileRev, files);

  const signature = await signBundle(
    env.BUNDLE_KEY,
    files.map((f) => `${f.path}\n${f.content}`).join("\n---\n"),
  );

  return {
    pbxId,
    fileRev,
    files,
    signature,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The content of a rendered file with its revision stamp removed, so two
 * revisions of an otherwise unchanged file hash the same. The stamp appears in
 * every banner and, for extensions.conf, as the AEM_FILE_REV global.
 */
function withoutRevision(content: string): string {
  return content
    .replace(/file revision \d+/g, "file revision N")
    .replace(/^AEM_FILE_REV = \d+$/m, "AEM_FILE_REV = N");
}

/**
 * Remember what each file of this revision looked like. Best effort: a missing
 * table (migration 0004 not yet applied) must not stop the bundle from being
 * served — the only cost is a less specific stale message.
 */
async function recordFileHashes(
  db: D1Database,
  pbxId: string,
  fileRev: number,
  files: RenderedFile[],
): Promise<void> {
  try {
    const rows = await Promise.all(
      files.map(async (f) => ({
        path: f.path,
        hash: await sha256Hex(withoutRevision(f.content)),
      })),
    );
    await db.batch(
      rows.map((r) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO bundle_file_hash (pbx_id, file_rev, path, content_hash)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(pbxId, fileRev, r.path, r.hash),
      ),
    );
  } catch (e) {
    console.error(`bundle: could not record file hashes for ${pbxId}@${fileRev}`, e);
  }
}

export interface StaleFiles {
  /** New or changed since the applied revision: install these. */
  changed: string[];
  /** Shipped in the applied revision but no longer generated: remove these. */
  removed: string[];
}

/**
 * Which files differ between the revision the PBX has applied and the one AEM
 * wants. Null when either revision was never recorded (rendered before
 * migration 0004, or never rendered at all), so the caller falls back to
 * "apply the whole bundle".
 */
export async function staleFiles(
  db: D1Database,
  pbxId: string,
  appliedRev: number,
  desiredRev: number,
): Promise<StaleFiles | null> {
  try {
    const res = await db
      .prepare(
        `SELECT file_rev, path, content_hash FROM bundle_file_hash
          WHERE pbx_id = ? AND file_rev IN (?, ?)`,
      )
      .bind(pbxId, appliedRev, desiredRev)
      .all<{ file_rev: number; path: string; content_hash: string }>();
    const applied = new Map<string, string>();
    const desired = new Map<string, string>();
    for (const r of res.results ?? []) {
      (r.file_rev === appliedRev ? applied : desired).set(r.path, r.content_hash);
    }
    if (applied.size === 0 || desired.size === 0) return null;

    return {
      changed: [...desired].filter(([p, h]) => applied.get(p) !== h).map(([p]) => p),
      removed: [...applied.keys()].filter((p) => !desired.has(p)),
    };
  } catch {
    return null;
  }
}

/** The middle sentence of the stale status: what to install, what to remove. */
export function describeStale(stale: StaleFiles | null): string {
  if (!stale) {
    return "Which files changed is unknown (that revision was never recorded), so install every file.";
  }
  const parts: string[] = [];
  if (stale.changed.length) parts.push(`Changed: ${stale.changed.join(", ")}.`);
  if (stale.removed.length) parts.push(`No longer generated, remove: ${stale.removed.join(", ")}.`);
  // Only the revision stamp moved, e.g. an input changed and was changed back.
  if (!parts.length) parts.push("No file content changed, only the revision stamp; installing extensions.conf is enough.");
  return parts.join(" ");
}
