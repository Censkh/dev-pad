// Local processors for the `uses:` actions the workflows call, keyed by owner/repository[/path].
// Each accepts only the inputs it implements, so a workflow can't start relying on an input that
// is silently ignored here. Toolchains are taken from this Mac (Homebrew, java_home, uv) or
// downloaded from their official release with a checked SHA-256 into the tool cache.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Processor, StepRun } from "./processor";
import { StepFailure } from "./processor";

type Action = { inputs: string[]; processor: Processor; literalInputs?: boolean };

function accept(step: StepRun, allowed: string[]) {
  for (const name of Object.keys(step.inputs))
    if (!allowed.includes(name)) throw new StepFailure(`Input '${name}' has no local implementation`);
}

// Asynchronous, so a long clone doesn't stop the runner's other jobs and live status.
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new StepFailure(`git ${args.join(" ")} failed:\n${stderr}`);
  return stdout.trim();
}

// Submodules are cloned from their copies in the source tree, which hold the pinned commits
// (pushed or not), so nothing is fetched from GitHub. `submodule init` keeps a URL already in
// the config (never `submodule sync`, which resets it to .gitmodules').
// A preserved path is plain and relative: no globs, `..`, leading slash or empty segments.
export const isPreservablePath = (path: string) =>
  /^[^*?[\]!#\\]+$/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

// `git clean` excludes for the preserved paths under `prefix` (a submodule's path, or "" for the
// workspace itself), anchored there.
function preserved(paths: readonly string[], prefix: string): string[] {
  return paths.flatMap((path) =>
    !prefix ? ["-e", `/${path}`] : path.startsWith(`${prefix}/`) ? ["-e", `/${path.slice(prefix.length + 1)}`] : [],
  );
}

async function checkoutSubmodules(
  destination: string,
  source: string,
  recursive: boolean,
  preserve: readonly string[],
  prefix = "",
) {
  if (!existsSync(join(destination, ".gitmodules"))) return;
  const entries = (await git(destination, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [key, path] = line.split(" ");
      return { name: key.replace(/^submodule\./, "").replace(/\.path$/, ""), path };
    });
  for (const { name, path } of entries) {
    await git(destination, "config", `submodule.${name}.url`, join(source, path));
    // A submodule cloned before keeps fetching from its own origin, so that is the local copy too.
    if (existsSync(join(destination, path, ".git")))
      await git(join(destination, path), "remote", "set-url", "origin", join(source, path));
  }
  await git(destination, "submodule", "--quiet", "update", "--init", "--force");
  for (const { path } of entries) {
    const within = prefix ? `${prefix}/${path}` : path;
    await git(join(destination, path), "clean", "-ffdxq", "-e", "node_modules", ...preserved(preserve, within));
    if (recursive) await checkoutSubmodules(join(destination, path), join(source, path), true, preserve, within);
  }
}

const checkout: Action = {
  inputs: ["submodules", "fetch-depth"],
  async processor(step) {
    // The workspace is a --shared clone of the source repository: it reads the source's objects,
    // so any local commit checks out, and it keeps installed dependencies between runs.
    if (!existsSync(join(step.workspace, ".git")))
      await git(
        dirname(step.workspace),
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        step.run.source,
        step.workspace,
      );
    await git(step.workspace, "checkout", "--quiet", "--force", "--detach", step.run.sha);
    const preserve = step.run.preserve;
    await git(step.workspace, "clean", "-ffdxq", "-e", "node_modules", ...preserved(preserve, ""));
    const submodules = step.input("submodules");
    if (submodules === "true" || submodules === "recursive")
      await checkoutSubmodules(step.workspace, step.run.source, submodules === "recursive", preserve);
    else if (submodules && submodules !== "false") throw new StepFailure(`submodules: ${submodules} is not supported`);
    step.log(`Checked out ${step.run.sha.slice(0, 9)} in ${step.workspace}`);
  },
};

const noOp = (inputs: string[]): Action => ({
  inputs,
  literalInputs: true,
  async processor(step) {
    step.log("Local runs keep their caches on disk, so this does nothing.");
  },
});

async function sha256(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

// Downloads an official release archive, checks it against the release's SHA256SUMS line and
// unpacks it into the tool cache, once.
async function cachedRelease(step: StepRun, options: { directory: string; url: string; sums: string; file: string }) {
  if (existsSync(join(options.directory, ".complete"))) return;
  rmSync(options.directory, { recursive: true, force: true });
  mkdirSync(options.directory, { recursive: true });
  step.log(`Downloading ${options.url}`);
  const sums = await (await fetch(options.sums, { signal: step.signal })).text();
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === options.file)?.[0];
  if (!expected) throw new StepFailure(`${options.file} is not listed in ${options.sums}`);
  const response = await fetch(options.url, { signal: step.signal });
  if (!response.ok) throw new StepFailure(`Downloading ${options.url} failed: ${response.status}`);
  const archive = join(options.directory, options.file);
  await Bun.write(archive, response);
  if ((await sha256(archive)) !== expected) throw new StepFailure(`${options.file} does not match its SHA-256`);
  const unpack = options.file.endsWith(".zip")
    ? ["unzip", "-q", archive, "-d", options.directory]
    : ["tar", "-xzf", archive, "-C", options.directory];
  if (Bun.spawnSync(unpack).exitCode !== 0) throw new StepFailure(`Unpacking ${options.file} failed`);
  rmSync(archive);
  await Bun.write(join(options.directory, ".complete"), "");
}

// A tool's version output, or undefined when it isn't installed or fails.
function versionOf(command: string[], env?: Record<string, string>) {
  try {
    const result = Bun.spawnSync(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
}

const nodeArch = process.arch === "arm64" ? "arm64" : "x64";
const platform = process.platform === "darwin" ? "darwin" : "linux";

const setupNode: Action = {
  inputs: ["node-version", "cache", "cache-dependency-path"],
  async processor(step) {
    const major = step.input("node-version").replace(/^v/, "").split(".")[0];
    if (!/^\d+$/.test(major))
      throw new StepFailure(`node-version ${step.input("node-version")} is not a major version`);
    const current = versionOf(["node", "--version"], step.env);
    if (current?.replace(/^v/, "").split(".")[0] === major) return step.log(`Using node ${current}`);
    const brew = `/opt/homebrew/opt/node@${major}/bin`;
    if (existsSync(join(brew, "node"))) {
      step.addPath(brew);
      return step.log(`Using ${brew}/node`);
    }
    const index = (await (await fetch("https://nodejs.org/dist/index.json", { signal: step.signal })).json()) as {
      version: string;
    }[];
    const version = index.find((release) => release.version.startsWith(`v${major}.`))?.version;
    if (!version) throw new StepFailure(`No Node.js ${major} release`);
    const name = `node-${version}-${platform}-${nodeArch}`;
    const directory = join(step.run.toolCache, "node", version);
    await cachedRelease(step, {
      directory,
      url: `https://nodejs.org/dist/${version}/${name}.tar.gz`,
      sums: `https://nodejs.org/dist/${version}/SHASUMS256.txt`,
      file: `${name}.tar.gz`,
    });
    step.addPath(join(directory, name, "bin"));
    step.log(`Using node ${version}`);
  },
};

const setupBun: Action = {
  inputs: ["bun-version"],
  async processor(step) {
    const version = step.input("bun-version");
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new StepFailure(`bun-version ${version} is not an exact version`);
    if (versionOf(["bun", "--version"], step.env) === version) return step.log(`Using bun ${version}`);
    const name = `bun-${platform}-${process.arch === "arm64" ? "aarch64" : "x64"}`;
    const directory = join(step.run.toolCache, "bun", version);
    const release = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
    await cachedRelease(step, {
      directory,
      url: `${release}/${name}.zip`,
      sums: `${release}/SHASUMS256.txt`,
      file: `${name}.zip`,
    });
    step.addPath(join(directory, name));
    step.log(`Using bun ${version}`);
  },
};

// A virtual environment of the requested Python for the job (uv finds or installs the version),
// so `pip install` never touches a Python installed on this Mac.
const setupPython: Action = {
  inputs: ["python-version", "cache"],
  async processor(step) {
    const version = step.input("python-version");
    const venv = join(step.temp, `python-${version}`);
    await step.exec("uv", ["venv", "--quiet", "--seed", "--python", version, venv]);
    step.addPath(join(venv, "bin"));
    step.exportEnv("VIRTUAL_ENV", venv);
    step.log(`Using ${await step.output(join(venv, "bin/python"), ["--version"])} in ${venv}`);
  },
};

// The local Go when it matches, otherwise Go's own toolchain download (GOTOOLCHAIN, verified
// against the Go checksum database) of the newest matching release.
const setupGo: Action = {
  inputs: ["go-version", "cache"],
  async processor(step) {
    const spec = step.input("go-version");
    const local = (await step.output("go", ["env", "GOVERSION"])).replace(/^go/, "");
    if (spec === "stable") return step.log(`Using the local Go ${local}`);
    const prefix = spec.replace(/\.x$/, "");
    const matches = (version: string) => version === prefix || version.startsWith(`${prefix}.`);
    if (matches(local)) return step.log(`Using the local Go ${local}`);
    const releases = (await (
      await fetch("https://go.dev/dl/?mode=json&include=all", { signal: step.signal })
    ).json()) as {
      version: string;
      stable: boolean;
    }[];
    const version = releases.find((release) => release.stable && matches(release.version.replace(/^go/, "")))?.version;
    if (!version) throw new StepFailure(`No Go release matches ${spec}`);
    step.exportEnv("GOTOOLCHAIN", version);
    step.log(`Using Go ${version} through GOTOOLCHAIN`);
  },
};

function javaMajor(home: string) {
  try {
    const release = readFileSync(join(home, "release"), "utf8");
    return /JAVA_VERSION="(\d+)/.exec(release)?.[1];
  } catch {
    return undefined;
  }
}

const setupJava: Action = {
  inputs: ["distribution", "java-version", "cache"],
  async processor(step) {
    const major = step.input("java-version");
    const candidates = [
      versionOf(["/usr/libexec/java_home", "-v", major]),
      `/opt/homebrew/opt/openjdk@${major}/libexec/openjdk.jdk/Contents/Home`,
      "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    ].filter((home): home is string => !!home);
    const home = candidates.find((candidate) => javaMajor(candidate) === major);
    if (!home) throw new StepFailure(`No JDK ${major} on this Mac: brew install openjdk@${major}`);
    step.exportEnv("JAVA_HOME", home);
    step.addPath(join(home, "bin"));
    step.log(`Using JDK ${major} at ${home} (${step.input("distribution") || "any"} distribution requested)`);
  },
};

const setupRuby: Action = {
  inputs: ["ruby-version", "bundler-cache", "working-directory"],
  async processor(step) {
    const version = step.input("ruby-version");
    const matches = (found: string) => found === version || found.startsWith(`${version}.`);
    const bin = [`/opt/homebrew/opt/ruby@${version}/bin`, "/opt/homebrew/opt/ruby/bin"].find((directory) => {
      const found = versionOf([join(directory, "ruby"), "-e", "print RUBY_VERSION"]);
      return found !== undefined && matches(found);
    });
    if (!bin) throw new StepFailure(`No Ruby ${version} on this Mac: brew install ruby@${version}`);
    // Gems install into the tool cache, never into the Homebrew Ruby's own gem directory.
    const found = versionOf([join(bin, "ruby"), "-e", "print RUBY_VERSION"])!;
    const gemHome = join(step.run.toolCache, "gems", found);
    mkdirSync(gemHome, { recursive: true });
    step.exportEnv("GEM_HOME", gemHome);
    step.exportEnv("GEM_PATH", gemHome);
    step.addPath(bin);
    step.addPath(join(gemHome, "bin"));
    step.log(`Using Ruby ${found} from ${bin}`);
    if (step.input("bundler-cache") === "true")
      await step.exec("bundle", ["install"], { cwd: step.input("working-directory") || "." });
  },
};

const setupPhp: Action = {
  inputs: ["php-version", "tools", "extensions", "coverage"],
  async processor(step) {
    const version = step.input("php-version");
    const minor = version.split(".").slice(0, 2).join(".");
    const bin = [`/opt/homebrew/opt/php@${minor}/bin`, "/opt/homebrew/opt/php/bin"].find((directory) =>
      versionOf([join(directory, "php"), "-r", "echo PHP_VERSION;"])?.startsWith(`${minor}.`),
    );
    if (!bin) throw new StepFailure(`No PHP ${minor} on this Mac: brew install shivammathur/php/php@${minor}`);
    const found = versionOf([join(bin, "php"), "-r", "echo PHP_VERSION;"])!;
    step.addPath(bin);
    step.log(`Using PHP ${found} from ${bin}${found === version ? "" : ` (the workflow pins ${version})`}`);
    const modules = (versionOf([join(bin, "php"), "-m"]) ?? "").toLowerCase().split("\n");
    const missing = step
      .input("extensions")
      .split(",")
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension && !modules.includes(extension));
    if (missing.length) throw new StepFailure(`PHP ${found} lacks the extensions ${missing.join(", ")}`);
    for (const tool of step
      .input("tools")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      if (tool !== "composer:v2") throw new StepFailure(`The PHP tool ${tool} has no local implementation`);
      const composer = await step.output("composer", ["--version"]);
      if (!/Composer version 2\./.test(composer)) throw new StepFailure(`Composer 2 is required, found ${composer}`);
    }
  },
};

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function commonDirectory(paths: string[]) {
  const parts = paths.map((path) => path.split(sep));
  const common: string[] = [];
  for (let i = 0; parts.every((part) => i < part.length - 1 && part[i] === parts[0][i]); i++) common.push(parts[0][i]);
  return common.join(sep) || sep;
}

/** The directory of a run's artifacts that marks which job uploaded each (by name). */
export const UPLOADED_BY = ".uploaded-by";

// actions/upload-artifact: the files under the artifact's root (the paths' common directory, or
// a single directory itself), copied into this run's artifacts.
const uploadArtifact: Action = {
  inputs: ["name", "path", "retention-days", "if-no-files-found"],
  async processor(step) {
    const name = step.input("name");
    if (!name) throw new StepFailure("An artifact needs a name");
    const entries = step
      .input("path")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (entries.some((entry) => /[*?[]/.test(entry) || entry.startsWith("!")))
      throw new StepFailure("Artifact path patterns have no local implementation");
    const paths = entries.map((entry) => resolve(step.workspace, entry)).filter((path) => existsSync(path));
    if (paths.length === 0) {
      if (step.input("if-no-files-found") === "error") throw new StepFailure(`No files for artifact ${name}`);
      return step.log(`No files for artifact ${name}`);
    }
    // A directory's own contents, or a file at the root.
    const root = commonDirectory(paths.map((path) => join(statSync(path).isDirectory() ? path : dirname(path), "x")));
    const destination = join(step.run.artifacts, name);
    if (existsSync(destination)) throw new StepFailure(`Artifact ${name} was already uploaded in this run`);
    for (const file of paths.flatMap(filesUnder)) {
      const target = join(destination, relative(root, file));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
    }
    // Which job uploaded it, so a run that reuses the job's result brings its artifacts too.
    mkdirSync(join(step.run.artifacts, UPLOADED_BY), { recursive: true });
    writeFileSync(join(step.run.artifacts, UPLOADED_BY, name), step.jobId);
    step.log(`Uploaded artifact ${name}`);
  },
};

const downloadArtifact: Action = {
  inputs: ["name", "path"],
  async processor(step) {
    const name = step.input("name");
    if (!name) throw new StepFailure("Downloading every artifact has no local implementation");
    const source = step.artifactDirectory(name);
    if (!existsSync(source)) throw new StepFailure(`No artifact ${name} was uploaded in this run`);
    const destination = resolve(step.workspace, step.input("path") || ".");
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true });
    step.log(`Downloaded artifact ${name} to ${destination}`);
  },
};

const wranglerAction: Action = {
  inputs: ["apiToken", "accountId", "workingDirectory", "command", "packageManager"],
  async processor(step) {
    const runners: Record<string, string[]> = {
      bun: ["bunx"],
      npm: ["npx"],
      pnpm: ["pnpm", "exec"],
      yarn: ["yarn"],
    };
    const runner = runners[step.input("packageManager") || "npm"];
    if (!runner) throw new StepFailure(`packageManager ${step.input("packageManager")} is not supported`);
    // The command is the action's documented argument string: split on spaces, no shell.
    const args = step.input("command").split(/\s+/).filter(Boolean);
    if (args.some((arg) => /["'`$;&|<>]/.test(arg)))
      throw new StepFailure("Quoted or shell wrangler commands are not supported");
    const env: Record<string, string> = {};
    if (step.input("apiToken")) env.CLOUDFLARE_API_TOKEN = step.input("apiToken");
    if (step.input("accountId")) env.CLOUDFLARE_ACCOUNT_ID = step.input("accountId");
    await step.exec(runner[0], [...runner.slice(1), "wrangler", ...args], {
      cwd: step.input("workingDirectory") || ".",
      env,
    });
  },
};

const cacheInputs = ["path", "key", "restore-keys", "enableCrossOsArchive", "fail-on-cache-miss", "lookup-only"];

export const actions: Record<string, Action> = {
  "actions/checkout": checkout,
  "actions/setup-node": setupNode,
  "oven-sh/setup-bun": setupBun,
  "actions/setup-python": setupPython,
  "actions/setup-go": setupGo,
  "actions/setup-java": setupJava,
  "ruby/setup-ruby": setupRuby,
  "shivammathur/setup-php": setupPhp,
  "actions/cache": noOp(cacheInputs),
  "actions/cache/restore": noOp(cacheInputs),
  "actions/cache/save": noOp(cacheInputs),
  "actions/upload-artifact": uploadArtifact,
  "actions/download-artifact": downloadArtifact,
  "cloudflare/wrangler-action": wranglerAction,
};

export function actionProcessor(name: string): Processor | undefined {
  const action = actions[name];
  if (!action) return undefined;
  return async (step) => {
    accept(step, action.inputs);
    await action.processor(step);
  };
}
