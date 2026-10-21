// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { closeSync, fsyncSync, openSync } from "node:fs";

/**
 * Error codes meaning directory fsync is unavailable here, so an entry cannot be made durable by fsync on this
 * platform and the write is kept. EINVAL, ENOTSUP and EOPNOTSUPP: the filesystem or driver rejects fsync on the
 * descriptor (some network and FUSE mounts). EPERM and EISDIR: Windows does not open or flush a directory like a
 * file, and Node reports that as one of these. Every other code (ENOENT, EACCES, EIO, ...) is a real failure.
 */
const DIR_FSYNC_UNSUPPORTED: Record<string, true> = {
	EINVAL: true,
	ENOTSUP: true,
	EOPNOTSUPP: true,
	EPERM: true,
	EISDIR: true,
};

function isDirFsyncUnsupported(error: unknown): boolean {
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	return typeof code === "string" && DIR_FSYNC_UNSUPPORTED[code] === true;
}

/**
 * Opens the directory read-only, fsyncs it, and closes it, so a create or rename inside it is durable.
 * Tolerates only the codes listed above; any other failure is rethrown.
 */
export function fsyncDirectory(dir: string): void {
	let fd: number;
	try {
		fd = openSync(dir, "r");
	} catch (error) {
		if (isDirFsyncUnsupported(error)) return;
		throw error;
	}
	try {
		fsyncSync(fd);
	} catch (error) {
		if (!isDirFsyncUnsupported(error)) throw error;
	} finally {
		closeSync(fd);
	}
}
