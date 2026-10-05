import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const selected = process.env.PACKAGE_MANAGER;
const managers = ["bun", "npm", "pnpm", "yarn"].filter((manager) => !selected || manager === selected);
const available = (command) => {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const run = (command, args, cwd, env) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });

const verify = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const hostRequire = createRequire(import.meta.url);
const devPadEntry = hostRequire.resolve("dev-pad");
const devPadRequire = createRequire(devPadEntry);
const openTuiEntry = devPadRequire.resolve("@opentui/react");
const openTuiRequire = createRequire(openTuiEntry);
const devPadReact = devPadRequire("react");
assert.strictEqual(devPadReact, openTuiRequire("react"), "dev-pad and OpenTUI resolved different React instances");
if (process.env.EXPECT_HOST_REACT === "1")
  assert.strictEqual(devPadReact, hostRequire("react"), "dev-pad did not use the host React instance");
console.log("React " + devPadReact.version + " resolved once");
`;

const packageTarball = async (directory) => {
  const output = run("npm", ["pack", "--json", "--pack-destination", directory, "--ignore-scripts"], root);
  return join(directory, JSON.parse(output)[0].filename);
};

const installArgs = (manager) => (manager === "bun" ? ["install"] : ["install", "--ignore-scripts"]);

const testFixture = async (manager, name, dependencies, expectsHostReact) => {
  const directory = await mkdtemp(join(tmpdir(), `dev-pad-${manager}-${name}-`));
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: `dev-pad-${manager}-${name}`, private: true, type: "module", dependencies }, null, 2),
    );
    await writeFile(join(directory, "verify.mjs"), verify);
    try {
      run(manager, installArgs(manager), directory);
    } catch (error) {
      throw new Error(
        `${manager} could not install the ${name} fixture:\n${error.stderr || error.stdout || error.message}`,
      );
    }
    try {
      const output = run(process.execPath, ["verify.mjs"], directory, {
        EXPECT_HOST_REACT: expectsHostReact ? "1" : "0",
      });
      assert.match(output, /resolved once/);
    } catch (error) {
      throw new Error(`${manager} failed the ${name} fixture:\n${error.stderr || error.stdout || error.message}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("package managers share React between dev-pad and OpenTUI", async () => {
  const packed = await mkdtemp(join(tmpdir(), "dev-pad-package-"));
  try {
    const tarball = await packageTarball(packed);
    for (const manager of managers) {
      if (!available(manager)) {
        if (selected) throw new Error(`${manager} is required but unavailable`);
        console.log(`skip - ${manager} is unavailable`);
        continue;
      }
      await testFixture(manager, "host-react", { "dev-pad": `file:${tarball}`, react: "19.3.0" }, true);
      await testFixture(manager, "missing-react", { "dev-pad": `file:${tarball}` }, false);
      console.log(`ok - ${manager}: host and installed-peer React resolution`);
    }
  } finally {
    await rm(packed, { recursive: true, force: true });
  }
});
