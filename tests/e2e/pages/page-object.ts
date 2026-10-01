import type { Locator } from '@playwright/test';

/** Ein Page Object: aufrufbar liefert es sein Wurzel-Element, dazu `locators` (Elemente) und `do` (Handlungen). */
export type PageObject<TLocators, TActions> = (() => Locator) & { locators: TLocators; do: TActions };

export function pageObject<TLocators, TActions>(root: Locator, locators: TLocators, actions: TActions): PageObject<TLocators, TActions> {
  return Object.assign(() => root, { locators, do: actions });
}
