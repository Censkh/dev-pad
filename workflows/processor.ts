// What a step processor is given. A workflow's YAML decides which jobs run, in what order, with
// which matrix, env and inputs, and which of their steps run; each step that runs is carried out
// by the processor registered for it, never by executing the step's `run:` text.
import type { Value } from "./expressions";

export type ExecOptions = {
  // Relative to the step's working directory (the job's workspace by default).
  cwd?: string;
  env?: Record<string, string>;
  timeoutMinutes?: number;
  // Settle instead of throwing, returning the exit code.
  allowFailure?: boolean;
};

export type NeedResult = { result: string; outputs: Record<string, string> };

export type RunInfo = {
  // The repository the workflow belongs to (its working tree on this Mac) and the tested commit.
  source: string;
  sha: string;
  branch: string;
  event: string;
  // Whether this run may use secrets and deploy: a complete run without --dry-run.
  deploy: boolean;
  // The commit changes are compared with: --since, else this workflow's last successful deploying
  // run on this branch.
  lastSuccessSha?: string;
  artifacts: string;
  toolCache: string;
  /** Installation root of the DevPad runner. */
  runnerPackage: string;
  /**
   * Untracked paths, relative to the workspace (such as a Cargo `target` directory), that a job's
   * checkout keeps between runs instead of cleaning: caches for tools that invalidate their own
   * output. From the processors module's `preserve` export; a path inside a submodule applies there.
   */
  preserve: string[];
};

export type StepRun = {
  key: string;
  jobId: string;
  inputs: Record<string, Value>;
  input(name: string): string;
  // The workflow's, job's and step's env from the YAML, evaluated, plus what earlier steps exported.
  env: Record<string, string>;
  matrix: Record<string, Value>;
  // The combination's place in its job's matrix (1-based), as a shard number.
  strategy: { jobIndex: number; jobTotal: number };
  needs: Record<string, NeedResult>;
  workspace: string;
  cwd: string;
  temp: string;
  run: RunInfo;
  signal: AbortSignal;
  exec(command: string, args?: string[], options?: ExecOptions): Promise<number>;
  output(command: string, args?: string[], options?: ExecOptions): Promise<string>;
  setOutput(name: string, value: string): void;
  exportEnv(name: string, value: string): void;
  addPath(directory: string): void;
  log(text: string): void;
  // Waits for every job that uploads this artifact in this run (the scheduler starts a job only
  // after those, so this is already true when a processor asks).
  artifactDirectory(name: string): string;
  /**
   * `count` ports nothing listens on, at or above `from`, for servers the step starts: reserved for
   * this job combination until it ends, so combinations running side by side never share them.
   */
  openPorts(count: number, from: number): Promise<number[]>;
};

export type Processor = (step: StepRun) => Promise<unknown>;

// Keys are `<job id>/<step id or name>`, or `<step id or name>` for every job of the workflow.
export type Processors = Record<string, Processor>;

export class StepFailure extends Error {}
