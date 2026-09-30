## What and why

<!-- What changes, and why. Link the issue or roadmap item (e.g. "Closes #123", "ROADMAP-V3 D-9"). -->

## How it was tested

<!-- The tests added or changed, and anything checked by hand (instance family, client, transport). -->

## Checklist

- [ ] `npm run check` passes locally (build, lint, format, tests with coverage, tarball guard, production audit).
- [ ] A behavioural change ships with a test in this pull request.
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` (not needed for internal-only changes).
- [ ] Tools changed: `npm run gen:manifest` and `npm run docs:readme` were run and the results are committed.
- [ ] No secrets, instance credentials, tokens or personal data in the code, tests, fixtures or this description.
- [ ] Breaking change (tool contract, setting default, removed behaviour): marked as such and explained above.
