import {
  strictSameOriginError,
  verifyManagerSession,
  type ManagerAuthEnv,
} from "./manager-auth";
import {
  MANAGER_SUPPORT_PATH,
  MANAGER_TICKET_LIMIT_MAX,
  listManagerSupportTickets,
  parseManagerSupportUpdate,
  parseSupportKind,
  parseSupportStatus,
  updateManagerSupportTicket,
} from "./support-storage";

const MANAGER_SUPPORT_BODY_LIMIT_BYTES = 8 * 1024;

export type ManagerSupportEnv = ManagerAuthEnv & { DB?: D1Database };

function json(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, private");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(payload), { status, headers });
}

function error(message: string, status: number, code?: string, extraHeaders?: HeadersInit): Response {
  return json({ error: message, ...(code ? { code } : {}) }, status, extraHeaders);
}

async function readBodyWithinLimit(request: Request, limit: number): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength.trim()) || Number(contentLength) > limit)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch { /* the body limit still applies */ }
      return null;
    }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  return raw + decoder.decode();
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const raw = await readBodyWithinLimit(request, MANAGER_SUPPORT_BODY_LIMIT_BYTES);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseLimit(value: string | null): number | null {
  if (value === null || value === "") return 50;
  if (!/^\d{1,3}$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MANAGER_TICKET_LIMIT_MAX ? limit : null;
}

function missingPlayerTables(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /no such table:\s*(?:player_account|player_support_ticket)/i.test(message);
}

export async function handleManagerSupportApi(
  request: Request,
  env: ManagerSupportEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== MANAGER_SUPPORT_PATH) return null;
  if (request.method !== "GET" && request.method !== "PATCH") {
    return error("Method not allowed", 405, undefined, { allow: "GET, PATCH" });
  }
  if (request.method === "PATCH") {
    const originError = strictSameOriginError(request);
    if (originError) return originError;
  }
  if (!(await verifyManagerSession(request, env))) {
    return error("Manager session is invalid or expired", 401, "unauthenticated");
  }
  if (!env.DB) return error("Support storage is unavailable", 503, "not_configured");

  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const rawStatus = url.searchParams.get("status");
      const rawKind = url.searchParams.get("kind");
      const status = rawStatus === null || rawStatus === "all" ? null : parseSupportStatus(rawStatus);
      const kind = rawKind === null || rawKind === "all" ? null : parseSupportKind(rawKind);
      const limit = parseLimit(url.searchParams.get("limit"));
      if ((rawStatus !== null && rawStatus !== "all" && !status)
        || (rawKind !== null && rawKind !== "all" && !kind)
        || limit === null) {
        return error("Support filters are invalid", 400, "invalid_filter");
      }
      const tickets = await listManagerSupportTickets(env.DB, { status, kind, limit });
      return json({ tickets });
    }

    const body = await readJsonBody(request);
    const update = parseManagerSupportUpdate(body);
    if (!update) return error("Support update is invalid", 422, "invalid_support_update");
    const ticket = await updateManagerSupportTicket(env.DB, update);
    return ticket
      ? json({ ticket })
      : error("Support ticket was not found", 404, "not_found");
  } catch (cause) {
    if (request.method === "GET" && missingPlayerTables(cause)) return json({ tickets: [] });
    console.error("manager-support", cause instanceof Error ? cause.message : cause);
    return error("Support storage is temporarily unavailable", 503, "storage_unavailable");
  }
}
