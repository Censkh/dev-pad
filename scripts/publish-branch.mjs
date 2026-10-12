import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let branch;
try {
  branch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  throw new Error("Run publish:branch from a named branch");
}
if (!branch || branch === "master") throw new Error("publish:branch cannot publish from master");

const files = ["package.json", "bun.lock"];
const originals = files.map((file) => readFileSync(file));
const dir = mkdtempSync(join(tmpdir(), "dev-pad-branch-publish-"));
const output = join(dir, "version-output");
try {
  execFileSync(process.execPath, [new URL("./prepare-branch-release.mjs", import.meta.url).pathname], {
    stdio: "inherit",
    env: { ...process.env, RELEASE_BRANCH: branch, GITHUB_OUTPUT: output },
  });
  const tag = readFileSync(output, "utf8").match(/^tag=(.+)$/m)?.[1];
  if (!tag) throw new Error("Branch release did not produce an npm tag");
  execFileSync("npm", ["publish", "--tag", tag], { stdio: "inherit" });
} finally {
  files.forEach((file, index) => {
    writeFileSync(file, originals[index]);
  });
  rmSync(dir, { recursive: true, force: true });
}
