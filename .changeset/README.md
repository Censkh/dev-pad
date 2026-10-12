# Release notes

Add a changeset to a PR when its release should be minor or major, or when you
want a specific changelog entry:

```sh
bunx changeset add
```

Select patch, minor, or major and describe the change. On every push to
`master`, CI applies pending changesets, defaults to patch when none exist,
commits the version and changelog, then publishes the stable package to npm.
Branch pushes publish automatically under branch-specific prerelease versions
and npm dist-tags.

To publish a branch version yourself, run `bun run publish:branch` from that
branch while logged in to npm. It uses the same version and tag scheme as CI and
restores local package version files afterward. Stable versions can only be
published by the `master` GitHub Actions workflow.
