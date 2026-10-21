
# Workflow policy (U2a). Input: the `workflows` array of the shared input contract written by policy/collect.ts.
# Each violation is {"rule", "file", "detail"}; check.sh passes only when the violations set is empty.
package ultrathink.policy

import rego.v1

# The only job-scoped write grants the repo allows (W-R4). Every other write scope is a violation. Each entry names
# one job and one scope, and carries the reason the baseline needs it.
allowed_write_grants := {
	{"file": ".github/workflows/release.yml", "job": "release", "scope": "contents", "reason": "publish the GitHub release"},
	{"file": ".github/workflows/codeql.yml", "job": "analyze", "scope": "security-events", "reason": "upload CodeQL SARIF results"},
	{"file": ".github/workflows/security-scan.yml", "job": "semgrep", "scope": "security-events", "reason": "upload Semgrep SARIF results"},
}

# W-R1: every `uses` ref is pinned to a full 40-hex commit SHA. Local ./ refs are rejected.
pinned_ref(ref) if {
	regex.match(`^[A-Za-z0-9._/-]+@[0-9a-f]{40}$`, ref)
	not startswith(ref, "./")
}

violations contains {"rule": "W-R1", "file": wf.file, "detail": sprintf("job %s uses %s, which is not pinned to a 40-hex commit SHA", [job_id, ref])} if {
	some wf in input.workflows
	some job_id, job in object.get(wf, "jobs", {})
	some ref in object.get(job, "uses", [])
	not pinned_ref(ref)
}

# W-R2: top-level permissions must be present and must not grant write.
grants_write(perms) if perms == "write-all"

grants_write(perms) if {
	is_object(perms)
	some scope
	perms[scope] == "write"
}

top_level_read_only(perms) if {
	perms != null
	not grants_write(perms)
}

violations contains {"rule": "W-R2", "file": wf.file, "detail": "top-level permissions must be present and must not grant write"} if {
	some wf in input.workflows
	not top_level_read_only(object.get(wf, "permissions", null))
}

# W-R3: no workflow may trigger on pull_request_target. The rule reads the parsed `on` list, never comment text.
violations contains {"rule": "W-R3", "file": wf.file, "detail": "workflow triggers on pull_request_target"} if {
	some wf in input.workflows
	"pull_request_target" in object.get(wf, "on", [])
}

# W-R4: a write scope in a job's permissions is allowed only for the grants in allowed_write_grants.
write_grant_allowed(file, job_id, scope) if {
	some grant in allowed_write_grants
	grant.file == file
	grant.job == job_id
	grant.scope == scope
}

violations contains {"rule": "W-R4", "file": wf.file, "detail": sprintf("job %s grants write-all", [job_id])} if {
	some wf in input.workflows
	some job_id, job in object.get(wf, "jobs", {})
	object.get(job, "permissions", null) == "write-all"
}

violations contains {"rule": "W-R4", "file": wf.file, "detail": sprintf("job %s grants write on %s, which is not an allowed grant", [job_id, scope])} if {
	some wf in input.workflows
	some job_id, job in object.get(wf, "jobs", {})
	perms := object.get(job, "permissions", null)
	is_object(perms)
	some scope, level in perms
	level == "write"
	not write_grant_allowed(wf.file, job_id, scope)
}
