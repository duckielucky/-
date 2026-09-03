const PLAYER_REGISTER_PATH = "/api/player/register";
const PLAYER_SESSION_PATH = "/api/player/session";
const PLAYER_PROFILE_PATH = "/api/player/profile";
const PLAYER_PASSWORD_PATH = "/api/player/password";
const PLAYER_ACCOUNT_PATH = "/api/player/account";
const PLAYER_SAVE_PATH = "/api/player/save";
const PLAYER_COOKIE = "__Host-lucky-player-session";
const PLAYER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_BODY_LIMIT_BYTES = 12 * 1024;
const SAVE_BODY_LIMIT_BYTES = 192 * 1024;
const MIN_SIGNING_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4 * 1024;
const PASSWORD_ITERATIONS = 150_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_ALGORITHM = `pbkdf2-sha256-v1:${PASSWORD_ITERATIONS}`;
const SESSION_KEY_CONTEXT = "Lucky player session signing key\u0000v1";
const SESSION_SIGNATURE_CONTEXT = "Lucky player session cookie\u0000v1\u0000";
const LOGIN_THROTTLE_CONTEXT = "Lucky player login throttle\u0000v1\u0000";
const LOGIN_THROTTLE_MAX_FAILURES = 8;
const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const TEST_USERNAME = "test";
const TEST_EMAIL = "test@example.com";
const TEST_PASSWORD = "1111";
const TEST_ACCOUNT_ID = "builtin-test-player";
const START_COINS = 20_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DUMMY_PASSWORD_SALT = new Uint8Array([91, 17, 204, 63, 142, 5, 76, 188, 31, 219, 104, 57, 7, 166, 242, 119]);

const AVATARS = new Set(["🍀", "🎰", "💎", "👑", "🎲", "⭐", "🔮", "🦄", "🐯", "🌈"]);
const COLORS = new Set(["#a83cff", "#2ce9d3", "#ffd76e", "#ff5db1", "#5e8bff", "#ff8a3c"]);
const RESERVED_USERNAMES = new Set(["__proto__", "constructor", "prototype", "hasownproperty", "admin", "root", "test", "testplayer"]);

export type PlayerApiEnv = {
  DB?: D1Database;
  PLAYER_SESSION_SECRET?: string;
  MANAGER_TOKEN?: string;
};

type StoredPlayer = {
  id: string;
  username: string;
  usernameNormalized: string;
  email: string;
  emailNormalized: string;
  displayName: string;
  avatar: string;
  color: string;
  role: string;
  passwordHash: string;
  passwordSalt: string;
  passwordAlgorithm: string;
  authRevision: number;
  createdAt: number;
  updatedAt: number;
};

type StoredSave = {
  saveJson: string;
  revision: number;
  updatedAt: number;
};

type PlayerSession = {
  account: StoredPlayer;
  expiresAt: number;
};

type SessionPayload = {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
  host: string;
  playerId: string;
  authRevision: number;
};

const CREATE_PLAYER_ACCOUNT_TABLE = `
  CREATE TABLE IF NOT EXISTS player_account (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    color TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_algorithm TEXT NOT NULL,
    auth_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID
`;

const CREATE_PLAYER_SAVE_TABLE = `
  CREATE TABLE IF NOT EXISTS player_save (
    player_id TEXT PRIMARY KEY NOT NULL,
    save_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (player_id) REFERENCES player_account(id) ON DELETE CASCADE
  ) WITHOUT ROWID
`;

const CREATE_PLAYER_LOGIN_THROTTLE_TABLE = `
  CREATE TABLE IF NOT EXISTS player_login_throttle (
    key TEXT PRIMARY KEY NOT NULL,
    failed_attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID
`;

let schemaReady: Promise<void> | null = null;

async function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.prepare(CREATE_PLAYER_ACCOUNT_TABLE).run();
      await db.prepare(CREATE_PLAYER_SAVE_TABLE).run();
      await db.prepare(CREATE_PLAYER_LOGIN_THROTTLE_TABLE).run();
    })().catch((cause) => {
      schemaReady = null;
      throw cause;
    });
  }
  await schemaReady;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalPathname(pathname: string): string | null {
  let current = pathname;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let decoded: string;
    try { decoded = decodeURIComponent(current); } catch { return null; }
    if (decoded === current) return decoded;
    current = decoded;
  }
  return null;
}

