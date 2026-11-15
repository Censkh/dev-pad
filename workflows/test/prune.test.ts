import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneCacheEntries, pruneState } from "../prune";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-15T12:00:00Z");
let root: string;
let stateDir: string;

const touch = (path: string, ageDays: number) => {
  const time = new Date(now - ageDays * DAY);
  utimesSync(path, time, time);
};
// A finished run with a log, artifacts and a job temporary directory.
function run(dir: string, name: string, state = "passed", pid = 999_999_999) {
  const runDir = join(dir, "runs", name);
  mkdirSync(join(runDir, "artifacts", "bundles"), { recursive: true });
  mkdirSync(join(runDir, "tmp", "job"), { recursive: true });
  writeFileSync(join(runDir, "job.log"), "log");
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ state, pid }));
  return runDir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prune-"));
  stateDir = join(root, "CalmLens", "deploy", "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("keeps the newest runs, artifacts only for the newest few, and no finished run's temp", () => {
  for (let i = 1; i <= 6; i++) run(stateDir, `2026-11-1${i}T00-00-00-000Z-abc`);
  const removed = pruneState({ stateDir, keepRuns: 4, keepArtifacts: 2, maxIdleDays: 7, now });
  const runs = readdirSync(join(stateDir, "runs")).sort();
  expect(runs).toEqual([
    "2026-11-13T00-00-00-000Z-abc",
    "2026-11-14T00-00-00-000Z-abc",
    "2026-11-15T00-00-00-000Z-abc",
    "2026-11-16T00-00-00-000Z-abc",
  ]);
  expect(removed.runs.sort()).toEqual(["2026-11-11T00-00-00-000Z-abc", "2026-11-12T00-00-00-000Z-abc"]);
  expect(runs.map((name) => existsSync(join(stateDir, "runs", name, "artifacts")))).toEqual([false, false, true, true]);
  expect(runs.some((name) => existsSync(join(stateDir, "runs", name, "tmp")))).toBe(false);
  expect(runs.every((name) => existsSync(join(stateDir, "runs", name, "job.log")))).toBe(true);
});

test("never touches the pruning run or one still running", () => {
  const current = run(stateDir, "2026-11-01T00-00-00-000Z-current");
  const running = run(stateDir, "2026-11-02T00-00-00-000Z-running", "running", process.pid);
  run(stateDir, "2026-11-03T00-00-00-000Z-newer");
  pruneState({
    stateDir,
    keepRuns: 1,
    keepArtifacts: 0,
    maxIdleDays: 7,
    keep: ["2026-11-01T00-00-00-000Z-current"],
    now,
  });
  expect(existsSync(join(current, "tmp"))).toBe(true);
  expect(existsSync(join(running, "artifacts"))).toBe(true);
  expect(existsSync(join(running, "tmp"))).toBe(true);
});

test("removes workspaces idle for longer than the limit", () => {
  for (const [name, age] of [
    ["used", 1],
    ["idle", 9],
  ] as const) {
    mkdirSync(join(stateDir, "workspaces", name, "node_modules"), { recursive: true });
    touch(join(stateDir, "workspaces", name), age);
  }
  const removed = pruneState({ stateDir, keepRuns: 20, keepArtifacts: 5, maxIdleDays: 7, now });
  expect(removed.workspaces).toEqual(["idle"]);
  expect(readdirSync(join(stateDir, "workspaces"))).toEqual(["used"]);
});

test("removes another branch's idle state, but not while it has a live run", () => {
  const idle = join(root, "CalmLens", "deploy", "perf");
  const busy = join(root, "CalmLens", "deploy", "dev");
  touch(run(idle, "2026-11-01T00-00-00-000Z-old"), 10);
  touch(idle, 10);
  touch(run(busy, "2026-11-01T00-00-00-000Z-old", "running", process.pid), 10);
  touch(busy, 10);
  mkdirSync(stateDir, { recursive: true });
  const removed = pruneState({ stateDir, keepRuns: 20, keepArtifacts: 5, maxIdleDays: 7, now });
  expect(removed.branches).toEqual(["perf"]);
  expect(existsSync(idle)).toBe(false);
  expect(existsSync(busy)).toBe(true);
});

test("removes cache entries unused for longer than the limit", () => {
  const cache = join(root, "sdk-javascript");
  for (const [name, age] of [
    ["fresh", 2],
    ["stale", 20],
  ] as const) {
    mkdirSync(join(cache, name), { recursive: true });
    touch(join(cache, name), age);
  }
  expect(pruneCacheEntries(cache, 14, now)).toEqual(["stale"]);
  expect(readdirSync(cache)).toEqual(["fresh"]);
});
