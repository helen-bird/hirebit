# Reference-guided video: dated validation and current path

This document records the historical product-photo baseline and subsequent reference-guided validation. The vision stage analyzes one resized product image and eight sampled reference frames into a schema-validated six-shot plan; Hypit compiles the approved plan into video assembly primitives. The dated outputs below are evidence for the exact configurations tested, while the current two-eight-second production path is described separately.

Validated on 2026-09-20 using only:

- product image: operator-supplied `product_pic.jpeg` (3024×4032 JPEG)
- TikTok reference: `https://www.tiktok.com/@bilintinamakeup/video/6798977602963918085`

No product brief, source copy, presenter asset, payment or original reference audio was supplied to the production.

## Reference understanding

Hypit's pinned `media fetch` localized the TikTok page after the project-private downloader was prepared with `curl-cffi` impersonation support. `media probe`, `media boundaries` and time-sampled review found:

- 12.606 seconds, 720×1280, 60 fps, with audio
- a continuous detail/application phase through roughly 6.9 seconds
- the strongest transition cluster from 7.25–8.17 seconds
- a reveal/result phase through the close

The adaptation retained the vertical format, duration, frame rate, close-detail opening, 6.9-second structural turn and result/CTA close. It did not reuse the reference person or audio.

## Production result

- Hypit Build: `bld_20260920T152238079Z_84CD4F4F7B`
- output: `.validation/reference-clone/output/cotton-swabs-reference-clone.mp4`
- 12.6 seconds, 720×1280, 60 fps
- H.264/AAC MP4 with 48 kHz stereo audio
- Google Cloud TTS: 91 billable characters; maximum estimated cost USD 0.001456
- black-frame ratio: 0
- frozen-frame ratio: 0
- audibility mean: −25.4 dB

The final output passed the same media acceptance checks used for purchased campaign delivery: video count, variant coverage, duration, aspect ratio, audio stream, audibility, black-frame ratio, freeze ratio and duplicate-content checks. The first three visual revisions are retained under `.validation/reference-clone/output/revisions/` as a QA trail.

## Historical Google Veo product-motion validation (2026-09-21)

On 2026-09-21, the existing Google Cloud project was used for one bounded Veo validation after Vertex AI was enabled. The request used `veo-3.1-lite-generate-001`, one product image, one output, four seconds, 720p portrait video, no generated audio and no automatic retry. DeepSeek's cached reference analysis supplied the creative direction; the TikTok video itself was not sent to Veo because this model does not accept a reference-video input.

- output: `.validation/reference-clone/output/veo/cotton-swabs-veo-lite.mp4`
- receipt: `.validation/reference-clone/output/veo/veo-validation-receipt.json`
- media: 4.0 seconds, 720×1280, 24 fps, H.264, no audio
- output SHA-256: `06290250f3d0254cf9564e8965f525d3113e7528d7322b4a2a3fec1773a49746`

The clip successfully moves from the supplied tub to a newly generated adult creator using a visually matching light-wood, white-tipped swab. It validates the Google alternative for product-aware motion generation. It does not validate literal frame-for-frame replacement of the source TikTok video, and the raw four-second clip still needs Hypit composition, approved copy and audio before it is a deliverable marketing video.

After the short validation was accepted, one additional bounded Veo Lite request generated an eight-second continuation from the four-second clip's final frame. The two clips were joined locally, the already-approved Google TTS narration was reused, and an explicit CTA treatment covered model-generated pseudo-text in the lower third. This 4+8-second artifact is a dated validation output for the configuration exercised on 2026-09-21.

- finished output: `.validation/reference-clone/output/veo/cotton-swabs-veo-12s-finished.mp4`
- continuation receipt: `.validation/reference-clone/output/veo/veo-continuation-receipt.json`
- media: 12.0 seconds, 720×1280, 24 fps, H.264 video, AAC mono audio
- finished SHA-256: `653cd7bb139643883f019a9ea1302c1a3fa32d88cca16db241163ca16dc56a79`

## Historical vision-enhanced product-photo result (2026-09-20)

The original `deepseek-flash` acceptance analysis used eight ordered reference frames and the resized product image. It correctly observed the clear tub, pointed and rounded cotton tips, light wood shafts, the reference's eye-detail framing, its transition around 7.2 seconds and its calmer reveal phase. That historical acceptance run compiled the plan into six product-only shots.

