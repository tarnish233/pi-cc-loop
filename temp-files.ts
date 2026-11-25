/** Loop-owned atomic-write scratch directories, not task/config/session data.
 * Every write is staged next to its destination for atomic rename. Ownership
 * includes the exact target, host and pid. GC never guesses that old loose
 * *.tmp files belong to Loop, and never traverses a symlinked parent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const MARKER = "owner.json";
const SCHEMA = "pi-cc-loop.atomic";
interface Owner {
	schema: typeof SCHEMA;
	version: 1;
	kind: "atomic-write";
	target: string;
	pid: number;
	hostname: string;
	createdAt: number;
	closedAt: number | null;
}

export function writeAtomic(file: string, text: string): void {
	const dir = fs.mkdtempSync(file + ".pi-cc-loop-tmp-");
	const marker = path.join(dir, MARKER);
	const owner: Owner = { schema: SCHEMA, version: 1, kind: "atomic-write", target: path.resolve(file), pid: process.pid, hostname: os.hostname(), createdAt: Date.now(), closedAt: null };
	try {
		fs.writeFileSync(marker, JSON.stringify(owner), { mode: 0o600 });
		const temp = path.join(dir, "value.tmp");
		fs.writeFileSync(temp, text, "utf8");
		fs.renameSync(temp, file);
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
			// Do not turn an already-saved setting or durable tick into a failure.
			// A finished marker permits eventual GC even if this pid remains alive.
			try { fs.writeFileSync(marker, JSON.stringify({ ...owner, closedAt: Date.now() }), { mode: 0o600 }); } catch { /* uncertain leftovers are retained */ }
		}
	}
}
function readOwner(dir: string, target: string): Owner | undefined {
	const marker = path.join(dir, MARKER), stat = fs.lstatSync(marker);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return;
	const value = JSON.parse(fs.readFileSync(marker, "utf8")) as Owner;
	if (!value || value.schema !== SCHEMA || value.version !== 1 || value.kind !== "atomic-write" || value.target !== target) return;
	if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || value.hostname !== os.hostname()) return;
	if (!Number.isFinite(value.createdAt) || value.createdAt <= 0 || value.closedAt !== null && (!Number.isFinite(value.closedAt) || value.closedAt <= 0)) return;
	return value;
}
function ourUid(stat: fs.Stats): boolean {
	const uid = process.geteuid?.() ?? process.getuid?.();
	return uid === undefined || stat.uid === uid;
}
function definitelyDead(pid: number): boolean {
	try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** Best effort, no mkdir, no symlink traversal, and no deletion of destinations or locks. */
export function cleanRuntimeTemps(files: readonly string[], now = Date.now()): void {
	for (const target of new Set(files.map((file) => path.resolve(file)))) {
		const parent = path.dirname(target), prefix = path.basename(target) + ".pi-cc-loop-tmp-";
		try {
			const parentStat = fs.lstatSync(parent);
			if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) continue;
			for (const name of fs.readdirSync(parent)) {
				if (!name.startsWith(prefix)) continue;
				const dir = path.join(parent, name);
				try {
					const stat = fs.lstatSync(dir);
					if (!stat.isDirectory() || stat.isSymbolicLink() || !ourUid(stat)) continue;
					const owner = readOwner(dir, target);
					if (!owner || owner.closedAt === null && !definitelyDead(owner.pid)) continue;
					let activity = Math.max(stat.mtimeMs, owner.createdAt, owner.closedAt ?? 0);
					// Only regular direct children are created here; no recursive traversal
					// and no following a symlink to infer somebody else's activity.
					for (const child of fs.readdirSync(dir)) {
						const childStat = fs.lstatSync(path.join(dir, child));
						if (childStat.isDirectory()) { activity = now; break; }
						if (childStat.isFile()) activity = Math.max(activity, childStat.mtimeMs);
					}
					if (now - activity < TEMP_RETENTION_MS) continue;
					const current = fs.lstatSync(dir);
					const again = readOwner(dir, target);
					if (current.ino !== stat.ino || !current.isDirectory() || !ourUid(current) || !again || again.pid !== owner.pid || again.createdAt !== owner.createdAt || again.closedAt !== owner.closedAt) continue;
					if (again.closedAt === null && !definitelyDead(again.pid)) continue;
					fs.rmSync(dir, { recursive: true, force: true });
				} catch { /* one unreadable/uncertain entry cannot affect scheduling */ }
			}
		} catch { /* a missing or symlinked runtime location is not an error */ }
	}
}
