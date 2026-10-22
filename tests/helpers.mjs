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

/** Import the pi-coding-agent package through the aliased jiti instance. */
export async function loadPi() {
	const jiti = await makeJiti();
	return jiti.import("@earendil-works/pi-coding-agent");
}

/** The sibling extension directory (both packages live side by side). */
export function siblingExtensionDir(name) {
	return path.resolve(extensionDir, "..", name);
}
