import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard } from "../../dist/index.js";

test.skipIf(!(Bun.which("gtimeout") ?? Bun.which("timeout")))(
  "the dashboard runs and cancels registered workflows and shows their step output",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dev-pad-workflow-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    const workflow = "check.yml";
    const processors = "processors.ts";
    const output = "hello from a workflow step";
    writeFileSync(
      join(cwd, workflow),
      `jobs:
  lint:
    steps:
      - uses: actions/checkout@v6
      - name: Check
        run: exit 1
  build:
    needs: lint
    steps:
      - uses: actions/checkout@v6
      - name: Wait
        run: exit 1
  hosted:
    steps:
      - name: Hosted only
        run: exit 1
`,
    );
    writeFileSync(
      join(cwd, processors),
      `
export const processors = {
  Check: (step) => step.exec("printf", ["%s\\n", ${JSON.stringify(output)}]),
  Wait: async (step) => {
    step.log("ready for cancellation");
    await step.exec("sleep", ["30"]);
  },
};`,
    );
    git("init", "-qb", "main");
    git("add", ".");
    git("-c", "user.name=DevPad Test", "-c", "user.email=devpad@example.com", "commit", "-qm", "Fixture");
    const config = {
      title: "Checks",
      cwd,
      services: [],
      workflows: [
        { id: "lint", file: workflow, processors, jobs: ["lint"] },
        { id: "build", file: workflow, processors, jobs: ["build"] },
      ],
    };
    const dashboard = createDashboard(config);
    const status = (id: string) => dashboard.snapshot().services.find((item) => item.id === id)?.status;
    const hasLog = (message: string) => dashboard.snapshot().logs.some((line) => line.message.includes(message));
    const until = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(50);
      expect(condition()).toBe(true);
    };
    try {
      await dashboard.start();
      expect(status("lint")).toBe("idle");
      expect(dashboard.snapshot().services.find(({ id }) => id === "lint")?.name).toBe(workflow);
      expect(dashboard.snapshot().workflowSummary).toEqual({ status: "idle", stages: [] });
      await dashboard.key("w");
      expect(dashboard.snapshot().workflowView).toBe(true);
      expect(dashboard.snapshot().selectedId).toBe("lint");
      await dashboard.key("r");
      await until(() => status("lint") === "passed");
      expect(hasLog(output)).toBe(true);

      await dashboard.key("2");
      await dashboard.key("r");
      await until(() => hasLog("ready for cancellation"));
      expect(status("build")).toBe("running");
      await until(
        () => dashboard.snapshot().workflowJobs?.some((job) => job.id === "build" && job.state === "running") === true,
      );
      const build = dashboard.snapshot().workflowJobs?.find((job) => job.id === "build");
      expect(build?.needs).toEqual(["lint"]);
      expect(hasLog(output)).toBe(true);
      await dashboard.key("k");
      expect(dashboard.snapshot().selectedJob).toBe("hosted");
      await dashboard.key("k");
      expect(dashboard.snapshot().selectedJob).toBe("build");
      expect(hasLog(output)).toBe(false);
      expect(hasLog("ready for cancellation")).toBe(true);
      await dashboard.key("j");
      expect(dashboard.snapshot().selectedJob).toBe("hosted");
      await dashboard.key("j");
      expect(dashboard.snapshot().selectedJob).toBeUndefined();
      expect(hasLog(output)).toBe(true);
      await dashboard.key("j");
      expect(dashboard.snapshot().selectedJob).toBe("lint");
      expect(hasLog("ready for cancellation")).toBe(false);
      await dashboard.key("w");
      expect(dashboard.snapshot().workflowView).toBe(false);
      await until(() => dashboard.snapshot().workflowSummary?.stages.includes("Wait") === true);
      expect(dashboard.snapshot().workflowSummary).toEqual({ status: "running", stages: ["Wait"] });
      await dashboard.key("w");
      await dashboard.key("2");
      await dashboard.key("q");
      expect(status("build")).toBe("cancelled");
      expect(dashboard.snapshot().workflowSummary).toEqual({ status: "cancelled", stages: [] });
      expect(status("lint")).toBe("passed");

      const reopened = createDashboard(config);
      try {
        await reopened.start();
        expect(reopened.snapshot().workflowSummary).toEqual({ status: "cancelled", stages: [] });
        await reopened.key("w");
        expect(reopened.snapshot().workflowJobs?.find((job) => job.id === "lint")?.state).toBe("success");
        expect(reopened.snapshot().logs.some((line) => line.message.includes(output))).toBe(true);
        await reopened.key("2");
        expect(reopened.snapshot().workflowJobs?.find((job) => job.id === "build")?.needs).toEqual(["lint"]);
        await reopened.key("job:build");
        const messages = reopened.snapshot().logs.map((line) => line.message);
        expect(messages.some((message) => message.includes("ready for cancellation"))).toBe(true);
        expect(messages.some((message) => message.includes(output))).toBe(false);
      } finally {
        await reopened.shutdown();
      }
    } finally {
      await dashboard.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  25_000,
);

