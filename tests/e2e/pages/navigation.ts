import type { Page } from '@playwright/test';
import { pageObject } from './page-object';

/** Die Bereiche der Hauptnavigation (data-testid `nav-<name>`). */
export const SECTIONS = ['chat', 'inbox', 'knowledge', 'decisions', 'documents', 'timeline', 'open-items', 'insights', 'scan', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];

export function initNavigation(page: Page) {
  const root = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const locators = {
    link: (section: Section) => root.getByTestId(`nav-${section}`),
  };
  const interactions = {
    open: async (section: Section) => {
      await locators.link(section).click();
    },
  };
  return pageObject(root, locators, interactions);
}
