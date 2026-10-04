CREATE TABLE `document_lsh_bands` (
	`document_id` text NOT NULL,
	`band` integer NOT NULL,
	`bucket` integer NOT NULL,
	PRIMARY KEY(`document_id`, `band`)
);
--> statement-breakpoint
CREATE INDEX `document_lsh_bucket_idx` ON `document_lsh_bands` (`band`,`bucket`);--> statement-breakpoint
CREATE TABLE `document_minhash` (
	`document_id` text PRIMARY KEY NOT NULL,
	`signature` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_reanalysis` (
	`document_id` text PRIMARY KEY NOT NULL,
	`proposal` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `llm_transmissions` ADD `personal_redactions` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_transmissions` ADD `requests` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_transmissions` ADD `note` text;--> statement-breakpoint
CREATE INDEX `llm_transmissions_at_idx` ON `llm_transmissions` (`at`);