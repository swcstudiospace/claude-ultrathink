// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Receipt log for teachable moments captured by a detached observe process, which cannot call `sendMessage`.
 * The Omp session polls this file and publishes a display-only card. Never throws.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ActivityNotice, toActivityNotice } from "../host/activity-notice.ts";

const MAX_LINES = 50;
const FILE_NAME = "activity.ndjson";

export interface ActivityReceipt extends ActivityNotice {
	id: string;
}

function activityPath(stateDir: string): string {
	return join(stateDir, "teach", FILE_NAME);
}

/** Appends one validated notice. Drops a notice that fails validation. Keeps the newest 50 lines. */
export function appendActivity(stateDir: string, notice: unknown): void {
	try {
		const clean = toActivityNotice(notice);
		if (!clean) return;
		const dir = join(stateDir, "teach");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			chmodSync(dir, 0o700);
		} catch {
			// a directory we do not own keeps its mode
		}
		const path = activityPath(stateDir);
		let prior = "";
		try {
			prior = readFileSync(path, "utf8");
		} catch {
			prior = "";
		}
		const lines = prior.split("\n").filter((line) => line !== "");
		const id = randomBytes(4).toString("hex");
		lines.push(JSON.stringify({ id, ...clean }));
		const tail = lines.slice(-MAX_LINES);
		const tmp = `${path}.${process.pid}.${id}.tmp`;
		writeFileSync(tmp, `${tail.join("\n")}\n`, { mode: 0o600 });
		try {
			chmodSync(tmp, 0o600);
		} catch {
			// mode was set at create
		}
		renameSync(tmp, path);
		try {
			chmodSync(path, 0o600);
		} catch {
			// best-effort
		}
	} catch {
		// fail-open: a receipt is display only
	}
}

/** Parsed receipts, skipping malformed lines. Empty when the file is missing or unreadable. */
export function readActivity(stateDir: string): ActivityReceipt[] {
	try {
		const text = readFileSync(activityPath(stateDir), "utf8");
		const receipts: ActivityReceipt[] = [];
		for (const line of text.split("\n")) {
			if (line === "") continue;
			try {
				const value: unknown = JSON.parse(line);
				if (!value || typeof value !== "object" || Array.isArray(value)) continue;
				const id = "id" in value && typeof value.id === "string" && /^[0-9a-f]{8}$/.test(value.id) ? value.id : undefined;
				const notice = toActivityNotice(value);
				if (!id || !notice) continue;
				receipts.push({ id, ...notice });
			} catch {
				// skip one bad line
			}
		}
		return receipts;
	} catch {
		return [];
	}
}
