CREATE TABLE `contradiction_reviews` (
	`text_hash` text PRIMARY KEY NOT NULL,
	`is_contradiction` integer NOT NULL,
	`reviewed_at` text NOT NULL
);
