const $ = (selector) => document.querySelector(selector);
const stageContent = $("#stage-content");
const actionBar = $("#action-bar");
const activeId = $("#active-id");
const recentList = $("#recent-list");
let active = null;
let pollTimer;
let selectedPurchaseMode = "auto_within_budget";
let reusableReferenceUploadId = null;
let previewObjectUrl = null;
const selectedDecisionSteps = new Map();
const selectedDecisionPages = new Map();

const DEMO_PRODUCT_IMAGE_URL = "/console/demo-product.jpeg";
const DEMO_VIDEO_URL = "https://www.tiktok.com/@bilintinamakeup/video/6798977602963918085";

const presets = {
  auto: {
    platform: "TikTok",
    purchaseMode: "auto_within_budget",
    request: "Create a conversion-focused TikTok launch campaign for Precision Beauty Swabs, designed for makeup users who want precise, easy cleanup. Use an energetic United States English voice and product-led visuals. Choose the right number of opening hooks for launch testing. Keep spend under 2,000 sats and deliver within 60 minutes.",
  },
  confirm: {
    platform: "TikTok",
    purchaseMode: "confirm_before_purchase",
    request: "Create a conversion-focused TikTok launch campaign for Precision Beauty Swabs, designed for makeup users who want precise, easy cleanup. Use an energetic United States English voice and product-led visuals. Choose the right number of opening hooks for launch testing. Keep spend under 2,000 sats and deliver within 60 minutes.",
  },
};

