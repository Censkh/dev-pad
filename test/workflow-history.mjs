import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatAgo, formatDuration, jobDuration } from "../dist/durations.js";
import { localWorkflowRuns, runOptions } from "../dist/workflow-history.js";

test("local runs include a run still going from the command line, but not one whose runner died", async () => {
  const repository = await mkdtemp(join(tmpdir(), "dev-pad-history-"));
  // A process that ended, so its pid names no runner.
  const ended = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => ended.on("exit", resolve));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    await mkdir(join(repository, ".github/workflows"), { recursive: true });
    await writeFile(join(repository, ".github/workflows/deploy.yml"), "name: Deploy\n");
    const runs = join(repository, ".local/workflows/Owner/deploy/main/runs");
    const save = async (id, state, pid) => {
      await mkdir(join(runs, id), { recursive: true });
      const status = {
        version: 1,
        id,
        pid,
        workflowPath: ".github/workflows/deploy.yml",
        branch: "main",
        state,
        startedAt: `2026-01-01T00:00:0${id.at(-1)}.000Z`,
        args: [".github/workflows/deploy.yml"],
        config: { deploy: false },
        jobs: [
          { id: "checks", name: "Checks", state: "running", combinations: [{ key: "checks", log: "checks.log" }] },
        ],
      };
      await writeFile(join(runs, id, "status.json"), JSON.stringify(status));
    };
    await save("run-1", "passed", ended.pid);
    await save("run-2", "running", ended.pid);
    await save("run-3", "running", process.pid);

    const listed = await localWorkflowRuns(repository, { id: "deploy", file: ".github/workflows/deploy.yml" });
    assert.deepEqual(
      listed.map(({ id, state, pid }) => ({ id, state, pid })),
      [
        { id: "run-3", state: "running", pid: process.pid },
        { id: "run-1", state: "passed", pid: undefined },
      ],
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("the whole workflow's entry lists partial runs no other entry claims, with the jobs they ran", async () => {
  const repository = await mkdtemp(join(tmpdir(), "dev-pad-history-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    await mkdir(join(repository, ".github/workflows"), { recursive: true });
    await writeFile(join(repository, ".github/workflows/deploy.yml"), "name: Deploy\n");
    const runs = join(repository, ".local/workflows/Owner/deploy/main/runs");
    const save = async (id, jobs) => {
      await mkdir(join(runs, id), { recursive: true });
      const status = {
        version: 1,
        id,
        workflowPath: ".github/workflows/deploy.yml",
        branch: "main",
        state: "passed",
        startedAt: `2026-01-01T00:00:0${id.at(-1)}.000Z`,
        args: [".github/workflows/deploy.yml", ...jobs.flatMap((job) => ["--job", job])],
        config: { deploy: false },
        jobs: [],
      };
      await writeFile(join(runs, id, "status.json"), JSON.stringify(status));
    };
    await save("run-1", []);
    await save("run-2", ["tests", "e2e"]);
    await save("run-3", ["checks"]);

    const whole = { id: "deploy", file: ".github/workflows/deploy.yml" };
    const checks = { id: "checks", file: ".github/workflows/deploy.yml", jobs: ["checks"] };
    const entries = [whole, checks];
    const listed = (entry) =>
      localWorkflowRuns(repository, entry, entries).then((saved) => saved.map(({ id, partial }) => ({ id, partial })));
    assert.deepEqual(await listed(whole), [
      { id: "run-2", partial: ["e2e", "tests"] },
      { id: "run-1", partial: undefined },
    ]);
    assert.deepEqual(await listed(checks), [{ id: "run-3", partial: undefined }]);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("a run's options read as words, without the workflow file or the runner's wiring", () => {
  assert.equal(
    runOptions([
      ".github/workflows/deploy.yml",
      "--since",
      "origin/main",
      "--no-fail-fast",
      "--ref",
      "05d5196b7",
      "--state",
      "/repo/.local/workflows",
      "--keychain-service",
      "service",
      "--tool-cache",
      "/cache",
      "--processor-root",
      "/repo/processors",
      "--processors",
      "processors.ts",
      "--stream",
      "--status-events",
      "--job",
      "setup",
      "--job",
      "cockroachdb",
      "--matrix",
      "name=workers",
      "--all",
    ]),
    "jobs setup, cockroachdb · only name=workers · since origin/main · every job · no fail-fast · at 05d5196b7",
  );
});

test("a saved job spans its combinations, and a job still going has no end yet", async () => {
  const repository = await mkdtemp(join(tmpdir(), "dev-pad-history-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    await mkdir(join(repository, ".github/workflows"), { recursive: true });
    await writeFile(join(repository, ".github/workflows/deploy.yml"), "name: Deploy\n");
    const run = join(repository, ".local/workflows/Owner/deploy/main/runs/run-1");
    await mkdir(run, { recursive: true });
    const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
    const combination = (key, startedAt, finishedAt) => ({ key, log: `${key}.log`, startedAt, finishedAt });
    const status = {
      version: 1,
      id: "run-1",
      pid: process.pid,
      workflowPath: ".github/workflows/deploy.yml",
      branch: "main",
      state: "running",
      startedAt: at(0),
      args: [".github/workflows/deploy.yml"],
      config: { deploy: false },
      jobs: [
        {
          id: "tests",
          name: "Tests",
          state: "success",
          needs: [],
          combinations: [combination("tests-1", at(5), at(30)), combination("tests-2", at(3), at(20))],
        },
        {
          id: "e2e",
          name: "E2E",
          state: "running",
          needs: ["tests"],
          combinations: [combination("e2e-1", at(31), at(40)), combination("e2e-2", at(32))],
        },
        { id: "deploy", name: "Deploy", state: "pending", needs: ["e2e"], combinations: [combination("deploy")] },
      ],
    };
    await writeFile(join(run, "status.json"), JSON.stringify(status));

    const [saved] = await localWorkflowRuns(repository, { id: "deploy", file: ".github/workflows/deploy.yml" });
    assert.deepEqual(
      saved.jobs.map(({ id, startedAt, finishedAt }) => ({ id, startedAt, finishedAt })),
      [
        { id: "tests", startedAt: at(3), finishedAt: at(30) },
        { id: "e2e", startedAt: at(31), finishedAt: undefined },
        { id: "deploy", startedAt: undefined, finishedAt: undefined },
      ],
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("durations and run ages read in their largest units", () => {
  const start = Date.UTC(2026, 0, 1);
  assert.equal(jobDuration({ startedAt: new Date(start).toISOString() }, start + 45_000), "45s");
  assert.equal(
    jobDuration({ startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 187_000).toISOString() }),
    "3m 07s",
  );
  assert.equal(formatDuration(2 * 3600_000 + 5 * 60_000), "2h 05m");
  assert.equal(jobDuration({}), undefined);
  assert.equal(formatAgo(start, start + 30_000), "just now");
  assert.equal(formatAgo(start, start + 5 * 60_000), "5m ago");
  assert.equal(formatAgo(start, start + 3 * 86400_000), "3d ago");
});
