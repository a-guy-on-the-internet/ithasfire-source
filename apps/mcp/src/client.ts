/**
 * tRPC HTTP client for the Ithas Fire API.
 *
 * The API uses superjson as its tRPC transformer, so inputs are wrapped as
 * `{"json": <value>}` and outputs are read from `result.data.json`.
 *
 * Auth (in priority order):
 *   1. ITHASFIRE_API_KEY  → sent as x-api-key header (long-lived, recommended for automation)
 *   2. ITHASFIRE_SESSION_TOKEN → sent as Authorization: Bearer (short-lived session cookie)
 *
 * To generate an API key: call the apiKeys.create tRPC procedure as an
 * authenticated user, then set ITHASFIRE_API_KEY to the returned key value.
 */

const API_URL = (
  process.env.ITHASFIRE_API_URL ?? "http://localhost:3001"
).replace(/\/$/, "");
const API_KEY = process.env.ITHASFIRE_API_KEY ?? "";
const SESSION_TOKEN = process.env.ITHASFIRE_SESSION_TOKEN ?? "";

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  } else if (SESSION_TOKEN) {
    headers["Authorization"] = `Bearer ${SESSION_TOKEN}`;
  }
  return headers;
}

function parseBody(body: unknown, path: string): unknown {
  if (
    typeof body !== "object" ||
    body === null ||
    !("result" in body) ||
    typeof (body as Record<string, unknown>).result !== "object"
  ) {
    throw new Error(`Unexpected tRPC response shape for ${path}`);
  }
  const result = (body as { result: Record<string, unknown> }).result;
  const data = result.data as Record<string, unknown> | undefined;
  return data?.json;
}

export async function trpcQuery<T>(path: string, input: unknown): Promise<T> {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  const url = `${API_URL}/trpc/${path}?input=${encoded}`;
  const res = await fetch(url, { headers: buildHeaders() });
  const body = (await res.json()) as Record<string, unknown>;
  if (body["error"]) {
    const err = body["error"] as Record<string, unknown>;
    const msg =
      (err["json"] as Record<string, unknown> | undefined)?.["message"] ??
      `tRPC error on ${path}`;
    throw new Error(String(msg));
  }
  return parseBody(body, path) as T;
}

export async function trpcMutation<T>(
  path: string,
  input: unknown,
): Promise<T> {
  const url = `${API_URL}/trpc/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ json: input }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (body["error"]) {
    const err = body["error"] as Record<string, unknown>;
    const msg =
      (err["json"] as Record<string, unknown> | undefined)?.["message"] ??
      `tRPC error on ${path}`;
    throw new Error(String(msg));
  }
  return parseBody(body, path) as T;
}
