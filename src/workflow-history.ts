import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { LocalWorkflow } from "./index.js";
import { logStream } from "./logs.js";
import type { WorkflowJob } from "./ui.js";

type SavedStatus = {
  version: number;
  id: string;
  workflowPath: string;
  branch: string;
  state: string;
  /** The runner's process, which keeps this file current while the run is going. */
  pid?: number;
  startedAt: string;
  args: string[];
  config: { deploy: boolean };
  jobs: Array<Omit<WorkflowJob, "logKeys"> & { combinations: Array<{ key: string; log: string }> }>;
};

const git = promisify(execFile);
const directories = async (path: string) =>
  (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory());

/** Whether the process that wrote a running run's status is still going: a runner that was killed leaves "running" behind. */
const isAlive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const requestedJobs = (status: SavedStatus) =>
  new Set(status.args.flatMap((arg, index, args) => (arg === "--job" ? args.slice(index + 1, index + 2) : [])));
const sameJobs = (requested: Set<string>, configured: readonly string[]) =>
  requested.size === new Set(configured).size && configured.every((job) => requested.has(job));

/**
 * Whether a saved run belongs to this workflow entry, and the jobs it was limited to when they
 * aren't the entry's own: a run of exactly the entry's jobs is its run, and the entry for the whole
 * workflow (no `jobs`) also lists the partial runs no other entry for the same file claims, such as
 * one started from the command line with `--job`, so every run holding the runner shows somewhere.
 */
function matchWorkflow(
  status: SavedStatus,
  workflow: LocalWorkflow,
  others: readonly LocalWorkflow[],
): { partial?: string[] } | undefined {
  if (status.config.deploy) return workflow.deployment ? {} : undefined;
  const requested = requestedJobs(status);
  if (sameJobs(requested, workflow.jobs ?? [])) return {};
  if (workflow.jobs?.length || others.some((other) => sameJobs(requested, other.jobs ?? []))) return undefined;
  return { partial: [...requested].sort() };
}

/** The saved runs of one workflow entry; `entries` are all the dashboard's entries (see matchWorkflow). */
export async function localWorkflowRuns(cwd: string, config: LocalWorkflow, entries: readonly LocalWorkflow[] = []) {
  try {
    const path = await realpath(resolve(cwd, config.file));
    const gitOptions = { cwd: dirname(path) };
    const [root, branchResult] = await Promise.all([
      git("git", ["rev-parse", "--show-toplevel"], gitOptions),
      git("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], gitOptions).catch(() => undefined),
    ]);
    const repository = root.stdout.trim();
    const branch = branchResult?.stdout.trim() || "main";
    const workflowPath = relative(repository, path);
    const stateRoot = join(repository, ".local/workflows");
    const workflow = basename(path).replace(/\.ya?ml$/, "");
    const others = entries.filter(
      (entry) => entry !== config && entry.id !== config.id && resolve(cwd, entry.file) === resolve(cwd, config.file),
    );
    const saved: { status: SavedStatus; directory: string; partial?: string[] }[] = [];
    for (const entry of await directories(stateRoot)) {
      const runs = join(stateRoot, entry.name, workflow, branch, "runs");
      const recent = (await directories(runs)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 40);
      for (const run of recent) {
        const directory = join(runs, run.name);
        try {
          const status: SavedStatus = JSON.parse(await readFile(join(directory, "status.json"), "utf8"));
          if (
            status.version !== 1 ||
            status.workflowPath !== workflowPath ||
            status.branch !== branch ||
            !(
              ["passed", "failed", "cancelled"].includes(status.state) ||
              (status.state === "running" && isAlive(status.pid))
            ) ||
            !Array.isArray(status.jobs)
          )
            continue;
          const match = matchWorkflow(status, config, others);
          if (match) saved.push({ status, directory, ...match });
        } catch {
          // A run may be removed by pruning while DevPad is starting.
        }
      }
    }
    return saved
      .sort((a, b) => b.status.startedAt.localeCompare(a.status.startedAt))
      .slice(0, 15)
      .map(({ status, directory, partial }) => ({
        id: status.id,
        /** The jobs a partial run was limited to, when they aren't this entry's own. */
        partial,
        branch: status.branch,
        startedAt: status.startedAt,
        state: status.state,
        pid: status.state === "running" ? status.pid : undefined,
        stages: [],
        jobs: status.jobs.map(({ id, name, state, needs, combinations }) => ({
          id,
          name,
          state,
          needs,
          logKeys: combinations.map(({ key }) => key),
        })),
        directory,
        logs: status.jobs.flatMap((job) => job.combinations),
      }));
  } catch {
    return [];
  }
}

export function readWorkflowLog(directory: string, file: string, emit: (message: string) => void) {
  if (!file.endsWith(".log") || file !== basename(file)) return;
  let fd: number | undefined;
  try {
    fd = openSync(join(directory, file), "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    const text = buffer.toString("utf8", 0, readSync(fd, buffer, 0, length, size - length));
    const stream = logStream(emit);
    stream.write(size > length ? text.slice(text.indexOf("\n") + 1) : text);
    stream.end();
  } catch {
    // A saved run can still show its graph if a log has been removed.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
