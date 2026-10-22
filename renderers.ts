/**
 * The few display helpers pi-cc-loop still needs: clock times for track records
 * and the coarse countdown for the footer. Messages and tool rows are rendered
 * by Pi, as in Claude Code.
 */


/**
 * A clock time the way Claude Code writes it: "6:16pm". Formatted here rather
 * than through the locale, so the transcript reads the same everywhere.
 */
export function formatClock(epochMs: number | undefined): string {
	if (!epochMs) return "unknown";
	const date = new Date(epochMs);
	const hour = date.getHours();
	const suffix = hour < 12 ? "am" : "pm";
	const twelve = hour % 12 === 0 ? 12 : hour % 12;
	return `${twelve}:${String(date.getMinutes()).padStart(2, "0")}${suffix}`;
}

/**
 * A countdown for the footer: "3m", "<1m", "2h 15m". Rounded up and coarse on
 * purpose, so the shared footer line is repainted at most once a minute.
 */
export function formatEta(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return "<1m";
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
