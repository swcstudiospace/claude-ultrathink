// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
export const MUSE_MODEL_DEFAULT = "muse-spark-1.3-contributor";

export const MUSE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type MuseEffort = (typeof MUSE_EFFORTS)[number];

export interface MuseConfig {
	/** `muse` binary used for headless completions. */
	bin: string;
	/** Model id for the uplift and thinking calls; empty inherits the CLI session default. */
	model: string;
	/** Meta reasoning effort for child calls. */
	reasoningEffort: MuseEffort;
	/** Per-call timeout for one headless completion. 0 = no timer. */
	callTimeoutMs: number;
}

export const DEFAULT_MUSE_CONFIG: MuseConfig = {
	bin: "muse",
	model: MUSE_MODEL_DEFAULT,
	reasoningEffort: "high",
	callTimeoutMs: 0,
};
