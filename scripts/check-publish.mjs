import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const core = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const stable = new RegExp(`^${core}(?:\\+[0-9A-Za-z.-]+)?$`).test(version);
const prerelease = new RegExp(`^${core}-[0-9A-Za-z.-]+(?:\\+[0-9A-Za-z.-]+)?$`).test(version);
if (!stable && !prerelease) throw new Error(`Invalid package version: ${version}`);

if (
  stable &&
  !(
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_REF === "refs/heads/master" &&
    process.env.RELEASE_BRANCH === "master" &&
    process.env.GITHUB_REPOSITORY?.toLowerCase() === "censkh/dev-pad"
  )
) {
  throw new Error(`Stable publish of ${version} is only allowed from dev-pad master CI`);
}
