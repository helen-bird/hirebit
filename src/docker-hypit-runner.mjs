import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { AppError } from "./errors.mjs";

const execFileAsync = promisify(execFile);
const ATTESTATION_FORMAT = "seller.hypit-worker-isolation@1";
const REQUIRED_TESTS = Object.freeze([
  "non_root_user",
  "read_only_root",
  "network_disabled",
  "capabilities_dropped",
  "no_new_privileges",
  "single_job_mount",
  "secret_paths_absent",
  "secret_environment_absent",
  "outside_write_denied",
  "job_write_allowed",
  "hypit_build_complete",
]);

function inside(path, root) {
  const target = resolve(path);
  const boundary = resolve(root);
  return target === boundary || target.startsWith(`${boundary}${sep}`);
}

function containerName(jobDir) {
  return `agentic-hypit-${createHash("sha256").update(resolve(jobDir)).digest("hex").slice(0, 20)}`;
}

function volumeName(jobDir) {
  return `agentic-hypit-job-${createHash("sha256").update(resolve(jobDir)).digest("hex").slice(0, 20)}`;
}

function containerPath(hostPath, jobDir) {
  if (!inside(hostPath, jobDir)) {
    throw new AppError("hypit_container_path_denied", "Container command attempted to access a host path outside its order directory", 503);
  }
  const suffix = relative(resolve(jobDir), resolve(hostPath)).split(sep).join("/");
  return suffix === "" ? "/work/job" : `/work/job/${suffix}`;
}

function runtimeProfile() {
  return {
    format: "hypit.runtime-local@1",
    dataRoot: "/work/job/hypit-runtime",
    endpoints: {
      "media.local": {
        use: "@hypit/provider-media-local",
        config: {
          defaultConcurrency: 2,
          ffmpegPath: "/opt/worker-tools/bin/ffmpeg",
          ffprobePath: "/usr/bin/ffprobe",
        },
      },
      "hyperframes.local": {
        use: "@hypit/provider-hyperframes-local",
        config: {
          workers: 2,
          defaultConcurrency: 1,
          browserGpu: "software",
          ffmpegPath: "/opt/worker-tools/bin/ffmpeg",
          ffprobePath: "/usr/bin/ffprobe",
          chromePath: "/usr/bin/chromium",
        },
      },
    },
  };
}

export class DockerHypitRunner {
  constructor({
    dataDir,
    dockerBin = "/usr/local/bin/docker",
    image = "agentic-hypit-worker:local",
    attestationFile = resolve(dataDir, "isolation-verification.json"),
    allowedJobRoots = [resolve(dataDir, "jobs")],
    uid = typeof process.getuid === "function" ? process.getuid() : 1000,
    gid = typeof process.getgid === "function" ? process.getgid() : 1000,
  }) {
    this.dataDir = resolve(dataDir);
    this.dockerBin = dockerBin;
    this.image = image;
    this.attestationFile = resolve(attestationFile);
    this.allowedJobRoots = allowedJobRoots.map((item) => resolve(item));
    this.uid = uid;
    this.gid = gid;
  }

  async isolationStatus() {
    let imageId;
    try {
      const { stdout } = await execFileAsync(this.dockerBin, ["image", "inspect", "--format", "{{.Id}}", this.image], {
        timeout: 30_000, maxBuffer: 64 * 1024,
      });
      imageId = stdout.trim();
    } catch {
      return { configured: false, verified: false, mode: "docker", image: this.image, issue: "worker_image_unavailable" };
    }
    let attestation;
    try { attestation = JSON.parse(await readFile(this.attestationFile, "utf8")); } catch {
      return { configured: true, verified: false, mode: "docker", image: this.image, imageId, issue: "isolation_attestation_missing" };
    }
    const testMap = new Map((attestation.tests ?? []).map((item) => [item.id, item.passed]));
    const verified = attestation.format === ATTESTATION_FORMAT
      && attestation.image === this.image
      && attestation.imageId === imageId
      && REQUIRED_TESTS.every((id) => testMap.get(id) === true);
    return {
      configured: true,
      verified,
      mode: "docker",
      image: this.image,
      imageId,
      verifiedAt: verified ? attestation.verifiedAt : null,
      issue: verified ? null : "isolation_attestation_invalid",
    };
  }

