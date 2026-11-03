import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkImports, checkTools, findInstall, hostModules } from "../scripts/compat-check.mjs";

const checker = fileURLToPath(new URL("../scripts/compat-check.mjs", import.meta.url));
const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
// Only absence is optional: malformed/incomplete installed releases must still fail.
function optionalInstall(version) {
	const manifest = path.join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
	return fs.existsSync(manifest) ? findInstall(version) : undefined;
}
const versions = ["1.4.0", "1.5.0"];
const [legacy, modern] = versions.map(optionalInstall);
const available = modern ?? legacy;
const needsLegacy = { skip: legacy ? false : "Pi 1.4.0 is not installed" };
const needsModern = { skip: modern ? false : "Pi 1.5.0 is not installed" };
const needsInstall = { skip: available ? false : "Neither Pi 1.4.0 nor Pi 1.5.0 is installed" };

function fixture(t, source, install = available) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compat-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const workspace = path.join(root, "workspace");
	const dir = path.join(workspace, "fixture");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(agentDir);
	if (install) {
		// Only release discovery reads through this link; config/cache writes stay in the fixture.
		fs.symlinkSync(path.dirname(path.dirname(path.dirname(install.root))), path.join(agentDir, "install"), "dir");
	} else {
		fs.mkdirSync(path.join(agentDir, "install", "releases"), { recursive: true });
	}
	const manifest = { name: "compat-fixture", type: "module", pi: { extensions: ["./index.ts"] } };
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, "index.ts"), source);
	return {
		root, workspace, dir, manifest,
		env: { ...process.env, PI_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", JITI_FS_CACHE: "0" },
	};
}

function runNode(f, args) {
	const result = spawnSync(process.execPath, args, {
		cwd: f.root, env: f.env, encoding: "utf8", timeout: 120_000,
	});
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.signal, null, result.stderr);
	return result;
}

function runChecker(f, install) {
	const result = runNode(f, [checker, "--root", f.workspace, "--pi-release", install.version, "--json"]);
	const report = JSON.parse(result.stdout);
	assert.equal(report.release, install.version);
	assert.equal(report.results.length, 1);
	return { status: result.status, report, checks: report.results[0].checks };
}

function realLoader(f, install) {
	const loaderUrl = pathToFileURL(path.join(path.dirname(install.index), "core/extensions/loader.js")).href;
	const result = runNode(f, ["--input-type=module", "-e", `
		const {loadExtensions} = await import(${JSON.stringify(loaderUrl)});
		const result = await loadExtensions([${JSON.stringify(path.join(f.dir, "index.ts"))}], ${JSON.stringify(f.root)});
		console.log(JSON.stringify({errors: result.errors, tools: result.extensions.flatMap(e => [...e.tools.keys()])}));
	`]);
	assert.equal(result.status, 0, result.stderr);
	const loaded = JSON.parse(result.stdout);
	assert.deepEqual(loaded.errors, []);
	return loaded;
}

