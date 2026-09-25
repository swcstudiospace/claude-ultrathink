// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { Clarification } from "../hitl/types.ts";

export interface TaskRow {
	graphId: string;
	item: string;
	description: string;
	upliftedPrompt: string;
	agent: string;
	status: string;
	linearState: string;
	repo?: string;
	branch?: string;
}

export interface IssueRow {
	graphId: string;
	nodeId: string;
	item: string;
	thought: string;
}

export interface SubIssueRow {
	graphId: string;
	nodeId: string;
	item: string;
	step: number;
	thought: string;
}

export interface LinearIssuePlan {
	nodeId: string;
	title: string;
	description: string;
}

export interface LinearSubIssuePlan {
	nodeId: string;
	/** 1-based rationale step index; pairs this entry with the SubIssueRow of the same nodeId + step. */
	step: number;
	title: string;
	description: string;
}

export interface HitlPlan {
	blocking: Clarification[];
	nonBlocking: Clarification[];
}

export interface TrackPlan {
	graphId: string;
	task: TaskRow;
	issues: IssueRow[];
	subIssues: SubIssueRow[];
	linearIssues: LinearIssuePlan[];
	linearSubIssues: LinearSubIssuePlan[];
	hitl: HitlPlan;
}

export interface IssueRef {
	id: string;
	identifier: string;
	url: string;
	title: string;
}

export type TrackingStatus = "complete" | "partial" | "failed";

export interface TrackingRefs {
	graphId: string;
	status: TrackingStatus;
	linearTeam?: string;
	/** `steps` is keyed by stepKey(nodeId, step) = `${nodeId}.${step}`. */
	linear: { nodes: Record<string, IssueRef>; steps: Record<string, IssueRef> };
	notion: { taskUrl?: string; nodes: Record<string, string>; steps: Record<string, string> };
	/** Short, secret-free error notes, e.g. "notion: login required". */
	errors: string[];
	updatedAt: number;
}
