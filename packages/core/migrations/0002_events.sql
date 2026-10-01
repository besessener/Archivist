CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`occurred_at` text NOT NULL,
	`topic_id` text,
	`project_id` text,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_occurred_idx` ON `events` (`occurred_at`);
