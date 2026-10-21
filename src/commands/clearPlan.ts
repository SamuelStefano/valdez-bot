// Discord only bulk-deletes messages younger than 14 days; anything older has to
// go one call at a time. A small safety margin keeps a message that crosses the
// limit mid-request out of the bulk call, where it would fail the whole batch.
export const BULK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

export function splitByAge<T extends { createdTimestamp: number }>(
  messages: T[],
  now: number
): { recent: T[]; old: T[] } {
  const recent: T[] = [];
  const old: T[] = [];
  for (const message of messages) {
    (now - message.createdTimestamp < BULK_MAX_AGE_MS ? recent : old).push(message);
  }
  return { recent, old };
}
