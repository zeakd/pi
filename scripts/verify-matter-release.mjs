#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installCodingAgentConsumer, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

import { verifyHttpConsumer } from "./verify-matter-http.mjs";

const directory = realpathSync(resolve(process.argv[2] ?? ".artifacts/matter-release"));
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
const tarballs = new Map(manifest.packages.map((pkg) => {
	const path = join(directory, pkg.filename);
	assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), pkg.sha256, pkg.name);
	return [pkg.name, path];
}));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-matter-consumer-")));

function checkGraph(consumer) {
	const found = new Map();
	const seen = new Set();
	function visit(modules) {
		if (!existsSync(modules)) return;
		for (const name of readdirSync(modules)) {
			if (name.startsWith(".")) continue;
			const entries = name.startsWith("@") ? readdirSync(join(modules, name)).map((child) => join(name, child)) : [name];
			for (const entry of entries) {
				const path = realpathSync(join(modules, entry));
				if (seen.has(path) || !existsSync(join(path, "package.json"))) continue;
				seen.add(path);
				const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
				if (tarballs.has(pkg.name)) {
					assert.equal(pkg.version, manifest.version, `${pkg.name}: official/fork versions mixed`);
					assert.equal(pkg.piFork?.sourceSha, manifest.sourceSha, `${pkg.name}: source differs`);
					found.set(pkg.name, (found.get(pkg.name) ?? 0) + 1);
				}
				visit(join(path, "node_modules"));
			}
		}
	}
	visit(join(consumer, "node_modules"));
	for (const name of tarballs.keys()) assert.equal(found.get(name), 1, `${name}: must be installed exactly once`);
}

try {
	const npmConsumer = join(temporary, "npm");
	installCodingAgentConsumer(npmConsumer, tarballs);
	checkGraph(npmConsumer);
	smokeTestCodingAgentConsumer(npmConsumer);
	const bunConsumer = join(temporary, "bun");
	installCodingAgentConsumer(bunConsumer, tarballs, "bun");
	checkGraph(bunConsumer);
	execFileSync("bun", ["install", "--ignore-scripts"], { cwd: bunConsumer, stdio: "inherit" });
	const lock = readFileSync(join(bunConsumer, "bun.lock"), "utf8");
	rmSync(join(bunConsumer, "node_modules"), { recursive: true });
	execFileSync("bun", ["install", "--production", "--frozen-lockfile", "--ignore-scripts"], { cwd: bunConsumer, stdio: "inherit" });
	assert.equal(readFileSync(join(bunConsumer, "bun.lock"), "utf8"), lock);
	checkGraph(bunConsumer);
	const entry = join(bunConsumer, "sdk.mjs");
	writeFileSync(entry, `import assert from 'node:assert/strict';
import { createAgentSession, SessionManager, ModelRuntime } from '@earendil-works/pi-coding-agent';
assert.equal(typeof createAgentSession, 'function');
assert.equal(typeof SessionManager.inMemory, 'function');
assert.equal(typeof ModelRuntime.create, 'function');
`);
	const env = { PATH: process.env.PATH, HOME: bunConsumer, PI_CODING_AGENT_DIR: join(bunConsumer, ".pi"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
	execFileSync("bun", [entry], { cwd: bunConsumer, env, stdio: "inherit" });
	// Pi's bundled Node CLI has a different runtime contract; Matter imports the unbundled SDK under Bun.
	const version = execFileSync("bun", [join(bunConsumer, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--version"], { env, encoding: "utf8" }).trim();
	assert.equal(version, manifest.version);
	await verifyHttpConsumer(directory, temporary, manifest, checkGraph);
	console.log(`Verified ${tarballs.size} fork packages: npm/Node, Bun SDK, one instance each, frozen production reinstall.`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
