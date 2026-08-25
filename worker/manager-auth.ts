const MANAGER_SESSION_PATH = "/api/manager/session";
const MANAGER_LOGIN_PATH = "/manager-login.html";
const MANAGER_PAGE_PATHS = new Set(["/manager", "/manager/", "/manager.html"]);
const MANAGER_COOKIE = "__Host-lucky-manager-session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_BODY_LIMIT_BYTES = 4 * 1024;
const MIN_MANAGER_TOKEN_BYTES = 32;
const MAX_MANAGER_TOKEN_BYTES = 4 * 1024;
const MIN_MANAGER_PASSWORD_BYTES = 8;
const KEY_DERIVATION_CONTEXT = "Lucky manager session signing key\u0000v1";
const SIGNATURE_CONTEXT = "Lucky manager session cookie\u0000v1\u0000";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function canonicalPathname(pathname: string): string | null {
  let current = pathname;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) return decoded;
    current = decoded;
  }
  return null;
}

export type ManagerAuthEnv = {
  MANAGER_TOKEN?: string;
  MANAGER_PASSWORD?: string;
};

export type ManagerSession = {
  issuedAt: number;
  expiresAt: number;
};

type SessionPayload = {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
  host: string;
};

function authJson(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, private");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(payload), { status, headers });
}

function authError(message: string, status: number, extraHeaders?: HeadersInit): Response {
  return authJson({ error: message }, status, extraHeaders);
}

function configuredManagerToken(env: ManagerAuthEnv): string | null {
  if (typeof env.MANAGER_TOKEN !== "string") return null;
  const byteLength = encoder.encode(env.MANAGER_TOKEN).byteLength;
  return byteLength >= MIN_MANAGER_TOKEN_BYTES && byteLength <= MAX_MANAGER_TOKEN_BYTES
    ? env.MANAGER_TOKEN
    : null;
}

function configuredManagerPassword(env: ManagerAuthEnv): string | null {
  if (env.MANAGER_PASSWORD === undefined) return configuredManagerToken(env);
  if (typeof env.MANAGER_PASSWORD !== "string") return null;
  const byteLength = encoder.encode(env.MANAGER_PASSWORD).byteLength;
  return byteLength >= MIN_MANAGER_PASSWORD_BYTES && byteLength <= MAX_MANAGER_TOKEN_BYTES
    ? env.MANAGER_PASSWORD
    : null;
}

export function isManagerAuthConfigured(env: ManagerAuthEnv): boolean {
  return configuredManagerToken(env) !== null && configuredManagerPassword(env) !== null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string, maxBytes: number): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maxBytes * 4 / 3) + 4) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    if (binary.length > maxBytes) return null;
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
    return result;
  } catch {
    return null;
  }
}

async function deriveSessionSigningKey(managerToken: string): Promise<CryptoKey> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(managerToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derivedBytes = await crypto.subtle.sign("HMAC", rootKey, encoder.encode(KEY_DERIVATION_CONTEXT));
  return crypto.subtle.importKey(
    "raw",
    derivedBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function managerTokenMatches(candidate: string, expected: string): Promise<boolean> {
  const candidateBytes = encoder.encode(candidate);
  if (candidateBytes.byteLength < 1 || candidateBytes.byteLength > MAX_MANAGER_TOKEN_BYTES) return false;
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", candidateBytes),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function issueManagerSession(request: Request, managerToken: string): Promise<{ value: string; session: ManagerSession }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const payload: SessionPayload = {
    v: 1,
    iat: issuedAt,
    exp: expiresAt,
    nonce: randomNonce(),
    host: new URL(request.url).host,
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signingKey = await deriveSessionSigningKey(managerToken);
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    encoder.encode(SIGNATURE_CONTEXT + encodedPayload),
  );
  return {
    value: `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`,
    session: { issuedAt, expiresAt },
  };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8 * 1024) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values.length === 1 ? values[0] : null;
}

