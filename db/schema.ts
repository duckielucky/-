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
