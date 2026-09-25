import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Exercise the production view functions without running app startup, polling,
// authentication, or paid production. Every dynamic string uses the same node()
// helper used by the actual console; the DOM double rejects HTML sinks.
const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.textContent = "";
    this.classList = { add() {} };
  }
  set innerHTML(_) { throw new Error("Dynamic HTML is forbidden"); }
  set outerHTML(_) { throw new Error("Dynamic HTML is forbidden"); }
  insertAdjacentHTML() { throw new Error("Dynamic HTML is forbidden"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
}
const context = vm.createContext({
  document: { createElement: (tag) => new Element(tag) },
  window: { matchMedia: () => ({ matches: false }) },
});
const helpers = source.slice(source.indexOf("function node("), source.indexOf("function toast("));
const decisionView = source.slice(source.indexOf("const rejectionLabels ="), source.indexOf("function decisionJourney("));
assert.ok(helpers && decisionView);
vm.runInContext(`${helpers}\n${decisionView}`, context);
const { customerDecisionRationale, decisionEvidence, renderDecisionEvidence, tradeoffView } = context;

function campaign() {
  const selected = {
    planId: "showcase:h3", productId: "proof_demo", productName: "Proof Demo",
    eligible: true, score: 0.8, totalAuthorizedSats: 1660,
    scope: { hookVariants: 3, summary: "3 hooks · 1 language · 1 format" },
    quote: { amountSats: 1600, addOns: { hookVariants: 3 }, estimatedTurnaroundMinutes: 50 },
    semanticAssessment: {
      planId: "showcase:h3", productId: "proof_demo",
      rationale: "Three openings allow you to compare the cleanup demonstration against two alternative introductions.",
    },
  };
  const alternative = {
    planId: "creator:h3", productId: "creator_pitch", productName: "Creator Pitch",
    eligible: true, score: 0.85, totalAuthorizedSats: 1260,
    scope: { hookVariants: 3, summary: "3 hooks · 1 language · 1 format" },
    quote: { amountSats: 1200, addOns: { hookVariants: 3 }, estimatedTurnaroundMinutes: 40 },
    semanticAssessment: {
      planId: "creator:h3", productId: "creator_pitch",
      rationale: "The presenter can explain the cleanup benefit, but the audience asked to see the product in action.",
    },
  };
  return {
    input: { budgetSats: 2000, scopeFlexibility: { hookVariants: true } },
    authorization: { budgetSats: 2000, autoExecute: true },
    decision: {
      method: "deepseek_semantic", selected, plans: [alternative, selected], budgetSats: 2000,
      objective: "conversion", rationale: "Proof Demo makes the cleanup benefit visible; the brief values demonstration over a presenter pitch.",
      tradeoffs: { cheaper: { planId: alternative.planId, label: "Creator Pitch", totalAuthorizedSats: 1260 } },
    },
  };
}

test("recommendation uses the persisted AI decision with deterministic price and remaining budget", () => {
  const value = campaign();
  const text = customerDecisionRationale(value);
  assert.match(text, /^Product Showcase makes the cleanup benefit visible/);
  assert.match(text, /Up to 1,660 sats, payment fee included; 340 sats stays available/);
  assert.doesNotMatch(text, /only offered format|removes the extra openings|strongest match/);
});

test("comparison shows each actual assessment, without inventing a same-format or fewer-hooks tradeoff", () => {
  const value = campaign();
  const result = decisionEvidence(value);
  assert.match(result.rank.items[0].title, /Product Showcase/);
  assert.equal(result.rank.items[0].detail, value.decision.selected.semanticAssessment.rationale);
  assert.equal(result.rank.items[1].detail, value.decision.plans[0].semanticAssessment.rationale);
  assert.match(result.rank.items[1].meta, /Also eligible · 3 openings · up to 1,260 sats/);
  assert.doesNotMatch(JSON.stringify(result.rank), /Same product-led format|lower-cost fallback/i);
});

test("tradeoff cards identify the actual package and use its assessment instead of generic backend summaries", () => {
  const value = campaign();
  const cheaper = value.decision.tradeoffs.cheaper;
  cheaper.reason = "Costs less, but provides less testing scope or a weaker format fit.";
  const view = tradeoffView(cheaper, value);
  assert.match(view.label, /^Creator Pitch · 3 hooks/);
  assert.equal(view.reason, value.decision.plans[0].semanticAssessment.rationale);
  const rejected = { ...value.decision.selected, planId: "showcase:h5", eligible: false, totalAuthorizedSats: 2500, rejections: ["campaign_budget"] };
  value.decision.plans.push(rejected);
  assert.equal(tradeoffView({ planId: rejected.planId }, value).reason, "Costs 2,500 sats, above your 2,000-sat limit.");
  assert.match(tradeoffView({ planId: "missing", label: "Legacy option" }, value).reason, /unavailable/);
});

test("old decisions and mismatched assessment identifiers do not invent a missing explanation", () => {
  const value = campaign();
  value.decision.rationale = " ";
  value.decision.selected.semanticAssessment.planId = "another-plan";
  value.decision.plans[0].semanticAssessment.productId = "another-product";
  assert.match(customerDecisionRationale(value), /original comparison notes are unavailable/);
  assert.match(decisionEvidence(value).rank.items[1].detail, /original comparison notes are unavailable/);
  delete value.decision.method;
  assert.match(customerDecisionRationale(value), /original comparison notes are unavailable/);
});

test("missing overall rationale can use the selected plan's bound assessment", () => {
  const value = campaign();
  delete value.decision.rationale;
  assert.ok(customerDecisionRationale(value).startsWith(value.decision.selected.semanticAssessment.rationale));
});

test("failed AI ranking is disclosed and partial assessments are not treated as the purchase basis", () => {
  const value = campaign();
  value.decision.method = "deterministic_fallback";
  value.decision.advisorError = { code: "creative_advisor_failed", message: "private diagnostic" };
  const text = customerDecisionRationale(value);
  assert.match(text, /An AI comparison was not used/);
  assert.doesNotMatch(text, /cleanup benefit|private diagnostic/);
  const evidence = decisionEvidence(value);
  assert.equal(evidence.rank.title, "Saved campaign scores guided this choice.");
  assert.match(evidence.rank.items[1].detail, /saved fit, quality, cost and speed scores/);
});

test("model markup remains literal text in the rendered decision panel", () => {
  const value = campaign();
  const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  value.decision.selected.semanticAssessment.rationale = malicious;
  value.decision.rationale = malicious;
  const panel = new Element("section");
  renderDecisionEvidence(panel, decisionEvidence(value).rank);
  const descend = (element) => [element, ...element.children.flatMap(descend)];
  assert.ok(descend(panel).some((element) => element.textContent === malicious));
  assert.equal(descend(panel).filter((element) => ["img", "script"].includes(element.tagName)).length, 0);
  renderDecisionEvidence(panel, decisionEvidence(value).purchase);
  assert.ok(descend(panel).some((element) => String(element.textContent).includes(malicious)));
});
