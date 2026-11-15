// Starts job combinations by the machine's load instead of a fixed number of slots. A combination
// starts when the CPUs have room and enough memory is free, and starts across every runner using the
// same directory are spaced by a settle time, so the load the last one adds shows before the next
// one is weighed. A run with nothing of its own running always starts its next combination, so load
// from outside (another run, a build in a terminal) can slow a run down but never stall it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { tryLease } from "./leases";

export type Load = {
  /** The share of CPU time spent busy over the sample, from 0 to 1. */
  cpuBusy: number;
  /** Bytes the machine can hand out without swapping. */
  freeMemory: number;
  cpus: number;
};

export type LoadLimits = {
  /** The busiest the CPUs may be for a combination to start, from 0 to 1. */
  cpuBusy: number;
  /** The memory that must stay free for a combination to start, in bytes. */
  freeMemory: number;
  /** How long after one start the load is weighed for the next, in milliseconds. */
  settleMs: number;
};

/** Why a combination is still waiting. */
export type Wait = { reason: "settling" } | { reason: "cpu" | "memory"; load: Load };

/** The limits, from DEVPAD_MAX_CPU_BUSY (percent), DEVPAD_MIN_FREE_MEMORY_GIB and DEVPAD_LOAD_SETTLE_SECONDS. */
export function loadLimits(env: Record<string, string | undefined> = process.env): LoadLimits {
  const number = (name: string, fallback: number) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a number of at least 0`);
    return parsed;
  };
  return {
    // Timing-sensitive suites (a database container's health check, 5 s test timeouts) failed
    // when the CPUs were kept fully busy, so leave them some room.
    cpuBusy: Math.min(100, number("DEVPAD_MAX_CPU_BUSY", 75)) / 100,
    freeMemory: number("DEVPAD_MIN_FREE_MEMORY_GIB", Math.max(4, (totalmem() / 1024 ** 3) * 0.15)) * 1024 ** 3,
    settleMs: number("DEVPAD_LOAD_SETTLE_SECONDS", 10) * 1000,
  };
}

const cpuTimes = () =>
  cpus().reduce(
    (sum, { times }) => {
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { busy: sum.busy + total - times.idle, total: sum.total + total };
    },
    { busy: 0, total: 0 },
  );

// macOS counts only never-used pages as free; memory it reclaims at once (inactive, speculative
// and purgeable pages) is free for a new job too. Linux says so itself as MemAvailable.
function availableMemory() {
  try {
    if (process.platform === "darwin") {
      const stats = Bun.spawnSync(["vm_stat"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      const pageSize = Number(/page size of (\d+) bytes/.exec(stats)?.[1]);
      const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stats)?.[1] ?? 0);
      if (pageSize) return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * pageSize;
    }
    if (process.platform === "linux") {
      const kib = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
      if (kib) return Number(kib) * 1024;
    }
  } catch {}
  return freemem();
}

/** The machine's load over `sampleMs`. */
export async function sampleLoad(sampleMs = 1000): Promise<Load> {
  const before = cpuTimes();
  await Bun.sleep(sampleMs);
  const after = cpuTimes();
  const total = after.total - before.total;
  return {
    cpuBusy: total > 0 ? Math.min(1, Math.max(0, (after.busy - before.busy) / total)) : 0,
    freeMemory: availableMemory(),
    cpus: availableParallelism(),
  };
}

/** A waiting combination's reason, short enough for a job card. */
export function waitNote(wait: Wait) {
  if (wait.reason === "settling") return "load settling";
  if (wait.reason === "cpu") return `CPU ${Math.round(wait.load.cpuBusy * 100)}% busy`;
  return `${(wait.load.freeMemory / 1024 ** 3).toFixed(1)} GiB free`;
}

/**
 * The CPUs a combination started under `load` may use, which its steps get as DEVPAD_JOB_CPUS to
 * size their own parallelism: the idle ones, shared with the `ready` combinations of its run that
 * are waiting to start with it, and at least one.
 */
export function jobCpus(load: Load, ready: number) {
  return Math.max(1, Math.floor((load.cpus * (1 - load.cpuBusy)) / Math.max(1, ready)));
}

export class MachineLoad {
  private readonly lastStartPath: string;

  constructor(
    private readonly directory: string,
    private readonly limits: LoadLimits,
    private readonly sample: () => Promise<Load> = () => sampleLoad(),
    private readonly pollMs = 1000,
  ) {
    this.lastStartPath = join(directory, "last-start");
  }

  private lastStart() {
    try {
      return Number(readFileSync(this.lastStartPath, "utf8")) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Waits until the machine has room for another combination and returns the load it started
   * under; undefined when `stop()` says to give up. `alone()` says the caller's run has nothing of
   * its own running, which starts the combination whatever the load. While it waits, `waiting`
   * hears why each time it looks.
   */
  async admit(
    owner: string,
    {
      stop = () => false,
      alone = () => false,
      waiting,
    }: { stop?: () => boolean; alone?: () => boolean; waiting?: (wait: Wait) => void } = {},
  ): Promise<Load | undefined> {
    for (;;) {
      if (stop()) return undefined;
      const sampledFrom = Date.now();
      const load = await this.sample();
      if (stop()) return undefined;
      // Reading and recording the last start happen under one lease, so two runners can't both
      // start on the strength of the same sample.
      const lease = tryLease(join(this.directory, "start.lease"), owner);
      if (!lease) {
        await Bun.sleep(50);
        continue;
      }
      let wait: Wait | undefined;
      try {
        const settledAt = this.lastStart() + this.limits.settleMs;
        if (!alone()) {
          if (sampledFrom < settledAt) wait = { reason: "settling" };
          else if (load.cpuBusy > this.limits.cpuBusy) wait = { reason: "cpu", load };
          else if (load.freeMemory < this.limits.freeMemory) wait = { reason: "memory", load };
        }
        if (!wait) {
          const temporary = `${this.lastStartPath}.${process.pid}`;
          writeFileSync(temporary, String(Date.now()));
          renameSync(temporary, this.lastStartPath);
          return load;
        }
      } finally {
        lease.release();
      }
      waiting?.(wait);
      const settleLeft = wait.reason === "settling" ? this.lastStart() + this.limits.settleMs - Date.now() : 0;
      await Bun.sleep(Math.max(this.pollMs, settleLeft));
    }
  }
}
