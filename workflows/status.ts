// The live state of a run, written by run.ts to runs/<run>/status.json as it changes and read
// by the web GUI (gui.ts), and the rule for when a new run supersedes an older one.

export type StepState = "running" | "success" | "failure" | "skipped";
// A queued job is ready to run and waits for a job slot (this run's, or the machine's when other
// runs hold them all).
export type JobState = "pending" | "queued" | "running" | "success" | "failure" | "skipped" | "cancelled";
export type RunState = "queued" | "running" | "passed" | "failed" | "cancelled";

export type StepStatus = {
  name: string;
  state: StepState;
  startedAt?: string;
  finishedAt?: string;
};

export type CombinationStatus = {
  key: string;
  name: string;
  matrix: Record<string, unknown>;
  // 1-based place in the job's whole matrix, and its size.
  index: number;
  total: number;
  state: JobState;
  startedAt?: string;
  finishedAt?: string;
  // The job's log file, in the run directory.
  log: string;
  failedStep?: string;
  steps: StepStatus[];
};

export type JobStatus = {
  id: string;
  name: string;
  needs: string[];
  state: JobState;
  note?: string;
  usesSecrets: boolean;
  combinations: CombinationStatus[];
};

// What a run was asked to do, as supersession compares it.
export type RunConfig = {
  sha: string;
  deploy: boolean;
  // The jobs this run may run: those --job selected (with what they need), less --skip.
  jobs: string[];
  // --matrix key=value filters.
  matrix: string[];
  // The commit the Changes job compares with; undefined means everything runs.
  base?: string;
};

export type RunStatus = {
  version: 1;
  id: string;
  pid: number;
  repository: string;
  workflow: string;
  workflowName: string;
  // The workflow file: absolute, and relative to its repository.
  workflowFile: string;
  workflowPath: string;
  // The tested commit's subject and author.
  title: string;
  author: string;
  // The runner's arguments, for running it again.
  args: string[];
  branch: string;
  event: string;
  config: RunConfig;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  // While queued: the run it waits for, and why it doesn't replace it.
  waitingFor?: { run: string; reason: string };
  supersededBy?: string;
  jobs: JobStatus[];
};

export type Decision = { supersedes: true } | { supersedes: false; reason: string };

// A newer run replaces an older one on the same workflow and branch only when it does at least
// everything the older one would: the same or a later commit, at least as much deploying, every
// job the older one may run, no stricter matrix filter, and changes compared from no later a point
// (an older run of everything counts as comparing from its own commit).
// Otherwise the older run's work isn't covered, so the newer one waits for it.
export function decideSupersession(
  newer: RunConfig,
  older: RunConfig,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): Decision {
  if (older.deploy && !newer.deploy)
    return { supersedes: false, reason: "the earlier run deploys and this one doesn't" };
  if (newer.sha !== older.sha && !isAncestor(older.sha, newer.sha))
    return { supersedes: false, reason: "this commit doesn't contain the earlier run's commit" };
  const jobs = new Set(newer.jobs);
  const missing = older.jobs.filter((job) => !jobs.has(job));
  if (missing.length) return { supersedes: false, reason: `this run doesn't include ${missing.join(", ")}` };
  const filters = new Set(older.matrix);
  const stricter = newer.matrix.filter((filter) => !filters.has(filter));
  if (stricter.length) return { supersedes: false, reason: `this run only runs ${stricter.join(", ")}` };
  // A job the newer run skips is unchanged since its base, a commit trusted to pass. When that
  // base is no later than where the older run compares from, the job is unchanged there too. An
  // older run of everything compares from nowhere: it is covered when the newer run's base is no
  // later than its commit (the job is unchanged there) or contains it (its commit already passed).
  if (newer.base !== undefined) {
    const covered =
      older.base === undefined
        ? newer.base === older.sha || isAncestor(newer.base, older.sha) || isAncestor(older.sha, newer.base)
        : newer.base === older.base || isAncestor(newer.base, older.base);
    if (!covered)
      return {
        supersedes: false,
        reason:
          older.base === undefined
            ? "the earlier run runs everything on a commit unrelated to this run's base"
            : "the earlier run compares with an earlier commit",
      };
  }
  return { supersedes: true };
}

// Whether a run is in a job that deploys or publishes: such a run is never cancelled halfway.
export function isDeploying(status: RunStatus): boolean {
  return status.config.deploy && status.jobs.some((job) => job.usesSecrets && job.state === "running");
}
