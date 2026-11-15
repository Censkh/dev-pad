import { describe, expect, test } from "bun:test";
import { expandMatrix, jobLabel } from "../workflow";

describe("expandMatrix", () => {
  test("multiplies the axes and drops excluded combinations", () => {
    expect(
      expandMatrix({
        php: ["8.2", "8.5"],
        guzzle: ["7", "8"],
        exclude: [{ php: "8.2", guzzle: "8" }],
      }),
    ).toEqual([
      { php: "8.2", guzzle: "7" },
      { php: "8.5", guzzle: "7" },
      { php: "8.5", guzzle: "8" },
    ]);
  });

  // GitHub's documented example: an include entry extends every combination whose original
  // values it doesn't overwrite, and becomes a combination of its own when it fits none.
  test("adds include entries to matching combinations or as new ones", () => {
    expect(
      expandMatrix({
        fruit: ["apple", "pear"],
        animal: ["cat", "dog"],
        include: [
          { color: "green" },
          { color: "pink", animal: "cat" },
          { fruit: "apple", shape: "circle" },
          { fruit: "banana" },
          { fruit: "banana", animal: "cat" },
        ],
      }),
    ).toEqual([
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ]);
  });

  test("a matrix of only include entries has one combination per entry", () => {
    expect(expandMatrix({ include: [{ name: "libraries" }, { name: "frontend" }] })).toEqual([
      { name: "libraries" },
      { name: "frontend" },
    ]);
    expect(expandMatrix(undefined)).toEqual([{}]);
  });
});

// Job names hold the workflow's own `${{ }}` expressions, not template placeholders.
const expression = (text: string) => `$\{{ ${text} }}`;

describe("jobLabel", () => {
  test("drops a matrix expression, even one holding parentheses of its own", () => {
    expect(jobLabel({ name: `Backend Tests (${expression("matrix.shard")}/5)` } as never, "backend-tests")).toBe(
      "Backend Tests",
    );
    expect(
      jobLabel(
        {
          name: `Frontend E2E (${expression("matrix.shard == 'dev' && 'dev' || format('{0}/6', matrix.shard)")})`,
        } as never,
        "frontend-e2e",
      ),
    ).toBe("Frontend E2E");
  });

  test("falls back to the job's id when its name is only an expression", () => {
    expect(jobLabel({ name: expression("matrix.name") } as never, "setup")).toBe("setup");
  });
});
