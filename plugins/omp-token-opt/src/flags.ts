/** Feature flags for v0.2 improvements. Every flag defaults off. All off = baseline behaviour. */
export const FLAG_NAMES = [
	"graphBudget",
	"graphKeyedCache",
	"graphSingleflight",
	"asyncLedger",
	"sessionBudget",
	"boundedDedupe",
	"graphPointer",
	"remoteSink",
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];
export type Flags = Record<FlagName, boolean>;

export const FLAG_ENV: Record<FlagName, string> = {
	graphBudget: "TOKEN_OPT_FF_GRAPH_BUDGET",
	graphKeyedCache: "TOKEN_OPT_FF_GRAPH_KEYED_CACHE",
	graphSingleflight: "TOKEN_OPT_FF_GRAPH_SINGLEFLIGHT",
	asyncLedger: "TOKEN_OPT_FF_ASYNC_LEDGER",
	sessionBudget: "TOKEN_OPT_FF_SESSION_BUDGET",
	boundedDedupe: "TOKEN_OPT_FF_BOUNDED_DEDUPE",
	graphPointer: "TOKEN_OPT_FF_GRAPH_POINTER",
	remoteSink: "TOKEN_OPT_FF_REMOTE_SINK",
};

export const ALL_FLAGS_OFF: Flags = {
	graphBudget: false,
	graphKeyedCache: false,
	graphSingleflight: false,
	asyncLedger: false,
	sessionBudget: false,
	boundedDedupe: false,
	graphPointer: false,
	remoteSink: false,
};

function isOn(value: string | undefined): boolean {
	if (typeof value !== "string") return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "on";
}

/** Read flags from the environment. Unset, empty, or unknown values mean off. */
export function readFlags(env: Record<string, string | undefined> = process.env): Flags {
	const out: Flags = { ...ALL_FLAGS_OFF };
	for (const name of FLAG_NAMES) out[name] = isOn(env[FLAG_ENV[name]]);
	return out;
}
