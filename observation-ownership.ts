/** Stable session-local Loop identity; the existing binding channels stay unchanged. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { LOOP_OBSERVATION_BIND_CHANNEL, LOOP_OBSERVATION_ADOPT_CHANNEL, OBSERVATION_LINK_VERSION, type ObservationBinding } from "./observation-link.ts";
export { LOOP_OBSERVATION_BIND_CHANNEL, LOOP_OBSERVATION_ADOPT_CHANNEL } from "./observation-link.ts";

export interface ObservationRun {
	loopRequest?: boolean;
	userTurn?: boolean;
	/** Stable Loop id; null means a modern message explicitly has no Loop affinity. */
	activityId?: string | null;
	chainId?: string;
	cronId?: string;
	cancelled?: boolean;
	createdCronPrompts?: Set<string>;
}
export interface ObservationOwner { readonly prompt: string; readonly chainId?: string }
type Chain = { id: string; prompt: string };
type Activity = { prompt: string; chainId?: string; observed?: boolean };
interface OwnershipOptions {
	run(): ObservationRun;
	createId(): string;
	normalize(prompt: string): string;
	/** Compatibility lookup only: callers reject ambiguous text. */
	findChain(prompt: string): Chain | undefined;
	getChain(id: string): Chain | undefined;
	isStopped(prompt: string): boolean;
}
const STOPPED_BINDING = "The /loop this observation belongs to was stopped. Do not re-arm its observations or resubmit its external job; ask the user to start a new /loop.";
export const IMPLICIT_ACTIVITY_CONFLICT = "This turn already started a different self-paced Loop. Reuse its exact prompt or start the other Loop separately.";

export class ObservationOwnership {
	private readonly activities = new Map<string, Activity>();
	/** Do not recycle a retired identity while old events can still exist. */
	private readonly issued = new Set<string>();
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor(private readonly pi: ExtensionAPI, private readonly options: OwnershipOptions) {
		this.unsubscribe = pi.events.on(LOOP_OBSERVATION_BIND_CHANNEL, data => this.bind(data));
	}

	owner(id: string): ObservationOwner | undefined { return this.activities.get(id); }

	/** A plain user turn can start one tentative activity; it does not own the whole turn. */
	implicitPrompt(run: ObservationRun): string | undefined {
		return run.userTurn && run.activityId ? this.activities.get(run.activityId)?.prompt : undefined;
	}

	/** Identity only: no scheduler record, timer, observation or model message. */
	begin(run: ObservationRun, prompt: string): void {
		if (this.disposed) throw new Error(STOPPED_BINDING);
		let id: string;
		do { id = this.options.createId(); } while (this.issued.has(id) || this.options.getChain(id));
		this.issued.add(id);
		this.activities.set(id, { prompt: this.options.normalize(prompt) });
		run.activityId = id;
	}

	/** Existing/restored wakeups use their own id; no text adoption is needed. */
	forChain(chain: Chain): string {
		if (!this.activities.has(chain.id)) {
			if (this.disposed || this.issued.has(chain.id)) throw new Error(STOPPED_BINDING);
			this.issued.add(chain.id);
			this.activities.set(chain.id, { prompt: chain.prompt, chainId: chain.id });
		}
		return chain.id;
	}

