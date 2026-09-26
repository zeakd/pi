#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packReleasePackages } from "./coding-agent-consumer.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

export function releaseVersion(tag, upstreamVersion) {
	const match = /^matter-(\d+\.\d+\.\d+)-([1-9]\d*)$/.exec(tag);
	if (!match || match[1] !== upstreamVersion) throw new Error(`Expected matter-${upstreamVersion}-N (N >= 1)`);
	return `${match[1]}-matter.${match[2]}`;
}

export function runtimePackages(catalog, roots) {
	const selected = new Map();
	const visiting = new Set();
	function visit(name) {
		if (selected.has(name)) return;
		if (visiting.has(name)) throw new Error(`Workspace dependency cycle: ${name}`);
		const pkg = catalog.get(name);
		if (!pkg) throw new Error(`Missing public workspace: ${name}`);
		visiting.add(name);
		for (const dep of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies })) {
			if (catalog.has(dep)) visit(dep);
		}
		visiting.delete(name);
		selected.set(name, pkg);
	}
	for (const name of roots) visit(name);
	return [...selected.values()];
}

export function stageManifest(manifest, version, urls, sourceSha) {
	const staged = structuredClone(manifest);
	staged.version = version;
	staged.piFork = { repository: "zeakd/pi", sourceSha, upstreamVersion: manifest.version };
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const name of Object.keys(staged[field] ?? {})) {
			if (urls[name]) staged[field][name] = version;
		}
	}
	delete staged.devDependencies;
	if (staged.files) staged.files = staged.files.filter((file) => file !== "npm-shrinkwrap.json");
	return staged;
}

export function packMatterRelease(tag, output) {
	const catalog = new Map(getPublicWorkspacePackages().map((pkg) => [pkg.name, {
		...pkg, manifest: JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8")),
	}]));
	const packages = runtimePackages(catalog, ["@earendil-works/pi-coding-agent"]);
	const upstreamVersion = catalog.get("@earendil-works/pi-coding-agent").version;
	const version = releaseVersion(tag, upstreamVersion);
	const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const names = Object.fromEntries(packages.map((pkg) => [pkg.name, `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`]));
	const urls = Object.fromEntries(Object.entries(names).map(([name, file]) => [name, `https://github.com/zeakd/pi/releases/download/${tag}/${file}`]));
	const destination = resolve(output);
	if (existsSync(destination)) throw new Error(`Output already exists: ${destination}`);
	mkdirSync(destination, { recursive: true });
	const temporary = mkdtempSync(join(tmpdir(), "pi-matter-pack-"));
	const upstream = JSON.parse(readFileSync("matter-upstream.json", "utf8"));
	if (upstream.version !== upstreamVersion) throw new Error("Update matter-upstream.json with the selected upstream release");
	const manifest = { schema: 1, tag, version, upstreamVersion, sourceSha, upstream, packages: [] };
	try {
		const originals = packReleasePackages(packages, join(temporary, "originals"));
		for (const pkg of packages) {
			if (pkg.version !== upstreamVersion) throw new Error(`Workspace version mismatch: ${pkg.name}`);
			const stage = join(temporary, pkg.name.replaceAll("/", "-"));
			mkdirSync(stage);
			execFileSync("tar", ["-xzf", originals.get(pkg.name), "-C", stage]);
			const directory = join(stage, "package");
			const staged = stageManifest(pkg.manifest, version, urls, sourceSha);
			writeFileSync(join(directory, "package.json"), `${JSON.stringify(staged, null, "\t")}\n`);
			// The SDK consumer owns its installation lock. The upstream shrinkwrap resolves official npm packages.
			rmSync(join(directory, "npm-shrinkwrap.json"), { force: true });
			const packed = packReleasePackages([{ name: pkg.name, directory }], destination).get(pkg.name);
			const bytes = readFileSync(packed);
			manifest.packages.push({ name: pkg.name, filename: names[pkg.name], url: urls[pkg.name],
				sha256: createHash("sha256").update(bytes).digest("hex"),
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
		}
		// Preserve the pinned catalog used by this build alongside the package artifacts.
		execFileSync("tar", ["-czf", join(destination, "model-data.tar.gz"), "-C", "packages/ai/src/providers", "data"]);
		writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		writeFileSync(join(destination, "consumer.json"), `${JSON.stringify({
			dependencies: Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-tui"].map((name) => [`@earendil-works/${name}`, urls[`@earendil-works/${name}`]])),
			overrides: urls,
		}, null, 2)}\n`);
		const files = [...Object.values(names), "model-data.tar.gz", "manifest.json", "consumer.json"];
		writeFileSync(join(destination, "SHA256SUMS"), files.map((file) => `${createHash("sha256").update(readFileSync(join(destination, file))).digest("hex")}  ${file}\n`).join(""));
		return manifest;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 4) throw new Error("Usage: node scripts/matter-release.mjs <matter-X.Y.Z-N> <new-output-directory>");
	console.log(JSON.stringify(packMatterRelease(process.argv[2], process.argv[3]), null, 2));
}