const referenceVideoChannels = {
  TikTok: {
    label: "TIKTOK LINK",
    placeholder: "https://www.tiktok.com/@creator/video/7461234567890123456",
    matches: (url) => (url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"))
      && (/^\/@[^/]+\/video\/\d+(?:\/|$)/u.test(url.pathname)
        || (["vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname) && url.pathname.length > 1)),
  },
  "Instagram Reels": {
    label: "INSTAGRAM LINK",
    placeholder: "https://www.instagram.com/reel/DFa1b2C3d4E/",
    matches: (url) => (url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com"))
      && /^\/(?:reel|reels|p)\/[A-Za-z0-9_-]+(?:\/|$)/u.test(url.pathname),
  },
  "YouTube Shorts": {
    label: "YOUTUBE LINK",
    placeholder: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    matches: (url) => ((url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com"))
      && /^\/shorts\/[A-Za-z0-9_-]{6,15}(?:\/|$)/u.test(url.pathname))
      || (url.hostname === "youtu.be" && /^\/[A-Za-z0-9_-]{6,15}(?:\/|$)/u.test(url.pathname)),
  },
};

function updateCharacterCount() {
  const input = $("#request");
  $("#char-count").textContent = `${input.value.length.toLocaleString()} / ${input.maxLength.toLocaleString()}`;
}

function selectedImage() {
  const image = $("#product-image-file").files[0];
  if (!image) return null;
  if (!["image/jpeg", "image/png"].includes(image.type)) {
    throw new Error("Product image must be a JPG or PNG file");
  }
  if (image.size < 32 || image.size > 5 * 1024 * 1024) {
    throw new Error("Product image must be between 32 bytes and 5 MB");
  }
  return image;
}

function referenceVideoUrl() {
  const value = $("#reference-video-url").value.trim();
  if (!value) return null;
  const channel = $("#platform").value;
  const rule = referenceVideoChannels[channel];
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`Paste a valid ${channel} video link`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !["", "443"].includes(parsed.port)) {
    throw new Error("Reference video must use HTTPS without credentials or a custom port");
  }
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!rule?.matches(parsed)) throw new Error(`Paste a ${channel} link like ${rule?.placeholder ?? "the selected channel"}`);
  return parsed.href;
}

function updateReferenceVideoHint() {
  const rule = referenceVideoChannels[$("#platform").value];
  if (!rule) return;
  $("#reference-video-url").placeholder = rule.placeholder;
  $("#reference-video-kind").textContent = rule.label;
  const input = $("#reference-video-url");
  if ($("#platform").value !== "TikTok" && input.value.trim() === DEMO_VIDEO_URL) input.value = "";
  if ($("#platform").value === "TikTok" && input.value.trim() === "") input.value = DEMO_VIDEO_URL;
}

function updateImageName() {
  try {
    const image = selectedImage();
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = image ? URL.createObjectURL(image) : null;
    if (image) reusableReferenceUploadId = null;
    $("#product-preview").src = previewObjectUrl
      ?? (reusableReferenceUploadId ? `/v1/uploads/${encodeURIComponent(reusableReferenceUploadId)}` : DEMO_PRODUCT_IMAGE_URL);
    $("#upload-name").textContent = image?.name ?? (reusableReferenceUploadId ? "Product image ready" : "Demo product ready");
    $("#reference-upload-field").classList.add("has-file");
  } catch (error) {
    $("#product-image-file").value = "";
    reusableReferenceUploadId = null;
    $("#product-preview").src = DEMO_PRODUCT_IMAGE_URL;
    $("#upload-name").textContent = "Demo product ready";
    $("#reference-upload-field").classList.add("has-file");
    toast(error.message, true);
  }
}

async function demoProductImage() {
  const response = await fetch(DEMO_PRODUCT_IMAGE_URL);
  if (!response.ok) throw new Error("The demo product image is unavailable");
  const blob = await response.blob();
  return new File([blob], "demo-product.jpeg", { type: "image/jpeg" });
}

function selectPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  selectedPurchaseMode = preset.purchaseMode;
  $("#request").value = preset.request;
  $("#platform").value = preset.platform;
  updateReferenceVideoHint();
  document.querySelectorAll(".preset").forEach((button) => {
    const selected = button.dataset.preset === name;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  updateCharacterCount();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function clear(element) { element.replaceChildren(); }

function toast(message, isError = false) {
  const box = $("#toast");
  box.textContent = message;
  box.className = `toast show${isError ? " error" : ""}`;
  setTimeout(() => { box.className = "toast"; }, 3200);
}

let loginPromise;

function requestToken() {
  const dialog = $("#login-dialog");
  const form = $("#login-form");
  const tokenInput = $("#access-token");
  dialog.showModal();
  tokenInput.value = "";
  tokenInput.focus();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      form.removeEventListener("submit", submit);
      $("#login-cancel").removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", cancel);
    };
    const submit = (event) => {
      event.preventDefault();
      const token = tokenInput.value;
      cleanup();
      dialog.close();
      resolve(token);
    };
    const cancel = (event) => {
      event.preventDefault();
      cleanup();
      dialog.close();
      reject(new Error("Buyer Console authentication is required"));
    };
    form.addEventListener("submit", submit);
    $("#login-cancel").addEventListener("click", cancel);
    dialog.addEventListener("cancel", cancel);
  });
}

async function login() {
  loginPromise ??= (async () => {
    const token = await requestToken();
    if (!token) throw new Error("Buyer Console authentication is required");
    const response = await fetch("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message ?? "Authentication failed");
  })().finally(() => { loginPromise = undefined; });
  return await loginPromise;
}

async function loginFromFragment() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("access");
  if (!token) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  const response = await fetch("/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message ?? "Preview link authentication failed");
  return true;
}

$("#logout").addEventListener("click", async () => {
  await fetch("/v1/session", { method: "DELETE" });
  active = null;
  toast("Buyer Console session ended");
  await login();
  await readiness();
});

async function api(path, options = {}, retry = true) {
  const { acceptStatuses = [], ...fetchOptions } = options;
  const response = await fetch(path, {
    ...fetchOptions,
    headers: { "content-type": "application/json", ...(fetchOptions.headers ?? {}) },
  });
  if (response.status === 401 && retry && path !== "/v1/session") {
    await login();
    return await api(path, options, false);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !acceptStatuses.includes(response.status)) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  }
  return payload;
}

function stageFor(delegation) {
  const campaign = delegation.campaign;
  if (!campaign) return "intent";
  if (campaign.state === "decision_ready") return "decision";
  if (["creating_payment", "awaiting_payment", "signing", "submitting_payment", "payment_submitted", "payment_uncertain", "payment_preparation_failed"].includes(campaign.state)) return "payment";
  if (["paid", "fulfillment", "fulfillment_failed"].includes(campaign.state)) return "production";
  if (["packaging", "packaging_failed", "completed"].includes(campaign.state)) return "package";
  return "decision";
}

function updateStages(delegation, forcedStage = null) {
  const order = ["intent", "decision", "payment", "production", "package"];
  const current = order.indexOf(forcedStage ?? stageFor(delegation));
  document.querySelectorAll("#stage-track li").forEach((item, index) => {
    item.classList.toggle("done", index < current || (delegation.state === "completed" && index <= current));
    item.classList.toggle("active", index === current && delegation.state !== "completed");
  });
}

function renderComparisonProgress(delegation) {
  clear(stageContent);
  clear(actionBar);
  actionBar.classList.add("hidden");
  updateStages(delegation, "decision");
  const mandate = delegation.mandate;
  stageContent.append(title("AGENT SHOPPING", "Finding the strongest campaign option", "CREATIVE FIT × SCOPE × PRICE"));
  if (mandate) stageContent.append(dataGrid([
    ["GOAL", mandate.objective],
    ["MAX SPEND", `${mandate.budgetSats.toLocaleString()} sats`],
    ["SCOPE", mandate.scopeFlexibility?.hookVariants ? "Agent optimizes variants" : `${mandate.brief?.hookVariants ?? 1} hooks`],
  ]));
  const journey = node("section", "decision-journey live", "");
  const steps = [
    ["01", "Understand", "Your goal, budget and buying preference", "done"],
    ["02", "Compare", "Exploring services, scope and price", "active"],
    ["03", "Protect", "Ruling out options outside your limits", "pending"],
    ["04", "Recommend", "AI weighs campaign value and fit", "pending"],
    ["05", "Purchase", "Confirm the exact choice before buying", "pending"],
  ];
  for (const [number, label, detail, state] of steps) {
    const step = node("article", `decision-step ${state}`);
    step.append(node("span", "", number), node("strong", "", label), node("small", "", detail));
    journey.append(step);
  }
  stageContent.append(journey);
  const scan = node("div", "comparison-scan");
  for (const [index, name] of ["Creator Pitch", "Product Showcase", "Ranking / Listicle", "Two-person Podcast"].entries()) {
    const item = node("div", "comparison-scan-item");
    item.style.setProperty("--scan-delay", `${index * 0.18}s`);
    item.append(node("span", "scan-dot"), node("strong", "", name), node("small", "", "Pricing scope and checking fit"));
    scan.append(item);
  }
  stageContent.append(scan);
}

function dataGrid(items) {
  const grid = node("div", "data-grid");
  for (const [label, value] of items) {
    const card = node("div", "datum");
    card.append(node("span", "", label), node("strong", "", value ?? "—"));
    grid.append(card);
  }
  return grid;
}

function title(kicker, heading, note = "") {
  const wrap = node("div", "section-title");
  const left = node("div");
  left.append(node("p", "kicker", kicker), node("h2", "", heading));
  wrap.append(left);
  if (note) wrap.append(node("p", "", note));
  return wrap;
}

const stateLabels = {
  interpreting: "UNDERSTANDING BRIEF",
  clarification_required: "NEEDS YOUR INPUT",
  approval_required: "READY TO REVIEW",
  declined: "READY TO REVISE",
  advisory_ready: "OPTION READY",
  awaiting_purchase_confirmation: "READY TO BUY",
  creating_campaign: "COMPARING OPTIONS",
  campaign_active: "CAMPAIGN IN PROGRESS",
  execution_paused: "ACTION NEEDED",
  completed: "CAMPAIGN READY",
  interpretation_failed: "TRY AGAIN",
};

function restoreBrief(delegation) {
  const context = delegation.input?.context ?? {};
  selectedPurchaseMode = context.purchaseMode === "confirm_before_purchase"
    ? "confirm_before_purchase"
    : "auto_within_budget";
  document.querySelectorAll(".preset").forEach((button) => {
    const selected = (button.dataset.preset === "auto") === (selectedPurchaseMode === "auto_within_budget");
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#request").value = delegation.input?.request ?? presets.auto.request;
  $("#platform").value = context.platform ?? "TikTok";
  $("#reference-video-url").value = context.referenceVideoUrl ?? (context.platform === "TikTok" ? DEMO_VIDEO_URL : "");
  reusableReferenceUploadId = context.referenceUploadId ?? delegation.mandate?.referenceUploadId ?? null;
  $("#product-image-file").value = "";
  updateReferenceVideoHint();
  updateImageName();
  updateCharacterCount();
  $("#request").focus();
  clear(stageContent);
  clear(actionBar);
  actionBar.classList.add("hidden");
  stageContent.append(title("EDITING BRIEF", "Update your request, then press Start"));
  stageContent.append(node("p", "flow-guidance", "The previous run is paused. Your purchase mode, references, and brief are ready to revise."));
  if (window.matchMedia("(max-width: 760px)").matches) {
    document.querySelector(".launcher-panel").scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  }
}

function renderQuestions(delegation) {
  const requiredQuestions = delegation.questions.filter((item) => item.required !== false);
  stageContent.append(title("BRIEF CHECK", "A few details first", `${requiredQuestions.length} open`));
  stageContent.append(node("div", "notice neutral", "Answer the details that can change the plan."));
  const form = node("form", "question-list");
  for (const item of requiredQuestions) {
    const wrapper = node("div", "question");
    wrapper.append(node("p", "", item.question));
    const input = node("input");
    input.name = item.id;
    input.required = true;
    input.placeholder = "Answer";
    wrapper.append(input);
    form.append(wrapper);
  }
  const submit = node("button", "button primary");
  submit.type = "submit";
  submit.append(node("span", "", "Submit answers"), node("span", "", "↗"));
  form.append(submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const answers = Object.fromEntries([...new FormData(form)].filter(([, value]) => String(value).trim() !== ""));
    await act(`/v1/delegations/${encodeURIComponent(delegation.id)}/answers`, { answers });
  });
  stageContent.append(form);
}

function renderMandate(delegation) {
  const mandate = delegation.mandate;
  const voiceRequirements = mandate.brief?.voiceRequirements ?? [];
  const voiceSummary = voiceRequirements.length === 0
    ? "Package default"
    : voiceRequirements.map((item) => [item.role, item.style, item.pace, item.accent].filter(Boolean).join(" · ")).join(" / ");
  stageContent.append(title("CAMPAIGN PLAN", "Review before we compare offers"));
  const summary = dataGrid([
    ["GOAL", mandate.objective],
    ["BUDGET LIMIT", `${mandate.budgetSats.toLocaleString()} sats`],
    ["FORMAT", delegation.input?.context?.platform ?? mandate.brief?.aspectRatios?.join(" · ") ?? "Social video"],
    ["VOICE", voiceSummary],
  ]);
  summary.classList.add("mandate-summary");
  stageContent.append(summary);
  const approve = node("button", "button confirm", "Continue to package comparison");
  const decline = node("button", "button secondary", "Edit brief");
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    decline.disabled = true;
    approve.textContent = "Starting campaign…";
    toast("Mandate approved. Starting the campaign…");
    renderComparisonProgress(delegation);
    const updated = await act(`/v1/delegations/${encodeURIComponent(delegation.id)}/confirm`, {
      approved: true,
      mandateVersion: mandate.version,
      scopeHash: mandate.scopeHash,
    });
    if (!updated && active?.state === "approval_required") {
      approve.disabled = false;
      decline.disabled = false;
      approve.textContent = "Continue to package comparison";
    }
  });
  decline.addEventListener("click", () => act(`/v1/delegations/${encodeURIComponent(delegation.id)}/confirm`, { approved: false }));
  showActions(decline, approve);
}

function renderDeclined(delegation) {
  updateStages(delegation, "intent");
  stageContent.append(title("BRIEF PAUSED", "Make a change, then try again"));
  stageContent.append(node(
    "p",
    "flow-guidance",
    "Your brief and references are still available. Return to the editor, adjust anything you want, and start a new run.",
  ));
  const edit = node("button", "button primary", "Edit brief and try again");
  edit.addEventListener("click", () => restoreBrief(delegation));
  showActions(edit);
}

const rejectionLabels = {
  reference_adaptation_unsupported: "Reference-video adaptation unavailable",
  reference_product_image_required: "Product image required",
  visual_mode_unsupported: "Visual format mismatch",
  voice_requirements_unsupported: "Voice format mismatch",
  campaign_budget: "Outside the approved budget",
  budget_exceeded: "Outside the approved budget",
  per_order_policy_ceiling: "Above the safe order limit",
  deadline: "Cannot meet the deadline",
  production_variant_limit: "Requested output set is too large",
};

const packageProfiles = {
  creator_pitch: {
    format: "1 CREATOR",
    outcome: "Direct pitch to camera",
    difference: "Launch ads and direct response",
    bestFor: "Launches and direct-response ads",
    basePriceSats: 900,
  },
  proof_demo: {
    displayName: "Product Showcase",
    format: "PRODUCT-FIRST",
    outcome: "Your product performs the reference actions",
    difference: "Demos, feature proof, and conversion",
    bestFor: "Product demonstrations and conversion",
    basePriceSats: 1300,
  },
  ranking_listicle: {
    format: "1 PRESENTER",
    outcome: "Three reasons, ranked and explained",
    difference: "Comparisons and consideration",
    bestFor: "Comparisons and consideration",
    basePriceSats: 1600,
  },
  two_person_podcast: {
    format: "2 HOSTS",
    outcome: "Objections answered in conversation",
    difference: "Trust and social proof",
    bestFor: "Objections, trust, and social proof",
    basePriceSats: 2100,
  },
};

function productDisplayName(productId, fallback) {
  return packageProfiles[productId]?.displayName ?? fallback;
}

function customerCopy(value) {
  return String(value ?? "")
    .replace(/\bProof Demo\b/giu, "Product Showcase")
    .replace(/\bproof_demo\b/gu, "Product Showcase");
}

function selectedPlanSummary(decision) {
  const quote = decision?.selected?.quote;
  if (!quote) return "";
  return decision.selected.scope?.summary
    ?? `${quote.addOns?.hookVariants ?? 1} hooks · ${(quote.addOns?.languages ?? []).join(" + ")} · ${(quote.addOns?.aspectRatios ?? []).join(" + ")}`;
}

function packageStatus(candidate, decision) {
  if (candidate.productId === decision.selected.productId) return "BEST FIT";
  if (candidate.eligible) return "ALSO FITS";
  const reasons = candidate.rejections?.map((reason) => rejectionLabels[reason] ?? null).filter(Boolean) ?? [];
  return reasons[0] ?? "NOT A FIT";
}

function selectionSignals(decision) {
  const selected = decision.selected;
  const quote = selected.quote;
  const profile = packageProfiles[selected.productId];
  const signals = [];
  if (quote?.brief?.evidenceUrl && quote.product?.production?.referenceAdaptation === true) {
    signals.push(["BRIEF MATCH", "Uses your product image and reference-video choreography"]);
  } else if (profile) {
    signals.push(["FORMAT MATCH", profile.bestFor]);
  }
  if ((quote?.addOns?.hookVariants ?? 1) > 1) {
    signals.push(["TESTING VALUE", `${quote.addOns.hookVariants} hooks give the campaign multiple openings to test`]);
  } else {
    signals.push(["RIGHT-SIZED", "Buys only the output needed for this brief"]);
  }
  const budget = decision.budgetSats;
  const spend = selected.totalAuthorizedSats ?? quote?.amountSats;
  if (Number.isSafeInteger(budget) && Number.isSafeInteger(spend)) {
    signals.push(["BUDGET FIT", `${spend.toLocaleString()} sats authorized · ${(budget - spend).toLocaleString()} sats kept`]);
  }
  return signals.slice(0, 3);
}

function concise(text, maxLength = 260) {
  const value = customerCopy(text).replace(/\s+/gu, " ").trim();
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength + 1).replace(/\s+\S*$/u, "");
  return `${clipped}…`;
}

function readableObjective(value) {
  const text = String(value ?? "campaign").replace(/[_-]+/gu, " ").trim();
  return text === "" ? "Campaign goal" : `${text[0].toUpperCase()}${text.slice(1)}`;
}

function customerDecisionRationale(campaign) {
  const decision = campaign.decision;
  const selected = decision.selected;
  const budget = decision.budgetSats ?? campaign.authorization?.budgetSats ?? campaign.input?.budgetSats;
  const spend = selected.totalAuthorizedSats ?? selected.quote.amountSats;
  const remaining = Number.isSafeInteger(budget) ? Math.max(0, budget - spend) : null;
  const parts = [
    `${productDisplayName(selected.productId, selected.productName)} is the strongest match for ${readableObjective(decision.objective).toLowerCase()}.`,
  ];
  if (campaign.input?.referenceVideoUrl) {
    parts.push("It can turn your reference into new product-led motion.");
  }
  parts.push(`You get ${selectedPlanSummary(decision).toLowerCase()} for ${spend.toLocaleString()} sats${remaining === null ? "." : `, with ${remaining.toLocaleString()} sats left.`}`);
  if (decision.tradeoffs?.broader?.withinBudget === false) {
    parts.push("The next larger option would exceed your approved spend.");
  }
  return parts.join(" ");
}

function planLabel(plan) {
  return `${productDisplayName(plan.productId, plan.productName)} · ${plan.scope?.summary ?? "Requested scope"}`;
}

function rejectionExplanation(code, plan, decision, campaign) {
  const budget = decision.budgetSats ?? campaign.authorization?.budgetSats ?? campaign.input?.budgetSats;
  const deadline = campaign.input?.deadlineMinutes;
  const explanations = {
    campaign_budget: Number.isSafeInteger(plan.totalAuthorizedSats) && Number.isSafeInteger(budget)
      ? `Costs ${plan.totalAuthorizedSats.toLocaleString()} sats, above your ${budget.toLocaleString()}-sat limit.`
      : "Costs more than your approved budget.",
    budget_exceeded: "Costs more than your approved budget.",
    per_order_policy_ceiling: "Exceeds the purchase allowance available to this account.",
    deadline: Number.isSafeInteger(plan.quote?.estimatedTurnaroundMinutes) && Number.isSafeInteger(deadline)
      ? "This larger scope cannot be completed reliably within your requested delivery window."
      : "Cannot be delivered within your requested deadline.",
    reference_adaptation_unsupported: "Cannot turn your reference video into new product-led motion.",
    reference_product_image_required: "Needs a usable product image before production can begin.",
    visual_mode_unsupported: "Does not support the visual format requested in your brief.",
    voice_requirements_unsupported: "Does not support the requested voice setup.",
    production_variant_limit: "Cannot deliver this many versions in one production run.",
  };
  return explanations[code] ?? "Does not meet one of the confirmed campaign requirements.";
}

function decisionEvidence(campaign) {
  const decision = campaign.decision;
  const plans = decision.plans ?? decision.candidates ?? [];
  const rejected = plans.filter((plan) => !plan.eligible);
  const eligible = plans.filter((plan) => plan.eligible).sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const budget = decision.budgetSats ?? campaign.authorization?.budgetSats ?? campaign.input?.budgetSats;
  const spend = decision.selected.totalAuthorizedSats ?? decision.selected.quote.amountSats;
  const authority = campaign.authorization?.autoExecute === true
    ? "Buy automatically once every confirmed limit is satisfied"
    : "Ask for your approval before placing the order";
  const grouped = new Map();
  for (const plan of plans) grouped.set(plan.productId, [...(grouped.get(plan.productId) ?? []), plan]);
  const packageItems = [...grouped.entries()].map(([productId, items]) => {
    const profile = packageProfiles[productId] ?? {};
    const quoted = items.filter((item) => item.quote !== null);
    const prices = quoted.map((item) => item.totalAuthorizedSats ?? item.quote.amountSats);
    const startingPrice = Number.isSafeInteger(profile.basePriceSats)
      ? profile.basePriceSats
      : prices.length ? Math.min(...prices) : null;
    return {
      title: productDisplayName(productId, items[0]?.productName),
      meta: `${profile.format ?? "VIDEO"} · ${startingPrice === null ? "priced to scope" : `from ${startingPrice.toLocaleString()} sats`}`,
      detail: `${profile.outcome ?? "Campaign production"}. ${profile.bestFor ? `Best for ${profile.bestFor.toLowerCase()}.` : profile.difference ?? "Available for the right campaign brief."}`,
    };
  });
  const rankedItems = eligible.map((plan, index) => {
    const assessment = plan.semanticAssessment;
    const scores = assessment
      ? `Goal ${Math.round(assessment.objectiveFit * 100)}% · Creative ${Math.round(assessment.creativeFit * 100)}% · Evidence ${Math.round(assessment.evidenceFit * 100)}%`
      : `Overall fit ${Math.round((plan.score ?? 0) * 100)}%`;
    return {
      title: `${index + 1}. ${planLabel(plan)}`,
      meta: `${scores} · ${(plan.totalAuthorizedSats ?? plan.quote?.amountSats ?? 0).toLocaleString()} sats`,
      detail: plan.planId === decision.selected.planId
        ? customerDecisionRationale(campaign)
        : "This option meets the campaign requirements and budget, but offers less overall campaign value than the recommendation.",
    };
  });
  return {
    mandate: {
      eyebrow: "WHAT YOU ASKED FOR",
      title: "The agent turned your brief into clear buying boundaries.",
      intro: "These are the promises the final purchase must keep.",
      items: [
        { title: "Campaign goal", meta: readableObjective(decision.objective), detail: "The creative should be optimized for this outcome." },
        { title: "Approved spend", meta: `${Number(budget).toLocaleString()} sats maximum`, detail: "The agent cannot authorize a plan above this amount." },
        { title: "Purchase preference", meta: authority, detail: "Your chosen level of autonomy stays attached to this campaign." },
        { title: "Flexible scope", meta: campaign.input?.scopeFlexibility?.hookVariants ? "The agent may choose the number of hooks" : "The requested output count is fixed", detail: "Flexibility is used only when it improves the campaign inside budget." },
      ],
    },
    enumerate: {
      eyebrow: "WHAT THE AGENT EXPLORED",
      title: `${plans.length} complete purchase options were built before choosing one.`,
      intro: "Each option combines a production format, output scope, price and turnaround—not just a package name.",
      items: packageItems,
    },
    filter: {
      eyebrow: "WHAT DIDN'T QUALIFY",
      title: `${rejected.length} option${rejected.length === 1 ? " was" : "s were"} ruled out before recommendation.`,
      intro: "Only options that respected every approved requirement moved forward.",
      items: rejected.map((plan) => ({
        title: planLabel(plan),
        meta: "Not a fit for this campaign",
        detail: (plan.rejections ?? []).map((code) => rejectionExplanation(code, plan, decision, campaign)).join(" "),
      })),
    },
    rank: {
      eyebrow: "HOW THE BEST OPTIONS COMPARED",
      title: decision.method === "deepseek_semantic"
        ? "AI compared campaign value—not simply the lowest price."
        : "The agent compared campaign fit, quality, cost and speed.",
      intro: "Only matching options appear here. The strongest overall balance ranks first.",
      items: rankedItems,
    },
    purchase: {
      eyebrow: "WHY THIS PLAN WAS AUTHORIZED",
      title: `${productDisplayName(decision.selected.productId, decision.selected.productName)} gives the strongest result inside your limit.`,
      intro: customerDecisionRationale(campaign),
      items: [
        { title: "Selected output", meta: selectedPlanSummary(decision), detail: "The scope gives the campaign useful creative coverage without buying unnecessary output." },
        { title: "Final spend", meta: `${spend.toLocaleString()} of ${Number(budget).toLocaleString()} sats`, detail: `${Math.max(0, budget - spend).toLocaleString()} sats stays unspent.` },
        { title: "Protected purchase", meta: "One exact plan, authorized once", detail: "A changed price, recipient or scope requires a fresh decision before anything can proceed." },
      ],
    },
  };
}

function renderDecisionEvidence(panel, evidence, { page = 0, onPageChange } = {}) {
  clear(panel);
  const pageSize = window.matchMedia("(max-width: 760px)").matches ? 2 : 4;
  const totalPages = Math.max(1, Math.ceil(evidence.items.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const heading = node("div", "decision-evidence-heading");
  const copy = node("div");
  copy.append(node("span", "", evidence.eyebrow), node("h4", "", evidence.title), node("p", "", evidence.intro));
  heading.append(copy, node("small", "", "EXPLORE THE DECISION"));
  const main = node("div", "decision-evidence-main");
  const list = node("div", "decision-evidence-list");
  for (const item of evidence.items.slice(currentPage * pageSize, (currentPage + 1) * pageSize)) {
    const row = node("article", "decision-evidence-item");
    const label = node("div");
    label.append(node("strong", "", item.title), node("small", "", item.meta));
    row.append(label, node("p", "", item.detail));
    list.append(row);
  }
  main.append(list);
  if (totalPages > 1) {
    const pager = node("nav", "decision-evidence-pager");
    pager.setAttribute("aria-label", "More decision details");
    const previous = node("button", "", "← Previous");
    const next = node("button", "", "Next →");
    previous.type = "button";
    next.type = "button";
    previous.disabled = currentPage === 0;
    next.disabled = currentPage === totalPages - 1;
    previous.addEventListener("click", () => onPageChange?.(currentPage - 1));
    next.addEventListener("click", () => onPageChange?.(currentPage + 1));
    pager.append(previous, node("span", "", `${currentPage + 1} of ${totalPages}`), next);
    main.append(pager);
  }
  panel.append(heading, main);
}

function decisionJourney(campaign, { compact = false } = {}) {
  const decision = campaign?.decision;
  if (!decision?.selected) return null;
  const plans = decision.plans ?? decision.candidates ?? [];
  const eligible = plans.filter((item) => item.eligible).length;
  const packages = new Set(plans.map((item) => item.productId).filter(Boolean)).size;
  const spend = decision.selected.totalAuthorizedSats ?? decision.selected.quote.amountSats;
  const budget = decision.budgetSats ?? campaign.authorization?.budgetSats ?? campaign.input?.budgetSats ?? spend;
  const remaining = Math.max(0, budget - spend);
  const aiRanked = decision.method === "deepseek_semantic";
  const steps = [
    ["mandate", "01", "Understand", `${readableObjective(decision.objective)} · up to ${budget.toLocaleString()} sats`],
    ["enumerate", "02", "Compare", `${plans.length} options from ${packages} services`],
    ["filter", "03", "Protect", `${eligible} match · ${Math.max(0, plans.length - eligible)} ruled out`],
    ["rank", "04", "Recommend", aiRanked ? "AI balanced impact, cost and speed" : "Balanced impact, cost and speed"],
    ["purchase", "05", "Purchase", `${productDisplayName(decision.selected.productId, decision.selected.productName)} · ${spend.toLocaleString()} · ${remaining.toLocaleString()} left`],
  ];
  const section = node("section", `decision-journey${compact ? " compact" : ""}`);
  section.setAttribute("aria-label", "How the agent chose and authorized the purchase");
  section.setAttribute("role", "tablist");
  const evidence = decisionEvidence(campaign);
  const selectedKey = selectedDecisionSteps.get(campaign.id) ?? "mandate";
  const panel = node("section", "decision-evidence");
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-live", "polite");
  const showEvidence = (key) => {
    const pageKey = `${campaign.id}:${key}`;
    renderDecisionEvidence(panel, evidence[key] ?? evidence.mandate, {
      page: selectedDecisionPages.get(pageKey) ?? 0,
      onPageChange: (nextPage) => {
        selectedDecisionPages.set(pageKey, nextPage);
        showEvidence(key);
      },
    });
  };
  for (const [key, number, label, detail] of steps) {
    const step = node("button", `decision-step done${key === selectedKey ? " selected" : ""}`);
    step.type = "button";
    step.setAttribute("role", "tab");
    step.setAttribute("aria-selected", String(key === selectedKey));
    step.append(node("span", "", number), node("strong", "", label), node("small", "", detail));
    step.addEventListener("click", () => {
      selectedDecisionSteps.set(campaign.id, key);
      for (const item of section.querySelectorAll(".decision-step")) {
        const isSelected = item === step;
        item.classList.toggle("selected", isSelected);
        item.setAttribute("aria-selected", String(isSelected));
      }
      showEvidence(key);
    });
    section.append(step);
  }
  showEvidence(selectedKey);
  section.append(panel);
  return section;
}

function codeGuardrails(campaign) {
  const decision = campaign?.decision;
  if (!decision?.selected) return null;
  const spend = decision.selected.totalAuthorizedSats ?? decision.selected.quote.amountSats;
  const budget = decision.budgetSats ?? campaign.authorization?.budgetSats ?? campaign.input?.budgetSats ?? spend;
  const autonomous = campaign.authorization?.autoExecute === true;
  const guardrails = node("section", "code-guardrails");
  guardrails.append(node("div", "code-guardrails-title", "YOUR LIMITS STAY PROTECTED"));
  const items = [
    ["AUTONOMY", autonomous ? "The agent can buy only inside the campaign you approved" : "The order waits for your explicit approval"],
    ["SPEND", `${spend.toLocaleString()} sats stays inside your ${budget.toLocaleString()}-sat limit`],
    ["ORDER", "The approved plan can be purchased once; any change needs a new decision"],
  ];
  for (const [label, detail] of items) {
    const item = node("article");
    item.append(node("span", "", "PROTECTED"), node("strong", "", label), node("small", "", detail));
    guardrails.append(item);
  }
  return guardrails;
}

function planRecap(campaign) {
  const decision = campaign?.decision;
  if (!decision?.selected) return null;
  const spend = decision.selected.totalAuthorizedSats ?? decision.selected.quote.amountSats;
  const budget = decision.budgetSats ?? campaign.authorization?.budgetSats ?? campaign.input?.budgetSats;
  const remaining = Number.isSafeInteger(budget) ? budget - spend : null;
  const recap = node("div", "plan-recap");
  const copy = node("div");
  copy.append(
    node("span", "plan-recap-label", "AGENT'S CHOICE"),
    node("strong", "", productDisplayName(decision.selected.productId, decision.selected.productName)),
    node("small", "", selectedPlanSummary(decision)),
    node("p", "", concise(customerDecisionRationale(campaign), 260)),
  );
  const numbers = node("div", "plan-recap-numbers");
  numbers.append(node("b", "", `${spend.toLocaleString()} / ${Number(budget ?? spend).toLocaleString()} sats`));
  if (remaining !== null) numbers.append(node("small", "", `${Math.max(0, remaining).toLocaleString()} remaining`));
  recap.append(copy, numbers);
  const compared = decision.plans?.length ?? decision.candidates?.length ?? 0;
  const cheaper = decision.tradeoffs?.cheaper;
  const broader = decision.tradeoffs?.broader;
  const noteParts = [`Compared ${compared} options`];
  if (cheaper) noteParts.push(`lower-cost choice ${cheaper.totalAuthorizedSats.toLocaleString()} sats`);
  if (broader) noteParts.push(`${broader.withinBudget === false ? "larger scope is over budget" : "more output is available"}`);
  recap.append(node("div", "plan-recap-note", noteParts.join(" · ")));
  const journey = decisionJourney(campaign, { compact: true });
  if (journey) recap.append(journey);
  return recap;
}

function renderDecision(delegation, { transient = false } = {}) {
  const campaign = delegation.campaign;
  const decision = campaign?.decision;
  if (!decision) {
    renderComparisonProgress(delegation);
    return;
  }
  const matched = (decision.plans ?? decision.candidates).filter((candidate) => candidate.eligible).length;
  stageContent.append(title(
    "AGENT'S CHOICE",
    "The best plan within your budget",
    `${decision.plans?.length ?? decision.candidates.length} OPTIONS COMPARED · ${matched} MATCH`,
  ));
  const journey = decisionJourney(campaign);
  if (journey) stageContent.append(journey);
  const decisionSpotlight = node("div", "decision-spotlight");
  const best = node("div", "best-fit-card");
  const bestCopy = node("div");
  bestCopy.append(
    node("span", "best-fit-label", "RECOMMENDED PURCHASE"),
    node("h3", "", productDisplayName(decision.selected.productId, decision.selected.productName)),
    node("strong", "best-fit-scope", selectedPlanSummary(decision)),
    node("p", "", concise(customerDecisionRationale(campaign), 300)),
  );
  best.append(bestCopy, node("strong", "best-fit-price", `${decision.selected.quote.amountSats.toLocaleString()} sats`));
  const why = node("div", "selection-proof");
  why.append(node("span", "selection-proof-label", "WHY THIS PLAN WON"));
  for (const [label, value] of selectionSignals(decision)) {
    const signal = node("div", "selection-signal");
    signal.append(node("i", "", "✓"), node("span", "", label), node("strong", "", value));
    why.append(signal);
  }
  decisionSpotlight.append(best, why);
  stageContent.append(decisionSpotlight);

  const authorized = decision.selected.totalAuthorizedSats ?? decision.selected.quote.amountSats;
  const budget = decision.budgetSats ?? campaign.authorization?.budgetSats ?? campaign.input?.budgetSats;
  const meter = node("div", "budget-meter");
  const meterHead = node("div", "budget-meter-head");
  meterHead.append(
    node("span", "", "AUTHORIZED SPEND"),
    node("strong", "", `${authorized.toLocaleString()} / ${budget.toLocaleString()} sats`),
  );
  const track = node("div", "budget-meter-track");
  const fill = node("i");
  fill.style.width = `${Math.min(100, (authorized / budget) * 100)}%`;
  track.append(fill);
  meter.append(meterHead, track, node("small", "", `${Math.max(0, budget - authorized).toLocaleString()} sats remain available`));
  stageContent.append(meter);
  const guardrails = codeGuardrails(campaign);
  if (guardrails) stageContent.append(guardrails);

  const tradeoffs = node("div", "tradeoff-grid");
  const tradeoffItems = [
    ["LOWER COST", decision.tradeoffs?.cheaper],
    ["SELECTED", decision.tradeoffs?.selected],
    ["MORE OUTPUT", decision.tradeoffs?.broader],
  ].filter(([, item]) => item);
  for (const [label, item] of tradeoffItems) {
    const selected = item.planId === decision.selected.planId;
    const card = node("div", `tradeoff-card${selected ? " selected" : ""}${item.withinBudget === false ? " over-budget" : ""}`);
    card.append(
      node("span", "", label),
      node("strong", "", item.label),
      node("b", "", `${item.totalAuthorizedSats.toLocaleString()} sats`),
      node("small", "", item.reason),
    );
    tradeoffs.append(card);
  }
  if (tradeoffItems.length > 1) stageContent.append(tradeoffs);

  const comparison = node("section", "package-comparison");
  const comparisonHead = node("div", "package-comparison-head");
  comparisonHead.append(
    node("strong", "", "How the packages differ"),
    node("small", "", "See what each option delivers and why it fits—or does not"),
  );
  comparison.append(comparisonHead);
  const list = node("div", "package-comparison-grid");
  for (const candidate of decision.candidates) {
    const selected = candidate.productId === decision.selected.productId;
    const profile = packageProfiles[candidate.productId] ?? {};
    const card = node("article", `package-option${selected ? " selected" : ""}${candidate.eligible ? "" : " rejected"}`);
    const top = node("div", "package-option-top");
    top.append(
      node("span", "package-option-status", selected ? "✓ SELECTED" : candidate.eligible ? "MATCH" : "NOT A MATCH"),
      node("b", "", candidate.quote
        ? `${candidate.quote.amountSats.toLocaleString()} sats`
        : `from ${Number(profile.basePriceSats ?? 0).toLocaleString()} sats`),
    );
    card.append(
      top,
      node("h3", "", productDisplayName(candidate.productId, candidate.productName)),
      node("span", "package-format", profile.format ?? "VIDEO"),
      node("strong", "package-outcome", profile.outcome ?? "Campaign production"),
      node("small", "package-difference", profile.difference ?? candidate.scope?.summary ?? "Priced scope"),
      node("p", "package-verdict", packageStatus(candidate, decision)),
    );
    list.append(card);
  }
  comparison.append(list);
  stageContent.append(comparison);
  if (!transient && delegation.state === "awaiting_purchase_confirmation") {
    const confirm = node("button", "button confirm", `Approve ${productDisplayName(decision.selected.productId, decision.selected.productName)} · ${decision.selected.quote.amountSats.toLocaleString()} sats`);
    confirm.addEventListener("click", () => act(`/v1/delegations/${encodeURIComponent(delegation.id)}/confirm-purchase`, {}));
    showActions(confirm);
  }
}

function renderPayment(delegation) {
  const campaign = delegation.campaign;
  const payment = campaign.sellerOrder?.payment ?? {};
  const simulated = payment.simulated === true || campaign.paymentAttempt?.receipt?.simulated === true;
  stageContent.append(title(simulated ? "PAYMENT PREVIEW" : "BITCOIN PAYMENT", "Authorizing the selected package"));
  const recap = planRecap(campaign);
  if (recap) stageContent.append(recap);
  const card = node("div", "payment-card");
  const copy = node("div");
  copy.append(node("h3", "", payment.authorization === "authorized"
    ? (simulated ? "Preview authorized" : "Payment authorized")
    : (simulated ? "Awaiting preview authorization" : "Awaiting GoBTC")));
  copy.append(node("p", "", "The agent is securely authorizing the selected package."));
  card.append(copy, node("div", "amount", `${campaign.sellerOrder?.amountSats ?? campaign.decision?.selected.quote.amountSats ?? 0} sats`));
  stageContent.append(card);
  if (simulated) stageContent.append(node("div", "notice neutral", "PREVIEW MODE · Authorization is exercised; no Bitcoin moves."));
  if (campaign.lastError) stageContent.append(node("div", "notice", "Payment needs attention. The agent will keep checking safely."));
}

function renderExecutionPaused(delegation) {
  const campaign = delegation.campaign;
  const errorCode = campaign?.lastError?.code;
  const allowanceReached = ["daily_spend_limit", "lifetime_spend_limit"].includes(errorCode);
  stageContent.append(title(
    "AUTOMATIC PURCHASE PAUSED",
    allowanceReached ? "The preview allowance needs to reset" : "The order needs another attempt",
  ));
  const recap = planRecap(campaign);
  if (recap) stageContent.append(recap);
  stageContent.append(node(
    "div",
    "notice",
    allowanceReached
      ? "The agent selected the plan automatically, but the shared preview allowance blocked authorization. No payment was made."
      : "The agent selected the plan automatically, but could not finish authorization. No duplicate payment will be created.",
  ));
  const retry = node("button", "button confirm", "Retry automatic purchase");
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    retry.textContent = "Retrying…";
    await act(`/v1/delegations/${encodeURIComponent(delegation.id)}/resume`, {});
  });
  showActions(retry);
}

function renderProduction(delegation) {
  const campaign = delegation.campaign;
  const production = campaign.sellerOrder?.production ?? {};
  const isProducing = production.state === "producing";
  const turnaround = campaign.decision?.selected?.quote?.estimatedTurnaroundMinutes;
  stageContent.append(title("VIDEO PRODUCTION", isProducing ? "Your campaign is being created" : "Production is getting ready"));
  const recap = planRecap(campaign);
  if (recap) stageContent.append(recap);
  const live = node("section", `production-live${isProducing ? " active" : ""}`);
  const activity = node("div", "production-activity");
  activity.append(node("span", "production-spinner"), node("span", "production-live-label", isProducing ? "PRODUCTION IN PROGRESS" : "QUEUED FOR PRODUCTION"));
  const copy = node("div", "production-live-copy");
  copy.append(
    node("h3", "", isProducing ? "Please wait — we’re making your video" : "Your production slot is ready"),
    node("p", "", isProducing
      ? "The reference is being translated into new product action, then assembled and checked by Hypit. This page refreshes automatically."
      : "Production will begin automatically. No further action is needed."),
  );
  const progress = node("div", "production-progress");
  progress.append(node("i"));
  const meta = node("div", "production-meta");
  meta.append(
    node("span", "", isProducing ? "Creating · assembling · validating" : "Waiting to start"),
    node("strong", "", Number.isSafeInteger(turnaround) ? `Estimate: up to ${turnaround} min` : "We’ll update this page when ready"),
  );
  live.append(activity, copy, progress, meta);
  stageContent.append(live);
  stageContent.append(node("p", "production-wait-note", "You can keep this page open or return later. Your campaign continues safely in the background."));
  if (campaign.lastError) {
    const referenceOrder = Boolean(campaign.decision?.selected?.quote?.brief?.evidenceUrl);
    const message = campaign.lastError.code === "reference_video_fetch_failed"
      || (referenceOrder && campaign.lastError.code === "hypit_command_failed")
      ? "The reference-video source could not be reached. Retry the same order—your payment and selections are preserved."
      : "Production stopped before completion. Retry the same order—your payment and selections are preserved.";
    stageContent.append(node("div", "notice", message));
  }
  if (campaign.state === "fulfillment_failed") {
    const retry = node("button", "button confirm", "Retry production · no new payment");
    retry.addEventListener("click", () => act(`/v1/delegations/${encodeURIComponent(delegation.id)}/retry-fulfillment`, {}));
    const resolution = node("button", "button danger", "Request human resolution");
    resolution.addEventListener("click", () => act(`/v1/delegations/${encodeURIComponent(delegation.id)}/request-resolution`, {
      reason: "Paid production failed and requires operator review for retry, replacement, or refund handling.",
    }));
    showActions(resolution, retry);
  }
}

function renderPackage(delegation) {
  const campaign = delegation.campaign;
  const campaignPackage = campaign.package;
  if (!campaignPackage || campaignPackage.state !== "completed") {
    stageContent.append(title("CAMPAIGN ASSEMBLY", "Preparing your final files"));
    stageContent.append(node("p", "hero-copy", "The Buyer is collecting creatives, payment evidence, testing guidance, spend, and provenance into one verifiable package."));
    if (campaign.lastError) stageContent.append(node("div", "notice", "Final packaging paused. Resume when you’re ready."));
    const retry = node("button", "button secondary", "Resume package assembly");
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        await api(`/v1/campaigns/${encodeURIComponent(campaign.id)}/resume`, { method: "POST", body: "{}" });
        const next = await api(`/v1/delegations/${encodeURIComponent(delegation.id)}/sync`, { method: "POST", body: "{}" });
        render(next);
        await loadRecent();
        toast("Package assembly resumed");
      } catch (error) {
        retry.disabled = false;
        toast(error.message, true);
      }
    });
    showActions(retry);
    return;
  }
  const simulated = campaignPackage.paymentProof.simulated === true;
  stageContent.append(title(
    "CAMPAIGN READY",
    campaignPackage.summary.subject ?? "Campaign package",
    `${campaignPackage.summary.spend.spentSats} SATS ${simulated ? "PREVIEWED" : "SPENT"}`,
  ));
  if (campaign.decision?.selected) {
    const recap = planRecap(campaign);
    if (recap) stageContent.append(recap);
  }
  const video = campaignPackage.files.find((item) => item.mediaType?.startsWith("video/"));
  if (video) {
    const player = node("video", "campaign-video");
    player.controls = true;
    player.preload = "metadata";
    player.src = video.url;
    stageContent.append(player);

    const download = node("a", "button secondary download-video", "Download video");
    download.href = video.url;
    download.download = "hirebit-campaign.mp4";
    stageContent.append(download);
  }
  stageContent.append(dataGrid([
    ["PACKAGE", productDisplayName(campaignPackage.summary.selectedProduct.id, campaignPackage.summary.selectedProduct.name)],
    ["SPEND", `${campaignPackage.summary.spend.spentSats} sats`],
    ["REMAINING", `${campaignPackage.summary.spend.remainingBudgetSats} sats`],
  ]));
}

