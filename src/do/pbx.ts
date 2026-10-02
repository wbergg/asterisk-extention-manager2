import { DurableObject } from "cloudflare:workers";

import {
  buildRequest,
  configUri,
  describeFailure,
  isRestResponse,
  parseResponseBody,
  type AriEvent,
  type ConfigPutBody,
  type RestRequest,
  type RestResponse,
} from "../ari/envelope.js";
import { decryptSecret } from "../lib/crypto.js";
import { ingestChannelEvent } from "./calllog.js";
import { validateSccpInventory } from "../model/sccp/validate.js";
import {
  isSecretTuple,
  type ConfigClass,
  type ConfigTuple,
  type DesiredTuple,
  type Env,
  type ObjectType,
  type ReconcileState,
} from "../types.js";

/** How long to wait for a RESTResponse before giving up on a request. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Background drift sweep cadence. Also acts as the reconcile watchdog. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Consecutive failures before an object is quarantined and skipped. */
const QUARANTINE_AFTER = 5;

const BACKOFF_MS = [1_000, 2_000, 4_000, 15_000, 60_000, 300_000];

interface DesiredRow {
  config_class: ConfigClass;
  object_type: ObjectType;
  object_id: string;
  version: number;
  attrs_json: string;
  dep_rank: number;
  // Required so this type satisfies the DO SQLite row constraint; the mirror
  // table and the D1 table share this shape.
  [k: string]: SqlStorageValue;
}

