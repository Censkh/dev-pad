#!/usr/bin/env bun
// Runs a GitHub Actions workflow locally. The YAML decides everything about the run: which
// jobs exist and what they need, their matrices, `if` conditions, env, inputs and step order.
// Each step that runs is carried out by the TypeScript processor registered for it (by step id
// or name, or by its action for `uses:` steps): processors/<repository>/<workflow file>.ts and
// actions.ts. The step's `run:` text is never executed, and a step without a processor fails
// `--check`, so the two stay in step.
//
//   dev-pad workflows <workflow.yml> [options]
//   dev-pad workflows --check <workflow.yml>...
//
//   --ref <commit>   The commit to run (default HEAD of the workflow's repository). Only
//                    committed work runs: each job gets a clean checkout of it.
//   --branch <name>  github.ref_name (default the repository's current branch, else main).
//   --event <name>   github.event_name (default push).
//   --dry-run        Skip the jobs that use secrets (deploys, publishing). A complete run
//                    otherwise loads the workflow's secrets and runs them; a run limited by
//                    --job, --skip, --matrix or --since never does.
//   --job <id>       Run only this job and what it needs (repeatable).
//   --skip <id>      Treat this job as skipped (repeatable).
//   --no-fail-fast   Run every job even after a step fails. By default the first failing step
//                    stops the run: its log tail is printed at once, the other jobs' steps are
//                    stopped and every job not finished is cancelled.
//   --all            Ignore the last successful run (the changes job then runs everything).
//   --since <ref>    Compare with this commit instead of the last successful run, so the
//                    changes job runs what a push of the changes since then needs
//                    (`--since origin/main`).
//   --matrix <k=v>   Run only the matrix combinations whose k is v, in jobs whose matrix has
//                    a k (repeatable): `--job backend-tests --matrix shard=2`. Combinations
//                    keep their positions, so shard 2 of 5 is still 2/5.
//   --jobs <n>       At most this many of the run's job combinations at once. Without it the
//                    machine's load decides (machine-load.ts). Each combination has its own workspace.
//   --processors <module>  The processors module (default processors/<repository>/<workflow>.ts).
//   --state <dir>    Where workspaces and runs live (default .local/workflows).
//   --check          Check that every step that can run locally has a processor, that every
//                    action input is implemented and that no processor is left over; run nothing.
//
// State lives in .local/workflows/<repository>/<workflow>/<branch>/:
// workspaces/<job> (kept between runs, so dependencies stay installed; <job>.2 and on when runs
// going at once need the same job's workspace), runs/<time>-<sha>/ (a log per job, artifacts,
// summary.txt) and last-success.json, written after a complete deploying run. Runs of the same
// workflow and branch go side by side; only deploying runs take turns.
//
// Secrets come from the environment or the macOS Keychain service configured with --keychain-service.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { actionProcessor, actions, isPreservablePath } from "./actions";
import {
  condition,
  type ExpressionContext,
  evaluateValue,
  interpolate,
  stringify,
  truthy,
  UnknownContextError,
  type Value,
} from "./expressions";
import { alive, type Lease, leaseHolder, tryLease } from "./leases";
import { jobCpus, loadLimits, MachineLoad, waitNote } from "./machine-load";
import { PortReservations } from "./ports";
import type { NeedResult, Processor, Processors, RunInfo, StepRun } from "./processor";
import { StepFailure } from "./processor";
import { pruneState } from "./prune";
import { chainSeconds, isQuick, jobDuration, startOrder, type Waiter } from "./schedule";
import {
  type CombinationStatus,
  decideSupersession,
  isDeploying,
  type JobStatus as LiveJob,
  type RunStatus,
} from "./status";
import {
  actionName,
  expandMatrix,
  type Job,
  jobLabel,
  loadWorkflow,
  needsOf,
  type Step,
  type Workflow,
} from "./workflow";
import { leaseWorkspace } from "./workspaces";

const runnerOS =
  ({ darwin: "macOS", linux: "Linux", win32: "Windows" } as Record<string, string>)[process.platform] ??
  process.platform;

// --- Loading ------------------------------------------------------------------------------------

