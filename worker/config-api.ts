const CONFIG_PATH = "/api/config";
const CONFIG_KEY = "global";
const MAX_BODY_BYTES = 96 * 1024;
let schemaReady: Promise<void> | null = null;

type ConfigEnv = {
  DB?: D1Database;
  MANAGER_TOKEN?: string;
};

type StoredConfigRow = {
  configJson: string;
  version: number;
  updatedAt: number;
};

type TierConfig = {
  id: string;
  name: string;
  shortName: string;
  maxLabel: string;
  feature: string;
  cost: number;
  unlockLevel: number;
  accent: string;
  accent2: string;
  prizePool: number[];
  multipliers: number[];
  specialChance: number;
};

type OperatorConfig = {
  schemaVersion: 1;
  updatedAt: number;
  multiplierMinLevel: number;
  odds: { m0: number; m1: number; m2: number; m3: number };
  tiers: TierConfig[];
};

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS game_config (
    key TEXT PRIMARY KEY NOT NULL,
    config_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID
`;

function json(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(payload), { status, headers });
}

function error(message: string, status: number, details?: unknown): Response {
  return json({ error: message, ...(details === undefined ? {} : { details }) }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw new Error(`${label} must contain 1-${maxLength} characters`);
  return result;
}

function readInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function readNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}`);
  }
  return value;
}

function readNumberList(value: unknown, label: string, min: number, max: number, maxItems: number): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new Error(`${label} must contain 1-${maxItems} values`);
  }
  const result = value.map((entry, index) => readNumber(entry, `${label}[${index}]`, min, max));
  if (new Set(result).size !== result.length) throw new Error(`${label} cannot contain duplicate values`);
  return result;
}

function validateConfig(value: unknown, updatedAt: number): OperatorConfig {
  if (!isRecord(value)) throw new Error("config must be an object");
  if (!isRecord(value.odds)) throw new Error("odds must be an object");
  if (!Array.isArray(value.tiers) || value.tiers.length < 1 || value.tiers.length > 12) {
    throw new Error("tiers must contain 1-12 ticket types");
  }

  const odds = {
    m0: readNumber(value.odds.m0, "odds.m0", 0, 1),
    m1: readNumber(value.odds.m1, "odds.m1", 0, 1),
    m2: readNumber(value.odds.m2, "odds.m2", 0, 1),
    m3: readNumber(value.odds.m3, "odds.m3", 0, 1),
  };
  if (odds.m0 + odds.m1 + odds.m2 + odds.m3 <= 0) throw new Error("at least one winning probability must be above zero");

  const seenIds = new Set<string>();
  const tiers = value.tiers.map((rawTier, index): TierConfig => {
    if (!isRecord(rawTier)) throw new Error(`tiers[${index}] must be an object`);
    const id = readString(rawTier.id, `tiers[${index}].id`, 40);
    if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`tiers[${index}].id may only use letters, numbers, _ and -`);
    if (seenIds.has(id)) throw new Error(`duplicate ticket id: ${id}`);
    seenIds.add(id);

    const accent = readString(rawTier.accent, `tiers[${index}].accent`, 7);
    const accent2 = readString(rawTier.accent2, `tiers[${index}].accent2`, 7);
    if (!/^#[0-9a-f]{6}$/i.test(accent) || !/^#[0-9a-f]{6}$/i.test(accent2)) {
      throw new Error(`tiers[${index}] colors must use #RRGGBB`);
    }

    return {
      id,
      name: readString(rawTier.name, `tiers[${index}].name`, 40),
      shortName: readString(rawTier.shortName, `tiers[${index}].shortName`, 12),
      maxLabel: readString(rawTier.maxLabel, `tiers[${index}].maxLabel`, 12),
      feature: readString(rawTier.feature, `tiers[${index}].feature`, 60),
      cost: readInteger(rawTier.cost, `tiers[${index}].cost`, 1, 1_000_000_000),
      unlockLevel: readInteger(rawTier.unlockLevel, `tiers[${index}].unlockLevel`, 1, 1_000_000),
      accent: accent.toLowerCase(),
      accent2: accent2.toLowerCase(),
      prizePool: readNumberList(rawTier.prizePool, `tiers[${index}].prizePool`, 0.01, 1_000_000_000_000, 64),
      multipliers: readNumberList(rawTier.multipliers, `tiers[${index}].multipliers`, 1, 1_000_000, 32),
      specialChance: readNumber(rawTier.specialChance, `tiers[${index}].specialChance`, 0, 1),
    };
  });

  return {
    schemaVersion: 1,
    updatedAt,
    multiplierMinLevel: readInteger(value.multiplierMinLevel, "multiplierMinLevel", 1, 1_000_000),
    odds,
    tiers,
  };
}

function secureEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index % Math.max(a.length, 1)] || 0) ^ (b[index % Math.max(b.length, 1)] || 0);
  return mismatch === 0;
}

function bearerToken(request: Request): string {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  return match ? match[1] : "";
}

async function ensureTable(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.prepare(CREATE_TABLE).run().then(() => undefined).catch((cause) => {
      schemaReady = null;
      throw cause;
    });
  }
  await schemaReady;
}

async function currentRow(db: D1Database): Promise<StoredConfigRow | null> {
  return db.prepare(
    "SELECT config_json AS configJson, version, updated_at AS updatedAt FROM game_config WHERE key = ?1",
  ).bind(CONFIG_KEY).first<StoredConfigRow>();
}

async function getConfig(db: D1Database, request: Request): Promise<Response> {
  const row = await currentRow(db);
  if (!row) return json({ config: null, version: 0, updatedAt: 0 });
  let config: unknown;
  try {
    config = JSON.parse(row.configJson);
  } catch {
    return error("The stored game configuration is damaged", 500);
  }
  const etag = `\"lucky-config-v${row.version}\"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  }
  return json({ config, version: row.version, updatedAt: row.updatedAt }, 200, { etag });
}

async function putConfig(db: D1Database, request: Request, env: ConfigEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return error("Cross-origin manager writes are not allowed", 403);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return error("Cross-site manager writes are not allowed", 403);

  if (!env.MANAGER_TOKEN) return error("Manager synchronization is not configured", 503);
  if (!secureEqual(bearerToken(request), env.MANAGER_TOKEN)) return error("Manager key is invalid", 401);
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }
  const advertisedSize = Number(request.headers.get("content-length") || 0);
  if (advertisedSize > MAX_BODY_BYTES) return error("Configuration is too large", 413);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return error("Configuration is too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error("Request body is not valid JSON", 400);
  }
  if (!isRecord(body)) return error("Request body must be an object", 400);
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return error("expectedVersion must be a non-negative integer", 400);

  const updatedAt = Date.now();
  let config: OperatorConfig;
  try {
    config = validateConfig(body.config, updatedAt);
  } catch (validationError) {
    return error(validationError instanceof Error ? validationError.message : "Configuration is invalid", 422);
  }

  const encoded = JSON.stringify(config);
  let writeResult: D1Result<unknown>;
  if (expectedVersion === 0) {
    writeResult = await db.prepare(
      "INSERT INTO game_config (key, config_json, version, updated_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(key) DO NOTHING",
    ).bind(CONFIG_KEY, encoded, updatedAt).run();
  } else {
    writeResult = await db.prepare(
      "UPDATE game_config SET config_json = ?1, version = version + 1, updated_at = ?2 WHERE key = ?3 AND version = ?4",
    ).bind(encoded, updatedAt, CONFIG_KEY, expectedVersion).run();
  }

  if ((writeResult.meta.changes || 0) !== 1) {
    const latest = await currentRow(db);
    return error("This configuration changed in another manager. Reload before saving again.", 409, {
      version: latest?.version || 0,
      updatedAt: latest?.updatedAt || 0,
    });
  }

  const version = expectedVersion + 1;
  return json({ config, version, updatedAt }, 200, { etag: `\"lucky-config-v${version}\"` });
}

export async function handleConfigApi(request: Request, env: ConfigEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== CONFIG_PATH) return null;
  if (!env.DB) return error("Shared configuration storage is unavailable", 503);
  try {
    await ensureTable(env.DB);
    if (request.method === "GET" || request.method === "HEAD") {
      const response = await getConfig(env.DB, request);
      return request.method === "HEAD" ? new Response(null, response) : response;
    }
    if (request.method === "PUT") return putConfig(env.DB, request, env);
    return json({ error: "Method not allowed" }, 405, { allow: "GET, HEAD, PUT" });
  } catch (databaseError) {
    console.error("config-api", databaseError instanceof Error ? databaseError.message : databaseError);
    return error("Shared configuration storage is temporarily unavailable", 503);
  }
}
