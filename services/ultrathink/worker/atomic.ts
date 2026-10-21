// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fsyncDirectory } from "./durable.ts";

/**
 * Writes `${dir}/${name}` via a temp file in the same directory, fsyncs it, renames it into
 * place, then fsyncs the directory so the new entry survives a power loss after the rename.
 */
export function writeAtomic(dir: string, name: string, content: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const finalPath = join(dir, name);
	const tempPath = join(dir, `.${name}.${randomUUID()}.tmp`);
	try {
		const fd = openSync(tempPath, "wx", 0o600);
		try {
			writeFileSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tempPath, finalPath);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
	fsyncDirectory(dir);
}
