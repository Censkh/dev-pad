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
import { existsSync, writeFileSync } from "node:fs";
export const exclusive = process.env.EXCLUSIVE ? [["slow"]] : [];
export const startFirst = process.env.START_FIRST ? ["quick"] : [];
export const processors = {
  async Hold(step) {
    // Which workspace this run's Hold has, by runner.
    writeFileSync(process.env.RELEASE + ".workspace-" + process.pid, step.workspace);
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
  // Runners the tests start weigh no real load and don't space their starts out, unless a test says.
  process.env.DEVPAD_LOAD_SETTLE_SECONDS = "0";
  process.env.DEVPAD_MAX_CPU_BUSY = "100";
  process.env.DEVPAD_MIN_FREE_MEMORY_GIB = "0";
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
        "--dry-run",
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
      secret: { result: "skipped", note: "uses secrets: dry run" },
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
  "--since sets the commit changes are compared with, --matrix runs only matching combinations in their place, and such a partial run never loads secrets to deploy",
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

test.skipIf(!canRun)(
  "a checkout keeps the preserved untracked paths between runs, in the workspace and its submodules, and cleans the rest",
  () => {
    const root = join(dir, "preserve");
    const source = join(root, "repo");
    const stateDir = join(root, "state");
    const lib = join(root, "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "README"), "lib");
    git(lib, "init", "-q", "-b", "main");
    git(lib, "add", ".");
    git(lib, "commit", "-qm", "lib");
    mkdirSync(join(source, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(source, ".github/workflows/cache.yml"),
      "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v6\n        with:\n          submodules: true\n      - name: Build\n",
    );
    git(source, "init", "-q", "-b", "main");
    git(source, "submodule", "--quiet", "add", lib, "lib");
    git(source, "add", ".");
    git(source, "commit", "-qm", "cache");
    const seen = join(root, "seen.txt");
    // Records which outputs an earlier run left, then leaves all of them again.
    writeFileSync(
      join(root, "cache.ts"),
      `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const outputs = ["target/out", "scratch/out", "lib/target/out", "lib/scratch/out"];
export const preserve = ["target", "lib/target"];
export const processors = {
  async Build(step) {
    appendFileSync(${JSON.stringify(seen)}, outputs.filter((path) => existsSync(join(step.workspace, path))).join(",") + "\\n");
    for (const path of outputs) {
      mkdirSync(join(step.workspace, path, ".."), { recursive: true });
      writeFileSync(join(step.workspace, path), "built");
    }
  },
};
`,
    );
    const run = () =>
      Bun.spawnSync(
        [
          "bun",
          runner,
          join(source, ".github/workflows/cache.yml"),
          "--processors",
          join(root, "cache.ts"),
          "--state",
          stateDir,
          // The second run checks out again, rather than reusing the first's result.
          "--fresh",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    expect(run().exitCode).toBe(0);
    expect(run().exitCode).toBe(0);
    expect(
      readFileSync(seen, "utf8")
        .split("\n")
        .filter((line, index) => line || index === 0),
    ).toEqual(["", "target/out,lib/target/out"]);
  },
  60_000,
);

test.skipIf(!canRun)("--check rejects a preserved path that isn't a plain path inside the workspace", () => {
  writeFileSync(
    join(dir, "bad-preserve.ts"),
    `export const preserve = ["../outside", "target/*"];
export const processors = {};`,
  );
  const result = Bun.spawnSync(
    ["bun", runner, "--check", join(repo, ".github/workflows/fast.yml"), "--processors", join(dir, "bad-preserve.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const errors = result.stderr.toString();
  expect(result.exitCode).toBe(1);
  expect(errors).toContain("preserved path '../outside'");
  expect(errors).toContain("preserved path 'target/*'");
});

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

test.skipIf(!canRun)(
  "a job an earlier run passed with the same inputs is reused, with its outputs and artifacts",
  () => {
    const reuseState = join(dir, "state-reuse");
    const markers = join(reuseState, "probe/probe/main/markers");
    const run = (...extra: string[]) => {
      rmSync(markers, { recursive: true, force: true });
      mkdirSync(markers, { recursive: true });
      Bun.spawnSync(
        [
          "bun",
          runner,
          join(repo, ".github/workflows/probe.yml"),
          "--processors",
          join(dir, "processors.ts"),
          "--state",
          reuseState,
          "--no-fail-fast",
          "--dry-run",
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const runs = join(reuseState, "probe/probe/main/runs");
      const latest = readdirSync(runs).sort().at(-1)!;
      return {
        jobs: JSON.parse(readFileSync(join(runs, latest, "results.json"), "utf8")).jobs,
        markers: readdirSync(markers).sort(),
      };
    };
    // The first job alone, which records its result.
    // (lib- names the submodule's README, which an earlier test may have updated.)
    expect(run("--job", "first").markers).toEqual(["base-none", expect.stringMatching(/^lib-/)]);
    // Then everything: the first job isn't run again (no lib- or base- marker), yet the second
    // gets its output and its artifact.
    const reused = run();
    expect(reused.jobs.first.result).toBe("success");
    expect(reused.jobs.first.note).toMatch(/^reused from /);
    expect(reused.markers).toEqual(["after-failure", "use-1-made-hello-1of2", "use-2-made-hello-2of2"]);
    // A failed job is never reused, and --fresh runs everything again.
    expect(reused.jobs.failing.result).toBe("failure");
    expect(run("--fresh").markers).toEqual([
      "after-failure",
      "base-none",
      expect.stringMatching(/^lib-/),
      "use-1-made-hello-1of2",
      "use-2-made-hello-2of2",
    ]);
  },
  120_000,
);

test.skipIf(!canRun)(
  "a job that read the run's base is reused only with the same base, and one that didn't with any",
  () => {
    const reuseState = join(dir, "state-reuse-base");
    const markers = join(reuseState, "probe/probe/main/markers");
    const run = (...extra: string[]) => {
      rmSync(markers, { recursive: true, force: true });
      mkdirSync(markers, { recursive: true });
      Bun.spawnSync(
        [
          "bun",
          runner,
          join(repo, ".github/workflows/probe.yml"),
          "--processors",
          join(dir, "processors.ts"),
          "--state",
          reuseState,
          "--no-fail-fast",
          "--dry-run",
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      return readdirSync(markers).sort();
    };
    run();
    // The first job's Make reads the base (its base- marker): against another base it runs again,
    // while the second job, which doesn't, has the same needs and is reused.
    const markersSince = run("--since", "HEAD");
    expect(markersSince.filter((name) => name.startsWith("base-"))).toEqual([
      expect.stringMatching(/^base-[0-9a-f]{7}$/),
    ]);
    expect(markersSince.filter((name) => name.startsWith("use-"))).toEqual([]);
  },
  120_000,
);

test.skipIf(!canRun)(
  "a secret the processors module provides is read up front, and again before a step once it is old",
  () => {
    const root = mkdtempSync(join(tmpdir(), "secret-env-"));
    const source = join(root, "repo");
    mkdirSync(join(source, ".github/workflows"), { recursive: true });
    // Each step of the deploying job reads the token; the provider hands out a new one each time.
    writeFileSync(
      join(source, ".github/workflows/token.yml"),
      `
jobs:
  publish:
    steps:
      - name: First
        env:
          TOKEN: \${{ secrets.TOKEN }}
      - name: Second
        env:
          TOKEN: \${{ secrets.TOKEN }}
`,
    );
    const seen = join(root, "seen");
    writeFileSync(
      join(root, "token.ts"),
      `import { appendFileSync } from "node:fs";
let reads = 0;
export const env = { TOKEN: { read: async () => \`token-\${++reads}\`, refreshSeconds: 0 } };
const note = (step) => appendFileSync(${JSON.stringify(seen)}, step.env.TOKEN + "\\n");
export const processors = { First: note, Second: note };`,
    );
    git(source, "init", "-q", "-b", "main");
    git(source, "add", ".");
    git(source, "commit", "-qm", "token");
    const result = Bun.spawnSync(
      [
        "bun",
        runner,
        join(source, ".github/workflows/token.yml"),
        "--processors",
        join(root, "token.ts"),
        "--state",
        join(root, "state"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    // Read up front (token-1), then again before each step, as its value was already old.
    expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual(["token-2", "token-3"]);
    rmSync(root, { recursive: true, force: true });
  },
  60_000,
);

test.skipIf(!canRun)("--check rejects a provided secret no step reads", () => {
  writeFileSync(
    join(dir, "stray-env.ts"),
    `export const env = { NOBODY: () => "x" };
export const processors = { Hold: async () => {}, Quick: async () => {} };`,
  );
  const result = Bun.spawnSync(
    ["bun", runner, "--check", join(repo, ".github/workflows/turns.yml"), "--processors", join(dir, "stray-env.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("env provides 'NOBODY'");
});

describe.skipIf(!canRun)("runs going at once", () => {
  // busy: the machine's CPUs always count as busier than the limit, so only a run's first
  // combination starts while another of its own runs.
  const start = (
    stateDir: string,
    release: string,
    extra: string[] = [],
    exclusive = false,
    busy = false,
    startFirst = false,
  ) =>
    Bun.spawn(
      [
        "bun",
        runner,
        join(repo, ".github/workflows/turns.yml"),
        "--processors",
        join(dir, "turns.ts"),
        "--state",
        stateDir,
        // Load gate, exclusive groups and ports of their own, not the machine's real ones.
        "--tool-cache",
        join(release, "..", `${release.split("/").pop()}-tools`),
        ...extra,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          RELEASE: release,
          EXCLUSIVE: exclusive ? "1" : "",
          ...(busy ? { DEVPAD_MAX_CPU_BUSY: "0" } : {}),
          START_FIRST: startFirst ? "1" : "",
        },
      },
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
  const slowCombination = (status: Live | undefined) =>
    (
      status as unknown as {
        jobs?: {
          id: string;
          combinations: { startedAt?: string; finishedAt?: string; steps: { name: string; state: string }[] }[];
        }[];
      }
    )?.jobs?.find((job) => job.id === "slow")?.combinations[0];
  const holding = (status: Live | undefined) =>
    slowCombination(status)?.steps.find((step) => step.name === "Hold")?.state === "running";
  const holdingRuns = (stateDir: string) => {
    const held = statuses(stateDir).filter(holding);
    return held.length ? held : undefined;
  };
  const workspaces = (release: string) =>
    readdirSync(join(release, ".."))
      .filter((name) => name.startsWith(`${release.split("/").pop()}.workspace-`))
      .map((name) => readFileSync(join(release, "..", name), "utf8"));

  test("a run that does everything an earlier one would cancels it", async () => {
    const stateDir = join(dir, "turns-supersede");
    const release = join(dir, "release-supersede");
    const older = start(stateDir, release, ["--dry-run"]);
    const [first] = await until(() => holdingRuns(stateDir));
    const newer = start(stateDir, release, ["--dry-run"]);
    await older.exited;
    writeFileSync(release, "");
    await newer.exited;
    const [olderStatus, newerStatus] = statuses(stateDir);
    expect(olderStatus.id).toBe(first.id);
    expect(olderStatus.state).toBe("cancelled");
    expect(olderStatus.supersededBy).toBe(newerStatus.id);
    expect(newerStatus.state).toBe("passed");
  }, 60_000);

  test("a run whose work an earlier one already does stops, absorbed by it", async () => {
    const stateDir = join(dir, "turns-absorb");
    const release = join(dir, "release-absorb");
    const older = start(stateDir, release, ["--dry-run"]);
    const [first] = await until(() => holdingRuns(stateDir));
    const newer = start(stateDir, release, ["--job", "slow"]);
    expect(await newer.exited).toBe(130);
    const absorbed = statuses(stateDir)[1];
    expect(absorbed.state).toBe("cancelled");
    expect(absorbed.supersededBy).toBe(first.id);
    expect(slowCombination(absorbed)).toBeUndefined();
    writeFileSync(release, "");
    await older.exited;
    expect(statuses(stateDir)[0].state).toBe("passed");
  }, 60_000);

  // A commit on a branch of its own: neither it nor the main branch's commit contains the other, so
  // neither run covers the other's work.
  const sibling = () => {
    const tree = git(repo, "rev-parse", "HEAD^{tree}").stdout.toString().trim();
    const commit = git(repo, "commit-tree", tree, "-m", "sibling").stdout.toString().trim();
    git(repo, "branch", "-f", "sibling", commit);
    return commit;
  };

  test("a run that neither covers nor is covered goes alongside the earlier one, in a workspace of its own", async () => {
    const stateDir = join(dir, "turns-alongside");
    const release = join(dir, "release-alongside");
    const older = start(stateDir, release, ["--dry-run"]);
    await until(() => holdingRuns(stateDir));
    const newer = start(stateDir, release, ["--job", "slow", "--ref", sibling()]);
    // Both hold at once.
    const both = await until(() => {
      const held = holdingRuns(stateDir);
      return held && held.length === 2 ? held : undefined;
    });
    expect(both.map((status) => status.state)).toEqual(["running", "running"]);
    expect(workspaces(release).sort()).toEqual([
      join(stateDir, "probe/turns/main/workspaces/slow"),
      join(stateDir, "probe/turns/main/workspaces/slow.2"),
    ]);
    writeFileSync(release, "");
    await Promise.all([older.exited, newer.exited]);
    expect(statuses(stateDir).map((status) => status.state)).toEqual(["passed", "passed"]);
    // Neither workspace is held once its run is over.
    expect(
      readdirSync(join(stateDir, "probe/turns/main/workspaces")).filter((name) => name.endsWith(".lease")),
    ).toEqual([]);
  }, 60_000);

  test("a job waiting for the machine's load is queued, saying why, and starts once its run's other job ends", async () => {
    const release = join(dir, "release-load");
    const stateDir = join(dir, "turns-load");
    const run = start(stateDir, release, ["--dry-run"], false, true);
    type Jobs = { jobs?: { id: string; state: string; note?: string }[] };
    // Neither job is timed, so the slow one, first in the workflow, starts first and the quick
    // one waits behind it for the busy CPUs.
    const queued = await until(() =>
      (statuses(stateDir)[0] as unknown as Jobs)?.jobs?.find((job) => job.id === "quick" && job.note),
    );
    expect(queued.state).toBe("queued");
    expect(queued.note).toMatch(/^CPU \d+% busy$/);
    writeFileSync(release, "");
    expect(await run.exited).toBe(0);
    const quick = (statuses(stateDir)[0] as unknown as Jobs).jobs!.find((job) => job.id === "quick")!;
    expect(quick.state).toBe("success");
    expect(quick.note).toBeUndefined();
  }, 60_000);

  test("a job that has reliably taken seconds starts without waiting for the machine's load", async () => {
    const release = join(dir, "release-quick");
    const quickState = join(dir, "turns-quick");
    // Three runs time the quick job on its own.
    for (let run = 0; run < 3; run++) expect(await start(quickState, release, ["--job", "quick"]).exited).toBe(0);
    // The slow job holds and the CPUs count as busy, but the quick job doesn't wait.
    const run = start(quickState, release, ["--dry-run"], false, true);
    type Jobs = { jobs?: { id: string; state: string }[] };
    const state = (status: Jobs, id: string) => status.jobs?.find((job) => job.id === id)?.state;
    // The run whose slow job holds, once its quick job is done.
    const holding = await until(() =>
      (statuses(quickState) as unknown as Jobs[]).find(
        (status) =>
          state(status, "slow") === "running" &&
          state(status, "quick") !== "queued" &&
          state(status, "quick") !== "running",
      ),
    );
    expect(state(holding, "quick")).toBe("success");
    writeFileSync(release, "");
    expect(await run.exited).toBe(0);
  }, 60_000);

  test("a start-first job starts without waiting for the machine's load, though never timed", async () => {
    const release = join(dir, "release-start-first");
    const stateDir = join(dir, "turns-start-first");
    // The slow job holds and the CPUs count as busy: without startFirst the quick job would queue
    // behind it (the test above), but it runs and finishes while the slow job still holds.
    const run = start(stateDir, release, ["--dry-run"], false, true, true);
    type Jobs = { jobs?: { id: string; state: string }[] };
    const state = (status: Jobs, id: string) => status.jobs?.find((job) => job.id === id)?.state;
    const holding = await until(() =>
      (statuses(stateDir) as unknown as Jobs[]).find(
        (status) => state(status, "slow") === "running" && state(status, "quick") === "success",
      ),
    );
    expect(state(holding, "quick")).toBe("success");
    writeFileSync(release, "");
    expect(await run.exited).toBe(0);
  }, 60_000);

  test("an exclusive group holds across runs, even with state of their own", async () => {
    const release = join(dir, "release-exclusive");
    const olderState = join(dir, "turns-exclusive-a");
    const newerState = join(dir, "turns-exclusive-b");
    const older = start(olderState, release, ["--dry-run"], true);
    await until(() => holdingRuns(olderState));
    const newer = start(newerState, release, ["--dry-run"], true);
    // The newer run gets going (its quick job passes) but its slow job waits for the group.
    await until(() =>
      statuses(newerState)
        .flatMap((status) => (status as unknown as { jobs: { id: string; state: string }[] }).jobs ?? [])
        .find((job) => job.id === "quick" && job.state === "success"),
    );
    await Bun.sleep(1500);
    expect(slowCombination(statuses(newerState)[0])).toBeUndefined();
    writeFileSync(release, "");
    await Promise.all([older.exited, newer.exited]);
    const olderSlow = slowCombination(statuses(olderState)[0])!;
    const newerSlow = slowCombination(statuses(newerState)[0])!;
    expect(statuses(newerState)[0].state).toBe("passed");
    expect(Date.parse(newerSlow.startedAt!)).toBeGreaterThanOrEqual(Date.parse(olderSlow.finishedAt!));
  }, 60_000);

  test("complete runs deploy unless they're dry runs, and deploying runs take turns", async () => {
    const stateDir = join(dir, "turns-deploy");
    const release = join(dir, "release-deploy");
    const older = start(stateDir, release);
    const [first] = await until(() => holdingRuns(stateDir));
    const newer = start(stateDir, release, ["--ref", sibling()]);
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
