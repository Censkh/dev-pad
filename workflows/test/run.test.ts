// Runs a small workflow through the runner in a throwaway repository, with processors that leave
// marker files, and checks what ran, in which order and with what.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The runner stops a step's commands through GNU timeout.
const canRun = !!(Bun.which("gtimeout") ?? Bun.which("timeout"));
const runner = resolve(import.meta.dir, "../run.ts");

let dir: string;
let repo: string;
let state: string;
let git: (cwd: string, ...args: string[]) => unknown;

const workflow = `
name: Probe
env:
  GREETING: hello
jobs:
  first:
    outputs:
      value: \${{ steps.make.outputs.value }}
    steps:
      - uses: actions/checkout@v6
        with:
          submodules: true
      - id: make
        name: Make
      - name: Leave Behind
      - name: Upload
        uses: actions/upload-artifact@v4
        with:
          name: thing
          path: out.txt
  second:
    needs: first
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - uses: actions/checkout@v6
      - name: Download
        uses: actions/download-artifact@v4
        with:
          name: thing
          path: downloaded
      - name: Use
        env:
          VALUE: \${{ needs.first.outputs.value }}
      - name: Allowed To Fail
        continue-on-error: true
  pull-request-only:
    if: github.event_name == 'pull_request'
    steps:
      - name: Never
  secret:
    steps:
      - name: Never
        env:
          TOKEN: \${{ secrets.TOKEN }}
  failing:
    needs: first
    steps:
      - name: Fail
      - name: Never
      - name: After Failure
        if: failure()
  after-failing:
    needs: failing
    steps:
      - name: Never
`;

const processors = `
import { join } from "node:path";
const mark = (step, name) => step.exec("/usr/bin/touch", [join(step.temp, "..", "..", "..", "..", "markers", name)]);
export const processors = {
  async make(step) {
    await mark(step, \`lib-\${await step.output("/bin/cat", ["lib/README"])}\`);
    await mark(step, \`base-\${step.run.lastSuccessSha?.slice(0, 7) ?? "none"}\`);
    await step.exec("/bin/sh", ["-c", 'printf %s "$GREETING" > out.txt']);
    step.setOutput("value", "made");
  },
  // A background process the step doesn't wait for, as a test's detached server would be.
  async "first/Leave Behind"(step) {
    await step.exec("/bin/sh", ["-c", 'nohup sleep 300 > /dev/null 2>&1 & echo $! > "$PIDFILE"'], {
      env: { PIDFILE: "__PIDFILE__" },
    });
  },
  async "second/Use"(step) {
    const downloaded = await step.output("/bin/cat", ["downloaded/out.txt"]);
    await mark(step, \`use-\${step.matrix.n}-\${step.env.VALUE}-\${downloaded}-\${step.strategy.jobIndex}of\${step.strategy.jobTotal}\`);
  },
  async "second/Allowed To Fail"(step) {
    await step.exec("/usr/bin/false");
  },
  async Never(step) {
    await mark(step, \`never-\${step.jobId}\`);
  },
  async "failing/Fail"(step) {
    await step.exec("/usr/bin/false");
  },
  async "failing/After Failure"(step) {
    await mark(step, "after-failure");
  },
};
`;

// Two jobs, one of which holds its run until the test creates a release file.
const turnsWorkflow = `
jobs:
  slow:
    steps:
      - name: Hold
  quick:
    steps:
      - name: Quick
`;
// One job fails at once while another holds; a third needs the one that holds.
const fastWorkflow = `
jobs:
  slow:
    steps:
      - name: Hold
  broken:
    steps:
      - name: Break
      - name: On Failure
        if: failure()
  after:
    needs: slow
    steps:
      - name: Quick
`;
const fastProcessors = `
import { existsSync } from "node:fs";
export const processors = {
  async Hold(step) {
    while (!existsSync(process.env.RELEASE)) {
      if (step.signal.aborted) throw new Error("cancelled");
      await Bun.sleep(100);
    }
  },
  async Quick() {},
  async Break(step) {
    await step.exec("/usr/bin/false");
  },
  async "On Failure"(step) {
    await step.exec("/usr/bin/touch", [process.env.RELEASE + ".failure-step"]);
  },
};
`;
const turnsProcessors = `
import { existsSync } from "node:fs";
export const processors = {
  async Hold(step) {
    while (!existsSync(process.env.RELEASE)) {
      if (step.signal.aborted) throw new Error("cancelled");
      await Bun.sleep(100);
    }
  },
  async Quick() {},
};
`;

