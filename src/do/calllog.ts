/**
 * Call log, reconstructed from the ARI event stream.
 *
 * There is no CDR event type in ARI — 57 event models, none of them
 * accounting — and Asterisk ships no HTTP CDR backend. What makes this work
 * is that `ari.conf` `channelvars` entries containing `(` are invoked as
 * dialplan *functions* (main/channel.c:7885-7887, :8009), so `CDR(billsec)`
 * and friends ride along inside `channel.channelvars` on every channel event.
 *
 * Two caveats are baked into the rendered config rather than handled here:
 *
 *   - `cdr.conf` must set `endbeforehexten = yes`. It defaults to `no`, and
 *     `cdr_object_finalize()` is the only place `disposition` and `end` are
 *     set — so without it an answered call reports disposition NO ANSWER.
 *   - Events are lost while the socket is down; Asterisk does not replay them.
 *     This is a call log, not a billing record, and is scoped as such.
 */

import type { AriEvent } from "../ari/envelope.js";

interface ChannelSnapshot {
  id: string;
  name?: string;
  state?: string;
  caller?: { name?: string; number?: string };
  connected?: { name?: string; number?: string };
  dialplan?: { context?: string; exten?: string; app_name?: string };
  creationtime?: string;
  channelvars?: Record<string, string>;
}

/**
 * Recover an extension from a channel name when the CDR fields are degenerate.
 * Ported from v1 (cdr_handler.go:201-211), which hit this with outbound faxes
 * where src came through as "fax" and dst as "s".
 *
 * "PJSIP/aem-1001-00000002" -> "aem-1001";  "SCCP/1001-0000002a" -> "1001"
 */
export function extensionFromChannelName(name: string | undefined): string | null {
  if (!name) return null;
  const slash = name.indexOf("/");
  if (slash < 0) return null;
  const rest = name.slice(slash + 1);
  const dash = rest.lastIndexOf("-");
  return (dash > 0 ? rest.slice(0, dash) : rest) || null;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Empty, "s", and "unknown" are all "no useful value" in practice. */
function meaningful(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (t === "" || t === "s" || t === "unknown" || t === "<unknown>") return null;
  return t;
}

export async function ingestChannelEvent(
  db: D1Database,
  pbxId: string,
  event: AriEvent,
): Promise<void> {
  if (!pbxId) return;

  const channel = event["channel"] as ChannelSnapshot | undefined;
  if (!channel?.id) return;

  // v1 skipped AppDial B-leg records because they duplicate the A-leg with no
  // extra information (cdr_handler.go:160-163). Same reasoning here.
  if (channel.dialplan?.app_name === "AppDial") return;

  switch (event.type) {
    case "ChannelCreated":
      await upsertCreated(db, pbxId, channel);
      return;
    case "ChannelStateChange":
      if (channel.state === "Up") await markAnswered(db, pbxId, channel);
      return;
    case "ChannelDestroyed":
      await finalize(db, pbxId, channel, event);
      return;
    default:
      return;
  }
}

async function upsertCreated(
  db: D1Database,
  pbxId: string,
  ch: ChannelSnapshot,
): Promise<void> {
  const src =
    meaningful(ch.caller?.number) ?? extensionFromChannelName(ch.name) ?? null;
  const dst = meaningful(ch.dialplan?.exten) ?? null;

  await db
    .prepare(
      `INSERT INTO call_leg (pbx_id, channel_id, channel_name, src, dst, dcontext, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pbx_id, channel_id) DO UPDATE SET
         channel_name = excluded.channel_name,
         src = COALESCE(excluded.src, call_leg.src),
         dst = COALESCE(excluded.dst, call_leg.dst)`,
    )
    .bind(
      pbxId,
      ch.id,
      ch.name ?? null,
      src,
      dst,
      ch.dialplan?.context ?? null,
      ch.creationtime ?? new Date().toISOString(),
    )
    .run();
}

async function markAnswered(
  db: D1Database,
  pbxId: string,
  ch: ChannelSnapshot,
): Promise<void> {
  await db
    .prepare(
      `UPDATE call_leg SET answered_at = COALESCE(answered_at, ?)
        WHERE pbx_id = ? AND channel_id = ?`,
    )
    .bind(new Date().toISOString(), pbxId, ch.id)
    .run();
}

async function finalize(
  db: D1Database,
  pbxId: string,
  ch: ChannelSnapshot,
  event: AriEvent,
): Promise<void> {
  const vars = ch.channelvars ?? {};

  const src =
    meaningful(vars["CDR(src)"]) ??
    meaningful(ch.caller?.number) ??
    extensionFromChannelName(ch.name);
  const dst = meaningful(vars["CDR(dst)"]) ?? meaningful(ch.dialplan?.exten);

  await db
    .prepare(
      `INSERT INTO call_leg (pbx_id, channel_id, channel_name, linkedid, src, dst,
                             dcontext, started_at, answered_at, ended_at,
                             disposition, billsec, duration, cause, cause_txt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pbx_id, channel_id) DO UPDATE SET
         linkedid    = COALESCE(excluded.linkedid, call_leg.linkedid),
         src         = COALESCE(excluded.src, call_leg.src),
         dst         = COALESCE(excluded.dst, call_leg.dst),
         answered_at = COALESCE(call_leg.answered_at, excluded.answered_at),
         ended_at    = excluded.ended_at,
         disposition = excluded.disposition,
         billsec     = excluded.billsec,
         duration    = excluded.duration,
         cause       = excluded.cause,
         cause_txt   = excluded.cause_txt`,
    )
    .bind(
      pbxId,
      ch.id,
      ch.name ?? null,
      meaningful(vars["CDR(linkedid)"]),
      src,
      dst,
      ch.dialplan?.context ?? null,
      meaningful(vars["CDR(start)"]) ?? ch.creationtime ?? null,
      meaningful(vars["CDR(answer)"]),
      meaningful(vars["CDR(end)"]) ?? event.timestamp ?? new Date().toISOString(),
      meaningful(vars["CDR(disposition)"]),
      num(vars["CDR(billsec)"]),
      num(vars["CDR(duration)"]),
      typeof event["cause"] === "number" ? event["cause"] : null,
      typeof event["cause_txt"] === "string" ? event["cause_txt"] : null,
    )
    .run();
}
