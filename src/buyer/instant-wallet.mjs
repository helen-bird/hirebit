import { createHash, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { address, networks, Psbt, Transaction } from "bitcoinjs-lib";

import { AppError } from "../errors.mjs";
import { safeServiceBaseUrl } from "../security.mjs";

function unwrap(payload) {
  const result = payload?.result;
  if (result?.$case === "failure") {
    const failure = result.failure ?? {};
    throw new AppError(
      "gobtcpay_failure",
      failure.message ?? "GoBTC Pay rejected the request",
      502,
      { code: failure.code, type: failure.data?.type, traceId: payload?.meta?.traceId },
    );
  }
  if (result?.$case === "success") return result.success;
  return payload;
}

function varInt(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("varInt requires a non-negative safe integer");
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const result = Buffer.alloc(3);
    result[0] = 0xfd;
    result.writeUInt16LE(value, 1);
    return result;
  }
  if (value <= 0xffffffff) {
    const result = Buffer.alloc(5);
    result[0] = 0xfe;
    result.writeUInt32LE(value, 1);
    return result;
  }
  const result = Buffer.alloc(9);
  result[0] = 0xff;
  result.writeBigUInt64LE(BigInt(value), 1);
  return result;
}

export function bitcoinMessageHash(message) {
  const prefix = Buffer.from("\u0018Bitcoin Signed Message:\n", "utf8");
  const content = Buffer.from(message, "utf8");
  const payload = Buffer.concat([prefix, varInt(content.length), content]);
  const first = createHash("sha256").update(payload).digest();
  return createHash("sha256").update(first).digest();
}

export function signChallenge(message, privateKey) {
  return Buffer.from(secp256k1.sign(bitcoinMessageHash(message), privateKey, { prehash: false })).toString("hex");
}

function sats(value, field) {
  try {
    const result = BigInt(value);
    if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("out of range");
    return result;
  } catch {
    throw new AppError("psbt_intent_mismatch", `${field} is not a valid satoshi amount`, 502);
  }
}

function number(value, field) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "" || value === null) {
    throw new AppError("psbt_intent_mismatch", `${field} is not a valid number`, 502);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new AppError("psbt_intent_mismatch", `${field} is not a valid number`, 502);
  }
  return result;
}

function varIntSize(value) {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

function minimumVirtualSize(psbt) {
  const outputBytes = psbt.txOutputs.reduce((total, output) => (
    total + 8 + varIntSize(output.script.length) + output.script.length
  ), 0);
  const baseBytes = 4 + varIntSize(psbt.inputCount) + (psbt.inputCount * 41)
    + varIntSize(psbt.txOutputs.length) + outputBytes + 4;
  return Math.max(1, baseBytes);
}

function outputScript(value, field) {
  try {
    return Buffer.from(address.toOutputScript(value, networks.bitcoin));
  } catch {
    throw new AppError("psbt_intent_mismatch", `${field} is not a valid Bitcoin mainnet address`, 502);
  }
}

function timestamp(value) {
  if (/^\d+$/u.test(value)) {
    const raw = Number(value);
    return raw < 10_000_000_000 ? raw * 1000 : raw;
  }
  return Date.parse(value);
}

function validateChallenge(message, publicKeyHex, now) {
  const [purpose, ...pairs] = message.split(";");
  if (purpose !== "instant-go login") {
    throw new AppError("gobtcpay_challenge_invalid", "GoBTC auth challenge has an unexpected purpose", 502);
  }
  const fields = Object.fromEntries(pairs.map((item) => {
    const index = item.indexOf("=");
    return index > 0 ? [item.slice(0, index), item.slice(index + 1)] : [item, ""];
  }));
  if (fields.pubkey?.toLowerCase() !== publicKeyHex.toLowerCase()) {
    throw new AppError("gobtcpay_challenge_invalid", "GoBTC auth challenge is for a different payer key", 502);
  }
  if (typeof fields.nonce !== "string" || fields.nonce.length < 8 || fields.nonce.length > 256) {
    throw new AppError("gobtcpay_challenge_invalid", "GoBTC auth challenge nonce is invalid", 502);
  }
  const issuedAt = timestamp(fields.issuedAt ?? "");
  const expiresAt = timestamp(fields.expiresAt ?? "");
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now + 60_000 || issuedAt < now - (15 * 60_000)
    || expiresAt <= now || expiresAt > now + (15 * 60_000)) {
    throw new AppError("gobtcpay_challenge_invalid", "GoBTC auth challenge is expired or outside the allowed time window", 502);
  }
}

