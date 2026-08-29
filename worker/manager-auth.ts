const MANAGER_SESSION_PATH = "/api/manager/session";
const MANAGER_LOGIN_PATH = "/manager-login.html";
const DEFAULT_MANAGER_USERNAME = "Admin";
const MANAGER_PAGE_PATHS = new Set(["/manager", "/manager/", "/manager.html"]);
const MANAGER_COOKIE = "__Host-lucky-manager-session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_BODY_LIMIT_BYTES = 4 * 1024;
const MIN_MANAGER_TOKEN_BYTES = 32;
const MAX_MANAGER_TOKEN_BYTES = 4 * 1024;
const MIN_MANAGER_PASSWORD_BYTES = 8;
const MANAGER_PASSWORD_PATH = "/api/manager/password";
const MANAGER_USERNAME_PATH = "/api/manager/username";
const MIN_MANAGER_USERNAME_LENGTH = 3;
const MAX_MANAGER_USERNAME_LENGTH = 32;
const MIN_CHANGED_PASSWORD_LENGTH = 10;
const MAX_CHANGED_PASSWORD_LENGTH = 128;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_HASH_ALGORITHM = "hmac-sha256-v1";
const PASSWORD_HASH_CONTEXT = "Lucky manager password hash\u0000v1\u0000";
const MANAGER_SECRET_KEY = "manager";
const MANAGER_ACCOUNT_KEY = "manager";
const LOGIN_THROTTLE_MAX_FAILURES = 5;
const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_THROTTLE_KEY_CONTEXT = "Lucky manager login throttle\u0000v1\u0000";
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
  DB?: D1Database;
};

export type ManagerSession = {
  issuedAt: number;
  expiresAt: number;
};

