# Contributing

Open a pull request with the problem, the resulting behavior, and the checks you
ran. Keep unrelated changes separate. Run these checks with Node.js 22+ and Go 1.27.0:

```sh
npm test
npm run check:package
node scripts/bundle-gitleaks.mjs
node scripts/scanner-notices.mjs --check
(cd scanner && go vet ./...)
```

`test/unit` contains offline tests against local HTTP fixtures. Use synthetic
fixtures. Do not commit credentials, customer data, captured sessions, local
configuration, or build caches.

## Hosts

Keep host field names, idempotency prefixes and output shapes in
`src/hosts/<host>/`. The core must not read a host's hook event. A host adapter
derives a call key (which admitted call a later report belongs to) and an
approval fingerprint (which retry an approval may release) and passes them in.

Hosts vendor a released archive, never a local pack. While developing, pack this
checkout and vendor it into a host to run the host's own tests, including its
native and live integration suites, but do not merge a host on a local pack.

## Releasing

1. Bump `version` in `package.json` and add a `## <version>` section to
   `CHANGELOG.md`. That section becomes the release notes, and CI fails without it.
2. Merge to `main` and wait for CI on `main` to pass, including `release-ready`.
3. Tag that exact commit and push the tag:

   ```sh
   git tag v<version> <commit on main>
   git push origin v<version>
   ```

The `release` workflow reuses the passed CI for that commit and publishes
`actera-ai-agent-hooks-<version>.tgz` and its `.sha256` as a GitHub release. It
refuses a tag that is not on `main`, a tag that moved, and a version that does not
match `package.json`. If CI on `main` is still running, the release follows when it
finishes. Tags are immutable: fix a bad release with a new version. Each host then
moves to the release in its own pull request, when it needs it.

## Contract

API changes originate in the backend repository. Export a reviewed contract to
`actera-api`, release it, and import that exact tag with
`node scripts/update-contract.mjs <actera-api-checkout>`, then
`npm run generate:outcomes`. Do not edit the snapshot independently.

## Bundled scanner

Run `node scripts/bundle-gitleaks.mjs` to verify all six bundled platforms.
Maintainers rebuild with Go 1.27.0 and `node scripts/bundle-gitleaks.mjs --build`.
The Go helper uses Gitleaks 8.30.1 as a library, pinned through `scanner/go.mod`
and `scanner/go.sum`. The script builds six targets with CGO disabled, trimmed
paths and no VCS/build ID, then records binary hashes and a hash of the source
inputs. Run `node scripts/scanner-notices.mjs` after rebuilding. Commit the six `.gz`
files, manifest, generated third-party notices, license, and Go sources together.
CI rebuilds with `--verify-build` and compares executable hashes.

`node scripts/benchmark-capture.mjs` measures cold capture, warm capture, and
capture from fresh Node hook processes; see [scanner performance](docs/scanner-performance.md).

Describe changes in `CHANGELOG.md`. Participation is governed by the
[code of conduct](CODE_OF_CONDUCT.md).
