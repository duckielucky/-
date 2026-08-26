CREATE TABLE `manager_secret` (
	`key` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`salt` text NOT NULL,
	`algorithm` text NOT NULL,
	`updated_at` integer NOT NULL
);
