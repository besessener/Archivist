CREATE TABLE `blocked_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_subjects_unique_idx` ON `blocked_subjects` (`type`,`normalized_name`);