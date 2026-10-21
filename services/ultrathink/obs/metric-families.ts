// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * The closed set of Prometheus metric family names this service may emit, base names only
 * (no `_bucket`, `_sum` or `_count` suffix). Rules and dashboards under `deploy/observability/`
 * may reference only these names; `observability-contract.test.ts` enforces it.
 */
export const METRIC_FAMILIES: readonly string[] = [
	// Existing families.
	"ultrathink_http_requests_total",
	"ultrathink_http_request_duration_seconds",
	"ultrathink_http_inflight",
	"ultrathink_overload_total",
	"ultrathink_mcp_tool_calls_total",
	"ultrathink_auth_failures_total",
	"ultrathink_rate_limited_total",
	"ultrathink_plan_jobs_total",
	"ultrathink_planner_calls_total",
	"ultrathink_planner_call_duration_seconds",
	"ultrathink_plan_tokens_total",
	"ultrathink_plan_cost_usd_total",
	"ultrathink_planner_enabled",
	"ultrathink_build_info",
	"ultrathink_metrics_dropped_total",
	"ultrathink_audit_write_failures_total",
	"ultrathink_upstream_breaker_state",
	"ultrathink_retention_removed_total",
	"ultrathink_event_loop_lag_seconds",
	"ultrathink_process_rss_bytes",
	"ultrathink_process_heap_used_bytes",
	"ultrathink_uptime_seconds",
	// New families.
	"ultrathink_upstream_breaker_transitions_total",
	"ultrathink_audit_chain_notices_total",
	"ultrathink_retention_sweep_duration_seconds",
	"ultrathink_retention_errors_total",
	"ultrathink_otel_spans_dropped_total",
	"ultrathink_otel_export_failures_total",
	"ultrathink_anomaly_active",
	"ultrathink_anomaly_transitions_total",
	"ultrathink_slo_error_budget_remaining_ratio",
	"ultrathink_slo_burn_rate",
	"ultrathink_slo_observed_seconds",
	// Audit sink, abuse, fair-share, and load-forecast families emitted by routes/router.ts.
	"ultrathink_audit_sink_events_total",
	"ultrathink_audit_anomalies_total",
	"ultrathink_audit_tamper_alerts_total",
	"ultrathink_abuse_penalty_total",
	"ultrathink_abuse_untracked_total",
	"ultrathink_fair_share_refused_total",
	"ultrathink_adaptive_quota_factor",
	"ultrathink_load_forecast_rps",
	"ultrathink_recommended_replicas",
];
