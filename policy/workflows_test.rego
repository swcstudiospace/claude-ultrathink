
# Tests for policy/workflows.rego. Inline fixtures in the shape policy/collect.ts emits.
# Assertions use exact sets of [rule, file] pairs. Only W-* rules are compared, because the unit and header rules
# share the same `violations` set and are not under test here.
package ultrathink.policy

import rego.v1

ci_file := ".github/workflows/ci.yml"

release_file := ".github/workflows/release.yml"

codeql_file := ".github/workflows/codeql.yml"

pinned_checkout := "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"

read_perms := {"contents": "read"}

wf_summary(vs) := {[v.rule, v.file] | some v in vs; startswith(v.rule, "W-")}

wf_ci(on, perms, jobs) := {
	"file": ci_file,
	"on": on,
	"permissions": perms,
	"jobs": jobs,
}

wf_release(perms, jobs) := {
	"file": release_file,
	"on": ["push"],
	"permissions": read_perms,
	"jobs": jobs,
}

# A ci.yml-shaped workflow that passes every rule. Each negative test changes one field of it.
clean_ci := wf_ci(["push", "pull_request"], read_perms, {"test": {"permissions": null, "uses": [pinned_checkout]}})

test_w_baseline_clean_passes if {
	inp := {"workflows": [clean_ci]}
	vs := violations with input as inp
	wf_summary(vs) == set()
}

# W-R1

test_w_r1_tag_ref_fails if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], read_perms, {"test": {"permissions": null, "uses": ["actions/checkout@v4"]}})]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R1", ci_file]}
}

test_w_r1_local_ref_fails if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], read_perms, {"test": {"permissions": null, "uses": ["./.github/actions/local"]}})]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R1", ci_file]}
}

test_w_r1_sha_ref_passes if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], read_perms, {"test": {"permissions": null, "uses": [pinned_checkout]}})]}
	vs := violations with input as inp
	not ["W-R1", ci_file] in wf_summary(vs)
}

# W-R2

test_w_r2_write_all_fails if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], "write-all", {"test": {"permissions": null, "uses": [pinned_checkout]}})]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R2", ci_file]}
}

test_w_r2_missing_permissions_fails if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], null, {"test": {"permissions": null, "uses": [pinned_checkout]}})]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R2", ci_file]}
}

test_w_r2_write_scope_at_top_level_fails if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], {"contents": "write"}, {"test": {"permissions": null, "uses": [pinned_checkout]}})]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R2", ci_file]}
}

test_w_r2_read_all_passes if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], "read-all", {"test": {"permissions": null, "uses": [pinned_checkout]}})]}
	vs := violations with input as inp
	wf_summary(vs) == set()
}

# W-R3

test_w_r3_codeql_shape_passes if {
	# codeql.yml mentions pull_request_target in a comment only. The parsed `on` list does not contain it.
	codeql := {
		"file": codeql_file,
		"on": ["push", "pull_request", "schedule"],
		"permissions": read_perms,
		"jobs": {"analyze": {"permissions": {"contents": "read", "actions": "read"}, "uses": [pinned_checkout]}},
	}
	inp := {"workflows": [codeql]}
	vs := violations with input as inp
	wf_summary(vs) == set()
}

test_w_r3_pull_request_target_fails if {
	inp := {"workflows": [wf_ci(["pull_request_target"], read_perms, {"test": {"permissions": null, "uses": [pinned_checkout]}})]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R3", ci_file]}
}

# W-R4

test_w_r4_release_contents_write_passes if {
	rel := wf_release(read_perms, {"release": {"permissions": {"contents": "write", "checks": "read"}, "uses": [pinned_checkout]}})
	inp := {"workflows": [rel]}
	vs := violations with input as inp
	wf_summary(vs) == set()
}

test_w_r4_ci_contents_write_fails if {
	inp := {"workflows": [wf_ci(["push", "pull_request"], read_perms, {"test": {"permissions": {"contents": "write"}, "uses": [pinned_checkout]}})]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R4", ci_file]}
}

test_w_r4_release_other_scope_fails if {
	rel := wf_release(read_perms, {"release": {"permissions": {"contents": "write", "id-token": "write"}, "uses": [pinned_checkout]}})
	inp := {"workflows": [rel]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R4", release_file]}
}

test_w_r4_release_other_job_fails if {
	rel := wf_release(read_perms, {"build": {"permissions": {"contents": "write"}, "uses": [pinned_checkout]}})
	inp := {"workflows": [rel]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R4", release_file]}
}

test_w_r4_job_write_all_fails if {
	rel := wf_release(read_perms, {"release": {"permissions": "write-all", "uses": [pinned_checkout]}})
	inp := {"workflows": [rel]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R4", release_file]}
}

codeql_wf := {
	"file": codeql_file,
	"on": ["push", "pull_request", "schedule"],
	"permissions": read_perms,
	"jobs": {"analyze": {"permissions": {"contents": "read", "actions": "read", "security-events": "write"}, "uses": [pinned_checkout]}},
}

scan_file := ".github/workflows/security-scan.yml"

scan_wf(job_id) := {
	"file": scan_file,
	"on": ["push", "pull_request"],
	"permissions": read_perms,
	"jobs": {job_id: {"permissions": {"contents": "read", "security-events": "write"}, "uses": [pinned_checkout]}},
}

test_w_r4_codeql_analyze_sarif_grant_passes if {
	inp := {"workflows": [codeql_wf]}
	vs := violations with input as inp
	wf_summary(vs) == set()
}

test_w_r4_semgrep_sarif_grant_passes if {
	inp := {"workflows": [scan_wf("semgrep")]}
	vs := violations with input as inp
	wf_summary(vs) == set()
}

test_w_r4_sarif_grant_in_other_job_fails if {
	# The same security-events write in security-scan.yml job dependency-audit is not an allowed grant.
	inp := {"workflows": [scan_wf("dependency-audit")]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R4", scan_file]}
}

test_w_r4_sarif_grant_in_other_workflow_fails if {
	# The codeql analyze job name in ci.yml is not the codeql.yml grant.
	ci := wf_ci(["push", "pull_request"], read_perms, {"analyze": {"permissions": {"security-events": "write"}, "uses": [pinned_checkout]}})
	inp := {"workflows": [ci]}
	vs := violations with input as inp
	wf_summary(vs) == {["W-R4", ci_file]}
}