	private bind(data: unknown): void {
		if (this.disposed || !data || typeof data !== "object" || Array.isArray(data)) return;
		const request = data as ObservationBinding;
		if (typeof request.prompt !== "string" || (request.version !== undefined && request.version !== OBSERVATION_LINK_VERSION)) return;
		if (request.version !== undefined) request.acceptedVersion = OBSERVATION_LINK_VERSION;
		const prompt = this.options.normalize(request.prompt);
		if (!prompt) return;
		const run = this.options.run();
		if (run.cancelled) { request.error = STOPPED_BINDING; return; }
		request.canonicalPrompt = prompt;
		// Fixed schedules keep their existing Esc/observation independence.
		if (run.activityId === null || run.cronId || run.createdCronPrompts?.has(prompt)) return;
		const implicit = this.implicitPrompt(run);
		const differentActivity = implicit !== undefined && implicit !== prompt;
		let id = differentActivity ? undefined : run.activityId;
		if (!id && run.chainId) {
			const chain = this.options.getChain(run.chainId);
			if (!chain) { request.error = STOPPED_BINDING; return; }
			id = this.forChain(chain);
		}
		if (!id) {
			let chain: Chain | undefined;
			try { chain = this.options.findChain(prompt); }
			catch (error) {
				// Pi's event bus catches listener exceptions. Return rejection in
				// the synchronous reply so Monitor allocates no resources.
				request.error = error instanceof Error ? error.message : String(error);
				return;
			}
			if (chain) id = this.forChain(chain);
			else if (this.options.isStopped(prompt)) { request.error = STOPPED_BINDING; return; }
			else if (differentActivity) {
				request.error = IMPLICIT_ACTIVITY_CONFLICT + " Omit loopPrompt for an independent observation.";
				return;
			} else if (run.userTurn) { this.begin(run, prompt); id = run.activityId; }
		}
		if (!id) return;
		const owner = this.activities.get(id);
		if (!owner || owner.chainId && !this.options.getChain(owner.chainId)) { request.error = STOPPED_BINDING; return; }
		owner.observed = true;
		request.observationGroup = id;
		request.canonicalPrompt = owner.prompt;
	}

	/** Register the first wakeup on the activity's existing id, never replace it. */
	link(run: ObservationRun, chain: Chain): void {
		if (run.activityId && run.activityId !== chain.id) throw new Error("Loop activity identity cannot be reassigned to another wakeup");
		const id = run.activityId ?? this.forChain(chain), owner = this.activities.get(id);
		if (!owner || this.disposed || run.cancelled) throw new Error(STOPPED_BINDING);
		const changed = owner.chainId !== chain.id || owner.prompt !== chain.prompt;
		owner.chainId = chain.id;
		owner.prompt = chain.prompt;
		if (changed) this.displayNotice([id], chain.prompt);
	}

	/** This initial request became fixed cron; do not give it self-paced Esc ownership. */
	detachForCron(run: ObservationRun, prompt: string): void {
		const id = run.activityId, owner = id ? this.activities.get(id) : undefined;
		if (!id || !owner || owner.chainId) return;
		// A cron created in an ordinary user turn may schedule an unrelated task.
		if (run.userTurn && this.options.normalize(prompt) !== owner.prompt) return;
		this.activities.delete(id);
		run.activityId = undefined;
		this.displayNotice([id], prompt, true);
	}

	private displayNotice(observationGroups: string[], prompt: string, detached = false): void {
		try { this.pi.events.emit(LOOP_OBSERVATION_ADOPT_CHANNEL, { observationGroups, prompt, detached }); }
		catch { /* Identity fencing does not depend on a display update. */ }
	}

	/** Retire this id only, not unrelated same-prompt initial activities. */
	retire(chain: Chain): string[] {
		const owner = this.activities.get(chain.id);
		if (!owner || owner.chainId !== chain.id) return [];
		this.activities.delete(chain.id);
		return [chain.id];
	}

	cancelPending(run: ObservationRun): Array<{ id: string; prompt: string }> {
		const id = run.activityId, owner = id ? this.activities.get(id) : undefined;
		if (!id || !owner || owner.chainId) return [];
		this.activities.delete(id);
		return [{ id, prompt: owner.prompt }];
	}

	/** An empty initial run needs no retained activity; observed runs can still receive events. */
	settle(run: ObservationRun): void {
		const id = run.activityId, owner = id ? this.activities.get(id) : undefined;
		if (id && owner && !owner.chainId && !owner.observed) this.activities.delete(id);
	}

	dispose(): void {
		this.disposed = true;
		try { this.unsubscribe?.(); } catch { /* old event facades may already be invalid */ }
		this.activities.clear();
		this.issued.clear();
	}
}
