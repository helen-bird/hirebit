import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { probeMedia } from "../src/media-probe.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("media inspection retains source dimensions and duration for packaged assets", async () => {
  const image = await probeMedia(join(rootDir, "productions/shared-assets/arduino-uno-r4-wifi/product.jpg"));
  assert.ok(image.streams.some((stream) => stream.codec_type === "video" && stream.width > 0 && stream.height > 0));
  const video = await probeMedia(join(rootDir, "productions/previews/final/proof-demo.mp4"));
  assert.ok(Number(video.format.duration) >= 24);
  assert.ok(video.streams.some((stream) => stream.codec_type === "video" && stream.width === 540 && stream.height === 960));
  assert.ok(video.streams.some((stream) => stream.codec_type === "audio" && stream.sample_rate));
});

test("media inspection fails closed on corrupt input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "media-probe-invalid-"));
  const path = join(directory, "corrupt.mp4");
  await writeFile(path, "not a video");
  await assert.rejects(probeMedia(path), (error) => error.code === "media_invalid");
});
