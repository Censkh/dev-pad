// Which waiting job combinations take the free slots. A combination goes first when the work it
// holds up is longest: its own expected duration, the rest of its exclusive group still waiting
// (which can only run after it, one at a time), and the longest chain of jobs that wait for its job.
// Ordering by a combination's own duration alone starts a short job late even when a long chain
// waits on it, such as a build that a group of exclusive test shards needs.

export type Waiter = {
  // Expected seconds for this combination (Infinity when never timed, so it starts first).
  seconds: number;
  // Expected seconds of the longest chain of jobs that wait for this combination's job.
  chain: number;
  // Indexes of the exclusive groups it belongs to.
  groups: number[];
};

export function priority(waiter: Waiter, waiters: readonly Waiter[]): number {
  let serial = 0;
  for (const other of waiters)
    if (other !== waiter && other.groups.some((group) => waiter.groups.includes(group))) serial += other.seconds;
  return waiter.seconds + serial + waiter.chain;
}

// The waiters in the order they should start, highest priority first (ties keep arrival order).
export function startOrder<W extends Waiter>(waiters: readonly W[]): W[] {
  const priorities = new Map(waiters.map((waiter) => [waiter, priority(waiter, waiters)]));
  return [...waiters].sort((a, b) => {
    const pa = priorities.get(a)!;
    const pb = priorities.get(b)!;
    return pa === pb ? 0 : pb > pa ? 1 : -1;
  });
}

// Expected seconds from a job's end until every job that waits for it, directly or through others,
// can have finished: the longest path through its dependents. `dependencies` maps each job to the
// jobs it waits for; `jobSeconds` is a job's expected duration (0 for one that won't run or was
// never timed, so an unknown dependent doesn't make every ancestor look endless).
export function chainSeconds(
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  jobSeconds: (id: string) => number,
): (id: string) => number {
  const dependents = new Map<string, string[]>();
  for (const [id, waitsFor] of dependencies)
    for (const dependency of waitsFor) dependents.set(dependency, [...(dependents.get(dependency) ?? []), id]);
  const memo = new Map<string, number>();
  const chain = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    let longest = 0;
    for (const dependent of dependents.get(id) ?? [])
      longest = Math.max(longest, jobSeconds(dependent) + chain(dependent));
    memo.set(id, longest);
    return longest;
  };
  return chain;
}

// A combination that has reliably taken only seconds, such as one that checks out the commit and
// compares it with a base, needs no job slot: it adds no real load, and waiting for a slot behind
// hours of tests would hold up everything that waits for it. Reliably: timed in at least three of
// the latest runs, and never longer than ten seconds.
export const quickSeconds = 10;
export function isQuick(previousSeconds: readonly number[]): boolean {
  return previousSeconds.length >= 3 && previousSeconds.every((seconds) => seconds <= quickSeconds);
}

// A job's expected duration from its combinations' previous durations: they run side by side
// (the longest), or one at a time in an exclusive group (their sum).
export function jobDuration(combinationSeconds: readonly number[], exclusive: boolean): number {
  if (!combinationSeconds.length) return 0;
  return exclusive ? combinationSeconds.reduce((sum, seconds) => sum + seconds, 0) : Math.max(...combinationSeconds);
}
