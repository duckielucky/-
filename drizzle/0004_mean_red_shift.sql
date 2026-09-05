-- Normalize player_save before adding the cascade expected by the runtime and
-- manager player-deletion flow. Old databases can contain orphan rows because
-- the original table did not declare this foreign key.
DELETE FROM `player_save`
WHERE NOT EXISTS (
	SELECT 1 FROM `player_account` WHERE `player_account`.`id` = `player_save`.`player_id`
);--> statement-breakpoint
CREATE TABLE `__new_player_save` (
	`player_id` text PRIMARY KEY NOT NULL,
	`save_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `player_account`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;--> statement-breakpoint
INSERT INTO `__new_player_save` (`player_id`, `save_json`, `revision`, `updated_at`)
SELECT `player_id`, `save_json`, `revision`, `updated_at` FROM `player_save`;--> statement-breakpoint
DROP TABLE `player_save`;--> statement-breakpoint
ALTER TABLE `__new_player_save` RENAME TO `player_save`;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `manager_admin` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_normalized` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_algorithm` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`auth_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `manager_admin_username_normalized_unique` ON `manager_admin` (`username_normalized`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `player_support_ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`manager_reply` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`replied_at` integer,
	FOREIGN KEY (`player_id`) REFERENCES `player_account`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `player_support_ticket_kind_check` CHECK (`kind` IN ('support', 'report')),
	CONSTRAINT `player_support_ticket_status_check` CHECK (`status` IN ('open', 'in_progress', 'resolved', 'closed'))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `player_support_ticket_player_request_unique` ON `player_support_ticket` (`player_id`,`request_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `player_support_ticket_player_created_idx` ON `player_support_ticket` (`player_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `player_support_ticket_status_created_idx` ON `player_support_ticket` (`status`,`created_at`);
