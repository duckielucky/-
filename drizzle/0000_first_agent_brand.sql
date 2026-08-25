CREATE TABLE `game_config` (
	`key` text PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
