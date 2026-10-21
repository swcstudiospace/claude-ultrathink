/**
 * BPE token count with the gpt-tokenizer cl100k_base encoding. Deterministic. Not provider billing.
 * Never throws: empty or non-string input and encoder failures return 0.
 */
import { encode } from "gpt-tokenizer/encoding/cl100k_base";

export function bpeCount(text: string): number {
	if (typeof text !== "string" || text.length === 0) return 0;
	try {
		return encode(text).length;
	} catch {
		return 0;
	}
}
