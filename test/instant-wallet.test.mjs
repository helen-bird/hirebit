import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { payments, Psbt } from "bitcoinjs-lib";

import {
  bitcoinMessageHash,
  InstantWalletClient,
  loadPayerIdentity,
  signChallenge,
} from "../src/buyer/instant-wallet.mjs";

async function identityFixture() {
  const directory = await mkdtemp(join(tmpdir(), "payer-key-test-"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const keyFile = join(directory, "payer-key.pem");
  await writeFile(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return { keyFile, identity: await loadPayerIdentity(keyFile) };
}

function success(value) {
  return new Response(JSON.stringify({ result: { $case: "success", success: value } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("challenge signature verifies against the payer public key", async () => {
  const { identity } = await identityFixture();
  const message = "GoBTC challenge: test-only";
  const signature = Buffer.from(signChallenge(message, identity.privateKey), "hex");
  assert.equal(signature.length, 64);
  assert.equal(secp256k1.verify(signature, bitcoinMessageHash(message), identity.publicKey, { prehash: false }), true);
});

test("wallet refuses payment before registration is configured", async () => {
  const { keyFile, identity } = await identityFixture();
  const wallet = new InstantWalletClient({
    baseUrl: "https://api.example.test",
    keyFile,
    expectedPublicKeyHex: identity.publicKeyHex,
    fetchImpl: async () => { throw new Error("network must not be called"); },
  });
  await assert.rejects(
    wallet.preparePayment({ paymentId: "payment-1", amountSats: 1_000, recipientAddress: "bc1qunused" }),
    (error) => error.code === "wallet_not_registered" && error.status === 503,
  );
});

test("wallet refuses to sign an auth challenge for a different payer key", async () => {
  const { keyFile, identity } = await identityFixture();
  const walletOutput = payments.p2wpkh({ pubkey: identity.publicKey });
  const recipientOutput = payments.p2wpkh({ pubkey: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true) });
  const wallet = new InstantWalletClient({
    baseUrl: "https://api.example.test",
    keyFile,
    expectedPublicKeyHex: identity.publicKeyHex,
    multisigAddress: walletOutput.address,
    clock: () => 1_800_000_000_000,
    fetchImpl: async () => success({
      challengeId: "challenge-1",
      messageToSign: `instant-go login;pubkey=${"02".padEnd(66, "0")};nonce=12345678;issuedAt=1800000000000;expiresAt=1800000600000`,
    }),
  });
  await assert.rejects(
    wallet.preparePayment({ paymentId: "payment-1", amountSats: 1_000, recipientAddress: recipientOutput.address }),
    (error) => error.code === "gobtcpay_challenge_invalid",
  );
});

test("wallet authenticates, signs every matching PSBT input, and preserves receipt semantics", async () => {
  const { keyFile, identity } = await identityFixture();
  const walletOutput = payments.p2wpkh({ pubkey: identity.publicKey });
  const recipientKey = secp256k1.utils.randomSecretKey();
  const recipientOutput = payments.p2wpkh({ pubkey: secp256k1.getPublicKey(recipientKey, true) });
  const psbt = new Psbt();
  psbt.addInput({
    hash: Buffer.alloc(32, 7),
    index: 0,
    witnessUtxo: { script: walletOutput.output, value: 10_000n },
  });
  psbt.addOutput({ script: recipientOutput.output, value: 9_000n });
  psbt.addOutput({ script: walletOutput.output, value: 500n });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/instant/auth/get-data-to-sign")) {
      return success({
        challengeId: "challenge-1",
        messageToSign: `instant-go login;pubkey=${identity.publicKeyHex};nonce=12345678;issuedAt=1800000000000;expiresAt=1800000600000`,
      });
    }
    if (url.endsWith("/instant/auth/get-jwt")) return success({ jwt: "jwt-1" });
    if (url.endsWith("/instant/psbt/build-transaction-to-sign-payment")) {
      return success({
        jobId: "job-1",
        psbtBase64: psbt.toBase64(),
        summary: {
          fromAddress: walletOutput.address,
          toAddress: recipientOutput.address,
          amountSats: "9000",
          feeRateSatVb: "2",
          feeSats: "500",
          changeSats: "500",
          inputCount: 1,
        },
      });
    }
    if (url.endsWith("/instant/transaction/pay-and-sign-pre-authorized-transaction")) {
      return success({ paymentTxId: "receipt-not-chain-txid" });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const wallet = new InstantWalletClient({
    baseUrl: "https://api.example.test",
    keyFile,
    expectedPublicKeyHex: identity.publicKeyHex,
    multisigAddress: walletOutput.address,
    fetchImpl,
    clock: () => 1_800_000_000_000,
  });
  const prepared = await wallet.preparePayment({
    paymentId: "payment-1",
    amountSats: 9_000,
    recipientAddress: recipientOutput.address,
  });
  const signed = Psbt.fromBase64(prepared.signedPsbtBase64);
  assert.equal(signed.data.inputs[0].partialSig.length, 1);
  const receipt = await wallet.submitPrepared(prepared);
  assert.deepEqual(receipt, {
    instantReceiptId: "receipt-not-chain-txid",
    submittedAt: "2027-01-15T08:00:00.000Z",
  });
  assert.equal(calls.filter((call) => call.url.endsWith("/instant/auth/get-data-to-sign")).length, 1);
  assert.equal(calls.at(-1).options.headers.authorization, "Bearer jwt-1");
});

test("wallet signs every input of a 2-of-3 P2WSH multisig PSBT", async () => {
  const { keyFile, identity } = await identityFixture();
  const otherKeys = [
    secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
    secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
  ];
  const witness = payments.p2ms({ m: 2, pubkeys: [identity.publicKey, ...otherKeys] });
  const walletOutput = payments.p2wsh({ redeem: witness });
  const recipientOutput = payments.p2wpkh({ pubkey: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true) });
  const psbt = new Psbt();
  for (const index of [0, 1]) {
    psbt.addInput({
      hash: Buffer.alloc(32, 20 + index),
      index: 0,
      witnessUtxo: { script: walletOutput.output, value: 10_000n },
      witnessScript: witness.output,
    });
  }
  psbt.addOutput({ script: recipientOutput.output, value: 18_000n });
  psbt.addOutput({ script: walletOutput.output, value: 1_000n });
  const fetchImpl = async (url) => {
    if (url.endsWith("/instant/auth/get-data-to-sign")) return success({
      challengeId: "challenge-multisig",
      messageToSign: `instant-go login;pubkey=${identity.publicKeyHex};nonce=12345678;issuedAt=1800000000000;expiresAt=1800000600000`,
    });
    if (url.endsWith("/instant/auth/get-jwt")) return success({ jwt: "jwt-multisig" });
    return success({
      jobId: "job-multisig",
      psbtBase64: psbt.toBase64(),
      summary: {
        fromAddress: walletOutput.address,
        toAddress: recipientOutput.address,
        amountSats: "18000",
        feeRateSatVb: "4",
        feeSats: "1000",
        changeSats: "1000",
        inputCount: 2,
      },
    });
  };
  const wallet = new InstantWalletClient({
    baseUrl: "https://api.example.test",
    keyFile,
    expectedPublicKeyHex: identity.publicKeyHex,
    multisigAddress: walletOutput.address,
    fetchImpl,
    clock: () => 1_800_000_000_000,
    maxFeeSats: 1500,
  });
  const prepared = await wallet.preparePayment({
    paymentId: "payment-multisig",
    amountSats: 18_000,
    recipientAddress: recipientOutput.address,
  });
  const signed = Psbt.fromBase64(prepared.signedPsbtBase64);
  assert.equal(signed.data.inputs.length, 2);
  assert.ok(signed.data.inputs.every((input) => input.partialSig?.some((item) => Buffer.from(item.pubkey).equals(identity.publicKey))));
  assert.ok(prepared.validation.independentlyBoundedFeeRateSatVb <= 50);
});

test("wallet refuses a PSBT with an output outside the authorized recipient and Buyer change", async () => {
  const { keyFile, identity } = await identityFixture();
  const walletOutput = payments.p2wpkh({ pubkey: identity.publicKey });
  const recipientOutput = payments.p2wpkh({ pubkey: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true) });
  const attackerOutput = payments.p2wpkh({ pubkey: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true) });
  const psbt = new Psbt();
  psbt.addInput({
    hash: Buffer.alloc(32, 8),
    index: 0,
    witnessUtxo: { script: walletOutput.output, value: 10_000n },
  });
  psbt.addOutput({ script: recipientOutput.output, value: 9_000n });
  psbt.addOutput({ script: attackerOutput.output, value: 500n });
  const fetchImpl = async (url) => {
    if (url.endsWith("/instant/auth/get-data-to-sign")) {
      return success({
        challengeId: "challenge-1",
        messageToSign: `instant-go login;pubkey=${identity.publicKeyHex};nonce=12345678;issuedAt=1800000000000;expiresAt=1800000600000`,
      });
    }
    if (url.endsWith("/instant/auth/get-jwt")) return success({ jwt: "jwt-1" });
    return success({
      jobId: "job-1",
      psbtBase64: psbt.toBase64(),
      summary: {
        fromAddress: walletOutput.address,
        toAddress: recipientOutput.address,
        amountSats: "9000",
        feeRateSatVb: "2",
        feeSats: "500",
        changeSats: "500",
        inputCount: 1,
      },
    });
  };
  const wallet = new InstantWalletClient({
    baseUrl: "https://api.example.test",
    keyFile,
    expectedPublicKeyHex: identity.publicKeyHex,
    multisigAddress: walletOutput.address,
    fetchImpl,
    clock: () => 1_800_000_000_000,
  });
  await assert.rejects(
    wallet.preparePayment({ paymentId: "payment-1", amountSats: 9_000, recipientAddress: recipientOutput.address }),
    (error) => error.code === "psbt_unexpected_output",
  );
});

test("payer identity stays stable when its generated key file is reloaded", async () => {
  const { keyFile, identity } = await identityFixture();
  const reloaded = await loadPayerIdentity(keyFile);
  assert.equal(reloaded.publicKeyHex, identity.publicKeyHex);
});
