/**
 * Reads of one thing where only the one asked for last may apply (a creation dialog's agent list: the
 * read as it opens, and the one after Add another agent… installed one). Each read takes a ticket;
 * the ticket says whether no later read was asked for since.
 */
export function latestRead(): () => () => boolean {
  let last = 0;
  return () => {
    const mine = ++last;
    return () => last === mine;
  };
}
