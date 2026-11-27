/** Session-local terminal messages; never durable and never a runner queue. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type TerminalMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type PendingMessage = { message: TerminalMessage };
const IDLE_FALLBACK_MS = 200;

export class TerminalOutbox<Key> {
	private readonly pending = new Map<Key, PendingMessage>();
	private wakeRetry?: PendingMessage;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private flushing = false;

	constructor(
		private readonly pi: Pick<ExtensionAPI, "sendMessage">,
		private readonly isIdle: () => boolean,
		private readonly onHandoff?: () => void,
	) {}

	get size(): number { return this.pending.size; }
	has(key: Key): boolean { return this.pending.has(key); }

	delete(key: Key): void {
		if (this.pending.get(key) === this.wakeRetry) this.cancelWakeRetry();
		this.pending.delete(key);
		this.updateFallback();
	}

	enqueue(key: Key, message: TerminalMessage, wakeIfIdle = true): void {
		if (this.disposed) return;
		this.pending.set(key, { message });
		if (wakeIfIdle && this.idle()) this.flush(true);
		this.updateFallback();
	}

	/** A new run or manual session operation supersedes an idle wake retry. */
	cancelWakeRetry(): void { this.wakeRetry = undefined; }

	/** True after synchronous handoff, not a receipt for persistence or a model run. */
	flush(triggerTurn: boolean): boolean {
		return this.flushBatch(triggerTurn);
	}

	private flushBatch(triggerTurn: boolean, retry?: PendingMessage): boolean {
		this.cancelWakeRetry();
		if (this.disposed || this.flushing || !this.pending.size) return false;
		this.flushing = true;
		let handedOff = false;
		const queued = [...this.pending];
		const wake = triggerTurn && this.idle() && (!retry || queued.at(-1)?.[1] === retry);
		try {
			for (let index = 0; index < queued.length; index++) {
				if (this.disposed) break;
				const [key, entry] = queued[index]!;
				if (this.pending.get(key) !== entry) continue;
				const wakeThis = wake && index === queued.length - 1;
				// An earlier handoff may have already started a run. Do not put
				// another terminal wake into the ordinary, Esc-clearable queue.
				if (wakeThis && !this.idle()) break;
				try {
					this.pi.sendMessage(entry.message, { deliverAs: "followUp", triggerTurn: wakeThis });
				} catch {
					// Earlier facts from this idle batch are already stored. Retry its
					// sole wake once, only for the same entry and idle opportunity.
					if (wakeThis && !retry && handedOff && this.pending.get(key) === entry && this.idle()) this.wakeRetry = entry;
					continue; // A synchronous rejection remains due.
				}
				if (this.pending.get(key) === entry) this.pending.delete(key);
				handedOff = true;
			}
		} finally {
			this.flushing = false;
			this.updateFallback();
			if (handedOff && !this.disposed) this.onHandoff?.();
		}
		return handedOff;
	}

	private idle(): boolean {
		try { return this.isIdle(); } catch { return false; }
	}

	private updateFallback(): void {
		if (this.disposed || !this.pending.size) {
			if (this.timer) clearTimeout(this.timer);
			this.timer = undefined;
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed || !this.pending.size) return;
			// Mere recovery to idle does not authorize a wake. Only an explicit
			// idle batch gets one retry, which is lost if the host is busy.
			const retry = this.wakeRetry;
			this.cancelWakeRetry();
			if (this.idle()) this.flushBatch(retry !== undefined, retry);
			this.updateFallback();
		}, IDLE_FALLBACK_MS);
		this.timer.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		this.cancelWakeRetry();
		this.pending.clear();
		this.updateFallback();
	}
}
