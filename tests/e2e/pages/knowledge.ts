import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

type CreatableType = 'topic' | 'project' | 'case' | 'person' | 'note';

export function initKnowledge(page: Page) {
  const locators = {
    buttons: {
      create: page.getByTestId('knowledge-create'),
      save: page.getByTestId('knowledge-new-save'),
      saveEvent: page.getByTestId('event-save'),
    },
    inputs: {
      type: page.getByTestId('knowledge-new-type'),
      name: page.getByTestId('knowledge-new-name'),
      description: page.getByTestId('knowledge-new-description'),
      eventTitle: page.getByTestId('event-title'),
      eventDate: page.getByTestId('event-date'),
    },
    eventForm: page.getByTestId('event-form'),
    items: page.getByTestId('knowledge-item'),
    detail: page.getByTestId('entity-detail'),
    toasts: page.getByTestId('toast'),
  };
  const interactions = {
    create: async (type: CreatableType, name: string, description?: string) => {
      await locators.buttons.create.click();
      await locators.inputs.type.selectOption(type);
      await locators.inputs.name.fill(name);
      if (description) await locators.inputs.description.fill(description);
      await locators.buttons.save.click();
    },
    /** Picks "Ereignis" in the create dialog, which opens the timeline's event dialog. */
    createEvent: async (title: string, isoDate: string) => {
      await locators.buttons.create.click();
      await locators.inputs.name.fill(title);
      await locators.inputs.type.selectOption('event');
      await expect(locators.eventForm).toBeVisible();
      await expect(locators.inputs.eventTitle).toHaveValue(title);
      await locators.inputs.eventDate.fill(isoDate);
      await locators.buttons.saveEvent.click();
    },
  };
  const heading = () => locators.detail.getByRole('heading', { level: 2 });
  return Object.assign(pageObject(locators.items, locators, interactions), { heading });
}
