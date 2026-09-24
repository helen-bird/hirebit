# Four package validation fixtures

This directory contains one complete, locally rendered Hypit fixture for each of the four formal
catalog packages. The fixtures use Arduino UNO R4 WiFi as a real-product case study and exercise
different language, voice, presenter, pacing, and layout requirements. They are an unofficial
hackathon demonstration and do not imply Arduino endorsement.

These are **historical validation fixtures**, not the customer product currently shown on the Hirebit
website. Current commissions compile an order-private Hypit project from the customer's assets;
they do not deliver these Arduino previews. The internal ID and directory `proof_demo` correspond
to the customer-facing **Product Showcase** package and are retained for compatibility.

## Acceptance briefs

| Package | Target language | Voice and person | Duration | Final preview |
| --- | --- | --- | ---: | --- |
| Creator Pitch | en-US | Warm American-English female maker; fictional East Asian woman presenter | 16 s | `previews/final/creator-pitch.mp4` |
| Product Showcase | zh-CN | Calm Mandarin female technical narrator; product-only, no presenter | 25 s | `previews/final/proof-demo.mp4` |
| Ranking / Listicle | es-US | Energetic US-Spanish reviewer; fictional Latino maker | 20 s | `previews/final/ranking-listicle.mp4` |
| Two-person Podcast | en-GB | Two distinct British voices; fictional woman engineer and man host | 25.5 s | `previews/final/two-person-podcast.mp4` |

The machine-readable briefs and image-generation prompts are in
`shared-assets/arduino-uno-r4-wifi/production-briefs.json`. Asset sources, license obligations,
reference-video policy, and the brand disclaimer are in
`shared-assets/arduino-uno-r4-wifi/SOURCES.md`.

## Hypit structure

Each package has:

- `authors/main.svml`: the authored vertical-video timeline;
- `runs/build.svrun`: the durable Run that targets `final.video`;
- `assets/*.txt`: the spoken script;
- `assets/*.wav`: a local acceptance voice fixture.

All four Runs share `look.svs` and `hypit.runtime.json`. The runtime resolves every request to the
local media and HyperFrames providers; the last plan check reported zero provider, unresolved, and
unsupported requests.

Paid commissions now use `src/hypit-commission-compiler.mjs` instead of invoking these fixed Runs
directly. It reads the immutable order commission, builds the purchased Hook × language × aspect
ratio Cartesian matrix in an order-private Hypit project, and targets every video plus a receipt in
one durable Build. Supported aspect ratios are 9:16, 1:1, and 16:9, with a fail-closed maximum of 30
videos per order. The quote API enforces the same limits before payment.

Before compilation, `src/production-input-preparer.mjs` asks DeepSeek for schema-constrained copy
once per Hook × language and synthesizes the corresponding speaker turns. The resulting copy, WAV
files, provider metadata, and SHA-256 hashes are stored under the private order job. Aspect-ratio
variants reuse the same language/Hook production input. Retries verify and reuse a completed
manifest. If a supplier call failed before completion, Seller may retry that exact operation once
at its own cost; no new Buyer payment is created. Only sanitized brief fields and asset metadata
are sent to DeepSeek; order, payment, secret, URL, and local-path fields are excluded.

The machine-local runtime profile is ignored by Git. A fresh checkout does **not** contain
`productions/hypit.runtime.json`; copy the example and replace its FFmpeg, FFprobe and Chrome paths
for the current machine before attempting the commands below. Historical build IDs are evidence
from the original operator's environment, not reusable job IDs.

## Reproduce a build

Run the following from the repository root, replacing `<package>` with `creator-pitch`,
`proof-demo`, `ranking-listicle`, or `two-person-podcast`:

```sh
npm ci
npm run hypit:setup
(cd vendor/hypit && corepack pnpm install --frozen-lockfile)
cp productions/hypit.runtime.example.json productions/hypit.runtime.json
```

Edit the copied runtime's `<absolute-...>` placeholders before continuing. Starting Hypit providers
and building a video may consume local resources or paid provider services; do not treat this as a
credential-free setup check.

```sh
vendor/hypit/hypit runtime up \
  --workspace productions \
  --runtime productions/hypit.runtime.json

vendor/hypit/hypit check productions/<package>/authors/main.svml \
  --workspace productions --json

vendor/hypit/hypit plan productions/<package>/runs/build.svrun \
  --workspace productions \
  --runtime productions/hypit.runtime.json \
  --json

vendor/hypit/hypit build productions/<package>/runs/build.svrun \
  --workspace productions \
  --runtime productions/hypit.runtime.json \
  --follow --max-wait-ms 120000 --json
```

Export a completed output with:

```sh
mkdir -p .validation
vendor/hypit/hypit get <build-id> \
  --output final.video \
  --to .validation/<package>.mp4 \
  --workspace productions --json
```

This writes to an ignored local directory; it does not overwrite the committed preview evidence.

Validated build IDs on 2026-09-18:

| Package | Build ID | Outcome |
| --- | --- | --- |
| Creator Pitch | `bld_20260918T142107014Z_791555C34B` | complete |
| Product Showcase | `bld_20260918T142143455Z_7DC3CB9BC5` | complete |
| Ranking / Listicle | `bld_20260920T115707801Z_A12ADE4674` | complete (`es-US` source update) |
| Two-person Podcast | `bld_20260918T142607022Z_9256400EAB` | complete |

## Historical validation performed (2026-09-18–20)

- `hypit check` passed for all four Authors.
- `hypit plan` passed for all four Runs with zero request issues.
- Every final MP4 contains H.264 video and AAC audio at 540x960 and 30 fps.
- `validateCampaignDeliverables` accepted the exact language, hook, aspect ratio, duration, and file
  count for all four package fixtures. The validator used in that run confirmed usable audio and zero
  detected black/frozen intervals for all four final previews.
- A compiled 3 Hook × 2 language × 2 aspect-ratio commission passed `hypit check` and `hypit plan`
  with 12 video targets, one receipt target, one Input Source Manifest target, and zero request issues.
- Dynamic smoke Build `bld_20260918T150419661Z_D6F9D615E7` completed a 20-second video and its
  commission receipt in the same Build. The exported receipt SHA-256 matched the durable commission.
- The repository syntax check and automated tests passed for the revision used in that acceptance run;
  the current working tree requires a separate validation before release.

## Sale readiness

Google Cloud TTS passed production validation for en-US, zh-CN/cmn-CN, es-US, and two distinct
en-GB voices; other languages and regional accents are deliberately not sold. The image-bound
Docker worker isolation test also passed on the original machine, and the four workflow definitions
were marked `readyForSale: true` for the Demo Day evaluation. The newer two-segment reference-guided
path still needs a complete current-order production check before its live fulfillment can be claimed
as end-to-end validated. Exhaustive rendering of every add-on combination was outside the agreed Demo
acceptance scope; compiler matrix tests, the 30-video ceiling and per-file completion validation
remain defined as delivery gates.

Operational availability is separate from workflow acceptance. The Seller removes these products
from the live catalog before payment whenever DeepSeek credentials, Google TTS/ADC, the verified
worker image or GoBTC merchant configuration is unavailable.
