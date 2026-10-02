/**
 * CiscoIPPhoneDirectory XML.
 *
 * Note this only matters for PJSIP-attached Cisco sets: chan_sccp2 already
 * serves /sccp/directory itself from the PBX's own HTTP server
 * (src/http/directory.rs:30), so SCCP phones never come here.
 */

import { toAscii, xmlEscape } from "../lib/ascii.js";

const PAGE_SIZE = 32; // 7900-series sets choke on much more than this

export async function renderDirectoryXml(
  db: D1Database,
  pbxId: string,
  url: URL,
): Promise<Response> {
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

  const res = await db
    .prepare(
      `SELECT number, display_name FROM extension
        WHERE pbx_id = ? ORDER BY number LIMIT ? OFFSET ?`,
    )
    .bind(pbxId, PAGE_SIZE + 1, offset)
    .all<{ number: string; display_name: string }>();

  const rows = res.results ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const lines = [
    '<?xml version="1.0" encoding="ISO-8859-1"?>',
    "<CiscoIPPhoneDirectory>",
    "<Title>Directory</Title>",
    "<Prompt>Select an entry</Prompt>",
  ];

  for (const row of page) {
    // Fold to ASCII before escaping: the phone renders a legacy code page and
    // would otherwise mangle Nordic characters.
    const name = xmlEscape(toAscii(row.display_name || row.number));
    lines.push(
      "<DirectoryEntry>",
      `<Name>${name}</Name>`,
      `<Telephone>${xmlEscape(row.number)}</Telephone>`,
      "</DirectoryEntry>",
    );
  }

  if (hasMore) {
    const next = new URL(url);
    next.searchParams.set("offset", String(offset + PAGE_SIZE));
    lines.push(
      "<SoftKeyItem>",
      "<Name>Next</Name>",
      "<Position>2</Position>",
      `<URL>${xmlEscape(next.toString())}</URL>`,
      "</SoftKeyItem>",
    );
  }

  lines.push("</CiscoIPPhoneDirectory>");

  return new Response(lines.join("\n"), {
    headers: {
      // Cisco sets require both the charset and an explicit Content-Length.
      "Content-Type": "text/xml; charset=ISO-8859-1",
      "Cache-Control": "no-cache",
    },
  });
}
