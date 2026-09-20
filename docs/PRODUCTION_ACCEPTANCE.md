# Production acceptance gate

Every catalog product is fail-closed. `config/hypit-workflows.json` must keep `readyForSale: false` until all checks below pass for that exact workflow on the deployment machine.

## Required evidence per product

1. The workflow reads `SELLER_COMMISSION_PATH` and visibly uses the approved subject, copy and optional localized reference image. A static example render does not pass.
2. `hypit check`, `hypit plan`, a fresh Build, Build reattachment by ID and every configured `hypit get` export succeed.
3. The exported videos pass the Buyer validator for duration, decodability, dimensions, hook index, language, aspect-ratio coverage, audio presence/audibility, black/frozen-frame ratios and duplicate content. Input Source Manifest orders also export the declared JSON source artifact.
4. The compiler and automated tests must prove exact Hook × language × aspect-ratio Cartesian materialization, enforce the 30-video ceiling and reject unsupported matrices. For this Hackathon Demo, a full render of every or maximum-size combination is not required; the delivered files for any real order are still validated one by one before completion.
5. Provider accounts, content rights and current terms have been reviewed. Record the real `providerTermsConfirmedAt` and a conservative `maxProviderCostSats`; do not use placeholder values.
6. The Hypit worker runs as a dedicated OS user or in a container with only the production project, job directory, isolated home and required provider egress mounted/allowed. Verify that it cannot read the payer key, merchant secrets, API tokens or Buyer policy and cannot write outside its project/job paths.
7. Set `HYPIT_WORKER_ISOLATION_VERIFIED=1` only on the machine where step 6 was actually tested. Then set this product's `readyForSale` to `true`.
8. Verify the package's declared visual modes and voice roles. A paid voice provider must return positive evidence that it applied every requested role/style/pace/accent setting; unsupported requests must fail before payment or fail closed before Build.

## Four product checks

- `creator_pitch`: fixed presenter layout, one narration voice, purchased hook count and supporting text.
- `proof_demo`: product or supplied reference image, one narration voice and claim captions.
- `ranking_listicle`: fixed presenter layout, ordered list points and one narration voice.
- `two_person_podcast`: fixed two-host visual and two distinct dialogue voices.

Only `proof_demo` accepts the explicit `product_only` visual mode. The other formats expose their fixed package layout as `package_default`. Single-voice formats accept the `narrator` role; the podcast accepts `host_a` and `host_b`. No package claims custom actors, avatars, presenter likenesses or generated characters.

Production availability is calculated from these gates. An unavailable product cannot be quoted or ordered, so configuration failure is discovered before Bitcoin payment.

## Current compiler status

`src/hypit-commission-compiler.mjs` now provides the order-bound mechanics required by items 1–4:

- it reads the immutable commission and verifies localized-asset digests;
- it emits an order-private Author and Run with the exact purchased Hook × language × aspect-ratio matrix;
- it enforces the same 30-video and 9:16/1:1/16:9 limits as the quote API;
- it creates commission-receipt and optional Input Source Manifest Logical Outputs in the same Build;
- it measures narration against the actual package timeline, safely applies no more than 1.25× tempo
  compression for mild overflow, and rejects scripts that would otherwise be truncated;
- the Seller decodes those Build outputs and verifies order ID, product ID and commission SHA-256;
- retry/reattachment reuses the durable commission and compiled manifest instead of recompiling from mutable order state.
- a separate production-input stage generates schema-validated DeepSeek copy and language-specific
  speaker audio once per Hook × language, then persists and verifies copy/audio hashes on every retry;
- the commission receipt binds the production-input manifest digest, copy/voice provider identities,
  requested creative/voice settings, provider application status, text/script digests, voice IDs,
  original/fitted timing, tempo and compiled-audio digests without
  exposing credentials or raw model prompts.

