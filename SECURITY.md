# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, authorize payment,
access private campaign media or cause paid provider usage. Contact the repository owner privately
and include the affected revision, impact, reproduction steps and any suggested mitigation. Do not
include real tokens, private keys, customer media or wallet data in the report.

## Supported version

Security fixes target the current default branch. This repository is a single-operator reference
implementation and does not claim production multi-tenant hardening.

## Secret handling

The repository must contain examples only. Real values belong in ignored `.env` files, OS-managed
credentials or a deployment secret manager. Before publishing a revision:

1. Inspect `git status --ignored` and the staged file list.
2. Scan the complete Git history, not only the working tree.
3. If a credential ever entered Git, revoke or rotate it; deleting the file is insufficient.
4. Never publish `.buyer`, `.seller`, `.gobtcpay`, Google credential files, Hypit runtime state or
   deployment bundles produced from a private environment.

The detailed threat model and operating controls are documented in
[`docs/SECURITY.md`](docs/SECURITY.md).
