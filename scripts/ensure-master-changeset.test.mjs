import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("master defaults to patch only when no changeset is pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-pad-master-release-"));
  const changesets = join(dir, ".changeset");
  const script = new URL("./ensure-master-changeset.mjs", import.meta.url).pathname;
  try {
    mkdirSync(changesets);
    writeFileSync(join(changesets, "README.md"), "Instructions");
    assert.equal(spawnSync(process.execPath, [script], { cwd: dir }).status, 0);
    assert.match(readFileSync(join(changesets, "ci-patch.md"), "utf8"), /"dev-pad": patch/);
    writeFileSync(join(changesets, "ci-patch.md"), "existing changeset");
    assert.equal(spawnSync(process.execPath, [script], { cwd: dir }).status, 0);
    assert.equal(readFileSync(join(changesets, "ci-patch.md"), "utf8"), "existing changeset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
