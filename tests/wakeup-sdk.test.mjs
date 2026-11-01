/** Real SDK registry and nested-call checks. No model requests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { extensionDir, findPiInstall } from "./helpers.mjs";

const call = (name, id, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content) => ({
	role: "assistant", content, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

function recordAssistant(session, content) {
	const message = assistant(content);
	session.sessionManager.appendMessage(message);
	session.agent.state.messages = [...session.agent.state.messages, message];
}

test("the real SDK keeps wakeup direct, rejects nested/batched arms and preserves standalone termination", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-wakeup-sdk-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CC_CONFIG_FILE = path.join(agentDir, "pi-cc.json");
	process.env.PI_LOOP_SCAN_MS = "600000";
	process.env.PI_LOOP_DURABLE_SYNC_MS = "0";
	const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(findPiInstall().piCodingAgent).href);
	const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [path.join(extensionDir, "index.ts")] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const errors = [];
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: true });
	try {
		await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
		session.setActiveToolsByName(["schedule_wakeup"]);
		assert.ok(session.getActiveToolNames().includes("schedule_wakeup"));
		assert.ok(!session.getCallableToolNames().includes("schedule_wakeup"), "model-only survives the real registry projection");
		const runner = session.extensionRunner, tool = runner.getToolDefinition("schedule_wakeup");
		assert.equal(tool.exposure, "model-only");
		const args = { delaySeconds: 600, reason: "waiting for CI", prompt: "SDK fixture" };
		const jobs = async () => (await runner.getToolDefinition("cron_list").execute("list", {}, undefined, undefined, runner.createContext())).details.jobs;

		recordAssistant(session, [call("codemode", "parent")]);
		const nestedCtx = runner.createToolContext("parent", undefined);
		const nested = await nestedCtx.executeTool("schedule_wakeup", args);
		assert.equal(nested.isError, true);
		assert.deepEqual(await jobs(), [], "the rejected nested call created no schedule");

		recordAssistant(session, [call("schedule_wakeup", "wake", args), call("cron_list", "other")]);
		await assert.rejects(() => tool.execute("wake", args, undefined, undefined, runner.createToolContext("wake", undefined)), /only tool call/);
		assert.deepEqual(await jobs(), [], "the real session's mixed batch created no schedule");

		recordAssistant(session, [call("schedule_wakeup", "alone", args)]);
		const armed = await tool.execute("alone", args, undefined, undefined, runner.createToolContext("alone", undefined));
		assert.equal(armed.terminate, true);
		assert.equal((await jobs()).length, 1);
		recordAssistant(session, [call("schedule_wakeup", "stop", { stop: true })]);
		const stopped = await tool.execute("stop", { stop: true }, undefined, undefined, runner.createToolContext("stop", undefined));
		assert.equal(stopped.terminate, undefined);
		assert.deepEqual(await jobs(), []);
		assert.deepEqual(errors, []);
	} finally {
		try {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session.dispose();
		}
	}
});
