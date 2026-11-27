/** Private wire contract: optional cooperation, independent installations. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const OBSERVATION_LINK_VERSION = 1;
export const MONITOR_CAPABILITY_CHANNEL = "pi-cc:monitor:observation-link";
export const LOOP_OBSERVATION_BIND_CHANNEL = "loop:bind-observation";
export const LOOP_OBSERVATION_ADOPT_CHANNEL = "loop:adopt-observations";
export const LOOP_STOPPED_CHANNEL = "loop:stopped";
export const MONITOR_EVENT_TYPE = "Monitor";

export interface ObservationBinding {
	prompt: string;
	version?: number;
	acceptedVersion?: number;
	canonicalPrompt?: string;
	observationGroup?: string;
	error?: string;
}

type Bus = Pick<ExtensionAPI, "events">;
type Probe = { version: number; acceptedVersion?: number };

export function advertiseObservationMonitor(pi: Bus): () => void {
	return pi.events.on(MONITOR_CAPABILITY_CHANNEL, data => {
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const probe = data as Probe;
		if (probe.version === OBSERVATION_LINK_VERSION) probe.acceptedVersion = OBSERVATION_LINK_VERSION;
	});
}

/** A tool with the same name may use an older, command-executing contract. */
export function supportsObservationMonitor(pi: Bus): boolean {
	const probe: Probe = { version: OBSERVATION_LINK_VERSION };
	try { pi.events.emit(MONITOR_CAPABILITY_CHANNEL, probe); }
	catch { return false; }
	return probe.acceptedVersion === OBSERVATION_LINK_VERSION;
}
