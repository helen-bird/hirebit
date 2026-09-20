import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { ATTESTATION_FORMAT, DockerHypitRunner, REQUIRED_TESTS } from "../src/docker-hypit-runner.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const dataDir = resolve(rootDir, process.env.SELLER_DATA_DIR ?? ".seller");
const dockerBin = process.env.DOCKER_BIN ?? "/usr/local/bin/docker";
const image = process.env.HYPIT_WORKER_IMAGE ?? "agentic-hypit-worker:local";
const probeRoot = join(dataDir, "isolation-probes");
const jobDir = join(probeRoot, new Date().toISOString().replace(/[:.]/gu, "-"));
const projectDir = join(jobDir, "hypit-project");
const hostRuntimePath = join(rootDir, "productions/hypit.runtime.json");

function parseJson(value, subject) {
  try { return JSON.parse(value); } catch { throw new Error(`${subject} returned invalid JSON`); }
}

async function acceptedProject() {
  const validationRoot = join(dataDir, "production-validation");
  const runs = (await readdir(validationRoot)).sort().reverse();
  for (const run of runs) {
    const candidate = join(validationRoot, run, "creator_pitch", "hypit-project");
    try {
      if ((await stat(join(candidate, "run.svrun"))).isFile()) return candidate;
    } catch {
      // Continue to the next completed acceptance run.
    }
  }
  throw new Error("Run production acceptance before worker isolation verification; no compiled Creator Pitch project was found");
}

function result(id, passed, evidence) {
  return { id, passed: passed === true, evidence };
}

await mkdir(jobDir, { recursive: true, mode: 0o700 });
await cp(await acceptedProject(), projectDir, { recursive: true, errorOnExist: true });
await writeFile(join(jobDir, "commission.json"), "{\"isolationProbe\":true}\n", { mode: 0o600, flag: "wx" });

