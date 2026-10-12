import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { branchTag } from "./branch-tag.mjs";

// workflow_run jobs run on the default branch, so they pass the pushed branch as RELEASE_BRANCH.
const branch = process.env.RELEASE_BRANCH || process.env.GITHUB_REF_NAME;
if (!branch) throw new Error("Expected RELEASE_BRANCH or GITHUB_REF_NAME");

const name = "dev-pad";
const latest = JSON.parse(execFileSync("bun", ["info", `${name}@latest`, "version", "--json"], { encoding: "utf8" }));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest);
if (!match) throw new Error(`Expected a stable latest version, received ${latest}`);

const tag = branchTag(branch);
const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-${tag}.${Math.floor(Date.now() / 1000)}`;
execFileSync("bun", ["pm", "version", version, "--no-git-tag-version"], { stdio: "inherit" });
console.log(`Publishing ${name}@${version} with tag ${tag}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${version}\n`);
