import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MachineSlots } from "../machine-slots";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const slotsDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-pad-slots-"));
  directories.push(directory);
  return directory;
};
// A pid no process has, as a killed runner leaves behind.
const deadPid = async () => {
  const child = Bun.spawn([process.execPath, "-e", ""]);
  await child.exited;
  return child.pid;
};

test("runners sharing the directory never hold more slots than it has", async () => {
  const directory = slotsDirectory();
  // Two runners' views of the same slots.
  const first = new MachineSlots(directory, 1, 20);
  const second = new MachineSlots(directory, 1, 20);
  const release = await first.acquire("run-1/build");
  let waited = false;
  const next = second.acquire("run-2/test").then((done) => {
    waited = true;
    return done;
  });
  await Bun.sleep(150);
  expect(waited).toBe(false);
  release!();
  const releaseNext = await next;
  expect(waited).toBe(true);
  releaseNext!();
  expect(readdirSync(directory)).toEqual([]);
});

test("a runner waiting for a slot hears who holds them, leaving out a holder that died", async () => {
  const directory = slotsDirectory();
  writeFileSync(join(directory, "slot-1"), JSON.stringify({ pid: await deadPid(), owner: "killed/run" }));
  const first = new MachineSlots(directory, 2, 20);
  const release = await first.acquire("run-1/build");
  // The dead holder's slot is the other one, so the first runner takes it too.
  const releaseSecond = await first.acquire("run-1/test");
  const heard: string[][] = [];
  let stop = false;
  const waiting = new MachineSlots(directory, 2, 20).acquire(
    "run-2/build",
    () => stop,
    (holders) => {
      heard.push(holders.map(({ owner }) => owner).sort());
      stop = true;
    },
  );
  expect(await waiting).toBeUndefined();
  expect(heard).toEqual([["run-1/build", "run-1/test"]]);
  release!();
  releaseSecond!();
});

test("a slot whose holder died is taken over", async () => {
  const directory = slotsDirectory();
  writeFileSync(join(directory, "slot-0"), JSON.stringify({ pid: await deadPid(), owner: "killed/run" }));
  const release = await new MachineSlots(directory, 1, 20).acquire("run-1/build", () => false);
  expect(release).toBeFunction();
  release!();
});

test("a runner killed while holding a slot doesn't keep it", async () => {
  const directory = slotsDirectory();
  const module = resolve(import.meta.dir, "../machine-slots.ts");
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { MachineSlots } = await import(${JSON.stringify(module)});
       await new MachineSlots(${JSON.stringify(directory)}, 1).acquire("held/run");
       console.log("held");
       await Bun.sleep(60_000);`,
    ],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
  holder.kill("SIGKILL");
  await holder.exited;
  // Its slot file is still there, but nothing holds it.
  expect(existsSync(join(directory, "slot-0"))).toBe(true);
  const release = await new MachineSlots(directory, 1, 20).acquire("run-1/build");
  expect(release).toBeFunction();
  release!();
});

test("stops waiting when told to", async () => {
  const directory = slotsDirectory();
  const slots = new MachineSlots(directory, 1, 20);
  const release = await slots.acquire("run-1/build");
  let stop = false;
  const waiting = slots.acquire("run-1/test", () => stop);
  stop = true;
  expect(await waiting).toBeUndefined();
  release!();
});
