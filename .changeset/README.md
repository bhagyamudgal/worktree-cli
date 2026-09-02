# Changesets

This folder holds pending release notes for `worktree-cli`. Every user-visible
change gets a changeset, and the version number is derived from those files.

## Adding one

```bash
bun changeset
```

Pick the bump type and write a one-line summary. Commit the generated Markdown
file with the rest of the pull request.

- **patch**: bug fix with no behavior change for correct usage
- **minor**: new command, flag, or capability
- **major**: incompatible change to an existing command, flag, or output

Tests, CI, documentation, and refactors do not need a changeset unless users
will notice the result.

## What happens next

Merging to `main` makes GitHub Actions open a `chore: version packages` pull
request that collects pending changesets into a version bump and a
`CHANGELOG.md` entry. Merging that pull request builds the binaries and creates
the GitHub release.

See `.github/workflows/release.yml`.
