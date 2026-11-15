// Job slots shared by every runner on this machine, so concurrent runs (another workflow, another
// branch's state, another checkout) don't each start their own jobs on top of each other's. A slot
// is a file in a shared directory, created exclusively with the holder's pid; a slot whose holder
// has died is reclaimed, so a killed runner never keeps one.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Holder = { pid: number; owner: string };

const alive = (pid: number) => {
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

export class MachineSlots {
  private readonly held = new Set<string>();

  constructor(
    private readonly directory: string,
    readonly count: number,
    private readonly pollMs = 500,
  ) {
    // Slots this process still holds are freed when it exits, however it exits.
    process.once("exit", () => {
      for (const path of this.held) this.free(path);
    });
  }

  /**
   * Takes a free slot, waiting until one is, and returns its release; undefined when `stop()` says
   * to give up. While every slot is taken, `waiting` hears who holds them, each time it looks.
   */
  async acquire(
    owner: string,
    stop: () => boolean = () => false,
    waiting?: (holders: Holder[]) => void,
  ): Promise<(() => void) | undefined> {
    for (;;) {
      if (stop()) return undefined;
      for (let index = 0; index < this.count; index++) {
        const path = join(this.directory, `slot-${index}`);
        if (this.take(path, owner)) {
          this.held.add(path);
          return () => {
            this.held.delete(path);
            this.free(path);
          };
        }
      }
      waiting?.(this.holders());
      await Bun.sleep(this.pollMs);
    }
  }

  /** The live holders of the slots. */
  holders(): Holder[] {
    const holders: Holder[] = [];
    for (let index = 0; index < this.count; index++) {
      const holder = read(join(this.directory, `slot-${index}`));
      if (holder && alive(holder.pid)) holders.push(holder);
    }
    return holders;
  }

  private take(path: string, owner: string) {
    const holder: Holder = { pid: process.pid, owner };
    try {
      writeFileSync(path, JSON.stringify(holder), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = read(path);
    if (current && alive(current.pid)) return false;
    // A dead holder's slot: moved aside first, so two runners reclaiming it at once can't both
    // delete a file the other has just created; one that turns out live goes back.
    const aside = `${path}.reclaim-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      renameSync(path, aside);
    } catch {
      return false;
    }
    const moved = read(aside);
    if (moved && alive(moved.pid)) {
      try {
        renameSync(aside, path);
      } catch {}
      return false;
    }
    unlinkSync(aside);
    try {
      writeFileSync(path, JSON.stringify(holder), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  private free(path: string) {
    try {
      if (read(path)?.pid === process.pid) unlinkSync(path);
    } catch {}
  }
}
