import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./publish-branch.mjs", import.meta.url).pathname;

function run(branch, failPublish = false) {
  const dir = mkdtempSync(join(tmpdir(), "dev-pad-manual-publish-"));
  const manifest = '{"name":"dev-pad","version":"0.2.1"}\n';
  const lock = '{"lockfileVersion":1}\n';
  try {
    writeFileSync(join(dir, "package.json"), manifest);
    writeFileSync(join(dir, "bun.lock"), lock);
    writeFileSync(join(dir, "git"), '#!/bin/sh\necho "$TEST_BRANCH"\n');
    writeFileSync(
      join(dir, "bun"),
      '#!/bin/sh\ncase "$1" in\n  info) echo "\\"0.2.1\\"";;\n  pm) echo changed > package.json; echo changed > bun.lock;;\nesac\n',
    );
    writeFileSync(
      join(dir, "npm"),
      '#!/bin/sh\necho "$*" > "$PUBLISH_CALL"\nif [ "$FAIL_PUBLISH" = 1 ]; then exit 3; fi\n',
    );
    for (const bin of ["git", "bun", "npm"]) chmodSync(join(dir, bin), 0o755);
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEST_BRANCH: branch,
        PUBLISH_CALL: join(dir, "published"),
        FAIL_PUBLISH: failPublish ? "1" : "0",
      },
    });
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), manifest);
    assert.equal(readFileSync(join(dir, "bun.lock"), "utf8"), lock);
    return {
      result,
      published: result.status === 0 || failPublish ? readFileSync(join(dir, "published"), "utf8") : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("manual branch publish uses a branch tag and restores version files", () => {
  const { result, published } = run("feature/log-filter");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(published, "publish --tag feature-log-filter\n");
});

test("manual branch publish restores version files when publishing fails", () => {
  const { result, published } = run("feature/log-filter", true);
  assert.notEqual(result.status, 0);
  assert.equal(published, "publish --tag feature-log-filter\n");
});

test("manual branch publish refuses master", () => {
  const { result } = run("master");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot publish from master/);
});
