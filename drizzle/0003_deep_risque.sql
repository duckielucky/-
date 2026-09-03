CREATE TABLE `player_account` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_normalized` text NOT NULL,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar` text NOT NULL,
	`color` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_algorithm` text NOT NULL,
	`auth_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_account_username_normalized_unique` ON `player_account` (`username_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `player_account_email_normalized_unique` ON `player_account` (`email_normalized`);--> statement-breakpoint
CREATE TABLE `player_login_throttle` (
	`key` text PRIMARY KEY NOT NULL,
	`failed_attempts` integer NOT NULL,
	`window_started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `player_login_throttle_updated_at_idx` ON `player_login_throttle` (`updated_at`);--> statement-breakpoint
CREATE TABLE `player_save` (
	`player_id` text PRIMARY KEY NOT NULL,
	`save_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