function gitOutput(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

type Loaded = {
  path: string;
  file: string;
  repository: string;
  repositoryRoot: string;
  slug: string;
  workflow: Workflow;
  processors: Processors;
  deployJobs: string[];
  optionalSecrets: Set<string>;
  // Groups of job ids whose matrix combinations never run at the same time (shared ports).
  exclusive: string[][];
  // Untracked paths a job's checkout keeps between runs, as caches (RunInfo.preserve).
  preserve: string[];
};

/**
 * The repository's origin URL, through any local clones: a job's workspace is cloned from this
 * Mac's copy, so its origin is a path whose own origin names the repository (CalmLens/CalmLens).
 * Read as a slug, the path named it "safemind", and --check found no processors in a workspace.
 */
const originRemote = (repositoryRoot: string) => {
  let remote = gitOutput(repositoryRoot, "remote", "get-url", "origin") ?? repositoryRoot;
  for (let hops = 0; hops < 5; hops++) {
    const local = remote.startsWith("file://") ? remote.slice("file://".length) : remote;
    if (!local.startsWith("/") || !existsSync(local)) break;
    const next = gitOutput(local, "remote", "get-url", "origin");
    if (!next || next === remote) break;
    remote = next;
  }
  return remote;
};

// A run reads the workflow as committed at the commit it tests; --check reads the working tree.
async function load(
  workflowPath: string,
  processorsModule?: string,
  ref?: string,
  processorRoot?: string,
): Promise<Loaded> {
  // Real paths, as git reports the repository root (/var is /private/var).
  const path = realpathSync(resolve(workflowPath));
  const repositoryRoot = gitOutput(dirname(path), "rev-parse", "--show-toplevel");
  if (!repositoryRoot) throw new Error(`${workflowPath} is not in a git repository`);
  const remote = originRemote(repositoryRoot);
  const slug = /[:/]([^/:]+\/[^/]+?)(\.git)?$/.exec(remote)?.[1] ?? basename(repositoryRoot);
  const repository = slug.split("/").pop()!;
  const file = basename(path);
  const module = processorsModule
    ? resolve(processorsModule)
    : join(
        processorRoot ?? join(repositoryRoot, "scripts/local-workflows/processors"),
        repository,
        `${file.replace(/\.ya?ml$/, "")}.ts`,
      );
  const imported = existsSync(module)
    ? ((await import(module)) as {
        processors?: Processors;
        exclusive?: string[][];
        deployJobs?: string[];
        optionalSecrets?: string[];
        preserve?: string[];
      })
    : {};
  const processors: Processors = imported.processors ?? {};
  const exclusive = imported.exclusive ?? [];
  let text: string | undefined;
  if (ref) {
    text = gitOutput(repositoryRoot, "show", `${ref}:${relative(repositoryRoot, path)}`);
    if (text === undefined) throw new Error(`${relative(repositoryRoot, path)} is not in ${ref}`);
  }
  return {
    path,
    file,
    exclusive,
    repository,
    repositoryRoot,
    slug,
    workflow: loadWorkflow(path, text),
    processors,
    deployJobs: imported.deployJobs ?? [],
    optionalSecrets: new Set(imported.optionalSecrets ?? []),
    preserve: imported.preserve ?? [],
  };
}

const stepKey = (step: Step) => step.id ?? step.name;

function registeredProcessor(loaded: Loaded, jobId: string, step: Step) {
  const key = stepKey(step);
  return key ? (loaded.processors[`${jobId}/${key}`] ?? loaded.processors[key]) : undefined;
}

function processorFor(loaded: Loaded, jobId: string, step: Step): Processor | undefined {
  return registeredProcessor(loaded, jobId, step) ?? (step.uses ? actionProcessor(actionName(step.uses)) : undefined);
}

const deployOnly = (loaded: Loaded, id: string, job: Job) =>
  loaded.deployJobs.includes(id) || /\bsecrets\./.test(JSON.stringify(job));

// --- Check --------------------------------------------------------------------------------------

function staticContext(loaded: Loaded): ExpressionContext {
  // Only what is known before a run: an expression reading anything else is undecidable here.
  return {
    contexts: {
      github: { event_name: "push", repository: loaded.slug, server_url: "https://github.com" },
      runner: {
        os: runnerOS,
        arch: process.arch === "arm64" ? "ARM64" : "X64",
        environment: "local",
      },
      vars: {},
      inputs: {},
      secrets: undefined,
      env: undefined,
      matrix: undefined,
      needs: undefined,
      steps: undefined,
      strategy: undefined,
      job: undefined,
    },
  };
}

function workflowDependencies(workflow: Workflow): Map<string, Set<string>> {
  const artifactName = (step: Step, action: string) =>
    step.uses &&
    actionName(step.uses) === action &&
    typeof step.with?.name === "string" &&
    !step.with.name.includes("${{")
      ? step.with.name
      : undefined;
  const jobs = Object.entries(workflow.jobs);
  const producers = new Map<string, Set<string>>();
  for (const [id, job] of jobs)
    for (const step of job.steps ?? []) {
      const name = artifactName(step, "actions/upload-artifact");
      if (name) producers.set(name, (producers.get(name) ?? new Set()).add(id));
    }
  return new Map(
    jobs.map(([id, job]) => {
      const dependencies = new Set(needsOf(job));
      for (const need of dependencies) if (!workflow.jobs[need]) throw new Error(`${id} needs an unknown job ${need}`);
      for (const step of job.steps ?? []) {
        const name = artifactName(step, "actions/download-artifact");
        for (const producer of (name && producers.get(name)) || []) if (producer !== id) dependencies.add(producer);
      }
      return [id, dependencies];
    }),
  );
}

function selectedJobs(dependencies: Map<string, Set<string>>, requested: string[]): Set<string> {
  if (!requested.length) return new Set(dependencies.keys());
  const selected = new Set<string>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    const needs = dependencies.get(id);
    if (!needs) throw new Error(`No job ${id}`);
    selected.add(id);
    for (const need of needs) visit(need);
  };
  requested.forEach(visit);
  return selected;
}

function check(loaded: Loaded, selected: Set<string>, partial = false): string[] {
  const errors: string[] = [];
  const context = staticContext(loaded);
  const used = new Set<string>();
  const where = (jobId: string, step: Step, index: number) =>
    `${loaded.file} ${jobId} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
  for (const [jobId, job] of Object.entries(loaded.workflow.jobs)) {
    if (!selected.has(jobId)) continue;
    process.stdout.write(
      `${loaded.file} ${jobId}${deployOnly(loaded, jobId, job) ? " (uses secrets: complete runs without --dry-run only)" : ""}\n`,
    );
    (job.steps ?? []).forEach((step, index) => {
      // A step never runs locally when its condition is false whether earlier steps passed or
      // failed (a runner.environment guard); anything undecidable might run.
      let neverRuns = false;
      try {
        neverRuns = [false, true].every(
          (earlierFailed) =>
            !condition(step.if, {
              ...context,
              status: {
                success: () => !earlierFailed,
                failure: () => earlierFailed,
                cancelled: () => false,
              },
            }),
        );
      } catch (error) {
        if (!(error instanceof UnknownContextError))
          errors.push(`${where(jobId, step, index)}: ${(error as Error).message}`);
      }
      const key = stepKey(step);
      if (key) for (const candidate of [`${jobId}/${key}`, key]) if (loaded.processors[candidate]) used.add(candidate);
      let label: string;
      if (neverRuns) {
        label = "skipped locally";
      } else if (!key && !step.uses) {
        errors.push(`${where(jobId, step, index)}: a run step needs an id or name to have a processor`);
        label = "MISSING (unnamed)";
      } else if (!processorFor(loaded, jobId, step)) {
        errors.push(`${where(jobId, step, index)}: no local processor for '${key ?? step.uses}'`);
        label = "MISSING";
      } else {
        const registered = registeredProcessor(loaded, jobId, step);
        if (!registered && step.uses) {
          const action = actions[actionName(step.uses)];
          for (const input of Object.keys(step.with ?? {}))
            if (!action.inputs.includes(input))
              errors.push(
                `${where(jobId, step, index)}: ${actionName(step.uses)} input '${input}' has no local implementation`,
              );
          label = `action ${actionName(step.uses)}`;
        } else {
          label = `processor ${loaded.processors[`${jobId}/${key}`] ? `${jobId}/${key}` : key}`;
        }
      }
      process.stdout.write(`  ${step.name ?? step.id ?? step.uses}: ${label}\n`);
    });
  }
  if (!partial)
    for (const key of Object.keys(loaded.processors))
      if (!used.has(key)) errors.push(`${loaded.file}: processor '${key}' matches no step`);
  for (const group of loaded.exclusive)
    for (const id of group)
      if (!loaded.workflow.jobs[id]) errors.push(`${loaded.file}: exclusive job '${id}' doesn't exist`);
  for (const id of loaded.deployJobs)
    if (!loaded.workflow.jobs[id]) errors.push(`${loaded.file}: deploy job '${id}' doesn't exist`);
  for (const path of loaded.preserve)
    if (!isPreservablePath(path))
      errors.push(`${loaded.file}: preserved path '${path}' isn't a plain path inside the workspace`);
  return errors;
}

