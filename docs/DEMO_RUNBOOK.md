# Three-minute demo runbook

1. Start on `/ready`. In mainnet mode, show the real wallet registration and Seller readiness. While GoBTC remains unavailable, use the explicit `npm run demo:seller` / `npm run demo:buyer` fallback and show `mode: demo_simulated`, `simulated: true`, `mainnet: false` before continuing.
2. Submit one specific customer delegation with objective, subject, hard sats budget, deadline and authorization mode.
3. Show the extracted versioned Mandate and approve its exact scope hash. If a hard fact is missing, answer the required clarification instead of skipping it.
4. Show multiple eligible/rejected packages, their price/time trade-offs and the selected rationale. For confirm-before-purchase, perform the separate purchase confirmation.
5. In mainnet mode, show the spend reservation including the maximum network-fee reserve, then the validated payment recipient/amount. In Demo mode, show the zero-fee simulated intent and the non-payable demo recipient marker. Never display a private key or API token.
6. In mainnet mode, wait for GoBTC `paid`. In Demo mode, show that the authenticated local submission creates a `demo_receipt_` and only then unlocks Hypit. The Build must consume the commission; the zero-cost smoke video is not a substitute.
7. Open the validated delivered video and campaign package. In Demo mode, explicitly show `DEMO ONLY`, zero network fee, pending settlement and no txid; never call the simulated receipt an instant GoBTC receipt or on-chain proof.
8. End with the campaign testing plan and the concrete next action enabled by the purchased artifact.

If mainnet funding, GoBTC infrastructure, provider credentials or final settlement is unavailable, say exactly which step is simulated or pending. Do not present the smoke Build, instant receipt or a mocked payment as mainnet proof.