function requireSummaryMatch(summary, expected, actual, field) {
  if (summary?.[field] === undefined || String(summary[field]) !== String(expected)) {
    throw new AppError("psbt_summary_mismatch", `GoBTC summary ${field} does not match the authorized payment`, 502, {
      expected: String(expected),
      received: summary?.[field] === undefined ? null : String(summary[field]),
    });
  }
  if (actual !== undefined && String(summary[field]) !== String(actual)) {
    throw new AppError("psbt_summary_mismatch", `GoBTC summary ${field} does not match the decoded PSBT`, 502);
  }
}

export async function loadPayerIdentity(keyFile) {
  let pem;
  try {
    pem = await readFile(keyFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AppError("payer_key_missing", `Buyer payer key is missing: ${keyFile}`, 503);
    }
    throw error;
  }
  let jwk;
  try {
    jwk = createPrivateKey(pem).export({ format: "jwk" });
  } catch {
    throw new AppError("payer_key_invalid", "Buyer payer key is not a valid EC private key", 503);
  }
  if (jwk.crv !== "secp256k1" || typeof jwk.d !== "string") {
    throw new AppError("payer_key_invalid", "Buyer payer key must be a secp256k1 private key", 503);
  }
  const privateKey = Buffer.from(jwk.d, "base64url");
  if (privateKey.length !== 32) throw new AppError("payer_key_invalid", "Buyer private key must be 32 bytes", 503);
  const publicKey = Buffer.from(secp256k1.getPublicKey(privateKey, true));
  return { privateKey, publicKey, publicKeyHex: publicKey.toString("hex") };
}

export class InstantWalletClient {
  constructor({
    baseUrl,
    keyFile,
    expectedPublicKeyHex,
    multisigAddress,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    clock = Date.now,
    maxFeeSats = 500,
    maxFeeRateSatVb = 50,
  }) {
    this.baseUrl = safeServiceBaseUrl(baseUrl, "GoBTC Pay base URL");
    this.keyFile = keyFile;
    this.expectedPublicKeyHex = expectedPublicKeyHex;
    this.multisigAddress = multisigAddress;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.maxFeeSats = maxFeeSats;
    this.maxFeeRateSatVb = maxFeeRateSatVb;
    this.identityPromise = undefined;
    this.token = undefined;
  }

  async readiness() {
    try {
      const identity = await this.#identity();
      return {
        configured: typeof this.multisigAddress === "string" && this.multisigAddress.startsWith("bc1"),
        payerKeyConfigured: true,
        publicKeyHex: identity.publicKeyHex,
        walletRegistration: this.multisigAddress ? "configured" : "pending",
        multisigAddress: this.multisigAddress ?? null,
        baseUrl: this.baseUrl,
      };
    } catch (error) {
      return {
        configured: false,
        payerKeyConfigured: false,
        walletRegistration: "pending",
        multisigAddress: null,
        baseUrl: this.baseUrl,
        error: error.code ?? "payer_key_invalid",
      };
    }
  }

