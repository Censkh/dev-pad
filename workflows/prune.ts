// Keeps the runner's state from growing without bound, as GitHub keeps logs and artifacts for a
// while and gives every job a fresh machine. Runs of the same workflow and branch can go at once,
// so a live run and a workspace another run holds (its lease, workspaces.ts) are never removed.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { alive, tryLease } from "./leases";
import type { RunStatus } from "./status";
import { isExtraPoolMember, workspaceLeasePath } from "./workspaces";

export type PruneOptions = {
  // <state>/<repository>/<workflow>/<branch>: runs/ and workspaces/.
  stateDir: string;
  // Runs kept, newest first; older ones go with their logs and artifacts.
  keepRuns: number;
  // Of those, the runs that keep their artifacts.
  keepArtifacts: number;
  // Workspaces (and sibling branches' whole state) unused for longer go.
  maxIdleDays: number;
  // The extra workspaces runs going at once needed (workspaces.ts: <key>.2 and on) go sooner.
  maxIdleExtraDays?: number;
  // Runs never removed (the one pruning).
  keep?: string[];
  now?: number;
};

const DAY = 24 * 60 * 60 * 1000;

function directories(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

// A run whose status says it is queued or running and whose process is alive.
function live(runDir: string) {
  try {
    const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
    return (status.state === "queued" || status.state === "running") && alive(status.pid);
  } catch {
    return false;
  }
}

export function pruneState(options: PruneOptions) {
  const now = options.now ?? Date.now();
  const removed = {
    runs: [] as string[],
    artifacts: [] as string[],
    workspaces: [] as string[],
    branches: [] as string[],
  };
  const keep = new Set(options.keep ?? []);

  // Runs are named by their start time, so newest first is reverse order.
  const runsDir = join(options.stateDir, "runs");
  const runs = directories(runsDir).sort().reverse();
  runs.forEach((name, index) => {
    const dir = join(runsDir, name);
    if (keep.has(name) || live(dir)) return;
    // A finished run's job temporary directories are never needed again.
    rmSync(join(dir, "tmp"), { recursive: true, force: true });
    if (index >= options.keepRuns) {
      rmSync(dir, { recursive: true, force: true });
      removed.runs.push(name);
    } else if (index >= options.keepArtifacts && existsSync(join(dir, "artifacts"))) {
      rmSync(join(dir, "artifacts"), { recursive: true, force: true });
      removed.artifacts.push(name);
    }
  });

  // A workspace's modification time is its last use (the runner touches it when a job starts).
  const workspacesDir = join(options.stateDir, "workspaces");
  for (const name of directories(workspacesDir)) {
    const dir = join(workspacesDir, name);
    const maxIdle = isExtraPoolMember(name) ? (options.maxIdleExtraDays ?? options.maxIdleDays) : options.maxIdleDays;
    if (now - mtime(dir) <= maxIdle * DAY) continue;
    // Held while it goes, so no run starts using it meanwhile.
    const lease = tryLease(workspaceLeasePath(dir), "prune");
    if (!lease) continue;
    rmSync(dir, { recursive: true, force: true });
    lease.release();
    removed.workspaces.push(name);
  }

  // Other branches' state for the same workflow, once idle that long and with no live run.
  const workflowDir = join(options.stateDir, "..");
  const branch = options.stateDir.split("/").pop();
  for (const name of directories(workflowDir)) {
    if (name === branch) continue;
    const dir = join(workflowDir, name);
    const lastRun = directories(join(dir, "runs"))
      .map((run) => mtime(join(dir, "runs", run)))
      .reduce((latest, time) => Math.max(latest, time), mtime(dir));
    const running = directories(join(dir, "runs")).some((run) => live(join(dir, "runs", run)));
    if (!running && now - lastRun > options.maxIdleDays * DAY) {
      rmSync(dir, { recursive: true, force: true });
      removed.branches.push(name);
    }
  }
  return removed;
}

// Cache entries (the SDK builds) unused for longer than maxIdleDays.
export function pruneCacheEntries(directory: string, maxIdleDays: number, now = Date.now()) {
  const removed: string[] = [];
  for (const name of directories(directory)) {
    const dir = join(directory, name);
    if (now - mtime(dir) > maxIdleDays * DAY) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