- DeepSeek usage: 3,674 input tokens and 2,465 output tokens in one request
- Google Cloud TTS: 70 billable characters; maximum estimated cost USD 0.001120
- Hypit Build: `bld_20260920T154934323Z_859F07AEB0`
- output: `.validation/reference-clone/output/cotton-swabs-vision-adapted.mp4`
- 12.6 seconds, 720×1280, 60 fps, H.264/AAC with 48 kHz stereo audio
- black-frame ratio: 0; frozen-frame ratio: 0; audibility mean: −26.7 dB
- final SHA-256: `3a614225d0a4fd44580e369c64fb111c8682204f8c19323171889005e2451a46`

Visual QA rejected the first vision render because two captions created isolated-letter line breaks and one crop over-weighted a pale highlight. The compiler now constrains crop focus to the product region, caps detail zoom, widens copy frames, scales type conservatively and uses clean image cuts. Subsequent revisions reused the persisted vision plan and script-bound TTS audio, so they made no additional DeepSeek or Google TTS calls. The final storyboard has no broken words, isolated punctuation or blank transition frame.

Compared with the baseline, the final video is materially more product-specific: it names the double-ended form, distinguishes the pointed and rounded tips, shows the visible wooden shafts and uses a direct product CTA. The baseline remains somewhat bolder typographically; the vision version trades that generic impact for accurate product and reference understanding.

## Current two-segment production path

The current order path carries a versioned action sequence and generic subject framing from
reference analysis into two eight-second Veo requests. The first request starts from the supplied
product image; its final frame anchors the eight-second continuation. The generated segments are
paced together to the source duration within an 8-16 second window, retaining the closing action,
and Hypit assembles
narration and captions. If Veo is unavailable, over quota or either segment is missing, production
pauses. The reference's choreography and visual structure guide a new product-led scene with a
generic performer. The dated 4+8-second Veo artifact and product-photo renders above are separate
evidence.

On 2026-09-24, an isolated local order exercised real DeepSeek interpretation and reference planning,
two paid Veo generations, Google TTS, Hypit Build/export and Buyer packaging, with simulated Bitcoin
payment. Three 12.6-second variants were delivered technically, but visual review found invented,
unreadable lettering already present in the raw first Veo segment. This fails creative quality
acceptance despite passing media-integrity checks. That earlier order is historical evidence, not
the acceptance result for the updated path.

A second isolated local order on 2026-09-24 validated the updated negative prompt and full-sequence
pacing with two Veo 3.1 Lite generations, real DeepSeek reference/copy calls, Google TTS, Hypit
Build/export and Buyer completion. Bitcoin payment was simulated. Its source TikTok page was
temporarily unreachable during this run, so the order resumed with the previously fetched and
locally verified 12.47-second cache entry for the same URL. Hypit measured the source timeline
at 12.606 seconds. The first build exposed two caption defects: an internal objective slug was
rendered on screen and a long opening headline wrapped inside a word. The compiler now omits the
internal objective from reference-guided captions and shortens titles at phrase boundaries.
Using the same generated motion and voice, a network-disabled Hypit rebuild produced three
corrected 12.6-second H.264/AAC variants under
`.validation/paid-e2e-20260924-qa/review/re-render/*-final.mp4` without additional model calls.
Sampled opening, middle and closing frames showed continuous product-use action and no invented
lettering or internal objective text. All three corrected files contain video and audio streams.
The corrected videos were revalidated with the Buyer media gate and attached to the same isolated
completed order as delivery revision `r2`; the first package remains in `packageHistory` with its
original files and hashes intact. Six authenticated Buyer downloads (three original, three revised)
matched their recorded byte counts and SHA-256 digests. In the local Buyer page, the corrected
12.6-second video loaded and all three hook selectors pointed the player and download link to their
respective revised files. A delivery-issue test on a copy of the intake state selected Hook 2,
bound its evidence to that Hook 2 artifact and matched the revised manifest, with no refund issued.

## Current evidence boundary

The first non-generative baseline validated secure social-page ingest, mechanical and visual reference analysis, schema-constrained product understanding, dynamic crop/copy/timing compilation, new copy and voice, Hypit Build and verified MP4 export. That historical baseline used crop, zoom and reveal composition from one product photo.

The current reference-guided path adds newly generated generic human action through two bounded Veo
segments and Hypit assembly. This is an order-bound use of Hypit's Author/Run/Build, not Hypit's
full interactive agent workflow of reviewing the finished composition and revising creative assets.
The corrected local QA render validates the updated Veo prompt, source-length motion pacing and
the inspected caption points, but is not a full subjective review of every frame or audio segment.
The QA correction used a versioned local Buyer package; it did not create another order or payment.
Neither test nor simulated payment validates real Bitcoin settlement, and the updated path has not
been deployed online.
