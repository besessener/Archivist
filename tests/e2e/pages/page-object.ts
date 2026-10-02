import type { Locator } from '@playwright/test';

/** A page object: calling it returns its root element; it also has `locators` (elements) and `do` (actions). */
export type PageObject<TLocators, TActions> = (() => Locator) & { locators: TLocators; do: TActions };

export function pageObject<TLocators, TActions>(root: Locator, locators: TLocators, actions: TActions): PageObject<TLocators, TActions> {
  return Object.assign(() => root, { locators, do: actions });
}
