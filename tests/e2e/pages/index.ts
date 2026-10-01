import type { Page } from '@playwright/test';
import { initChat } from './chat';
import { initInbox } from './inbox';
import { initKnowledge } from './knowledge';
import { initNavigation } from './navigation';
import { initScan } from './scan';
import { initSetupWizard } from './setup';
import { initTimeline } from './timeline';

/** Getter, damit ein Spec nur die Locators der Seiten aufbaut, die er braucht. */
export type PageTree = ReturnType<typeof createPageTree>;

export function createPageTree(page: Page) {
  return {
    get chat() {
      return initChat(page);
    },
    get inbox() {
      return initInbox(page);
    },
    get knowledge() {
      return initKnowledge(page);
    },
    get navigation() {
      return initNavigation(page);
    },
    get scan() {
      return initScan(page);
    },
    get setup() {
      return initSetupWizard(page);
    },
    get timeline() {
      return initTimeline(page);
    },
  };
}
