import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import test from "node:test";

import { resolveRegularFile, streamRegularFile, verifyRegularFileDigest } from "../src/safe-file.mjs";

test("safe file streaming transfers FileHandle ownership without a double close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "safe-file-stream-"));
  try {
    const path = join(directory, "asset.css");
    await writeFile(path, "body { color: orange; }\n", "utf8");
    const selected = await resolveRegularFile(directory, "asset.css");
    const response = new PassThrough();
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    streamRegularFile(response, selected);
    await once(response, "end");
    assert.equal(Buffer.concat(chunks).toString("utf8"), "body { color: orange; }\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("abandoned download closes the open file handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "safe-file-aborted-"));
  try {
    await writeFile(join(directory, "large.mp4"), Buffer.alloc(1024 * 1024));
    const selected = await resolveRegularFile(directory, "large.mp4");
    const response = new PassThrough({ highWaterMark: 1 });
    streamRegularFile(response, selected);
    const closed = once(selected.handle, "close");
    response.destroy();
    await closed;
    await assert.rejects(selected.handle.stat(), (error) => error.code === "EBADF");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package download verifies the opened file before streaming it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "safe-file-digest-"));
  try {
    const bytes = Buffer.from("verified media bytes\n");
    await writeFile(join(directory, "video.mp4"), bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const selected = await resolveRegularFile(directory, "video.mp4");
    await verifyRegularFileDigest(selected, digest, bytes.length);
    const response = new PassThrough();
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    streamRegularFile(response, selected);
    await once(response, "end");
    assert.deepEqual(Buffer.concat(chunks), bytes);

    await writeFile(join(directory, "video.mp4"), "tampered media bytes\n");
    const tampered = await resolveRegularFile(directory, "video.mp4");
    await assert.rejects(
      verifyRegularFileDigest(tampered, digest, bytes.length),
      (error) => error.code === "file_integrity_failed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
