import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function prepare(branch, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dev-pad-branch-release-"));
  try {
    const bun = join(dir, "bun");
    writeFileSync(
      bun,
      '#!/bin/sh\nif [ "$1" = info ]; then echo "\\"0.2.1\\""; else printf "%s\\n" "$*" >> "$CALLS"; fi\n',
    );
    chmodSync(bun, 0o755);
    const output = join(dir, "output");
    const before = Math.floor(Date.now() / 1000);
    const result = spawnSync(process.execPath, [new URL("./prepare-branch-release.mjs", import.meta.url).pathname], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: join(dir, "calls"),
        GITHUB_OUTPUT: output,
        GITHUB_REF_NAME: branch,
        RELEASE_BRANCH: "",
        ...env,
      },
    });
    const after = Math.floor(Date.now() / 1000);
    assert.equal(result.status, 0, result.stderr);
    return { calls: readFileSync(join(dir, "calls"), "utf8"), output: readFileSync(output, "utf8"), before, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("branch release uses the next stable patch and a unique branch tag", () => {
  const { calls, output, before, after } = prepare("feature/Log-Filter");
  const timestamp = Number(
    calls.match(/^pm version 0\.2\.2-feature-log-filter\.(\d{10}) --no-git-tag-version\n$/)?.[1],
  );
  assert.ok(timestamp >= before && timestamp <= after);
  assert.equal(output, `tag=feature-log-filter\nversion=0.2.2-feature-log-filter.${timestamp}\n`);
});

test("workflow_run releases use the pushed branch rather than the default branch ref", () => {
  assert.match(prepare("master", { RELEASE_BRANCH: "feature/expo" }).output, /^tag=feature-expo$/m);
});

test("branch tags never look like semver ranges", () => {
  assert.match(prepare("v2").output, /^tag=branch-v2$/m);
  assert.match(prepare("1.x").output, /^tag=branch-1-x$/m);
});
