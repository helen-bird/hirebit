# Hirebit

Hirebit is a safety-bounded agentic marketplace for commissioning product-marketing videos. A
customer describes the outcome, supplies a product image and optionally a TikTok, Instagram or
YouTube reference, then delegates the job to a Buyer agent. The Buyer clarifies missing facts,
compares Seller packages, enforces a spending mandate and supervises production through Hypit.

The product is designed around a simple idea: an agent may make choices, but it must not invent its
own authority. Budget, scope, payment and external side effects remain bounded by explicit policy and
durable evidence.

## What it does

The customer journey is intentionally short:

1. Choose **Autonomous** or **Confirm before purchase**.
2. Describe the campaign and add product media.
3. Answer only the questions needed to make the request executable.
4. Review the normalized mandate and package comparison.
5. Let the Buyer purchase the best eligible offer, or approve it first.
6. Follow production progress and download the finished video.

Hirebit currently offers four Hypit-backed production packages:

| Package | Best for | Production shape |
| --- | --- | --- |
| Creator Pitch | Fast product storytelling | Presenter-led or presenter-free vertical pitch |
| Proof Demo | Product evidence and reference-led adaptation | Product-first demo with structured pacing |
| Ranking / Listicle | Comparison and discovery content | Ranked hooks with repeatable visual beats |
| Two-person Podcast | Conversational explanation | Two distinct voices in a dialogue format |

Purchased variants are compiled as a bounded Hook × language × aspect-ratio matrix. Supported
ratios are 9:16, 1:1 and 16:9, with a hard ceiling of 30 output videos per order.

## System design

```text
Browser console
    │ brief, assets, approval
    ▼
Buyer agent ── intent → clarification → mandate → quote comparison → decision
    │ approved scope, budget and idempotency key
    ▼
Seller API ── catalog → quote → order → payment evidence → production job
    │ order-private manifest and media
    ▼
Hypit worker ── check → plan → durable build → validation → campaign package
```

DeepSeek performs schema-constrained intent extraction, copy generation and reference-frame
planning. Google Cloud Text-to-Speech supplies the supported production voices. Vertex AI Veo is an
optional image-to-video source for eligible packages; reference-video orders instead use Hypit to
adapt pacing, framing, transition rhythm and reveal structure. The source person's likeness, audio,
captions and claims are not copied.

The Buyer and Seller are separate services. The Seller owns pricing and production capability; the
Buyer owns customer intent, mandate enforcement and package selection. This keeps a model-generated
recommendation separate from the code that can authorize payment or start work.

## Security by design

Security controls are part of the transaction model, not a UI convention:

- **No secrets in source control.** `.env*`, wallet keys, local API tokens, provider state, Google
  credentials, machine-specific Hypit profiles and runtime databases are ignored. Only placeholder
  examples are committed. Google access uses Application Default Credentials rather than a JSON key.
- **Least authority.** Models return data that must pass JSON-schema and policy validation. A model
  cannot directly call payment or production tools, expand the budget, change purchase mode or add
  an unapproved asset.
- **Versioned mandates.** Every decision is tied to an immutable mandate version, exact scope and
  budget ceiling. A material clarification creates a new version and invalidates stale approval.
- **Fail-closed payments.** Quote totals, product IDs, destinations and PSBT outputs are independently
  checked before signing. Idempotency keys and durable reservations prevent duplicate orders and
  blind retries after uncertain results.
- **Private-key isolation.** Payer keys remain in an owner-only local directory and never enter the
  browser, model prompt, campaign package or Hypit worker. Mainnet is disabled in the public profile.
- **Network input controls.** URL parsing, DNS/IP checks, redirect revalidation, hostname allowlists,
  media probes, byte limits and timeouts reduce SSRF and downloader abuse. Production fails closed if
  a required reference cannot be safely fetched and validated.
- **Worker isolation.** Hypit builds run in a constrained Docker worker with only an order-private job
  mounted. The host repository, wallet, Buyer state, Seller state and cloud credentials are absent.
- **Bounded public demo.** The public profile permits simulated payment only, caps requests, input
  length, TTS characters and Veo reservations, and uses a rolling hourly task limit. Its access token
  is a demo gate—not production authentication.
- **Durable audit evidence.** Decisions, payment state and production manifests are persisted for
  recovery and verification, while low-level evidence files are intentionally hidden from the normal
  customer journey.

More detail is in [docs/SECURITY.md](docs/SECURITY.md) and the root
[security policy](SECURITY.md).

