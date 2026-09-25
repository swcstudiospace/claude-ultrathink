// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Hosts that load this plugin. The TypeScript engine is shared; only the
 * entry point and the delivery carrier differ.
 */
export const HOSTS = ["claude-code", "grok-build", "hermes", "muse", "omp"] as const;

export type HostId = (typeof HOSTS)[number];

export function isHostId(value: string): value is HostId {
	return (HOSTS as readonly string[]).includes(value);
}
