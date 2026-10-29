/** Real SDK sessions in one process, as used by subagents. No model requests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { extensionDir, findPiInstall } from "./helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-loop-sdk-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
fs.mkdirSync(agentDir);
fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CC_CONFIG_FILE = path.join(agentDir, "pi-cc.json");
process.env.PI_LOOP_SCAN_MS = "600000";
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(findPiInstall().piCodingAgent).href);

async function openSession(errors) {
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [path.join(extensionDir, "index.ts")] });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: true });
	try {
		await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
}

async function closeSession(session) {
	if (!session) return;
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}

async function createCron(session, prompt) {
	const runner = session.extensionRunner;
	return runner.getToolDefinition("cron_create").execute("create", { cron: "*/10 * * * *", prompt, durable: true }, undefined, undefined, runner.createContext());
}

const readLock = () => JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "scheduled_tasks.lock"), "utf8"));

test("real main and child SDK sessions share a process without sharing durable lock ownership", async () => {
	const errors = [];
	let main, child;
	try {
		main = await openSession(errors);
		assert.equal((await createCron(main, "main task")).details.runsHere, true);
		const firstLock = readLock();
		assert.equal(firstLock.pid, process.pid);
		assert.equal(typeof firstLock.ownerToken, "string");
		child = await openSession(errors);
		assert.deepEqual(readLock(), firstLock, "binding the child's extensions does not steal the parent's lock");
		assert.equal((await createCron(child, "child task")).details.runsHere, false);
		assert.deepEqual(readLock(), firstLock, "the child adds to the store without becoming a second owner");
		await closeSession(main);
		main = undefined;
		assert.equal((await createCron(child, "takeover task")).details.runsHere, true);
		assert.notEqual(readLock().ownerToken, firstLock.ownerToken, "the child owns its own instance token after takeover");
		assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "scheduled_tasks.json"), "utf8")).jobs.length, 3);
		assert.deepEqual(errors, []);
	} finally {
		await closeSession(child);
		await closeSession(main);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
