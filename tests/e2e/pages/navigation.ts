import type { Page } from '@playwright/test';
import { pageObject } from './page-object';

/** The sections of the main navigation (data-testid `nav-<name>`). */
export const SECTIONS = ['chat', 'inbox', 'knowledge', 'decisions', 'documents', 'timeline', 'open-items', 'insights', 'scan', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];

export function initNavigation(page: Page) {
  const root = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const locators = {
    link: (section: Section) => root.getByTestId(`nav-${section}`),
    /** The count badge of a section (only shown while the count is above zero). */
    count: (section: Section) => root.getByTestId(`nav-${section}-count`),
    /** The grey second badge of Insights: open link proposals, counted apart from the findings. */
    insightLinksCount: root.getByTestId('nav-insights-links-count'),
    /** The icon tile in the current page's header; `data-tone` names its colour. */
    pageTile: page.getByTestId('page-header-tile'),
    /** The connection indicator in the header; its accessible name carries the state. */
    llmStatus: page.getByTestId('llm-status'),
    /** The popover the connection indicator opens. */
    llmDetails: page.getByRole('dialog').filter({ hasText: 'Verbindung zur KI' }),
  };
  const interactions = {
    open: async (section: Section) => {
      await locators.link(section).click();
    },
  };
  return pageObject({ root, locators, actions: interactions });
}