interface PendingRequest {
  resolve: (r: RestResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One Durable Object per PBX. It owns the WebSocket that Asterisk dials out
 * to, and is the only writer of configuration to that box.
 *
 * Reconciliation is serialized here rather than in the Worker because ARI
 * dynamic configuration has no transactional semantics — each PUT is
 * independent, ordering between them is load-bearing, and two concurrent
 * reconcilers would interleave dependency chains and produce endpoints
 * referencing auths that do not exist yet.
 */
export class PbxController extends DurableObject<Env> {
  /** Request correlation. In-memory only: lost on eviction, which is fine —
   *  an orphaned response is dropped and the alarm restarts the reconcile. */
  private pending = new Map<string, PendingRequest>();
  private reconciling = false;
  private reqCounter = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const current = sql
      .exec<{ v: number }>("SELECT COALESCE(MAX(id), 0) AS v FROM _migrations")
      .one().v;

    if (current < 1) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        -- Mirror of D1's object_version for this PBX, so a reconcile can still
        -- run (and SCCP ownership is still known) if D1 is briefly unreachable.
        CREATE TABLE IF NOT EXISTS desired (
          config_class TEXT NOT NULL,
          object_type  TEXT NOT NULL,
          object_id    TEXT NOT NULL,
          version      INTEGER NOT NULL,
          attrs_json   TEXT NOT NULL,
          dep_rank     INTEGER NOT NULL,
          PRIMARY KEY (config_class, object_type, object_id)
        );
        INSERT INTO _migrations (id) VALUES (1);
      `);
    }
  }

  // ---------------------------------------------------------------------
  // meta helpers
  // ---------------------------------------------------------------------

  private getMeta(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private get pbxId(): string {
    return this.getMeta("pbx_id") ?? "";
  }

  private get ackedSeq(): number {
    return Number(this.getMeta("acked_seq") ?? "0");
  }

  // ---------------------------------------------------------------------
  // WebSocket lifecycle
  // ---------------------------------------------------------------------

  /**
   * The Worker forwards the verified upgrade request here. Using the
   * hibernation API keeps the socket alive across DO eviction, which matters
   * because a PBX may sit idle for hours between config changes.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pbxId = url.searchParams.get("pbx_id");
    if (!pbxId) return new Response("missing pbx_id", { status: 400 });

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    this.setMeta("pbx_id", pbxId);

    // Only one Asterisk instance per PBX. A reconnect while an old socket is
    // still half-open would otherwise leave two sockets and interleaved
    // requests, so close any predecessor first.
    for (const old of this.ctx.getWebSockets()) {
      try {
        old.close(1012, "superseded by new connection");
      } catch {
        /* already gone */
      }
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]!);

    // A fresh connection is a fresh opportunity: reset the retry budget so we
    // attempt immediately. The usual reason Asterisk reconnects is that
    // somebody just fixed the thing that was failing and restarted it —
    // making them wait out a five-minute backoff would be perverse.
    this.clearFailure();

    // Sweep on every connect, not just the first. The delta cursor assumes the
    // PBX kept the state we last acked, which AstDB does across an Asterisk
    // restart — but not across a re-image, an AstDB wipe, or a restore from
    // backup. Without this the DO would report "converged" over an empty box.
    this.setMeta("needs_sweep", "1");

    // Keep the previous error visible until this attempt produces its own
    // verdict, so the status view never goes blank mid-reconnect.
    await this.setState("connecting", this.getMeta("last_error"));
    // Don't reconcile inline: the upgrade response must be returned promptly
    // or Asterisk's connection_timeout (default 500ms) trips.
    void this.ctx.storage.setAlarm(Date.now() + 100);

    return new Response(null, { status: 101, webSocket: pair[0]! });
  }

  override async webSocketMessage(
    _ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return; // ARI is text/JSON only

    let msg: AriEvent | RestResponse;
    try {
      msg = JSON.parse(message);
    } catch {
      console.error("pbx: non-JSON frame", message.slice(0, 200));
      return;
    }

    if (isRestResponse(msg)) {
      const entry = this.pending.get(msg.request_id);
      if (!entry) return; // response from a previous incarnation; drop it
      this.pending.delete(msg.request_id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
      return;
    }

    await ingestChannelEvent(this.env.DB, this.pbxId, msg as AriEvent);
  }

  override async webSocketClose(): Promise<void> {
    this.failPending("websocket closed");

    // `state` means "verdict of the last reconcile", not "is the socket up".
    // Losing the socket does not invalidate that verdict — a stale bundle is
    // still stale, a converged PBX is still converged — so the verdict is
    // preserved and only the liveness timestamp is refreshed. Connectivity is
    // reported separately by getStatus(), which checks for a live socket, and
    // `last_seen_at` shows how long ago that was true.
    //
    // The alternative, resetting to "never_connected", produced the actively
    // false claim that a PBX which had just connected never had.
    await this.setState(
      (this.getMeta("state") ?? "never_connected") as ReconcileState,
      this.getMeta("last_error"),
    );
  }

  override async webSocketError(): Promise<void> {
    this.failPending("websocket error");
  }

  private failPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------
  // ARI REST-over-WebSocket
  // ---------------------------------------------------------------------

  private socket(): WebSocket | null {
    return this.ctx.getWebSockets()[0] ?? null;
  }

  private send(req: RestRequest): Promise<RestResponse> {
    const ws = this.socket();
    if (!ws) return Promise.reject(new Error("no active websocket"));

    const id = req.request_id!;
    return new Promise<RestResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ARI request timed out: ${req.method} ${req.uri}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(req));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private nextRequestId(): string {
    // Deliberately not crypto.randomUUID(): a short monotonic id keeps the
    // frames small and makes packet captures readable during commissioning.
    return `r${Date.now().toString(36)}-${(this.reqCounter++).toString(36)}`;
  }

  private ari(
    method: RestRequest["method"],
    uri: string,
    opts: { query?: { name: string; value: string }[]; body?: unknown } = {},
  ): Promise<RestResponse> {
    return this.send(buildRequest(this.nextRequestId(), method, uri, opts));
  }

  // ---------------------------------------------------------------------
  // Public RPC
  // ---------------------------------------------------------------------

  /** Called by the Worker after it writes new ops to D1. */
  async notifyChange(): Promise<void> {
    await this.reconcile(false);
  }

  async forceResync(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.reconcile(true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getStatus(): Promise<{
    connected: boolean;
    state: ReconcileState;
    ackedSeq: number;
    lastError: string | null;
    observedFileRev: number | null;
  }> {
    const rev = this.getMeta("observed_file_rev");
    return {
      connected: this.socket() !== null,
      state: (this.getMeta("state") ?? "never_connected") as ReconcileState,
      ackedSeq: this.ackedSeq,
      lastError: this.getMeta("last_error"),
      observedFileRev: rev === null ? null : Number(rev),
    };
  }

  /**
   * Tear this controller down, for good.
   *
   * A Durable Object cannot be deleted — `getByName` on the same site id
   * returns the same object forever. So recreating a PBX under a reused id
   * would otherwise inherit this one's reconcile cursor, its applied-state
   * mirror and its `observed_file_rev`, and the next pass would "converge" a
   * brand-new box against another box's history. Wiping storage is what makes
   * the id genuinely reusable: the constructor re-runs `migrate()` on the next
   * instantiation and comes up empty.
   *
   * With `purge`, the owned objects are removed from the PBX first — an empty
   * desired set turns the ordinary stray sweep into exactly that. Best-effort
   * by design: a decommissioned box is usually already unreachable, and
   * refusing to delete the record because the hardware is off would be the
   * wrong trade. The caller is told either way.
   */
  async decommission(purge: boolean): Promise<{ purged: boolean; error?: string }> {
    let purged = false;
    let error: string | undefined;

    if (purge) {
      if (!this.socket()) {
        error = "PBX is not connected";
      } else {
        try {
          // Ordering mirrors fullSweep. Both techs resolve the owned set from
          // the local mirror, so this removes exactly what this PBX pushed and
          // leaves the file layer's trunks alone — a decommission should drop
          // this app's objects, not config it never wrote.
          await this.deletePjsipStrays([]);
          await this.deleteSccpStrays([]);
          purged = true;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
    }

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "pbx deleted");
      } catch {
        /* already gone */
      }
    }
    this.failPending("pbx deleted");

    // Before deleteAll, so no watchdog can fire against wiped tables. Every
    // meta read after this point would throw "no such table".
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    return { purged, ...(error ? { error } : {}) };
  }

  override async alarm(): Promise<void> {
    try {
      const forceSweep =
        Date.now() >= Number(this.getMeta("next_sweep_at") ?? "0");
      await this.reconcile(forceSweep);
    } finally {
      // Always keep a watchdog armed. If a reconcile died mid-flight (DO
      // evicted while awaiting a response), this is what restarts it.
      await this.ctx.storage.setAlarm(Date.now() + this.nextAlarmDelay());
    }
  }

  private nextAlarmDelay(): number {
    const backoffUntil = Number(this.getMeta("backoff_until") ?? "0");
    const remaining = backoffUntil - Date.now();
    if (remaining > 0) return Math.min(remaining, SWEEP_INTERVAL_MS);
    return SWEEP_INTERVAL_MS;
  }

  // ---------------------------------------------------------------------
  // State reporting
  // ---------------------------------------------------------------------

  private async setState(
    state: ReconcileState,
    error: string | null,
  ): Promise<void> {
    this.setMeta("state", state);
    if (error === null) this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'last_error'");
    else this.setMeta("last_error", error);

    const pbxId = this.pbxId;
    if (!pbxId) return;
    try {
      await this.env.DB.prepare(
        `UPDATE pbx SET state = ?, last_error = ?, acked_seq = ?,
                        observed_file_rev = ?, last_seen_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(
          state,
          error,
          this.ackedSeq,
          this.getMeta("observed_file_rev"),
          pbxId,
        )
        .run();
    } catch (e) {
      // Status reporting must never break reconciliation.
      console.error("pbx: failed to mirror state to D1", e);
    }
  }

