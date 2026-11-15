import { describe, expect, test } from "bun:test";
import { decideSupersession, isDeploying, type RunConfig, type RunStatus } from "../status";

// a ← b ← c: each commit's ancestors.
const history: Record<string, string[]> = { a: [], b: ["a"], c: ["a", "b"] };
const isAncestor = (ancestor: string, descendant: string) => history[descendant].includes(ancestor);
const all = ["changes", "setup", "backend-tests", "frontend-e2e", "build", "deploy"];
const config = (overrides: Partial<RunConfig>): RunConfig => ({
  sha: "b",
  deploy: false,
  jobs: all,
  matrix: [],
  ...overrides,
});

describe("decideSupersession", () => {
  test("the same run again, or the same on a later commit, replaces the earlier one", () => {
    expect(decideSupersession(config({}), config({}), isAncestor)).toEqual({ supersedes: true });
    expect(decideSupersession(config({ sha: "c" }), config({}), isAncestor)).toEqual({
      supersedes: true,
    });
  });

  test("a wider run replaces a narrower one, but not the other way round", () => {
    const portal = config({ jobs: ["changes", "frontend-e2e"] });
    expect(decideSupersession(config({}), portal, isAncestor)).toEqual({ supersedes: true });
    expect(decideSupersession(portal, config({}), isAncestor).supersedes).toBe(false);
    const shard = config({ jobs: ["changes", "backend-tests"], matrix: ["shard=2"] });
    expect(decideSupersession(config({ jobs: ["changes", "backend-tests"] }), shard, isAncestor)).toEqual({
      supersedes: true,
    });
    expect(decideSupersession(shard, config({ jobs: ["changes", "backend-tests"] }), isAncestor).supersedes).toBe(
      false,
    );
  });

  test("a run on an earlier or unrelated commit, or that doesn't deploy, waits", () => {
    expect(decideSupersession(config({ sha: "a" }), config({}), isAncestor).supersedes).toBe(false);
    expect(decideSupersession(config({}), config({ deploy: true }), isAncestor).supersedes).toBe(false);
    expect(decideSupersession(config({ deploy: true }), config({}), isAncestor)).toEqual({
      supersedes: true,
    });
  });

  test("changes compared from an earlier point cover a later one, and everything covers both", () => {
    expect(decideSupersession(config({ base: "a" }), config({ base: "b" }), isAncestor)).toEqual({
      supersedes: true,
    });
    expect(decideSupersession(config({ base: "b" }), config({ base: "a" }), isAncestor).supersedes).toBe(false);
    expect(decideSupersession(config({}), config({ base: "a" }), isAncestor)).toEqual({
      supersedes: true,
    });
  });

  // A job the newer run skips is unchanged since its base, so it is unchanged on the earlier
  // run's commit too, or that commit is part of the base, which passed.
  test("changes compared from a commit related to an earlier run's cover that run of everything", () => {
    expect(decideSupersession(config({ sha: "c", base: "a" }), config({}), isAncestor)).toEqual({
      supersedes: true,
    });
    expect(decideSupersession(config({ sha: "c", base: "c" }), config({ sha: "a" }), isAncestor)).toEqual({
      supersedes: true,
    });
    // d is on a branch of its own, so neither contains the other.
    const branched = (ancestor: string, descendant: string) =>
      ({ a: [], b: ["a"], c: ["a", "b", "d"], d: ["a"] })[descendant]!.includes(ancestor);
    expect(decideSupersession(config({ sha: "c", base: "d" }), config({}), branched).supersedes).toBe(false);
  });
});

test("a run is deploying only while a job that uses secrets runs under --deploy", () => {
  const run = (deploy: boolean, state: "running" | "success"): RunStatus => ({
    version: 1,
    id: "r",
    pid: 1,
    repository: "o/r",
    workflow: "deploy.yml",
    workflowName: "Deploy",
    workflowFile: "/repo/.github/workflows/deploy.yml",
    workflowPath: ".github/workflows/deploy.yml",
    title: "A change",
    author: "Someone",
    args: [],
    branch: "main",
    event: "push",
    config: config({ deploy }),
    state: "running",
    startedAt: "",
    jobs: [
      {
        id: "setup",
        name: "Checks",
        needs: [],
        state: "running",
        usesSecrets: false,
        combinations: [],
      },
      { id: "deploy", name: "Deploy", needs: [], state, usesSecrets: true, combinations: [] },
    ],
  });
  expect(isDeploying(run(true, "running"))).toBe(true);
  expect(isDeploying(run(true, "success"))).toBe(false);
  expect(isDeploying(run(false, "running"))).toBe(false);
});
