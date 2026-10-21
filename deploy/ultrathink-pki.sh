#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Internal PKI for the ultrathink TLS leaves (app, edge, ops). An offline root (pathlen:1) signs an intermediate that
# runs on the VPS (pathlen:0), and the intermediate issues short-lived leaves (24 h by default). ECDSA P-256 throughout.
# ultrathink-cert-renew.sh calls renew-if-due hourly. Needs openssl, GNU date and mktemp, plus coreutils and awk.
#
#   init-root <root-dir> [--force]
#       root.key (0400) and root.pem: self-signed, CA:TRUE pathlen:1, 10 years. Run offline, never on the VPS.
#   init-intermediate <tls-dir> [--force]
#       <tls-dir>/intermediate/intermediate.key (0400) and intermediate.csr. Runs on the VPS.
#   sign-intermediate <root-dir> <csr> <out.pem>
#       Signs the CSR as CA:TRUE pathlen:0 for 1 year. <out.pem> receives the intermediate, then the root. Write it to
#       <tls-dir>/intermediate/intermediate.pem.
#   issue <tls-dir> <name> <spiffe-id> [--ip <addr>] [--hours <1-24>] [--group <grp>]
#       Writes <tls-dir>/<name>/cert.pem (leaf, then intermediate) and key.pem, mode 0400 or 0440 with --group.
#       Writes <tls-dir>/ca.pem (root, then intermediate) when it is absent.
#   renew-if-due <tls-dir> <name>... [--hours <1-24>]
#       Re-issues each leaf that expires within 12 h, keeping its SPIFFE URI, IP SAN and group. Prints "renewed <name>"
#       or "kept <name>". Stops at the first failing name and exits non-zero; that name's files are left untouched.
#
# Layout under <tls-dir>: ca.pem, intermediate/ (0700: the intermediate key and the openssl ca database), and <name>/
# (0750). Private keys are written only under the directory the caller names. The script prints status lines and
# errors and nothing else; it never echoes key material and never enables tracing.
set -eu
set -f
umask 077

PROG=ultrathink-pki.sh
ROOT_DAYS=3650
INTERMEDIATE_DAYS=365
RENEW_WINDOW=43200
WORK=""

die() {
	printf '%s: %s\n' "$PROG" "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
usage: ultrathink-pki.sh <command> [arguments]
  init-root <root-dir> [--force]
  init-intermediate <tls-dir> [--force]
  sign-intermediate <root-dir> <csr> <out.pem>
  issue <tls-dir> <name> <spiffe-id> [--ip <addr>] [--hours <1-24>] [--group <grp>]
  renew-if-due <tls-dir> <name>... [--hours <1-24>]
EOF
}

# valid <ere> <value>: true when value is a single line that matches the extended regular expression.
valid() {
	[ "$2" = "$(printf '%s' "$2" | tr -d '\n')" ] || return 1
	printf '%s\n' "$2" | grep -Eq -- "$1"
}

need() {
	_missing=""
	for _c in "$@"; do
		command -v "$_c" >/dev/null 2>&1 || _missing="$_missing $_c"
	done
	if [ -n "$_missing" ]; then
		die "missing required command(s):$_missing"
	fi
}

