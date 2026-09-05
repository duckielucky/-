import { strictSameOriginError, verifyManagerSession, type ManagerAuthEnv } from "./manager-auth";

const PATH = "/api/manager/players";
const BODY_LIMIT = 32 * 1024;
const SAVE_LIMIT = 192 * 1024;
const TEST_ID = "builtin-test-player";
const ITERATIONS = 100_000;
const ALGORITHM = `pbkdf2-sha256-v1:${ITERATIONS}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AVATARS = new Set(["🍀", "🎰", "💎", "👑", "🎲", "⭐", "🔮", "🦄", "🐯", "🌈"]);
const COLORS = new Set(["#a83cff", "#2ce9d3", "#ffd76e", "#ff5db1", "#5e8bff", "#ff8a3c"]);
const RESERVED = new Set(["__proto__", "constructor", "prototype", "hasownproperty", "admin", "root", "test", "testplayer"]);
const GAME_KEYS = ["coins", "ticketsPlayed", "totalWon", "totalSpent", "selectedTicketId", "bestWins",
  "sound", "vibration", "tutorialSeen", "rescueReady", "clearHistory"] as const;
const PATCH_KEYS = new Set(["targetUsername", "expectedRevision", "action", "username", "displayName", "email",
  "avatar", "color", "newPassword", ...GAME_KEYS]);

type Env = ManagerAuthEnv & { DB?: D1Database };
type D1DatabaseWithBatch = D1Database & {
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
};
type Row = {
  id: string; username: string; usernameNormalized: string; email: string; displayName: string;
  avatar: string; color: string; role: string; passwordHash: string; passwordSalt: string;
  passwordAlgorithm: string; createdAt: number; saveJson: string | null; revision: number | null;
  savedAt: number | null;
};

type SummaryRow = {
  id: string; username: string; email: string; displayName: string; avatar: string; color: string;
  role: string; createdAt: number; revision: number | null; savedAt: number | null;
  coins: unknown; ticketsPlayed: unknown; level: unknown; totalWon: unknown; totalSpent: unknown;
} & Record<string, unknown>;

const MALAYSIA_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
});

const SELECT = "SELECT a.id AS id,a.username AS username,a.username_normalized AS usernameNormalized,"
  + "a.email AS email,a.display_name AS displayName,a.avatar AS avatar,a.color AS color,a.role AS role,"
  + "a.password_hash AS passwordHash,a.password_salt AS passwordSalt,a.password_algorithm AS passwordAlgorithm,"
  + "a.created_at AS createdAt,s.save_json AS saveJson,s.revision AS revision,s.updated_at AS savedAt "
  + "FROM player_account a LEFT JOIN player_save s ON s.player_id=a.id";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private",
    "pragma": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function username(value: unknown, reserved = false): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{3,20}$/.test(value)
    && (reserved || !RESERVED.has(value.toLowerCase()));
}
function email(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function displayName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 40
    && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function missingTable(error: unknown): boolean {
  return /no such table/i.test(error instanceof Error ? error.message : String(error));
}
function conflict(error: unknown): boolean {
  return /unique constraint|sqlite_constraint/i.test(error instanceof Error ? error.message : String(error));
}
function changes(result: D1Result<unknown> | undefined): number { return Number(result?.meta?.changes || 0); }
function revision(row: Row): number { return integer(row.revision, 2_147_483_647) ? row.revision : 0; }
function safeAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}
function recentMalaysiaDays(now = Date.now()): string[] {
  const result: string[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const parts = MALAYSIA_DAY.formatToParts(new Date(now - offset * 86_400_000));
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const key = `${values.year}-${values.month}-${values.day}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && !result.includes(key)) result.push(key);
  }
  return result;
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  if (Number(request.headers.get("content-length") || 0) > BODY_LIMIT) return json({ error: "Request body is too large" }, 413);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "A JSON body is required" }, 400);
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > BODY_LIMIT) { await reader.cancel(); return json({ error: "Request body is too large" }, 413); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    return record(parsed) ? parsed : json({ error: "JSON body must be an object" }, 400);
  } catch { return json({ error: "Invalid JSON body" }, 400); }
}
function publicRow(row: Row) {
  let save: unknown = null;
  try { save = row.saveJson ? JSON.parse(row.saveJson) : null; } catch { /* keep account visible */ }
  return {
    username: row.username,
    account: { username: row.username, email: row.email, displayName: row.displayName, avatar: row.avatar,
      color: row.color, role: row.role, createdAt: row.createdAt },
    save, revision: revision(row), savedAt: row.savedAt, updatedAt: row.savedAt,
  };
}
function summaryRow(row: SummaryRow, days: string[]) {
  const won = safeAmount(row.totalWon);
  const spent = safeAmount(row.totalSpent);
  const dailyStats: Record<string, { won: number; spent: number }> = {};
  days.forEach((day, index) => {
    dailyStats[day] = { won: safeAmount(row[`day${index}Won`]), spent: safeAmount(row[`day${index}Spent`]) };
  });
  return {
    username: row.username,
    account: { username: row.username, email: row.email, displayName: row.displayName, avatar: row.avatar,
      color: row.color, role: row.role, createdAt: row.createdAt },
    summary: {
      username: row.username, displayName: row.displayName || row.username,
      role: row.role === "test" || row.username.toLowerCase() === "test" ? "test" : "player",
      balance: safeAmount(row.coins), tickets: Math.floor(safeAmount(row.ticketsPlayed)),
      level: Math.max(1, Math.floor(safeAmount(row.level) || 1)), won, spent,
      loss: Math.max(spent - won, 0), net: won - spent, log: [], dailyStats,
    },
    revision: integer(row.revision, 2_147_483_647) ? row.revision : 0,
    savedAt: row.savedAt, updatedAt: row.savedAt,
  };
}
async function find(db: D1Database, value: string): Promise<Row | null> {
  return db.prepare(`${SELECT} WHERE a.username_normalized=?1 LIMIT 1`).bind(value.toLowerCase()).first<Row>();
}
function base64(bytes: Uint8Array): string {
  let result = ""; for (const byte of bytes) result += String.fromCharCode(byte);
  return btoa(result).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function password(value: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material, 256);
  return { hash: base64(new Uint8Array(bits)), salt: base64(salt) };
}
function validatePatch(value: Record<string, unknown>): Response | null {
  for (const key of Object.keys(value)) if (!PATCH_KEYS.has(key)) return json({ error: `Unsupported field: ${key}` }, 422);
  if (!username(value.targetUsername, true)) return json({ error: "targetUsername is invalid" }, 422);
  if (!integer(value.expectedRevision, 2_147_483_647)) return json({ error: "expectedRevision must be a non-negative integer" }, 422);
  if (value.action !== undefined && value.action !== "reset") return json({ error: "action must be reset" }, 422);
  for (const key of ["coins", "totalWon", "totalSpent"]) {
    if (key in value && !integer(value[key])) return json({ error: `${key} must be a non-negative safe integer` }, 422);
  }
  if ("ticketsPlayed" in value && !integer(value.ticketsPlayed, 1_000_000_000)) return json({ error: "ticketsPlayed is invalid" }, 422);
  if ("selectedTicketId" in value && (typeof value.selectedTicketId !== "string"
    || !/^[A-Za-z0-9_-]{1,40}$/.test(value.selectedTicketId))) return json({ error: "selectedTicketId is invalid" }, 422);
  for (const key of ["sound", "vibration", "tutorialSeen", "rescueReady", "clearHistory"]) {
    if (key in value && typeof value[key] !== "boolean") return json({ error: `${key} must be boolean` }, 422);
  }
  if ("bestWins" in value) {
    if (!record(value.bestWins) || Object.keys(value.bestWins).length > 32) return json({ error: "bestWins is invalid" }, 422);
    for (const [key, win] of Object.entries(value.bestWins)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || !integer(win)) return json({ error: "bestWins is invalid" }, 422);
    }
  }
  return null;
}
function updateSave(row: Row, patch: Record<string, unknown>): string | Response {
  let raw: unknown = null;
  try { raw = row.saveJson ? JSON.parse(row.saveJson) : null; } catch { /* invalid below */ }
  if (!record(raw) || !record(raw.player)) return json({ error: "This player has no editable cloud save" }, 409);
  if (raw.ticket !== undefined && raw.ticket !== null && !record(raw.ticket)) return json({ error: "Stored save is invalid" }, 409);
  if (record(raw.ticket) && raw.ticket.scratched !== undefined
    && (!Array.isArray(raw.ticket.scratched) || raw.ticket.scratched.length !== 16
      || raw.ticket.scratched.some((item) => typeof item !== "boolean"))) return json({ error: "Stored save is invalid" }, 409);
  const player = { ...raw.player };
  if (player.log !== undefined && (!Array.isArray(player.log) || player.log.length > 80)) return json({ error: "Stored save is invalid" }, 409);
  const oldCoins = typeof player.coins === "number" && Number.isFinite(player.coins) ? player.coins : 0;
  for (const key of ["coins", "ticketsPlayed", "totalWon", "totalSpent", "selectedTicketId", "tutorialSeen"]) {
    if (key in patch) player[key] = patch[key];
  }
  if ("sound" in patch || "vibration" in patch) {
    const settings = record(player.settings) ? { ...player.settings } : { sound: true, vibration: true };
    if ("sound" in patch) settings.sound = patch.sound as boolean;
    if ("vibration" in patch) settings.vibration = patch.vibration as boolean;
    player.settings = settings;
  }
  if ("ticketsPlayed" in patch) player.level = Math.floor(Number(patch.ticketsPlayed) / 5) + 1;
  if (record(patch.bestWins)) player.bestWins = { ...(record(player.bestWins) ? player.bestWins : {}), ...patch.bestWins };
  if (patch.rescueReady === true) player.rescueAt = 0;
  if (patch.clearHistory === true) { player.log = []; player.dailyStats = {}; }
  if ("coins" in patch && patch.clearHistory !== true && Number(patch.coins) !== oldCoins) {
    const log = Array.isArray(player.log) ? player.log.slice(0, 79) : [];
    player.log = [{ t: Date.now(), k: "developer", a: Number(patch.coins) - oldCoins, n: "运营后台编辑余额" }, ...log];
  }
  const encoded = JSON.stringify({ ...raw, player, saveVersion: 2, updatedAt: Date.now() });
  return encoder.encode(encoded).byteLength <= SAVE_LIMIT ? encoded : json({ error: "Updated save is too large" }, 413);
}
function freshSave(now: number): string {
  return JSON.stringify({
    saveVersion: 2,
    updatedAt: now,
    player: {
      coins: 20_000,
      level: 1,
      ticketsPlayed: 0,
      selectedTicketId: "starter_100x",
      bestWins: {},
      lastDaily: "",
      rescueAt: 0,
      tutorialSeen: false,
      settings: { sound: true, vibration: true },
      totalSpent: 0,
      totalWon: 0,
      dailyStats: {},
      log: [],
    },
    ticket: null,
  });
}
function guardedWhere(expected: number): string {
  return expected === 0
    ? "NOT EXISTS(SELECT 1 FROM player_save WHERE player_id=?12)"
    : "EXISTS(SELECT 1 FROM player_save WHERE player_id=?12 AND revision=?13)";
}

