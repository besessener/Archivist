import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';
import { seedTags } from './helpers';

/** Two tags that mean the same, as documents produce them. */
const withTags = test.extend({
  workspace: async ({ workspace }, provide) => {
    seedTags(workspace.dataDir, ['Steuer', 'Steuern']);
    await provide(workspace);
  },
});

test.describe('knowledge: create new', () => {
  test('creates real entries and opens an existing one instead of claiming it was created', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;

    await k.do.create({ type: 'topic', name: 'Hauskauf' });
    await expect(k.locators.toasts.filter({ hasText: 'Thema angelegt.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Hauskauf');

    await k.do.create({ type: 'topic', name: 'hauskauf' });
    await expect(k.locators.toasts.filter({ hasText: 'Thema „Hauskauf“ existiert bereits.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Hauskauf');
    await expect(k().filter({ hasText: /hauskauf/i })).toHaveCount(1);

    await k.do.create({ type: 'note', name: 'Einkaufsliste', description: 'Milch und Brot' });
    await expect(k.locators.toasts.filter({ hasText: 'Notiz angelegt.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Einkaufsliste');

    await k.do.createEvent('Beitrag beim German Testing Day eingereicht', '2026-10-01');
    await expect(k.locators.toasts.filter({ hasText: 'Ereignis angelegt.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Beitrag beim German Testing Day eingereicht');

    await app.navigation.do.open('timeline');
    await expect(app.timeline.entry('German Testing Day')).toHaveAttribute('data-kind', 'event');
  });

  test('deletes a note after confirmation and removes it from the list (#248)', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({ type: 'note', name: 'Mietvertrag Hauptstraße', description: 'Mietvertrag Hauptstraße' });
    await expect(k.heading()).toHaveText('Mietvertrag Hauptstraße');

    await k.locators.buttons.deleteEntry.click();
    await k.locators.buttons.confirmDelete.click();

    await expect(k.locators.toasts.filter({ hasText: 'Notiz gelöscht.' })).toBeVisible();
    await expect(k().filter({ hasText: 'Mietvertrag Hauptstraße' })).toHaveCount(0);
  });

  test('deletes a person after confirmation and removes it from the list', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({ type: 'person', name: 'Frieda Fehler' });
    await expect(k.heading()).toHaveText('Frieda Fehler');

    await k.locators.buttons.deleteEntry.click();
    await expect(k.locators.confirmDialog).toContainText('Es hängt nichts daran.');
    await k.locators.buttons.confirmDelete.click();

    await expect(k.locators.toasts.filter({ hasText: 'Person gelöscht.' })).toBeVisible();
    await expect(k().filter({ hasText: 'Frieda Fehler' })).toHaveCount(0);
  });

  test('proposes merging persons and projects, not only topics (#188)', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    for (const [type, source, target] of [
      ['person', 'Anna Albers', 'Anne Albers'],
      ['project', 'Umzug', 'Umzug 2026'],
    ] as const) {
      await k.do.create({ type, name: source });
      await k.do.create({ type, name: target });
      await k.locators.items.filter({ hasText: source }).first().click();
      await expect(k.heading()).toHaveText(source);
      await expect(k.locators.buttons.merge).toBeVisible();
      if (type === 'person') await expectNoSeriousA11yViolations(page, testInfo);
      await k.do.proposeMerge(target);
      await expect(k.locators.mergeAction).toContainText(`„${source}“ in „${target}“ zusammenführen`);
    }
  });

  withTags('merges two tags after the confirmation of the proposal', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.locators.items.filter({ hasText: 'Steuern' }).click();
    await expect(k.heading()).toHaveText('Steuern');

    await k.locators.buttons.merge.click();
    await expect(k.locators.inputs.mergeTarget).toContainText('Steuer');
    await expectNoSeriousA11yViolations(page, testInfo);
    await k.locators.inputs.mergeTarget.selectOption({ label: 'Steuer' });
    await k.locators.buttons.proposeMerge.click();
    await expect(k.locators.mergeAction).toContainText('„Steuern“ in „Steuer“ zusammenführen');
    await k.locators.approveMerge.click();

    await expect(k.locators.items.filter({ hasText: 'Steuern' })).toHaveCount(0);
    await expect(k.locators.items.filter({ hasText: 'Steuer' })).toHaveCount(1);
  });

  test('shows the own person with the badge „Du“ (name from the setup)', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.locators.inputs.profileName.fill('Monika Lor-Zade');
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;

    const me = k.locators.items.filter({ hasText: 'Monika Lor-Zade' });
    await expect(me.getByTestId('knowledge-item-self')).toHaveText('Du');
    await me.click();
    await expect(k.heading()).toHaveText('Monika Lor-Zade');
    await expect(k.locators.detail.getByTestId('entity-self')).toHaveText('Du');
  });

  test('proposes similar entries on its own; „Bestätigen“ under related entries confirms the link (#271, #276, #280)', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create({
      type: 'note',
      name: 'Heizung Wartung',
      description: 'Die Heizung im Keller wurde von der Firma Kalt gewartet, der Brenner der Heizung wurde gereinigt.',
    });
    await k.do.create({ type: 'note', name: 'Heizung Brenner', description: 'Die Firma Kalt hat am Brenner der Heizung im Keller einen Defekt gefunden.' });
    await expect(k.heading()).toHaveText('Heizung Brenner');

    // proposed in the background, with who stands behind it and why
    const related = page.getByTestId('related-entry').filter({ hasText: 'Heizung Wartung' });
    await expect(related).toBeVisible();
    await expect(related.getByTestId('related-reason')).toContainText('ähnlicher Inhalt');
    await expectNoSeriousA11yViolations(page, testInfo);
    await related.getByTestId('related-confirm').click();
    await expect(k.locators.toasts.filter({ hasText: 'Bestätigt.' })).toBeVisible();
    await expect(related.getByTestId('related-reason')).toContainText('von dir bestätigt');
    await expect(related.getByTestId('related-confirm')).toHaveCount(0);
  });
});