function signingSecret(env: PlayerApiEnv): string | null {
  const candidate = env.PLAYER_SESSION_SECRET ?? env.MANAGER_TOKEN;
  if (typeof candidate !== "string") return null;
  const length = encoder.encode(candidate).byteLength;
  return length >= MIN_SIGNING_SECRET_BYTES && length <= MAX_SECRET_BYTES ? candidate : null;
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
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    if (binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomId(): string {
  return bytesToBase64Url(randomBytes(18));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function derivePassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  // Password verification must survive rotation of the session-signing secret.
  // A per-account random salt and PBKDF2 keep credentials independent of it.
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    material,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

async function passwordMatches(password: string, account: StoredPlayer): Promise<boolean> {
  if (account.passwordAlgorithm !== PASSWORD_ALGORITHM) return false;
  const salt = base64UrlToBytes(account.passwordSalt, 64);
  const expected = base64UrlToBytes(account.passwordHash, 64);
  if (!salt || salt.byteLength !== PASSWORD_SALT_BYTES || !expected || expected.byteLength !== PASSWORD_HASH_BYTES) return false;
  return constantTimeEqual(await derivePassword(password, salt), expected);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8 * 1024) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim());
  }
  return values.length === 1 ? values[0] : null;
}

function sessionCookie(value: string, maxAge = PLAYER_SESSION_TTL_SECONDS): string {
  return [
    `${PLAYER_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function expiredSessionCookie(): string {
  return [
    `${PLAYER_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

async function deriveSessionKey(secret: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(SESSION_KEY_CONTEXT));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function issueSession(request: Request, account: StoredPlayer, secret: string): Promise<{ cookie: string; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + PLAYER_SESSION_TTL_SECONDS;
  const payload: SessionPayload = {
    v: 1,
    iat: issuedAt,
    exp: expiresAt,
    nonce: randomId(),
    host: new URL(request.url).host,
    playerId: account.id,
    authRevision: account.authRevision,
  };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await deriveSessionKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(SESSION_SIGNATURE_CONTEXT + encoded));
  return { cookie: `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`, expiresAt };
}

function sameOriginError(request: Request): Response | null {
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return error("不允许跨站请求", 403, "cross_origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite && fetchSite !== "same-origin" ? error("不允许跨站请求", 403, "cross_origin") : null;
}

async function readBodyWithinLimit(request: Request, limit: number): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength.trim()) || Number(contentLength) > limit)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  let raw = "";
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch { /* limit still applies */ }
      return null;
    }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  return raw + decoder.decode();
}

async function readJsonBody(request: Request, limit: number): Promise<Record<string, unknown> | null> {
  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const raw = await readBodyWithinLimit(request, limit);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validUsername(value: unknown, allowReserved = false): { display: string; normalized: string } | null {
  if (typeof value !== "string") return null;
  const display = value.trim();
  const normalized = display.toLowerCase();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(display) || (!allowReserved && RESERVED_USERNAMES.has(normalized))) return null;
  return { display, normalized };
}

function validEmail(value: unknown): { display: string; normalized: string } | null {
  if (typeof value !== "string") return null;
  const display = value.trim();
  const normalized = display.toLowerCase();
  if (display.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(display)) return null;
  return { display, normalized };
}

function validDisplayName(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return null;
  const display = value.trim() || fallback;
  const hasControlCharacter = Array.from(display).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  return display.length <= 40 && !hasControlCharacter ? display : null;
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 4 && value.length <= 128;
}

function publicAccount(account: StoredPlayer) {
  return {
    username: account.username,
    email: account.email,
    displayName: account.displayName,
    avatar: AVATARS.has(account.avatar) ? account.avatar : "🍀",
    color: COLORS.has(account.color) ? account.color : "#a83cff",
    coins: START_COINS,
    role: account.role === "test" ? "test" : "player",
    createdAt: new Date(account.createdAt).toISOString(),
  };
}

