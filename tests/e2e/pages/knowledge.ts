import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

type CreatableType = 'topic' | 'project' | 'case' | 'person' | 'note';

export function initKnowledge(page: Page) {
  const locators = {
    buttons: {
      create: page.getByTestId('knowledge-create'),
      save: page.getByTestId('knowledge-new-save'),
      saveEvent: page.getByTestId('event-save'),
      deleteNote: page.getByTestId('note-delete'),
      confirmDelete: page.getByTestId('confirm-dialog-confirm'),
      merge: page.getByTestId('knowledge-merge'),
      proposeMerge: page.getByTestId('merge-propose'),
    },
    inputs: {
      type: page.getByTestId('knowledge-new-type'),
      name: page.getByTestId('knowledge-new-name'),
      description: page.getByTestId('knowledge-new-description'),
      eventTitle: page.getByTestId('event-title'),
      eventDate: page.getByTestId('event-date'),
      mergeTarget: page.getByTestId('merge-target'),
    },
    mergeAction: page.getByTestId('merge-action'),
    eventForm: page.getByTestId('event-form'),
    items: page.getByTestId('knowledge-item'),
    detail: page.getByTestId('entity-detail'),
    toasts: page.getByTestId('toast'),
  };
  const interactions = {
    create: async (entry: { type: CreatableType; name: string; description?: string }) => {
      await locators.buttons.create.click();
      await locators.inputs.type.selectOption(entry.type);
      await locators.inputs.name.fill(entry.name);
      if (entry.description) await locators.inputs.description.fill(entry.description);
      await locators.buttons.save.click();
    },
    /** Opens the merge dialog of the shown entry and proposes merging it into the entry with this name. */
    proposeMerge: async (targetName: string) => {
      await locators.buttons.merge.click();
      await locators.inputs.mergeTarget.selectOption({ label: targetName });
      await locators.buttons.proposeMerge.click();
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
  return Object.assign(pageObject({ root: locators.items, locators, actions: interactions }), { heading });
}
