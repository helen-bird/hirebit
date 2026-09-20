import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { AppError } from "./errors.mjs";

function inside(base, target) {
  return target === base || target.startsWith(`${base}${sep}`);
}

export async function resolveRegularFile(basePath, relativePath, notFoundCode = "file_not_found") {
  const base = resolve(basePath);
  const candidate = resolve(base, relativePath);
  if (!inside(base, candidate)) throw new AppError(notFoundCode, "File not found", 404);
  try {
    const linkInfo = await lstat(candidate);
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) throw new AppError(notFoundCode, "File not found", 404);
    const [realBase, realCandidate] = await Promise.all([realpath(base), realpath(candidate)]);
    if (!inside(realBase, realCandidate)) throw new AppError(notFoundCode, "File not found", 404);
    const info = await stat(realCandidate);
    if (!info.isFile()) throw new AppError(notFoundCode, "File not found", 404);
    const handle = await open(realCandidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      await handle.close();
      throw new AppError(notFoundCode, "File changed while it was being opened", 404);
    }
    return { path: realCandidate, size: opened.size, handle };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
      throw new AppError(notFoundCode, "File not found", 404);
    }
    throw error;
  }
}

export function streamRegularFile(response, file) {
  // Keep FileHandle and stream ownership aligned. Passing handle.fd to fs.createReadStream
  // with autoClose=true closes the descriptor behind FileHandle's back, which can make
  // Node 24 attempt a second close during FileHandle garbage collection and terminate.
  const stream = file.handle.createReadStream({ autoClose: true });
  stream.once("error", (error) => response.destroy(error));
  stream.pipe(response);
}
