/**
 * Compile the product model into `object_version` (desired sorcery objects)
 * and append the resulting changes to `op_log` (the delta stream the Durable
 * Object consumes).
 *
 * Runs after any mutation to extensions, devices or profiles. It is idempotent
 * by construction: it diffs the freshly expanded desired state against what is
 * already recorded and only writes op_log rows for objects that actually
 * changed. That matters more than it sounds — every SCCP write triggers a
 * complete inventory reload on the PBX, and a material device change drops the
 * phone's session, so spurious ops have a visible cost in re-registrations.
 */

import {
  expandExtension,
  expandSccpDevice,
  type ExtensionRow,
  type ProfileAttrs,
  type SccpDeviceRow,
} from "./expand.js";
import type { DesiredObject, DesiredTuple } from "../types.js";

/**
 * Stable serialization so attribute ordering never registers as a change.
 *
 * For COMPARISON ONLY — never store or push this form. Several PJSIP options
 * are order-dependent, and `disallow`/`allow` is the pair that matters: the
 * handlers mutate one shared codec list, so `disallow=all` applied after
 * `allow=ulaw,alaw,g722` silently empties it. Sorted alphabetically `allow`
 * lands first, and an endpoint with no codecs is not merely degraded — res_pjsip
 * refuses to materialize it, so the object sits in AstDB while
 * `pjsip show endpoint <id>` reports "Unable to find object".
 *
 * Storing the sorted form is what caused exactly that. `serializeAttrs` is the
 * storage and push form; this one only ever feeds an equality test.
 */
export function canonicalAttrs(attrs: DesiredTuple[]): string {
  const sorted = [...attrs].sort((a, b) =>
    a.attribute < b.attribute ? -1 : a.attribute > b.attribute ? 1 : 0,
  );
  return JSON.stringify(sorted);
}

/** The stored and pushed form: expansion order, preserved verbatim. */
export function serializeAttrs(attrs: DesiredTuple[]): string {
  return JSON.stringify(attrs);
}

function parseAttrs(json: string): DesiredTuple[] {
  try {
    return JSON.parse(json) as DesiredTuple[];
  } catch {
    return [];
  }
}

export interface CompileResult {
  created: number;
  updated: number;
  deleted: number;
  changed: boolean;
}

interface ProfileRow {
  id: string;
  attrs_json: string;
}

async function loadProfiles(
  db: D1Database,
): Promise<Map<string, ProfileAttrs>> {
  const res = await db
    .prepare("SELECT id, attrs_json FROM profile")
    .all<ProfileRow>();
  const map = new Map<string, ProfileAttrs>();
  for (const row of res.results ?? []) {
    try {
      map.set(row.id, JSON.parse(row.attrs_json) as ProfileAttrs);
    } catch {
      map.set(row.id, {});
    }
  }
  return map;
}

export async function buildDesired(
  db: D1Database,
  pbxId: string,
): Promise<DesiredObject[]> {
  const pbx = await db
    .prepare("SELECT id FROM pbx WHERE id = ?")
    .bind(pbxId)
    .first<{ id: string }>();
  if (!pbx) throw new Error(`unknown pbx: ${pbxId}`);

  const profiles = await loadProfiles(db);

  const extRes = await db
    .prepare(
      `SELECT id, number, display_name, tech, context, directory_only,
              overrides_json, profile_id
         FROM extension WHERE pbx_id = ?`,
    )
    .bind(pbxId)
    .all<Omit<ExtensionRow, "profile_attrs"> & { profile_id: string | null }>();

  const objects: DesiredObject[] = [];

  for (const row of extRes.results ?? []) {
    const ext: ExtensionRow = {
      ...row,
      profile_attrs: (row.profile_id ? profiles.get(row.profile_id) : undefined) ?? {},
    };
    objects.push(...expandExtension(ext));
  }

  const devRes = await db
    .prepare(
      `SELECT id, sep_id, description, softkey_profile, overrides_json, profile_id
         FROM sccp_device WHERE pbx_id = ?`,
    )
    .bind(pbxId)
    .all<
      Omit<SccpDeviceRow, "profile_attrs" | "buttons"> & {
        profile_id: string | null;
      }
    >();

  const devices = devRes.results ?? [];
  if (devices.length > 0) {
    const btnRes = await db
      .prepare(
        `SELECT device_id, position, kind, args_json
           FROM sccp_button
          WHERE device_id IN (SELECT id FROM sccp_device WHERE pbx_id = ?)
          ORDER BY device_id, position`,
      )
      .bind(pbxId)
      .all<{
        device_id: number;
        position: number;
        kind: string;
        args_json: string;
      }>();

    const buttonsByDevice = new Map<
      number,
      { position: number; kind: string; args: string[] }[]
    >();
    for (const b of btnRes.results ?? []) {
      let list = buttonsByDevice.get(b.device_id);
      if (!list) {
        list = [];
        buttonsByDevice.set(b.device_id, list);
      }
      let args: string[] = [];
      try {
        args = JSON.parse(b.args_json) as string[];
      } catch {
        args = [];
      }
      list.push({ position: b.position, kind: b.kind, args });
    }

    for (const row of devices) {
      objects.push(
        expandSccpDevice({
          ...row,
          profile_attrs:
            (row.profile_id ? profiles.get(row.profile_id) : undefined) ?? {},
          buttons: buttonsByDevice.get(row.id) ?? [],
        }),
      );
    }
  }

  return objects;
}

