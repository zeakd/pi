#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryDigest } from "./matter-release.mjs";

const config = JSON.parse(readFileSync("matter-upstream.json", "utf8"));
assert.match(config.version, /^\d+\.\d+\.\d+$/);
assert.equal(JSON.parse(readFileSync("packages/ai/package.json", "utf8")).version, config.version);
assert.equal(config.sourceArchive, `https://github.com/earendil-works/pi/releases/download/v${config.version}/pi-${config.version}-source.tar.gz`);
assert.match(config.sha256, /^[a-f0-9]{64}$/);
assert.match(config.commit, /^[a-f0-9]{40}$/);
execFileSync("git", ["merge-base", "--is-ancestor", config.commit, "HEAD"]);
const response = await fetch(config.sourceArchive);
if (!response.ok) throw new Error(`Source archive download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(bytes).digest("hex"), config.sha256, "Upstream source archive checksum mismatch");
const temporary = mkdtempSync(join(tmpdir(), "pi-matter-models-"));
try {
	const archive = join(temporary, "source.tar.gz");
	writeFileSync(archive, bytes);
	const directory = `pi-${config.version}/packages/ai/src/providers/data`;
	execFileSync("tar", ["-xzf", archive, "-C", temporary, directory]);
	assert.equal(directoryDigest(join(temporary, directory)), config.modelDataSha256, "Pinned model catalog mismatch");
	const target = "packages/ai/src/providers/data";
	rmSync(target, { recursive: true, force: true });
	cpSync(join(temporary, directory), target, { recursive: true });
	execFileSync("npm", ["run", "check:model-data"], { stdio: "inherit" });
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
