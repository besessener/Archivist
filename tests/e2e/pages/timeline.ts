import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initTimeline(page: Page) {
  const locators = {
    buttons: {
      addEvent: page.getByTestId('event-add'),
      saveEvent: page.getByTestId('event-save'),
    },
    form: page.getByTestId('event-form'),
    inputs: {
      eventTitle: page.getByTestId('event-title'),
      eventDate: page.getByTestId('event-date'),
      eventDescription: page.getByTestId('event-description'),
      eventTopic: page.getByTestId('event-topic'),
      eventProject: page.getByTestId('event-project'),
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
    /** Opens the edit dialog of the event entry containing `title`, fills the given fields and saves. */
    editEvent: async (title: string, values: { title?: string; date?: string; description?: string; topic?: string; project?: string }) => {
      await entry(title).getByTestId('event-edit').click();
      await expect(locators.form).toBeVisible();
      if (values.title !== undefined) await locators.inputs.eventTitle.fill(values.title);
      if (values.date !== undefined) await locators.inputs.eventDate.fill(values.date);
      if (values.description !== undefined) await locators.inputs.eventDescription.fill(values.description);
      if (values.topic !== undefined) await locators.inputs.eventTopic.fill(values.topic);
      if (values.project !== undefined) await locators.inputs.eventProject.fill(values.project);
      await locators.buttons.saveEvent.click();
      await expect(locators.form).toBeHidden();
    },
  };
  return Object.assign(pageObject(locators.entries, locators, interactions), { entry });
}
