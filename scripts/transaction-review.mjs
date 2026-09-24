import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { transactionReview } from "../src/transaction-review.mjs";

const root = resolve(import.meta.dirname, "..");
const mode = process.argv[2];
if (!["demo", "public-demo", "mainnet"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/transaction-review.mjs demo|public-demo|mainnet");
}

const buyerDir = resolve(root, process.env.BUYER_DATA_DIR ?? ".buyer");
const sellerDir = resolve(root, process.env.SELLER_DATA_DIR ?? ".seller");
const files = mode === "public-demo" ? {
  buyer: resolve(buyerDir, "public-demo-state.json"),
  intake: resolve(buyerDir, "public-demo-intake-state.json"),
  seller: resolve(sellerDir, "public-demo-state.json"),
} : mode === "demo" ? {
  buyer: resolve(buyerDir, "demo-state.json"),
  intake: resolve(buyerDir, "demo-intake-state.json"),
  seller: resolve(sellerDir, "demo-state.json"),
} : {
  buyer: resolve(buyerDir, "state.json"),
  intake: resolve(buyerDir, "intake-state.json"),
  seller: resolve(sellerDir, "state.json"),
};
const [buyer, intake, seller] = await Promise.all(Object.values(files).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const report = transactionReview({ buyer, intake, seller });
console.log(JSON.stringify({ mode, ...report }, null, 2));
