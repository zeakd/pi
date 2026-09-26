# Matter's Pi SDK distribution

`main` mirrors upstream. `matter/main` integrates the SDK patches and release tooling used by Matter. Individual fixes are developed in task worktrees and can be proposed upstream independently. Update branches merge a selected upstream release into `matter/main`, re-evaluate each patch and run the SDK and Matter consumer checks before integration.

## Release

Push a tag `matter-X.Y.Z-N` on a tested commit already merged into `matter/main`. `X.Y.Z` must equal the upstream coding-agent package version; `N` starts at 1 and increases for each fork release. The package version is `X.Y.Z-matter.N`.

For example, `matter-0.87.1-1` produces `0.87.1-matter.1` packages. The Matter SDK workflow tests and builds that commit, installs the packed packages with npm and Bun, then publishes a GitHub prerelease. Branch pushes and PRs targeting `matter/main` verify without publishing. The tag trigger keeps the workflow off the upstream mirror and avoids upstream's `v*` publishing trigger.

Repository setup: enable immutable releases and disable the inherited Build Binaries and Publish Model Catalog workflows in the fork's Actions settings. These settings preserve the mirrored files. This workflow needs only GitHub's repository token, not npm or upstream service credentials.

The release contains the coding-agent runtime dependency closure (currently coding-agent, agent-core, ai, tui, chord and telemetry), `manifest.json`, `consumer.json`, `SHA256SUMS`, and the model catalog used for the build. `matter-upstream.json` pins the upstream commit and source archive checksum. Preparation extracts the release's catalog from that verified archive, avoiding a live catalog refresh. Update this file together with each upstream upgrade. Model catalog changes are an explicit build-input change.

Packaging starts from upstream's `npm pack` file set. Only staged manifests change: fork version, source identity, exact internal fork versions and development metadata. Root consumer overrides map those versions to release URLs. All six overrides are required: these fork versions are not published to npm. This also supports pre-publication local artifact verification under Bun 1.3.14, whose overrides do not replace URL dependencies. The coding-agent npm shrinkwrap is excluded because it pins official registry packages. Consumers must commit their installation lockfile. Source manifests, the monorepo lockfile and upstream changelogs remain unchanged.

Local verification after `npm ci --ignore-scripts`, `node scripts/matter-model-data.mjs`, and `npm run build:offline`:

```sh
npm run check
node --test scripts/matter-release.test.mjs
./test.sh
node scripts/matter-release.mjs matter-0.87.1-1 .artifacts/matter-release
node scripts/verify-matter-release.mjs .artifacts/matter-release
```

Use a new output directory for each packaging attempt. The verifier checks npm/Node SDK and CLI startup, Bun SDK and unbundled CLI startup, source/version identity, one installed instance per fork package, and a frozen production reinstall. The bundled Node CLI is not a Bun CLI distribution. These checks do not call a model provider.

## Matter adoption

Take the three direct dependency URLs and six root overrides from `consumer.json`; update matching workspace dependency declarations to the same URLs. Regenerate and commit Matter's Bun lockfile. Validate the release checksums when adopting the version, then run Matter's verification and production package installation checks. Published assets and tags are immutable; any correction receives a new fork release number.

Pi release and Matter adoption are separate operations. Publishing Pi does not change an installed Matter version. The initial SDK release does not include the pending cancellation, disposition or queue-recovery patches.

## Recovery

A failed build publishes nothing. A failed upload leaves a draft for inspection. The workflow refuses to replace an existing release. For an incomplete draft, inspect the tag and uploaded assets, then explicitly remove that draft before retrying the same tag's workflow. Published releases are never replaced. If code must change, use a new commit and release number.