type SessionPayload = {
  v: 2;
  iat: number;
  exp: number;
  nonce: string;
  host: string;
  revision: string;
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

async function managerLoginThrottleKey(request: Request, normalizedUsername: string, managerToken: string): Promise<string> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(managerToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() || "unknown";
  const digest = await crypto.subtle.sign(
    "HMAC",
    rootKey,
    encoder.encode(`${LOGIN_THROTTLE_KEY_CONTEXT}${connectingIp}\u0000${normalizedUsername}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function issueManagerSession(request: Request, managerToken: string, revision: string): Promise<{ value: string; session: ManagerSession }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const payload: SessionPayload = {
    v: 2,
    iat: issuedAt,
    exp: expiresAt,
    nonce: randomNonce(),
    host: new URL(request.url).host,
    revision,
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
    candidate.v !== 2
    || typeof candidate.iat !== "number"
    || typeof candidate.exp !== "number"
    || !Number.isSafeInteger(candidate.iat)
    || !Number.isSafeInteger(candidate.exp)
    || typeof candidate.nonce !== "string"
    || !/^[A-Za-z0-9_-]{22}$/.test(candidate.nonce)
    || candidate.host !== new URL(request.url).host
    || typeof candidate.revision !== "string"
    || !/^\d+:\d+$/.test(candidate.revision)
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
  let currentRevision: string;
  try {
    currentRevision = await readManagerAuthRevision(env);
  } catch {
    return null;
  }
  if (candidate.revision !== currentRevision) return null;
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

async function readLoginCredentials(request: Request): Promise<{ username: string; password: string } | null> {
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
    const username = (body as { username?: unknown }).username;
    const password = (body as { password?: unknown }).password;
    return typeof username === "string" && typeof password === "string"
      ? { username: username.trim(), password }
      : null;
  } catch {
    return null;
  }
}

const CREATE_MANAGER_SECRET_TABLE = `
  CREATE TABLE IF NOT EXISTS manager_secret (
    key TEXT PRIMARY KEY NOT NULL,
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID
`;
let managerSecretSchemaReady: Promise<void> | null = null;

async function ensureManagerSecretTable(db: D1Database): Promise<void> {
  if (!managerSecretSchemaReady) {
    managerSecretSchemaReady = db.prepare(CREATE_MANAGER_SECRET_TABLE).run().then(() => undefined).catch((cause) => {
      managerSecretSchemaReady = null;
      throw cause;
    });
  }
  await managerSecretSchemaReady;
}

type StoredManagerPassword = { hash: string; salt: string; algorithm: string; updatedAt: number };

type ManagerUsername = { username: string; normalized: string };
type StoredManagerAccount = { username: string; usernameNormalized: string; updatedAt: number };

const CREATE_MANAGER_ACCOUNT_TABLE = `
  CREATE TABLE IF NOT EXISTS manager_account (
    key TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID
`;
let managerAccountSchemaReady: Promise<void> | null = null;

type StoredManagerLoginThrottle = { failedAttempts: number; windowStartedAt: number };

const CREATE_MANAGER_LOGIN_THROTTLE_TABLE = `
  CREATE TABLE IF NOT EXISTS manager_login_throttle (
    key TEXT PRIMARY KEY NOT NULL,
    failed_attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID
`;
let managerLoginThrottleSchemaReady: Promise<void> | null = null;

function parseManagerUsername(value: unknown): ManagerUsername | null {
  if (typeof value !== "string") return null;
  const username = value.trim();
  if (
    username.length < MIN_MANAGER_USERNAME_LENGTH
    || username.length > MAX_MANAGER_USERNAME_LENGTH
    || !/^[A-Za-z][A-Za-z0-9_]*$/.test(username)
  ) return null;
  return { username, normalized: username.toLowerCase() };
}

async function ensureManagerAccountTable(db: D1Database): Promise<void> {
  if (!managerAccountSchemaReady) {
    managerAccountSchemaReady = db.prepare(CREATE_MANAGER_ACCOUNT_TABLE).run().then(() => undefined).catch((cause) => {
      managerAccountSchemaReady = null;
      throw cause;
    });
  }
  await managerAccountSchemaReady;
}

async function ensureManagerLoginThrottleTable(db: D1Database): Promise<void> {
  if (!managerLoginThrottleSchemaReady) {
    managerLoginThrottleSchemaReady = db.prepare(CREATE_MANAGER_LOGIN_THROTTLE_TABLE).run().then(() => undefined).catch((cause) => {
      managerLoginThrottleSchemaReady = null;
      throw cause;
    });
  }
  await managerLoginThrottleSchemaReady;
}

async function managerLoginRetryAfter(db: D1Database, key: string, now: number): Promise<number | null> {
  await ensureManagerLoginThrottleTable(db);
  const row = await db.prepare(
    "SELECT failed_attempts AS failedAttempts, window_started_at AS windowStartedAt FROM manager_login_throttle WHERE key = ?1",
  ).bind(key).first<StoredManagerLoginThrottle>();
  if (!row) return null;
  const failedAttempts = Number(row.failedAttempts);
  const windowStartedAt = Number(row.windowStartedAt);
  if (!Number.isSafeInteger(failedAttempts) || failedAttempts < 0 || !Number.isSafeInteger(windowStartedAt) || windowStartedAt < 0) {
    throw new Error("Stored manager login throttle is invalid");
  }
  const remainingMs = windowStartedAt + LOGIN_THROTTLE_WINDOW_MS - now;
  if (failedAttempts < LOGIN_THROTTLE_MAX_FAILURES || remainingMs <= 0) return null;
  return Math.max(1, Math.min(LOGIN_THROTTLE_WINDOW_MS / 1000, Math.ceil(remainingMs / 1000)));
}

async function recordManagerLoginFailure(db: D1Database, key: string, now: number): Promise<void> {
  await ensureManagerLoginThrottleTable(db);
  const staleBefore = now - LOGIN_THROTTLE_WINDOW_MS;
  await db.prepare("DELETE FROM manager_login_throttle WHERE updated_at <= ?1").bind(staleBefore).run();
  await db.prepare(
    "INSERT INTO manager_login_throttle (key, failed_attempts, window_started_at, updated_at) VALUES (?1, 1, ?2, ?2) "
    + "ON CONFLICT(key) DO UPDATE SET "
    + "failed_attempts = CASE WHEN window_started_at <= ?3 THEN 1 ELSE failed_attempts + 1 END, "
    + "window_started_at = CASE WHEN window_started_at <= ?3 THEN ?2 ELSE window_started_at END, "
    + "updated_at = ?2",
  ).bind(key, now, staleBefore).run();
}

async function clearManagerLoginFailures(db: D1Database, key: string): Promise<void> {
  await ensureManagerLoginThrottleTable(db);
  await db.prepare("DELETE FROM manager_login_throttle WHERE key = ?1").bind(key).run();
}

async function readStoredManagerAccount(db: D1Database): Promise<StoredManagerAccount | null> {
  await ensureManagerAccountTable(db);
  return db.prepare(
    "SELECT username, username_normalized AS usernameNormalized, updated_at AS updatedAt FROM manager_account WHERE key = ?1",
  ).bind(MANAGER_ACCOUNT_KEY).first<StoredManagerAccount>();
}

async function readManagerUsername(env: ManagerAuthEnv): Promise<ManagerUsername> {
  if (!env.DB) return { username: DEFAULT_MANAGER_USERNAME, normalized: DEFAULT_MANAGER_USERNAME.toLowerCase() };
  const stored = await readStoredManagerAccount(env.DB);
  if (!stored) return { username: DEFAULT_MANAGER_USERNAME, normalized: DEFAULT_MANAGER_USERNAME.toLowerCase() };
  const parsed = parseManagerUsername(stored.username);
  if (!parsed || parsed.normalized !== stored.usernameNormalized) throw new Error("Stored manager username is invalid");
  return parsed;
}

async function storeManagerUsername(db: D1Database, value: ManagerUsername): Promise<void> {
  const current = await readStoredManagerAccount(db);
  const updatedAt = Math.max(Date.now(), Number(current?.updatedAt || 0) + 1);
  await db.prepare(
    "INSERT INTO manager_account (key, username, username_normalized, updated_at) VALUES (?1, ?2, ?3, ?4) "
    + "ON CONFLICT(key) DO UPDATE SET username = excluded.username, username_normalized = excluded.username_normalized, updated_at = excluded.updated_at",
  ).bind(MANAGER_ACCOUNT_KEY, value.username, value.normalized, updatedAt).run();
}

async function readStoredManagerPassword(db: D1Database): Promise<StoredManagerPassword | null> {
  await ensureManagerSecretTable(db);
  return db.prepare("SELECT hash, salt, algorithm, updated_at AS updatedAt FROM manager_secret WHERE key = ?1")
    .bind(MANAGER_SECRET_KEY)
    .first<StoredManagerPassword>();
}

async function readManagerAuthRevision(env: ManagerAuthEnv): Promise<string> {
  if (!env.DB) return "0:0";
  const [account, secret] = await Promise.all([
    readStoredManagerAccount(env.DB),
    readStoredManagerPassword(env.DB),
  ]);
  return `${Number(account?.updatedAt || 0)}:${Number(secret?.updatedAt || 0)}`;
}

async function derivePasswordHash(password: string, salt: Uint8Array, managerToken: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(managerToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = PASSWORD_HASH_CONTEXT + bytesToBase64Url(salt) + "\u0000" + password;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function storedManagerPasswordMatches(candidate: string, row: StoredManagerPassword, managerToken: string): Promise<boolean> {
  if (row.algorithm !== PASSWORD_HASH_ALGORITHM) return false;
  const salt = base64UrlToBytes(row.salt, 64);
  const expected = base64UrlToBytes(row.hash, 128);
  if (!salt || salt.byteLength !== PASSWORD_SALT_BYTES || !expected || expected.byteLength !== PASSWORD_HASH_BYTES) return false;
  const candidateHash = await derivePasswordHash(candidate, salt, managerToken);
  return constantTimeEqual(candidateHash, expected);
}

async function storeManagerPassword(db: D1Database, password: string, managerToken: string): Promise<void> {
  const current = await readStoredManagerPassword(db);
  const salt = new Uint8Array(PASSWORD_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derivePasswordHash(password, salt, managerToken);
  const updatedAt = Math.max(Date.now(), Number(current?.updatedAt || 0) + 1);
  await db.prepare(
    "INSERT INTO manager_secret (key, hash, salt, algorithm, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) "
    + "ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, salt = excluded.salt, algorithm = excluded.algorithm, updated_at = excluded.updated_at",
  ).bind(MANAGER_SECRET_KEY, bytesToBase64Url(hash), bytesToBase64Url(salt), PASSWORD_HASH_ALGORITHM, updatedAt).run();
}

/**
 * Verify a login credential. A password set via "change password" is stored in
 * D1 and is authoritative. The strong MANAGER_TOKEN remains a break-glass
 * recovery credential, while MANAGER_PASSWORD is only the initial password.
 */
async function verifyLoginCredential(candidate: string, env: ManagerAuthEnv): Promise<boolean> {
  const recoveryToken = configuredManagerToken(env);
  if (env.DB) {
    try {
      const stored = await readStoredManagerPassword(env.DB);
      if (stored) {
        const [storedMatches, recoveryMatches] = await Promise.all([
          recoveryToken ? storedManagerPasswordMatches(candidate, stored, recoveryToken) : Promise.resolve(false),
          recoveryToken ? managerTokenMatches(candidate, recoveryToken) : Promise.resolve(false),
        ]);
        return storedMatches || recoveryMatches;
      }
    } catch {
      // Never reactivate the old password during a storage outage. Only the
      // strong signing token may be used as the recovery credential.
      return recoveryToken ? managerTokenMatches(candidate, recoveryToken) : false;
    }
  }
  const managerPassword = configuredManagerPassword(env);
  if (!managerPassword) return false;
  const [passwordMatches, recoveryMatches] = await Promise.all([
    managerTokenMatches(candidate, managerPassword),
    recoveryToken && recoveryToken !== managerPassword
      ? managerTokenMatches(candidate, recoveryToken)
      : Promise.resolve(false),
  ]);
  return passwordMatches || recoveryMatches;
}

async function readPasswordChange(request: Request): Promise<{ currentPassword: string; newPassword: string } | null> {
  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength.trim()) || Number(contentLength) > LOGIN_BODY_LIMIT_BYTES)) return null;
  const raw = await readBodyWithinLimit(request, LOGIN_BODY_LIMIT_BYTES);
  if (raw === null) return null;
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const currentPassword = (body as { currentPassword?: unknown }).currentPassword;
    const newPassword = (body as { newPassword?: unknown }).newPassword;
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") return null;
    return { currentPassword, newPassword };
  } catch {
    return null;
  }
}

async function readUsernameChange(request: Request): Promise<{ currentPassword: string; newUsername: string } | null> {
  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength.trim()) || Number(contentLength) > LOGIN_BODY_LIMIT_BYTES)) return null;
  const raw = await readBodyWithinLimit(request, LOGIN_BODY_LIMIT_BYTES);
  if (raw === null) return null;
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const currentPassword = (body as { currentPassword?: unknown }).currentPassword;
    const newUsername = (body as { newUsername?: unknown }).newUsername;
    if (typeof currentPassword !== "string" || typeof newUsername !== "string") return null;
    return { currentPassword, newUsername };
  } catch {
    return null;
  }
}

async function handleManagerPasswordChange(request: Request, env: ManagerAuthEnv): Promise<Response> {
  if (request.method !== "POST") return authJson({ error: "Method not allowed" }, 405, { allow: "POST" });
  const originError = strictSameOriginError(request);
  if (originError) return originError;
  const managerToken = configuredManagerToken(env);
  if (!managerToken) return authError("Manager authentication is not configured", 503);
  if (!(await verifyManagerSession(request, env))) return authError("Manager session is invalid or expired", 401);
  if (!env.DB) return authError("Password storage is unavailable", 503);
  const body = await readPasswordChange(request);
  if (body === null) return authError("The request is invalid", 400);
  if (!(await verifyLoginCredential(body.currentPassword, env))) return authError("The current password is incorrect", 401);
  if (body.newPassword.length < MIN_CHANGED_PASSWORD_LENGTH || body.newPassword.length > MAX_CHANGED_PASSWORD_LENGTH) {
    return authError(`The new password must be ${MIN_CHANGED_PASSWORD_LENGTH}-${MAX_CHANGED_PASSWORD_LENGTH} characters`, 422);
  }
  if (body.newPassword === body.currentPassword) return authError("The new password must differ from the current one", 422);
  let replacementSession: { value: string; session: ManagerSession };
  try {
    await storeManagerPassword(env.DB, body.newPassword, managerToken);
    replacementSession = await issueManagerSession(request, managerToken, await readManagerAuthRevision(env));
  } catch {
    return authError("Could not save the new password. Try again.", 503);
  }
  return authJson({ ok: true }, 200, { "set-cookie": sessionCookie(replacementSession.value) });
}

async function handleManagerUsernameChange(request: Request, env: ManagerAuthEnv): Promise<Response> {
  if (request.method !== "POST") return authJson({ error: "Method not allowed" }, 405, { allow: "POST" });
  const originError = strictSameOriginError(request);
  if (originError) return originError;
  const managerToken = configuredManagerToken(env);
  if (!managerToken) return authError("Manager authentication is not configured", 503);
  if (!(await verifyManagerSession(request, env))) return authError("Manager session is invalid or expired", 401);
  if (!env.DB) return authError("Manager account storage is unavailable", 503);
  const body = await readUsernameChange(request);
  if (body === null) return authError("The request is invalid", 400);
  if (!(await verifyLoginCredential(body.currentPassword, env))) return authError("The current password is incorrect", 401);
  const nextUsername = parseManagerUsername(body.newUsername);
  if (!nextUsername) {
    return authError(
      `The username must be ${MIN_MANAGER_USERNAME_LENGTH}-${MAX_MANAGER_USERNAME_LENGTH} characters, start with a letter, and contain only letters, numbers, or underscores`,
      422,
    );
  }
  let replacementSession: { value: string; session: ManagerSession };
  try {
    const current = await readManagerUsername(env);
    if (current.normalized === nextUsername.normalized) return authError("The new username must differ from the current one", 422);
    await storeManagerUsername(env.DB, nextUsername);
    replacementSession = await issueManagerSession(request, managerToken, await readManagerAuthRevision(env));
  } catch {
    return authError("Could not save the manager username. Try again.", 503);
  }
  return authJson(
    { ok: true, username: nextUsername.username },
    200,
    { "set-cookie": sessionCookie(replacementSession.value) },
  );
}

export async function handleManagerAuthApi(request: Request, env: ManagerAuthEnv): Promise<Response | null> {
  const pathname = canonicalPathname(new URL(request.url).pathname);
  if (pathname === null) return authError("The request path is invalid", 400);
  if (pathname === MANAGER_PASSWORD_PATH) return handleManagerPasswordChange(request, env);
  if (pathname === MANAGER_USERNAME_PATH) return handleManagerUsernameChange(request, env);
  if (pathname !== MANAGER_SESSION_PATH) return null;

  if (request.method === "GET") {
    if (!isManagerAuthConfigured(env)) return authError("Manager authentication is not configured", 503);
    const session = await verifyManagerSession(request, env);
    if (!session) {
      return authJson({ authenticated: false }, 401, { "set-cookie": expiredSessionCookie() });
    }
    try {
      const managerUsername = await readManagerUsername(env);
      return authJson({ authenticated: true, username: managerUsername.username, expiresAt: session.expiresAt });
    } catch {
      return authError("Manager account storage is unavailable", 503);
    }
  }

  if (request.method === "POST") {
    const originError = strictSameOriginError(request);
    if (originError) return originError;
    const managerToken = configuredManagerToken(env);
    const managerPassword = configuredManagerPassword(env);
    if (!managerToken || !managerPassword) return authError("Manager authentication is not configured", 503);
    const credentials = await readLoginCredentials(request);
    if (credentials === null) return authError("The login request is invalid", 400);
    const normalizedCandidateUsername = credentials.username.toLowerCase();
    let throttleKey: string | null = null;
    if (env.DB) {
      try {
        throttleKey = await managerLoginThrottleKey(request, normalizedCandidateUsername, managerToken);
        const retryAfter = await managerLoginRetryAfter(env.DB, throttleKey, Date.now());
        if (retryAfter !== null) {
          return authError("Too many login attempts. Try again later.", 429, { "retry-after": String(retryAfter) });
        }
      } catch {
        return authError("Manager login is temporarily unavailable", 503);
      }
    }
    let managerUsername: ManagerUsername;
    try {
      managerUsername = await readManagerUsername(env);
    } catch {
      return authError("Manager account storage is unavailable", 503);
    }
    const [usernameMatches, passwordMatches] = await Promise.all([
      managerTokenMatches(normalizedCandidateUsername, managerUsername.normalized),
      verifyLoginCredential(credentials.password, env),
    ]);
    if (!usernameMatches || !passwordMatches) {
      if (env.DB && throttleKey) {
        try {
          await recordManagerLoginFailure(env.DB, throttleKey, Date.now());
        } catch {
          return authError("Manager login is temporarily unavailable", 503);
        }
      }
      return authError("Manager credentials are invalid", 401);
    }
    let revision: string;
    try {
      if (env.DB && throttleKey) await clearManagerLoginFailures(env.DB, throttleKey);
      revision = await readManagerAuthRevision(env);
    } catch {
      return authError("Manager account storage is unavailable", 503);
    }
    const { value, session } = await issueManagerSession(request, managerToken, revision);
    return authJson(
      { authenticated: true, username: managerUsername.username, expiresAt: session.expiresAt },
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
