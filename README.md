# Hirebit

## 60 second summary

**Problem.** Small businesses need occasional product-video campaigns without managing separate AI
tools. Hirebit's AI Buyer clarifies a brief, compares four Seller packages, buys the best eligible
scope within budget, and validates delivery.

**Why Bitcoin.** The Buyer agent can pay another service agent in BTC from its own 2-of-3 wallet,
without a Seller-specific subscription or credits. It checks the recipient, amount and miner fee
in the PSBT before signing locally. GoBTC's `paid` acceptance gives the Seller a seconds-scale
signal to start a bounded job; BTC settles on-chain later. Code enforces the mandate and spending
authority while AI chooses which service is worth buying.

**Transaction.** Brief + assets → clarified mandate and quotes → budget reservation → Seller
invoice → Buyer validates and signs the PSBT → GoBTC `paid` → production and delivery → later
on-chain settlement.

**Where is the BTC after paid?** The funding UTXO is still in the Buyer's GoBTC-registered 2-of-3
multisig wallet; the Buyer key alone cannot spend it. GoBTC has accepted the signature and committed
to the payment, so the Seller starts this bounded job, although `paidAt` can still be `null` and
`transactions[]` empty. BTC reaches the Seller only after later batched on-chain settlement. See the
[official guide](https://pioneers.agnic.ai/build/bitcoin-pay) and [payment lifecycle](docs/PAYMENT_LIFECYCLE.md).

**Built and verified.** The [live demo](https://sats-story-hirebit.pages.dev/console/) exercises
the Buyer decision, budget controls and real video-production path; successful jobs are delivered.
GoBTC responses are simulated there: **no BTC moves**. Real GoBTC clients and local PSBT signing
exist, but wallet onboarding, mainnet payment and settlement remain unverified live.

## Contents

- [Bitcoin's role in Hirebit](#bitcoins-role-in-hirebit)
- [Find the payment code](#find-the-payment-code)
- [What it does](#what-it-does)
- [Product thesis and evidence](#product-thesis-and-evidence)
- [Payment modes and validation](#payment-modes-and-validation)
  - [Authorization and settlement](#payment-authorization-is-separate-from-settlement)
- [System design](#system-design)
- [How delegated purchasing works](#how-delegated-purchasing-works)
- [Security by design](#security-by-design)
- [Quick start: local UI](#quick-start-local-ui)
- [Production providers](#production-providers)
- [Verification](#verification)
- [Repository map](#repository-map)
- [Known limits](#known-limits)
- [License and third-party code](#license-and-third-party-code)

## Bitcoin's role in Hirebit

The video service is the first purchase category; the Bitcoin-specific mechanism is the payment
between autonomous Buyer and Seller agents. Both use the same BTC rail rather than a separate
Seller credit balance or card checkout. Native BTC can cross borders where the service is available,
although Hirebit has not verified a live cross-border or mainnet payment.

| What Bitcoin enables here | What the code actually does |
| --- | --- |
| Buyer-authorized, programmatic spending | The agent holds a local signing key for its GoBTC 2-of-3 wallet. It validates every PSBT input, the Seller output, change and network fee before signing; mandate and account budgets bound when it may submit. |
| A small payment for a specific job | Seller creates a satoshi-denominated invoice with a stable order ID. The all-in customer price includes a Seller-funded miner-fee allowance; the Buyer will not sign if invoice plus actual fee exceeds its authorization. Network fees and dust still impose a practical minimum. |
| Seller can act before chain settlement | GoBTC's `paid` status records its acceptance of the Buyer's signature. Hirebit unlocks production once for that exact order, then records `paidAt` and transaction IDs separately when GoBTC reports later settlement. `paid` is a seconds-scale authorization signal, not an on-chain confirmation. |

The fulfillment gate is GoBTC's accepted `paid` commitment. The Seller starts production at that
point; delivery disputes and any refunds follow a separate review process.
The [payment lifecycle](docs/PAYMENT_LIFECYCLE.md) describes the money and work at each stage.

## Find the payment code

| Question | Start here |
| --- | --- |
| How does the Buyer sign a Bitcoin payment? | [`src/buyer/instant-wallet.mjs`](src/buyer/instant-wallet.mjs) validates the GoBTC PSBT and signs locally; [`src/gobtcpay.mjs`](src/gobtcpay.mjs) is the Seller's GoBTC client. |
| Who decides whether money may be spent? | [`src/buyer/buyer-service.mjs`](src/buyer/buyer-service.mjs) owns authorization and the spend reservation; [`src/seller-service.mjs`](src/seller-service.mjs) gates production on accepted payment. |
| What happens if payment, cancellation or delivery is disputed? | [`docs/PAYMENT_LIFECYCLE.md`](docs/PAYMENT_LIFECYCLE.md) maps the states; [`src/transaction-review.mjs`](src/transaction-review.mjs) lists unresolved obligations. |
| How does the public payment preview work? | [`src/demo-payment.mjs`](src/demo-payment.mjs) provides interface-compatible simulated GoBTC responses for the preview. |

## What it does

The customer journey is intentionally short:

1. Choose **Autonomous** or **Confirm purchase**.
2. Describe the campaign and add product media.
3. Answer only the questions needed to make the request executable.
4. Review the normalized mandate and the Agent's package × scope comparison.
5. Let the Buyer purchase the best eligible plan within budget, or approve it first.
6. Follow production progress and download the finished video.

The current campaign flow accepts a product image and a public TikTok video page as its visual references.

Hirebit currently offers four Hypit-backed production packages:

| Package | Best for | Production shape |
| --- | --- | --- |
| Creator Pitch | Launches and direct-response ads | One creator delivers a direct pitch to camera |
| Product Showcase | Product demonstrations and conversion | The product performs reference-guided actions with narration and captions |
| Ranking / Listicle | Comparisons and consideration | One presenter ranks and explains three reasons |
| Two-person Podcast | Objections, trust and social proof | Two hosts answer objections in conversation |

Purchased variants are compiled as a bounded Hook × language × aspect-ratio matrix. Supported
ratios are 9:16, 1:1 and 16:9, with a hard ceiling of 30 output videos per order.

## Product thesis and evidence

Small-business AI marketing use and demand for video are established. Hirebit uses this prototype
to test whether customers will delegate a bounded creative purchase to an agent.

| What is supported today | Evidence | What it means for Hirebit |
| --- | --- | --- |
| Small businesses already use AI for marketing | QuickBooks reports that 41% of AI-using small businesses use it for marketing | Marketing is a familiar entry point for an AI-assisted purchase |
| Video marketing is an established need | Wyzowl reports that 91% of businesses use video marketing; cost and time remain leading barriers for non-users | Short-form video is a practical first procurement category |
| Tool fragmentation creates friction | inTandem reports that 43% of SMBs would pay more for a solution that reduced their total tool count | Hirebit combines service selection, purchase and delivery in one workflow |
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

## Payment modes and validation

The public preview uses simulated GoBTC responses at the provider boundary. The same Buyer
mandate, budget reservation, package selection, Seller order, idempotency, payment gate, production
and delivery workflow still runs. `PAYMENT_MODE=gobtcpay` selects the real merchant and instant-wallet
clients; `PAYMENT_MODE=demo` selects interface-compatible simulated clients with explicit
`simulated: true` and `mainnet: false` evidence, a non-payable recipient marker and no PSBT, private
key, GoBTC request, Bitcoin transfer or transaction ID.

On 2026-09-21, fresh wallet and merchant registration requests returned nginx HTTP 503, and the
organizers confirmed the outage in their official Discord. They approved a clearly labeled
simulated-payment Demo Day presentation. This is dated historical evidence, not a current GoBTC
availability check. Real wallet registration, merchant onboarding, mainnet submission and settlement
remain pending live validation.

### Payment authorization is separate from settlement

The real instant-payment path uses the Buyer's GoBTC 2-of-3 multisig wallet and the Seller's
payment address. The Buyer first checks the selected order, recipient, amount, fee and policy
limits against the PSBT, then signs locally. GoBTC accepts the submitted signature; broadcasting
and on-chain settlement follow later.

| Signal | Hirebit action | Payment state |
| --- | --- | --- |
| Payment `initiated` | Reserve the all-in customer price, including Seller-funded network-fee allowance; keep production locked | Awaiting provider acceptance |
| Payment `paid` | Commit the spend once and unlock this low-value production job | Instant authorization accepted; chain settlement pending |
| `paidAt` plus transaction IDs | Record GoBTC-reported settlement evidence; do not run production again | Provider-reported chain settlement; disputes remain separately reviewable |

If a submission times out, Hirebit reconciles the existing payment instead of blindly signing
or submitting another one. The order's stable `externalId` and local reservation protect retries;
an expired or rejected unpaid payment releases the reservation only when GoBTC reports that
terminal status. A local invoice deadline alone cannot prove that money was not submitted.
A paid order whose production fails receives a bounded Seller-side retry where the provider
operation is safe to repeat; a terminal Veo rejection instead pauses for review. An ambiguous
Hypit Build without an ID or exhausted retries remains a Seller-side obligation, never a second
Buyer charge or an automatic Bitcoin reversal. Buyer
cancellation now blocks later submission when it wins the final submit gate, and a Seller stop
request blocks production when it wins the production-start race. An unpaid invoice remains under
reconciliation until GoBTC confirms a terminal status. If `paid` arrives after the stop, Hirebit
records the service price as **refund review required**, not as BTC already returned. A request
after production starts enters itemized-cost review. Delivered work can be disputed within 72
hours with file-specific evidence. Quality disputes do not include a free rework; an approved
quality refund is capped at 20% of the service price. Adjudication and a separate outgoing BTC
refund are not automated. A read-only local review command lists unresolved obligations without
printing payment IDs, wallet addresses or customer briefs. Use
`npm run transaction:review -- demo` for local preview state,
`npm run transaction:review -- public-demo` for public preview state, or
`npm run transaction:review -- mainnet` for separately configured real-payment state. See
[payment lifecycle and edge cases](docs/PAYMENT_LIFECYCLE.md).
Seller reconciliation checks the returned payment ID, amount, recipient address and rail before accepting `paid`;
the Buyer also checks that the Seller order still matches the quote and invoice it accepted.
If an invoice is `paid` without a matching Buyer submission receipt, Hirebit pauses for payer-source
review rather than charging the Buyer's budget or retrying payment. A timed-out submission may
therefore require manual reconciliation even if the invoice later shows `paid`.
Concurrent slower provider responses cannot overwrite a newer paid or settled state. Other
conflicting or regressed provider responses stop for investigation instead of unlocking a new job
or erasing a previously accepted authorization. Changed package, scope, service price or maximum
authorized spend invalidates a purchase confirmation;
the customer must approve the new offer. A cancelled order stops later paid production steps
where possible, while already-submitted provider work remains subject to documented cost review.
Completed campaigns respect the Seller's bounded next-check time while waiting for slow chain
settlement, rather than hammering GoBTC every UI tick. Package downloads verify each file's
recorded size and SHA-256 before serving it; a partially refreshed settlement report is withheld
until its on-disk contents and the durable package record agree.
New Seller exports record their own size and SHA-256, which the Seller and Buyer check before
delivery. Shareable campaign reports omit the GoBTC payment ID because it is a read token for
GoBTC's unauthenticated payment lookup; the protected transaction state retains it for reconciliation.
The Buyer's multisig is not a guarantee of absolute irreversibility by key structure alone: GoBTC
documents a separate Buyer-plus-recovery-custodian path. Hirebit relies on the provider's `paid`
commitment for its small-job fulfillment gate, and reports chain settlement separately.

Demo mode follows the same *state boundary*: a synthetic `paid` has `paidAt: null` and no chain
transactions. Its `simulatedAuthorizedAt` and `demo_receipt_` are simulation evidence only. Neither
the demo nor local tests establish that a real GoBTC payment will settle successfully.

This prototype assumes one instant-payment rail per invoice. An unexpected outside-wallet payment
to the same address, a disputed provider commitment, key compromise, or a requested refund enters
manual investigation. Hirebit gates low-value production on GoBTC's accepted `paid` status and
tracks later settlement separately.

Protocol references: [official build guide](https://pioneers.agnic.ai/build/bitcoin-pay) and
[GoBTC Pay's website](https://gobtcpay.com/).

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
segment's final frame anchoring the continuation. The two segments are paced to the reference duration
within an 8-16 second window so the closing action is retained; Hypit then assembles narration and captions. The source person's identity, likeness, audio, captions and claims are
not copied. Reference-video orders fail closed when generative motion is unavailable instead of being
silently replaced by product-photo zooms.

The current automated media checks verify technical delivery (duration, format, audio and frame integrity),
not creative or typographic quality. The first 2026-09-24 local simulated-payment run exposed invented
lettering in raw Veo footage. A later isolated run exercised the updated two-segment prompt and
source-length pacing, then caught two caption defects in the completed Buyer package. The same
generated motion and voice were rebuilt offline into three corrected 12.6-second QA videos; sampled
frames no longer show the lettering or caption defects. The corrected files were validated and attached
as revision `r2` of the same isolated Buyer order. The first delivery and its hashes remain available;
all six original/revised video downloads passed SHA-256 checks through the authenticated Buyer endpoint.
The Buyer page plays and offers all three corrected hooks. This local revision has not been deployed online. See
[the dated reference-guided validation record](docs/REFERENCE_CLONE_ACCEPTANCE.md) for the exact evidence boundary.

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
| Understand (`Interpret`) | Validates the schema and preserves authoritative UI choices | Extracts objective, audience, creative requirements, budget, deadline and authority | Versioned mandate |
| Compare (`Enumerate`) | Requests Seller catalog and quotes for every feasible package × scope combination | None; prices and capabilities come only from the Seller | Comparable plan matrix |
| Protect (`Filter`) | Rejects capability, format, deadline and customer-budget violations | Cannot restore an ineligible plan | Eligible plan set with rejection reasons |
| Recommend (`Rank`) | Supplies only eligible plans and bounded decision factors | Assesses objective fit, creative fit, evidence quality and testing value | Ranked plans and concise rationale |
| Purchase (`Select`) | Verifies the returned plan ID and recomputes all monetary checks | Chooses the best-value plan that materially advances the objective | Selected plan plus cheaper and broader trade-offs |

This ordering is the key design choice: AI contributes semantic judgment where rules are brittle, but
never receives the ability to redefine the constraints it is judging inside.

### Code controls the money

The customer mandate is the first budget boundary. The Buyer then applies account-level limits and
creates a durable spend reservation before an order can be issued. There is no separate per-order
ceiling; an order is bounded by the customer's hard budget and by the remaining daily and lifetime
allowances, which both default to 60,000 sats.

| Control | Enforcement |
| --- | --- |
| Customer hard budget | The displayed all-in price includes a Seller-funded network-fee allowance; invoice plus actual fee must not exceed that price or the confirmed mandate in either payment mode |
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

## Quick start: local UI

Requirements for the local console: Node.js 22.15 or newer and Git. Full video production
additionally requires Docker and Corepack/pnpm for the pinned Hypit checkout.

```bash
git clone --recurse-submodules https://github.com/helen-bird/hirebit.git
cd hirebit
npm ci
cp .env.example .env
```

The commands below start the **local UI and simulated-payment services**. A fresh checkout can open
the console; completing an order also requires the provider setup in the next section. Start the two
services in separate terminals:

```bash
npm run demo:seller
npm run demo:buyer
```

Open `http://127.0.0.1:8788/console/`. Runtime tokens are created under ignored local state; never
copy them into documentation, screenshots or commits. The local Buyer token used by the sign-in form
is stored in `.buyer/api-token` on that machine; do not put it in a URL.

### Complete a local order

Configure the following **before** submitting a brief. These are
opt-in paid services, even though `PAYMENT_MODE=demo` never transfers Bitcoin:

1. Prepare the pinned Hypit checkout and its downloader patches:

   ```bash
   npm run hypit:setup
   (cd vendor/hypit && corepack pnpm install --frozen-lockfile)
   ```

   Review [Hypit's license](vendor/hypit/LICENSE) before redistributing or operating it.
2. Put `DEEPSEEK_API_KEY` in the ignored `.env`, or store it under macOS Keychain service
   `shared-model-gateway`, account `deepseek-api`. Do not commit or paste the value into an issue.
3. Set `GOOGLE_CLOUD_PROJECT`, configure Google Application Default Credentials, enable billing and
   the required TTS/Vertex APIs in your own project, and review the current commercial-use terms.
   Only after approval, set `GOOGLE_TTS_COMMERCIAL_USE_APPROVED=1`, `GOOGLE_VEO_ENABLED=1`, and
   `GOOGLE_VEO_COMMERCIAL_USE_APPROVED=1` in the ignored `.env`.
4. Start Docker, copy `productions/hypit.runtime.example.json` to the ignored
   `productions/hypit.runtime.json`, and replace its machine-specific executable paths. Complete
   [production acceptance](docs/PRODUCTION_ACCEPTANCE.md), build the worker with
   `npm run worker:image`, and run `npm run worker:verify`. Set
   `HYPIT_WORKER_ISOLATION_VERIFIED=1` only after that check passes on this machine.

Restart both local services after changing `.env` so they load the approved provider configuration.

Do not run production acceptance or submit a campaign merely to check installation: those actions
can call paid providers. The public demo has additional restrictions in
[deployment instructions](docs/PUBLIC_DEMO_DEPLOYMENT.md).

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

`repo:check` examines staged Git objects and current committable working-tree files. Ignored
runtime credentials remain outside its scan; stage the intended release files and run it again
before committing. A local green result is separate from the full browser workflow and paid-provider
acceptance checks.

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
src/buyer/instant-wallet.mjs   Buyer PSBT checks and local signing
src/buyer/buyer-service.mjs    spend authorization, reservation and recovery
src/gobtcpay.mjs               real GoBTC merchant client
src/demo-payment.mjs           simulated provider boundary for preview
src/seller-service.mjs         order, payment gate and fulfillment state
src/transaction-review.mjs    unresolved payment and refund obligations
src/hypit-commission-compiler.mjs   order-bound Hypit production
web/             focused customer console
config/          public policy, catalog and workflow definitions
productions/     historical Arduino validation fixtures and curated preview evidence, not customer orders
docker/          isolated production worker
cloudflare/      optional public gateway
scripts/         onboarding, validation and reproducible setup tools
test/            unit and integration tests
docs/            operations, acceptance and threat-model documentation
docs/archive/    original planning notes; current behavior is documented above
```

The repository includes historical Arduino acceptance fixtures for all four packages. The current
customer example uses [the cotton-swab product photo](product_pic.jpeg) and a reference-led brief;
its campaign videos are delivered through the authenticated demo workflow. The dated
[reference validation record](docs/REFERENCE_CLONE_ACCEPTANCE.md) distinguishes tested example
outputs from the current production path.

## Known limits

- The current deployment serves one operator; independent customer accounts and tenancy require additional work.
- The public preview runs simulated GoBTC responses. Mainnet registration, payment and settlement
  await live validation; the 2026-09-21 outage is recorded above.
- Reference-guided production adapts the source action and structure with a generic generated presenter.
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