// --- Arguments ----------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(["--dry-run", "--all", "--check", "--no-fail-fast", "--stream", "--status-events"]);
const repeated: Record<string, string[]> = { "--job": [], "--skip": [], "--matrix": [] };
const single: Record<string, string | undefined> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (flags.has(arg)) single[arg] = "true";
  else if (arg in repeated) repeated[arg].push(args[++i]);
  else if (
    [
      "--ref",
      "--branch",
      "--event",
      "--jobs",
      "--processors",
      "--state",
      "--since",
      "--tool-cache",
      "--keychain-service",
      "--processor-root",
    ].includes(arg)
  )
    single[arg] = args[++i];
  else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
  else positional.push(arg);
}
if (positional.length === 0) {
  process.stderr.write("Usage: dev-pad workflows [--check] <workflow.yml>... [options]\n");
  process.exit(2);
}

if (single["--check"]) {
  const errors: string[] = [];
  for (const path of positional) {
    const workflow = await load(path, single["--processors"], undefined, single["--processor-root"]);
    const requested = repeated["--job"];
    errors.push(
      ...check(workflow, selectedJobs(workflowDependencies(workflow.workflow), requested), requested.length > 0),
    );
  }
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exit(errors.length ? 1 : 0);
}
if (positional.length !== 1) throw new Error("Run one workflow at a time");

// --- Run setup ----------------------------------------------------------------------------------

const workflowRoot = gitOutput(dirname(resolve(positional[0])), "rev-parse", "--show-toplevel");
if (!workflowRoot) throw new Error(`${positional[0]} is not in a git repository`);
const resolvedSha = gitOutput(workflowRoot, "rev-parse", "--verify", `${single["--ref"] ?? "HEAD"}^{commit}`);
if (!resolvedSha) throw new Error(`${single["--ref"] ?? "HEAD"} is not a commit`);
const sha: string = resolvedSha;
const loaded = await load(positional[0], single["--processors"], sha, single["--processor-root"]);
const stateRoot = single["--state"] ? resolve(single["--state"]) : join(loaded.repositoryRoot, ".local/workflows");
const toolCache = resolve(single["--tool-cache"] ?? join(homedir(), ".cache/dev-pad-workflows"));
const keychainService = single["--keychain-service"];
const dependencies = workflowDependencies(loaded.workflow);
{
  const requested = repeated["--job"];
  const errors = check(loaded, selectedJobs(dependencies, requested), requested.length > 0);
  if (errors.length) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.exit(1);
  }
}
// A complete run deploys unless it's a dry run; a run limited to part of the workflow never does,
// so checking a few jobs, or what a push of some commits needs, can't deploy.
const partialRun =
  repeated["--job"].length > 0 ||
  repeated["--skip"].length > 0 ||
  repeated["--matrix"].length > 0 ||
  single["--since"] !== undefined;
const deploy = !single["--dry-run"] && !partialRun;
const branch =
  single["--branch"] ?? gitOutput(loaded.repositoryRoot, "symbolic-ref", "--quiet", "--short", "HEAD") ?? "main";
