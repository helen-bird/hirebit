import { spawn } from "node:child_process";
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";

export function retryDelay(failures) {
  return Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, failures - 1)));
}

export function xml(value) {
  return String(value).replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

export function remainingAwakeSeconds(until, now = Date.now()) {
  const value = Date.parse(until);
  if (!Number.isFinite(value)) throw new Error("Invalid keep-awake deadline");
  return Math.max(0, Math.ceil((value - now) / 1000));
}

export function makeLogger(file, secrets = [], maxBytes = 2 * 1024 * 1024) {
  return (event, detail = "") => {
    let line = `${new Date().toISOString()} ${event} ${String(detail)}`;
    for (const secret of secrets.filter((s) => typeof s === "string" && s.length >= 8)) line = line.replaceAll(secret, "[REDACTED]");
    line = line.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]").slice(0, 16_000) + "\n";
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
      if (existsSync(`${file}.3`)) unlinkSync(`${file}.3`);
      for (let i = 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, line, { mode: 0o600 });
  };
}

// Only owns children it spawned. No process-name matching or global Docker restarts.
export class ManagedProcess {
  constructor(name, command, args, { env, cwd, log, delay = retryDelay, restart = true } = {}) {
    Object.assign(this, { name, command, args, env, cwd, log, delay, restart });
    this.failures = 0;
    this.starts = 0;
    this.stopping = false;
  }

  start() {
    if (this.child || this.stopping) return;
    const started = Date.now();
    const child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.starts++;
    this.log(this.name, `started pid=${child.pid ?? "unavailable"}`);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk;
        let i;
        while ((i = pending.indexOf("\n")) !== -1) {
          this.log(this.name, pending.slice(0, i));
          pending = pending.slice(i + 1);
        }
        if (pending.length > 64_000) pending = "[oversized log line omitted]";
      });
      stream.on("end", () => { if (pending) this.log(this.name, pending); });
    }
    child.on("error", (error) => this.log(this.name, `spawn failed: ${error.code ?? "unknown"}`));
    child.once("close", (code, signal) => {
      this.child = null;
      this.log(this.name, `exited code=${code} signal=${signal}`);
      if (this.stopping || !this.restart) return;
      this.failures = Date.now() - started > 120_000 ? 1 : this.failures + 1;
      this.timer = setTimeout(() => this.start(), this.delay(this.failures));
    });
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }

  status() { return { pid: this.child?.pid ?? null, starts: this.starts }; }
}

export async function probe(url, expectedService, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: "error", headers: { "cache-control": "no-cache" } });
    const body = await response.json();
    return { ok: response.ok && body.ok === true && body.service === expectedService, status: response.status };
  } catch { return { ok: false, status: null }; }
}