function sessionCookie(value: string, maxAge = SESSION_TTL_SECONDS): string {
  return [
    `${MANAGER_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function expiredSessionCookie(): string {
  return [
    `${MANAGER_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

export function strictSameOriginError(request: Request): Response | null {
  const requestOrigin = new URL(request.url).origin;
  if (request.headers.get("origin") !== requestOrigin) {
    return authError("Cross-origin manager requests are not allowed", 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return authError("Cross-origin manager requests are not allowed", 403);
  }
  return null;
}

export async function verifyManagerSession(request: Request, env: ManagerAuthEnv): Promise<ManagerSession | null> {
  const managerToken = configuredManagerToken(env);
  if (!managerToken) return null;
  const cookie = readCookie(request, MANAGER_COOKIE);
  if (!cookie || cookie.length > 2 * 1024) return null;
  const parts = cookie.split(".");
  if (parts.length !== 2) return null;

  const payloadBytes = base64UrlToBytes(parts[0], 1024);
  const signatureBytes = base64UrlToBytes(parts[1], 64);
  if (!payloadBytes || !signatureBytes || signatureBytes.byteLength !== 32) return null;

  const signingKey = await deriveSessionSigningKey(managerToken);
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    signingKey,
    signatureBytes,
    encoder.encode(SIGNATURE_CONTEXT + parts[0]),
  );
  if (!signatureValid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as Partial<SessionPayload>;
  if (
    candidate.v !== 1
    || typeof candidate.iat !== "number"
    || typeof candidate.exp !== "number"
    || !Number.isSafeInteger(candidate.iat)
    || !Number.isSafeInteger(candidate.exp)
    || typeof candidate.nonce !== "string"
    || !/^[A-Za-z0-9_-]{22}$/.test(candidate.nonce)
    || candidate.host !== new URL(request.url).host
  ) return null;

  const issuedAt = Number(candidate.iat);
  const expiresAt = Number(candidate.exp);
  const now = Math.floor(Date.now() / 1000);
  if (
    issuedAt > now + 60
    || expiresAt <= now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > SESSION_TTL_SECONDS
  ) return null;
  return { issuedAt, expiresAt };
}

async function readBodyWithinLimit(request: Request, limit: number): Promise<string | null> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const bodyDecoder = new TextDecoder();
  let result = "";
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch { /* the size limit still applies */ }
      return null;
    }
    result += bodyDecoder.decode(chunk.value, { stream: true });
  }
  return result + bodyDecoder.decode();
}

async function readLoginCredential(request: Request): Promise<string | null> {
  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength.trim()) || Number(contentLength) > LOGIN_BODY_LIMIT_BYTES)) {
    return null;
  }
  const raw = await readBodyWithinLimit(request, LOGIN_BODY_LIMIT_BYTES);
  if (raw === null) return null;
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const password = (body as { password?: unknown }).password;
    return typeof password === "string" ? password : null;
  } catch {
    return null;
  }
}

export async function handleManagerAuthApi(request: Request, env: ManagerAuthEnv): Promise<Response | null> {
  const pathname = canonicalPathname(new URL(request.url).pathname);
  if (pathname === null) return authError("The request path is invalid", 400);
  if (pathname !== MANAGER_SESSION_PATH) return null;

  if (request.method === "GET") {
    if (!isManagerAuthConfigured(env)) return authError("Manager authentication is not configured", 503);
    const session = await verifyManagerSession(request, env);
    if (!session) {
      return authJson({ authenticated: false }, 401, { "set-cookie": expiredSessionCookie() });
    }
    return authJson({ authenticated: true, expiresAt: session.expiresAt });
  }

  if (request.method === "POST") {
    const originError = strictSameOriginError(request);
    if (originError) return originError;
    const managerToken = configuredManagerToken(env);
    const managerPassword = configuredManagerPassword(env);
    if (!managerToken || !managerPassword) return authError("Manager authentication is not configured", 503);
    const candidate = await readLoginCredential(request);
    if (candidate === null) return authError("The login request is invalid", 400);
    if (!(await managerTokenMatches(candidate, managerPassword))) return authError("Manager credentials are invalid", 401);
    const { value, session } = await issueManagerSession(request, managerToken);
    return authJson(
      { authenticated: true, expiresAt: session.expiresAt },
      200,
      { "set-cookie": sessionCookie(value) },
    );
  }

  if (request.method === "DELETE") {
    const originError = strictSameOriginError(request);
    if (originError) return originError;
    return authJson(
      { authenticated: false },
      200,
      { "set-cookie": expiredSessionCookie() },
    );
  }

  return authJson({ error: "Method not allowed" }, 405, { allow: "GET, POST, DELETE" });
}

export function isManagerPagePath(pathname: string): boolean {
  const canonical = canonicalPathname(pathname);
  return canonical !== null && MANAGER_PAGE_PATHS.has(canonical);
}

export function isManagerLoginPagePath(pathname: string): boolean {
  return canonicalPathname(pathname) === MANAGER_LOGIN_PATH;
}

function securedPageResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, private");
  headers.set("pragma", "no-cache");
  // `Vary: *` also prevents the current service worker's generic Cache.put
  // path from retaining an authenticated manager document.
  headers.set("vary", "*");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-security-policy", "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleManagerPageGate(request: Request, env: ManagerAuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = canonicalPathname(url.pathname);
  if (pathname === null) {
    return securedPageResponse(new Response("Bad request", { status: 400 }));
  }
  const managerPage = MANAGER_PAGE_PATHS.has(pathname);
  const loginPage = pathname === MANAGER_LOGIN_PATH;
  if (!managerPage && !loginPage) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return securedPageResponse(new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }));
  }

  const session = await verifyManagerSession(request, env);
  if (managerPage && !session) {
    return securedPageResponse(Response.redirect(new URL(MANAGER_LOGIN_PATH, request.url), 302));
  }
  if (managerPage && session && (pathname !== "/manager.html" || url.pathname !== pathname)) {
    return securedPageResponse(Response.redirect(new URL("/manager.html", request.url), 302));
  }
  if (loginPage && session) {
    return securedPageResponse(Response.redirect(new URL("/manager.html", request.url), 302));
  }
  if (loginPage && url.pathname !== pathname) {
    return securedPageResponse(Response.redirect(new URL(MANAGER_LOGIN_PATH, request.url), 302));
  }
  return null;
}

export function secureManagerPageResponse(response: Response): Response {
  return securedPageResponse(response);
}
