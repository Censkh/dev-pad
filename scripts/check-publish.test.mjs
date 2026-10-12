import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./check-publish.mjs", import.meta.url).pathname;

function check(version, ci = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dev-pad-publish-gate-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
    return spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_REF: "", GITHUB_REPOSITORY: "", RELEASE_BRANCH: "", ...ci },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const masterCI = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/master",
  GITHUB_REPOSITORY: "Censkh/dev-pad",
  RELEASE_BRANCH: "master",
};

test("stable publish requires master repository CI", () => {
  for (const version of ["0.2.2", "0.2.2+build.1"]) {
    assert.match(check(version).stderr, /only allowed from dev-pad master CI/);
    assert.equal(check(version, masterCI).status, 0);
    assert.match(check(version, { ...masterCI, GITHUB_REF: "refs/heads/feature/test" }).stderr, /only allowed/);
    // workflow_run jobs always report the default branch ref, even for branch pushes.
    assert.match(check(version, { ...masterCI, RELEASE_BRANCH: "feature/test" }).stderr, /only allowed/);
    assert.match(check(version, { ...masterCI, GITHUB_REPOSITORY: "someone/fork" }).stderr, /only allowed/);
  }
});

test("branch prereleases remain publishable locally", () => {
  assert.equal(check("0.2.2-feature-logs.123").status, 0);
  assert.match(check("not-a-version").stderr, /Invalid package version/);
});
