import { expect, test } from './fixture';
import type { PageTree } from './pages';

/** Records the decision „Nordlicht pausieren“ including the follow-up question about date and participants. */
async function recordDecision(app: PageTree) {
  await app.chat.do.send('Wir haben entschieden, dass wir das Projekt Nordlicht pausieren.');
  await expect(app.chat.do.lastReply()).toContainText('Wann wurde das entschieden?');
  await app.chat.do.send('Am 4. Mai 2026.');
  await expect(app.chat.do.lastReply()).toContainText('Die Entscheidung ist gespeichert');
}

test.describe('decisions in the chat', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('asks for the date, but not for participants, if the message does not mention them (#198)', async ({ on, page }) => {
    const app = on(page);

    await app.chat.do.send('Wir haben entschieden, dass wir das Projekt Nordlicht pausieren.');

    await expect(app.chat.do.lastReply()).toContainText('Wann wurde das entschieden?');
    await expect(app.chat.do.lastReply()).not.toContainText('Wer war an der Entscheidung beteiligt?');
  });

  test('saves the decision after the answer to the follow-up question', async ({ on, page }) => {
    await recordDecision(on(page));
  });

  test('finds a saved decision again in the chat, with sources', async ({ on, page }) => {
    const app = on(page);
    await recordDecision(app);

    await app.chat.do.send('Wann haben wir Nordlicht pausiert?');

    await expect(app.chat.do.lastReply()).toContainText('4. Mai 2026');
    await expect(app.chat.locators.sources.first()).toBeVisible();
  });
});