async function get(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const requestedUsername = url.searchParams.get("username");
  try {
    if (request.method === "HEAD") return new Response(null, { headers: json({}).headers });
    if (requestedUsername !== null) {
      if (!username(requestedUsername, true)) return json({ error: "username is invalid" }, 422);
      const row = await find(db, requestedUsername);
      return row ? json({ player: publicRow(row), source: "cloud" }) : json({ error: "Player was not found" }, 404);
    }
    const days = recentMalaysiaDays();
    const jsonValue = (path: string) => `CASE WHEN json_valid(s.save_json) THEN json_extract(s.save_json,'${path}') END`;
    const dailyColumns = days.flatMap((day, index) => [
      `${jsonValue(`$.player.dailyStats."${day}".won`)} AS day${index}Won`,
      `${jsonValue(`$.player.dailyStats."${day}".spent`)} AS day${index}Spent`,
    ]).join(",");
    const summarySelect = "SELECT a.id AS id,a.username AS username,a.email AS email,a.display_name AS displayName,"
      + "a.avatar AS avatar,a.color AS color,a.role AS role,a.created_at AS createdAt,"
      + "s.revision AS revision,s.updated_at AS savedAt,"
      + `${jsonValue("$.player.coins")} AS coins,${jsonValue("$.player.ticketsPlayed")} AS ticketsPlayed,`
      + `${jsonValue("$.player.level")} AS level,${jsonValue("$.player.totalWon")} AS totalWon,`
      + `${jsonValue("$.player.totalSpent")} AS totalSpent,${dailyColumns} `
      + "FROM player_account a LEFT JOIN player_save s ON s.player_id=a.id ORDER BY a.username LIMIT 500";
    const rows = (await db.prepare(summarySelect).run<SummaryRow>()).results || [];
    return json({ players: rows.map((row) => summaryRow(row, days)), source: "cloud" });
  } catch (error) {
    if (missingTable(error)) return json({ players: [], source: "cloud" });
    console.error("manager-players-get", error instanceof Error ? error.message : error);
    return json({ error: "Player storage is temporarily unavailable" }, 503);
  }
}
async function patch(request: Request, db: D1Database): Promise<Response> {
  const originError = strictSameOriginError(request); if (originError) return originError;
  const parsed = await body(request); if (parsed instanceof Response) return parsed;
  const invalid = validatePatch(parsed); if (invalid) return invalid;
  let row: Row | null;
  try { row = await find(db, parsed.targetUsername as string); }
  catch (error) { return missingTable(error) ? json({ error: "Player was not found" }, 404) : json({ error: "Player storage is unavailable" }, 503); }
  if (!row) return json({ error: "Player was not found" }, 404);
  const expected = parsed.expectedRevision as number;
  if (revision(row) !== expected) return json({ error: "Player save changed; reload before saving", code: "revision_conflict", currentRevision: revision(row) }, 409);
  const test = row.id === TEST_ID || row.role === "test" || row.usernameNormalized === "test";
  const nextUsername = parsed.username === undefined ? row.username : parsed.username;
  const nextName = parsed.displayName === undefined ? row.displayName : parsed.displayName;
  const nextEmail = parsed.email === undefined ? row.email : parsed.email;
  const nextAvatar = parsed.avatar === undefined ? row.avatar : parsed.avatar;
  const nextColor = parsed.color === undefined ? row.color : parsed.color;
  if ((!username(nextUsername) && nextUsername !== row.username)) return json({ error: "username is invalid or reserved" }, 422);
  if (!displayName(nextName)) return json({ error: "displayName is invalid" }, 422);
  if (!email(nextEmail)) return json({ error: "email is invalid" }, 422);
  if (typeof nextAvatar !== "string" || !AVATARS.has(nextAvatar)) return json({ error: "avatar is invalid" }, 422);
  if (typeof nextColor !== "string" || !COLORS.has(nextColor)) return json({ error: "color is invalid" }, 422);
  if (parsed.newPassword !== undefined && (typeof parsed.newPassword !== "string" || parsed.newPassword.length < 8 || parsed.newPassword.length > 128)) {
    return json({ error: "newPassword must contain 8 to 128 characters" }, 422);
  }
  const renamed = nextUsername !== row.username;
  if (test && (renamed || parsed.newPassword !== undefined || parsed.action === "reset")) {
    return json({ error: "The built-in test player's username, password, and save cannot be reset" }, 403);
  }
  const gameChanged = GAME_KEYS.some((key) => key in parsed);
  const profileChanged = ["username", "displayName", "email", "avatar", "color", "newPassword"].some((key) => key in parsed);
  if (!gameChanged && !profileChanged && parsed.action !== "reset") return json({ error: "No editable fields were provided" }, 422);
  const now = Date.now();
  let nextSave: string | null = null;
  if (parsed.action === "reset") nextSave = freshSave(now);
  else if (gameChanged) { const result = updateSave(row, parsed); if (result instanceof Response) return result; nextSave = result; }
  let hash = row.passwordHash, salt = row.passwordSalt, algorithm = row.passwordAlgorithm;
  if (typeof parsed.newPassword === "string") { const result = await password(parsed.newPassword); hash = result.hash; salt = result.salt; algorithm = ALGORITHM; }
  const statements: D1PreparedStatement[] = [db.prepare(
    "UPDATE player_account SET username=?1,username_normalized=?2,email=?3,email_normalized=?4,"
    + "display_name=?5,avatar=?6,color=?7,password_hash=?8,password_salt=?9,password_algorithm=?10,"
    + "auth_revision=auth_revision+?11,updated_at=?14 WHERE id=?12 AND " + guardedWhere(expected),
  ).bind(nextUsername, (nextUsername as string).toLowerCase(), (nextEmail as string).trim(),
    (nextEmail as string).trim().toLowerCase(), (nextName as string).trim(), nextAvatar, nextColor,
    hash, salt, algorithm, renamed || typeof parsed.newPassword === "string" || parsed.action === "reset" ? 1 : 0, row.id, expected, now)];
  if (nextSave !== null && expected === 0) statements.push(db.prepare(
    "INSERT INTO player_save (player_id,save_json,revision,updated_at) VALUES (?1,?2,1,?3)",
  ).bind(row.id, nextSave, now));
  else if (nextSave !== null) statements.push(db.prepare(
    "UPDATE player_save SET save_json=?1,revision=revision+1,updated_at=?2 WHERE player_id=?3 AND revision=?4",
  ).bind(nextSave, now, row.id, expected));
  try {
    const results = await (db as D1DatabaseWithBatch).batch(statements);
    if (changes(results[0]) !== 1 || (statements.length > 1 && changes(results[1]) !== 1)) {
      return json({ error: "Player save changed; reload before saving", code: "revision_conflict" }, 409);
    }
    const updated = await find(db, nextUsername as string);
    return updated ? json({ player: publicRow(updated), source: "cloud" }) : json({ error: "Player was not found" }, 404);
  } catch (error) {
    if (conflict(error)) return json({ error: "Username or email is already in use", code: "identity_conflict" }, 409);
    console.error("manager-players-patch", error instanceof Error ? error.message : error);
    return json({ error: "Player update failed" }, 503);
  }
}
async function remove(request: Request, db: D1Database): Promise<Response> {
  const originError = strictSameOriginError(request); if (originError) return originError;
  const parsed = await body(request); if (parsed instanceof Response) return parsed;
  if (Object.keys(parsed).some((key) => key !== "targetUsername" && key !== "expectedRevision")
    || !username(parsed.targetUsername, true) || !integer(parsed.expectedRevision, 2_147_483_647)) {
    return json({ error: "DELETE requires targetUsername and expectedRevision only" }, 422);
  }
  let row: Row | null;
  try { row = await find(db, parsed.targetUsername); }
  catch (error) { return missingTable(error) ? json({ error: "Player was not found" }, 404) : json({ error: "Player storage is unavailable" }, 503); }
  if (!row) return json({ error: "Player was not found" }, 404);
  if (row.id === TEST_ID || row.role === "test" || row.usernameNormalized === "test") return json({ error: "The built-in test player cannot be deleted" }, 403);
  const expected = parsed.expectedRevision;
  if (revision(row) !== expected) return json({ error: "Player save changed; reload before deleting", code: "revision_conflict", currentRevision: revision(row) }, 409);
  const guard = expected === 0
    ? "NOT EXISTS(SELECT 1 FROM player_save WHERE player_id=?1)"
    : "EXISTS(SELECT 1 FROM player_save WHERE player_id=?1 AND revision=?2)";
  try {
    const deleteAccount = db.prepare(`DELETE FROM player_account WHERE id=?1 AND ${guard}`);
    const results = await (db as D1DatabaseWithBatch).batch([
      expected === 0 ? deleteAccount.bind(row.id) : deleteAccount.bind(row.id, expected),
      // Older databases were created before player_save had a foreign key.
      // Remove any orphan explicitly while keeping the revision guard atomic.
      db.prepare("DELETE FROM player_save WHERE player_id=?1 AND NOT EXISTS(SELECT 1 FROM player_account WHERE id=?1)").bind(row.id),
    ]);
    return changes(results[0]) === 1
      ? json({ deleted: true, username: row.username, source: "cloud" })
      : json({ error: "Player save changed; reload before deleting", code: "revision_conflict" }, 409);
  } catch (error) {
    console.error("manager-players-delete", error instanceof Error ? error.message : error);
    return json({ error: "Player deletion failed" }, 503);
  }
}

export async function handleManagerPlayersApi(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null;
  if (!["GET", "HEAD", "PATCH", "DELETE"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  const manager = await verifyManagerSession(request, env);
  if (!manager || (manager.role !== "owner" && manager.role !== "admin")) return json({ error: "Manager session is invalid or expired" }, 401);
  if (!env.DB) return json({ error: "Player storage is unavailable" }, 503);
  if (request.method === "GET" || request.method === "HEAD") return get(request, env.DB);
  return request.method === "PATCH" ? patch(request, env.DB) : remove(request, env.DB);
}
