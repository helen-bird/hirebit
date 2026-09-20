import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { safeServiceBaseUrl } from "../src/security.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = resolve(rootDir, process.env.SELLER_DATA_DIR ?? ".seller");
const baseUrl = safeServiceBaseUrl(
  process.env.GOBTCPAY_BASE_URL ?? "https://api.gobtcpay.com/public/api/v1.2",
  "GoBTC Pay base URL",
);
const walletFile = resolve(dataDir, "merchant-wallet.json");
const onboardingFile = resolve(dataDir, "merchant-onboarding.json");
const secretFile = resolve(dataDir, "merchant-secrets.json");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function save(file, value) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function unwrap(payload) {
  if (payload?.result?.$case === "failure") {
    const failure = payload.result.failure ?? {};
    throw new Error(`${failure.code ?? "GoBTC failure"}: ${failure.message ?? "request rejected"}`);
  }
  return payload?.result?.$case === "success" ? payload.result.success : payload;
}

async function post(path, body, token = undefined) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`GoBTC returned non-JSON HTTP ${response.status}`); }
  const value = unwrap(payload);
  if (!response.ok) throw new Error(`GoBTC HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function createKey() {
  try {
    await readFile(walletFile);
    throw new Error(`Refusing to overwrite existing merchant wallet: ${walletFile}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const mnemonic = generateMnemonic(wordlist, 128);
  const master = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const account = master.derive("m/84'/0'/0'");
  const wallet = {
    createdAt: new Date().toISOString(),
    mnemonic,
    derivationPath: "m/84'/0'/0'",
    xpub: account.publicExtendedKey,
    masterFingerprint: master.fingerprint.toString(16).padStart(8, "0"),
  };
  await save(walletFile, wallet);
  console.log(`Merchant wallet generated and stored with mode 0600 at ${walletFile}`);
  console.log("Keep this file secret and backed up. It is separate from the buyer instant-wallet key.");
}

async function register() {
  await readJson(walletFile);
  const email = required("MERCHANT_EMAIL");
  const displayName = required("MERCHANT_DISPLAY_NAME");
  const merchantName = process.env.MERCHANT_NAME ?? `${displayName} Video Seller`;
  const password = process.env.MERCHANT_PASSWORD ?? randomBytes(24).toString("base64url");
  const result = await post("/merchant/auth/register", { email, password, displayName, merchantName });
  await save(onboardingFile, {
    registeredAt: new Date().toISOString(),
    email,
    displayName,
    merchantName,
    userId: result.userId,
    status: result.status,
    password,
  });
  console.log(`Merchant registered. Credentials are stored with mode 0600 at ${onboardingFile}`);
  console.log(`Enter the six-digit email code within 30 minutes and run: MERCHANT_CODE=...... npm run merchant:verify-and-link`);
}

async function verifyAndLink() {
  const wallet = await readJson(walletFile);
  const onboarding = await readJson(onboardingFile);
  const verified = await post("/merchant/auth/verify-email", {
    email: onboarding.email,
    code: required("MERCHANT_CODE"),
  });
  const accessToken = verified.tokens?.accessToken;
  if (typeof accessToken !== "string") throw new Error("Verification response did not include an access token");
  await post("/merchant/auth/xpub/link-authorized", {
    xpub: wallet.xpub,
    derivationPath: wallet.derivationPath,
    masterFingerprint: wallet.masterFingerprint,
    label: "Internal Hypit video seller",
  }, accessToken);
  const key = await post("/merchant/api-key/create", {
    label: "Internal Hypit video seller",
    type: "secret"
  }, accessToken);
  const merchantApiKey = key.apiKey?.secret;
  if (typeof merchantApiKey !== "string" || !merchantApiKey.startsWith("sk_live_")) {
    throw new Error("API-key response did not include the one-time sk_live_ secret");
  }
  await save(secretFile, {
    createdAt: new Date().toISOString(),
    merchantApiKey,
    merchantId: verified.memberships?.[0]?.merchantId,
    apiKeyPrefix: key.apiKey?.prefix,
  });
  await save(onboardingFile, { ...onboarding, status: "active", linkedAt: new Date().toISOString() });
  console.log(`Merchant verified, xpub linked, and account-wide API key stored at ${secretFile}`);
  console.log("The Seller will read this file automatically. The secret was not printed.");
}

const action = process.argv[2];
if (action === "key") await createKey();
else if (action === "register") await register();
else if (action === "verify-and-link") await verifyAndLink();
else throw new Error("Usage: node scripts/merchant-onboard.mjs key|register|verify-and-link");