  async preparePayment({ paymentId, amountSats, recipientAddress }) {
    if (typeof this.multisigAddress !== "string" || !this.multisigAddress.startsWith("bc1")) {
      throw new AppError(
        "wallet_not_registered",
        "Buyer wallet registration is not configured; wait for /instant/wallet/register to succeed",
        503,
      );
    }
    if (typeof paymentId !== "string" || paymentId === "") {
      throw new AppError("invalid_payment_id", "Seller order does not contain a paymentId");
    }
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      throw new AppError("invalid_payment_intent", "Authorized payment amount must be a positive integer");
    }
    if (typeof recipientAddress !== "string" || recipientAddress === "") {
      throw new AppError("invalid_payment_intent", "Authorized payment recipient is required");
    }
    const token = await this.#jwt();
    const built = await this.#post(
      "/instant/psbt/build-transaction-to-sign-payment",
      { paymentId },
      token,
    );
    if (typeof built?.jobId !== "string" || typeof built?.psbtBase64 !== "string") {
      throw new AppError("gobtcpay_invalid_response", "GoBTC Pay did not return a signing job and PSBT", 502);
    }
    const validation = await this.#validatePsbt(built.psbtBase64, built.summary, {
      amountSats,
      recipientAddress,
    });
    return {
      paymentId,
      jobId: built.jobId,
      signedPsbtBase64: await this.#signPsbt(built.psbtBase64),
      summary: structuredClone(built.summary),
      validation,
      preparedAt: new Date(this.clock()).toISOString(),
    };
  }

  async submitPrepared({ paymentId, jobId, signedPsbtBase64 }) {
    const token = await this.#jwt();
    const submitted = await this.#post(
      "/instant/transaction/pay-and-sign-pre-authorized-transaction",
      { paymentId, jobId, signedPsbtBase64 },
      token,
    );
    if (typeof submitted?.paymentTxId !== "string" || submitted.paymentTxId === "") {
      throw new AppError("gobtcpay_invalid_response", "GoBTC Pay did not return a payment receipt", 502);
    }
    return {
      instantReceiptId: submitted.paymentTxId,
      submittedAt: new Date(this.clock()).toISOString(),
    };
  }

  async #identity() {
    this.identityPromise ??= loadPayerIdentity(this.keyFile).then((identity) => {
      if (this.expectedPublicKeyHex && identity.publicKeyHex !== this.expectedPublicKeyHex.toLowerCase()) {
        throw new AppError("payer_key_mismatch", "Buyer payer key does not match the configured public key", 503);
      }
      return identity;
    });
    return await this.identityPromise;
  }

  async #jwt() {
    if (this.token !== undefined && this.token.expiresAt > this.clock() + 15_000) return this.token.value;
    const identity = await this.#identity();
    const challenge = await this.#post("/instant/auth/get-data-to-sign", {
      userPubKeyHex: identity.publicKeyHex,
    });
    if (typeof challenge?.challengeId !== "string" || typeof challenge?.messageToSign !== "string") {
      throw new AppError("gobtcpay_invalid_response", "GoBTC Pay did not return a valid auth challenge", 502);
    }
    validateChallenge(challenge.messageToSign, identity.publicKeyHex, this.clock());
    const auth = await this.#post("/instant/auth/get-jwt", {
      challengeId: challenge.challengeId,
      signature: signChallenge(challenge.messageToSign, identity.privateKey),
    });
    const value = auth?.jwt ?? auth?.accessToken ?? auth?.token;
    if (typeof value !== "string" || value === "") {
      throw new AppError("gobtcpay_invalid_response", "GoBTC Pay did not return an instant JWT", 502);
    }
    this.token = { value, expiresAt: this.clock() + (9 * 60 * 1000) };
    return value;
  }

  async #signPsbt(psbtBase64) {
    const identity = await this.#identity();
    let psbt;
    try {
      psbt = Psbt.fromBase64(psbtBase64);
      for (let index = 0; index < psbt.inputCount; index += 1) {
        const sighashType = psbt.data.inputs[index].sighashType;
        if (sighashType !== undefined && sighashType !== Transaction.SIGHASH_ALL) {
          throw new Error(`input ${index} requests unsupported sighash type ${sighashType}`);
        }
      }
      psbt.signAllInputs({
        publicKey: identity.publicKey,
        sign: (hash) => Buffer.from(secp256k1.sign(hash, identity.privateKey, { prehash: false })),
      });
      for (let index = 0; index < psbt.inputCount; index += 1) {
        const signed = psbt.data.inputs[index].partialSig?.some((item) => Buffer.from(item.pubkey).equals(identity.publicKey));
        if (signed !== true) throw new Error(`input ${index} was not signed by the configured Buyer key`);
      }
      return psbt.toBase64();
    } catch (error) {
      throw new AppError("psbt_signing_failed", "Buyer could not sign the GoBTC payment PSBT", 502, {
        cause: String(error?.message ?? error),
      });
    }
  }

  async #validatePsbt(psbtBase64, summary, { amountSats, recipientAddress }) {
    if (summary === null || typeof summary !== "object") {
      throw new AppError("psbt_summary_missing", "GoBTC Pay did not return the required transaction summary", 502);
    }
    let psbt;
    try {
      psbt = Psbt.fromBase64(psbtBase64);
    } catch {
      throw new AppError("psbt_invalid", "GoBTC Pay returned an invalid PSBT", 502);
    }
    const identity = await this.#identity();
    const walletScript = outputScript(this.multisigAddress, "Configured multisig address");
    const recipientScript = outputScript(recipientAddress, "Seller recipient address");
    if (walletScript.equals(recipientScript)) {
      throw new AppError("psbt_intent_mismatch", "Seller recipient must differ from the Buyer wallet", 502);
    }

    let inputTotal = 0n;
    for (let index = 0; index < psbt.inputCount; index += 1) {
      const input = psbt.data.inputs[index];
      let previousOutput;
      if (input.witnessUtxo !== undefined) {
        previousOutput = input.witnessUtxo;
      } else if (input.nonWitnessUtxo !== undefined) {
        const transaction = Transaction.fromBuffer(input.nonWitnessUtxo);
        previousOutput = transaction.outs[psbt.txInputs[index].index];
      }
      if (previousOutput === undefined || !Buffer.from(previousOutput.script).equals(walletScript)) {
        throw new AppError("psbt_input_not_owned", "PSBT contains an input that is not from the configured Buyer wallet", 502, { input: index });
      }
      if (!psbt.inputHasPubkey(index, identity.publicKey)) {
        throw new AppError("psbt_input_not_signable", "PSBT input does not commit to the configured Buyer key", 502, { input: index });
      }
      inputTotal += sats(previousOutput.value, `input ${index} value`);
    }
    if (psbt.inputCount === 0) throw new AppError("psbt_invalid", "PSBT contains no inputs", 502);

    const expectedAmount = BigInt(amountSats);
    let recipientCount = 0;
    let recipientTotal = 0n;
    let changeTotal = 0n;
    let outputTotal = 0n;
    for (const [index, output] of psbt.txOutputs.entries()) {
      const value = sats(output.value, `output ${index} value`);
      if (value <= 0n) throw new AppError("psbt_intent_mismatch", "PSBT contains a zero-value output", 502, { output: index });
      outputTotal += value;
      if (Buffer.from(output.script).equals(recipientScript)) {
        recipientCount += 1;
        recipientTotal += value;
      } else if (Buffer.from(output.script).equals(walletScript)) {
        changeTotal += value;
      } else {
        throw new AppError("psbt_unexpected_output", "PSBT contains an unauthorized output", 502, { output: index });
      }
    }
    if (recipientCount !== 1 || recipientTotal !== expectedAmount) {
      throw new AppError("psbt_intent_mismatch", "PSBT recipient or amount differs from the authorized order", 502);
    }
    const fee = inputTotal - outputTotal;
    if (fee < 0n || fee > BigInt(this.maxFeeSats)) {
      throw new AppError("psbt_fee_exceeded", "PSBT fee exceeds Buyer policy", 403, {
        feeSats: fee.toString(),
        maxFeeSats: this.maxFeeSats,
      });
    }
    const feeRate = number(summary.feeRateSatVb, "summary.feeRateSatVb");
    const minimumVsize = minimumVirtualSize(psbt);
    const independentlyBoundedFeeRate = Number(fee) / minimumVsize;
    if (feeRate > this.maxFeeRateSatVb || independentlyBoundedFeeRate > this.maxFeeRateSatVb) {
      throw new AppError("psbt_fee_rate_exceeded", "PSBT fee rate exceeds Buyer policy", 403, {
        feeRateSatVb: feeRate,
        independentlyBoundedFeeRateSatVb: independentlyBoundedFeeRate,
        minimumVsize,
        maxFeeRateSatVb: this.maxFeeRateSatVb,
      });
    }
    requireSummaryMatch(summary, this.multisigAddress, undefined, "fromAddress");
    requireSummaryMatch(summary, recipientAddress, undefined, "toAddress");
    requireSummaryMatch(summary, amountSats, recipientTotal, "amountSats");
    requireSummaryMatch(summary, fee.toString(), fee, "feeSats");
    requireSummaryMatch(summary, changeTotal.toString(), changeTotal, "changeSats");
    requireSummaryMatch(summary, psbt.inputCount, psbt.inputCount, "inputCount");
    return {
      recipientAddress,
      amountSats,
      feeSats: Number(fee),
      feeRateSatVb: feeRate,
      independentlyBoundedFeeRateSatVb: independentlyBoundedFeeRate,
      changeSats: Number(changeTotal),
      inputCount: psbt.inputCount,
      outputCount: psbt.txOutputs.length,
    };
  }

  async #post(path, body, bearer = undefined) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new AppError("gobtcpay_invalid_response", "GoBTC Pay returned non-JSON data", 502, {
          httpStatus: response.status,
        });
      }
      const value = unwrap(payload);
      if (!response.ok) {
        throw new AppError("gobtcpay_http_error", "GoBTC Pay request failed", 502, {
          httpStatus: response.status,
          payload: value,
        });
      }
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error?.name === "AbortError" ? "GoBTC Pay request timed out" : "GoBTC Pay is unavailable";
      throw new AppError("gobtcpay_unavailable", message, 502, { cause: String(error?.message ?? error) });
    } finally {
      clearTimeout(timeout);
    }
  }
}
