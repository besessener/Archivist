import { expect, test } from './fixture';
import type { PageTree } from './pages';

/** Erfasst die Entscheidung „Nordlicht pausieren“ samt Rückfrage nach Datum und Beteiligten. */
async function recordDecision(app: PageTree) {
  await app.chat.do.send('Wir haben entschieden, dass wir das Projekt Nordlicht pausieren.');
  await expect(app.chat.do.lastReply()).toContainText('Wann wurde das entschieden?');
  await app.chat.do.send('Am 4. Mai 2026 mit Anna und Ben.');
  await expect(app.chat.do.lastReply()).toContainText('Die Entscheidung ist gespeichert');
}

test.describe('Entscheidungen im Chat', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('fragt nach Datum und Beteiligten, wenn die Nachricht sie nicht nennt', async ({ on, page }) => {
    const app = on(page);

    await app.chat.do.send('Wir haben entschieden, dass wir das Projekt Nordlicht pausieren.');

    await expect(app.chat.do.lastReply()).toContainText('Wann wurde das entschieden?');
    await expect(app.chat.do.lastReply()).toContainText('Wer war an der Entscheidung beteiligt?');
  });

  test('speichert die Entscheidung nach der Antwort auf die Rückfrage', async ({ on, page }) => {
    await recordDecision(on(page));
  });

  test('findet eine gespeicherte Entscheidung im Chat wieder, mit Quellen', async ({ on, page }) => {
    const app = on(page);
    await recordDecision(app);

    await app.chat.do.send('Wann haben wir Nordlicht pausiert?');

    await expect(app.chat.do.lastReply()).toContainText('4. Mai 2026');
    await expect(app.chat.locators.sources.first()).toBeVisible();
  });
});
