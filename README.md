# Hirebit

> Hackathon Demo — a working prototype of pay-per-job procurement for short-form video campaigns.

Small businesses already use AI for marketing and need short-form video, but an occasional campaign
job does not map neatly to another tool subscription, credit system and production workflow. Hirebit
lets a merchant specify the outcome, assets, deadline and budget. An AI Buyer decides what production
is worth purchasing, pays for that job and supervises delivery through Hypit.

Hirebit is built around a simple product thesis: **the demand is task-shaped, while most AI software
is sold tool-by-tool.** The customer buys a finished campaign rather than learning and managing every
tool behind it:

```text
goal + assets + deadline + budget → purchasable production plan → payment → finished campaign
```

Bitcoin is not the customer proposition. The customer proposition is pay-per-job procurement.
Bitcoin is the machine-native payment rail that lets an agent pay a capability provider for one job
without maintaining a subscription relationship with every provider. The agent may decide what is
worth buying, but it may not invent its own authority: budget, scope, payment and external side
effects remain bounded by explicit policy and durable evidence.

## What it does

The customer journey is intentionally short:

1. Choose **Autonomous** or **Confirm before purchase**.
2. Describe the campaign and add product media.
3. Answer only the questions needed to make the request executable.
4. Review the normalized mandate and the Agent's package × scope comparison.
5. Let the Buyer purchase the best eligible plan within budget, or approve it first.
6. Follow production progress and download the finished video.

Hirebit currently offers four Hypit-backed production packages:

| Package | Best for | Production shape |
| --- | --- | --- |
| Creator Pitch | Fast product storytelling | Presenter-led or presenter-free vertical pitch |
| Product Showcase | Product demonstration and reference-led adaptation | Product-first action, narration, captions, and structured pacing |
| Ranking / Listicle | Comparison and discovery content | Ranked hooks with repeatable visual beats |
| Two-person Podcast | Conversational explanation | Two distinct voices in a dialogue format |

Purchased variants are compiled as a bounded Hook × language × aspect-ratio matrix. Supported
ratios are 9:16, 1:1 and 16:9, with a hard ceiling of 30 output videos per order.

## Product thesis and evidence

Hirebit does not claim that small businesses have already adopted autonomous creative procurement.
It starts from evidence-backed behavior and uses this prototype to test the remaining assumptions.

| What is supported today | Evidence | What it means for Hirebit |
| --- | --- | --- |
| Small businesses already use AI for marketing | QuickBooks reports that 41% of AI-using small businesses use it for marketing | Hirebit does not need to teach the market that AI can help with marketing |
| Video marketing is an established need | Wyzowl reports that 91% of businesses use video marketing; cost and time remain leading barriers for non-users | Short-form video is a practical first procurement category |
| Tool fragmentation creates friction | inTandem reports that 43% of SMBs would pay more for a solution that reduced their total tool count | The value is reducing tool and workflow management, not adding another generator |
| Smaller businesses are cost-sensitive about AI | Bredin reports that 42% of AI-using U.S. SMBs use only free tools; cost-effectiveness is the top AI attribute for the smallest firms | A bounded, low-commitment job purchase is a reasonable model to test |