function showActions(...buttons) {
  clear(actionBar);
  actionBar.append(...buttons);
  actionBar.classList.remove("hidden");
}

function render(delegation) {
  active = delegation;
  localStorage.setItem("activeDelegationId", delegation.id);
  activeId.textContent = stateLabels[delegation.state] ?? "IN PROGRESS";
  clear(stageContent);
  clear(actionBar);
  actionBar.classList.add("hidden");
  stageContent.className = "stage-content";
  updateStages(delegation);
  if (delegation.state === "declined") renderDeclined(delegation);
  else if (delegation.state === "clarification_required") renderQuestions(delegation);
  else if (delegation.state === "approval_required") renderMandate(delegation);
  else if (["advisory_ready", "awaiting_purchase_confirmation"].includes(delegation.state)) renderDecision(delegation);
  else if (delegation.state === "execution_paused"
    || ["spend_blocked", "order_failed", "payment_preparation_failed"].includes(delegation.campaign?.state)) {
    renderExecutionPaused(delegation);
  }
  else if (delegation.state === "completed" || stageFor(delegation) === "package") renderPackage(delegation);
  else if (stageFor(delegation) === "payment") renderPayment(delegation);
  else if (stageFor(delegation) === "production") renderProduction(delegation);
  else if (delegation.campaign) renderDecision(delegation);
  else {
    stageContent.append(title("UNDERSTANDING YOUR BRIEF", "Building a clear campaign plan"));
    if (delegation.lastError) stageContent.append(node("div", "notice", "We couldn’t finish understanding the brief. Your information is safe—try again."));
    if (delegation.state === "interpretation_failed") {
      const retry = node("button", "button primary", "Retry interpretation");
      retry.addEventListener("click", () => act(`/v1/delegations/${encodeURIComponent(delegation.id)}/retry-interpretation`, {}));
      showActions(retry);
    }
  }
  schedulePoll(delegation);
}

