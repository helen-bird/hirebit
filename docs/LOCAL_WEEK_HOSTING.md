# One-week local hosting

This is a lower-cost, single-Mac deployment, **not a seven-day uptime guarantee**.
The Mac must stay plugged in, open, connected to a stable network, and logged in.
Screen locking is safe; logging out, manual sleep, shutdown, closing the lid, or a network outage
can interrupt service. Do not disable the screen password or FileVault.

## Installation and operation

From the repository, with the existing private `.env` and `.env.public-demo`:

```sh
npm run ops:install
npm run ops:start
npm run ops:status
```

The installer creates the user LaunchAgent `local.hirebit.supervisor` and private
`.local-ops/config.json`. No secrets are embedded in the LaunchAgent. The supervisor:

- starts Buyer and Seller on loopback, with real BTC forced off;
- restarts only child processes it owns, with 1–60 second crash backoff;
- runs `caffeinate -is` until the persisted seven-day deadline; restarting does not extend it;
- does **not** change system sleep preferences, display settings or screen security;
- probes Buyer, Seller, the public `/health` endpoint and Docker once per minute;
- records state changes and low-disk warnings (under 5 GiB) in private, redacted logs;
- runs the named-tunnel connector with a minimal environment, without model/provider keys;
- requires its tunnel token to be an owner-only regular file (`0600`) and redacts it from logs;
- rotates `services.log` at 2 MiB and retains three rotations;
- retains eight daily, private JSON state snapshots, without copying wallet keys or API tokens.

Health status is written to `.local-ops/health.json`. `ops:status` reports whether the LaunchAgent
is loaded and whether the observation is stale. These are local checks, **not external alerts**:
if this Mac or its internet connection stops, the checker cannot independently notify you.
An HTTP 200 health result is also not proof that Google/DeepSeek can fulfill a paid production.

No health probe creates a delegation, invokes a model, signs a payment, or submits an order.
An unresponsive process is reported, not forcibly recycled during potentially paid work.
Actual process exits are automatically restarted; the application retains its existing durable
recovery and uncertain-submission rules. No uncertain payment or model submission is blindly retried.

## Dependencies and remaining limits

Docker Desktop must already be running. The supervisor does not restart the global Docker engine,
change other projects, remove render containers, delete generated videos or erase order data.
After a machine reboot, log in, start Docker if needed, and check `ops:status` plus Seller `/ready`.
A user LaunchAgent starts at login; it cannot unlock a FileVault-protected machine for you.

The original Pages URL remains unchanged. The current deployment uses a named tunnel and a stable
hostname under the Cloudflare-managed domain, as recorded below. A fresh deployment needs its own
Cloudflare-managed domain and named tunnel. The earlier Quick Tunnel could change hostname on restart
or lose its server-side registration.
Docker's `unless-stopped` restart policy cannot repair an expired Quick Tunnel registration.
The supervisor deliberately does not silently create replacement random tunnels or retain broad
Cloudflare account credentials for unattended redeployments.

For a fresh deployment, configure a named tunnel for **only** Buyer `127.0.0.1:8788`, retaining
the host allowlist, exact frontend origin, token gate and payment restrictions. A native cloudflared
binary and an owner-only token file can be specified in `.local-ops/config.json`:

```json
{
  "keepAwakeUntil": "<existing ISO timestamp>",
  "tunnel": {
    "binary": "<absolute path to cloudflared>",
    "tokenFile": "<absolute path to private tunnel token file>"
  }
}
```

The token value is never put in command-line arguments. Update Pages `UPSTREAM_ORIGIN` and the
Buyer hostname allowlist to the stable hostname; then stop the previous project-specific tunnel
after verification. Do not expose Seller or broaden the host allowlist to a wildcard.

## Stop and recovery

```sh
npm run ops:stop
```

This unloads this LaunchAgent and stops only its owned services and keep-awake process.
An existing unmanaged Docker tunnel is **not** stopped by this command; stop that named container
separately if taking the site offline. The plist remains for next login; to retire hosting permanently,
unload it and remove only `local.hirebit.supervisor.plist` from your user's LaunchAgents directory.

Stopping/restarting Buyer invalidates its in-memory browser sessions; users may need to re-enter
the access token. Do not restart during active paid production just to refresh the UI.

Backups under `.local-ops/backups` are local state snapshots, not disaster-recovery backups.
Each source JSON file is atomic but the group is not a cross-service transaction; it excludes media.
Restore manually only after stopping both services and reconciling orders, payment records and Veo
reservations. Never restore an old spending ledger independently to bypass quotas.

## Acceptance checks