abspath() {
	case $1 in
	/*) printf '%s\n' "$1" ;;
	*) printf '%s/%s\n' "$PWD" "$1" ;;
	esac
}

drop_work() {
	if [ -n "$WORK" ]; then
		rm -rf -- "$WORK"
	fi
	WORK=""
}

trap drop_work EXIT
trap 'exit 1' HUP INT TERM

check_name() {
	valid '^[A-Za-z0-9][A-Za-z0-9._-]*$' "$1" || die "invalid leaf name: $1"
}

check_spiffe() {
	valid '^spiffe://[a-z0-9._-]+/[A-Za-z0-9._/-]+$' "$1" ||
		die "invalid SPIFFE ID (want spiffe://<lowercase trust domain>/<path>, no query): $1"
}

check_hours() {
	valid '^[0-9]{1,2}$' "$1" && [ "$1" -ge 1 ] && [ "$1" -le 24 ] || die "--hours must be an integer from 1 to 24"
}

check_ip() {
	valid '^[0-9A-Fa-f:.]+$' "$1" || die "invalid --ip: $1"
}

check_group() {
	valid '^[A-Za-z0-9_][A-Za-z0-9._-]*$' "$1" || die "invalid --group: $1"
}

parse_force() {
	FORCE=0
	for _a in "$@"; do
		case $_a in
		--force) FORCE=1 ;;
		*) die "unknown argument: $_a" ;;
		esac
	done
}

# enddate <hours>: the openssl ca -enddate value (UTCTime, UTC) that many hours from now.
enddate() {
	date -u -d "+$1 hours" '+%y%m%d%H%M%SZ'
}

# write_ext <file>: the request and CA extension sections, shared by req and x509.
write_ext() {
	cat > "$1" <<'EOF'
[ req ]
distinguished_name = dn
prompt = no

[ dn ]

[ v3_root ]
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[ v3_intermediate ]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
}

# write_ca <file> <intermediate-dir> <intermediate-cert>: openssl ca configuration for the intermediate.
# unique_subject is off so a renewal can reuse the leaf's subject; the serial is sequential and kept in the database.
write_ca() {
	cat > "$1" <<EOF
[ ca ]
default_ca = ultrathink_intermediate

[ ultrathink_intermediate ]
dir = $2
database = \$dir/index.txt
new_certs_dir = \$dir/newcerts
serial = \$dir/serial
certificate = $3
private_key = \$dir/intermediate.key
default_md = sha256
default_days = 1
unique_subject = no
copy_extensions = none
preserve = no
policy = policy_any

[ policy_any ]
commonName = supplied
EOF
}

cmd_init_root() {
	[ $# -ge 1 ] || die "init-root needs <root-dir>"
	_dir=$(abspath "$1")
	shift
	parse_force "$@"
	mkdir -p -m 0700 "$_dir"
	if [ -e "$_dir/root.key" ] && [ "$FORCE" -ne 1 ]; then
		die "refusing to overwrite $_dir/root.key; pass --force to replace the root CA"
	fi
	WORK=$(mktemp -d "$_dir/.init-root.XXXXXX")
	write_ext "$WORK/ext.cnf"
	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$WORK/root.key"
	chmod 0400 "$WORK/root.key"
	openssl req -x509 -new -sha256 -days "$ROOT_DAYS" -key "$WORK/root.key" \
		-subj "/CN=ultrathink internal root CA" -config "$WORK/ext.cnf" -extensions v3_root -out "$WORK/root.pem"
	chmod 0644 "$WORK/root.pem"
	mv -f "$WORK/root.key" "$_dir/root.key"
	mv -f "$WORK/root.pem" "$_dir/root.pem"
	drop_work
	printf 'root CA written to %s\n' "$_dir"
}

cmd_init_intermediate() {
	[ $# -ge 1 ] || die "init-intermediate needs <tls-dir>"
	_tls=$(abspath "$1")
	shift
	parse_force "$@"
	_ica="$_tls/intermediate"
	mkdir -p -m 0750 "$_tls"
	mkdir -p -m 0700 "$_ica"
	if [ -e "$_ica/intermediate.key" ] && [ "$FORCE" -ne 1 ]; then
		die "refusing to overwrite $_ica/intermediate.key; pass --force to replace the intermediate CA"
	fi
	WORK=$(mktemp -d "$_ica/.init.XXXXXX")
	write_ext "$WORK/ext.cnf"
	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$WORK/intermediate.key"
	chmod 0400 "$WORK/intermediate.key"
	openssl req -new -sha256 -key "$WORK/intermediate.key" \
		-subj "/CN=ultrathink internal intermediate CA" -config "$WORK/ext.cnf" -out "$WORK/intermediate.csr"
	chmod 0644 "$WORK/intermediate.csr"
	# The CA database survives --force: reusing a serial number would make an existing leaf ambiguous.
	if [ ! -e "$_ica/index.txt" ]; then : > "$_ica/index.txt"; fi
	if [ ! -e "$_ica/index.txt.attr" ]; then printf 'unique_subject = no\n' > "$_ica/index.txt.attr"; fi
	if [ ! -e "$_ica/serial" ]; then printf '01\n' > "$_ica/serial"; fi
	if [ ! -d "$_ica/newcerts" ]; then mkdir -m 0700 "$_ica/newcerts"; fi
	mv -f "$WORK/intermediate.key" "$_ica/intermediate.key"
	mv -f "$WORK/intermediate.csr" "$_ica/intermediate.csr"
	drop_work
	printf 'intermediate CSR written to %s\n' "$_ica/intermediate.csr"
}

cmd_sign_intermediate() {
	[ $# -eq 3 ] || die "sign-intermediate needs <root-dir> <csr> <out.pem>"
	_root=$(abspath "$1")
	_csr=$(abspath "$2")
	_out=$(abspath "$3")
	if [ ! -f "$_root/root.key" ] || [ ! -f "$_root/root.pem" ]; then
		die "missing root CA in $_root (run init-root)"
	fi
	if [ ! -f "$_csr" ]; then
		die "missing CSR: $2"
	fi
	WORK=$(mktemp -d "$(dirname "$_out")/.sign.XXXXXX")
	write_ext "$WORK/ext.cnf"
	openssl x509 -req -sha256 -in "$_csr" -CA "$_root/root.pem" -CAkey "$_root/root.key" \
		-set_serial "0x$(openssl rand -hex 16)" -days "$INTERMEDIATE_DAYS" \
		-extfile "$WORK/ext.cnf" -extensions v3_intermediate -out "$WORK/intermediate.pem"
	cat "$WORK/intermediate.pem" "$_root/root.pem" > "$WORK/chain.pem"
	chmod 0644 "$WORK/chain.pem"
	mv -f "$WORK/chain.pem" "$_out"
	drop_work
	printf 'intermediate chain written to %s\n' "$2"
}

# issue_leaf <tls-dir> <name> <spiffe-id> <ip-or-empty> <hours> <group-or-empty>
# Builds the key, CSR and certificate in a scratch directory inside the leaf, verifies the chain, and only then moves
# the new key and certificate into place. Any failure before the moves leaves the old files as they were.
issue_leaf() {
	i_tls=$1
	i_name=$2
	i_id=$3
	i_ip=$4
	i_hours=$5
	i_group=$6
	i_ca="$i_tls/intermediate"
	i_leaf="$i_tls/$i_name"
	if [ ! -f "$i_ca/intermediate.key" ]; then
		die "missing intermediate key: $i_ca/intermediate.key (run init-intermediate)"
	fi
	if [ ! -f "$i_ca/intermediate.pem" ]; then
		die "missing intermediate chain: $i_ca/intermediate.pem (run sign-intermediate)"
	fi
	if [ ! -f "$i_ca/index.txt" ] || [ ! -f "$i_ca/serial" ]; then
		die "missing CA database under $i_ca (run init-intermediate)"
	fi
	if [ "$(grep -c 'BEGIN CERTIFICATE' "$i_ca/intermediate.pem")" -ne 2 ]; then
		die "$i_ca/intermediate.pem must hold the intermediate certificate, then the root"
	fi
	mkdir -p -m 0750 "$i_leaf"
	WORK=$(mktemp -d "$i_leaf/.issue.XXXXXX")
	write_ext "$WORK/ext.cnf"
	awk '/BEGIN CERTIFICATE/ { n++ } n == 1' "$i_ca/intermediate.pem" > "$WORK/intermediate-cert.pem"
	write_ca "$WORK/ca.cnf" "$i_ca" "$WORK/intermediate-cert.pem"
	i_san="URI:$i_id"
	if [ -n "$i_ip" ]; then
		i_san="$i_san, IP:$i_ip"
	fi
	{
		printf '[ leaf ]\n'
		printf 'basicConstraints = critical, CA:FALSE\n'
		printf 'keyUsage = critical, digitalSignature\n'
		printf 'extendedKeyUsage = serverAuth, clientAuth\n'
		printf 'subjectKeyIdentifier = hash\n'
		printf 'authorityKeyIdentifier = keyid\n'
		printf 'subjectAltName = %s\n' "$i_san"
	} >> "$WORK/ext.cnf"
	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$WORK/key.pem"
	openssl req -new -sha256 -key "$WORK/key.pem" -config "$WORK/ext.cnf" -subj "/CN=$i_name" -out "$WORK/leaf.csr"
	i_end=$(enddate "$i_hours")
	openssl ca -batch -notext -utf8 -config "$WORK/ca.cnf" -extfile "$WORK/ext.cnf" -extensions leaf \
		-enddate "$i_end" -in "$WORK/leaf.csr" -out "$WORK/leaf-only.pem" >/dev/null
	cat "$WORK/leaf-only.pem" "$WORK/intermediate-cert.pem" > "$WORK/cert.pem"
	if [ ! -f "$i_tls/ca.pem" ]; then
		cat "$i_ca/intermediate.pem" > "$i_tls/ca.pem"
		chmod 0644 "$i_tls/ca.pem"
	fi
	openssl verify -CAfile "$i_tls/ca.pem" "$WORK/cert.pem" >/dev/null ||
		die "new certificate for $i_name does not verify against $i_tls/ca.pem"
	if [ -n "$i_group" ]; then
		chgrp "$i_group" "$WORK/key.pem" || die "cannot set group $i_group on the key for $i_name"
		chmod 0440 "$WORK/key.pem"
	else
		chmod 0400 "$WORK/key.pem"
	fi
	chmod 0644 "$WORK/cert.pem"
	mv -f "$WORK/key.pem" "$i_leaf/key.pem"
	mv -f "$WORK/cert.pem" "$i_leaf/cert.pem"
	drop_work
}

cmd_issue() {
	[ $# -ge 3 ] || die "issue needs <tls-dir> <name> <spiffe-id>"
	_tls=$1
	_name=$2
	_id=$3
	shift 3
	_hours=24
	_ip=""
	_group=""
	while [ $# -gt 0 ]; do
		case $1 in
		--hours)
			[ $# -ge 2 ] || die "--hours needs a value"
			check_hours "$2"
			_hours=$2
			shift 2
			;;
		--ip)
			[ $# -ge 2 ] || die "--ip needs a value"
			check_ip "$2"
			_ip=$2
			shift 2
			;;
		--group)
			[ $# -ge 2 ] || die "--group needs a value"
			check_group "$2"
			_group=$2
			shift 2
			;;
		*) die "unknown argument: $1" ;;
		esac
	done
	check_name "$_name"
	check_spiffe "$_id"
	_tls=$(abspath "$_tls")
	issue_leaf "$_tls" "$_name" "$_id" "$_ip" "$_hours" "$_group"
	printf 'issued %s\n' "$_name"
}

# renew_one <tls-dir> <name> <hours>
# Reads the SPIFFE URI, IP SAN and group from the current leaf and re-issues it only when it expires within the window.
renew_one() {
	r_leaf="$1/$2"
	r_cert="$r_leaf/cert.pem"
	r_key="$r_leaf/key.pem"
	if [ ! -f "$r_cert" ] || [ ! -f "$r_key" ]; then
		die "no leaf for $2 under $1 (issue it first)"
	fi
	openssl x509 -noout -in "$r_cert" >/dev/null || die "cannot parse $r_cert"
	if openssl x509 -noout -checkend "$RENEW_WINDOW" -in "$r_cert" >/dev/null; then
		printf 'kept %s\n' "$2"
		return 0
	fi
	r_ext=$(openssl x509 -noout -ext subjectAltName -in "$r_cert") || die "cannot read the SAN of $r_cert"
	r_id=$(printf '%s\n' "$r_ext" | sed -n 's/.*URI:\([^, ]*\).*/\1/p')
	r_ip=$(printf '%s\n' "$r_ext" | sed -n 's/.*IP Address:\([^, ]*\).*/\1/p')
	if [ -z "$r_id" ]; then
		die "$r_cert has no SPIFFE URI SAN; re-issue $2 with issue"
	fi
	# A key given to a group is mode 0440, so group-read in the mode marks a --group leaf; the group is field 4.
	r_group=""
	r_perm=$(ls -l "$r_key" | awk '{ print $1 }')
	case $r_perm in
	????r*) r_group=$(ls -l "$r_key" | awk '{ print $4 }') ;;
	esac
	issue_leaf "$1" "$2" "$r_id" "$r_ip" "$3" "$r_group"
	printf 'renewed %s\n' "$2"
}

