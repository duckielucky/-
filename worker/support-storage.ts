export const PLAYER_SUPPORT_PATH = "/api/player/support";
export const MANAGER_SUPPORT_PATH = "/api/manager/support";

export const SUPPORT_KINDS = ["support", "report"] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];

export const SUPPORT_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

const SUPPORT_CATEGORIES = {
  support: new Set(["account", "gameplay", "topup", "bug", "other"]),
  report: new Set(["player", "cheating", "abuse", "other"]),
} satisfies Record<SupportKind, ReadonlySet<string>>;

const PLAYER_TICKET_LIMIT = 20;
const MANAGER_TICKET_LIMIT_DEFAULT = 50;
export const MANAGER_TICKET_LIMIT_MAX = 100;
export const SUPPORT_RATE_LIMIT_MAX = 5;
export const SUPPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MESSAGE_MIN_LENGTH = 3;
const MESSAGE_MAX_LENGTH = 2_000;
const REPLY_MAX_LENGTH = 2_000;

const CREATE_SUPPORT_TABLE = `
  CREATE TABLE IF NOT EXISTS player_support_ticket (
    id TEXT PRIMARY KEY NOT NULL,
    player_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('support', 'report')),
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    manager_reply TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    replied_at INTEGER,
    FOREIGN KEY (player_id) REFERENCES player_account(id) ON DELETE CASCADE,
    UNIQUE (player_id, request_id)
  ) WITHOUT ROWID
`;

const CREATE_PLAYER_CREATED_INDEX = `
  CREATE INDEX IF NOT EXISTS player_support_ticket_player_created_idx
  ON player_support_ticket (player_id, created_at)
`;

const CREATE_STATUS_CREATED_INDEX = `
  CREATE INDEX IF NOT EXISTS player_support_ticket_status_created_idx
  ON player_support_ticket (status, created_at)
`;

let supportSchemaReady: Promise<void> | null = null;

export async function ensureSupportSchema(db: D1Database): Promise<void> {
  if (!supportSchemaReady) {
    supportSchemaReady = (async () => {
      await db.prepare(CREATE_SUPPORT_TABLE).run();
      await db.prepare(CREATE_PLAYER_CREATED_INDEX).run();
      await db.prepare(CREATE_STATUS_CREATED_INDEX).run();
    })().catch((cause) => {
      supportSchemaReady = null;
      throw cause;
    });
  }
  await supportSchemaReady;
}

export type PlayerSupportSubmission = {
  requestId: string;
  kind: SupportKind;
  category: string;
  message: string;
};

export type ManagerSupportUpdate = {
  id: string;
  status?: SupportStatus;
  reply?: string | null;
};

export type PlayerSupportTicket = {
  id: string;
  requestId: string;
  kind: SupportKind;
  category: string;
  message: string;
  status: SupportStatus;
  reply: string | null;
  createdAt: number;
  updatedAt: number;
  repliedAt: number | null;
};

export type ManagerSupportTicket = PlayerSupportTicket & {
  player: {
    username: string;
    displayName: string;
    email: string;
    role: "player" | "test";
  };
};

type StoredSupportTicket = {
  id: string;
  requestId: string;
  kind: string;
  category: string;
  message: string;
  status: string;
  reply: string | null;
  createdAt: number;
  updatedAt: number;
  repliedAt: number | null;
};

type StoredManagerSupportTicket = StoredSupportTicket & {
  username: string;
  displayName: string;
  email: string;
  role: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseSupportKind(value: unknown): SupportKind | null {
  return typeof value === "string" && (SUPPORT_KINDS as readonly string[]).includes(value)
    ? value as SupportKind
    : null;
}

export function parseSupportStatus(value: unknown): SupportStatus | null {
  return typeof value === "string" && (SUPPORT_STATUSES as readonly string[]).includes(value)
    ? value as SupportStatus
    : null;
}

function normalizeText(value: unknown, minLength: number, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const characters = Array.from(normalized);
  if (characters.length < minLength || characters.length > maxLength) return null;
  const hasUnsafeControl = characters.some((character) => {
    const code = character.codePointAt(0) || 0;
    return (code < 32 && character !== "\n" && character !== "\t") || code === 127;
  });
  return hasUnsafeControl ? null : normalized;
}

function parseRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const requestId = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
}

function parseTicketId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{24}$/.test(value) ? value : null;
}

export function parsePlayerSupportSubmission(value: unknown): PlayerSupportSubmission | null {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["requestId", "kind", "category", "message"]))) return null;
  const requestId = parseRequestId(value.requestId);
  const kind = parseSupportKind(value.kind);
  const category = typeof value.category === "string" ? value.category.trim().toLowerCase() : "";
  const message = normalizeText(value.message, MESSAGE_MIN_LENGTH, MESSAGE_MAX_LENGTH);
  if (!requestId || !kind || !SUPPORT_CATEGORIES[kind].has(category) || !message) return null;
  return { requestId, kind, category, message };
}

