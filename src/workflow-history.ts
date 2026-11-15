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

function matchesWorkflow(status: SavedStatus, workflow: LocalWorkflow) {
  if (status.config.deploy) return Boolean(workflow.deployment);
  const requested = new Set(
    status.args.flatMap((arg, index, args) => (arg === "--job" ? args.slice(index + 1, index + 2) : [])),
  );
  const configured = new Set(workflow.jobs ?? []);
  return requested.size === configured.size && [...requested].every((job) => configured.has(job));
}

export async function localWorkflowRuns(cwd: string, config: LocalWorkflow) {
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
    const saved: { status: SavedStatus; directory: string }[] = [];
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
            !Array.isArray(status.jobs) ||
            !matchesWorkflow(status, config)
          )
            continue;
          saved.push({ status, directory });
        } catch {
          // A run may be removed by pruning while DevPad is starting.
        }
      }
    }
    return saved
      .sort((a, b) => b.status.startedAt.localeCompare(a.status.startedAt))
      .slice(0, 15)
      .map(({ status, directory }) => ({
        id: status.id,
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