  // ---------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------

  private async reconcile(forceSweep: boolean): Promise<void> {
    if (this.reconciling) return; // serialize; the caller's change is picked up by the running pass
    if (!this.socket()) return;

    const backoffUntil = Number(this.getMeta("backoff_until") ?? "0");
    if (!forceSweep && Date.now() < backoffUntil) return;

    this.reconciling = true;
    try {
      await this.setState("syncing", null);

      const blocked = await this.checkPreconditions();
      if (blocked) {
        await this.setState("blocked", blocked);
        this.noteFailure();
        return;
      }

      const desired = await this.loadDesired();

      const needSweep =
        forceSweep || this.getMeta("needs_sweep") === "1" || this.hasCursorGap();

      if (needSweep) {
        await this.fullSweep(desired);
        this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'needs_sweep'");
        this.setMeta("next_sweep_at", String(Date.now() + SWEEP_INTERVAL_MS));
      } else {
        await this.applyDeltas(desired);
      }

      // The pass succeeded, so the PBX now holds this set: record it as the
      // inventory the next pass will diff strays against.
      this.saveMirror(desired);
      this.clearFailure();

      // A pass that skipped quarantined objects has not converged, however
      // cleanly it ran. Reporting "converged" while an object is knowingly
      // unapplied would hide exactly the thing an operator needs to act on.
      const stuck = await this.countQuarantined();
      if (stuck > 0) {
        await this.setState(
          "degraded",
          `${stuck} object${stuck === 1 ? "" : "s"} quarantined and skipped; ` +
            `fix the cause and POST /api/admin/pbx/${this.pbxId}/resync to retry`,
        );
      } else {
        await this.setState("converged", null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.noteFailure();
      await this.setState("degraded", msg);
      console.error("pbx: reconcile failed", msg);
    } finally {
      this.reconciling = false;
      await this.ctx.storage.setAlarm(Date.now() + this.nextAlarmDelay());
    }
  }

  private noteFailure(): void {
    const n = Number(this.getMeta("consecutive_failures") ?? "0") + 1;
    this.setMeta("consecutive_failures", String(n));
    const delay = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)]!;
    this.setMeta("backoff_until", String(Date.now() + delay));
  }

