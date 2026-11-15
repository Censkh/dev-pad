// The parts of a workflow file the runner reads, and the pure logic around them: matrix
// expansion and action names.
import { readFileSync } from "node:fs";
import type { Value } from "./expressions";

export type Step = {
  id?: string;
  name?: string;
  if?: string | boolean;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  shell?: string;
  "working-directory"?: string;
  "timeout-minutes"?: number | string;
  "continue-on-error"?: boolean | string;
};

export type Defaults = { run?: { shell?: string; "working-directory"?: string } };

export type Job = {
  name?: string;
  needs?: string | string[];
  if?: string | boolean;
  "runs-on"?: unknown;
  env?: Record<string, unknown>;
  defaults?: Defaults;
  strategy?: { matrix?: unknown; "fail-fast"?: boolean | string; "max-parallel"?: number };
  outputs?: Record<string, string>;
  steps?: Step[];
  "timeout-minutes"?: number | string;
  "continue-on-error"?: boolean | string;
  permissions?: unknown;
  concurrency?: unknown;
  uses?: string;
  services?: unknown;
  container?: unknown;
};

export type Workflow = {
  name?: string;
  on?: unknown;
  env?: Record<string, unknown>;
  defaults?: Defaults;
  jobs: Record<string, Job>;
};

export function loadWorkflow(path: string, text = readFileSync(path, "utf8")): Workflow {
  const workflow = Bun.YAML.parse(text) as Workflow;
  if (!workflow?.jobs || typeof workflow.jobs !== "object") throw new Error(`${path} has no jobs`);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job.uses) throw new Error(`Job ${id} calls a reusable workflow, which has no local implementation`);
    if (job.services || job.container)
      throw new Error(`Job ${id} uses services or a job container, which have no local implementation`);
  }
  return workflow;
}

/**
 * A job's name without its unevaluated expressions, for a label that covers every matrix
 * combination: "Backend Tests (${{ matrix.shard }}/5)" is "Backend Tests". An expression may hold
 * parentheses of its own, as in `format('{0}/6', matrix.shard)`.
 */
export function jobLabel(job: Job, id: string): string {
  const name = (job.name ?? id)
    .replace(/\s*\([^()]*\$\{\{.*?\}\}[^()]*\)/g, "")
    .replace(/\s*\$\{\{.*?\}\}/g, "")
    .trim();
  return name || id;
}

export function needsOf(job: Job): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

type Combination = Record<string, Value>;

// GitHub's matrix expansion: the cartesian product of the axes, less each `exclude` entry that
// matches, then each `include` entry added to every combination whose original axis values it
// doesn't overwrite, or appended as a combination of its own when it fits none.
export function expandMatrix(matrix: Value | undefined): Combination[] {
  if (matrix === undefined || matrix === null) return [{}];
  if (typeof matrix !== "object" || Array.isArray(matrix)) throw new Error("A matrix must be a mapping");
  const { include, exclude, ...axes } = matrix as Record<string, Value>;
  let combinations: Combination[] = [{}];
  for (const [axis, values] of Object.entries(axes)) {
    if (!Array.isArray(values)) throw new Error(`Matrix axis ${axis} must be a list`);
    combinations = combinations.flatMap((combination) => values.map((value) => ({ ...combination, [axis]: value })));
  }
  const hasAxes = Object.keys(axes).length > 0;
  if (!hasAxes) combinations = [];
  const matches = (combination: Combination, partial: Combination) =>
    Object.entries(partial).every(([key, value]) => JSON.stringify(combination[key]) === JSON.stringify(value));
  if (Array.isArray(exclude))
    combinations = combinations.filter(
      (combination) => !exclude.some((entry) => matches(combination, entry as Combination)),
    );
  // Only the axes' combinations take include entries; one an include entry created doesn't.
  const originals = combinations.map((combination) => ({ ...combination }));
  if (Array.isArray(include)) {
    for (const entry of include as Combination[]) {
      let added = false;
      originals.forEach((original, index) => {
        const combination = combinations[index];
        const overwrites = Object.entries(entry).some(
          ([key, value]) => key in original && JSON.stringify(original[key]) !== JSON.stringify(value),
        );
        if (!overwrites) {
          Object.assign(combination, entry);
          added = true;
        }
      });
      if (!added) combinations.push({ ...entry });
    }
  } else if (include !== undefined) {
    throw new Error("A matrix include must be a list");
  }
  return combinations;
}

// The owner/repository[/path] of a `uses:` reference, without its version.
export function actionName(uses: string): string {
  const at = uses.indexOf("@");
  return (at === -1 ? uses : uses.slice(0, at)).toLowerCase();
}