function realAliases(f, install) {
	const loaderUrl = pathToFileURL(path.join(path.dirname(install.index), "core/extensions/loader.js")).href;
	// Execute the installed loader's private getAliases(), without modifying the release.
	// The flag preserves ESM import.meta.resolve's exact parent-URL/exports conditions.
	const result = runNode(f, ["--experimental-import-meta-resolve", "--input-type=module", "-e", `
		import fs from 'node:fs';
		import path from 'node:path';
		import {createRequire} from 'node:module';
		import {fileURLToPath} from 'node:url';
		const url = ${JSON.stringify(loaderUrl)};
		const source = fs.readFileSync(fileURLToPath(url), 'utf8');
		const start = source.indexOf('function getAliases()');
		const end = source.indexOf('let extensionCacheCwd;', start);
		if (start < 0 || end < 0) throw new Error('Cannot locate Pi getAliases');
		const body = source.slice(start, end).replaceAll('import.meta', 'meta');
		const get = new Function('fs', 'path', 'require', 'fileURLToPath', 'meta',
			'let _aliases = null; ' + body + '; return getAliases();');
		console.log(JSON.stringify(get(fs, path, createRequire(url), fileURLToPath,
			{url, resolve: specifier => import.meta.resolve(specifier, url)})));
	`]);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

function toolSource(type = "String", imports = "import { Value } from 'typebox/value';", reference = "void Value;") {
	return `import { Type } from 'typebox';
${imports}
export default function(pi) {
	${reference}
	pi.registerTool({
		name: 'fixture_tool', label: 'Fixture', description: 'Regression fixture',
		parameters: Type.Object({value: Type.${type}()}),
		async execute() { return {content: [{type: 'text', text: 'ok'}], details: {}}; },
	});
}
`;
}

function realPaths(aliases) {
	return Object.fromEntries(Object.entries(aliases).map(([specifier, target]) => [specifier, fs.realpathSync(target)]));
}

for (const [i, version] of versions.entries()) {
	const install = [legacy, modern][i];
	test(`checker matches every real Pi ${version} alias and loads valid subpaths`, { skip: install ? false : `Pi ${version} is not installed` }, (t) => {
		const aliases = hostModules(install);
		const imports = Object.keys(aliases).map((specifier, i) => `import * as host${i} from ${JSON.stringify(specifier)};`).join("\n");
		const reference = `void [${Object.keys(aliases).map((_, i) => `host${i}`).join(", ")}];`;
		const f = fixture(t, toolSource("String", imports, reference), install);
		assert.equal(Object.keys(aliases).length, 22);
		assert.deepEqual(realPaths(aliases), realPaths(realAliases(f, install)));
		assert.deepEqual(realLoader(f, install).tools, ["fixture_tool"]);
		const { status, report, checks } = runChecker(f, install);
		assert.equal(status, 0, JSON.stringify(report));
		assert.equal(report.ok, true);
		assert.equal(checks.imports.ok, true);
		assert.equal(checks.imports.detail, "1 names from 22 modules");
		assert.equal(checks.load.ok, true);
		assert.equal(checks.tools.ok, true);
		if (install.version === "1.4.0") assert.match(checks.tools.skipped, /has no pi-schema/);
		else {
			assert.equal(checks.tools.skipped, undefined);
			assert.equal(checks.tools.detail, "1 tools, 1 schemas");
		}
	});
}

test("typebox/value does not hide an incompatible BigInt tool schema behind a successful skip", needsModern, (t) => {
	const f = fixture(t, toolSource("BigInt"));
	assert.deepEqual(realLoader(f, modern).tools, ["fixture_tool"]);
	const { status, report, checks } = runChecker(f, modern);
	assert.equal(status, 1, JSON.stringify(report));
	assert.equal(report.ok, false);
	assert.equal(checks.imports.ok, true);
	assert.equal(checks.imports.detail, "2 names from 2 modules");
	assert.equal(checks.load.ok, true);
	assert.equal(checks.tools.ok, false);
	assert.equal(checks.tools.skipped, undefined);
	assert.equal(checks.tools.detail, "1 tools, 1 schemas");
	assert.ok(checks.tools.problems.some(p => /bigint.*not a JSON Schema type/.test(p)), JSON.stringify(checks));
});

test("Pi 1.4 complete import checks the legacy compat entry, not the core entry", needsLegacy, (t) => {
	const f = fixture(t, "import { complete } from '@earendil-works/pi-ai';\nexport default function() { void complete; }\n", legacy);
	assert.equal(legacy.piAi, path.join(legacy.root, "@earendil-works/pi-ai/dist/compat.js"));
	assert.deepEqual(realLoader(f, legacy).tools, []);
	const { status, report, checks } = runChecker(f, legacy);
	assert.equal(status, 0, JSON.stringify(report));
	assert.equal(report.ok, true);
	assert.equal(checks.imports.ok, true);
	assert.equal(checks.imports.detail, "1 names from 1 modules");
	assert.equal(checks.load.ok, true);
	assert.match(checks.tools.skipped, /Pi 1\.4\.0 has no pi-schema/);
});

test("missing named subpath exports fail the import check", needsInstall, async (t) => {
	const f = fixture(t, "import { DoesNotExist } from 'typebox/value';\nexport default function() { void DoesNotExist; }\n");
	const result = await checkImports(available, f.dir);
	assert.equal(result.ok, false);
	assert.deepEqual(result.problems, [`typebox/value: DoesNotExist is not exported by ${available.version}`]);
});

test("unmapped host imports are errors, including namespace and side-effect imports", needsInstall, async (t) => {
	const f = fixture(t, `import { Missing } from 'typebox/missing';
import * as MissingNamespace from '@mariozechner/pi-ai/missing';
import '@earendil-works/pi-agent-core/missing';
import type { Ignored } from 'typebox/type-only';
export default function() { void Missing; void MissingNamespace; }
`);
	const result = await checkImports(available, f.dir);
	assert.equal(result.ok, false);
	assert.deepEqual(result.problems, [
		`typebox/missing: no extension alias in Pi ${available.version}`,
		`@mariozechner/pi-ai/missing: no extension alias in Pi ${available.version}`,
		`@earendil-works/pi-agent-core/missing: no extension alias in Pi ${available.version}`,
	]);
	const run = runChecker(f, available);
	assert.equal(run.status, 1, JSON.stringify(run.report));
	assert.equal(run.checks.imports.ok, false);
	assert.deepEqual(run.checks.imports.problems, result.problems);
	if (available.version === "1.4.0") {
		assert.deepEqual(run.checks.tools, { ok: true, skipped: "Pi 1.4.0 has no pi-schema" });
	} else {
		assert.equal(run.checks.tools.ok, false);
		assert.equal(run.checks.tools.skipped, undefined);
		assert.match(run.checks.tools.problems.join("\n"), /could not inspect tools:/);
	}
});

test("module resolution and factory exceptions fail tools rather than requiring a live session", needsModern, async (t) => {
	for (const [label, source, message] of [
		["missing module", "import { missing } from './missing.js';\nexport default function() { void missing; }\n", /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/],
		["factory error", "export default function() { throw new Error('fixture factory failed'); }\n", /fixture factory failed/],
		["non-Error throw", "export default function() { throw 'fixture non-Error'; }\n", /fixture non-Error/],
		["invalid factory", "export default {};\n", /entry has no default factory/],
	]) {
		await t.test(label, (sub) => {
			const f = fixture(sub, source);
			const run = runChecker(f, modern);
			assert.equal(run.status, 1, JSON.stringify(run.report));
			assert.equal(run.checks.tools.ok, false);
			assert.equal(run.checks.tools.skipped, undefined);
			assert.match(run.checks.tools.problems.join("\n"), message);
		});
	}
});

test("missing jiti is a modern harness failure", needsModern, async (t) => {
	const f = fixture(t, "export default function() {}\n", modern);
	const missingJiti = path.join(f.root, "missing-jiti.mjs");
	const failure = await checkTools({ ...modern, jiti: missingJiti }, f.dir, f.manifest);
	assert.equal(failure.ok, false);
	assert.equal(failure.skipped, undefined);
	assert.deepEqual(failure.problems, ["no jiti in this release"]);
});

test("pre-1.5 pi-schema remains an intentional skip, even without jiti", needsLegacy, async (t) => {
	const f = fixture(t, "export default function() {}\n", legacy);
	const missingJiti = path.join(f.root, "missing-jiti.mjs");
	const result = await checkTools({ ...legacy, jiti: missingJiti }, f.dir, f.manifest);
	assert.deepEqual(result, { ok: true, skipped: "Pi 1.4.0 has no pi-schema" });
});

test("symlinked checker execution reports unavailable releases without running on import", (t) => {
	const f = fixture(t, "export default function() {}\n");
	const link = path.join(f.root, "compat-link.mjs");
	fs.symlinkSync(checker, link);
	const args = ["--pi-release", "0.0.0-does-not-exist"];
	const direct = runNode(f, [checker, ...args]);
	const linked = runNode(f, [link, ...args]);
	assert.equal(direct.status, 2, direct.stderr);
	assert.equal(linked.status, 2, linked.stderr);
	assert.equal(linked.stdout, "");
	assert.match(linked.stderr, /compat-check: (?:Pi 0\.0\.0-does-not-exist is not installed|No Pi releases under)/);
	assert.equal(linked.stderr, direct.stderr);

	const importer = path.join(f.root, "import-checker.mjs");
	fs.writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(checker).href)});\nawait import(${JSON.stringify(pathToFileURL(link).href)});\nconsole.log('import safe');\n`);
	const imported = runNode(f, [importer, ...args]);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout, "import safe\n");
	assert.equal(imported.stderr, "");
});