const event = single["--event"] ?? "push";
const stateDir = join(stateRoot, loaded.repository, loaded.file.replace(/\.ya?ml$/, ""), branch);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha.slice(0, 9)}`;
const runDir = join(stateDir, "runs", runId);
const artifactsDir = join(runDir, "artifacts");
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(join(stateDir, "workspaces"), { recursive: true });
mkdirSync(toolCache, { recursive: true });

const timeoutBin = Bun.which("gtimeout") ?? Bun.which("timeout") ?? "";
if (!timeoutBin) throw new Error("Needs GNU timeout: brew install coreutils");

// Secrets, only when deploying, and all of them up front so a deploy never stops half way.
const secrets: Record<string, string> = {};
if (deploy) {
  const names = new Set(
    [...readFileSync(loaded.path, "utf8").matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  );
  const missing: string[] = [];
  for (const name of names) {
    let value = process.env[name];
    if (!value && keychainService && process.platform === "darwin") {
      const result = Bun.spawnSync(["security", "find-generic-password", "-s", keychainService, "-a", name, "-w"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      if (result.exitCode === 0) value = result.stdout.toString().trim();
    }
    if (value) secrets[name] = value;
    else if (!loaded.optionalSecrets.has(name)) missing.push(name);
  }
  if (missing.length) {
    process.stderr.write(`Missing workflow secrets: ${missing.join(", ")}\n`);
    process.exit(1);
  }
}
const secretValues = Object.values(secrets).filter((value) => value.length >= 4);
const redact = (text: string) => secretValues.reduce((out, value) => out.split(value).join("***"), text);

const recordPath = join(stateDir, "last-success.json");
if (single["--all"] && single["--since"]) throw new Error("--all and --since contradict each other");
let lastSuccessSha: string | undefined;
if (single["--since"]) {
  lastSuccessSha = gitOutput(loaded.repositoryRoot, "rev-parse", "--verify", `${single["--since"]}^{commit}`);
  if (!lastSuccessSha) throw new Error(`--since ${single["--since"]} is not a commit`);
} else if (!single["--all"] && existsSync(recordPath)) {
  lastSuccessSha = JSON.parse(readFileSync(recordPath, "utf8")).sha as string;
}

// --matrix key=value filters.
const matrixFilters = repeated["--matrix"].map((filter) => {
  const equals = filter.indexOf("=");
  if (equals < 1) throw new Error(`--matrix ${filter} is not key=value`);
  return { key: filter.slice(0, equals), value: filter.slice(equals + 1) };
});

const runInfo: RunInfo = {
  source: loaded.repositoryRoot,
  sha,
  branch,
  event,
  deploy,
  lastSuccessSha,
  artifacts: artifactsDir,
  toolCache,
  runnerPackage: resolve(import.meta.dir, ".."),
  preserve: loaded.preserve,
};

const github = {
  repository: loaded.slug,
  repository_owner: loaded.slug.split("/")[0],
  ref_name: branch,
  ref: `refs/heads/${branch}`,
  head_ref: "",
  base_ref: "",
  event_name: event,
  event: {},
  sha,
  run_id: runId,
  run_attempt: "1",
  run_number: "1",
  workflow: loaded.workflow.name ?? loaded.file,
  token: "",
  actor: "local",
  server_url: "https://github.com",
};
const runner = {
  os: runnerOS,
  arch: process.arch === "arm64" ? "ARM64" : "X64",
  environment: "local",
  name: "local",
  temp: join(runDir, "tmp"),
};

const baseContexts = { github, runner, vars: {}, inputs: {}, secrets } as Record<string, Value>;
const workflowEnv = stringMap(evaluateValue(loaded.workflow.env ?? {}, { contexts: { ...baseContexts, env: {} } }));

function stringMap(value: Value): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stringify(item)]));
}

// --- Scheduling ---------------------------------------------------------------------------------

type Result = "success" | "failure" | "skipped" | "cancelled";
type JobState = {
  id: string;
  job: Job;
  result?: Result;
  running?: boolean;
  outputs: Record<string, string>;
  note?: string;
};
const jobs = new Map<string, JobState>(
  Object.entries(loaded.workflow.jobs).map(([id, job]) => [id, { id, job, outputs: {} }]),
);
for (const state of jobs.values())
  for (const need of needsOf(state.job))
    if (!jobs.has(need)) throw new Error(`${state.id} needs an unknown job ${need}`);

// A job that downloads an artifact another job uploads starts after that job: on GitHub such
// jobs may start early and wait (a polling step), which local runs, starting jobs only as load allows, can't afford.
const waitsFor = (state: JobState) => dependencies.get(state.id)!;

const selected = repeated["--job"];
if (selected.length) {
  const keep = selectedJobs(dependencies, selected);
  for (const state of jobs.values())
    if (!keep.has(state.id)) {
      state.result = "skipped";
      state.note = "not selected";
    }
}
for (const id of repeated["--skip"]) {
  const state = jobs.get(id);
  if (!state) throw new Error(`No job ${id}`);
  state.result = "skipped";
  state.note = "--skip";
}

const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
  for (const need of needsOf(jobs.get(id)!.job))
    if (!seen.has(need)) {
      seen.add(need);
      ancestors(need, seen);
    }
  return seen;
};

let cancelled = false;
// The job and step whose failure stopped the run (fail-fast).
let stoppedBy: { job: string; label: string } | undefined;
const failFast = !single["--no-fail-fast"];
const controllers = new Set<AbortController>();
function cancel() {
  if (cancelled) process.exit(130);
  cancelled = true;
  const supersededBy = (() => {
    try {
      return readFileSync(join(runDir, "superseded-by"), "utf8").trim();
    } catch {
      return undefined;
    }
  })();
  process.stderr.write(
    supersededBy
      ? `\nSuperseded by ${supersededBy}: stopping running steps\n`
      : "\nCancelling: stopping running steps (Ctrl-C again to quit at once)\n",
  );
  // The live status exists once the run has set up (a signal can't come sooner in practice).
  try {
    live.supersededBy = supersededBy;
    updateStatus();
  } catch {}
  for (const controller of controllers) controller.abort();
}
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

const started = Date.now();
const clock = () => {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const say = (text: string) => process.stdout.write(`[${clock()}] ${text}\n`);

// --- Live status (status.ts), for the web GUI and for runs deciding whether to supersede ----------

const now = () => new Date().toISOString();
const live: RunStatus = {
  version: 1,
  id: runId,
  pid: process.pid,
  repository: loaded.slug,
  workflow: loaded.file,
  workflowName: loaded.workflow.name ?? loaded.file,
  workflowFile: loaded.path,
  workflowPath: relative(loaded.repositoryRoot, loaded.path),
  title: gitOutput(loaded.repositoryRoot, "log", "-1", "--format=%s", sha) ?? sha.slice(0, 9),
  author: gitOutput(loaded.repositoryRoot, "log", "-1", "--format=%an", sha) ?? "",
  args,
  branch,
  event,
  config: {
    sha,
    deploy,
    jobs: [...jobs.values()].filter((state) => !state.result).map((state) => state.id),
    matrix: repeated["--matrix"],
    base: lastSuccessSha,
  },
  state: "queued",
  startedAt: now(),
  jobs: [...jobs.values()].map((state) => ({
    id: state.id,
    name: jobLabel(state.job, state.id),
    needs: needsOf(state.job),
    state: state.result ?? "pending",
    note: state.note,
    usesSecrets: deployOnly(loaded, state.id, state.job),
    combinations: [],
  })),
};
// Each combination's duration in the latest runs of this workflow on this branch, by job, for the
// start order (schedule.ts); one never timed counts as longest. Every timing in those runs, by
// combination, says whether it is quick enough to start without waiting for the machine's load.
const previousSeconds = new Map<string, number>();
const previousTimings = new Map<string, number[]>();
const previousJobSeconds = new Map<string, Map<string, number>>();
try {
  const earlier = readdirSync(join(stateDir, "runs"))
    .filter((name) => name !== runId)
    .sort()
    .reverse()
    .slice(0, 10);
  for (const name of earlier) {
    try {
      const status = JSON.parse(readFileSync(join(stateDir, "runs", name, "status.json"), "utf8")) as RunStatus;
      for (const job of status.jobs)
        for (const combination of job.combinations)
          if (combination.startedAt && combination.finishedAt) {
            const seconds = (Date.parse(combination.finishedAt) - Date.parse(combination.startedAt)) / 1000;
            previousTimings.set(combination.key, [...(previousTimings.get(combination.key) ?? []), seconds]);
            if (previousSeconds.has(combination.key)) continue;
            previousSeconds.set(combination.key, seconds);
            if (!previousJobSeconds.has(job.id)) previousJobSeconds.set(job.id, new Map());
            previousJobSeconds.get(job.id)!.set(combination.key, seconds);
          }
    } catch {}
  }
} catch {}
const expectedSeconds = (key: string) => previousSeconds.get(key) ?? Number.POSITIVE_INFINITY;
const isExclusive = (id: string) => loaded.exclusive.some((group) => group.includes(id));
// The longest chain of jobs still to run that wait for this one, from their previous durations.
const expectedChain = (id: string) =>
  chainSeconds(dependencies, (dependent) =>
    jobs.get(dependent)?.result || (!deploy && deployOnly(loaded, dependent, jobs.get(dependent)!.job))
      ? 0
      : jobDuration([...(previousJobSeconds.get(dependent)?.values() ?? [])], isExclusive(dependent)),
  )(id);

const liveJob = (id: string): LiveJob => live.jobs.find((job) => job.id === id)!;
const statusPath = join(runDir, "status.json");
let statusTimer: ReturnType<typeof setTimeout> | undefined;
function writeStatusNow() {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = undefined;
  writeFileSync(`${statusPath}.tmp`, JSON.stringify(live, null, 2));
  renameSync(`${statusPath}.tmp`, statusPath);
  if (single["--status-events"]) {
    const jobs = live.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      state: job.state,
      note: job.note,
      needs: job.needs,
      logKeys: job.combinations.map((part) => part.key),
    }));
    const stages = live.jobs.flatMap((job) =>
      job.combinations
        .filter((part) => part.state === "running")
        .map((part) => part.steps.find((step) => step.state === "running")?.name ?? part.name),
    );
    process.stdout.write(
      `::dev-pad-status::${JSON.stringify({ id: live.id, startedAt: live.startedAt, state: live.state, jobs, stages })}\n`,
    );
  }
}
function updateStatus() {
  statusTimer ??= setTimeout(writeStatusNow, 200);
}
writeStatusNow();

// --- Running a job ------------------------------------------------------------------------------

type CombinationResult = { ok: boolean; outputs: Record<string, string> };

// Ports the steps of running combinations asked for (StepRun.openPorts).
const ports = new PortReservations(join(toolCache, "ports"));

async function runCombination(
  state: JobState,
  matrix: Record<string, Value>,
  index: number,
  total: number,
  cpus: number,
): Promise<CombinationResult> {
  const { id, job } = state;
  const key = total > 1 ? `${id}-${index + 1}` : id;
  const needs: Record<string, NeedResult> = {};
  for (const need of needsOf(job)) needs[need] = { result: jobs.get(need)!.result!, outputs: jobs.get(need)!.outputs };
  const strategy = {
    "job-index": index,
    "job-total": total,
    "fail-fast": truthy(job.strategy?.["fail-fast"] ?? true),
  };
  const jobContexts = { ...baseContexts, needs, matrix, strategy, env: workflowEnv } as Record<string, Value>;
  const name = interpolate(job.name ?? id, { contexts: jobContexts });
  // A workspace per combination, so a matrix's combinations run side by side, leased from its
  // pool so runs going at once never share one (workspaces.ts); the first free one is the most
  // used, so its dependencies and caches are the warmest.
  const { path: workspace, lease: workspaceLease } = leaseWorkspace(join(stateDir, "workspaces"), key, runId);
  // A runner killed mid-job may have left processes behind in it.
  if (workspaceLease.reclaimed) await reapWorkspace(workspace);
  // Its last use, for pruning.
  utimesSync(workspace, new Date(), new Date());
  const temp = join(runDir, "tmp", key);
  mkdirSync(temp, { recursive: true });

  const logPath = join(runDir, `${key}.log`);
  const log = Bun.file(logPath).writer();
  let liveLine = "";
  const write = (text: string) => {
    const safe = redact(text);
    log.write(safe);
    if (!single["--stream"]) return;
    const lines = (liveLine + safe).split("\n");
    liveLine = lines.pop() ?? "";
    for (const line of lines) if (line) process.stdout.write(`[${key}] ${line}\n`);
  };
  say(`▶ ${name}`);
  const combo: CombinationStatus = {
    key,
    name,
    matrix,
    index: index + 1,
    total,
    state: "running",
    startedAt: now(),
    log: `${key}.log`,
    steps: [],
  };
  liveJob(id).combinations.push(combo);
  updateStatus();
  const jobStarted = Date.now();
  const jobDeadline = jobStarted + Number(job["timeout-minutes"] ?? 360) * 60_000;

  const jobEnv = {
    ...workflowEnv,
    ...stringMap(evaluateValue(job.env ?? {}, { contexts: jobContexts })),
  };
  const exported: Record<string, string> = {};
  const paths: string[] = [];
  const stepsContext: Record<string, Value> = {};
  let failed = false;
  let failedStep: string | undefined;

  const runnerEnv: Record<string, string> = {
    CI: "true",
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: loaded.slug,
    GITHUB_REF_NAME: branch,
    GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: event,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: id,
    RUNNER_TEMP: temp,
    DEVPAD_JOB_CPUS: String(cpus),
    RUNNER_OS: runnerOS,
    RUNNER_ARCH: runner.arch,
    RUNNER_ENVIRONMENT: "local",
    TMPDIR: temp,
  };

  for (const [stepIndex, step] of (job.steps ?? []).entries()) {
    const stepName = step.name ?? step.id ?? step.uses ?? `step ${stepIndex + 1}`;
    const status = {
      success: () => !failed && !cancelled,
      failure: () => failed,
      cancelled: () => cancelled,
    };
    const env = { ...jobEnv, ...exported };
    const context: ExpressionContext = {
      contexts: {
        ...jobContexts,
        env,
        steps: stepsContext,
        job: { status: failed ? "failure" : cancelled ? "cancelled" : "success" },
      },
      status,
    };
    const stepId = step.id;
    if (!condition(step.if, context)) {
      if (stepId) stepsContext[stepId] = { outputs: {}, outcome: "skipped", conclusion: "skipped" };
      combo.steps.push({ name: stepName, state: "skipped" });
      updateStatus();
      continue;
    }
    const processor = processorFor(loaded, id, step)!;
    const stepEnv = { ...env, ...stringMap(evaluateValue(step.env ?? {}, context)) };
    const action = step.uses && !registeredProcessor(loaded, id, step) ? actions[actionName(step.uses)] : undefined;
    const inputs = action?.literalInputs
      ? (step.with ?? {})
      : (evaluateValue(step.with ?? {}, context) as Record<string, Value>);
    const workingDirectory = step.uses
      ? "."
      : (step["working-directory"] ??
        job.defaults?.run?.["working-directory"] ??
        loaded.workflow.defaults?.run?.["working-directory"] ??
        ".");
    const cwd = resolve(workspace, interpolate(workingDirectory, context));
    const outputs: Record<string, string> = {};
    const controller = new AbortController();
    controllers.add(controller);
    const stepDeadline = Math.min(jobDeadline, Date.now() + Number(step["timeout-minutes"] ?? 360) * 60_000);
    const timer = setTimeout(() => controller.abort(), Math.max(0, stepDeadline - Date.now()));
    write(`\n##[step] ${stepName}\n`);
    const stepStarted = Date.now();
    const liveStep = { name: stepName, state: "running" as const, startedAt: now() };
    combo.steps.push(liveStep);
    updateStatus();

    const children = new Set<Bun.Subprocess>();
    controller.signal.addEventListener("abort", () => {
      for (const child of children) child.kill("SIGTERM");
    });
    const spawn = async (
      command: string,
      commandArgs: string[],
      options: Parameters<StepRun["exec"]>[2] = {},
      capture = false,
    ) => {
      if (controller.signal.aborted) throw new StepFailure("Cancelled");
      const childCwd = resolve(cwd, options.cwd ?? ".");
      const limit = Math.min(
        stepDeadline,
        options.timeoutMinutes ? Date.now() + options.timeoutMinutes * 60_000 : stepDeadline,
      );
      const seconds = Math.max(1, Math.ceil((limit - Date.now()) / 1000));
      write(
        `$ ${[command, ...commandArgs].join(" ")}${childCwd === workspace ? "" : `  (in ${relative(workspace, childCwd) || "."})`}\n`,
      );
      const child = Bun.spawn(
        // timeout runs the command in a process group of its own and stops all of it.
        [timeoutBin, "--kill-after=30s", `${seconds}s`, command, ...commandArgs],
        {
          cwd: childCwd,
          env: {
            ...(process.env as Record<string, string>),
            ...runnerEnv,
            ...stepEnv,
            ...options.env,
            PATH: [...paths, process.env.PATH ?? ""].join(":"),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      children.add(child);
      let captured = "";
      const pump = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          const text = decoder.decode(chunk, { stream: true });
          if (keep) captured += text;
          else write(text);
        }
      };
      await Promise.all([pump(child.stdout, capture), pump(child.stderr, false), child.exited]);
      children.delete(child);
      const code = child.exitCode ?? 1;
      if (code !== 0 && !options.allowFailure)
        throw new StepFailure(`${command} ${commandArgs.join(" ")} exited with ${code === 124 ? "a timeout" : code}`);
      return { code, captured };
    };

    const stepRun: StepRun = {
      key: stepKey(step) ?? actionName(step.uses ?? ""),
      jobId: id,
      inputs,
      input: (inputName) => stringify(inputs[inputName]),
      env: stepEnv,
      matrix,
      strategy: { jobIndex: index + 1, jobTotal: total },
      needs,
      workspace,
      cwd,
      temp,
      run: runInfo,
      signal: controller.signal,
      exec: async (command, commandArgs, options) => (await spawn(command, commandArgs ?? [], options)).code,
      output: async (command, commandArgs, options) =>
        (await spawn(command, commandArgs ?? [], options, true)).captured.trim(),
      setOutput: (outputName, value) => {
        outputs[outputName] = value;
      },
      exportEnv: (envName, value) => {
        exported[envName] = value;
        stepEnv[envName] = value;
      },
      addPath: (directory) => {
        paths.unshift(directory);
      },
      log: (text) => write(`${text}\n`),
      artifactDirectory: (artifact) => join(artifactsDir, artifact),
      openPorts: (count, from) => ports.open(key, count, from),
    };

    let ok = true;
    try {
      await processor(stepRun);
    } catch (error) {
      ok = false;
      write(`##[error] ${error instanceof StepFailure ? error.message : (error as Error).stack}\n`);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
    if (!ok && controller.signal.aborted && !cancelled) write("##[error] The step timed out\n");
    const continueOnError = truthy(evaluateValue(step["continue-on-error"] ?? false, context));
    write(`##[end] ${stepName}: ${ok ? "success" : "failure"} in ${Math.round((Date.now() - stepStarted) / 1000)}s\n`);
    if (stepId)
      stepsContext[stepId] = {
        outputs,
        outcome: ok ? "success" : "failure",
        conclusion: ok || continueOnError ? "success" : "failure",
      };
    Object.assign(liveStep, { state: ok ? "success" : "failure", finishedAt: now() });
    updateStatus();
    if (!ok && !continueOnError) {
      failed = true;
      failedStep ??= stepName;
      // Fail fast: the first failure stops every other job; this job still runs its own
      // `if: failure()` steps (failure artifacts).
      if (failFast && !cancelled) {
        stoppedBy = { job: id, label: `${name}: ${stepName}` };
        await log.flush();
        say(`✘ ${name}: ${stepName} failed, so the run stops (--no-fail-fast runs every job) → ${logPath}`);
        const tail = readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-40);
        process.stdout.write(`${tail.map((line) => `    │ ${line}`).join("\n")}\n`);
        cancelled = true;
        for (const other of controllers) other.abort();
      }
    }
  }

  const outputContext: ExpressionContext = {
    contexts: { ...jobContexts, env: { ...jobEnv, ...exported }, steps: stepsContext },
  };
  const jobOutputs = stringMap(evaluateValue(job.outputs ?? {}, outputContext));
  if (liveLine) process.stdout.write(`[${key}] ${liveLine}\n`);
  await log.end();
  await reapWorkspace(workspace);
  workspaceLease.release();
  ports.release(key);
  const causedStop = stoppedBy?.job === id && failed;
  Object.assign(combo, {
    state: failed ? (cancelled && !causedStop ? "cancelled" : "failure") : "success",
    failedStep,
    finishedAt: now(),
  });
  updateStatus();
  const seconds = Math.round((Date.now() - jobStarted) / 1000);
  if (!failed) {
    say(`✔ ${name} (${seconds}s)`);
  } else if (cancelled && !causedStop) {
    say(`■ ${name} (${seconds}s): cancelled`);
  } else if (!causedStop) {
    say(`✘ ${name} (${seconds}s): ${failedStep} failed → ${logPath}`);
    const tail = readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-25);
    process.stdout.write(`${tail.map((line) => `    │ ${line}`).join("\n")}\n`);
  } else {
    say(`✘ ${name} (${seconds}s): ${failedStep} failed`);
  }
  return { ok: !failed, outputs: jobOutputs };
}

