
# Unit policy (U2b). Input: the `units` array of the shared input contract written by policy/collect.ts. Values in
# `sections` are arrays of strings in file order. Each violation is {"rule", "file", "detail"}.
package ultrathink.policy

import rego.v1

# Units whose baseline passes today. The maintenance unit stays out until its baseline passes (D5).
unit_scope := {
	"deploy/ultrathink-web.service",
	"deploy/ultrathink-drift.service",
}

# The [Service] section of a scoped unit. Iteration runs over unit_scope, not over the input, so a scoped unit that is
# missing from the input yields {} and every required directive is reported. An absent unit fails closed.
scope_service(file) := section if {
	some unit in input.units
	unit.file == file
	section := object.get(unit.sections, "Service", {})
} else := {}

# U-R1: the required hardening directives and their exact values.
required_directives := {
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
}

violations contains {"rule": "U-R1", "file": file, "detail": sprintf("Service.%s must be %s", [key, json.marshal(want)])} if {
	some file in unit_scope
	some key, want in required_directives
	not scope_service(file)[key] == want
}

# U-R2: the privileged system-call group is excluded from SystemCallFilter.
violations contains {"rule": "U-R2", "file": file, "detail": "Service.SystemCallFilter must contain ~@privileged"} if {
	some file in unit_scope
	not "~@privileged" in object.get(scope_service(file), "SystemCallFilter", [])
}

# U-R3: RestrictAddressFamilies is a whitespace-separated list, so each token is checked. A line such as
# "AF_INET AF_NETLINK" is caught. An empty entry resets the list to unrestricted, and the empty token is rejected. An
# absent directive is rejected too: the list defaults to empty, and an empty list would pass.
allowed_address_families := {"AF_INET", "AF_INET6", "AF_UNIX"}

violations contains {"rule": "U-R3", "file": file, "detail": sprintf("Service.RestrictAddressFamilies token %s is not allowed", [family])} if {
	some file in unit_scope
	some entry in object.get(scope_service(file), "RestrictAddressFamilies", [])
	some family in regex.split(`\s+`, trim_space(entry))
	not family in allowed_address_families
}

violations contains {"rule": "U-R3", "file": file, "detail": "Service.RestrictAddressFamilies must be set"} if {
	some file in unit_scope
	not "RestrictAddressFamilies" in object.keys(scope_service(file))
}

# U-R4: User is present and is not root. Numeric uid 0 is root as well. Every entry is checked, so a repeated key
# cannot carry root past the rule.
privileged_users := {"root", "0"}

user_ok(users) if {
	count(users) > 0
	every user in users {
		trim_space(user) != ""
		not trim_space(user) in privileged_users
	}
}

violations contains {"rule": "U-R4", "file": file, "detail": "Service.User must be present and must not be root"} if {
	some file in unit_scope
	not user_ok(object.get(scope_service(file), "User", []))
}
