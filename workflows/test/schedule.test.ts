import { describe, expect, test } from "bun:test";
import { chainSeconds, isQuick, jobDuration, startOrder, type Waiter } from "../schedule";

const waiter = (name: string, seconds: number, chain = 0, groups: number[] = []) => ({ name, seconds, chain, groups });
const names = (waiters: (Waiter & { name: string })[]) => startOrder(waiters).map((w) => w.name);

describe("startOrder", () => {
  test("a short job that a long chain waits for starts before a longer job with nothing after it", () => {
    // A 75 s build that six exclusive 75 s shards wait for, against 300 s test shards.
    expect(names([waiter("tests", 300), waiter("build", 75, 450)])).toEqual(["build", "tests"]);
  });

  test("without a chain, the longest combination starts first", () => {
    expect(names([waiter("short", 10), waiter("long", 100)])).toEqual(["long", "short"]);
  });

  test("an exclusive combination counts the rest of its group still waiting", () => {
    const shards = [1, 2, 3].map((n) => waiter(`shard-${n}`, 75, 0, [0]));
    // 75 s plus 150 s of the group behind it outranks a 200 s job.
    expect(names([waiter("other", 200), ...shards])[0]).toBe("shard-1");
  });

  test("a combination never timed starts first", () => {
    expect(names([waiter("timed", 1000, 1000), waiter("new", Number.POSITIVE_INFINITY)])).toEqual(["new", "timed"]);
  });

  test("ties keep the order they arrived in", () => {
    expect(names([waiter("a", 5), waiter("b", 5), waiter("c", 5)])).toEqual(["a", "b", "c"]);
  });
});

describe("chainSeconds", () => {
  const dependencies = new Map<string, Set<string>>([
    ["changes", new Set()],
    ["build", new Set(["changes"])],
    ["shards", new Set(["build"])],
    ["tests", new Set(["changes"])],
    ["deploy", new Set(["build", "shards", "tests"])],
  ]);
  const seconds: Record<string, number> = { build: 75, shards: 450, tests: 300, deploy: 240 };

  test("is the longest path through the jobs that wait for a job", () => {
    const chain = chainSeconds(dependencies, (id) => seconds[id] ?? 0);
    expect(chain("build")).toBe(450 + 240);
    expect(chain("tests")).toBe(240);
    expect(chain("changes")).toBe(75 + 450 + 240);
    expect(chain("deploy")).toBe(0);
  });

  test("leaves out jobs that won't run", () => {
    const chain = chainSeconds(dependencies, (id) => (id === "deploy" ? 0 : (seconds[id] ?? 0)));
    expect(chain("build")).toBe(450);
  });
});

describe("jobDuration", () => {
  test("combinations side by side take as long as the longest", () => {
    expect(jobDuration([280, 390, 300], false)).toBe(390);
  });

  test("an exclusive job's combinations add up", () => {
    expect(jobDuration([70, 50, 80], true)).toBe(200);
  });

  test("a job never timed counts as nothing", () => {
    expect(jobDuration([], true)).toBe(0);
  });
});

test("a combination is quick only when several recent runs all took seconds", () => {
  expect(isQuick([0.4, 1, 2])).toBe(true);
  // Too few timings to rely on.
  expect(isQuick([0.4, 1])).toBe(false);
  // One slow run is enough to need a slot.
  expect(isQuick([0.4, 1, 45])).toBe(false);
});