## Quick start

Requirements: Node.js 22.15 or newer, Docker, Git and Corepack/pnpm for the pinned Hypit checkout.

```bash
git clone --recurse-submodules https://github.com/helen-bird/hirebit.git
cd hirebit
npm ci
npm run hypit:setup
corepack pnpm --dir vendor/hypit install --frozen-lockfile
cp .env.example .env
```

`npm run hypit:setup` pins Hypit to the tested commit and applies the committed downloader patch used
for supported TikTok pages. Review Hypit's own license before redistributing or operating it.

These commands start the local services using simulated payments. Intent interpretation and actual
video production still need provider configuration; a fresh checkout has no usable provider
credentials or worker attestation. Configure `.env` using the provider section below, then start the
two services in separate terminals:

```bash
npm run demo:seller
npm run demo:buyer
```

Open `http://127.0.0.1:8788/console/`. Runtime tokens are created under ignored local state; never
copy them into documentation, screenshots or commits.

## Production providers

Provider configuration is opt-in. Copy the examples and keep real values only in ignored local files
or a deployment secret manager.

| Capability | Configuration | Important boundary |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | Only sanitized task fields and required media are sent |
| Google TTS | Google ADC + `GOOGLE_CLOUD_PROJECT` | Sold language/voice set and per-order character cap |
| Vertex AI Veo | Google ADC + explicit enablement | Eligible package, duration and reservation limits |
| GoBTC Pay | merchant/payer config under ignored local state | Never expose keys to the web or worker |
| Cloudflare gateway | `UPSTREAM_ORIGIN` deployment variable | Tunnel only the Buyer; never the Seller port |

See [docs/PRODUCTION_ACCEPTANCE.md](docs/PRODUCTION_ACCEPTANCE.md) and
[docs/PUBLIC_DEMO_DEPLOYMENT.md](docs/PUBLIC_DEMO_DEPLOYMENT.md) before enabling paid providers or a
public endpoint.

Before rendering, copy `productions/hypit.runtime.example.json` to the ignored
`productions/hypit.runtime.json` and replace its FFmpeg, FFprobe and Chrome paths for your machine.
Complete production acceptance and worker verification before enabling the worker flag. Existing
acceptance records describe the original operator's deployment, not a fresh installation.

The supported voice locales are `en-US`, `en-GB`, `es-US` and `zh-CN` (Mandarin). Other languages or
regional accents are rejected before payment. For real GoBTC payments, explicitly configure
`GOBTCPAY_PAYER_PUBLIC_KEY` to the registered public key as well as the multisig address and private
key file; no operator wallet identity is embedded in the source.

## Verification

```bash
npm run check
npm run repo:check
npm test
```

The test suite covers mandate extraction and revisions, quote selection, budget enforcement,
idempotency, payment validation, recovery, media validation, reference planning, campaign packaging,
public-demo quotas and API security. Docker isolation has a separate host-level check:

```bash
npm run worker:image
npm run worker:verify
```

## Repository map

```text
src/buyer/       intent, clarification, policy, comparison and purchase orchestration
src/             Seller, payment adapters, production compiler and security utilities
web/             focused customer console
config/          public policy, catalog and workflow definitions
productions/     authored Hypit fixtures and curated preview evidence
docker/          isolated production worker
cloudflare/      optional public gateway
scripts/         onboarding, validation and reproducible setup tools
test/            unit and integration tests
docs/            operations, acceptance and threat-model documentation
```

## Known limits

- This is a single-operator reference implementation, not a hardened multi-tenant SaaS deployment.
- GoBTC availability and funding are external operational dependencies.
- A reference video guides structure; Hirebit does not promise pixel-identical cloning.
- Provider calls may incur charges. Keep quotas and billing alerts enabled before exposing a URL.
- Hypit's license restricts hosted, multi-tenant and third-party service use. Obtain Hypit.AI's written
  authorization or a commercial license before opening the production capability beyond an approved
  single-operator evaluation.
- Operators must have rights to every uploaded product image, reference and generated campaign asset.
- The public access token is intentionally a lightweight demo gate. Use real identity, authorization,
  abuse prevention and managed secrets before any production deployment.

## License and third-party code

Hirebit's original work is **All Rights Reserved** under [LICENSE](LICENSE): no additional permission
to copy, modify or redistribute is granted without written authorization. GitHub's platform rights
for viewing and forking public repositories still apply. Hypit, its patch and third-party media
retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
