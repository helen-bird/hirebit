# Reference-only Hypit production acceptance

This document keeps the first non-vision baseline as comparison evidence. The command now includes a bounded DeepSeek vision stage: one resized product image and eight sampled reference frames are converted into a schema-validated six-shot plan, then compiled into allowlisted Hypit primitives.

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

## Google Veo product-motion validation

On 2026-09-21, the existing Google Cloud project was used for one bounded Veo validation after Vertex AI was enabled. The request used `veo-3.1-lite-generate-001`, one product image, one output, four seconds, 720p portrait video, no generated audio and no automatic retry. DeepSeek's cached reference analysis supplied the creative direction; the TikTok video itself was not sent to Veo because this model does not accept a reference-video input.

- output: `.validation/reference-clone/output/veo/cotton-swabs-veo-lite.mp4`
- receipt: `.validation/reference-clone/output/veo/veo-validation-receipt.json`
- media: 4.0 seconds, 720×1280, 24 fps, H.264, no audio
- output SHA-256: `06290250f3d0254cf9564e8965f525d3113e7528d7322b4a2a3fec1773a49746`

The clip successfully moves from the supplied tub to a newly generated adult creator using a visually matching light-wood, white-tipped swab. It validates the Google alternative for product-aware motion generation. It does not validate literal frame-for-frame replacement of the source TikTok video, and the raw four-second clip still needs Hypit composition, approved copy and audio before it is a deliverable marketing video.

After the short validation was accepted, one additional bounded Veo Lite request generated an eight-second continuation from the four-second clip's final frame. The two clips were joined locally, the already-approved Google TTS narration was reused, and an explicit CTA treatment covered model-generated pseudo-text in the lower third. No third video-generation request was made.

- finished output: `.validation/reference-clone/output/veo/cotton-swabs-veo-12s-finished.mp4`
- continuation receipt: `.validation/reference-clone/output/veo/veo-continuation-receipt.json`
- media: 12.0 seconds, 720×1280, 24 fps, H.264 video, AAC mono audio
- finished SHA-256: `653cd7bb139643883f019a9ea1302c1a3fa32d88cca16db241163ca16dc56a79`

## Vision-enhanced result

The original `deepseek-flash` acceptance analysis used eight ordered reference frames and the resized product image. It correctly observed the clear tub, pointed and rounded cotton tips, light wood shafts, the reference's eye-detail framing, its transition around 7.2 seconds and its calmer reveal phase. That historical acceptance run compiled the plan into six product-only shots.

The production path now carries a versioned action sequence and generic subject framing from that bounded analysis into two approved Veo requests. The first request starts from the supplied product image; its final frame is the input for a second continuation request, with the remaining choreography assigned to that segment. Hypit joins the two generated segments, trims the result to the source duration within an 8-16 second window, and performs narration and caption assembly. It no longer stretches an eight-second generation with a long static product end card. If Veo is disabled, unavailable, over quota or either bound segment is missing, reference-video production stops explicitly rather than falling back to historical product-photo shots. The source person's identity, captions and audio are still not reused.

- DeepSeek usage: 3,674 input tokens and 2,465 output tokens in one request
- Google Cloud TTS: 70 billable characters; maximum estimated cost USD 0.001120
- Hypit Build: `bld_20260920T154934323Z_859F07AEB0`
- output: `.validation/reference-clone/output/cotton-swabs-vision-adapted.mp4`
- 12.6 seconds, 720×1280, 60 fps, H.264/AAC with 48 kHz stereo audio
- black-frame ratio: 0; frozen-frame ratio: 0; audibility mean: −26.7 dB
- final SHA-256: `3a614225d0a4fd44580e369c64fb111c8682204f8c19323171889005e2451a46`

Visual QA rejected the first vision render because two captions created isolated-letter line breaks and one crop over-weighted a pale highlight. The compiler now constrains crop focus to the product region, caps detail zoom, widens copy frames, scales type conservatively and uses clean image cuts. Subsequent revisions reused the persisted vision plan and script-bound TTS audio, so they made no additional DeepSeek or Google TTS calls. The final storyboard has no broken words, isolated punctuation or blank transition frame.

Compared with the baseline, the final video is materially more product-specific: it names the double-ended form, distinguishes the pointed and rounded tips, shows the visible wooden shafts and uses a direct product CTA. The baseline remains somewhat bolder typographically; the vision version trades that generic impact for accurate product and reference understanding.

## Capability boundary

The first non-generative baseline validated secure social-page ingest, mechanical and visual reference analysis, schema-constrained product understanding, dynamic crop/copy/timing compilation, new copy and voice, Hypit Build and verified MP4 export. That historical baseline used crop, zoom and reveal composition from one product photo.

The current reference-guided path adds newly generated generic human action through two bounded Veo segments and Hypit assembly. It still does not claim exact reconstruction of every source shot, action, caption, effect or music cue, and it does not copy the source person's identity or likeness.
