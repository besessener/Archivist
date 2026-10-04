import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => app.cleanup());

describe('Creating an open item in the form', () => {
  it('keeps an owner and a due date marked as unknown', async () => {
    const item = await app.ok('openItems:create', { title: 'Dachrinne reparieren', responsibleUnknown: true, dueUnknown: true });

    expect(item).toMatchObject({ responsibleUnknown: true, dueUnknown: true });
    expect(app.services.openItems.get(item.id)).toMatchObject({ responsibleUnknown: true, dueUnknown: true });
  });

  it('a given owner and due date win over the unknown marks', async () => {
    const item = await app.ok('openItems:create', {
      title: 'Angebot einholen',
      responsible: 'Anna Berger',
      responsibleUnknown: true,
      dueAt: '2026-11-05',
      dueUnknown: true,
    });

    expect(item).toMatchObject({ responsibleName: 'Anna Berger', responsibleUnknown: false, dueUnknown: false });
  });

  it('without the marks, both stay not unknown', async () => {
    const item = await app.ok('openItems:create', { title: 'Steuererklärung' });

    expect(item).toMatchObject({ responsibleUnknown: false, dueUnknown: false });
  });
});
