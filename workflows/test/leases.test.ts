import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { leaseHolder, tryLease } from "../leases";
import { leaseWorkspace } from "../workspaces";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-pad-leases-"));
  directories.push(directory);
  return directory;
};

// Another runner holding a lease until it is killed.
async function holdInChild(path: string) {
  const module = resolve(import.meta.dir, "../leases.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { tryLease } = await import(${JSON.stringify(module)});
       if (!tryLease(${JSON.stringify(path)}, "other/run")) process.exit(1);
       console.log("held");
       await Bun.sleep(60_000);`,
    ],
    { stdout: "pipe" },
  );
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
  return child;
}

test("a lease another live runner holds can't be taken, and is taken over once it dies", async () => {
  const path = join(scratch(), "exclusive", "group.lease");
  const child = await holdInChild(path);
  expect(tryLease(path, "this/run")).toBeUndefined();
  expect(leaseHolder(path)).toEqual({ pid: child.pid, owner: "other/run" });
  child.kill("SIGKILL");
  await child.exited;
  const lease = tryLease(path, "this/run");
  expect(lease?.reclaimed).toBe(true);
  expect(leaseHolder(path)).toEqual({ pid: process.pid, owner: "this/run" });
  lease!.release();
  expect(leaseHolder(path)).toBeUndefined();
});

test("a lease left empty by a holder killed while writing it is taken over once it is old", () => {
  const path = join(scratch(), "empty.lease");
  writeFileSync(path, "");
  expect(tryLease(path, "this/run")).toBeUndefined();
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  expect(tryLease(path, "this/run")?.reclaimed).toBe(true);
});

test("runs going at once get workspaces of their own from the pool, the first free one first", async () => {
  const directory = scratch();
  const child = await holdInChild(join(directory, "build.lease"));
  const second = leaseWorkspace(directory, "build", "run-2");
  const third = leaseWorkspace(directory, "build", "run-3");
  expect(second.path).toBe(join(directory, "build.2"));
  expect(third.path).toBe(join(directory, "build.3"));
  second.lease.release();
  // The freed one is used again before a new one is made.
  expect(leaseWorkspace(directory, "build", "run-4").path).toBe(join(directory, "build.2"));
  child.kill("SIGKILL");
  await child.exited;
  expect(leaseWorkspace(directory, "build", "run-5").path).toBe(join(directory, "build"));
  expect(
    readdirSync(directory)
      .filter((name) => !name.endsWith(".lease"))
      .sort(),
  ).toEqual(["build", "build.2", "build.3"]);
});