const PLAYER_SELECT = `SELECT id, username, username_normalized AS usernameNormalized, email,
  email_normalized AS emailNormalized, display_name AS displayName, avatar, color, role,
  password_hash AS passwordHash, password_salt AS passwordSalt, password_algorithm AS passwordAlgorithm,
  auth_revision AS authRevision, created_at AS createdAt, updated_at AS updatedAt FROM player_account`;

async function findPlayerByIdentity(db: D1Database, identity: string): Promise<StoredPlayer | null> {
  const normalized = identity.trim().toLowerCase();
  return db.prepare(`${PLAYER_SELECT} WHERE username_normalized = ?1 OR email_normalized = ?1 LIMIT 1`).bind(normalized).first<StoredPlayer>();
}

async function findPlayerById(db: D1Database, id: string): Promise<StoredPlayer | null> {
  return db.prepare(`${PLAYER_SELECT} WHERE id = ?1`).bind(id).first<StoredPlayer>();
}

async function insertPlayer(
  db: D1Database,
  input: { id?: string; username: string; email: string; displayName: string; avatar: string; color: string; role: "player" | "test"; password: string },
): Promise<StoredPlayer> {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = await derivePassword(input.password, salt);
  const now = Date.now();
  const id = input.id || randomId();
  await db.prepare(
    "INSERT INTO player_account (id, username, username_normalized, email, email_normalized, display_name, avatar, color, role, password_hash, password_salt, password_algorithm, auth_revision, created_at, updated_at) "
    + "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)",
  ).bind(
    id,
    input.username,
    input.username.toLowerCase(),
    input.email,
    input.email.toLowerCase(),
    input.displayName,
    input.avatar,
    input.color,
    input.role,
    bytesToBase64Url(hash),
    bytesToBase64Url(salt),
    PASSWORD_ALGORITHM,
    now,
  ).run();
  const stored = await findPlayerById(db, id);
  if (!stored) throw new Error("Player insert did not persist");
  return stored;
}

async function ensureTestPlayer(db: D1Database): Promise<StoredPlayer> {
  const existing = await findPlayerByIdentity(db, TEST_USERNAME);
  if (existing) return existing;
  try {
    return await insertPlayer(db, {
      id: TEST_ACCOUNT_ID,
      username: TEST_USERNAME,
      email: TEST_EMAIL,
      displayName: "Test",
      avatar: "🍀",
      color: "#a83cff",
      role: "test",
      password: TEST_PASSWORD,
    });
  } catch {
    const raced = await findPlayerByIdentity(db, TEST_USERNAME);
    if (raced) return raced;
    throw new Error("Could not create test player");
  }
}

async function verifySession(request: Request, env: PlayerApiEnv): Promise<PlayerSession | null> {
  const secret = signingSecret(env);
  if (!secret || !env.DB) return null;
  const cookie = readCookie(request, PLAYER_COOKIE);
  if (!cookie || cookie.length > 3 * 1024) return null;
  const parts = cookie.split(".");
  if (parts.length !== 2) return null;
  const payloadBytes = base64UrlToBytes(parts[0], 2 * 1024);
  const signature = base64UrlToBytes(parts[1], 64);
  if (!payloadBytes || !signature || signature.byteLength !== 32) return null;
  const key = await deriveSessionKey(secret);
  if (!(await crypto.subtle.verify("HMAC", key, signature, encoder.encode(SESSION_SIGNATURE_CONTEXT + parts[0])))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(payloadBytes)); } catch { return null; }
  if (!isRecord(parsed)) return null;
  const payload = parsed as Partial<SessionPayload>;
  if (
    payload.v !== 1
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || typeof payload.nonce !== "string"
    || !/^[A-Za-z0-9_-]{24}$/.test(payload.nonce)
    || typeof payload.playerId !== "string"
    || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.playerId)
    || !Number.isSafeInteger(payload.authRevision)
    || payload.host !== new URL(request.url).host
  ) return null;
  const issuedAt = Number(payload.iat);
  const expiresAt = Number(payload.exp);
  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now + 60 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > PLAYER_SESSION_TTL_SECONDS) return null;
  await ensureSchema(env.DB);
  const account = await findPlayerById(env.DB, payload.playerId);
  if (!account || account.authRevision !== Number(payload.authRevision)) return null;
  return { account, expiresAt };
}

