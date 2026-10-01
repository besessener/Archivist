CREATE TABLE `agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`action_type` text NOT NULL,
	`label` text NOT NULL,
	`rationale` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`affected_entities` text DEFAULT '[]' NOT NULL,
	`required_confirmation` text DEFAULT 'confirm' NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`result` text,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`trigger` text NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`entity_ids` text DEFAULT '[]' NOT NULL,
	`paths` text DEFAULT '[]' NOT NULL,
	`before` text,
	`after` text,
	`success` integer DEFAULT true NOT NULL,
	`error` text,
	`undo_type` text,
	`undo_data` text,
	`undone_at` text
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`approved` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_path_unique` ON `categories` (`path`);--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`idx` integer NOT NULL,
	`text` text NOT NULL,
	`embedding` blob,
	`embedding_model` text
);
--> statement-breakpoint
CREATE INDEX `chunks_entity_idx` ON `chunks` (`entity_id`);--> statement-breakpoint
CREATE TABLE `contradictions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`affected_entity_ids` text DEFAULT '[]' NOT NULL,
	`excerpts` text DEFAULT '[]' NOT NULL,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`timestamps` text DEFAULT '[]' NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`status` text DEFAULT 'detected' NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contradictions_dedupe_idx` ON `contradictions` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`pending` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`decision_text` text NOT NULL,
	`decided_at` text,
	`topic_id` text,
	`project_id` text,
	`participants` text DEFAULT '[]' NOT NULL,
	`rationale` text,
	`consequences` text,
	`alternatives` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`valid_from` text,
	`valid_until` text,
	`supersedes_decision_id` text,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`missing_fields` text DEFAULT '[]' NOT NULL,
	`unknown_fields` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_topic_idx` ON `decisions` (`topic_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`original_name` text NOT NULL,
	`ext` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`source_path` text,
	`staged_path` text,
	`archive_rel_path` text,
	`status` text DEFAULT 'staged' NOT NULL,
	`processing_status` text DEFAULT 'pending' NOT NULL,
	`processing_error` text,
	`doc_type` text,
	`summary` text,
	`category_path` text,
	`topic_id` text,
	`project_id` text,
	`persons` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`dates` text DEFAULT '[]' NOT NULL,
	`confidence` real,
	`llm_status` text DEFAULT 'pending' NOT NULL,
	`proposal` text,
	`archive_mode` text,
	`extracted_text` text DEFAULT '' NOT NULL,
	`technical_meta` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `documents_sha_idx` ON `documents` (`sha256`);--> statement-breakpoint
CREATE INDEX `documents_status_idx` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `documents_topic_idx` ON `documents` (`topic_id`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entities_type_name_idx` ON `entities` (`type`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`affected` text DEFAULT '[]' NOT NULL,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`recommended_action_id` text,
	`recommended_action_label` text,
	`status` text DEFAULT 'open' NOT NULL,
	`snoozed_until` text,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insights_dedupe_idx` ON `insights` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress` real,
	`progress_message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`error` text,
	`result` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `llm_transmissions` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`endpoint` text NOT NULL,
	`bytes` integer NOT NULL,
	`redactions` integer DEFAULT 0 NOT NULL,
	`document_ids` text DEFAULT '[]' NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`success` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`context` text,
	`action_ids` text DEFAULT '[]' NOT NULL,
	`confidence` real,
	`uncertainties` text DEFAULT '[]' NOT NULL,
	`intent` text,
	`error_message` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conv_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`affected_entity_ids` text DEFAULT '[]' NOT NULL,
	`proposed_actions` text DEFAULT '[]' NOT NULL,
	`dedupe_key` text,
	`created_at` text NOT NULL,
	`read_at` text,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_idx` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `open_items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`topic_id` text,
	`project_id` text,
	`responsible_person_id` text,
	`responsible_unknown` integer DEFAULT false NOT NULL,
	`due_at` text,
	`due_unknown` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`reminder_at` text,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `open_items_status_idx` ON `open_items` (`status`);--> statement-breakpoint
CREATE TABLE `relations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_entity_id` text NOT NULL,
	`target_entity_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relations_unique_idx` ON `relations` (`source_entity_id`,`target_entity_id`,`relation_type`);--> statement-breakpoint
CREATE INDEX `relations_target_idx` ON `relations` (`target_entity_id`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`title` text NOT NULL,
	`remind_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`status`,`remind_at`);--> statement-breakpoint
CREATE TABLE `scan_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_exclusions_idx` ON `scan_exclusions` (`kind`,`path`);--> statement-breakpoint
CREATE TABLE `scan_files` (
	`id` text PRIMARY KEY NOT NULL,
	`root_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`ext` text NOT NULL,
	`size` integer NOT NULL,
	`mtime_ms` real NOT NULL,
	`sha256` text,
	`mime` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`llm_status` text DEFAULT 'local_only' NOT NULL,
	`document_id` text,
	`duplicate_of_document_id` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_files_path_idx` ON `scan_files` (`root_id`,`path`);--> statement-breakpoint
CREATE INDEX `scan_files_status_idx` ON `scan_files` (`status`);--> statement-breakpoint
CREATE TABLE `scan_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`recursive` integer DEFAULT true NOT NULL,
	`excluded_subdirs` text DEFAULT '[]' NOT NULL,
	`extensions` text DEFAULT '[]' NOT NULL,
	`max_file_size_mb` real DEFAULT 50 NOT NULL,
	`llm_allowed` integer DEFAULT true NOT NULL,
	`last_scan_at` text,
	`last_summary` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_roots_path_unique` ON `scan_roots` (`path`);