  private clearFailure(): void {
    this.setMeta("consecutive_failures", "0");
    this.setMeta("backoff_until", "0");
  }

  /**
   * A gap means op_log rows we needed were pruned past retention while this
   * PBX was offline. The delta stream can no longer prove convergence, so we
   * fall back to a full sweep — the reason a resync path is mandatory when
   * shipping incremental deltas.
   */
  private hasCursorGap(): boolean {
    return this.getMeta("cursor_gap") === "1";
  }

  // ---------------------------------------------------------------------
  // Preconditions
  // ---------------------------------------------------------------------

  /** Returns a human-readable reason string if blocked, else null. */
  private async checkPreconditions(): Promise<string | null> {
    const modules = await this.ari("GET", "asterisk/modules");
    if (modules.status_code !== 200) {
      return `cannot list modules: ${describeFailure(modules)}`;
    }
    const loaded = new Set(
      (parseResponseBody<{ name: string }[]>(modules) ?? []).map((m) => m.name),
    );

    const pbx = await this.fetchPbxRow();
    const required = ["res_sorcery_astdb.so", "res_ari.so", "res_websocket_client.so"];
    if (pbx?.sccp_enabled) required.push("chan_sccp2.so");

    for (const mod of required) {
      // Asterisk reports module names with and without the .so suffix
      // depending on version; accept either.
      if (!loaded.has(mod) && !loaded.has(mod.replace(/\.so$/, ""))) {
        return `required module not loaded: ${mod}`;
      }
    }

    // The default flat-file sorcery wizard is read-only, so PUT/DELETE return
    // 403 until sorcery.conf remaps these types to astdb. A probe object is
    // the only way to find that out before pushing real config.
    // A fixed, deliberately non-numeric id. Object ids are otherwise bare
    // extension numbers, so the probe needs a name no extension can take —
    // writing and deleting a real extension's aor would drop its registration.
    const probeId = "aem-write-probe";
    const put = await this.ari(
      "PUT",
      configUri("res_pjsip", "aor", probeId),
      { body: { fields: [{ attribute: "type", value: "aor" }] } satisfies ConfigPutBody },
    );
    if (put.status_code !== 200) {
      return `sorcery write probe failed — ${describeFailure(put)}`;
    }
    await this.ari("DELETE", configUri("res_pjsip", "aor", probeId));

    // The file layer cannot be pushed over ARI, so we verify it out-of-band:
    // the rendered extensions.conf stamps its revision as a global variable.
    const rev = await this.ari("GET", "asterisk/variable", {
      query: [{ name: "variable", value: "AEM_FILE_REV" }],
    });
    if (rev.status_code === 200) {
      const value = parseResponseBody<{ value: string }>(rev)?.value ?? "";
      const observed = value === "" ? null : Number(value);
      this.setMeta("observed_file_rev", observed === null ? "" : String(observed));
      if (pbx && observed !== pbx.file_rev) {
        return `config bundle is stale: PBX has AEM_FILE_REV=${
          observed ?? "(unset)"
        }, desired is ${pbx.file_rev}. Apply the bundle from /api/pbx/${
          pbx.id
        }/config-bundle.`;
      }
    }

    return null;
  }

  private async fetchPbxRow(): Promise<{
    id: string;
    prefix: string;
    file_rev: number;
    sccp_enabled: number;
  } | null> {
    const pbxId = this.pbxId;
    if (!pbxId) return null;
    return await this.env.DB.prepare(
      "SELECT id, prefix, file_rev, sccp_enabled FROM pbx WHERE id = ?",
    )
      .bind(pbxId)
      .first();
  }

  // ---------------------------------------------------------------------
  // Desired state
  // ---------------------------------------------------------------------