/**
 * Append an op_log row for one object without changing its desired attributes.
 *
 * Needed because a secret change is invisible to `compilePbx`. The password
 * reaches the PBX as a `secret_ref` tuple — deliberately, so plaintext never
 * lands in `object_version` — which means attrs_json is byte-identical before
 * and after a rotation and the diff finds nothing to do. The new password would
 * then sit in D1 unpushed until some unrelated edit to the same auth object
 * happened to carry it along, with the handset still registering on the old one
 * in the meantime.
 *
 * The DO's delta pass re-reads the object and resolves the secret at push time,
 * so the op row alone is enough; no version bump is required. An op naming an
 * object that is not in `object_version` is skipped there harmlessly.
 */
export async function touchObject(
  db: D1Database,
  pbxId: string,
  configClass: string,
  objectType: string,
  objectId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO op_log (pbx_id, op, config_class, object_type, object_id)
       VALUES (?, 'upsert', ?, ?, ?)`,
    )
    .bind(pbxId, configClass, objectType, objectId)
    .run();
}

/**
 * Recompute desired state for one PBX and record the delta.
 *
 * Returns `changed: false` when nothing moved, which lets callers skip
 * notifying the Durable Object at all.
 */
export async function compilePbx(
  db: D1Database,
  pbxId: string,
): Promise<CompileResult> {
  const desired = await buildDesired(db, pbxId);

  const existingRes = await db
    .prepare(
      `SELECT config_class, object_type, object_id, version, attrs_json
         FROM object_version WHERE pbx_id = ?`,
    )
    .bind(pbxId)
    .all<{
      config_class: string;
      object_type: string;
      object_id: string;
      version: number;
      attrs_json: string;
    }>();

  const existing = new Map(
    (existingRes.results ?? []).map((r) => [
      `${r.config_class}/${r.object_type}/${r.object_id}`,
      r,
    ]),
  );

  const statements: D1PreparedStatement[] = [];
  let created = 0;
  let updated = 0;

  const seen = new Set<string>();

  for (const obj of desired) {
    const key = `${obj.configClass}/${obj.objectType}/${obj.objectId}`;
    seen.add(key);

    const attrsJson = serializeAttrs(obj.attrs);
    const prev = existing.get(key);

    if (prev && prev.attrs_json === attrsJson) continue; // byte-identical

    // Whether the attribute *set* moved, as opposed to only its order. Rows
    // written before the ordering fix hold the sorted form, so a reorder alone
    // must rewrite the row — the stored form is what gets pushed — without
    // billing it as a change the PBX needs to hear about.
    const setChanged =
      !prev || canonicalAttrs(parseAttrs(prev.attrs_json)) !== canonicalAttrs(obj.attrs);

    const version = setChanged ? (prev?.version ?? 0) + 1 : prev.version;
    if (setChanged) {
      if (prev) updated++;
      else created++;
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO object_version (pbx_id, config_class, object_type, object_id,
                                       version, attrs_json, dep_rank, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(pbx_id, config_class, object_type, object_id) DO UPDATE SET
             version = excluded.version,
             attrs_json = excluded.attrs_json,
             dep_rank = excluded.dep_rank,
             updated_at = excluded.updated_at`,
        )
        .bind(
          pbxId,
          obj.configClass,
          obj.objectType,
          obj.objectId,
          version,
          attrsJson,
          obj.depRank,
        ),
    );

    if (setChanged) {
      statements.push(
        db
          .prepare(
            `INSERT INTO op_log (pbx_id, op, config_class, object_type, object_id)
             VALUES (?, 'upsert', ?, ?, ?)`,
          )
          .bind(pbxId, obj.configClass, obj.objectType, obj.objectId),
      );
    }
  }

  let deleted = 0;
  for (const [key, row] of existing) {
    if (seen.has(key)) continue;
    deleted++;
    statements.push(
      db
        .prepare(
          `DELETE FROM object_version
            WHERE pbx_id = ? AND config_class = ? AND object_type = ? AND object_id = ?`,
        )
        .bind(pbxId, row.config_class, row.object_type, row.object_id),
      db
        .prepare(
          `INSERT INTO op_log (pbx_id, op, config_class, object_type, object_id)
           VALUES (?, 'delete', ?, ?, ?)`,
        )
        .bind(pbxId, row.config_class, row.object_type, row.object_id),
      // An object being removed should not keep a stale quarantine row that
      // would suppress a future object with the same id.
      db
        .prepare(
          `DELETE FROM quarantine
            WHERE pbx_id = ? AND config_class = ? AND object_type = ? AND object_id = ?`,
        )
        .bind(pbxId, row.config_class, row.object_type, row.object_id),
    );
  }

  if (statements.length > 0) await db.batch(statements);

  return { created, updated, deleted, changed: statements.length > 0 };
}
