import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export async function verifyHttpConsumer(directory, temporary, manifest, checkGraph) {
	const assets = join(temporary, "http-assets");
	const consumer = join(temporary, "http-consumer");
	mkdirSync(assets);
	mkdirSync(consumer);
	for (const pkg of manifest.packages) copyFileSync(join(directory, pkg.filename), join(assets, pkg.filename));
	const server = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads');
		const { createServer } = require('node:http');
		const { readFile } = require('node:fs');
		const { join, basename } = require('node:path');
		createServer((req, res) => {
			readFile(join(workerData, basename(new URL(req.url, 'http://localhost').pathname)), (error, data) => {
				res.writeHead(error ? 404 : 200);
				res.end(error ? 'missing' : data);
			});
		}).listen(0, '127.0.0.1', function () { parentPort.postMessage(this.address().port); });
	`, { eval: true, workerData: assets });
	try {
		const port = await new Promise((resolve, reject) => { server.once("message", resolve); server.once("error", reject); });
		const config = JSON.parse(readFileSync(join(directory, "consumer.json"), "utf8"));
		for (const field of ["dependencies", "overrides"]) {
			for (const [name, url] of Object.entries(config[field])) {
				const original = new URL(url);
				assert.equal(original.origin, "https://github.com");
				const pkg = manifest.packages.find((entry) => entry.name === name);
				assert.ok(pkg, `Unknown consumer package: ${name}`);
				assert.equal(original.pathname, `/zeakd/pi/releases/download/${manifest.tag}/${pkg.filename}`);
				config[field][name] = `http://127.0.0.1:${port}${original.pathname}`;
			}
		}
		writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, ...config }));
		const env = { ...process.env, BUN_INSTALL_CACHE_DIR: join(temporary, "http-cache") };
		const args = ["install", "--ignore-scripts"];
		execFileSync("bun", args, { cwd: consumer, env, stdio: "inherit" });
		checkGraph(consumer);
		const lock = readFileSync(join(consumer, "bun.lock"), "utf8");
		for (const pkg of manifest.packages) assert.ok(lock.includes(pkg.integrity), `${pkg.name}: lockfile must pin tarball integrity`);
		rmSync(join(consumer, "node_modules"), { recursive: true });
		execFileSync("bun", [...args, "--production", "--frozen-lockfile"], { cwd: consumer, env, stdio: "inherit" });
		assert.equal(readFileSync(join(consumer, "bun.lock"), "utf8"), lock);
		checkGraph(consumer);
		rmSync(join(consumer, "node_modules"), { recursive: true });
		assert.ok(manifest.packages.length > 1);
		copyFileSync(join(assets, manifest.packages[1].filename), join(assets, manifest.packages[0].filename));
		const rejected = spawnSync("bun", [...args, "--production", "--frozen-lockfile"], {
			cwd: consumer, env: { ...env, BUN_INSTALL_CACHE_DIR: join(temporary, "tamper-cache") }, encoding: "utf8",
		});
		assert.notEqual(rejected.status, 0, "Modified tarball must be rejected");
		assert.match(`${rejected.stdout}${rejected.stderr}`, /IntegrityCheckFailed|integrity check failed/i);
		console.log("Verified HTTP release URLs, lockfile integrity, frozen install and tampered asset rejection.");
	} finally {
		await server.terminate();
	}
}
