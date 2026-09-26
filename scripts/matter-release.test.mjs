import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseVersion, runtimePackages, stageManifest } from "./matter-release.mjs";
import { verifyReleaseAssets } from "./publish-matter-release.mjs";

test("publishing rejects replaced, missing and extra assets", () => {
	const hashes = { "package.tgz": "a".repeat(64) };
	const asset = { name: "package.tgz", digest: `sha256:${hashes["package.tgz"]}` };
	verifyReleaseAssets([asset], hashes);
	assert.throws(() => verifyReleaseAssets([{ ...asset, digest: `sha256:${"b".repeat(64)}` }], hashes));
	assert.throws(() => verifyReleaseAssets([], hashes));
	assert.throws(() => verifyReleaseAssets([asset, { name: "extra", digest: asset.digest }], hashes));
});

test("release identity must match the upstream package version", () => {
	assert.equal(releaseVersion("matter-0.87.1-2", "0.87.1"), "0.87.1-matter.2");
	for (const tag of ["v0.87.1", "matter-0.87.2-1", "matter-0.87.1-0", "matter-0.87.1-01", "matter-0.87.1-1/other"]) {
		assert.throws(() => releaseVersion(tag, "0.87.1"));
	}
});

test("runtime closure includes shared transitive packages and excludes development packages", () => {
	const catalog = new Map([
		["app", { name: "app", manifest: { dependencies: { core: "1", view: "1", external: "1" }, devDependencies: { dev: "1" } } }],
		["core", { name: "core", manifest: { dependencies: { common: "1" } } }],
		["view", { name: "view", manifest: { optionalDependencies: { common: "1" } } }],
		["common", { name: "common", manifest: {} }],
		["dev", { name: "dev", manifest: {} }],
	]);
	assert.deepEqual(runtimePackages(catalog, ["app"]).map((pkg) => pkg.name), ["common", "core", "view", "app"]);
	catalog.get("common").manifest.dependencies = { app: "1" };
	assert.throws(() => runtimePackages(catalog, ["app"]), /cycle/);
});

test("staging redirects internal dependencies and leaves source manifests unchanged", () => {
	const source = { name: "app", version: "1.2.3", files: ["dist", "npm-shrinkwrap.json"],
		dependencies: { core: "^1.2.3", external: "2.0.0" }, optionalDependencies: { core: "^1.2.3" },
		devDependencies: { dev: "1" } };
	const before = structuredClone(source);
	const staged = stageManifest(source, "1.2.3-matter.1", { core: "https://example.test/core.tgz" }, "a".repeat(40));
	assert.deepEqual(source, before);
	assert.equal(staged.dependencies.core, "1.2.3-matter.1");
	assert.equal(staged.optionalDependencies.core, staged.dependencies.core);
	assert.equal(staged.dependencies.external, "2.0.0");
	assert.deepEqual(staged.files, ["dist"]);
	assert.equal(staged.devDependencies, undefined);
	assert.equal(staged.piFork.upstreamVersion, "1.2.3");
});
