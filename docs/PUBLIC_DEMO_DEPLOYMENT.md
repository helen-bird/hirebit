# Restricted public-demo deployment

For the supervised one-week Mac deployment, see [Local hosting operations](LOCAL_WEEK_HOSTING.md).
It adds bounded keep-awake, process recovery, health checks and private state snapshots.
A fixed named tunnel requires a Cloudflare-managed domain. The local operations guide records the
current migration and activation status; a Quick Tunnel is not an uptime guarantee.
The current Hirebit deployment completed its named-tunnel cutover on 2026-09-23; its Pages entry
URL is unchanged, and the old temporary tunnel is stopped.

The deployment places a Cloudflare Pages Worker in front of an outbound tunnel:

```text
browser → Pages Worker → HTTPS tunnel → Buyer 127.0.0.1:8788 → Seller 127.0.0.1:8787
```

Only the Buyer is tunneled. The Seller, wallet material, Google ADC and local files must never bind
to a public interface. The public profile refuses to start unless `PAYMENT_MODE=demo`, so it cannot
authorize or submit a Bitcoin payment.

## Safety boundary

- The token configured by `PUBLIC_DEMO_ACCESS_TOKEN` is accepted only with both
  `PUBLIC_DEMO_MODE=1` and `PAYMENT_MODE=demo`. It is a demo gate, not user authentication.
- A fragment-bearing invite can exchange the token for a short-lived `HttpOnly; Secure;
  SameSite=Strict` cookie without placing it in an HTTP URL or committed file.
- Browser writes require the configured HTTPS origin; the Buyer accepts only explicit hostnames.
- All created delegations, including cancelled and declined ones, mutation frequency, request length,
  TTS characters and Veo reservations are capped. The public task limit is 20 per rolling hour,
  reserved atomically before model use; Veo separately permits 20 generation reservations
  per rolling hour and a reference-guided task consumes two. Reservations survive restart and uncertain
  provider submissions are not blindly retried.
- Uploaded customer images require Buyer authentication to retrieve. Upload counts survive process
  restart, are serialized per Buyer process, and public uploads stop when the local image store
  reaches 10 GiB. Images older than seven days are removed on startup and then hourly, except
  those still referenced by an active delegation or pending review. Cleanup is local to this host;
  it does not remove campaign deliverables.
- Social reference-video fetches are limited to 1 GB per file while downloading. Their re-fetchable
  cache evicts older entries at 10 GB; per-order source files and delivered videos are separate.
  New downloads stop before local free space falls below the temporary-file and host reserve.
- A single brief can request no more than 10 paid interpretations in a rolling hour. Clarification
  answers have per-answer, per-request and cumulative text limits. Seller-side copy, voice, reference
  analysis and Veo work may retry once for the same operation at Seller cost. A Hypit Build with
  an unknown submission outcome and no Build ID stops for Seller-side reconciliation, without a
  second Buyer charge.
- There is no separate per-order ceiling. Every order remains bounded by its customer-authorized
  mandate, while Buyer daily and lifetime ceilings are both 60,000 sats. The startup guard still
  refuses public mode with real Bitcoin enabled.
- Reference URLs are constrained to supported providers, revalidated through redirects and fetched
  into order-private storage. Required reference processing fails closed.
- Direct campaign creation and mainnet payment are disabled in public mode.

These controls bound the demo; they do not turn a locally hosted single-user service into a
production multi-tenant application.

## Local configuration

Create an ignored `.env.public-demo` from `.env.public-demo.example` and fill in your own values:

```dotenv
PUBLIC_DEMO_ORIGIN=https://<your-pages-project>.pages.dev
PUBLIC_DEMO_ACCESS_TOKEN=<generate-a-random-demo-token>
BUYER_ALLOWED_HOSTS=127.0.0.1,localhost,::1,<your-tunnel>.trycloudflare.com
PUBLIC_DEMO_MAX_DELEGATIONS_PER_HOUR=20
PUBLIC_DEMO_MAX_REQUEST_CHARS=1000
PUBLIC_DEMO_MAX_MUTATIONS_PER_MINUTE=30
```

Do not commit this file or reuse the token for any other service.

For a short manual preview only, start Seller, Buyer and a temporary outbound tunnel in separate
terminals. For the week-long deployment, use the supervised named-tunnel procedure above instead:

```bash
npm run public-demo:seller
npm run public-demo:buyer
docker run --rm cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://host.docker.internal:8788
```

Configure the Pages Worker secret/variable `UPSTREAM_ORIGIN` to the exact HTTPS tunnel origin. The
Worker source contains no account token, application token or environment-specific hostname. When
the tunnel hostname changes, update `BUYER_ALLOWED_HOSTS` locally and `UPSTREAM_ORIGIN` in
Cloudflare, then restart only the Buyer and redeploy only the gateway.

Generate a local invite after configuration:

```bash
npm run public-demo:link
```

## Stop and revoke

Stop the tunnel first, then the Buyer and Seller. To revoke an invite, rotate
`PUBLIC_DEMO_ACCESS_TOKEN` and restart the Buyer. If a token was ever committed, rotate it even after
removing it from Git history.
