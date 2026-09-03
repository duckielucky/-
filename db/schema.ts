import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  playerId: text("player_id").primaryKey(),
  saveJson: text("save_json").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

/** Opaque, short-lived counters for player login brute-force protection. */
export const playerLoginThrottle = sqliteTable("player_login_throttle", {
  key: text("key").primaryKey(),
  failedAttempts: integer("failed_attempts").notNull(),
  windowStartedAt: integer("window_started_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("player_login_throttle_updated_at_idx").on(table.updatedAt),
]);