const runner = new DockerHypitRunner({
  dataDir,
  dockerBin,
  image,
  allowedJobRoots: [probeRoot],
});
const tests = [];
let buildId = null;
let media = null;
try {
  const identity = await runner.exec(jobDir, "/usr/bin/id", ["-u"]);
  tests.push(result("non_root_user", identity.stdout.trim() !== "0", { uid: identity.stdout.trim() }));

  const inspection = await runner.inspect(jobDir);
  const mounts = (inspection.Mounts ?? []).map((item) => ({ type: item.Type, source: item.Source, destination: item.Destination, rw: item.RW }));
  tests.push(result("read_only_root", inspection.HostConfig?.ReadonlyRootfs === true, { readOnlyRootfs: inspection.HostConfig?.ReadonlyRootfs }));
  tests.push(result("network_disabled", inspection.HostConfig?.NetworkMode === "none", { networkMode: inspection.HostConfig?.NetworkMode }));
  tests.push(result("capabilities_dropped", inspection.HostConfig?.CapDrop?.includes("ALL") === true, { capDrop: inspection.HostConfig?.CapDrop ?? [] }));
  tests.push(result("no_new_privileges", inspection.HostConfig?.SecurityOpt?.includes("no-new-privileges:true") === true, { securityOpt: inspection.HostConfig?.SecurityOpt ?? [] }));
  tests.push(result("single_job_mount", mounts.length === 1 && mounts[0].type === "volume" && mounts[0].destination === "/work" && mounts[0].rw === true, { mounts }));

  const absence = await runner.exec(jobDir, "/bin/sh", ["-c", [
    "set -eu",
    "test ! -e /repo/.env",
    "test ! -e /repo/.gobtcpay",
    "test ! -e /repo/.buyer",
    "test ! -e /repo/config/buyer-policy.json",
    "test ! -e /work/job/.env",
  ].join("\n")]);
  const secretPaths = [".env", ".gobtcpay", ".buyer", "config/buyer-policy.json"];
  for (const relativePath of secretPaths) {
    await runner.exec(jobDir, "/usr/bin/test", ["!", "-e", resolve(rootDir, relativePath)]);
  }
  tests.push(result("secret_paths_absent", absence.stderr === "", { checked: secretPaths }));

  const environment = await runner.exec(jobDir, "/usr/bin/env");
  const forbiddenNames = ["DEEPSEEK_API_KEY", "GOBTCPAY_MERCHANT_API_KEY", "SELLER_API_TOKEN", "BUYER_API_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS"];
  tests.push(result("secret_environment_absent", forbiddenNames.every((name) => !environment.stdout.includes(`${name}=`)), { forbiddenNames }));

  let outsideWriteDenied = false;
  try { await runner.exec(jobDir, "/usr/bin/touch", ["/isolation-escape"]); } catch { outsideWriteDenied = true; }
  tests.push(result("outside_write_denied", outsideWriteDenied, { target: "/isolation-escape" }));
  await runner.exec(jobDir, "/usr/bin/touch", ["/work/job/allowed-write"]);
  const allowedWrite = await runner.exec(jobDir, "/usr/bin/test", ["-f", "/work/job/allowed-write"]);
  tests.push(result("job_write_allowed", allowedWrite.stderr === "", { target: "/work/job/allowed-write" }));

  const common = {
    cwd: projectDir,
    env: { SELLER_COMMISSION_PATH: join(jobDir, "commission.json") },
    jobDir,
    runtimePath: hostRuntimePath,
  };
  const runPath = join(projectDir, "run.svrun");
  await runner.run("hypit", ["check", runPath, "--workspace", projectDir, "--json"], { ...common, timeoutMs: 120_000 });
  const planResult = await runner.run("hypit", ["plan", runPath, "--workspace", projectDir, "--runtime", hostRuntimePath, "--json"], { ...common, timeoutMs: 120_000 });
  const plan = parseJson(planResult.stdout, "hypit plan");
  if (plan.ok === false || plan.requestIssueCount > 0) throw new Error("Isolated Hypit plan has unresolved requests");
  const buildResult = await runner.run("hypit", ["build", runPath, "--workspace", projectDir, "--runtime", hostRuntimePath, "--title", "worker-isolation-verification", "--json"], { ...common, timeoutMs: 120_000 });
  buildId = parseJson(buildResult.stdout, "hypit build")?.build?.id;
  if (typeof buildId !== "string" || buildId === "") throw new Error("Isolated Hypit Build did not return an ID");
  const statusResult = await runner.run("hypit", ["status", buildId, "--workspace", projectDir, "--runtime", hostRuntimePath, "--watch", "--max-wait-ms", "600000", "--json"], { ...common, timeoutMs: 630_000 });
  const completed = parseJson(statusResult.stdout, "hypit status")?.build;
  if (completed?.work?.outcome !== "complete") throw new Error("Isolated Hypit Build did not complete");
  const outputPath = join(jobDir, "isolated-final.mp4");
  await runner.run("hypit", ["get", buildId, "--output", "video-h1-en-us-9x16.video", "--to", outputPath, "--workspace", projectDir, "--json"], { ...common, timeoutMs: 300_000 });
  const probe = await runner.exec(jobDir, "/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", "/work/job/isolated-final.mp4"]);
  media = parseJson(probe.stdout, "ffprobe");
  const video = media.streams?.find((item) => item.codec_type === "video");
  const audio = media.streams?.find((item) => item.codec_type === "audio");
  tests.push(result("hypit_build_complete", video?.width === 540 && video?.height === 960 && audio !== undefined, {
    buildId,
    durationSeconds: Number(media.format?.duration),
    width: video?.width,
    height: video?.height,
    audio: audio !== undefined,
  }));

  const failed = tests.filter((item) => item.passed !== true);
  if (failed.length > 0 || !REQUIRED_TESTS.every((id) => tests.some((item) => item.id === id && item.passed === true))) {
    throw new Error(`Worker isolation verification failed: ${failed.map((item) => item.id).join(", ")}`);
  }
  const status = await runner.isolationStatus();
  const { stdout: imageIdOutput } = await execFileAsync(dockerBin, ["image", "inspect", "--format", "{{.Id}}", image], { timeout: 30_000 });
  const { stdout: dockerVersion } = await execFileAsync(dockerBin, ["version", "--format", "{{.Server.Version}}"], { timeout: 30_000 });
  const attestation = {
    format: ATTESTATION_FORMAT,
    verifiedAt: new Date().toISOString(),
    mode: "docker",
    image,
    imageId: imageIdOutput.trim(),
    dockerServerVersion: dockerVersion.trim(),
    probeJob: jobDir,
    buildId,
    tests,
    preexistingStatus: status,
  };
  await writeFile(join(dataDir, "isolation-verification.json"), `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(attestation, null, 2));
} finally {
  await runner.cleanup({ jobDir });
}
