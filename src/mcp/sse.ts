// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
export function createSseParser(onMessage: (data: string) => void): { push(chunk: string): void; end(): void } {
	let buffer = "";
	let data: string[] = [];
	const dispatch = (): void => {
		if (data.length > 0) {
			const payload = data.join("\n");
			data = [];
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
	};
	return {
		push(chunk: string): void {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				processLine(buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
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
