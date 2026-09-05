import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** One authoritative operator configuration shared by every Lucky client. */
export const gameConfig = sqliteTable("game_config", {
  key: text("key").primaryKey(),
  configJson: text("config_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

/** Password hash for the cloud-synced manager login. */
export const managerSecret = sqliteTable("manager_secret", {
  key: text("key").primaryKey(),
  hash: text("hash").notNull(),
  salt: text("salt").notNull(),
  algorithm: text("algorithm").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Mutable manager login identity, kept separate from public game configuration. */
export const managerAccount = sqliteTable("manager_account", {
  key: text("key").primaryKey(),
  username: text("username").notNull(),
  usernameNormalized: text("username_normalized").notNull().unique(),
  updatedAt: integer("updated_at").notNull(),
});

/** Secondary manager profiles created and controlled by the bootstrap owner. */
export const managerAdmin = sqliteTable("manager_admin", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  usernameNormalized: text("username_normalized").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordAlgorithm: text("password_algorithm").notNull(),
  active: integer("active").notNull().default(1),
  authRevision: integer("auth_revision").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Opaque, short-lived counters for manager login brute-force protection. */
export const managerLoginThrottle = sqliteTable("manager_login_throttle", {
  key: text("key").primaryKey(),
  failedAttempts: integer("failed_attempts").notNull(),
  windowStartedAt: integer("window_started_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("manager_login_throttle_updated_at_idx").on(table.updatedAt),
]);

/** Cloud player identity shared by every device signed into the same account. */
export const playerAccount = sqliteTable("player_account", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  usernameNormalized: text("username_normalized").notNull().unique(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatar: text("avatar").notNull(),
  color: text("color").notNull(),
  role: text("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordAlgorithm: text("password_algorithm").notNull(),
  authRevision: integer("auth_revision").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** The latest authoritative game snapshot for a player, guarded by a revision. */
export const playerSave = sqliteTable("player_save", {
  playerId: text("player_id").primaryKey().references(() => playerAccount.id, { onDelete: "cascade" }),
  saveJson: text("save_json").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

/** Player-created customer-service and report records shared across devices. */
export const playerSupportTicket = sqliteTable("player_support_ticket", {
  id: text("id").primaryKey(),
  playerId: text("player_id").notNull().references(() => playerAccount.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  kind: text("kind").notNull(),
  category: text("category").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("open"),
  managerReply: text("manager_reply"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  repliedAt: integer("replied_at"),
}, (table) => [
  uniqueIndex("player_support_ticket_player_request_unique").on(table.playerId, table.requestId),
  index("player_support_ticket_player_created_idx").on(table.playerId, table.createdAt),
  index("player_support_ticket_status_created_idx").on(table.status, table.createdAt),
  check("player_support_ticket_kind_check", sql`${table.kind} IN ('support', 'report')`),
  check("player_support_ticket_status_check", sql`${table.status} IN ('open', 'in_progress', 'resolved', 'closed')`),
]);

/** Opaque, short-lived counters for player login brute-force protection. */
export const playerLoginThrottle = sqliteTable("player_login_throttle", {
  key: text("key").primaryKey(),
  failedAttempts: integer("failed_attempts").notNull(),
  windowStartedAt: integer("window_started_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("player_login_throttle_updated_at_idx").on(table.updatedAt),
]);