  async run(_program, args, options) {
    const jobDir = this.#jobDir(options?.jobDir);
    await this.#ensureContainer(jobDir);
    const runtimeHostPath = options?.runtimePath === undefined ? null : resolve(options.runtimePath);
    const translated = args.map((arg) => {
      if (runtimeHostPath !== null && resolve(String(arg)) === runtimeHostPath) return "/work/job/docker-hypit.runtime.json";
      if (typeof arg === "string" && arg.startsWith("/") && inside(arg, jobDir)) return containerPath(arg, jobDir);
      if (typeof arg === "string" && arg.startsWith("/")) {
        throw new AppError("hypit_container_path_denied", "Hypit received an absolute host path outside its order directory", 503);
      }
      return arg;
    });
    const cwd = containerPath(options.cwd, jobDir);
    const environment = {
      HOME: "/home/hypit",
      TMPDIR: "/tmp",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...(typeof options.env?.LANG === "string" ? { LANG: options.env.LANG } : {}),
      ...(typeof options.env?.LC_ALL === "string" ? { LC_ALL: options.env.LC_ALL } : {}),
      ...(typeof options.env?.SELLER_COMMISSION_PATH === "string"
        ? { SELLER_COMMISSION_PATH: containerPath(options.env.SELLER_COMMISSION_PATH, jobDir) }
        : {}),
    };
    const dockerArgs = ["exec", "--workdir", cwd];
    for (const [name, value] of Object.entries(environment)) dockerArgs.push("--env", `${name}=${value}`);
    dockerArgs.push(containerName(jobDir), "/opt/hypit/hypit", ...translated);
    try {
      const result = await execFileAsync(this.dockerBin, dockerArgs, {
        timeout: options.timeoutMs ?? 3_600_000,
        maxBuffer: 1_000_000,
      });
      const outputIndex = args.indexOf("--to");
      if (args[0] === "get" && outputIndex >= 0 && typeof args[outputIndex + 1] === "string") {
        await this.copyOut(jobDir, args[outputIndex + 1]);
      }
      return result;
    } catch (error) {
      throw new AppError("hypit_command_failed", "Isolated Hypit command failed", 502, {
        exitCode: error.code,
        stdout: String(error.stdout ?? "").slice(-2000),
        stderr: String(error.stderr ?? "").slice(-4000),
      });
    }
  }