async function act(path, payload) {
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(payload) });
    render(result);
    await loadRecent();
    toast("Workflow updated");
    return true;
  } catch (error) {
    toast(error.message, true);
    if (active?.id) await loadDelegation(active.id, true);
    return false;
  }
}

async function loadDelegation(id, quiet = false) {
  try {
    const delegation = await api(`/v1/delegations/${encodeURIComponent(id)}`);
    render(delegation);
  } catch (error) {
    if (!quiet) toast(error.message, true);
  }
}

async function loadRecent() {
  if (!recentList) return;
  try {
    const { delegations } = await api("/v1/delegations?limit=8");
    clear(recentList);
    if (!delegations.length) recentList.append(node("p", "empty", "No mandates yet."));
    for (const item of delegations) {
      const button = node("button", "recent-item");
      const copy = node("span");
      copy.append(node("strong", "", item.mandate?.subject ?? item.input.request), node("small", "", new Date(item.updatedAt).toLocaleString()));
      button.append(copy, node("span", "state-pill", item.state.replaceAll("_", " ")));
      button.addEventListener("click", () => loadDelegation(item.id));
      recentList.append(button);
    }
  } catch (error) { recentList.replaceChildren(node("p", "empty", error.message)); }
}

function schedulePoll(delegation) {
  clearTimeout(pollTimer);
  if (["completed", "cancelled", "declined", "clarification_required", "approval_required", "awaiting_purchase_confirmation", "advisory_ready", "execution_paused", "interpretation_failed", "campaign_failed"].includes(delegation.state)) return;
  pollTimer = setTimeout(async () => {
    try {
      const next = delegation.campaignId
        ? await api(`/v1/delegations/${encodeURIComponent(delegation.id)}/sync`, { method: "POST", body: "{}" })
        : await api(`/v1/delegations/${encodeURIComponent(delegation.id)}`);
      render(next);
      await loadRecent();
    } catch { schedulePoll(delegation); }
  }, 3500);
}

