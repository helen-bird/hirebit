# Security and incident operations

## Trust boundaries

- DeepSeek may propose interpretations and rankings; it cannot authorize a mandate, select an out-of-policy product, sign a PSBT or invoke tools.
- The Seller may quote and fulfill only locally allowlisted, accepted workflows.
- Hypit receives a minimized environment, a localized commission and no wallet/merchant/API credentials. Production Docker mode is fail-closed unless an attestation matches the exact current image ID.
- GoBTC responses are untrusted until order amount, recipient, expiry, PSBT inputs/outputs, absolute fee, independently bounded fee rate and payment status have been validated locally.

## Hypit worker isolation

The production worker uses one container and one Docker volume per order. It has no network, no Docker socket and no repository bind mount. The root filesystem is read-only; `/tmp` and the isolated home are tmpfs mounts; the process uses the host operator's non-root UID, drops every Linux capability and enables `no-new-privileges`. Only the localized job copy is staged into `/work/job`. The runner rejects absolute host paths outside the allowlisted order root and copies only an explicitly requested exported artifact back.

`npm run worker:verify` checks those runtime settings, attempts forbidden reads and writes, checks that payment/model/API secrets are absent, verifies that the order volume remains writable, and completes a real offline Hypit Build/export. The resulting `.seller/isolation-verification.json` is valid only for its recorded image name and immutable image ID. Do not copy that file to another machine or set `HYPIT_WORKER_ISOLATION_VERIFIED=1` without rerunning the verifier there.

The 2026-09-20 deployment verification passed all 11 required tests against image `sha256:f1c10b630a491dda53a5590867e9f3dd96bd09ae0032837e129547cdfb365e13`. Build `bld_20260920T124203831Z_17AD4843A5` exported a 16-second 540×960 video with audio while the container was offline. This proves worker isolation for that image on this machine; it does not independently prove GoBTC availability or every product's maximum variant matrix.

## Emergency stop

Set `paymentsEnabled` to `false` in `config/buyer-policy.json`. The Buyer reloads this flag before PSBT preparation and again immediately before submission. Already submitted or uncertain payments remain reserved and are reconciled; they are never blindly resubmitted.

## Recovery rules

- Do not delete `.buyer`, `.seller` or `.gobtcpay` during recovery.
- A `submitting_payment` restart becomes `payment_uncertain` and only status reconciliation is allowed.
- A producing order with a durable Hypit Build ID reattaches to that Build. A legacy interrupted order without an ID fails closed and requires explicit production retry.
- Buyer and Seller process locks prevent two local instances from executing the same state files.
- Paid production failure can be retried explicitly. Cancellation is accepted only before payment might have been submitted; later cases enter human resolution rather than claiming an automatic refund.
- A terminal worker cleanup removes only the deterministic container and volume for that exact order. It never stops Docker globally or removes unrelated containers/volumes.

## Deployment limits

The included Console is a loopback operator interface, not a multi-customer identity or tenancy system. Do not expose it publicly without TLS, user identity/ownership, authorization per customer, durable session storage and an external security review.
