# Three-minute demo runbook

1. Start on `/ready`. State once that the organizers confirmed the GoBTC outage and approved clearly disclosed simulated responses for Demo Day. Use the explicit `npm run demo:seller` / `npm run demo:buyer` fallback and show `mode: demo_simulated`, `simulated: true`, `mainnet: false` before continuing. Do not imply that wallet registration or merchant onboarding succeeded.
2. Submit one specific customer delegation with objective, subject, hard sats budget, deadline and authorization mode.
3. Show the extracted versioned Mandate and approve its exact scope hash. If a hard fact is missing, answer the required clarification instead of skipping it.
4. Show multiple eligible/rejected packages, their price/time trade-offs and the selected rationale. For confirm-before-purchase, perform the separate purchase confirmation.
5. In Demo mode, identify the step as **Simulated GoBTC settlement** and show the zero-fee simulated intent and non-payable recipient marker. Explain that the same Buyer mandate, reservation, order and production gates are running while only the provider response is simulated. Never display a private key or API token.
6. Show that the authenticated simulated submission creates a `demo_receipt_` and only then unlocks Hypit. The Build must consume the commission; the zero-cost smoke video is not a substitute.
7. Open the validated delivered video and campaign package. In Demo mode, explicitly show `DEMO ONLY`, zero network fee, pending settlement and no txid; never call the simulated receipt an instant GoBTC receipt or on-chain proof.
8. End with the campaign testing plan and the concrete next action enabled by the purchased artifact.

If mainnet funding, GoBTC infrastructure, provider credentials or final settlement is unavailable, say exactly which step is simulated or pending. Do not present the smoke Build, instant receipt or a mocked payment as mainnet proof.