cmd_renew_if_due() {
	[ $# -ge 1 ] || die "renew-if-due needs <tls-dir> <name>..."
	_tls=$(abspath "$1")
	shift
	_hours=24
	_names=""
	while [ $# -gt 0 ]; do
		case $1 in
		--hours)
			[ $# -ge 2 ] || die "--hours needs a value"
			check_hours "$2"
			_hours=$2
			shift 2
			;;
		--*) die "unknown argument: $1" ;;
		*)
			check_name "$1"
			_names="$_names $1"
			shift
			;;
		esac
	done
	[ -n "$_names" ] || die "renew-if-due needs at least one <name>"
	# Names passed check_name, so they hold no whitespace or glob characters and word splitting is safe.
	for _n in $_names; do
		renew_one "$_tls" "$_n" "$_hours"
	done
}

cmd=${1-}
if [ $# -gt 0 ]; then
	shift
fi
case $cmd in
init-root | init-intermediate | sign-intermediate | issue | renew-if-due)
	need openssl awk sed grep tr date mktemp mkdir mv chmod chgrp ls cat dirname rm
	;;
esac
case $cmd in
init-root) cmd_init_root "$@" ;;
init-intermediate) cmd_init_intermediate "$@" ;;
sign-intermediate) cmd_sign_intermediate "$@" ;;
issue) cmd_issue "$@" ;;
renew-if-due) cmd_renew_if_due "$@" ;;
help | -h | --help) usage ;;
"")
	usage >&2
	exit 2
	;;
*)
	usage >&2
	die "unknown command: $cmd"
	;;
esac
