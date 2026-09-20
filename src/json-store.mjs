import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const INITIAL_STATE = Object.freeze({
  version: 1,
  quotes: {},
  orders: {},
  idempotency: {},
  audit: [],
});

function clone(value) {
  return structuredClone(value);
}

export class JsonStore {
  constructor(file, { initialState = INITIAL_STATE } = {}) {
    this.file = file;
    this.initialState = clone(initialState);
    this.state = clone(this.initialState);
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.file), 0o700);
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.state = clone(this.initialState);
      await this.#persist();
    }
  }

  snapshot() {
    return clone(this.state);
  }

  async transaction(mutator) {
    const execute = async () => {
      const draft = clone(this.state);
      const result = await mutator(draft);
      await this.#persist(draft);
      this.state = draft;
      return clone(result);
    };
    const operation = this.queue.then(execute, execute);
    this.queue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async #persist(state = this.state) {
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireProcessLock(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const payload = `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      let released = false;
      return {
        file,
        async release() {
          if (released) return;
          released = true;
          await handle.close();
          await unlink(file).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(await readFile(file, "utf8")); } catch { owner = null; }
      if (processExists(Number(owner?.pid))) {
        const conflict = new Error(`Another process (pid ${owner.pid}) already owns ${file}`);
        conflict.code = "process_lock_held";
        throw conflict;
      }
      await unlink(file).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  const error = new Error(`Could not acquire process lock: ${file}`);
  error.code = "process_lock_unavailable";
  throw error;
}
