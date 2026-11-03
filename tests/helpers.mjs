import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Isolate pi-cc-extensions' config as well: the compat sync must not touch
// the real file when a test toggles compact tool rows.
if (!process.env.PI_CC_EXTENSIONS_CONFIG_FILE) {
	const ccstyleConfig = path.join(os.tmpdir(), `pi-cc-extensions-${process.pid}.json`);
	fs.writeFileSync(ccstyleConfig, JSON.stringify({ excludeRenderers: [] }));
	process.env.PI_CC_EXTENSIONS_CONFIG_FILE = ccstyleConfig;
}

// Isolate the shared settings file so tests never read or write the user's.
if (!process.env.PI_CC_CONFIG_FILE) {
	const configFile = path.join(os.tmpdir(), `pi-cc-config-${process.pid}.json`);
	fs.writeFileSync(configFile, JSON.stringify({ compactMessages: true }));
	process.env.PI_CC_CONFIG_FILE = configFile;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionDir = path.resolve(here, "..");

/** Locate the Pi installation that ships the extension host and jiti. */
export function findPiInstall() {
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const releases = path.join(agentDir, "install", "releases");
	const candidates = fs.existsSync(releases) ? fs.readdirSync(releases) : [];
	const versions = candidates
		.filter((name) => fs.existsSync(path.join(releases, name, "node_modules", "jiti")))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	if (!versions.length) {
		throw new Error(
			`Could not find a Pi installation with jiti under ${releases}. ` +
				"Set PI_AGENT_DIR to point at your agent directory.",
		);
	}
	const root = path.join(releases, versions[versions.length - 1], "node_modules");
	return {
		root,
		versions,
		jiti: path.join(root, "jiti", "lib", "jiti.mjs"),
		typebox: path.join(root, "typebox", "build", "index.mjs"),
		// Pi aliases these for extensions at load time; the test harness has to
		// do the same.
		piCodingAgent: path.join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
		piTui: path.join(root, "@earendil-works", "pi-tui", "dist", "index.js"),
		// Pi's own tool-argument validator and the JSON Schema engine behind it
		// (Pi 1.5.0+), so the tests check what Pi checks instead of TypeBox.
		piAiValidation: path.join(root, "@earendil-works", "pi-ai", "dist", "utils", "validation.js"),
		piSchema: path.join(root, "@earendil-works", "pi-schema", "dist", "index.js"),
	};
}

/** A jiti instance that can load the extension's TypeScript sources. */
let jitiInstance;
export async function makeJiti() {
	if (jitiInstance) return jitiInstance;
	const install = findPiInstall();
	const { createJiti } = await import(pathToFileURL(install.jiti).href);
	jitiInstance = createJiti(pathToFileURL(path.join(extensionDir, "index.ts")).href, {
		alias: {
			typebox: install.typebox,
			"@earendil-works/pi-coding-agent": install.piCodingAgent,
			"@earendil-works/pi-tui": install.piTui,
		},
	});
	return jitiInstance;
}

/** Import one of the extension's TypeScript modules. */
export async function loadModule(name) {
	const jiti = await makeJiti();
	return jiti.import(path.join(extensionDir, name));
}

/**
 * Import a TypeScript module from another extension directory, sharing the same
 * jiti instance so both resolve the same Pi installation.
 */
export async function loadModuleFrom(dir, name) {
	const jiti = await makeJiti();
	return jiti.import(path.join(dir, name));
}

/** Pi's real argument validator, plus a uniform compile(schema).check(value) adapter. */
export async function loadValidators() {
	const install = findPiInstall();
	const { validateToolArguments } = await import(pathToFileURL(install.piAiValidation).href);
	if (fs.existsSync(install.piSchema)) {
		const { compile } = await import(pathToFileURL(install.piSchema).href);
		return { validateToolArguments, compile, engine: "pi-schema" };
	}
	// Pi before 1.5 uses TypeBox. Do not require a package that those releases
	// never shipped, or replace their real argument validation with our adapter.
	const { Compile } = await import(pathToFileURL(path.join(install.root, "typebox", "build", "compile", "index.mjs")).href);
	return {
		validateToolArguments,
		compile: (schema) => {
			const validator = Compile(schema);
			return { check: (value) => validator.Check(value) };
		},
		engine: "typebox",
	};
}

/**
 * Guard JSON-visible data strictly, and reject own symbol keys recursively,
 * including beneath non-enumerable data properties. Non-enumerable string-keyed
 * TypeBox metadata (e.g. ~kind/~optional) is allowed: a JSON round trip cannot
 * prove such metadata is absent. The source scan below checks lost features.
 */
export function assertJsonRoundTrip(value, where = "value") {
	const seen = new Set();
	const visit = (node, at) => {
		if (node === null || (typeof node !== "object" && typeof node !== "function") || seen.has(node)) return;
		seen.add(node);
		assert.deepEqual(Object.getOwnPropertySymbols(node), [], `${at} has symbol keys JSON drops`);
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
			if ("value" in descriptor) visit(descriptor.value, `${at}/${key}`);
		}
	};
	visit(value, where);
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${where} preserves JSON-visible data`);
}

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

/**
 * What a tool schema means to TypeBox but not to JSON Schema, and so not to Pi:
 * the TypeBox-only types (`bigint`, `undefined`, `void`), a codec's nested
 * `{ type: { ... } }`, and formats registered with `Format.Set()`.
 */
export function jsonSchemaProblems(schema, where = "schema") {
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

/** Source files of the extension that use a TypeBox feature tool arguments silently lose. */
export function unsupportedTypeboxUsages(dir = extensionDir) {
	const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const names = fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts") && !name.split(path.sep).some((part) => part === "node_modules" || part === "tests"));
	return names.filter((name) => IGNORED_TYPEBOX.test(strip(fs.readFileSync(path.join(dir, name), "utf8"))));
}

/** Import the pi-coding-agent package through the aliased jiti instance. */
export async function loadPi() {
	const jiti = await makeJiti();
	return jiti.import("@earendil-works/pi-coding-agent");
}

/** The sibling extension directory (both packages live side by side). */
export function siblingExtensionDir(name) {
	return path.resolve(extensionDir, "..", name);
}
