import { resolvePublicDemoAccessToken } from "../src/security.mjs";

const origin = process.env.PUBLIC_DEMO_ORIGIN;
if (typeof origin !== "string" || origin === "") {
  throw new Error("PUBLIC_DEMO_ORIGIN is required in .env.public-demo");
}
const parsed = new URL(origin);
if (parsed.protocol !== "https:" || parsed.origin !== origin) {
  throw new Error("PUBLIC_DEMO_ORIGIN must be an exact HTTPS origin without a path");
}
const token = resolvePublicDemoAccessToken({
  enabled: true,
  paymentMode: "demo",
  value: process.env.PUBLIC_DEMO_ACCESS_TOKEN,
}).value;
console.log(`${origin}/console/#access=${encodeURIComponent(token)}`);
