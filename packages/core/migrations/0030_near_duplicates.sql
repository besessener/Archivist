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
