import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { AppError } from "./errors.mjs";

// Each marker is written before a supplier call. A process crash may consume a
// slot without making the call; that is safer than an unbounded paid retry.
export async function reserveSellerProviderAttempt({ path, identity, uncertainCode }) {
  let first;
  try { first = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new AppError(uncertainCode, "Seller production attempt record is invalid", 503);
    }
  }
  if (first === undefined) {
    try {
      await writeFile(path, `${JSON.stringify({ ...identity, attempt: 1, startedAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" });
      return 1;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      throw new AppError(uncertainCode, "Another Seller production attempt is already running", 503);
    }
  }
  if (Object.entries(identity).some(([key, value]) => JSON.stringify(first[key]) !== JSON.stringify(value))) {
    throw new AppError(uncertainCode, "Seller production attempt does not match this order", 503);
  }
  if (first.attempt !== undefined && first.attempt !== 1) {
    throw new AppError(uncertainCode, "Seller production attempt counter is invalid", 503);
  }
  const secondPath = `${path}.retry-2.json`;
  try {
    await writeFile(secondPath, `${JSON.stringify({ ...identity, attempt: 2, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
    return 2;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let second;
    try { second = JSON.parse(await readFile(secondPath, "utf8")); } catch {
      throw new AppError(uncertainCode, "Second Seller production attempt record is invalid", 503);
    }
    if (second.attempt !== 2
      || Object.entries(identity).some(([key, value]) => JSON.stringify(second[key]) !== JSON.stringify(value))) {
      throw new AppError(uncertainCode, "Second Seller production attempt does not match this order", 503);
    }
    throw new AppError(uncertainCode, "Seller exhausted its two internal supplier attempts; do not charge Buyer again", 503);
  }
}

export async function withSellerOperationLock({ path, uncertainCode }, work) {
  const lockPath = `${path}.active`;
  const owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
      try { return await work(); } finally {
        let current;
        try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch { current = null; }
        if (current?.token === owner.token) await unlink(lockPath);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let current;
      try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch {
        throw new AppError(uncertainCode, "Seller production lock is invalid; do not start another supplier call", 503);
      }
      if (!Number.isSafeInteger(current.pid) || current.pid <= 0 || typeof current.token !== "string") {
        throw new AppError(uncertainCode, "Seller production lock is invalid; do not start another supplier call", 503);
      }
      try {
        process.kill(current.pid, 0);
        throw new AppError(uncertainCode, "Another Seller worker is already handling this supplier operation", 503);
      } catch (probeError) {
        if (probeError?.code !== "ESRCH") throw probeError;
      }
      try { await rename(lockPath, `${lockPath}.stale-${randomUUID()}`); } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new AppError(uncertainCode, "Could not exclusively claim Seller supplier operation", 503);
}

export async function callSellerProviderTwice({ path, identity, uncertainCode, beforeCall, call, finalize = (value) => value }) {
  return await withSellerOperationLock({ path, uncertainCode }, async () => {
    let priorError;
    for (let index = 0; index < 2; index += 1) {
    let attempt;
    try { attempt = await reserveSellerProviderAttempt({ path, identity, uncertainCode }); } catch (error) {
      if (priorError !== undefined && error.code === uncertainCode) {
        throw new AppError(uncertainCode, "Seller exhausted its two internal supplier attempts; do not charge Buyer again", 503,
          { cause: priorError.message });
      }
      throw error;
    }
    try {
      await beforeCall();
      return await finalize(await call(attempt));
    } catch (error) {
      if (error?.code === "production_cancelled_before_billable_step") throw error;
      priorError = error;
      if (attempt >= 2) {
        throw new AppError(uncertainCode, "Seller exhausted its two internal supplier attempts; do not charge Buyer again", 503,
          { cause: error.message });
      }
    }
    }
    throw priorError;
  });
}
