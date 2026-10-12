export function branchTag(branch) {
  const tag =
    branch
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "branch";
  // npm rejects dist-tags that parse as semver ranges, such as "1" or "v2".
  return /^v?\d/.test(tag) ? `branch-${tag}` : tag;
}