export function parseManagerSupportUpdate(value: unknown): ManagerSupportUpdate | null {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["id", "status", "reply"]))) return null;
  const id = parseTicketId(value.id);
  const hasStatus = Object.prototype.hasOwnProperty.call(value, "status");
  const hasReply = Object.prototype.hasOwnProperty.call(value, "reply");
  if (!id || (!hasStatus && !hasReply)) return null;

  const status = hasStatus ? parseSupportStatus(value.status) : undefined;
  if (hasStatus && !status) return null;

  let reply: string | null | undefined;
  if (hasReply) {
    if (value.reply === null) reply = null;
    else if (typeof value.reply === "string" && value.reply.trim() === "") reply = null;
    else {
      reply = normalizeText(value.reply, 1, REPLY_MAX_LENGTH);
      if (!reply) return null;
    }
  }
  if (status === "resolved" && (!hasReply || reply === null)) return null;
  return { id, ...(status ? { status } : {}), ...(hasReply ? { reply: reply ?? null } : {}) };
}

function randomTicketId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isKind(value: string): value is SupportKind {
  return (SUPPORT_KINDS as readonly string[]).includes(value);
}

function isStatus(value: string): value is SupportStatus {
  return (SUPPORT_STATUSES as readonly string[]).includes(value);
}

function finiteTimestamp(value: number | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Stored support timestamp is invalid");
  return number;
}

function toPlayerTicket(row: StoredSupportTicket): PlayerSupportTicket {
  if (!isKind(row.kind) || !isStatus(row.status)) throw new Error("Stored support ticket is invalid");
  return {
    id: row.id,
    requestId: row.requestId,
    kind: row.kind,
    category: row.category,
    message: row.message,
    status: row.status,
    reply: typeof row.reply === "string" ? row.reply : null,
    createdAt: finiteTimestamp(row.createdAt) as number,
    updatedAt: finiteTimestamp(row.updatedAt) as number,
    repliedAt: finiteTimestamp(row.repliedAt),
  };
}

const SUPPORT_SELECT = `SELECT id, request_id AS requestId, kind, category, message, status,
  manager_reply AS reply, created_at AS createdAt, updated_at AS updatedAt, replied_at AS repliedAt
  FROM player_support_ticket`;

async function findPlayerTicketByRequestId(
  db: D1Database,
  playerId: string,
  requestId: string,
): Promise<PlayerSupportTicket | null> {
  const row = await db.prepare(
    `${SUPPORT_SELECT} WHERE player_id = ?1 AND request_id = ?2 LIMIT 1`,
  ).bind(playerId, requestId).first<StoredSupportTicket>();
  return row ? toPlayerTicket(row) : null;
}

export type CreateSupportTicketResult =
  | { outcome: "created" | "duplicate"; ticket: PlayerSupportTicket }
  | { outcome: "idempotency_conflict" }
  | { outcome: "rate_limited"; retryAfter: number };

function matchesSubmission(ticket: PlayerSupportTicket, submission: PlayerSupportSubmission): boolean {
  return ticket.kind === submission.kind
    && ticket.category === submission.category
    && ticket.message === submission.message;
}

export async function createPlayerSupportTicket(
  db: D1Database,
  playerId: string,
  submission: PlayerSupportSubmission,
): Promise<CreateSupportTicketResult> {
  await ensureSupportSchema(db);
  const duplicate = await findPlayerTicketByRequestId(db, playerId, submission.requestId);
  if (duplicate) {
    return matchesSubmission(duplicate, submission)
      ? { outcome: "duplicate", ticket: duplicate }
      : { outcome: "idempotency_conflict" };
  }

  const now = Date.now();
  const cutoff = now - SUPPORT_RATE_LIMIT_WINDOW_MS;
  const id = randomTicketId();
  const result = await db.prepare(
    `INSERT INTO player_support_ticket
      (id, player_id, request_id, kind, category, message, status, manager_reply, created_at, updated_at, replied_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'open', NULL, ?7, ?7, NULL
      WHERE (SELECT COUNT(*) FROM player_support_ticket WHERE player_id = ?2 AND created_at >= ?8) < ?9
      ON CONFLICT(player_id, request_id) DO NOTHING`,
  ).bind(
    id,
    playerId,
    submission.requestId,
    submission.kind,
    submission.category,
    submission.message,
    now,
    cutoff,
    SUPPORT_RATE_LIMIT_MAX,
  ).run();

  if (Number(result.meta?.changes || 0) === 1) {
    const created = await findPlayerTicketByRequestId(db, playerId, submission.requestId);
    if (!created) throw new Error("Support ticket insert did not persist");
    return { outcome: "created", ticket: created };
  }

  const racedDuplicate = await findPlayerTicketByRequestId(db, playerId, submission.requestId);
  if (racedDuplicate) {
    return matchesSubmission(racedDuplicate, submission)
      ? { outcome: "duplicate", ticket: racedDuplicate }
      : { outcome: "idempotency_conflict" };
  }

  const oldest = await db.prepare(
    "SELECT MIN(created_at) AS createdAt FROM player_support_ticket WHERE player_id = ?1 AND created_at >= ?2",
  ).bind(playerId, cutoff).first<{ createdAt: number | null }>();
  const oldestAt = oldest?.createdAt === null || oldest?.createdAt === undefined
    ? Number.NaN
    : Number(oldest.createdAt);
  const retryAfter = Number.isSafeInteger(oldestAt) && oldestAt >= 0
    ? Math.max(1, Math.ceil((oldestAt + SUPPORT_RATE_LIMIT_WINDOW_MS - now) / 1_000))
    : Math.ceil(SUPPORT_RATE_LIMIT_WINDOW_MS / 1_000);
  return { outcome: "rate_limited", retryAfter };
}

