import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initTimeline(page: Page) {
  const locators = {
    buttons: {
      addEvent: page.getByTestId('event-add'),
      saveEvent: page.getByTestId('event-save'),
      loadOlder: page.getByTestId('timeline-load-older'),
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
    /** Creates many dated events directly through the IPC bridge (much faster than the dialog). */
    seedEvents: async (events: Array<{ title: string; occurredAt: string }>) => {
      await page.evaluate(async (list) => {
        const bridge = (window as unknown as { archivist: { invoke: (channel: string, input: unknown) => Promise<{ ok: boolean }> } }).archivist;
        for (const e of list) {
          const r = await bridge.invoke('events:create', e);
          if (!r.ok) throw new Error(`events:create failed for ${e.title}`);
        }
      }, events);
    },
    loadOlder: async () => {
      await locators.buttons.loadOlder.click();
    },
  };
  return Object.assign(pageObject(locators.entries, locators, interactions), { entry });
}