// As GitHub's runner cleans up orphan processes when a job ends: anything still running in the
// job's workspace (by working directory or command line), such as a test's web server that
// started a process group of its own, is stopped: SIGTERM, then SIGKILL after 5 s.
function workspaceProcesses(workspace: string) {
  // lsof reports real paths (/private/var for /var).
  const roots = [...new Set([workspace, existsSync(workspace) ? realpathSync(workspace) : workspace])];
  const inside = (path: string) => roots.some((root) => path === root || path.startsWith(`${root}/`));
  const pids = new Set<number>();
  const cwd = Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-Fpn"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  let pid = 0;
  for (const line of cwd.stdout.toString().split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && inside(line.slice(1))) pids.add(pid);
  }
  const ps = Bun.spawnSync(["ps", "-eo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  for (const line of ps.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match && roots.some((root) => match[2].includes(`${root}/`))) pids.add(Number(match[1]));
  }
  pids.delete(process.pid);
  return [...pids];
}
async function reapWorkspace(workspace: string) {
  const signal = (pids: number[], name: NodeJS.Signals) => {
    for (const pid of pids)
      try {
        process.kill(pid, name);
      } catch {}
  };
  let left = workspaceProcesses(workspace);
  if (!left.length) return;
  signal(left, "SIGTERM");
  for (let waited = 0; waited < 5000 && left.length; waited += 250) {
    await Bun.sleep(250);
    left = workspaceProcesses(workspace);
  }
  signal(left, "SIGKILL");
}