  async exec(jobDirValue, program, args = [], { cwd = "/work/job", env = {}, timeoutMs = 120_000 } = {}) {
    const jobDir = this.#jobDir(jobDirValue);
    await this.#ensureContainer(jobDir);
    const dockerArgs = ["exec", "--workdir", cwd];
    for (const [name, value] of Object.entries(env)) dockerArgs.push("--env", `${name}=${value}`);
    dockerArgs.push(containerName(jobDir), program, ...args);
    return await execFileAsync(this.dockerBin, dockerArgs, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  }

  async inspect(jobDirValue) {
    const jobDir = this.#jobDir(jobDirValue);
    await this.#ensureContainer(jobDir);
    const { stdout } = await execFileAsync(this.dockerBin, ["inspect", containerName(jobDir)], {
      timeout: 30_000, maxBuffer: 1_000_000,
    });
    return JSON.parse(stdout)[0];
  }

  async copyOut(jobDirValue, hostPath) {
    const jobDir = this.#jobDir(jobDirValue);
    const target = resolve(hostPath);
    const source = containerPath(target, jobDir);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await execFileAsync(this.dockerBin, ["cp", "--archive", `${containerName(jobDir)}:${source}`, target], {
      timeout: 300_000, maxBuffer: 1_000_000,
    });
  }

  async cleanup({ jobDir: jobDirValue }) {
    const jobDir = this.#jobDir(jobDirValue);
    await execFileAsync(this.dockerBin, ["rm", "--force", containerName(jobDir)], {
      timeout: 30_000, maxBuffer: 64 * 1024,
    }).catch(() => {});
    await execFileAsync(this.dockerBin, ["volume", "rm", volumeName(jobDir)], {
      timeout: 30_000, maxBuffer: 64 * 1024,
    }).catch(() => {});
  }

  async #ensureContainer(jobDir) {
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    const runtimePath = resolve(jobDir, "docker-hypit.runtime.json");
    const runtimeBytes = `${JSON.stringify(runtimeProfile(), null, 2)}\n`;
    try {
      if (await readFile(runtimePath, "utf8") !== runtimeBytes) {
        throw new AppError("hypit_container_runtime_mismatch", "Persisted container Runtime Profile changed", 503);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.code !== "ENOENT") throw error;
      await writeFile(runtimePath, runtimeBytes, { mode: 0o600, flag: "wx" });
    }
    const name = containerName(jobDir);
    try {
      const { stdout } = await execFileAsync(this.dockerBin, ["inspect", "--format", "{{.State.Running}}", name], {
        timeout: 15_000, maxBuffer: 64 * 1024,
      });
      if (stdout.trim() === "true") return;
      await execFileAsync(this.dockerBin, ["rm", "--force", name], { timeout: 30_000, maxBuffer: 64 * 1024 });
    } catch {
      // A missing container is the normal first-run state.
    }
    const volume = volumeName(jobDir);
    let newVolume = false;
    try {
      await execFileAsync(this.dockerBin, ["volume", "inspect", volume], { timeout: 30_000, maxBuffer: 64 * 1024 });
    } catch {
      await execFileAsync(this.dockerBin, [
        "volume", "create", "--label", "ai.agnic.agentic-commerce=hypit-job", volume,
      ], { timeout: 30_000, maxBuffer: 64 * 1024 });
      newVolume = true;
    }
    try {
      await execFileAsync(this.dockerBin, [
        "run", "--detach", "--name", name,
        "--label", "ai.agnic.agentic-commerce=hypit-worker",
        "--read-only", "--network", "none",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "512", "--memory", "6g", "--cpus", "2",
        "--user", `${this.uid}:${this.gid}`,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=3072m,mode=1777",
        "--tmpfs", `/home/hypit:rw,nosuid,size=1024m,mode=0700,uid=${this.uid},gid=${this.gid}`,
        "--mount", `type=volume,src=${volume},dst=/work`,
        "--workdir", "/tmp",
        "--env", "HOME=/home/hypit", "--env", "TMPDIR=/tmp",
        this.image, "sleep", "infinity",
      ], { timeout: 120_000, maxBuffer: 1_000_000 });
      if (newVolume) {
        await execFileAsync(this.dockerBin, ["cp", "--archive", jobDir, `${name}:/work/job`], {
          timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
        });
      }
    } catch (error) {
      await execFileAsync(this.dockerBin, ["rm", "--force", name], { timeout: 30_000, maxBuffer: 64 * 1024 }).catch(() => {});
      if (newVolume) {
        await execFileAsync(this.dockerBin, ["volume", "rm", volume], { timeout: 30_000, maxBuffer: 64 * 1024 }).catch(() => {});
      }
      throw error;
    }
  }

  #jobDir(value) {
    if (typeof value !== "string" || !this.allowedJobRoots.some((root) => inside(value, root))) {
      throw new AppError("hypit_container_job_path_denied", "Docker Hypit may mount only an allowlisted job directory", 503);
    }
    return resolve(value);
  }
}

export { ATTESTATION_FORMAT, REQUIRED_TESTS };