- Check `ops:status`: Buyer/Seller/public health, Docker, keep-awake and disk space.
- Check `pmset -g assertions`: this project's caffeinate assertion must be present.
- Check Seller `/ready` without generating a video.
- Visit the public console and verify assets and authentication; do not count this as a real production test.
- In an idle window, stop one **verified owned** Buyer PID and confirm automatic restart and recovery.
- Test screen-lock behaviour with the user's cooperation; do not claim lid-closed support.
- Recheck from a second device/network. The local checker does not establish global availability.

### Verification record — 2026-09-22

The user LaunchAgent was installed and started. Buyer and Seller local health, public Pages health,
Docker availability, and Seller readiness passed. The public console loaded in a browser.
An idle, supervisor-owned Buyer was terminated with SIGTERM; it restarted after roughly one second
and returned to healthy status without restarting Seller. All 130 project tests passed, including
four supervision tests. No new model generation or Bitcoin transaction was performed.

The previous Quick Tunnel returned `Unauthorized: Tunnel not found`; it was manually restarted,
then the private Buyer allowlist and Pages upstream configuration were updated and the gateway
redeployed. This recovered access but **did not implement a stable named tunnel**. The account had
no Cloudflare zones and the operator confirmed there was no existing domain.
Screen-lock, independent-network access, week-long uptime, and alert delivery
have not been verified. The later machine-reboot and alert configuration are recorded below.

### Named-tunnel migration — completed 2026-09-23

`hirebit-demo.xyz` was registered for one year and domain auto-renewal was disabled.
Its registrar nameservers were changed to the Cloudflare-assigned pair, and the Free plan has
the proxied `origin.hirebit-demo.xyz` CNAME pointing to the dedicated `hirebit-demo` tunnel.
The native Cloudflare client (2026.9.1, official release asset SHA-256 verified) runs under the
supervisor, routing only this hostname to Buyer on loopback; unmatched hosts return 404.
Tunnel credentials and deployment files remain under ignored `.local-ops/` with private permissions.

The Cloudflare API reported a healthy tunnel. A deliberate SIGTERM of the verified tunnel child
was followed by automatic restart about one second later, with the same tunnel identity; Buyer
and Seller stayed running. Four supervision tests and syntax/diff checks passed. The original
Pages console rendered in a browser, public health returned 200, and unauthenticated delegation
access returned 401. Seller readiness passed. No paid generation or real Bitcoin test was run.

Cloudflare now reports the zone as active. The fixed origin passed HTTPS validation, Buyer health
and unauthenticated-access checks. Pages production `UPSTREAM_ORIGIN` was switched to
`https://origin.hirebit-demo.xyz`, and gateway deployment `788d60a2` was published to the existing
project. The judges' URL remains `https://sats-story-hirebit.pages.dev/console/`.

The original console, JavaScript, CSS and product image returned 200; Token login and authenticated
reads passed, session cookies retained Secure/HttpOnly/SameSite=Strict, unauthenticated reads returned
401, and cross-origin login returned 403. The console rendered in the browser. The old
`hirebit-public-tunnel` container was stopped (not deleted), and its hostname was removed from the
Buyer allowlist during an idle reload. All order data, spending ledgers and media were retained.

That reload exposed a launchd race: `bootout` returned before the job disappeared, so the immediate
start initially skipped loading it. The service was explicitly started again and the stop command
now waits for the job to unload before returning. This was a brief reload interruption, not a
change to the fixed tunnel identity. No new order, paid video generation or Bitcoin payment was run.
An idle stop/start with the corrected command then passed; Buyer, Seller and public health recovered,
and the original Pages assets, Token login, authenticated reads and unauthenticated 401 were rechecked successfully.
The laptop, network, Docker, screen-lock/reboot and week-long-uptime limitations above still apply.

### Machine reboot drill — 2026-09-23

After an actual macOS restart and user login, launchd automatically recovered the Hirebit
supervisor, Buyer, Seller process, native tunnel and keep-awake assertion. The original Pages
console, app script and public health returned 200, while an unauthenticated delegation request
returned 401. Docker Desktop did not start automatically, so Seller initially reported
`ready: false` and could not offer production workflows. Opening Docker Desktop and restarting
only the idle, supervisor-owned Seller process restored `ready: true`, verified Docker worker
isolation and all four production workflows. No order, model generation or BTC payment was run.
This test demonstrates recovery with a manual Docker step, not unattended production recovery.

### Tunnel alert — 2026-09-23

A Cloudflare Tunnel Health Alert named `Hirebit demo tunnel health` is enabled for only the
`hirebit-demo` tunnel. It emails the Cloudflare account owner when the tunnel becomes healthy,
degraded or down. The saved account email and tunnel filter were checked in the dashboard, and
a sample notification was submitted using Cloudflare's Test action. The operator reported receiving
the email; delivery was not independently audited. This alert observes tunnel connectivity, not Seller readiness or
end-to-end video production.
