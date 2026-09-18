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