async function readiness() {
  try {
    const status = await api("/ready", { acceptStatuses: [503] });
    const box = $("#readiness");
    const simulated = status.buyer?.wallet?.simulated === true;
    if (box) {
      box.classList.toggle("degraded", !status.ready);
      box.querySelector("span:last-child").textContent = status.ready
        ? (simulated ? "Preview ready" : "All systems ready")
        : "Setup incomplete";
    }
    document.querySelector('[data-stage="payment"] b').textContent = simulated ? "Preview" : "Bitcoin";
    document.querySelector('[data-stage="payment"] small').textContent = "Authorize";
  } catch {
    if ($("#readiness")) $("#readiness").classList.add("degraded");
  }
}

$("#delegation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector("button[type=submit]");
  const submitLabel = submit.querySelector("span:first-child");
  submit.disabled = true;
  submitLabel.textContent = "Interpreting…";
  try {
    const request = $("#request").value.trim();
    const image = selectedImage();
    const videoUrl = referenceVideoUrl();
    let referenceUploadId = image ? null : reusableReferenceUploadId;
    const uploadImage = image ?? (referenceUploadId ? null : await demoProductImage());
    if (uploadImage) {
      submitLabel.textContent = "Uploading image…";
      const upload = await api("/v1/uploads/product-image", {
        method: "POST",
        headers: { "content-type": uploadImage.type },
        body: uploadImage,
      });
      referenceUploadId = upload.id;
      reusableReferenceUploadId = referenceUploadId;
      submitLabel.textContent = "Interpreting…";
    }
    const context = {
      platform: $("#platform").value,
      purchaseMode: selectedPurchaseMode,
      ...(referenceUploadId ? { referenceUploadId } : {}),
      ...(videoUrl ? { referenceVideoUrl: videoUrl } : {}),
    };
    const delegation = await api("/v1/delegations", {
      method: "POST",
      headers: { "idempotency-key": `console-${crypto.randomUUID()}` },
      body: JSON.stringify({ request, context }),
    });
    render(delegation);
    await loadRecent();
    if (window.matchMedia("(max-width: 760px)").matches) {
      document.querySelector(".signature-panel").scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
    }
    toast("Buyer accepted the delegation");
  } catch (error) { toast(error.message, true); }
  finally {
    submit.disabled = false;
    submitLabel.textContent = "Start";
  }
});

document.querySelectorAll(".preset").forEach((button) => {
  button.addEventListener("click", () => selectPreset(button.dataset.preset));
});
$("#request").addEventListener("input", updateCharacterCount);
$("#product-image-file").addEventListener("change", updateImageName);
$("#platform").addEventListener("change", updateReferenceVideoHint);
selectPreset("auto");
updateImageName();

try { await loginFromFragment(); } catch (error) { toast(error.message, true); }
await readiness();
await loadRecent();
const saved = localStorage.getItem("activeDelegationId");
if (saved) await loadDelegation(saved, true);
