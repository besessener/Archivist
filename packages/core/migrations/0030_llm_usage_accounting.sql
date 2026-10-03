ALTER TABLE `llm_transmissions` ADD `requests` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_transmissions` ADD `note` text;--> statement-breakpoint
CREATE INDEX `llm_transmissions_at_idx` ON `llm_transmissions` (`at`);