async function loginThrottleKey(request: Request, identity: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ip = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() || "unknown";
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${LOGIN_THROTTLE_CONTEXT}${ip}\u0000${identity}`));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function loginRetryAfter(db: D1Database, key: string, now: number): Promise<number | null> {
  const row = await db.prepare(
    "SELECT failed_attempts AS failedAttempts, window_started_at AS windowStartedAt FROM player_login_throttle WHERE key = ?1",
  ).bind(key).first<{ failedAttempts: number; windowStartedAt: number }>();
  if (!row) return null;
  const remaining = Number(row.windowStartedAt) + LOGIN_THROTTLE_WINDOW_MS - now;
  return Number(row.failedAttempts) >= LOGIN_THROTTLE_MAX_FAILURES && remaining > 0
    ? Math.max(1, Math.ceil(remaining / 1000))
    : null;
}

async function recordLoginFailure(db: D1Database, key: string, now: number): Promise<void> {
  const staleBefore = now - LOGIN_THROTTLE_WINDOW_MS;
  await db.prepare("DELETE FROM player_login_throttle WHERE updated_at <= ?1").bind(staleBefore).run();
  await db.prepare(
    "INSERT INTO player_login_throttle (key, failed_attempts, window_started_at, updated_at) VALUES (?1, 1, ?2, ?2) "
    + "ON CONFLICT(key) DO UPDATE SET failed_attempts = CASE WHEN window_started_at <= ?3 THEN 1 ELSE failed_attempts + 1 END, "
    + "window_started_at = CASE WHEN window_started_at <= ?3 THEN ?2 ELSE window_started_at END, updated_at = ?2",
  ).bind(key, now, staleBefore).run();
}

async function handleRegister(request: Request, env: PlayerApiEnv, db: D1Database, secret: string): Promise<Response> {
  if (request.method !== "POST") return error("Method not allowed", 405, undefined, { allow: "POST" });
  const originError = sameOriginError(request);
  if (originError) return originError;
  const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
  if (!body) return error("注册资料格式不正确", 400, "invalid_request");
  const username = validUsername(body.username);
  const email = validEmail(body.email);
  const password = body.password;
  const displayName = username ? validDisplayName(body.displayName, username.display) : null;
  const avatar = typeof body.avatar === "string" && AVATARS.has(body.avatar) ? body.avatar : "🍀";
  const color = typeof body.color === "string" && COLORS.has(body.color) ? body.color : "#a83cff";
  if (!username) return error("用户名为 3-20 位字母、数字或下划线", 422, "invalid_username");
  if (!email) return error("邮箱格式不正确", 422, "invalid_email");
  if (email.normalized === TEST_EMAIL) return error("该邮箱不可用于注册", 422, "reserved_email");
  if (!validPassword(password)) return error("密码必须为 4-128 位", 422, "invalid_password");
  if (!displayName) return error("昵称过长或含有无效字符（最多 40 字）", 422, "invalid_display_name");
  await ensureSchema(db);
  if (await findPlayerByIdentity(db, username.normalized)) return error("该用户名已被占用", 409, "username_taken");
  if (await findPlayerByIdentity(db, email.normalized)) return error("该邮箱已被注册", 409, "email_taken");
  let account: StoredPlayer;
  try {
    account = await insertPlayer(db, {
      username: username.display,
      email: email.display,
      displayName,
      avatar,
      color,
      role: "player",
      password,
    });
  } catch {
    return error("用户名或邮箱已被注册", 409, "identity_taken");
  }
  const session = await issueSession(request, account, secret);
  return json(
    { authenticated: true, account: publicAccount(account), expiresAt: session.expiresAt },
    201,
    { "set-cookie": sessionCookie(session.cookie) },
  );
}

async function handleSession(request: Request, env: PlayerApiEnv, db: D1Database, secret: string): Promise<Response> {
  if (request.method === "GET") {
    const session = await verifySession(request, env);
    if (!session) return json({ authenticated: false }, 401, { "set-cookie": expiredSessionCookie() });
    return json({ authenticated: true, account: publicAccount(session.account), expiresAt: session.expiresAt });
  }
  if (request.method === "DELETE") {
    const originError = sameOriginError(request);
    if (originError) return originError;
    return json({ authenticated: false }, 200, { "set-cookie": expiredSessionCookie() });
  }
  if (request.method !== "POST") return error("Method not allowed", 405, undefined, { allow: "GET, POST, DELETE" });
  const originError = sameOriginError(request);
  if (originError) return originError;
  const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
  const identity = typeof body?.identity === "string" ? body.identity.trim().toLowerCase() : "";
  const password = body?.password;
  if (!identity || typeof password !== "string" || password.length > 128) return error("请输入用户名和密码", 400, "invalid_request");
  await ensureSchema(db);
  const throttleKey = await loginThrottleKey(request, identity, secret);
  const now = Date.now();
  const retryAfter = await loginRetryAfter(db, throttleKey, now);
  if (retryAfter !== null) return error("登录尝试过多，请稍后再试", 429, "rate_limited", { "retry-after": String(retryAfter) });
  let account = await findPlayerByIdentity(db, identity);
  if (!account && (identity === TEST_USERNAME || identity === TEST_EMAIL)) account = await ensureTestPlayer(db);
  // Always run the same expensive derivation so response timing does not reveal
  // whether the supplied username/email exists.
  const valid = account
    ? await passwordMatches(password, account)
    : (await derivePassword(password, DUMMY_PASSWORD_SALT), false);
  if (!account || !valid) {
    await recordLoginFailure(db, throttleKey, now);
    return error("用户名或密码错误", 401, "invalid_credentials");
  }
  await db.prepare("DELETE FROM player_login_throttle WHERE key = ?1").bind(throttleKey).run();
  const issued = await issueSession(request, account, secret);
  return json(
    { authenticated: true, account: publicAccount(account), expiresAt: issued.expiresAt },
    200,
    { "set-cookie": sessionCookie(issued.cookie) },
  );
}

async function requirePlayer(request: Request, env: PlayerApiEnv): Promise<PlayerSession | Response> {
  try {
    const session = await verifySession(request, env);
    return session || error("玩家登录已过期，请重新登录", 401, "unauthenticated", { "set-cookie": expiredSessionCookie() });
  } catch {
    return error("玩家云端服务暂时不可用", 503, "storage_unavailable");
  }
}

async function handleProfile(request: Request, env: PlayerApiEnv, db: D1Database): Promise<Response> {
  if (request.method !== "PATCH") return error("Method not allowed", 405, undefined, { allow: "PATCH" });
  const originError = sameOriginError(request);
  if (originError) return originError;
  const authorized = await requirePlayer(request, env);
  if (authorized instanceof Response) return authorized;
  const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
  if (!body) return error("资料格式不正确", 400, "invalid_request");
  const displayName = validDisplayName(body.displayName, authorized.account.username);
  const email = validEmail(body.email);
  const avatar = typeof body.avatar === "string" && AVATARS.has(body.avatar) ? body.avatar : null;
  const color = typeof body.color === "string" && COLORS.has(body.color) ? body.color : null;
  if (!displayName || !email || !avatar || !color) return error("个人资料格式不正确", 422, "invalid_profile");
  const collision = await findPlayerByIdentity(db, email.normalized);
  if (collision && collision.id !== authorized.account.id) return error("该邮箱已被其他账户使用", 409, "email_taken");
  try {
    await db.prepare(
      "UPDATE player_account SET email = ?1, email_normalized = ?2, display_name = ?3, avatar = ?4, color = ?5, updated_at = ?6 WHERE id = ?7",
    ).bind(email.display, email.normalized, displayName, avatar, color, Date.now(), authorized.account.id).run();
  } catch {
    return error("该邮箱已被其他账户使用", 409, "email_taken");
  }
  const updated = await findPlayerById(db, authorized.account.id);
  return updated ? json({ ok: true, account: publicAccount(updated) }) : error("无法读取玩家资料", 503, "storage_unavailable");
}

async function handlePassword(request: Request, env: PlayerApiEnv, db: D1Database, secret: string): Promise<Response> {
  if (request.method !== "POST") return error("Method not allowed", 405, undefined, { allow: "POST" });
  const originError = sameOriginError(request);
  if (originError) return originError;
  const authorized = await requirePlayer(request, env);
  if (authorized instanceof Response) return authorized;
  if (authorized.account.role === "test") return error("内置测试玩家密码固定为 1111", 422, "test_password_fixed");
  const body = await readJsonBody(request, AUTH_BODY_LIMIT_BYTES);
  const currentPassword = body?.currentPassword;
  const newPassword = body?.newPassword;
  if (typeof currentPassword !== "string" || !validPassword(newPassword)) return error("密码格式不正确", 422, "invalid_password");
  if (!(await passwordMatches(currentPassword, authorized.account))) return error("当前密码不正确", 401, "invalid_credentials");
  if (currentPassword === newPassword) return error("新密码不能与当前密码相同", 422, "same_password");
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = await derivePassword(newPassword, salt);
  await db.prepare(
    "UPDATE player_account SET password_hash = ?1, password_salt = ?2, password_algorithm = ?3, auth_revision = auth_revision + 1, updated_at = ?4 WHERE id = ?5",
  ).bind(bytesToBase64Url(hash), bytesToBase64Url(salt), PASSWORD_ALGORITHM, Date.now(), authorized.account.id).run();
  const updated = await findPlayerById(db, authorized.account.id);
  if (!updated) return error("无法更新密码", 503, "storage_unavailable");
  const issued = await issueSession(request, updated, secret);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(issued.cookie) });
}

async function handleAccountDelete(request: Request, env: PlayerApiEnv, db: D1Database): Promise<Response> {
  if (request.method !== "DELETE") return error("Method not allowed", 405, undefined, { allow: "DELETE" });
  const originError = sameOriginError(request);
  if (originError) return originError;
  const authorized = await requirePlayer(request, env);
  if (authorized instanceof Response) return authorized;
  if (authorized.account.role === "test") return error("内置测试玩家不可删除", 422, "test_account_fixed");
  await db.prepare("DELETE FROM player_save WHERE player_id = ?1").bind(authorized.account.id).run();
  await db.prepare("DELETE FROM player_account WHERE id = ?1").bind(authorized.account.id).run();
  return json({ ok: true }, 200, { "set-cookie": expiredSessionCookie() });
}

function validateSave(value: unknown): { save: Record<string, unknown>; json: string } | null {
  if (!isRecord(value) || !isRecord(value.player)) return null;
  if (value.ticket !== null && value.ticket !== undefined && !isRecord(value.ticket)) return null;
  if (isRecord(value.ticket) && value.ticket.scratched !== undefined) {
    if (!Array.isArray(value.ticket.scratched) || value.ticket.scratched.length !== 16 || !value.ticket.scratched.every((entry) => typeof entry === "boolean")) return null;
  }
  const log = value.player.log;
  if (log !== undefined && (!Array.isArray(log) || log.length > 80)) return null;
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return null; }
  if (encoder.encode(encoded).byteLength > SAVE_BODY_LIMIT_BYTES - 1024) return null;
  return { save: value, json: encoded };
}

async function readSave(db: D1Database, playerId: string): Promise<{ save: unknown; revision: number; updatedAt: number } | null> {
  const row = await db.prepare(
    "SELECT save_json AS saveJson, revision, updated_at AS updatedAt FROM player_save WHERE player_id = ?1",
  ).bind(playerId).first<StoredSave>();
  if (!row) return null;
  const revision = Number(row.revision);
  const updatedAt = Number(row.updatedAt);
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error("Stored save metadata is invalid");
  return { save: JSON.parse(row.saveJson) as unknown, revision, updatedAt };
}

async function handleSave(request: Request, env: PlayerApiEnv, db: D1Database): Promise<Response> {
  const authorized = await requirePlayer(request, env);
  if (authorized instanceof Response) return authorized;
  if (request.method === "GET") {
    const current = await readSave(db, authorized.account.id);
    return current ? json(current, 200, { etag: `"lucky-save-v${current.revision}"` }) : json({ save: null, revision: 0, updatedAt: 0 });
  }
  if (request.method !== "PUT") return error("Method not allowed", 405, undefined, { allow: "GET, PUT" });
  const originError = sameOriginError(request);
  if (originError) return originError;
  const body = await readJsonBody(request, SAVE_BODY_LIMIT_BYTES);
  const baseRevision = Number(body?.baseRevision);
  const candidate = validateSave(body?.save);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision > 2_147_483_647 || !candidate) {
    return error("云存档格式不正确", 422, "invalid_save");
  }
  const current = await readSave(db, authorized.account.id);
  if (!current) {
    if (baseRevision !== 0) return json({ error: "云存档已更新", code: "revision_conflict", save: null, revision: 0, updatedAt: 0 }, 409);
    const now = Date.now();
    try {
      await db.prepare(
        "INSERT INTO player_save (player_id, save_json, revision, updated_at) VALUES (?1, ?2, 1, ?3)",
      ).bind(authorized.account.id, candidate.json, now).run();
    } catch {
      const raced = await readSave(db, authorized.account.id);
      return raced
        ? json({ error: "云存档已更新", code: "revision_conflict", ...raced }, 409)
        : error("无法保存游戏进度", 503, "storage_unavailable");
    }
    return json({ save: candidate.save, revision: 1, updatedAt: now });
  }
  if (current.revision !== baseRevision) return json({ error: "云存档已更新", code: "revision_conflict", ...current }, 409);
  const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
  const result = await db.prepare(
    "UPDATE player_save SET save_json = ?1, revision = revision + 1, updated_at = ?2 WHERE player_id = ?3 AND revision = ?4",
  ).bind(candidate.json, updatedAt, authorized.account.id, baseRevision).run();
  if (Number(result.meta?.changes || 0) !== 1) {
    const latest = await readSave(db, authorized.account.id);
    return latest
      ? json({ error: "云存档已更新", code: "revision_conflict", ...latest }, 409)
      : json({ error: "云存档已更新", code: "revision_conflict", save: null, revision: 0, updatedAt: 0 }, 409);
  }
  return json({ save: candidate.save, revision: baseRevision + 1, updatedAt });
}

export async function handlePlayerApi(request: Request, env: PlayerApiEnv): Promise<Response | null> {
  const pathname = canonicalPathname(new URL(request.url).pathname);
  if (pathname === null) return error("请求路径不正确", 400, "invalid_path");
  const known = new Set([
    PLAYER_REGISTER_PATH,
    PLAYER_SESSION_PATH,
    PLAYER_PROFILE_PATH,
    PLAYER_PASSWORD_PATH,
    PLAYER_ACCOUNT_PATH,
    PLAYER_SAVE_PATH,
  ]);
  if (!known.has(pathname)) return null;
  const db = env.DB;
  const secret = signingSecret(env);
  if (!db || !secret) return error("玩家云端服务尚未配置", 503, "not_configured");
  try {
    await ensureSchema(db);
    if (pathname === PLAYER_REGISTER_PATH) return await handleRegister(request, env, db, secret);
    if (pathname === PLAYER_SESSION_PATH) return await handleSession(request, env, db, secret);
    if (pathname === PLAYER_PROFILE_PATH) return await handleProfile(request, env, db);
    if (pathname === PLAYER_PASSWORD_PATH) return await handlePassword(request, env, db, secret);
    if (pathname === PLAYER_ACCOUNT_PATH) return await handleAccountDelete(request, env, db);
    return await handleSave(request, env, db);
  } catch {
    return error("玩家云端服务暂时不可用", 503, "storage_unavailable");
  }
}