  /**
   * Load desired state from D1, falling back to the local mirror if D1 is
   * unreachable.
   *
   * Deliberately does NOT refresh the mirror. The mirror holds what we last
   * successfully pushed, and SCCP stray detection is mirror-minus-desired —
   * refreshing it here would make those two sets identical and silently
   * disable stray deletion for SCCP entirely. See saveMirror().
   */
  private async loadDesired(): Promise<DesiredRow[]> {
    try {
      const res = await this.env.DB.prepare(
        `SELECT config_class, object_type, object_id, version, attrs_json, dep_rank
           FROM object_version WHERE pbx_id = ? ORDER BY dep_rank ASC`,
      )
        .bind(this.pbxId)
        .all<DesiredRow>();
      return res.results ?? [];
    } catch (e) {
      console.error("pbx: D1 unavailable, using local mirror", e);
      return this.readMirror();
    }
  }

  private readMirror(): DesiredRow[] {
    return this.ctx.storage.sql
      .exec<DesiredRow>(
        "SELECT config_class, object_type, object_id, version, attrs_json, dep_rank FROM desired ORDER BY dep_rank ASC",
      )
      .toArray();
  }

  /**
   * Record what is now on the PBX. Called only after a reconcile pass has
   * succeeded, so the mirror always describes applied state — which is what
   * makes it a valid inventory for the next pass's stray detection.
   */
  private saveMirror(rows: DesiredRow[]): void {
    this.ctx.storage.sql.exec("DELETE FROM desired");
    for (const r of rows) {
      this.ctx.storage.sql.exec(
        `INSERT INTO desired (config_class, object_type, object_id, version, attrs_json, dep_rank)
         VALUES (?, ?, ?, ?, ?, ?)`,
        r.config_class,
        r.object_type,
        r.object_id,
        r.version,
        r.attrs_json,
        r.dep_rank,
      );
    }
  }

