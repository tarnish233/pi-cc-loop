#!/usr/bin/env node
/**
 * Compatibility check against a Pi release: what still resolves, loads and validates.
 *
 * Pi 1.5.0 moved tool-argument validation to `@earendil-works/pi-schema` and stopped
 * re-exporting TypeBox from pi-ai; later releases will move other things. This script
 * checks the extensions in this workspace against one installed Pi release:
 *
 *   1. imports  every runtime import from a Pi package (or typebox) still exists;
 *   2. load     `pi --extension <package> --help` loads it without errors;
 *   3. tools    every registered tool schema compiles in Pi's validator and stays
 *               inside JSON Schema, and no source uses Type.Refine/Codec/BigInt/
 *               Undefined/Void or Format.Set() (features tool arguments silently lose);
 *   4. themes   every theme in package.json `pi.themes` passes Pi's theme schema.
 *
 * The checks degrade gracefully on releases that predate a module (pi-schema arrived
 * in 1.5.0), and say so instead of failing.
 *
 *   node scripts/compat-check.mjs
 *   node scripts/compat-check.mjs --pi-release 1.4.0
 *   node scripts/compat-check.mjs --root .. --json
 *
 * Exit code: 0 all checks passed, 1 a check failed, 2 the check itself could not run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const options = {
		root: path.resolve(here, "..", ".."),
		piRelease: undefined,
		json: false,
		verbose: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const next = argv[++i];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--root") options.root = path.resolve(value());
		else if (arg === "--pi-release") options.piRelease = value();
		else if (arg === "--json") options.json = true;
		else if (arg === "--verbose" || arg === "-v") options.verbose = true;
		else if (arg === "--help" || arg === "-h") {
			console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
			process.exit(0);
		} else throw new Error(`Unknown option ${arg}`);
	}
	return options;
}

// ---------------------------------------------------------------- the install

function releasesDir() {
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "install", "releases");
}

/** The installed Pi release to check against: the named one, or the newest. */
export function findInstall(version) {
	const dir = releasesDir();
	const versions = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
		.filter((name) => fs.existsSync(path.join(dir, name, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	if (!versions.length) throw new Error(`No Pi releases under ${dir}. Install Pi, or set PI_AGENT_DIR.`);
	const picked = version === undefined ? versions[versions.length - 1] : versions.find((name) => name === version);
	if (picked === undefined) {
		throw new Error(`Pi ${version} is not installed under ${dir}. Installed: ${versions.join(", ")}`);
	}
	const root = path.join(dir, picked, "node_modules");
	const packageDir = path.join(root, "@earendil-works", "pi-coding-agent");
	const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	const require = createRequire(path.join(packageDir, "dist", "index.js"));
	const extensionView = path.join(packageDir, "dist", "core", "extensions", "pi-ai-extension-view.js");
	const legacyCompat = path.join(root, "@earendil-works", "pi-ai", "dist", "compat.js");
	return {
		version: picked,
		root,
		index: path.join(packageDir, "dist", "index.js"),
		cli: bin === undefined ? undefined : path.join(packageDir, bin),
		// Match Pi's extension loader: 1.5+ uses its extension view; 1.4 uses compat.
		piAi: fs.existsSync(extensionView)
			? extensionView
			: fs.existsSync(legacyCompat) ? legacyCompat : path.join(root, "@earendil-works", "pi-ai", "dist", "index.js"),
		piAiModels: path.join(root, "@earendil-works", "pi-ai", "dist", "models.js"),
		piAiOauth: path.join(root, "@earendil-works", "pi-ai", "dist", "oauth.js"),
		piAiProviders: path.join(root, "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
		piAgentCore: path.join(root, "@earendil-works", "pi-agent-core", "dist", "index.js"),
		piTui: path.join(root, "@earendil-works", "pi-tui", "dist", "index.js"),
		piSchema: path.join(root, "@earendil-works", "pi-schema", "dist", "index.js"),
		themeSchema: path.join(packageDir, "dist", "modes", "interactive", "theme", "theme-schema.js"),
		typebox: require.resolve("typebox"),
		typeboxCompile: require.resolve("typebox/compile"),
		typeboxValue: require.resolve("typebox/value"),
		jiti: path.join(root, "jiti", "lib", "jiti.mjs"),
	};
}

// ------------------------------------------------------------- schema details

/** The `type` values JSON Schema has, and so Pi's validator: TypeBox can build more. */
const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** Formats Pi's validator checks: a `Format.Set()` format is only an annotation. */
const PI_SCHEMA_FORMATS = new Set([
	"date",
	"date-time",
	"duration",
	"email",
	"hostname",
	"idn-email",
	"idn-hostname",
	"ipv4",
	"ipv6",
	"iri",
	"iri-reference",
	"json-pointer",
	"json-pointer-uri-fragment",
	"regex",
	"relative-json-pointer",
	"time",
	"uri",
	"uri-reference",
	"uri-template",
	"url",
	"uuid",
]);

/** What a tool schema means to TypeBox but not to JSON Schema, and so not to Pi. */
function schemaProblems(schema, where) {
	const problems = [];
	const seen = new Set();
	const visit = (node, at) => {
		if (node === null || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) {
			node.forEach((item, index) => visit(item, `${at}/${index}`));
			return;
		}
		if (node.type !== undefined) {
			for (const type of Array.isArray(node.type) ? node.type : [node.type]) {
				if (typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type)) {
					problems.push(`${at}/type: ${JSON.stringify(type)} is not a JSON Schema type`);
				}
			}
		}
		if (typeof node.format === "string" && !PI_SCHEMA_FORMATS.has(node.format)) {
			problems.push(`${at}/format: ${node.format} is not a format Pi checks`);
		}
		for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
			const map = node[key];
			if (map && typeof map === "object" && !Array.isArray(map)) {
				for (const [name, sub] of Object.entries(map)) visit(sub, `${at}/${key}/${name}`);
			}
		}
		for (const key of [
			"items",
			"additionalProperties",
			"not",
			"contains",
			"if",
			"then",
			"else",
			"propertyNames",
			"unevaluatedProperties",
			"unevaluatedItems",
		]) {
			visit(node[key], `${at}/${key}`);
		}
		for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
			if (Array.isArray(node[key])) node[key].forEach((sub, index) => visit(sub, `${at}/${key}/${index}`));
		}
	};
	visit(schema, where);
	return problems;
}

/** TypeBox features Pi's validator ignores: refinements run nowhere, and the rest cannot be JSON. */
const IGNORED_TYPEBOX = /\bType\.(Refine|BigInt|Undefined|Void|Codec)\s*\(|\bFormat\.Set\s*\(/;

// ------------------------------------------------------------------ the checks

/** The host packages an extension may import, as the path Pi aliases them to. */
export function hostModules(install) {
	const modules = {};
	for (const scope of ["@earendil-works", "@mariozechner"]) {
		modules[`${scope}/pi-coding-agent`] = install.index;
		modules[`${scope}/pi-agent-core`] = install.piAgentCore;
		modules[`${scope}/pi-tui`] = install.piTui;
		modules[`${scope}/pi-ai/providers/all`] = install.piAiProviders;
		modules[`${scope}/pi-ai/compat`] = install.piAi;
		modules[`${scope}/pi-ai/models`] = install.piAiModels;
		modules[`${scope}/pi-ai/oauth`] = install.piAiOauth;
		modules[`${scope}/pi-ai`] = install.piAi;
	}
	for (const name of ["typebox", "@sinclair/typebox"]) {
		modules[name] = install.typebox;
		modules[`${name}/compile`] = install.typeboxCompile;
		modules[`${name}/value`] = install.typeboxValue;
	}
	return modules;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([\s\S]*?)\}|\*\s*(?:as\s+[\w$]+)?)?\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const HOST_IMPORT_RE = /^(?:@(?:earendil-works|mariozechner)\/pi-[^/]+|(?:@sinclair\/)?typebox)(?:\/|$)/;

/** Every `.ts` source of the extension, minus the tests. */
function sourceFiles(dir) {
	return fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts") && !name.split(path.sep).some((part) => part === "node_modules" || part === "tests"))
		.map((name) => ({ name, source: fs.readFileSync(path.join(dir, name), "utf8") }));
}

/** Runtime names imported from each host package, by specifier. */
function hostImports(dir, modules) {
	const found = new Map();
	for (const { name, source } of sourceFiles(dir)) {
		for (const match of source.matchAll(IMPORT_RE)) {
			const [, typeOnly, defaultImport, braces, fromSpecifier, sideEffectSpecifier] = match;
			const specifier = fromSpecifier ?? sideEffectSpecifier;
			if (typeOnly || (!(specifier in modules) && !HOST_IMPORT_RE.test(specifier))) continue;
			const names = found.get(specifier) ?? new Set();
			if (defaultImport) names.add("default");
			for (const part of (braces ?? "").split(",")) {
				const raw = part.trim();
				if (!raw || /^type\s/.test(raw) || raw.startsWith("*")) continue;
				const imported = raw.split(/\s+as\s+/)[0].trim();
				if (imported) names.add(imported);
			}
			found.set(specifier, names);
		}
	}
	return found;
}

export async function checkImports(install, dir) {
	const modules = hostModules(install);
	const problems = [];
	let names = 0;
	let packageCount = 0;
	for (const [specifier, imported] of hostImports(dir, modules)) {
		const target = modules[specifier];
		if (target === undefined) {
			problems.push(`${specifier}: no extension alias in Pi ${install.version}`);
			continue;
		}
		if (!fs.existsSync(target)) {
			problems.push(`${specifier}: not in ${install.version} (${path.relative(install.root, target)})`);
			continue;
		}
		const namespace = await import(pathToFileURL(target).href);
		packageCount++;
		for (const name of imported) {
			names++;
			if (!(name in namespace)) problems.push(`${specifier}: ${name} is not exported by ${install.version}`);
		}
	}
	return { ok: problems.length === 0, detail: `${names} names from ${packageCount} modules`, problems };
}

export function checkLoad(install, dir) {
	if (install.cli === undefined || !fs.existsSync(install.cli)) {
		return { ok: true, skipped: `Pi ${install.version} has no runnable CLI` };
	}
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compat-"));
	let result;
	try {
		result = spawnSync(process.execPath, [install.cli, "--extension", dir, "--help"], {
			cwd,
			env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
			encoding: "utf8",
			timeout: 120_000,
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const problems = [];
	if (result.error) problems.push(result.error.message);
	if (result.status !== 0) problems.push(`exit code ${result.status}`);
	for (const line of output.split("\n")) {
		if (/Failed to load extension|Error loading extension/i.test(line)) problems.push(line.trim());
	}
	return { ok: problems.length === 0, detail: `pi --extension ${path.basename(dir)} --help`, problems };
}

/** A Pi API that records tools and ignores everything else. */
function recordingPi(tools, log) {
	const noop = () => noop;
	const events = { on: noop, off: noop, emit: noop };
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (property === "registerTool") return (tool) => tools.push(tool);
				if (property === "events") return events;
				if (property === "getAllTools" || property === "getTools") return () => [];
				if (typeof property === "string" && ["registerCommand", "on", "registerToolRenderer"].includes(property)) {
					return (...args) => log.push(`${property}:${String(args[0])}`);
				}
				return noop;
			},
		},
	);
}

export async function checkTools(install, dir, manifest) {
	const schemaPath = install.piSchema;
	if (!fs.existsSync(schemaPath)) return { ok: true, skipped: `Pi ${install.version} has no pi-schema` };
	const entry = manifest.pi?.extensions?.[0];
	if (entry === undefined) return { ok: true, skipped: "no pi.extensions entry" };
	if (!fs.existsSync(install.jiti)) return { ok: false, detail: "tool inspection failed", problems: ["no jiti in this release"] };

	const tools = [];
	try {
		const jail = await import(pathToFileURL(install.jiti).href);
		const specifier = pathToFileURL(path.join(dir, entry)).href;
		const jiti = jail.createJiti(specifier, { interopDefault: true, alias: hostModules(install) });
		const module = await jiti.import(path.join(dir, entry));
		const factory = module.default ?? module;
		if (typeof factory !== "function") return { ok: false, detail: "tool inspection failed", problems: ["entry has no default factory"] };
		await factory(recordingPi(tools, []));
	} catch (error) {
		return { ok: false, detail: "tool inspection failed", problems: [`could not inspect tools: ${error instanceof Error ? error.message : String(error)}`] };
	}

	const { compile } = await import(pathToFileURL(schemaPath).href);
	const problems = [];
	let schemas = 0;
	for (const tool of tools) {
		for (const key of ["parameters", "outputSchema"]) {
			const schema = tool[key];
			if (!schema) continue;
			schemas++;
			const where = `${tool.name}.${key}`;
			problems.push(...schemaProblems(schema, where));
			try {
				compile(schema);
			} catch (error) {
				problems.push(`${where}: ${error.message}`);
			}
		}
	}
	for (const { name, source } of sourceFiles(dir)) {
		const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		if (IGNORED_TYPEBOX.test(stripped)) problems.push(`${name}: uses a TypeBox feature Pi ignores`);
	}
	return { ok: problems.length === 0, detail: `${tools.length} tools, ${schemas} schemas`, problems };
}

async function checkThemes(install, dir, manifest) {
	const themes = manifest.pi?.themes ?? [];
	if (!themes.length) return undefined;
	if (!fs.existsSync(install.themeSchema)) return { ok: true, skipped: `Pi ${install.version} validates themes elsewhere` };
	const { validateThemeJson } = await import(pathToFileURL(install.themeSchema).href);
	const problems = [];
	for (const theme of themes) {
		const file = path.join(dir, theme);
		try {
			validateThemeJson(theme, JSON.parse(fs.readFileSync(file, "utf8")));
		} catch (error) {
			problems.push(`${theme}: ${error.message}`);
		}
	}
	return { ok: problems.length === 0, detail: `${themes.length} themes`, problems };
}

// ---------------------------------------------------------------------- report

const PACKAGE_ICON = { ok: "ok", skipped: "skip", failed: "FAIL" };

function formatCheck(label, check) {
	const state = check.skipped !== undefined ? "skipped" : check.ok ? "ok" : "failed";
	const detail = check.skipped ?? check.detail;
	return `  ${label.padEnd(8)} ${PACKAGE_ICON[state].padEnd(5)} ${detail}${check.problems?.length ? `\n${check.problems.map((line) => `           - ${line}`).join("\n")}` : ""}`;
}

async function main(options) {
	const install = findInstall(options.piRelease);
	if (!fs.existsSync(install.index)) throw new Error(`Pi ${install.version} is incomplete: ${install.index} is missing`);

	const packages = fs
		.readdirSync(options.root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(options.root, entry.name, "package.json")))
		.map((entry) => path.join(options.root, entry.name))
		.filter((dir) => {
			try {
				return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).pi?.extensions !== undefined;
			} catch {
				return false;
			}
		})
		.sort();

	if (!packages.length) throw new Error(`No packages with pi.extensions under ${options.root}`);

	const results = [];
	for (const dir of packages) {
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		const checks = {
			imports: await checkImports(install, dir),
			load: checkLoad(install, dir),
			tools: await checkTools(install, dir, manifest),
			themes: await checkThemes(install, dir, manifest),
		};
		results.push({ name: manifest.name ?? path.basename(dir), dir, checks });
	}

	const failed = results.filter((entry) => Object.values(entry.checks).some((check) => check && !check.ok));

	if (options.json) {
		console.log(JSON.stringify({ release: install.version, root: options.root, results, ok: failed.length === 0 }, null, 2));
	} else {
		console.log(`Pi compatibility check — ${install.version} (${path.join(releasesDir(), install.version, "node_modules")})`);
		console.log(`workspace ${options.root}\n`);
		for (const entry of results) {
			console.log(entry.name);
			for (const [label, check] of Object.entries(entry.checks)) {
				if (check) console.log(formatCheck(label, check));
			}
			console.log("");
		}
		const skipped = results.flatMap((entry) => Object.values(entry.checks).filter((check) => check?.skipped));
		if (failed.length) {
			console.log(`${failed.length} package(s) failed on Pi ${install.version}: ${failed.map((entry) => entry.name).join(", ")}`);
		} else {
			console.log(`All checks passed on Pi ${install.version}${skipped.length ? ` (${skipped.length} skipped)` : ""}.`);
		}
	}
	return failed.length ? 1 : 0;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	try {
		process.exitCode = await main(parseArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(`compat-check: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}