test.skipIf(!(Bun.which("gtimeout") ?? Bun.which("timeout")))(
  "deploy is explicit and runs jobs excluded from local checks",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dev-pad-deploy-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    writeFileSync(
      join(cwd, "deploy.yml"),
      `jobs:
  check:
    steps:
      - name: Check
        run: exit 1
  publish:
    needs: check
    steps:
      - name: Publish
        run: exit 1
`,
    );
    const marker = join(cwd, "published-locally");
    writeFileSync(
      join(cwd, "processors.ts"),
      `
import { writeFileSync } from "node:fs";
export const deployJobs = ["publish"];
export const processors = {
  Check: async () => {},
  Publish: async () => writeFileSync(${JSON.stringify(marker)}, "published"),
};`,
    );
    git("init", "-qb", "main");
    git("add", ".");
    git("-c", "user.name=DevPad Test", "-c", "user.email=devpad@example.com", "commit", "-qm", "Fixture");
    const dashboard = createDashboard({
      title: "Deploy",
      cwd,
      services: [],
      workflows: [{ id: "deploy", file: "deploy.yml", processors: "processors.ts", deployment: {} }],
    });
    const waitPassed = async () => {
      const passed = () => dashboard.snapshot().services[0].status === "passed";
      for (let attempt = 0; attempt < 200 && !passed(); attempt++) await Bun.sleep(50);
      expect(passed()).toBe(true);
    };
    try {
      await dashboard.start();
      await dashboard.key("1");
      await dashboard.key("r");
      await waitPassed();
      expect(await Bun.file(marker).exists()).toBe(false);
      await dashboard.key("d");
      await waitPassed();
      expect(await Bun.file(marker).text()).toBe("published");
    } finally {
      await dashboard.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  25_000,
);

test("a run started outside DevPad shows on a workflow that isn't selected and had nothing running", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "dev-pad-new-run-"));
  Bun.spawnSync(["git", "init", "-qb", "main"], { cwd });
  for (const name of ["first", "second"]) writeFileSync(join(cwd, `${name}.yml`), "jobs: {}\n");
  const dashboard = createDashboard({
    title: "New runs",
    cwd,
    services: [],
    workflows: [
      { id: "first", file: "first.yml" },
      { id: "second", file: "second.yml" },
    ],
  });
  try {
    await dashboard.start();
    await dashboard.key("1");
    const second = () => dashboard.snapshot().services.find((service) => service.id === "second")!;
    expect(second().workflowSource).toBeUndefined();
    // As a command-line runner writes it: a new run directory with its status file.
    const run = join(cwd, ".local/workflows/Owner/second/main/runs/run-1");
    mkdirSync(run, { recursive: true });
    writeFileSync(
      join(run, "status.json"),
      JSON.stringify({
        version: 1,
        id: "run-1",
        workflowPath: "second.yml",
        branch: "main",
        state: "passed",
        startedAt: new Date().toISOString(),
        args: ["second.yml"],
        config: { deploy: false },
        jobs: [],
      }),
    );
    for (let attempt = 0; attempt < 60 && second().workflowSource !== "Local"; attempt++) {
      await dashboard.health();
      await Bun.sleep(100);
    }
    expect(second().workflowSource).toBe("Local");
    expect(second().status).toBe("passed");
  } finally {
    await dashboard.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform === "win32")("merges hosted and local history and opens the newest run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "dev-pad-merged-runs-"));
  const path = process.env.PATH;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-qb", "main");
  git("remote", "add", "origin", "https://github.com/fixture/project.git");
  const workflowPath = ".github/workflows/deploy.yml";
  mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
  writeFileSync(join(cwd, workflowPath), `name: "Deploy: production"\njobs: {}\n`);
  const runDir = join(cwd, ".local/workflows/project/deploy/main/runs/local-fixture");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "checks.log"), "local output\n");
  writeFileSync(
    join(runDir, "status.json"),
    JSON.stringify({
      version: 1,
      id: "local-fixture",
      workflowPath,
      branch: "main",
      state: "passed",
      startedAt: "2026-01-01T00:00:00.500Z",
      args: [],
      config: { deploy: false },
      jobs: [
        {
          id: "checks",
          name: "Checks",
          state: "success",
          needs: [],
          combinations: [{ key: "checks", log: "checks.log" }],
        },
      ],
    }),
  );
  writeFileSync(
    join(cwd, "gh"),
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const hostedRunAdded = await Bun.file(process.cwd() + "/hosted-run-added").exists();
const run = (databaseId, startedAt) => ({
  databaseId, workflowDatabaseId: 7, startedAt, number: databaseId, attempt: 1,
  headBranch: "main", headSha: "dd77b33", status: "completed", conclusion: "success",
  url: "https://github.com/fixture/project/actions/runs/" + databaseId
});
if (args[0] === "--version") console.log("gh fixture");
else if (args[0] === "workflow" && args[1] === "list")
  console.log(JSON.stringify([{ id: 7, name: "Deploy", path: ".github/workflows/deploy.yml" }]));
else if (args[0] === "api" && args.includes("repos/{owner}/{repo}/contents/.github/workflows/deploy.yml") && args.includes("ref=dd77b33"))
  console.log(["jobs:", "  build:", "    name: Build", "  test:", "    name: Test", "    needs: build"].join("\\n"));
else if (args[0] === "workflow" && args[1] === "run") {
  await Bun.write(process.cwd() + "/dispatched", JSON.stringify(args));
} else if (args[0] === "run" && args[1] === "list") {
  console.log(JSON.stringify(hostedRunAdded
    ? [run(9, "2026-01-01T00:00:02Z"), run(8, "2026-01-01T00:00:00Z")]
    : [run(8, "2026-01-01T00:00:00Z")]));
} else if (args[0] === "run" && args.includes("--log")) console.log("hosted output " + args[2]);
else if (args[0] === "run" && args[1] === "view")
  console.log(JSON.stringify({ jobs: [
    { databaseId: 21, name: "Build (macOS)", status: "completed", conclusion: "success", steps: [] },
    { databaseId: 22, name: "Build (Linux)", status: "completed", conclusion: "success", steps: [] },
    { databaseId: 23, name: "Test", status: "completed", conclusion: "success", steps: [] },
  ] }));
else process.exit(1);
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${cwd}:${path}`;
  const legacyConfig = { id: "deploy", name: "Legacy override", file: workflowPath, deployment: {} };
  const dashboard = createDashboard({
    title: "Merged runs",
    cwd,
    services: [],
    workflows: [legacyConfig],
  });
  const until = async (predicate: (snapshot: ReturnType<typeof dashboard.snapshot>) => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(dashboard.snapshot()); attempt++) await Bun.sleep(25);
    const snapshot = dashboard.snapshot();
    if (!predicate(snapshot)) throw new Error(JSON.stringify(snapshot));
  };
  try {
    await dashboard.start();
    await dashboard.key("w");
    await until((snapshot) => snapshot.workflowRuns.length === 2);
    expect(dashboard.snapshot().services.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "deploy", name: "Deploy: production" },
    ]);
    expect(dashboard.snapshot().workflowRunId).toBe("local:local-fixture");
    expect(dashboard.snapshot().logs.map(({ message }) => message)).toEqual(["[checks] local output"]);
    await dashboard.key("right");
    await until((snapshot) => snapshot.logs.some(({ message }) => message === "hosted output 8"));
    expect(dashboard.snapshot().workflowRunId).toBe("github:8:1");
    expect(dashboard.snapshot().workflowJobs?.map(({ id, needs }) => ({ id, needs }))).toEqual([
      { id: "21", needs: [] },
      { id: "22", needs: [] },
      { id: "23", needs: ["21", "22"] },
    ]);
    await dashboard.key("left");
    expect(dashboard.snapshot().workflowRunId).toBe("local:local-fixture");
    expect(dashboard.snapshot().logs.map(({ message }) => message)).toEqual(["[checks] local output"]);
    expect(
      dashboard
        .snapshot()
        .actions.map(({ key }) => key)
        .sort(),
    ).toEqual(["d", "f", "r"]);
    await dashboard.key("g");
    expect(await Bun.file(join(cwd, "dispatched")).exists()).toBe(false);
    await Bun.write(join(cwd, "hosted-run-added"), "");
    await dashboard.key("f");
    expect(dashboard.snapshot().workflowRuns.map(({ id }) => id)).toEqual([
      "github:9:1",
      "local:local-fixture",
      "github:8:1",
    ]);
    await dashboard.key("w");
    await dashboard.key("w");
    expect(dashboard.snapshot().workflowRunId).toBe("github:9:1");
    expect(dashboard.snapshot().services[0]?.workflowSource).toBe("GitHub");
  } finally {
    await dashboard.shutdown();
    process.env.PATH = path;
    rmSync(cwd, { recursive: true, force: true });
  }
});
