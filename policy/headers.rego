# Security header policy (U2b). Input: `expected` (SECURITY_HEADERS, exported by services/ultrathink/routes/router.ts),
# `headers` (lowercased: the static copy of expected, or the live response in live mode) and `source` ("static" | "live").
# Names are confirmed against services/ultrathink/security/headers.ts (buildSecurityHeaders) and router.ts
# (Cache-Control is added there before the builder output is spread in).
package ultrathink.policy

import rego.v1

header_source := "services/ultrathink/routes/router.ts"

required_headers := {
	"Strict-Transport-Security", # headers.ts: hsts
	"Content-Security-Policy", # headers.ts: csp, enforcing (cspReportOnly false)
	"X-Frame-Options", # headers.ts: frameOptions
	"X-Content-Type-Options", # headers.ts: contentTypeOptions
	"Referrer-Policy", # headers.ts: referrerPolicy
	"Permissions-Policy", # headers.ts: permissionsPolicy
	"Cache-Control", # router.ts: "no-store", added before the builder output
}

# True only when expected carries a value for the name. An absent `expected` input leaves this undefined.
expected_has(name) if input.expected[name] != null

# H-R1: every required name is present in expected. A missing name, or a missing expected object, is a violation.
violations contains {"rule": "H-R1", "file": header_source, "detail": sprintf("expected header %s is missing from SECURITY_HEADERS", [name])} if {
	some name in required_headers
	not expected_has(name)
}

# H-R2: in live mode the response header, lowercased, equals the expected value. An absent header is a violation.
# The `not` form matters: an undefined headers input or header key makes the comparison fail, not pass.
violations contains {"rule": "H-R2", "file": header_source, "detail": sprintf("live response header %s is absent or differs from expected", [name])} if {
	input.source == "live"
	some name in required_headers
	expected_has(name)
	not input.headers[lower(name)] == input.expected[name]
}
