import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobCpus, type Load, loadLimits, MachineLoad, type Wait } from "../machine-load";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const loadDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-pad-load-"));
  directories.push(directory);
  return directory;
};
const gib = 1024 ** 3;
const limits = { cpuBusy: 0.75, freeMemory: 4 * gib, settleMs: 0 };
// A machine whose load the test sets; each sample takes a moment, as a real one does.
const machine = (load: Load) => {
  const current = { ...load };
  const sample = async () => {
    await Bun.sleep(5);
    return { ...current };
  };
  return { current, sample };
};
const idle: Load = { cpuBusy: 0.1, freeMemory: 32 * gib, cpus: 16 };

test("a combination starts at once while the CPUs have room and memory is free", async () => {
  const { sample } = machine(idle);
  const load = await new MachineLoad(loadDirectory(), limits, sample, 10).admit("run/build");
  expect(load).toEqual(idle);
});

test("a combination waits while the CPUs are busier than the limit, and starts once they aren't", async () => {
  const { current, sample } = machine({ ...idle, cpuBusy: 0.9 });
  const waits: Wait[] = [];
  const admitted = new MachineLoad(loadDirectory(), limits, sample, 10).admit("run/build", {
    waiting: (wait) => waits.push(wait),
  });
  await Bun.sleep(60);
  expect(waits[0]).toEqual({ reason: "cpu", load: { ...idle, cpuBusy: 0.9 } });
  current.cpuBusy = 0.5;
  expect((await admitted)?.cpuBusy).toBe(0.5);
});

test("a combination waits while less memory is free than the limit keeps", async () => {
  const { current, sample } = machine({ ...idle, freeMemory: 2 * gib });
  const waits: Wait[] = [];
  const admitted = new MachineLoad(loadDirectory(), limits, sample, 10).admit("run/build", {
    waiting: (wait) => waits.push(wait),
  });
  await Bun.sleep(60);
  expect(waits[0]?.reason).toBe("memory");
  current.freeMemory = 8 * gib;
  expect((await admitted)?.freeMemory).toBe(8 * gib);
});

test("starts by runners sharing the directory are spaced by the settle time", async () => {
  const directory = loadDirectory();
  const { sample } = machine(idle);
  const settling = { ...limits, settleMs: 300 };
  await new MachineLoad(directory, settling, sample, 10).admit("run-1/build");
  const first = Date.now();
  const waits: Wait[] = [];
  // Another runner's view of the same machine.
  await new MachineLoad(directory, settling, sample, 10).admit("run-2/test", { waiting: (wait) => waits.push(wait) });
  expect(Date.now() - first).toBeGreaterThanOrEqual(300);
  expect(waits[0]).toEqual({ reason: "settling" });
});

test("a run with nothing of its own running starts its next combination whatever the load", async () => {
  const { sample } = machine({ ...idle, cpuBusy: 1, freeMemory: 0 });
  const load = await new MachineLoad(loadDirectory(), limits, sample, 10).admit("run/build", { alone: () => true });
  expect(load?.cpuBusy).toBe(1);
});

test("a waiting combination gives up when told to stop", async () => {
  const { sample } = machine({ ...idle, cpuBusy: 1 });
  let stop = false;
  const admitted = new MachineLoad(loadDirectory(), limits, sample, 10).admit("run/build", { stop: () => stop });
  await Bun.sleep(30);
  stop = true;
  expect(await admitted).toBeUndefined();
});

test("a combination's CPUs are the idle ones, shared with the run's others starting with it, and at least one", () => {
  expect(jobCpus({ ...idle, cpuBusy: 0.25 }, 3)).toBe(4);
  expect(jobCpus({ ...idle, cpuBusy: 0 }, 1)).toBe(16);
  expect(jobCpus({ ...idle, cpuBusy: 1 }, 1)).toBe(1);
});

test("the limits come from the environment, and a negative one is refused", () => {
  expect(
    loadLimits({ DEVPAD_MAX_CPU_BUSY: "60", DEVPAD_MIN_FREE_MEMORY_GIB: "2", DEVPAD_LOAD_SETTLE_SECONDS: "5" }),
  ).toEqual({ cpuBusy: 0.6, freeMemory: 2 * gib, settleMs: 5000 });
  expect(() => loadLimits({ DEVPAD_LOAD_SETTLE_SECONDS: "-1" })).toThrow("DEVPAD_LOAD_SETTLE_SECONDS");
});
