# Tests for policy/headers.rego. The values are the real SECURITY_HEADERS output of router.ts. Assertions use exact sets
# of [rule, file] pairs over H-* rules only, because the workflow and unit rules share the `violations` set.
package ultrathink.policy

import rego.v1

# Expected values as router.ts builds them today (API_HEADER_CONFIG plus Cache-Control).
hdr_expected := {
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Cache-Control": "no-store",
}

# A live response that matches hdr_expected, with lowercased names.
hdr_live := {
	"strict-transport-security": "max-age=31536000; includeSubDomains",
	"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"cache-control": "no-store",
}

hdr_static_headers := {lower(name): value | some name, value in hdr_expected}

hdr_summary(vs) := {[v.rule, v.file] | some v in vs; startswith(v.rule, "H-")}

hdr_src := "services/ultrathink/routes/router.ts"

# Static mode: headers mirror expected.

test_h_static_complete_passes if {
	inp := {"source": "static", "expected": hdr_expected, "headers": hdr_static_headers}
	vs := violations with input as inp
	hdr_summary(vs) == set()
}

test_h_r1_one_name_removed_from_expected_fails if {
	expected := object.remove(hdr_expected, ["Permissions-Policy"])
	inp := {"source": "static", "expected": expected, "headers": hdr_static_headers}
	vs := violations with input as inp
	hdr_summary(vs) == {["H-R1", hdr_src]}
}

test_h_r1_expected_missing_entirely_fails if {
	inp := {"source": "static", "headers": hdr_static_headers}
	vs := violations with input as inp
	s := hdr_summary(vs)
	["H-R1", hdr_src] in s
	count(s) == 1
}

# Live mode: the runtime compliance case.

test_h_r2_live_response_matching_expected_passes if {
	inp := {"source": "live", "expected": hdr_expected, "headers": hdr_live}
	vs := violations with input as inp
	hdr_summary(vs) == set()
}

test_h_r2_hsts_absent_fails if {
	live := object.remove(hdr_live, ["strict-transport-security"])
	inp := {"source": "live", "expected": hdr_expected, "headers": live}
	vs := violations with input as inp
	hdr_summary(vs) == {["H-R2", hdr_src]}
}

test_h_r2_csp_value_differs_fails if {
	live := object.union(hdr_live, {"content-security-policy": "default-src 'self'"})
	inp := {"source": "live", "expected": hdr_expected, "headers": live}
	vs := violations with input as inp
	hdr_summary(vs) == {["H-R2", hdr_src]}
}

test_h_r2_detail_names_the_absent_header if {
	live := object.remove(hdr_live, ["strict-transport-security"])
	inp := {"source": "live", "expected": hdr_expected, "headers": live}
	vs := violations with input as inp
	some v in vs
	v.rule == "H-R2"
	contains(v.detail, "Strict-Transport-Security")
}

test_h_r2_absent_live_headers_input_fails_closed if {
	inp := {"source": "live", "expected": hdr_expected}
	vs := violations with input as inp
	s := hdr_summary(vs)
	["H-R2", hdr_src] in s
	hdr_violations := {v | some v in vs; startswith(v.rule, "H-")}
	count(hdr_violations) == 7
}
