import { describe, expect, test } from "bun:test";
import { expandMatrix } from "../workflow";

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
