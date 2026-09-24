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
  const recoveryPath = `${lockPath}.recovery`;
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
      // A separate exclusive recovery claim prevents two workers from moving
      // the same stale lock, or one worker from moving a newer live lock.
      let recoveryOwned = false;
      try {
        await writeFile(recoveryPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
        recoveryOwned = true;
      } catch (recoveryError) {
        if (recoveryError?.code !== "EEXIST") throw recoveryError;
        throw new AppError(uncertainCode, "Another Seller worker is recovering this supplier operation", 503);
      }
      try {
        let latest;
        try { latest = JSON.parse(await readFile(lockPath, "utf8")); } catch (readError) {
          if (readError?.code !== "ENOENT") {
            throw new AppError(uncertainCode, "Seller production lock changed during recovery", 503);
          }
        }
        if (latest?.token === current.token) {
          try { await rename(lockPath, `${lockPath}.stale-${randomUUID()}`); } catch (renameError) {
            if (renameError?.code !== "ENOENT") throw renameError;
          }
        }
      } finally {
        if (recoveryOwned) await unlink(recoveryPath);
      }
    }
  }
  throw new AppError(uncertainCode, "Could not exclusively claim Seller supplier operation", 503);
}

export async function callSellerProviderTwice({ path, identity, uncertainCode, beforeCall, call, finalize = (value) => value }) {
  return await withSellerOperationLock({ path, uncertainCode }, async () => {
    const returnedPath = `${path}.provider-returned.json`;
    let returned;
    try { returned = JSON.parse(await readFile(returnedPath, "utf8")); } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new AppError(uncertainCode, "Seller supplier result marker is invalid", 503);
      }
    }
    if (returned !== undefined) {
      throw new AppError(uncertainCode, "Supplier already returned a result; reconcile Seller output before another paid call", 503);
    }
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
    let value;
    try {
      await beforeCall();
      value = await call(attempt);
    } catch (error) {
      if (error?.code === "production_cancelled_before_billable_step") throw error;
      priorError = error;
      if (attempt >= 2) {
        throw new AppError(uncertainCode, "Seller exhausted its two internal supplier attempts; do not charge Buyer again", 503,
          { cause: error.message });
      }
      continue;
    }
    // Once a provider has responded, a validation or disk-write failure in
    // finalize must not be interpreted as permission to call it again.
    await writeFile(returnedPath, `${JSON.stringify({ ...identity, attempt, returnedAt: new Date().toISOString() })}\n`,
      { mode: 0o600, flag: "wx" });
    return await finalize(value);
    }
    throw priorError;
  });
}
