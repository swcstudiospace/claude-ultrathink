// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { getSecurityLogger } from "../../services/ultrathink/security/events.ts";
import { NumberValidator, StringValidator } from "../../services/ultrathink/security/validation.ts";

const CHUNK_TEXT = new StringValidator({ allowEmpty: true });
const LINE_LIMIT = new NumberValidator({ integer: true, min: 1 });

/** Records a refusal on the security feed with its field and validator code. The data itself is never recorded. */
function refused(field: string, code: string): void {
	getSecurityLogger().logValidationFailure({ source: "mcp_sse", resource: "sse", details: { field, code } });
}

/**
 * `maxLineChars` bounds the unterminated remainder kept between pushes and the data of one event: a stream that never
 * sends "\n" or a blank line would otherwise grow them without limit. Exceeding it throws from `push`.
 */
export function createSseParser(
	onMessage: (data: string) => void,
	maxLineChars = 16 * 1024 * 1024,
): { push(chunk: string): void; end(): void } {
	const limit = LINE_LIMIT.validate(maxLineChars);
	if (!limit.valid) {
		refused("maxLineChars", limit.errors[0]?.code ?? "INVALID");
		throw new RangeError("maxLineChars must be a positive integer");
	}
	let buffer = "";
	let data: string[] = [];
	let dataChars = 0;
	const dispatch = (): void => {
		if (data.length > 0) {
			const payload = data.join("\n");
			data = [];
			dataChars = 0;
			if (payload !== "") onMessage(payload);
		}
	};
	const processLine = (raw: string): void => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		if (field !== "data") return;
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		data.push(value);
		dataChars += value.length + (data.length > 1 ? 1 : 0);
		if (dataChars > maxLineChars) {
			refused("event", "TOO_LARGE");
			throw new Error("SSE event too large");
		}
	};
	return {
		push(chunk: string): void {
			const chunkCheck = CHUNK_TEXT.validate(chunk);
			if (!chunkCheck.valid) {
				refused("chunk", chunkCheck.errors[0]?.code ?? "INVALID");
				throw new TypeError("SSE chunk must be a string");
			}
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				processLine(buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
			}
			if (buffer.length > maxLineChars) {
				refused("line", "TOO_LONG");
				throw new Error("SSE line too long");
			}
		},
		end(): void {
			if (buffer !== "") {
				processLine(buffer);
				buffer = "";
			}
			dispatch();
		},
	};
}
