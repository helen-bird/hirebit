import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "./errors.mjs";

const MARKER = "cancellation-request.json";

export async function markProductionCancellation(jobDir, orderId) {
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const path = join(jobDir, MARKER);
  const payload = { orderId, requestedAt: new Date().toISOString() };
  try {
    await writeFile(path, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const prior = JSON.parse(await readFile(path, "utf8"));
    if (prior.orderId !== orderId) {
      throw new AppError("production_cancellation_mismatch", "Production cancellation belongs to a different order", 503);
    }
  }
}

export async function assertProductionMaySpend(jobDir, { orderId = null, spendAllowed = null } = {}) {
  if (spendAllowed !== null && await spendAllowed(orderId) !== true) {
    throw new AppError(
      "production_cancelled_before_billable_step",
      "The order no longer authorizes paid production",
      409,
    );
  }
  try {
    await access(join(jobDir, MARKER));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new AppError(
    "production_cancelled_before_billable_step",
    "The buyer requested cancellation; no further paid production may begin",
    409,
  );
}
