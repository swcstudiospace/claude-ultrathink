# Compliance mapping: SOC 2, ISO/IEC 27001, GDPR

This document is an **engineering mapping, not an attestation**. It links each control to repository evidence so that
a control owner and an auditor can check it. It does not show that any control is effective, and no auditor has
accepted it. The framework clause numbers below are unvalidated and are marked **owner to validate** (Phase 75, D6).

Source of truth: `policy/controls.json`. Each control lists its evidence paths, optional `pending` reason, and optional
`findings`. The generator, `bun policy/compliance-report.ts --root . [--out <file>]`, checks that each evidence path
exists, records the sha256 of each present file, and reports each control as:

- `PASS`: all evidence is present and the control is not pending.
- `FAIL`: any evidence path is missing. The generator exits 1.
- `PENDING`: the control has a `pending` reason.

A control with no evidence and no `pending` is a schema error (exit 2).

## Control table

Clause references are as listed in `policy/controls.json` (**owner to validate**). SOC 2 references are to the
Trust Services Criteria common criteria and confidentiality category. ISO/IEC 27001 references are to Annex A of the
2022 edition. GDPR references are to articles.

| ID | Control | SOC 2 | ISO/IEC 27001 | GDPR | Evidence (repo paths) | Pending |
|---|---|---|---|---|---|---|
| ACCESS | Access control and credential management | CC6.1, CC6.2, CC6.3 | 5.15, 5.17, 8.2 | Art. 25, Art. 32(1)(b) | `services/ultrathink/auth/auth.ts` | |
| LOGGING | Audit logging and audit-chain verification | CC4.1, CC7.2 | 8.15, 8.16 | Art. 5(2), Art. 32(1)(d) | `services/ultrathink/obs/audit.ts`, `services/ultrathink/obs/audit-cli.ts` | |
| CHANGE | Change management and CI policy gates | CC8.1 | 8.25, 8.32 | Art. 25, Art. 32(1)(d) | `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/policy.yml` | |
| VULN | Vulnerability management and dependency audit | CC7.1 | 8.8 | Art. 32(1)(d) | `.github/workflows/security-scan.yml` | |
| CONFIG | Secure configuration and service sandbox baseline | CC6.6, CC7.1 | 8.9 | Art. 25, Art. 32(1)(b) | `deploy/ultrathink-web.service`, `policy/units.rego` | |
| RETENTION | Data retention and erasure | C1.2 | 8.10, 8.13 | Art. 5(1)(e), Art. 17 | `services/ultrathink/store/retention.ts`, `deploy/ultrathink-backup.sh` | |
| CRYPTO-BACKUP | Backup encryption and customer-managed key custody | C1.1, CC6.7 | 8.13, 8.24 | Art. 32(1)(a) | `deploy/ultrathink-dr-lib.sh` | Phase 74 DR-05 is partly implemented; key custody is BLOCKED |

## Open findings

### RET-D7: retention window is shorter than archive retention (control RETENTION)

Live SQLite runs are pruned after `ULTRATHINK_RETENTION_DAYS` (default 30). Daily archives are kept for
`ULTRATHINK_BACKUP_KEEP` (default 14), and they contain the data that was pruned. Off-host copies persist until the
target's own cleanup removes them. A deleted record can therefore remain in archives after the live window closes. The
repository defines no erasure deadline that covers archives. This is disclosed here and is not resolved by this phase
(D7). Closing it needs a retention decision from the data owner, then a change to the backup retention settings or to
the erasure procedure.

### CRYPTO-BACKUP: customer-managed key custody is BLOCKED (control CRYPTO-BACKUP)

Phase 74 DR-05 encrypts archives and off-host pushes to customer recipients with `age` (`dr_age` in
`deploy/ultrathink-dr-lib.sh`) when a recipient is set. Without one, nothing is pushed off-host
(`deploy/ultrathink-backup.sh` header). Key creation and custody are not in the repository. They need a KMS, HSM or
token, a named key owner, and a rotation procedure. Until then the control stays `PENDING`.

## Prerequisites for auditor attestation

An attestation requires all of the following. None is in the repository.

1. **Control owners** named for each control, who validate the clause references in `policy/controls.json`.
2. **An organisation control catalog.** This mapping covers only the controls and repository scope listed above.
3. **An auditor-accepted mapping.** An auditor must accept the table and the findings above.
4. **Organisation-wide policy inventory (Phase 75 C1).** This needs an org admin export of GitHub rulesets and
   environment protection rules, and an owner-provided inventory of cloud IAM policy. The policy-as-code scope is
   planned to cover only the enumerated domains: workflows, the web and drift units, and the security headers.
5. **Host runtime evidence (Phase 75 C2).** An operator must install `ultrathink-drift.{service,timer}` as root on the
   production host, and a journal must show a passing run.
6. **Remediation approval gate (Phase 75 C3).** Automated drift remediation needs root on the production host and an
   approval gate, such as a GitHub environment with required reviewers. That setting is a repository-admin action. Drift
   detection is report-only (D2) until then.
7. **Customer key custody (Phase 74 DR-05).** See CRYPTO-BACKUP above.
8. **Rego verification.** The Rego rules run only in CI or after the pinned OPA binary is installed, because the binary
   is not available in this environment.