This is implementation capability, not full production acceptance. Google Cloud TTS is wired through
ADC, with locale/voice selection, rate/pitch/volume style presets, a per-order character ceiling and
durable billing metadata. The user accepted the current Google Cloud terms for advertising-video use
and a 20,000-character per-order ceiling on 2026-09-20T11:38:20Z. A conservative 500-sat aggregate
provider-cost ceiling is recorded for every package. A live 46-character en-US Neural2-A synthesis
passed on the same date: LINEAR16/PCM 16-bit, 48 kHz mono, 3.3065 seconds, mean volume -18.1 dB and
peak -1.5 dB; the receipt metadata reported the warm preset at 0.96 speaking rate and -1 semitone.
Low-cost production validation on 2026-09-20 completed the real Google TTS → production-input
manifest → commission compiler → Hypit check/plan/Build/export → receipt binding → media acceptance
path for all four packages:

- `creator_pitch`: en-US Neural2-A, 31 billable characters, Build
  `bld_20260920T114435139Z_D2F3AC378C`, accepted 16-second 540×960 MP4;
- `proof_demo`: zh-CN mapped to cmn-CN Wavenet-A, 15 billable characters, Build
  `bld_20260920T114500709Z_1703472281`, accepted 25-second 540×960 MP4;
- `ranking_listicle`: es-US Neural2-A, 40 billable characters, Build
  `bld_20260920T115337915Z_FF220B65DF`, accepted 20-second 540×960 MP4;
- `two_person_podcast`: distinct en-GB Neural2-A and Neural2-B voices, 57 billable characters, Build
  `bld_20260920T114700354Z_51EC7795E2`, accepted 25.5-second 540×960 MP4.

All four outputs had audible AAC audio, zero detected black/frozen intervals, and a receipt bound to
the exact commission and production-input manifest. The aggregate was 143 billable characters; at
the conservative $16/million-character rate its maximum estimated TTS cost is $0.002288. DeepSeek
was deliberately not called: fixed short acceptance copy kept cost and variability bounded.

An earlier `es-MX` Ranking/Listicle attempt did not synthesize because Google returned only `es-US`
voices. The selector rejected the regional fallback before billing. With user approval, the product
was changed to `es-US` and then passed the validation above. The sellable language allowlist is now
`en-US`, `en-GB`, `es-US`, and `zh-CN`; generic `en`, `es`, `zh`, and `cmn` aliases normalize to those
locales. Other languages and regional accents fail before quote/payment.

Dedicated worker isolation passed on this machine on 2026-09-20. The final attestation is bound to
image `sha256:f1c10b630a491dda53a5590867e9f3dd96bd09ae0032837e129547cdfb365e13`
and Docker Engine 29.7.2. All 11 checks passed: non-root UID, read-only root, no network, all
capabilities dropped, `no-new-privileges`, a single order-private Docker volume, secret paths and
secret environment absent, writes outside the job denied, job writes allowed, and a complete
offline Hypit build/export. Build `bld_20260920T124203831Z_17AD4843A5` produced a 16-second
540×960 MP4 with audio. The attestation is invalidated automatically if the image ID changes.

The four workflows are now marked `readyForSale: true`. The Hackathon Demo acceptance decision does
not require exhaustive or maximum-matrix rendering: representative end-to-end package renders,
Cartesian compiler tests, the 30-video ceiling and strict post-delivery validation are the agreed
evidence. Runtime availability remains fail-closed and also requires the image-bound worker proof,
DeepSeek credentials, approved Google TTS/ADC configuration and the GoBTC merchant configuration.

GoBTC merchant and Buyer wallet onboarding were still blocked by an nginx HTTP 503 on 2026-09-20.
The optional `PAYMENT_MODE=demo` rail is therefore Hackathon presentation scaffolding only. It is
explicitly non-mainnet, creates no PSBT or chain transaction, never satisfies GoBTC acceptance, and
must not be cited as payment integration evidence. It exists solely to exercise the already-real
authorization gates, Hypit production, validation and campaign packaging while the external service
is unavailable.

Credential/API validation completed on 2026-09-20 in the operator-selected Google Cloud project:
Billing and Cloud Text-to-Speech are enabled, ADC is authenticated, and
read-only voice discovery succeeded for en-US, en-GB, es-US and cmn-CN. The complete package
validations above prove each accepted locale and both podcast voice roles on this deployment machine.
