#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyReleaseAssets(assets, checksums) {
	assert.deepEqual(assets.map((asset) => asset.name).sort(), Object.keys(checksums).sort(), "Release asset set mismatch");
	for (const asset of assets) assert.equal(asset.digest, `sha256:${checksums[asset.name]}`, `Uploaded asset digest mismatch: ${asset.name}`);
}

function publish(directory) {
	assert.equal(process.env.GH_REPO, "zeakd/pi");
	const tag = process.env.RELEASE_TAG;
	const sha = process.env.GITHUB_SHA;
	assert.match(tag ?? "", /^matter-\d+\.\d+\.\d+-[1-9]\d*$/);
	assert.match(sha ?? "", /^[a-f0-9]{40}$/);
	const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
	assert.equal(manifest.tag, tag);
	assert.equal(manifest.sourceSha, sha);
	const checksums = {};
	for (const line of readFileSync(join(directory, "SHA256SUMS"), "utf8").trim().split("\n")) {
		const [hash, filename] = line.split(/\s+/);
		assert.match(hash, /^[a-f0-9]{64}$/);
		assert.equal(basename(filename), filename);
		assert.equal(createHash("sha256").update(readFileSync(join(directory, filename))).digest("hex"), hash, filename);
		assert.equal(checksums[filename], undefined);
		checksums[filename] = hash;
	}
	assert.deepEqual(Object.keys(checksums).sort(), [...manifest.packages.map((pkg) => pkg.filename), "model-data.tar.gz", "manifest.json", "consumer.json"].sort());
	checksums.SHA256SUMS = createHash("sha256").update(readFileSync(join(directory, "SHA256SUMS"))).digest("hex");
	const gh = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
	const api = (path) => JSON.parse(gh(["api", `repos/zeakd/pi/${path}`]));
	const assertTag = () => assert.equal(api(`commits/${tag}`).sha, sha, "Release tag moved since verification");
	assertTag();
	// Creation fails on an existing release; no overwrite or automatic recovery path is used.
	const notes = join(directory, "RELEASE_NOTES.md");
	writeFileSync(notes, `Matter SDK ${manifest.version}\n\nUpstream: ${manifest.upstreamVersion}\nSource: ${sha}\n\nUse consumer.json for dependency URLs and root overrides. SHA256SUMS covers the package set and build catalog. The consumer owns its installation lockfile. No npm packages are published.\n`);
	gh(["release", "create", tag, "--verify-tag", "--draft", "--prerelease", "--title", tag, "--notes-file", notes,
		...Object.keys(checksums).map((file) => join(directory, file))]);
	const id = gh(["release", "view", tag, "--json", "databaseId", "--jq", ".databaseId"]);
	const draft = api(`releases/${id}`);
	assert.equal(draft.draft, true);
	verifyReleaseAssets(draft.assets, checksums);
	assertTag();
	gh(["release", "edit", tag, "--draft=false", "--latest=false"]);
	const published = api(`releases/${id}`);
	assert.equal(published.draft, false);
	assert.equal(published.immutable, true, "Enable immutable releases before publishing");
	verifyReleaseAssets(published.assets, checksums);
	assertTag();
	console.log(published.html_url);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3) throw new Error("Usage: node scripts/publish-matter-release.mjs <release-directory>");
	publish(resolve(process.argv[2]));
}
