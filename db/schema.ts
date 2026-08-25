import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One authoritative operator configuration shared by every Lucky client. */
export const gameConfig = sqliteTable("game_config", {
  key: text("key").primaryKey(),
  configJson: text("config_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});
