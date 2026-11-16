// Run ages and job durations as the workflow view shows them.

/** A span in its two largest units: `45s`, `3m 07s`, `2h 05m`, `3d 4h`. */
export function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How long ago something started, in its largest unit: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAgo(startedAt: number, now = Date.now()) {
  const seconds = Math.floor((now - startedAt) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A run's start in local time, with the date when it wasn't today, and how long ago that was: `14:02 · 5m ago`. */
export function runStarted(startedAt: number, now = Date.now()) {
  if (!startedAt) return "";
  const start = new Date(startedAt);
  const time = start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const today = start.toDateString() === new Date(now).toDateString();
  const date = today ? "" : `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} `;
  return `${date}${time} · ${formatAgo(startedAt, now)}`;
}

type Timed = { startedAt?: string; finishedAt?: string };

/**
 * When a job's combinations started and, once none is still going, finished: from its first
 * combination's start to its last one's end. A job none of whose combinations started has neither.
 */
export function jobSpan(combinations: readonly Timed[], finished: boolean): Timed {
  const starts = combinations.flatMap(({ startedAt }) => (startedAt ? [startedAt] : [])).sort();
  if (!starts.length) return {};
  const ends = combinations.flatMap(({ finishedAt }) => (finishedAt ? [finishedAt] : [])).sort();
  const done = finished && combinations.every(({ startedAt, finishedAt }) => !startedAt || finishedAt);
  return { startedAt: starts[0], finishedAt: done ? ends.at(-1) : undefined };
}

/** How long a job took, or has been running so far; nothing for a job that hasn't started. */
export function jobDuration(job: Timed, now = Date.now()) {
  const start = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return undefined;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return formatDuration(end - start);
}
