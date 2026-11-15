// Leases on things several runners on this machine might use at once: a job workspace, an
// exclusive group, a port, the right to deploy or to prune. A lease is a file created exclusively
// with its holder's pid; one whose holder has died is taken over, so a killed runner never keeps
// one. Every lease a process still holds is freed when it exits, however it exits.
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Holder = { pid: number; owner: string };
export type Lease = {
  release: () => void;
  // Whether a dead holder's lease was taken over: what it was doing may have left something behind.
  reclaimed: boolean;
};

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const read = (path: string): Holder | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Holder;
  } catch {
    return undefined;
  }
};

// A holder killed between creating its lease and writing it leaves an empty file.
const staleUnreadable = (path: string) => {
  try {
    return Date.now() - statSync(path).mtimeMs > 10_000;
  } catch {
    return false;
  }
};

const held = new Set<string>();
process.once("exit", () => {
  for (const path of held) free(path);
});

function free(path: string) {
  held.delete(path);
  try {
    if (read(path)?.pid === process.pid) unlinkSync(path);
  } catch {}
}

const create = (path: string, holder: Holder) => {
  try {
    writeFileSync(path, JSON.stringify(holder), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(dirname(path), { recursive: true });
      return create(path, holder);
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
};

/** The lease at `path` if nobody alive holds it, else undefined. Never waits. */
export function tryLease(path: string, owner: string): Lease | undefined {
  const holder: Holder = { pid: process.pid, owner };
  const taken = (reclaimed: boolean): Lease => {
    held.add(path);
    return { release: () => free(path), reclaimed };
  };
  if (create(path, holder)) return taken(false);
  const current = read(path);
  // A lease being written reads as nothing for a moment: held, unless it has stayed unreadable.
  if (current ? alive(current.pid) : !staleUnreadable(path)) return undefined;
  // A dead holder's lease: moved aside first, so two runners reclaiming it at once can't both
  // delete a file the other has just created; one that turns out live goes back.
  const aside = `${path}.reclaim-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, aside);
  } catch {
    return undefined;
  }
  const moved = read(aside);
  if (moved ? alive(moved.pid) : current) {
    try {
      renameSync(aside, path);
    } catch {}
    return undefined;
  }
  unlinkSync(aside);
  return create(path, holder) ? taken(true) : undefined;
}

/** Who alive holds the lease at `path`, if anyone. */
export function leaseHolder(path: string): Holder | undefined {
  const current = read(path);
  return current && alive(current.pid) ? current : undefined;
}

/** Waits for the lease at `path`, polling; undefined when `stop()` says to give up. */
export async function lease(
  path: string,
  owner: string,
  stop: () => boolean = () => false,
  pollMs = 500,
): Promise<Lease | undefined> {
  for (;;) {
    if (stop()) return undefined;
    const taken = tryLease(path, owner);
    if (taken) return taken;
    await Bun.sleep(pollMs);
  }
}
