CREATE TABLE `agent_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`data` text,
	`enabled` integer DEFAULT true NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`times_applied` integer DEFAULT 0 NOT NULL,
	`last_applied_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_memory_kind_idx` ON `agent_memory` (`kind`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`run_id` text,
	`data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_seq_idx` ON `agent_messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`trigger` text NOT NULL,
	`task` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`usage` text DEFAULT '{}' NOT NULL,
	`cost_usd` real,
	`rounds` integer DEFAULT 0 NOT NULL,
	`applied` text DEFAULT '[]' NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `agent_runs_started_idx` ON `agent_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_conv_idx` ON `agent_runs` (`conversation_id`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `run_id` text;--> statement-breakpoint
CREATE INDEX `audit_run_idx` ON `audit_log` (`run_id`);--> statement-breakpoint
ALTER TABLE `entities` ADD `status` text;--> statement-breakpoint
ALTER TABLE `llm_transmissions` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `llm_transmissions` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `llm_transmissions` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `relations` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `relations` ADD `run_id` text;--> statement-breakpoint
-- Backfill (#270): relations from before the origin column were made by the fixed methods or decided by the user.
UPDATE `relations` SET `origin` = CASE WHEN `resolved_by_user` = 1 THEN 'user' ELSE 'system' END WHERE `origin` IS NULL;
