import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ATTESTATION_FORMAT, DockerHypitRunner, REQUIRED_TESTS } from "../src/docker-hypit-runner.mjs";

test("Docker worker isolation requires an attestation bound to the current image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "docker-hypit-runner-"));
  const dockerBin = join(directory, "docker");
  const attestationFile = join(directory, "isolation-verification.json");
  await writeFile(dockerBin, "#!/bin/sh\nprintf 'sha256:current-image\\n'\n");
  await chmod(dockerBin, 0o700);
  const runner = new DockerHypitRunner({
    dataDir: directory,
    dockerBin,
    image: "worker:test",
    attestationFile,
    allowedJobRoots: [join(directory, "jobs")],
  });
  assert.equal((await runner.isolationStatus()).verified, false);
  await writeFile(attestationFile, JSON.stringify({
    format: ATTESTATION_FORMAT,
    image: "worker:test",
    imageId: "sha256:current-image",
    verifiedAt: "2026-09-20T00:00:00Z",
    tests: REQUIRED_TESTS.map((id) => ({ id, passed: true })),
  }));
  assert.equal((await runner.isolationStatus()).verified, true);
  const stale = JSON.parse(await (await import("node:fs/promises")).readFile(attestationFile, "utf8"));
  stale.imageId = "sha256:stale-image";
  await writeFile(attestationFile, JSON.stringify(stale));
  const status = await runner.isolationStatus();
  assert.equal(status.verified, false);
  assert.equal(status.issue, "isolation_attestation_invalid");
});
