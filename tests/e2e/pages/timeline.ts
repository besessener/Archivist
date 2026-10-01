import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initTimeline(page: Page) {
  const locators = {
    buttons: {
      addEvent: page.getByTestId('event-add'),
      saveEvent: page.getByTestId('event-save'),
    },
    inputs: {
      eventTitle: page.getByTestId('event-title'),
      eventDate: page.getByTestId('event-date'),
    },
    entries: page.getByTestId('timeline-entry'),
  };
  const entry = (title: string) => locators.entries.filter({ hasText: title });
  const interactions = {
    addEvent: async (title: string, isoDate: string) => {
      await locators.buttons.addEvent.click();
      await locators.inputs.eventTitle.fill(title);
      await locators.inputs.eventDate.fill(isoDate);
      await locators.buttons.saveEvent.click();
      await expect(entry(title)).toBeVisible();
    },
  };
  return Object.assign(pageObject(locators.entries, locators, interactions), { entry });
}