async function runJob(state: JobState): Promise<void> {
  const { id, job } = state;
  if (cancelled) {
    state.result = "cancelled";
    if (stoppedBy) state.note = `not run: ${stoppedBy.label} failed`;
    return;
  }
  const lineage = ancestors(id);
  const needs: Record<string, NeedResult> = {};
  for (const need of needsOf(job)) needs[need] = { result: jobs.get(need)!.result!, outputs: jobs.get(need)!.outputs };
  const context: ExpressionContext = {
    contexts: { ...baseContexts, needs, env: workflowEnv },
    status: {
      success: () => [...lineage].every((ancestor) => jobs.get(ancestor)!.result === "success") && !cancelled,
      failure: () => [...lineage].some((ancestor) => jobs.get(ancestor)!.result === "failure"),
      cancelled: () => cancelled,
    },
  };
  if (!condition(job.if, context)) {
    state.result = "skipped";
    return;
  }
  if (!deploy && deployOnly(loaded, id, job)) {
    state.result = "skipped";
    state.note = single["--dry-run"] ? "uses secrets: dry run" : "uses secrets: partial run";
    say(`- ${job.name ?? id}: skipped (${state.note})`);
    return;
  }
  const combinations =
    job.strategy?.matrix === undefined ? [{}] : expandMatrix(evaluateValue(job.strategy.matrix, context));
  if (combinations.length === 0) {
    state.result = "skipped";
    return;
  }
  // Each combination keeps its place in the whole matrix, so a filtered shard is still N/total.
  const chosen = combinations
    .map((matrix, index) => ({ matrix: matrix as Record<string, Value>, index }))
    .filter(({ matrix }) =>
      matrixFilters.every(({ key, value }) => !(key in matrix) || stringify(matrix[key]) === value),
    );
  if (chosen.length === 0) {
    state.result = "skipped";
    state.note = "no matrix combination matches --matrix";
    return;
  }
  const failFast = truthy(evaluateValue(job.strategy?.["fail-fast"] ?? true, context));
  const continueOnError = truthy(evaluateValue(job["continue-on-error"] ?? false, context));
  let ok = true;
  // The combinations run at once, each as the machine's load allows; with the strategy's fail-fast, one failure
  // stops those that haven't started.
  await Promise.all(
    chosen.map(({ matrix, index }) => {
      const key = combinations.length > 1 ? `${id}-${index + 1}` : id;
      return withSlot(
        id,
        expectedSeconds(key),
        expectedChain(id),
        isQuick(previousTimings.get(key) ?? []),
        async (cpus) => {
          if (cancelled || (!ok && failFast)) return;
          const result = await runCombination(state, matrix, index, combinations.length, cpus);
          Object.assign(state.outputs, result.outputs);
          if (!result.ok && !continueOnError) ok = false;
        },
      );
    }),
  );
  state.result = !ok && stoppedBy?.job === id ? "failure" : cancelled ? "cancelled" : ok ? "success" : "failure";
  if (state.result === "cancelled" && stoppedBy) state.note = `stopped: ${stoppedBy.label} failed`;
}