  /** Resolve secret_ref tuples to plaintext, immediately before the push. */
  private async resolveAttrs(attrsJson: string): Promise<ConfigTuple[]> {
    const raw = JSON.parse(attrsJson) as DesiredTuple[];
    const out: ConfigTuple[] = [];
    for (const t of raw) {
      if (!isSecretTuple(t)) {
        out.push(t);
        continue;
      }
      const row = await this.env.DB.prepare(
        "SELECT secret_enc FROM extension WHERE id = ?",
      )
        .bind(t.secret_ref)
        .first<{ secret_enc: string | null }>();
      if (!row?.secret_enc) {
        throw new Error(`missing secret for extension ${t.secret_ref}`);
      }
      out.push({
        attribute: t.attribute,
        value: await decryptSecret(this.env.SECRET_KEY, row.secret_enc),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Full sweep
  // ---------------------------------------------------------------------

  private async fullSweep(desired: DesiredRow[]): Promise<void> {
    await this.validateSccp(desired);

    // 1. Converge every desired object.
    for (const row of [...desired].sort((a, b) => a.dep_rank - b.dep_rank)) {
      if (await this.isQuarantined(row)) continue;
      const attrs = await this.resolveAttrs(row.attrs_json);
      const actual = await this.readObject(row);
      if (actual && tuplesMatch(attrs, actual)) continue; // no-op: skip the write
      await this.writeObject(row, attrs);
    }

    // 2. Remove strays inside the owned namespace.
    await this.deletePjsipStrays(desired);
    await this.deleteSccpStrays(desired);

    // A sweep proves the whole desired set is applied, so the cursor can jump
    // straight to the head of the op log.
    await this.advanceCursorToHead();
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'cursor_gap'");
  }

  private async readObject(row: DesiredRow): Promise<ConfigTuple[] | null> {
    const res = await this.ari(
      "GET",
      configUri(row.config_class, row.object_type, row.object_id),
    );
    if (res.status_code === 404) return null;
    if (res.status_code !== 200) {
      throw new Error(
        `GET ${row.object_type}/${row.object_id}: ${describeFailure(res)}`,
      );
    }
    return parseResponseBody<ConfigTuple[]>(res) ?? [];
  }

  private async writeObject(
    row: DesiredRow,
    attrs: ConfigTuple[],
  ): Promise<void> {
    const body: ConfigPutBody = { fields: attrs };
    const res = await this.ari(
      "PUT",
      configUri(row.config_class, row.object_type, row.object_id),
      { body },
    );
    if (res.status_code !== 200) {
      await this.recordFailure(row, res);
      throw new Error(
        `PUT ${row.object_type}/${row.object_id}: ${describeFailure(res)}`,
      );
    }
    await this.clearObjectFailure(row);
  }

  private async deleteObject(
    configClass: ConfigClass,
    objectType: ObjectType,
    objectId: string,
  ): Promise<void> {
    const res = await this.ari(
      "DELETE",
      configUri(configClass, objectType, objectId),
    );
    // 404 means it is already gone, which is the state we wanted.
    if (res.status_code !== 204 && res.status_code !== 200 && res.status_code !== 404) {
      throw new Error(
        `DELETE ${objectType}/${objectId}: ${describeFailure(res)}`,
      );
    }
  }

  /**
   * PJSIP stray detection.
   *
   * Object ids are bare extension numbers, so there is no owned namespace to
   * scan: `1001` in AstDB is indistinguishable by name from a hand-written
   * `1001` in the file layer. Ownership is therefore what this PBX last
   * successfully pushed — the local mirror — exactly as for SCCP.
   *
   * This is a narrower guarantee than the prefix scan it replaces. It cannot
   * reclaim an object orphaned by mirror loss (DO eviction with a storage
   * reset), which then sits in AstDB until removed by hand. The trade is
   * deliberate: the failure mode of a name-based scan over bare ids is deleting
   * a trunk, and nothing this PBX never wrote is now reachable by the sweep.
   *
   * Because the expansion gives auth, aor and endpoint the same id, one stray
   * endpoint id identifies all three.
   */
  private async deletePjsipStrays(desired: DesiredRow[]): Promise<void> {
    // The mirror still holds the previous pass's applied set at this point.
    const strays = pjsipStrays(desired, this.readMirror(), await this.fileLayerIds());

    for (const objectId of strays.protected) {
      // The mirror should never name a file-layer object, so reaching this is a
      // bug — but the cost of that bug is a dead trunk, which is worth one
      // redundant check and a loud line in the log.
      console.error(
        `pbx: refusing to delete PJSIP ${objectId} — it is defined in the file layer`,
      );
    }

    for (const objectId of strays.deletable) {
      // Reverse dependency order: endpoint, then aor, then auth.
      await this.deleteObject("res_pjsip", "endpoint", objectId);
      await this.deleteObject("res_pjsip", "aor", objectId);
      await this.deleteObject("res_pjsip", "auth", objectId);
    }
  }

  /**
   * Object ids this PBX must never delete: everything in the file layer.
   *
   * Trunks, transports and identifies live in `pjsip_static`, are rendered into
   * pjsip.conf and applied by hand, so they are not the reconciler's to remove.
   * With bare ids no naming rule separates them from managed extensions, which
   * makes this list the thing standing between a mirror bug and a dead trunk.
   */
  private async fileLayerIds(): Promise<Set<string>> {
    try {
      const res = await this.env.DB.prepare(
        "SELECT object_id FROM pjsip_static WHERE pbx_id = ?",
      )
        .bind(this.pbxId)
        .all<{ object_id: string }>();
      return new Set((res.results ?? []).map((r) => r.object_id));
    } catch (e) {
      // A protection list we could not load is not a licence to delete. Failing
      // the pass leaves strays in place, which is the recoverable direction.
      throw new Error(
        `cannot load the file-layer protection list: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * SCCP stray detection.
   *
   * chan_sccp2 never calls ast_endpoint_create, so GET /endpoints/SCCP returns
   * nothing and there is no ARI enumeration at all. The local mirror of the
   * previously-desired set is therefore the only inventory available.
   */
  private async deleteSccpStrays(desired: DesiredRow[]): Promise<void> {
    const wanted = new Set(
      desired
        .filter((d) => d.config_class === "chan_sccp2")
        .map((d) => `${d.object_type}/${d.object_id}`),
    );

    // The mirror still holds the previous pass's applied set at this point.
    const known = this.readMirror().filter(
      (r) => r.config_class === "chan_sccp2",
    );

    // Devices before lines: deleting a line a live device still binds fails
    // the reload.
    const strays = known.filter(
      (k) => !wanted.has(`${k.object_type}/${k.object_id}`),
    );
    for (const s of strays.filter((s) => s.object_type === "device")) {
      await this.deleteObject("chan_sccp2", "device", s.object_id);
    }
    for (const s of strays.filter((s) => s.object_type === "line")) {
      await this.deleteObject("chan_sccp2", "line", s.object_id);
    }
  }

  // ---------------------------------------------------------------------
  // Delta application
  // ---------------------------------------------------------------------

  private async applyDeltas(desired: DesiredRow[]): Promise<void> {
    const since = this.ackedSeq;
    const res = await this.env.DB.prepare(
      `SELECT seq, op, config_class, object_type, object_id
         FROM op_log WHERE pbx_id = ? AND seq > ? ORDER BY seq ASC LIMIT 5000`,
    )
      .bind(this.pbxId, since)
      .all<{
        seq: number;
        op: "upsert" | "delete";
        config_class: ConfigClass;
        object_type: ObjectType;
        object_id: string;
      }>();

    const ops = res.results ?? [];
    if (ops.length === 0) return;

    // Detect a pruned prefix: if the oldest surviving row is already beyond
    // our cursor + 1, rows we needed are gone and only a sweep can prove
    // convergence.
    const oldest = await this.env.DB.prepare(
      "SELECT MIN(seq) AS m FROM op_log WHERE pbx_id = ?",
    )
      .bind(this.pbxId)
      .first<{ m: number | null }>();
    if (oldest?.m != null && oldest.m > since + 1 && since !== 0) {
      this.setMeta("cursor_gap", "1");
      await this.fullSweep(desired);
      return;
    }

    await this.validateSccp(desired);

    // Coalesce to the last op per object: repeated edits collapse into one
    // write, which matters because every SCCP write triggers a complete
    // inventory reload and any material device change drops the phone.
    const latest = new Map<string, (typeof ops)[number]>();
    for (const op of ops) {
      latest.set(`${op.config_class}/${op.object_type}/${op.object_id}`, op);
    }

    const desiredByKey = new Map(
      desired.map((d) => [`${d.config_class}/${d.object_type}/${d.object_id}`, d]),
    );

    const upserts: DesiredRow[] = [];
    const deletes: { row: (typeof ops)[number]; rank: number }[] = [];

    for (const [key, op] of latest) {
      if (op.op === "delete") {
        deletes.push({ row: op, rank: rankOf(op.object_type) });
      } else {
        const d = desiredByKey.get(key);
        if (d) upserts.push(d);
      }
    }

    // Creates and updates ascending (dependencies first), deletes descending
    // (dependents first).
    upserts.sort((a, b) => a.dep_rank - b.dep_rank);
    deletes.sort((a, b) => b.rank - a.rank);

    const maxSeq = Math.max(...ops.map((o) => o.seq));

    for (const row of upserts) {
      if (await this.isQuarantined(row)) continue;
      const attrs = await this.resolveAttrs(row.attrs_json);

      // For SCCP, read before write: an identical re-PUT is a genuine no-op
      // (the reload diff is value-based), but any *material* change disconnects
      // the phone. Skipping unchanged objects is the difference between a
      // silent reconcile and re-registering the whole site.
      if (row.config_class === "chan_sccp2") {
        const actual = await this.readObject(row);
        if (actual && tuplesMatch(attrs, actual)) continue;
      }

      await this.writeObject(row, attrs);
    }

    for (const d of deletes) {
      await this.deleteObject(d.row.config_class, d.row.object_type, d.row.object_id);
    }

    // Only advance once the whole batch landed. A failure above throws, the
    // cursor stays put, and the retry re-runs the batch idempotently.
    this.setMeta("acked_seq", String(maxSeq));
  }

  private async advanceCursorToHead(): Promise<void> {
    try {
      const head = await this.env.DB.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS m FROM op_log WHERE pbx_id = ?",
      )
        .bind(this.pbxId)
        .first<{ m: number }>();
      this.setMeta("acked_seq", String(head?.m ?? 0));
    } catch {
      /* mirror-only mode; cursor stays where it is */
    }
  }

  // ---------------------------------------------------------------------
  // Validation & quarantine
  // ---------------------------------------------------------------------

  /**
   * Validate the whole SCCP candidate inventory before pushing any of it.
   *
   * chan_sccp2 acks 200 for writes whose subsequent reload fails, so a bad
   * object would look applied while silently poisoning every later reload.
   * Catching it here is the difference between a 400 we can report and a
   * warning buried in the Asterisk log.
   */
  private async validateSccp(desired: DesiredRow[]): Promise<void> {
    const sccp = desired.filter((d) => d.config_class === "chan_sccp2");
    if (sccp.length === 0) return;

    const profiles = await this.env.DB.prepare(
      "SELECT name FROM sccp_static WHERE pbx_id = ? AND section_type = 'softkey_profile'",
    )
      .bind(this.pbxId)
      .all<{ name: string }>();

    const softkeyProfiles = new Set(
      (profiles.results ?? []).map((p) => p.name),
    );
    softkeyProfiles.add("default"); // DEFAULT_SOFT_KEY_PROFILE, config/mod.rs:92

    const objects = await Promise.all(
      sccp.map(async (d) => ({
        objectType: d.object_type as "device" | "line",
        objectId: d.object_id,
        attrs: await this.resolveAttrs(d.attrs_json),
      })),
    );

    const issues = validateSccpInventory(objects, { softkeyProfiles });
    if (issues.length > 0) {
      const summary = issues
        .slice(0, 5)
        .map((i) => `${i.objectType}/${i.objectId}: ${i.code} — ${i.message}`)
        .join("; ");
      throw new Error(
        `SCCP inventory is invalid, refusing to push (${issues.length} issue${
          issues.length === 1 ? "" : "s"
        }): ${summary}`,
      );
    }
  }

  private async countQuarantined(): Promise<number> {
    try {
      const row = await this.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM quarantine WHERE pbx_id = ? AND attempts >= ?",
      )
        .bind(this.pbxId, QUARANTINE_AFTER)
        .first<{ n: number }>();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  private async isQuarantined(row: DesiredRow): Promise<boolean> {
    const q = await this.env.DB.prepare(
      `SELECT attempts FROM quarantine
        WHERE pbx_id = ? AND config_class = ? AND object_type = ? AND object_id = ?`,
    )
      .bind(this.pbxId, row.config_class, row.object_type, row.object_id)
      .first<{ attempts: number }>();
    return (q?.attempts ?? 0) >= QUARANTINE_AFTER;
  }

  private async recordFailure(row: DesiredRow, res: RestResponse): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO quarantine (pbx_id, config_class, object_type, object_id,
                               attempts, status_code, reason)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(pbx_id, config_class, object_type, object_id) DO UPDATE SET
         attempts = quarantine.attempts + 1,
         status_code = excluded.status_code,
         reason = excluded.reason,
         last_failed_at = datetime('now')`,
    )
      .bind(
        this.pbxId,
        row.config_class,
        row.object_type,
        row.object_id,
        res.status_code,
        describeFailure(res),
      )
      .run();
  }

  private async clearObjectFailure(row: DesiredRow): Promise<void> {
    await this.env.DB.prepare(
      `DELETE FROM quarantine
        WHERE pbx_id = ? AND config_class = ? AND object_type = ? AND object_id = ?`,
    )
      .bind(this.pbxId, row.config_class, row.object_type, row.object_id)
      .run();
  }
}

function rankOf(objectType: string): number {
  switch (objectType) {
    case "auth":
    case "line":
      return 10;
    case "aor":
    case "device":
      return 20;
    case "endpoint":
      return 30;
    default:
      return 0;
  }
}

/**
 * Does the PBX already hold every attribute we care about?
 *
 * A GET returns the object's *full* flattened attribute list including
 * defaults, while the desired state is a subset. So this asks "is every
 * desired attribute already correct", not "are the two sets equal" — extra
 * attributes on the box are defaults we do not manage.
 */
/**
 * Which PJSIP endpoint ids a sweep may delete, and which it must refuse.
 *
 * Pure and exported because this is the one calculation in the reconciler whose
 * failure mode is destructive: getting it wrong deletes a live trunk. Ownership
 * is mirror-minus-desired — only objects this PBX previously pushed are ever
 * candidates — and `protectedIds` is a second, independent rail over the file
 * layer. Anything appearing in both is reported rather than deleted, because
 * that combination means the mirror is wrong and silence would hide it.
 */
export function pjsipStrays(
  desired: { config_class: string; object_type: string; object_id: string }[],
  mirror: { config_class: string; object_type: string; object_id: string }[],
  protectedIds: Set<string>,
): { deletable: string[]; protected: string[] } {
  const isEndpoint = (r: { config_class: string; object_type: string }) =>
    r.config_class === "res_pjsip" && r.object_type === "endpoint";

  const wanted = new Set(desired.filter(isEndpoint).map((d) => d.object_id));

  const deletable: string[] = [];
  const blocked: string[] = [];
  for (const row of mirror.filter(isEndpoint)) {
    if (wanted.has(row.object_id)) continue;
    if (protectedIds.has(row.object_id)) blocked.push(row.object_id);
    else deletable.push(row.object_id);
  }
  return { deletable, protected: blocked };
}

export function tuplesMatch(
  desired: ConfigTuple[],
  actual: ConfigTuple[],
): boolean {
  const have = new Map(actual.map((t) => [t.attribute.toLowerCase(), t.value]));
  for (const t of desired) {
    if (have.get(t.attribute.toLowerCase()) !== t.value) return false;
  }
  return true;
}
