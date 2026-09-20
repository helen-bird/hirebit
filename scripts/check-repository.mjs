import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const tracked = execFileSync("git", ["ls-files", "--stage", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, oid, stage] = entry.slice(0, tab).split(" ");
    return { mode, oid, stage, file: entry.slice(tab + 1) };
  });

const forbiddenDirectories = /(^|\/)(\.buyer|\.seller|\.gobtcpay|\.hypit|\.demo|\.shared-model|\.validation|\.tools|\.pnpm-store|\.deck-assets|\.deck-build|\.codex-finalizer|node_modules|output)(\/|$)/;
const forbiddenExtensions = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const forbiddenFiles = new Set(["model.integration.json", "productions/hypit.runtime.json", "application_default_credentials.json"]);
const allowedEnvironmentExamples = new Set([".env.example", ".env.public-demo.example"]);
const findings = [];
const localSecrets = new Set();

// Compare against this operator's local credentials without logging any values.
for (const file of [".env", ".env.public-demo"]) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(name) && value.length >= 8) localSecrets.add(value);
  }
}
for (const file of [".buyer/api-token", ".buyer/public-demo-api-token", ".seller/api-token"]) {
  const path = join(root, file);
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (value.length >= 8) localSecrets.add(value);
  }
}
const merchantFile = join(root, ".seller/merchant-secrets.json");
if (existsSync(merchantFile)) {
  const value = JSON.parse(readFileSync(merchantFile, "utf8")).merchantApiKey;
  if (typeof value === "string" && value.length >= 8) localSecrets.add(value);
}

for (const { file, mode, oid, stage } of tracked) {
  const name = basename(file);
  if (stage !== "0" || mode === "120000") {
    findings.push(`${file}: unresolved index entry or symbolic link requires review`);
    continue;
  }
  if (mode === "160000") {
    if (file !== "vendor/hypit" || oid !== "e9c99ea552a8d5171f4d3605b3084aa39c9849e5") {
      findings.push(`${file}: unreviewed submodule revision`);
    }
    continue;
  }
  if (forbiddenDirectories.test(file) || forbiddenExtensions.test(file) || forbiddenFiles.has(file)
    || forbiddenFiles.has(name) || /^cloudflare\/.*\.zip$/.test(file)) {
    findings.push(`${file}: forbidden secret/runtime path`);
    continue;
  }
  if (name.startsWith(".env") && !allowedEnvironmentExamples.has(file)) {
    findings.push(`${file}: environment file is not an approved example`);
    continue;
  }

  // Read the Git object being committed, not the possibly different working file.
  // Include large files and binary metadata; never silently skip an asset.
  const data = execFileSync("git", ["cat-file", "blob", oid], { maxBuffer: 100 * 1024 * 1024 });
  for (const secret of localSecrets) {
    if (data.includes(Buffer.from(secret))) {
      findings.push(`${file}: contains a locally configured credential`);
      break;
    }
  }
  const text = data.toString("utf8");
  const patterns = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private key"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key"],
    [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "Google API key"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "GitHub token"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "GitHub fine-grained token"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "Slack token"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "provider API key"],
    [/"type"\s*:\s*"service_account"/g, "service account credentials"],
    [/"refresh_token"\s*:\s*"[A-Za-z0-9._\/-]{20,}"/g, "OAuth refresh token"],
    [new RegExp("\\/" + "Users" + "\\/(?!<)[A-Za-z0-9._-]+\\/", "g"), "personal absolute path"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) findings.push(`${file}: possible ${label}`);
  }
}

if (findings.length) {
  console.error("Repository safety check failed:\n" + findings.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Repository safety check passed for ${tracked.length} staged entries, including local credential comparisons.`);