Sources: [QuickBooks Small Business Insights 2026](https://quickbooks.intuit.com/r/small-business-data/small-business-insights/),
[QuickBooks AI Impact Report 2026](https://quickbooks.intuit.com/r/small-business-data/ai-impact-report/),
[Wyzowl Video Marketing Statistics 2026](https://wyzowl.com/sovm-results-2015/),
[inTandem 2026 SMB Digital Adoption Report](https://intandem.vcita.com/content-hub/the-2026-small-business-digital-adoption-report),
[Bredin research on SMB AI purchasing](https://www.bredin.com/news-posts/press-release-new-bredin-research-reveals-why-smbs-arent-paying-for-ai-tools-and-what-would-prompt-a-change),
and [Bredin research on the AI attributes SMBs value](https://www.bredin.com/blog/what-smbs-want-in-an-ai-solution-2).

The prototype is intended to validate four open questions:

- Will small businesses delegate a marketing procurement decision to an agent?
- For occasional campaign work, will they prefer pay-per-job procurement to operating tools directly?
- Is Bitcoin the most useful payment rail for machine-to-machine settlement in this workflow?
- Does buying three hook variants create enough incremental campaign value to justify the added spend?

The six-month validation plan therefore starts with five design partners and measures repeat use,
decision acceptance, budget utilization, time-to-campaign and output quality. Later milestones test
10 paid jobs, mainnet settlement, contribution margin and a second capability Seller before making
broader market or ROI claims.

## GoBTC Demo Day payment status

Fresh requests on 2026-09-21 to `POST /instant/wallet/register` and
`POST /merchant/auth/register` returned an nginx HTTP 503 response instead of the documented JSON.
The organizers confirmed in the official Discord that this matches the outage on their side, that
recovery should not be assumed before Demo Day, and that clearly disclosed simulated responses are
acceptable for the presentation while the real integration remains in place.

Hirebit therefore changes only the external payment-provider boundary in Demo mode. The same Buyer
mandate, budget reservation, package selection, Seller order, idempotency, payment gate, production
and delivery workflow still runs. `PAYMENT_MODE=gobtcpay` selects the real merchant and instant-wallet
clients; `PAYMENT_MODE=demo` selects interface-compatible simulated clients with explicit
`simulated: true` and `mainnet: false` evidence, a non-payable recipient marker and no PSBT, private
key, GoBTC request, Bitcoin transfer or transaction ID.

This demonstrates the implemented Buyer–Seller purchasing and fulfillment workflow through the
payment boundary. It does **not** claim successful GoBTC wallet registration, merchant onboarding,
mainnet submission, settlement or on-chain proof.

## System design

```text
Browser console
    │ brief, assets, approval
    ▼
Buyer agent ── intent → clarification → mandate → package × scope plans → decision
    │ approved scope, budget and idempotency key
    ▼
Seller API ── catalog → quote → order → payment evidence → production job
    │ order-private manifest and media
    ▼
Hypit worker ── check → plan → durable build → validation → campaign package
```

DeepSeek performs schema-constrained intent extraction, copy generation and reference-frame
planning. Google Cloud Text-to-Speech supplies the supported production voices. Vertex AI Veo is an
image-to-video source for eligible packages. For a supported reference-video order, DeepSeek extracts
generic action choreography, framing, pacing and transition structure; Veo generates a new generic
performance around the supplied product in two consecutive eight-second generations, with the first
segment's final frame anchoring the continuation; and Hypit trims the result to the reference duration
within an 8-16 second window and assembles approved narration and captions. The source person's identity, likeness, audio, captions and claims are
not copied. Reference-video orders fail closed when generative motion is unavailable instead of being
silently replaced by product-photo zooms.

The Buyer and Seller are separate services. The Seller owns pricing and production capability; the
Buyer owns customer intent, mandate enforcement and purchase-plan selection. This keeps a model-generated
recommendation separate from the code that can authorize payment or start work.

## How delegated purchasing works

Hirebit deliberately separates **judgment** from **authority**. AI interprets what will create value
for the customer; deterministic code decides which actions are permitted. A model can recommend a
purchase, but it cannot change a price, expand a budget, grant itself authority or submit a payment.

### AI decides what is worth buying

The Buyer does not ask the model to choose one package from a marketing list. It constructs complete
purchase plans across package, hook count, language, aspect ratio, price and turnaround, then evaluates
the plans in stages:

| Stage | Deterministic code | AI judgment | Resulting evidence |
| --- | --- | --- | --- |
| Interpret | Validates the schema and preserves authoritative UI choices | Extracts objective, audience, creative requirements, budget, deadline and authority | Versioned mandate |
| Enumerate | Requests Seller catalog and quotes for every feasible package × scope combination | None—prices and capabilities come only from the Seller | Comparable plan matrix |
| Filter | Rejects capability, format, deadline and customer-budget violations | Cannot restore an ineligible plan | Eligible plan set with rejection reasons |
| Rank | Supplies only eligible plans and bounded decision factors | Assesses objective fit, creative fit, evidence quality and testing value | Ranked plans and concise rationale |
| Select | Verifies the returned plan ID and recomputes all monetary checks | Chooses the best-value plan that materially advances the objective | Selected plan plus cheaper/broader trade-offs |

This ordering is the key design choice: AI contributes semantic judgment where rules are brittle, but
never receives the ability to redefine the constraints it is judging inside.

### Code controls the money

The customer mandate is the first budget boundary. The Buyer then applies account-level limits and
creates a durable spend reservation before an order can be issued. There is no separate per-order
ceiling; an order is bounded by the customer's hard budget and by the remaining daily and lifetime
allowances, which both default to 60,000 sats.

| Control | Enforcement |
| --- | --- |
| Customer hard budget | The selected quote plus the maximum real-payment fee reserve must fit inside the confirmed mandate |
| Daily and lifetime ceilings | Authorized spend and active reservations are summed transactionally before new spend is reserved |
| Concurrent payments | Pending-payment limits prevent multiple workflows from racing for the same allocation |
| Seller integrity | Product, quote ID, amount, recipient and expiry must match the accepted plan exactly |
| Bitcoin transaction integrity | Recipient, change, inputs, outputs, fee and fee rate are checked before signing or submission |
| Retry safety | Stable idempotency keys prevent duplicate orders; uncertain submissions are reconciled instead of blindly retried |

Reservations are persisted before external execution and released on a definite pre-payment failure.
After an uncertain submission they remain reserved until reconciliation, so a timeout cannot silently
turn into a second spend.

### Code controls the authority

Authorization is explicit state, not model sentiment. Each confirmed mandate binds the approved scope,
budget and purchase mode to a version and `scopeHash`.

| Authorization mode or gate | What code permits |
| --- | --- |
| Autonomous | After the exact mandate is confirmed, the Buyer may purchase once within that scope and budget without asking again |
| Confirm before purchase | The Buyer may compare and recommend, but cannot execute until the customer confirms the selected purchase |
| Mandate revision | Any material clarification creates a new version; stale confirmations and hashes are rejected |
| Payment gate | Seller production remains locked until the corresponding order has authorized payment evidence |
| Public Demo | Startup fails unless payment mode is simulated; the public web path cannot submit real Bitcoin |

Model output is always treated as untrusted data. JSON-schema validation, policy checks and state-machine
guards sit between every AI recommendation and every side effect. The practical rule is simple:
**AI proposes; code authorizes; durable evidence proves what happened.**

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
  is a demo gate—not production authentication. The public profile permits 20 tasks per rolling hour.
  There is no separate per-order ceiling: each order is bounded by its customer-authorized mandate,
  while the default Buyer daily and lifetime ceilings are both 60,000 sats.
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
(cd vendor/hypit && corepack pnpm install --frozen-lockfile)
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
| Vertex AI Veo | Google ADC + explicit enablement | Two generations per reference order; 20 reservations per rolling hour |
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
- GoBTC wallet and merchant registration were blocked by the organizer-confirmed HTTP 503 outage on
  2026-09-21. Demo mode exercises the implemented payment boundary but is not mainnet evidence.
- A reference video guides generic action choreography and structure; Hirebit does not reproduce the
  source person's identity or promise pixel-identical cloning.
- Reference-guided output uses two continuous Veo segments and follows the source duration within an
  8-16 second window; a continuous static hold over two seconds is rejected.
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