beforeAll(() => {
  if (!canRun) return;
  dir = mkdtempSync(join(tmpdir(), "local-workflows-"));
  repo = join(dir, "probe");
  state = join(dir, "state");
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/probe.yml"), workflow);
  writeFileSync(join(repo, ".github/workflows/turns.yml"), turnsWorkflow);
  writeFileSync(join(repo, ".github/workflows/fast.yml"), fastWorkflow);
  writeFileSync(join(dir, "turns.ts"), turnsProcessors);
  writeFileSync(join(dir, "fast.ts"), fastProcessors);
  writeFileSync(join(dir, "processors.ts"), processors.replace("__PIDFILE__", join(dir, "orphan.pid")));
  mkdirSync(join(state, "probe/probe/main/markers"), { recursive: true });
  git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], {
      cwd,
    });
  // A submodule whose .gitmodules URL is unreachable: checkout must clone the local copy.
  const lib = join(dir, "lib");
  mkdirSync(lib);
  writeFileSync(join(lib, "README"), "lib");
  git(lib, "init", "-q", "-b", "main");
  git(lib, "add", ".");
  git(lib, "commit", "-qm", "lib");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "submodule", "--quiet", "add", lib, "lib");
  git(repo, "config", "-f", ".gitmodules", "submodule.lib.url", "git@example.invalid:nobody/lib.git");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "probe");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!canRun)(
  "runs the jobs the workflow decides, with each step's processor",
  () => {
    const result = Bun.spawnSync(
      [
        "bun",
        runner,
        join(repo, ".github/workflows/probe.yml"),
        "--processors",
        join(dir, "processors.ts"),
        "--state",
        state,
        "--no-fail-fast",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    // Markers go beside the state, out of the workspaces.
    const markers = existsSync(join(state, "probe/probe/main/markers"))
      ? readdirSync(join(state, "probe/probe/main/markers"))
      : [];
    const runs = join(state, "probe/probe/main/runs");
    const results = JSON.parse(readFileSync(join(runs, readdirSync(runs)[0], "results.json"), "utf8"));

    expect(result.exitCode).toBe(1);
    expect(results.passed).toBe(false);
    expect(results.jobs).toEqual({
      first: { result: "success" },
      second: { result: "success" },
      "pull-request-only": { result: "skipped" },
      secret: { result: "skipped", note: "uses secrets: pass --deploy" },
      failing: { result: "failure" },
      "after-failing": { result: "skipped" },
    });
    // Both matrix combinations got the first job's output, its artifact and their shard position.
    expect(markers.sort()).toEqual([
      "after-failure",
      "base-none",
      "lib-lib",
      "use-1-made-hello-1of2",
      "use-2-made-hello-2of2",
    ]);
    // The process the first job left running was stopped when the job ended.
    const orphan = Number(readFileSync(join(dir, "orphan.pid"), "utf8"));
    expect(orphan).toBeGreaterThan(0);
    expect(() => process.kill(orphan, 0)).toThrow();
  },
  60_000,
);

// Runs after the first test, whose checkout cloned the submodule into the job's workspace.
test.skipIf(!canRun)(
  "a later checkout fetches a new submodule commit from the local copy, whatever the workspace's clone points at",
  () => {
    const lib = join(dir, "lib");
    const workspaceLib = join(state, "probe/probe/main/workspaces/first/lib");
    git(workspaceLib, "remote", "set-url", "origin", "git@example.invalid:nobody/lib.git");
    writeFileSync(join(lib, "README"), "updated");
    git(lib, "commit", "-qam", "update");
    git(join(repo, "lib"), "pull", "-q", lib, "main");
    git(repo, "commit", "-qam", "bump lib");
    Bun.spawnSync(
      [
        "bun",
        runner,
        join(repo, ".github/workflows/probe.yml"),
        "--processors",
        join(dir, "processors.ts"),
        "--state",
        state,
        "--job",
        "first",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(readdirSync(join(state, "probe/probe/main/markers"))).toContain("lib-updated");
  },
  60_000,
);

// Runs after the submodule test, on the probe's second commit.
test.skipIf(!canRun)(
  "--since sets the commit changes are compared with, and --matrix runs only matching combinations in their place",
  () => {
    const markers = join(state, "probe/probe/main/markers");
    rmSync(markers, { recursive: true, force: true });
    mkdirSync(markers);
    const first = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "HEAD"], { cwd: repo }).stdout.toString().trim();
    const result = Bun.spawnSync(
      [
        "bun",
        runner,
        join(repo, ".github/workflows/probe.yml"),
        "--processors",
        join(dir, "processors.ts"),
        "--state",
        state,
        "--job",
        "second",
        "--matrix",
        "n=2",
        "--since",
        first,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(readdirSync(markers).sort()).toEqual([`base-${first.slice(0, 7)}`, "lib-updated", "use-2-made-hello-2of2"]);
  },
  60_000,
);

test.skipIf(!canRun)("--check names steps without a processor and processors without a step", () => {
  writeFileSync(
    join(dir, "partial.ts"),
    `export const processors = { make: async () => {}, "first/Gone": async () => {} };`,
  );
  const result = Bun.spawnSync(
    ["bun", runner, "--check", join(repo, ".github/workflows/probe.yml"), "--processors", join(dir, "partial.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const errors = result.stderr.toString();
  expect(result.exitCode).toBe(1);
  expect(errors).toContain("no local processor for 'Use'");
  expect(errors).toContain("processor 'first/Gone' matches no step");
  expect(errors).not.toContain("'make'");
});

test.skipIf(!canRun)(
  "--check finds a repository's processors in a clone of a local copy, as a job's workspace is",
  () => {
    // This Mac's copy names the repository by its origin; a workspace is cloned from that copy.
    const upstream = join(dir, "upstream");
    mkdirSync(join(upstream, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(upstream, ".github/workflows/deploy.yml"),
      "jobs:\n  app:\n    steps:\n      - name: Check app\n        run: never execute this\n",
    );
    const processors = join(upstream, "scripts/local-workflows/processors/Fixture");
    mkdirSync(processors, { recursive: true });
    writeFileSync(join(processors, "deploy.ts"), 'export const processors = { "Check app": async () => {} };');
    git(upstream, "init", "-q", "-b", "main");
    git(upstream, "remote", "add", "origin", "https://github.com/example/Fixture.git");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "deploy");
    const workspace = join(dir, "workspace");
    git(dir, "clone", "-q", upstream, workspace);
    const result = Bun.spawnSync(["bun", runner, "--check", join(workspace, ".github/workflows/deploy.yml")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stdout.toString()).toContain("Check app: processor Check app");
    expect(result.exitCode).toBe(0);
  },
);

type Live = { id: string; state: string; supersededBy?: string; waitingFor?: { run: string } };
async function until<T>(read: () => T | undefined, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

describe.skipIf(!canRun)("taking turns", () => {
  const start = (stateDir: string, release: string, ...extra: string[]) =>
    Bun.spawn(
      [
        "bun",
        runner,
        join(repo, ".github/workflows/turns.yml"),
        "--processors",
        join(dir, "turns.ts"),
        "--state",
        stateDir,
        ...extra,
      ],
      { stdout: "ignore", stderr: "ignore", env: { ...process.env, RELEASE: release } },
    );
  // The run's own live status, once it has written one in the given state.
  const statuses = (stateDir: string): Live[] => {
    const runs = join(stateDir, "probe/turns/main/runs");
    if (!existsSync(runs)) return [];
    return readdirSync(runs)
      .sort()
      .flatMap((run) => {
        try {
          return [JSON.parse(readFileSync(join(runs, run, "status.json"), "utf8")) as Live];
        } catch {
          return [];
        }
      });
  };
  const holding = (stateDir: string) => {
    const [first] = statuses(stateDir);
    const status = first as unknown as {
      jobs?: { id: string; combinations: { steps: { name: string; state: string }[] }[] }[];
    };
    const hold = status?.jobs
      ?.find((job) => job.id === "slow")
      ?.combinations[0]?.steps.find((step) => step.name === "Hold");
    return hold?.state === "running" ? first : undefined;
  };

  test("a run that does everything an earlier one would cancels it", async () => {
    const stateDir = join(dir, "turns-supersede");
    const release = join(dir, "release-supersede");
    const older = start(stateDir, release);
    const first = await until(() => holding(stateDir));
    const newer = start(stateDir, release);
    await older.exited;
    writeFileSync(release, "");
    await newer.exited;
    const [olderStatus, newerStatus] = statuses(stateDir);
    expect(olderStatus.id).toBe(first.id);
    expect(olderStatus.state).toBe("cancelled");
    expect(olderStatus.supersededBy).toBe(newerStatus.id);
    expect(newerStatus.state).toBe("passed");
  }, 60_000);

  test("a run that does less waits for the earlier one instead", async () => {
    const stateDir = join(dir, "turns-queue");
    const release = join(dir, "release-queue");
    const older = start(stateDir, release);
    const first = await until(() => holding(stateDir));
    const newer = start(stateDir, release, "--job", "quick");
    const waiting = await until(() =>
      // A run is queued before it records what it waits for.
      statuses(stateDir).find((status) => status.state === "queued" && status.waitingFor),
    );
    expect(waiting.waitingFor?.run).toBe(first.id);
    writeFileSync(release, "");
    await Promise.all([older.exited, newer.exited]);
    const [olderStatus, newerStatus] = statuses(stateDir);
    expect(olderStatus.state).toBe("passed");
    expect(newerStatus.state).toBe("passed");
  }, 60_000);
});

describe.skipIf(!canRun)("failing fast", () => {
  test("the first failing step stops the run: running jobs are cancelled and the rest never start", async () => {
    const stateDir = join(dir, "fast");
    // Never created, so Hold would wait out its timeout unless the run stops it.
    const release = join(dir, "release-fast");
    const started = Date.now();
    const result = Bun.spawnSync(
      [
        "bun",
        runner,
        join(repo, ".github/workflows/fast.yml"),
        "--processors",
        join(dir, "fast.ts"),
        "--state",
        stateDir,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, RELEASE: release } },
    );
    const runs = join(stateDir, "probe/fast/main/runs");
    const results = JSON.parse(readFileSync(join(runs, readdirSync(runs)[0], "results.json"), "utf8"));
    expect(result.exitCode).toBe(1);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(results.jobs.broken.result).toBe("failure");
    expect(results.jobs.slow.result).toBe("cancelled");
    expect(results.jobs.after.result).toBe("cancelled");
    // The failing job's own failure() step still ran.
    expect(existsSync(`${release}.failure-step`)).toBe(true);
  }, 30_000);
});
