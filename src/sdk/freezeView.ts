// Pure helpers for the Logs view's Freeze (pause) control.
//
// The live tail keeps arriving from `useLogStream` while frozen; the view
// snapshots the `lines` array at the moment of freezing and renders that
// snapshot so the operator can read fast-scrolling logs. These helpers are
// kept side-effect-free (no DOM / React) so they can be unit-tested in
// isolation — the view just wires state to them.

/**
 * Which lines the Logs view should render right now.
 *
 * When `snapshot` is non-null (frozen) the snapshot is shown verbatim, even as
 * the live array keeps growing in the background. When it's null (live) the
 * live array passes through unchanged. The same reference is returned in the
 * live case so callers' memoisation stays stable.
 */
export function freezeView<T>(live: readonly T[], snapshot: readonly T[] | null): readonly T[] {
  return snapshot ?? live;
}

/**
 * How many live lines have arrived since the snapshot was taken.
 *
 * `useLogStream` keeps a fixed-size FIFO buffer (older lines are evicted from
 * the front as new ones are pushed to the back), so a plain length difference
 * undercounts once the buffer is full. We instead find where the snapshot's
 * tail sits inside the live array and count everything after it.
 *
 *   - Not frozen (`snapshot` null) → 0.
 *   - Empty snapshot → every live line is new.
 *   - Snapshot tail still present in `live` → lines after that position.
 *   - Snapshot tail already evicted (very high churn) → at least the whole
 *     live buffer is new; clamp to that lower bound so the count never lies low.
 *
 * `eq` defaults to identity (`===`), which is correct for the immutable
 * `LogEntry` objects the stream produces — a frozen snapshot shares the exact
 * object references the live array held at freeze time.
 */
export function newSinceFreeze<T>(
  live: readonly T[],
  snapshot: readonly T[] | null,
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
): number {
  if (snapshot === null) return 0;
  if (snapshot.length === 0) return live.length;

  const tail = snapshot[snapshot.length - 1] as T;
  // Search from the end of `live` — the snapshot's tail is the most recent
  // shared line, so it lives near the back.
  for (let i = live.length - 1; i >= 0; i -= 1) {
    if (eq(live[i] as T, tail)) {
      return live.length - 1 - i;
    }
  }

  // The snapshot's tail has been evicted from the live FIFO: every line
  // currently in `live` arrived after it. That's a lower bound (more lines
  // were evicted too), but it's the honest minimum we can prove.
  return live.length;
}