export async function listPlayerSupportTickets(db: D1Database, playerId: string): Promise<PlayerSupportTicket[]> {
  await ensureSupportSchema(db);
  const result = await db.prepare(
    `${SUPPORT_SELECT} WHERE player_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2`,
  ).bind(playerId, PLAYER_TICKET_LIMIT).run<StoredSupportTicket>();
  return (result.results || []).map(toPlayerTicket);
}

export async function listManagerSupportTickets(
  db: D1Database,
  filters: { status: SupportStatus | null; kind: SupportKind | null; limit?: number },
): Promise<ManagerSupportTicket[]> {
  await ensureSupportSchema(db);
  const limit = Math.max(1, Math.min(MANAGER_TICKET_LIMIT_MAX, filters.limit || MANAGER_TICKET_LIMIT_DEFAULT));
  const result = await db.prepare(
    `SELECT t.id, t.request_id AS requestId, t.kind, t.category, t.message, t.status,
      t.manager_reply AS reply, t.created_at AS createdAt, t.updated_at AS updatedAt, t.replied_at AS repliedAt,
      a.username, a.display_name AS displayName, a.email, a.role
      FROM player_support_ticket t
      INNER JOIN player_account a ON a.id = t.player_id
      WHERE (?1 IS NULL OR t.status = ?1) AND (?2 IS NULL OR t.kind = ?2)
      ORDER BY t.updated_at DESC, t.id DESC LIMIT ?3`,
  ).bind(filters.status, filters.kind, limit).run<StoredManagerSupportTicket>();
  return (result.results || []).map((row) => ({
    ...toPlayerTicket(row),
    player: {
      username: row.username,
      displayName: row.displayName,
      email: row.email,
      role: row.role === "test" ? "test" : "player",
    },
  }));
}

async function findManagerSupportTicket(db: D1Database, id: string): Promise<ManagerSupportTicket | null> {
  const result = await db.prepare(
    `SELECT t.id, t.request_id AS requestId, t.kind, t.category, t.message, t.status,
      t.manager_reply AS reply, t.created_at AS createdAt, t.updated_at AS updatedAt, t.replied_at AS repliedAt,
      a.username, a.display_name AS displayName, a.email, a.role
      FROM player_support_ticket t
      INNER JOIN player_account a ON a.id = t.player_id
      WHERE t.id = ?1 LIMIT 1`,
  ).bind(id).first<StoredManagerSupportTicket>();
  return result ? {
    ...toPlayerTicket(result),
    player: {
      username: result.username,
      displayName: result.displayName,
      email: result.email,
      role: result.role === "test" ? "test" : "player",
    },
  } : null;
}

export async function updateManagerSupportTicket(
  db: D1Database,
  update: ManagerSupportUpdate,
): Promise<ManagerSupportTicket | null> {
  await ensureSupportSchema(db);
  const changesStatus = update.status !== undefined;
  const changesReply = Object.prototype.hasOwnProperty.call(update, "reply");
  const reply = changesReply ? update.reply ?? null : null;
  const now = Date.now();
  await db.prepare(
    `UPDATE player_support_ticket SET
      status = CASE WHEN ?2 = 1 THEN ?3 ELSE status END,
      manager_reply = CASE WHEN ?4 = 1 THEN ?5 ELSE manager_reply END,
      replied_at = CASE WHEN ?4 = 1 THEN CASE WHEN ?5 IS NULL THEN NULL ELSE ?6 END ELSE replied_at END,
      updated_at = ?6
      WHERE id = ?1`,
  ).bind(update.id, changesStatus ? 1 : 0, update.status ?? null, changesReply ? 1 : 0, reply, now).run();
  return findManagerSupportTicket(db, update.id);
}