// --- Runs going at once ------------------------------------------------------------------------
// Runs of the same workflow and branch go side by side: each job combination leases a workspace of
// its own (workspaces.ts), exclusive groups and ports are leased across runs, and combinations start
// only while the machine's load leaves room (machine-load.ts). A new run
// stops every earlier live run whose work it does all of (decideSupersession) unless that one is
// deploying, and stops itself when an earlier live run already does all of its own; deploying
// runs take turns for the branch's deploy lease.
const isAncestorCommit = (ancestor: string, descendant: string) =>
  Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: loaded.repositoryRoot,
  }).exitCode === 0;
const readStatus = (dir: string): RunStatus | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as RunStatus;
  } catch {
    return undefined;
  }
};
// Runs started before this one (run directories are named by their start time) and still going.
function earlierLiveRuns() {
  const runsDir = join(stateDir, "runs");
  return readdirSync(runsDir)
    .filter((name) => name < runId)
    .flatMap((name) => {
      const status = readStatus(join(runsDir, name));
      return status && (status.state === "queued" || status.state === "running") && alive(status.pid)
        ? [{ dir: join(runsDir, name), status }]
        : [];
    });
}
const signalled = new Set<string>();
function supersedeEarlierRuns() {
  for (const { dir, status } of earlierLiveRuns()) {
    if (signalled.has(status.id) || isDeploying(status)) continue;
    if (!decideSupersession(live.config, status.config, isAncestorCommit).supersedes) continue;
    signalled.add(status.id);
    writeFileSync(join(dir, "superseded-by"), runId);
    try {
      process.kill(status.pid, "SIGINT");
    } catch (error) {
      // It ended after it was found live: nothing left to stop.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw error;
    }
    say(`Superseding ${status.id}: this run does everything it would`);
  }
}
supersedeEarlierRuns();
// And the other way round: an earlier live run that already does everything this one would, on this
// commit or a later one, absorbs this run, which stops before it starts anything.
{
  const covering = earlierLiveRuns().find(
    ({ status }) =>
      !signalled.has(status.id) && decideSupersession(status.config, live.config, isAncestorCommit).supersedes,
  );
  if (covering) {
    say(`Superseded by ${covering.status.id}: it already does everything this run would`);
    writeFileSync(join(runDir, "superseded-by"), covering.status.id);
    live.supersededBy = covering.status.id;
    live.state = "cancelled";
    live.finishedAt = now();
    writeStatusNow();
    process.exit(130);
  }
}
if (deploy) {
  const deployLease = join(stateDir, "deploy.lease");
  let lastWait = "";
  for (;;) {
    if (cancelled) {
      live.state = "cancelled";
      live.finishedAt = now();
      writeStatusNow();
      process.exit(130);
    }
    if (tryLease(deployLease, runDir)) break;
    const holder = leaseHolder(deployLease);
    const older = holder && readStatus(holder.owner);
    supersedeEarlierRuns();
    const decision = older && decideSupersession(live.config, older.config, isAncestorCommit);
    const reason = !older
      ? "what it runs is unknown (it has no live status)"
      : isDeploying(older)
        ? "it is deploying"
        : signalled.has(older.id)
          ? "it is stopping, superseded by this run"
          : decision && !decision.supersedes
            ? decision.reason
            : "deploying runs take turns";
    const run = older?.id ?? (holder ? `pid ${holder.pid}` : "another run");
    if (`${run} ${reason}` !== lastWait) {
      lastWait = `${run} ${reason}`;
      say(`Waiting for ${run}: ${reason}`);
      live.waitingFor = { run, reason };
      writeStatusNow();
    }
    await Bun.sleep(2000);
  }
}
live.state = "running";
live.waitingFor = undefined;
writeStatusNow();

// One run prunes at a time, and never removes a live run or a workspace another run holds
// (prune.ts): the last 20 runs stay, the last 5 with their artifacts. Idle workspaces and other
// branches' state are removed after a week, the extra workspaces runs going at once needed after a
// day.
{
  const pruning = tryLease(join(stateDir, "prune.lease"), runId);
  if (pruning) {
    const removed = pruneState({
      stateDir,
      keepRuns: 20,
      keepArtifacts: 5,
      maxIdleDays: 7,
      maxIdleExtraDays: 1,
      keep: [runId],
    });
    pruning.release();
    const counts = [
      [removed.runs.length, "old run"],
      [removed.artifacts.length, "run's artifacts"],
      [removed.workspaces.length, "idle workspace"],
      [removed.branches.length, "idle branch"],
    ].filter(([count]) => (count as number) > 0);
    if (counts.length)
      say(`Pruned ${counts.map(([count, what]) => `${count} ${what}${count === 1 ? "" : "s"}`).join(", ")}`);
  }
}

