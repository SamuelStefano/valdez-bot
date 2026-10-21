import { describe, expect, it } from 'vitest';
import { BULK_MAX_AGE_MS, splitByAge } from './clearPlan';

const DAY = 24 * 60 * 60 * 1000;

describe('splitByAge', () => {
  it('sends young messages to bulk and old ones to single delete', () => {
    const now = 100 * DAY;
    const messages = [
      { id: 'a', createdTimestamp: now - DAY },
      { id: 'b', createdTimestamp: now - 20 * DAY },
      { id: 'c', createdTimestamp: now - 365 * DAY },
    ];
    const { recent, old } = splitByAge(messages, now);
    expect(recent.map((m) => m.id)).toEqual(['a']);
    expect(old.map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('treats a message right at the bulk limit as old', () => {
    const now = 100 * DAY;
    const { recent, old } = splitByAge([{ createdTimestamp: now - BULK_MAX_AGE_MS }], now);
    expect(recent).toHaveLength(0);
    expect(old).toHaveLength(1);
  });
});
