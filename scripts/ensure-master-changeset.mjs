import { readdirSync, writeFileSync } from "node:fs";

const dir = ".changeset";
const pending = readdirSync(dir).some((file) => file.endsWith(".md") && file !== "README.md");
if (!pending) {
  writeFileSync(`${dir}/ci-patch.md`, '---\n"dev-pad": patch\n---\n\nChanges merged to master.\n');
  console.log("No changeset found; defaulting to a patch release");
}
