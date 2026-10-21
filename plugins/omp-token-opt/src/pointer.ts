/**
 * Graph pointer: a single static line that tells the agent a code graph exists.
 *
 * omp `before_agent_start` API (verified in the installed package):
 * - Types: /root/.local/share/reflex/bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts
 *   (also dist/types/extensibility/extensions/types.d.ts, lines ~756 and ~1108).
 * - Dispatch: .../src/extensibility/extensions/runner.ts, `emitBeforeAgentStart`.
 * - Apply: .../src/session/agent-session.ts, around lines 7823 and 7881.
 * - Event: `{ type, prompt, images?, systemPrompt: string[] }`. The handler DOES receive the
 *   system prompt, as an array of strings, not one string.
 * - Result: `{ message?, systemPrompt?: string[] }`. A string result is wrapped into an array.
 *   The result REPLACES the whole array. There is no append primitive. To append, return
 *   `[...event.systemPrompt, pointer]`. Extensions chain in order and each receives the
 *   previous result.
 * - Scope: the override is applied per turn with `setTurnSystemPromptOverride`, then cleared
 *   in the `finally` of the prompt path. This is the code behaviour. The type comment says
 *   "until the next preparation", which is looser.
 * - Caller: `index.ts` registers the handler only when the graphPointer flag is on. It returns
 *   `[...event.systemPrompt, pointer]`, so existing entries are kept.
 *
 * GRAPH_POINTER is constant: no digits, hashes, or timestamps, so the prefix stays cache-stable.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const GRAPH_POINTER = "Code graph: graphify-out/graph.json. Call graph_query before reading source files.";

/**
 * Returns GRAPH_POINTER when `<cwd>/graphify-out/graph.json` exists, otherwise null.
 * Fail-open: a throwing `exists` yields null, never an exception.
 */
export function pointerFor(cwd: string, exists: (path: string) => boolean = existsSync): string | null {
	try {
		return exists(join(cwd, "graphify-out", "graph.json")) ? GRAPH_POINTER : null;
	} catch {
		return null;
	}
}
