/**
 * ARI REST-over-WebSocket envelopes.
 *
 * Verified against Asterisk 23.5.0 rest-api/api-docs/events.json. Three things
 * about this protocol regularly cost people an afternoon:
 *
 *   1. `uri` must NOT have a leading slash. "/channels/x" yields 405.
 *   2. The payload fields are `content_type` + `message_body` on BOTH the
 *      request and the response. There is no `headers` field and no
 *      `response_body` field, despite what you might expect from the HTTP API.
 *   3. `transaction_id` / `request_id` are echoed verbatim, and if omitted in
 *      the request they come back as empty strings rather than being absent.
 *
 * Two operations are unavailable over this transport: binary payloads
 * (recordings) return 406 "Use HTTP GET", and `GET events` returns 400
 * "Can't upgrade to a websocket from a websocket".
 */

export interface RestQueryParam {
  name: string;
  value: string;
}

export interface RestRequest {
  type: "RESTRequest";
  transaction_id?: string;
  request_id?: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** No leading slash. e.g. "asterisk/config/dynamic/res_pjsip/aor/aem-1001" */
  uri: string;
  query_strings?: RestQueryParam[];
  content_type?: string;
  message_body?: string;
}

export interface RestResponse {
  type: "RESTResponse";
  transaction_id: string;
  request_id: string;
  status_code: number;
  reason_phrase: string;
  uri: string;
  content_type?: string;
  message_body?: string;
  timestamp?: string;
  asterisk_id?: string;
  application?: string;
}

/** Any inbound frame: either a REST response or a Stasis event. */
export interface AriEvent {
  type: string;
  application?: string;
  timestamp?: string;
  asterisk_id?: string;
  [k: string]: unknown;
}

export function isRestResponse(msg: { type?: string }): msg is RestResponse {
  return msg.type === "RESTResponse";
}

/** Build the dynamic-configuration URI for a sorcery object. */
export function configUri(
  configClass: string,
  objectType: string,
  objectId: string,
): string {
  // All three path segments are case-sensitive. Ids can contain characters
  // that need escaping (SCCP ids are constrained, but PJSIP ids are not).
  return `asterisk/config/dynamic/${configClass}/${objectType}/${encodeURIComponent(objectId)}`;
}

export function buildRequest(
  requestId: string,
  method: RestRequest["method"],
  uri: string,
  opts: {
    query?: RestQueryParam[];
    body?: unknown;
    transactionId?: string;
  } = {},
): RestRequest {
  const req: RestRequest = {
    type: "RESTRequest",
    request_id: requestId,
    method,
    uri,
  };
  if (opts.transactionId) req.transaction_id = opts.transactionId;
  if (opts.query?.length) req.query_strings = opts.query;
  if (opts.body !== undefined) {
    req.content_type = "application/json";
    req.message_body = JSON.stringify(opts.body);
  }
  return req;
}

/** PUT body shape for ARI dynamic configuration. */
export interface ConfigPutBody {
  fields: { attribute: string; value: string }[];
}

export function parseResponseBody<T>(res: RestResponse): T | null {
  if (!res.message_body) return null;
  try {
    return JSON.parse(res.message_body) as T;
  } catch {
    return null;
  }
}

/**
 * Asterisk returns 400 for both "a field value was rejected" and "the apply
 * handler vetoed the object" — same code, same message, no way to tell them
 * apart from the response alone. Worth distinguishing from a 403 (the wizard
 * itself refused, which almost always means sorcery.conf is not mapping this
 * type to a writable wizard).
 */
export function describeFailure(res: RestResponse): string {
  const detail = res.message_body ? ` ${res.message_body}` : "";
  switch (res.status_code) {
    case 400:
      return `validation rejected (bad field value or apply handler veto):${detail}`;
    case 403:
      return `wizard refused — check sorcery.conf maps this type to the astdb wizard:${detail}`;
    case 404:
      return `not found:${detail}`;
    case 500:
      return `internal error — an existing object may be failing its own apply handler:${detail}`;
    default:
      return `${res.status_code} ${res.reason_phrase}:${detail}`;
  }
}
