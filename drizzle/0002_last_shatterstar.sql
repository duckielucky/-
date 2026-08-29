CREATE TABLE IF NOT EXISTS `manager_account` (
	`key` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_normalized` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `manager_account_username_normalized_unique` ON `manager_account` (`username_normalized`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `manager_login_throttle` (
	`key` text PRIMARY KEY NOT NULL,
	`failed_attempts` integer NOT NULL,
	`window_started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `manager_login_throttle_updated_at_idx` ON `manager_login_throttle` (`updated_at`);
