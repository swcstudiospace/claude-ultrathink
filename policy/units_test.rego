
# Tests for policy/units.rego. Inline fixtures in the shape policy/collect.ts emits. Assertions use exact sets of
# [rule, file] pairs. Only U-* rules are compared, because the workflow and header rules share the `violations` set.
package ultrathink.policy

import rego.v1

web_file := "deploy/ultrathink-web.service"

drift_file := "deploy/ultrathink-drift.service"

# The [Service] section of deploy/ultrathink-web.service as it stands today.
hardened_service := {
	"NoNewPrivileges": ["true"],
	"ProtectSystem": ["strict"],
	"ProtectHome": ["true"],
	"PrivateTmp": ["true"],
	"PrivateDevices": ["true"],
	"ProtectKernelTunables": ["true"],
	"ProtectKernelModules": ["true"],
	"ProtectKernelLogs": ["true"],
	"ProtectControlGroups": ["true"],
	"ProtectClock": ["true"],
	"ProtectProc": ["invisible"],
	"RestrictNamespaces": ["true"],
	"RestrictSUIDSGID": ["true"],
	"LockPersonality": ["true"],
	"CapabilityBoundingSet": [""],
	"AmbientCapabilities": [""],
	"UMask": ["0077"],
	"RestrictAddressFamilies": ["AF_INET AF_INET6 AF_UNIX"],
	"SystemCallFilter": ["@system-service", "~@privileged"],
	"User": ["ultrathink"],
}

units_input(web, drift) := {"units": [
	{"file": web_file, "sections": {"Service": web}},
	{"file": drift_file, "sections": {"Service": drift}},
]}

unit_summary(vs) := {[v.rule, v.file] | some v in vs; startswith(v.rule, "U-")}

test_u_baseline_both_units_pass if {
	inp := units_input(hardened_service, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == set()
}

# U-R1

test_u_r1_protect_home_false_fails if {
	web := object.union(hardened_service, {"ProtectHome": ["false"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R1", web_file]}
}

test_u_r1_missing_directive_fails if {
	web := object.remove(hardened_service, ["PrivateTmp"])
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R1", web_file]}
}

test_u_r1_capability_bounding_set_nonempty_fails if {
	web := object.union(hardened_service, {"CapabilityBoundingSet": ["CAP_NET_ADMIN"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R1", web_file]}
}

test_u_r1_umask_must_be_exact_fails if {
	web := object.union(hardened_service, {"UMask": ["0022"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R1", web_file]}
}

# U-R2

test_u_r2_missing_privileged_filter_fails if {
	web := object.union(hardened_service, {"SystemCallFilter": ["@system-service"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R2", web_file]}
}

# U-R3

test_u_r3_netlink_in_line_fails if {
	web := object.union(hardened_service, {"RestrictAddressFamilies": ["AF_INET AF_NETLINK AF_UNIX"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R3", web_file]}
}

test_u_r3_packet_as_repeated_entry_fails if {
	web := object.union(hardened_service, {"RestrictAddressFamilies": ["AF_UNIX", "AF_PACKET"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R3", web_file]}
}

test_u_r3_empty_entry_fails if {
	# An empty RestrictAddressFamilies= resets the list to unrestricted.
	web := object.union(hardened_service, {"RestrictAddressFamilies": [""]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R3", web_file]}
}

# U-R4

test_u_r4_root_user_fails if {
	web := object.union(hardened_service, {"User": ["root"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R4", web_file]}
}

test_u_r4_numeric_root_user_fails if {
	web := object.union(hardened_service, {"User": ["0"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R4", web_file]}
}

test_u_r4_repeated_user_with_root_fails if {
	web := object.union(hardened_service, {"User": ["ultrathink", "root"]})
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R4", web_file]}
}

test_u_r4_absent_user_fails if {
	web := object.remove(hardened_service, ["User"])
	inp := units_input(web, hardened_service)
	vs := violations with input as inp
	unit_summary(vs) == {["U-R4", web_file]}
}

# Fail closed on scope

test_u_absent_scoped_unit_fails if {
	# The drift unit is in scope but missing from the input. Its directives are reported, and the web unit is not.
	inp := {"units": [{"file": web_file, "sections": {"Service": hardened_service}}]}
	vs := violations with input as inp
	s := unit_summary(vs)
	["U-R1", drift_file] in s
	["U-R2", drift_file] in s
	["U-R4", drift_file] in s
	not ["U-R1", web_file] in s
}

test_u_no_units_input_fails_closed if {
	vs := violations with input as {}
	s := unit_summary(vs)
	["U-R1", web_file] in s
	["U-R4", drift_file] in s
}