// --- Starting combinations ---------------------------------------------------------------------
// Waiting combinations start in the order schedule.ts gives, the one holding up the most work first,
// each once the machine's load leaves room for it (machine-load.ts, shared by every runner using this
// tool cache); exclusive groups (the processors module's `exclusive`) never run two at once.
// --jobs caps how many of this run's combinations run at once.
const slots = single["--jobs"] ? Math.max(1, Number(single["--jobs"])) : Number.POSITIVE_INFINITY;
const machineLoad = new MachineLoad(join(toolCache, "machine-load"), loadLimits());
let freeSlots = slots;
// This run's combinations that went through the load gate and are still running: with none, the
// next starts whatever the load, so a busy machine never stalls the run.
let admitted = 0;
// Combinations admitted one at a time, in the order startWaiters hands them over.
let admission: Promise<unknown> = Promise.resolve();
let readyToAdmit = 0;
// An exclusive group is a lease shared by every run of this workflow on the machine, whatever its
// branch or state directory, since what it protects (fixed ports) is the machine's.
const groupLeasePath = (group: string[]) =>
  join(
    toolCache,
    "exclusive",
    `${createHash("sha256")
      .update(JSON.stringify([loaded.slug, loaded.file, [...group].sort()]))
      .digest("hex")
      .slice(0, 24)}.lease`,
  );
// Every group's lease, or none: a combination waiting for one held elsewhere doesn't hold the others.
function leaseGroups(groups: string[][], owner: string) {
  const taken: Lease[] = [];
  for (const group of groups) {
    const lease = tryLease(groupLeasePath(group), owner);
    if (!lease) {
      for (const held of taken) held.release();
      return undefined;
    }
    taken.push(lease);
  }
  return taken;
}
type Waiting = Waiter & { owner: string; exclusive: string[][]; start: (leases: Lease[]) => void };
let waiters: Waiting[] = [];
let retry: ReturnType<typeof setTimeout> | undefined;
function startWaiters() {
  waiters = startOrder(waiters);
  let blocked = false;
  for (let i = 0; i < waiters.length && freeSlots > 0; ) {
    const waiter = waiters[i]!;
    // A group this run or another holds: the next waiter may go instead.
    const leases = leaseGroups(waiter.exclusive, waiter.owner);
    if (!leases) {
      blocked = true;
      i++;
      continue;
    }
    waiters.splice(i, 1);
    freeSlots--;
    waiter.start(leases);
  }
  // Another run frees a group without telling this one, so look again soon.
  if (blocked && !retry)
    retry = setTimeout(() => {
      retry = undefined;
      startWaiters();
    }, 1000);
}
// Runs `work` once the combination may start, with the CPUs it may use.
async function withSlot(
  jobId: string,
  seconds: number,
  chain: number,
  quick: boolean,
  work: (cpus: number) => Promise<void>,
) {
  const exclusive = loaded.exclusive.filter((group) => group.includes(jobId));
  // A quick combination (schedule.ts) starts at once, without waiting for --jobs or the machine's
  // load; one in an exclusive group still waits for the group.
  if (quick && !exclusive.length) {
    const job = liveJob(jobId);
    if (job.state === "queued") {
      job.state = "running";
      updateStatus();
    }
    await work(availableParallelism());
    return;
  }
  const groups = exclusive.map((_, index) => index);
  const owner = `${runId}/${jobId}`;
  const leases = await new Promise<Lease[]>((start) => {
    waiters.push({ seconds, chain, groups, owner, exclusive, start });
    startWaiters();
  });
  const job = liveJob(jobId);
  readyToAdmit++;
  const turn = admission.then(() =>
    machineLoad.admit(owner, {
      stop: () => cancelled,
      alone: () => admitted === 0,
      waiting: (wait) => {
        const note = waitNote(wait);
        if (job.state === "queued" && job.note !== note) {
          job.note = note;
          updateStatus();
        }
      },
    }),
  );
  admission = turn.catch(() => undefined);
  const load = await turn.finally(() => readyToAdmit--);
  if (load) admitted++;
  if (load && job.state === "queued") {
    job.state = "running";
    job.note = undefined;
    updateStatus();
  }
  try {
    if (load) await work(jobCpus(load, readyToAdmit + 1));
  } finally {
    if (load) admitted--;
    freeSlots++;
    for (const lease of leases) lease.release();
    startWaiters();
  }
}
say(
  `${loaded.slug} ${loaded.file} at ${sha.slice(0, 9)} on ${branch}${deploy ? ", deploying" : ""}, ${Number.isFinite(slots) ? `at most ${slots} jobs at once` : "jobs as the machine's load allows"}` +
    (lastSuccessSha
      ? `; changes since ${single["--since"] ? `${single["--since"]} (${lastSuccessSha.slice(0, 9)})` : `the last successful run ${lastSuccessSha.slice(0, 9)}`}`
      : ""),
);
const running = new Map<string, Promise<void>>();
for (;;) {
  for (const state of jobs.values()) {
    if (state.result || state.running) continue;
    if ([...waitsFor(state)].some((wait) => !jobs.get(wait)!.result)) continue;
    state.running = true;
    // Running once a combination starts.
    liveJob(state.id).state = "queued";
    updateStatus();
    running.set(
      state.id,
      runJob(state)
        .catch((error) => {
          say(`✘ ${state.id}: ${(error as Error).message}`);
          state.result = "failure";
        })
        .finally(() => {
          state.running = false;
          running.delete(state.id);
          Object.assign(liveJob(state.id), {
            state: state.result ?? "cancelled",
            note: state.note,
          });
          updateStatus();
        }),
    );
  }
  if (running.size === 0) break;
  await Promise.race(running.values());
}

const summary = [...jobs.values()].map(
  (state) =>
    `${(state.result ?? "cancelled").padEnd(9)} ${state.job.name && !state.job.name.includes("${{") ? `${state.id} (${state.job.name})` : state.id}${state.note ? ` — ${state.note}` : ""}`,
);
const passed = [...jobs.values()].every((state) => state.result === "success" || state.result === "skipped");
summary.push(`${passed ? "Passed" : "Failed"} in ${clock()}. Logs: ${runDir}`);
for (const job of live.jobs)
  if (job.state === "pending" || job.state === "queued" || job.state === "running") job.state = "cancelled";
// The jobs' temporary directories, as GitHub's runner empties RUNNER_TEMP after a job.
rmSync(join(runDir, "tmp"), { recursive: true, force: true });
live.state = stoppedBy ? "failed" : cancelled ? "cancelled" : passed ? "passed" : "failed";
live.finishedAt = now();
writeStatusNow();
writeFileSync(join(runDir, "summary.txt"), `${summary.join("\n")}\n`);
// The same, for tools: each job's result and why a job was skipped when the runner skipped it.
writeFileSync(
  join(runDir, "results.json"),
  `${JSON.stringify(
    {
      sha,
      branch,
      passed,
      jobs: Object.fromEntries(
        [...jobs.values()].map((state) => [state.id, { result: state.result ?? "cancelled", note: state.note }]),
      ),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`\n${summary.join("\n")}\n`);
// The changes job compares with the last run that did everything a push does, deploys included.
if (passed && deploy && !cancelled)
  writeFileSync(recordPath, `${JSON.stringify({ sha, finishedAt: new Date().toISOString() }, null, 2)}\n`);
process.exitCode = cancelled && !stoppedBy ? 130 : passed ? 0 : 1;
