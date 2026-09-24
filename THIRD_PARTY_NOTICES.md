# Third-party scope and attribution

## Hypit

Video composition and production orchestration use the pinned [Hypit project](https://github.com/hypit-ai/hypit).
Its original notices and modified Apache 2.0 license remain in `vendor/hypit/LICENSE`. The Buyer/Seller
service boundary is a technical design and does not establish a licensing exemption.

The committed `patches/hypit/yt-dlp-curl-cffi.patch` and
`patches/hypit/yt-dlp-download-cap.patch` are modifications of Hypit and are provided under
Hypit's same license terms. The license expressly permits an organization's own work, including work
for clients, and separately restricts offering Hypit's functionality to third parties as a hosted,
managed or SaaS service. Tenant scope concerns parties and workspaces, not the number of Buyer
processes. Operating one shared Buyer for unrelated customers does not itself establish compliance.
Obtain written clarification from Hypit.AI before relying on that interpretation for public service.

## Media

The optional Apple Silicon `@ffprobe-installer/darwin-arm64` package supplies an FFprobe binary
under LGPL-2.1; it is installed locally by npm and is not committed to this repository.

The product photograph in `productions/shared-assets/arduino-uno-r4-wifi/product.jpg` is by Lomrjyo,
licensed CC BY-SA 4.0. The four videos in `productions/previews/final/` adapt that photograph with
cropping, overlays, narration and editing and are distributed under CC BY-SA 4.0. See the detailed
[source record](productions/shared-assets/arduino-uno-r4-wifi/SOURCES.md) for attribution and links.
These licenses are not overridden by Hirebit's All Rights Reserved notice.

`product_pic.jpeg` was supplied by the repository owner, who approved its inclusion in this public
repository. No additional reuse license is granted for it.

## Model and media providers

DeepSeek is used directly for structured mandate interpretation, package ranking and testing-plan text. Hypit generation, speech, image, video and media providers retain their own pricing, acceptable-use, privacy and content-rights terms. `providerTermsConfirmedAt` and `maxProviderCostSats` are operational acceptance fields, not a substitute for those terms.

Customer-supplied reference/evidence material must be authorized for the requested transformation. The application localizes those URLs through a controlled downloader; localization does not grant copyright or personality rights.

## Project contribution

This repository's Buyer/Seller commerce layer, authorization gates, spend ledger, GoBTC integration, recovery behavior, delivery validator, package manifest and demo UI are project-specific work. Hypit provides the underlying production framework and related examples/components. Demo narration and submission materials should preserve that distinction.
