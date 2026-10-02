ALTER TABLE `insights` ADD `choices` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `insights` ADD `chosen_choice_id` text;