/**
 * Glue between the IndexedDB session store and the card UI.
 *
 * `reloadFromStore` rebuilds the panel from persisted sessions (called
 * once at page load). `beginActive` prepends a live card and returns
 * callbacks the sampling loop uses to append samples and finalize on
 * Stop — keeping the active card in DOM-position even if other cards
 * are loaded later.
 */

import { buildCard, paintChart, renderSessionCard } from './session-ui';
import type { SampleRecord, SessionRecord, SessionStore } from './session-store';

export interface ActiveCardHandle {
  append(sample: SampleRecord): void;
  end(endedAt: number): void;
}

export class SessionPanel {
  private container: HTMLElement;
  private store: SessionStore;

  constructor(container: HTMLElement, store: SessionStore) {
    this.container = container;
    this.store = store;
  }

  async reloadFromStore(): Promise<void> {
    this.container.replaceChildren();
    const sessions = await this.store.listSessions();
    for (const meta of sessions) {
      const samples = await this.store.getSamples(meta.startedAt);
      const card = renderSessionCard(meta, samples);
      this.container.appendChild(card);
    }
  }

  /**
   * Prepend a live card for an active session. Returns callbacks the
   * caller uses to feed new samples and to end the session.
   */
  beginActive(meta: SessionRecord): ActiveCardHandle {
    const card = buildCard(meta);
    card.classList.add('active');
    this.container.prepend(card);
    const samples: SampleRecord[] = [];
    let endedAt: number | undefined;
    // Initial paint shows the "starting…" empty state.
    paintChart(card, samples, endedAt);
    return {
      append: (s) => {
        samples.push(s);
        paintChart(card, samples, endedAt);
      },
      end: (ts) => {
        endedAt = ts;
        card.classList.remove('active');
        paintChart(card, samples, endedAt);
      },
    };
  }
}
