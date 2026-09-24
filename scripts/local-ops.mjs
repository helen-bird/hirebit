import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { chmod, mkdir, readFile, writeFile, rename, readdir, unlink, statfs, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { acquireProcessLock } from "../src/json-store.mjs";
import { ManagedProcess, makeLogger, probe, xml, remainingAwakeSeconds } from "./local-ops-lib.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const ops = join(root, ".local-ops");
const label = "local.hirebit.supervisor";
const domain = `gui/${process.getuid()}`;
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const configFile = join(ops, "config.json");
const stateFiles = [
  ".buyer/public-demo-state.json", ".buyer/public-demo-intake-state.json",
  ".seller/public-demo-state.json", ".seller/public-demo-payments.json", ".seller/google-veo-ledger.json",
];
async function prepare() { await mkdir(ops, { recursive: true, mode: 0o700 }); await chmod(ops, 0o700); }
async function atomic(file, value) {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
async function environment() {
  const values = { ...parseEnv(await readFile(join(root, ".env"), "utf8")), ...parseEnv(await readFile(join(root, ".env.public-demo"), "utf8")) };
  const origin = new URL(values.PUBLIC_DEMO_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid public origin");
  if (values.HYPIT_WORKER_MODE !== "docker") throw new Error("Local supervision requires the existing Docker isolation profile");
  // Do not inherit unrelated credentials, Node preload flags, or shell overrides.
  const env = {
    HOME: homedir(), USER: process.env.USER, TMPDIR: process.env.TMPDIR ?? "/tmp",
    PATH: `${join(homedir(), ".local/bin")}:${join(homedir(), "google-cloud-sdk/bin")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...values, PAYMENT_MODE: "demo", PUBLIC_DEMO_MODE: "1", HOST: "127.0.0.1", PORT: "8787", BUYER_HOST: "127.0.0.1", BUYER_PORT: "8788",
    SELLER_STATE_FILE: "public-demo-state.json", DEMO_PAYMENT_STATE_FILE: "public-demo-payments.json",
    BUYER_STATE_FILE: "public-demo-state.json", BUYER_INTAKE_STATE_FILE: "public-demo-intake-state.json", BUYER_API_TOKEN_FILE: "public-demo-api-token",
  };
  return env;
}

async function snapshot() {
  const folder = join(ops, "backups");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const date = new Date().toISOString().slice(0, 10);
  const files = await readdir(folder);
  if (!files.includes(`${date}.json`)) {
    const contents = {};
    for (const file of stateFiles) {
      try { contents[file] = JSON.parse(await readFile(join(root, file), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // For manual recovery only: each file is atomic, the set is not a cross-service transaction.
    await atomic(join(folder, `${date}.json`), { createdAt: new Date().toISOString(), contents });
  }
  const dates = (await readdir(folder)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(f)).sort();
  for (const name of dates.slice(0, -8)) await unlink(join(folder, name));
}

async function run() {
  const lock = await acquireProcessLock(join(ops, "supervisor.lock"));
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const env = await environment();
  const secrets = Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY/u.test(key)).map(([, value]) => value);
  if (config.tunnel) {
    const tokenStat = await lstat(config.tunnel.tokenFile);
    if (!tokenStat.isFile() || tokenStat.uid !== process.getuid() || (tokenStat.mode & 0o777) !== 0o600) {
      throw new Error("Tunnel token must be an owner-only regular file (0600)");
    }
    secrets.push((await readFile(config.tunnel.tokenFile, "utf8")).trim());
  }
  for (const file of [".seller/api-token", ".buyer/api-token", ".buyer/public-demo-api-token"]) {
    try { secrets.push((await readFile(join(root, file), "utf8")).trim()); } catch { /* optional */ }
  }
  const log = makeLogger(join(ops, "services.log"), secrets);
  const children = [];
  function manage(name, command, args, extra = {}) {
    const child = new ManagedProcess(name, command, args, { cwd: root, env, log, ...extra });
    children.push(child); child.start(); return child;
  }
  const remaining = remainingAwakeSeconds(config.keepAwakeUntil);
  if (remaining > 0) manage("keep-awake", "/usr/bin/caffeinate", ["-is", "-t", String(remaining)], { restart: false });
  // Launch only this project's services, never restart Docker or another project's processes.
  const seller = manage("seller", process.execPath, ["src/index.mjs"]);
  const buyer = manage("buyer", process.execPath, ["src/buyer-index.mjs"]);
  let tunnel;
  if (config.tunnel?.binary && config.tunnel?.tokenFile) {
    tunnel = manage("tunnel", config.tunnel.binary, ["tunnel", "--no-autoupdate", "run", "--token-file", config.tunnel.tokenFile], {
      env: { HOME: env.HOME, PATH: env.PATH, TMPDIR: env.TMPDIR },
    });
  }
  let stopped = false;
  let inFlight = false;
  let previous = "";
  const check = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const [localBuyer, localSeller, publicBuyer, disk] = await Promise.all([
        probe("http://127.0.0.1:8788/health", "autonomous-video-buyer"),
        probe("http://127.0.0.1:8787/health", "hypit-video-seller"),
        probe(`${env.PUBLIC_DEMO_ORIGIN}/health`, "autonomous-video-buyer"), statfs(root),
      ]);
      let dockerReady = false;
      try { await exec(env.DOCKER_BIN ?? "/usr/local/bin/docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 8000, maxBuffer: 32_768 }); dockerReady = true; } catch { /* report only */ }
      const freeGiB = Math.round(disk.bavail * disk.bsize / 1024 ** 3);
      const status = {
        checkedAt: new Date().toISOString(), supervisorPid: process.pid,
        buyer: { ...localBuyer, ...buyer.status() }, seller: { ...localSeller, ...seller.status() }, public: publicBuyer,
        dockerReady, freeGiB, diskWarning: freeGiB < 5, keepAwakeUntil: config.keepAwakeUntil,
        keepAwakeActive: remainingAwakeSeconds(config.keepAwakeUntil) > 0 && children.some((c) => c.name === "keep-awake" && c.child),
        tunnelMode: config.tunnel ? "named" : "existing-unmanaged-quick-tunnel",
        tunnel: tunnel?.status() ?? null,
      };
      const state = JSON.stringify([localBuyer.ok, localSeller.ok, publicBuyer.ok, dockerReady, status.diskWarning, status.keepAwakeActive]);
      if (state !== previous) { log("health", JSON.stringify(status)); previous = state; }
      await atomic(join(ops, "health.json"), status);
      await snapshot();
      // A failed health probe is not permission to replay orders or kill paid production.
    } catch (error) { log("health", `check failed: ${error.code ?? error.name}`); }
    finally { inFlight = false; }
  };
  const timer = setInterval(() => void check(), 60_000);
  void check();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true; stopped = true; clearInterval(timer);
    await Promise.all(children.map((child) => child.stop()));
    await lock.release(); process.exit(0);
  };
  process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
}

async function install() {
  await environment();
  let config;
  try { config = JSON.parse(await readFile(configFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  config ??= { keepAwakeUntil: new Date(Date.now() + 7 * 86400_000).toISOString(), tunnel: null };
  await atomic(configFile, config);
  // launchd opens these paths before Node starts; create them with private permissions.
  await writeFile(join(ops, "bootstrap.log"), "", { flag: "a", mode: 0o600 });
  await chmod(join(ops, "bootstrap.log"), 0o600);
  await mkdir(resolve(plist, ".."), { recursive: true });
  const args = [process.execPath, join(root, "scripts/local-ops.mjs"), "run"];
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(ops, "bootstrap.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(ops, "bootstrap.log"))}</string>
</dict></plist>\n`, { mode: 0o600 });
  console.log(`Installed ${label}. Keep-awake deadline: ${config.keepAwakeUntil}. Run npm run ops:start.`);
}

await prepare();
const action = process.argv[2];
if (action === "install") await install();
else if (action === "run") await run();
else if (action === "start") {
  let loaded = false;
  try { await exec("/bin/launchctl", ["print", `${domain}/${label}`]); loaded = true; } catch { /* unloaded */ }
  if (!loaded) await exec("/bin/launchctl", ["bootstrap", domain, plist]);
  console.log(loaded ? "Hirebit supervision is already loaded." : "Hirebit supervision started.");
} else if (action === "stop") {
  await exec("/bin/launchctl", ["bootout", `${domain}/${label}`]);
  // bootout can return before launchd has removed the job. A following start
  // must not mistake the unloading job for a healthy, already-loaded service.
  const deadline = Date.now() + 30_000;
  while (true) {
    let loaded = false;
    try { await exec("/bin/launchctl", ["print", `${domain}/${label}`]); loaded = true; } catch { /* unloaded */ }
    if (!loaded) break;
    if (Date.now() >= deadline) throw new Error("Hirebit supervision is still unloading; verify before starting again");
    await delay(200);
  }
  console.log("Stopped Hirebit supervision and its owned processes. Existing unmanaged tunnel is unchanged.");
} else if (action === "status") {
  let loaded = false;
  try { await exec("/bin/launchctl", ["print", `${domain}/${label}`]); loaded = true; } catch { /* unloaded */ }
  let status = null;
  try { status = JSON.parse(await readFile(join(ops, "health.json"), "utf8")); } catch { /* unavailable */ }
  console.log(JSON.stringify({ loaded, stale: !status || Date.now() - Date.parse(status.checkedAt) > 150_000, ...status }, null, 2));
} else throw new Error("Usage: node scripts/local-ops.mjs install|start|stop|status|run");
