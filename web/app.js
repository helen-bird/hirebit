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

const DEMO_PRODUCT_IMAGE_URL = "/console/demo-product.jpeg";
const DEMO_VIDEO_URL = "https://www.tiktok.com/@bilintinamakeup/video/6798977602963918085";

const presets = {
  auto: {
    platform: "TikTok",
    purchaseMode: "auto_within_budget",
    request: "Create a conversion-focused TikTok launch video for Tick cotton swabs, designed for makeup users who want precise, easy cleanup. Use an energetic United States English voice and product-led visuals. Keep spend under 2,000 sats and deliver within 60 minutes.",
  },
  confirm: {
    platform: "TikTok",
    purchaseMode: "confirm_before_purchase",
    request: "Create a conversion-focused TikTok launch video for Tick cotton swabs, designed for makeup users who want precise, easy cleanup. Use an energetic United States English voice and product-led visuals. Keep spend under 2,000 sats and deliver within 60 minutes.",
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
  stageContent.append(title("AGENT COMPARISON", "Finding the best fit", "4 PACKAGES"));
  const scan = node("div", "comparison-scan");
  for (const [index, name] of ["Creator Pitch", "Proof Demo", "Ranking / Listicle", "Two-person Podcast"].entries()) {
    const item = node("div", "comparison-scan-item");
    item.style.setProperty("--scan-delay", `${index * 0.18}s`);
    item.append(node("span", "scan-dot"), node("strong", "", name), node("small", "", "Checking fit and price"));
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

function candidateReason(candidate, selectedId) {
  if (candidate.productId === selectedId) {
    return `Best fit · ${candidate.quote.estimatedTurnaroundMinutes} min delivery`;
  }
  if (candidate.eligible) return `Meets the brief · ${candidate.quote.estimatedTurnaroundMinutes} min delivery`;
  const reasons = candidate.rejections?.map((reason) => rejectionLabels[reason] ?? null).filter(Boolean) ?? [];
  if (reasons.length > 0) return [...new Set(reasons)].join(" · ");
  if (candidate.error?.message) return candidate.error.message;
  return "Does not satisfy the approved brief";
}

function renderDecision(delegation, { transient = false } = {}) {
  const campaign = delegation.campaign;
  const decision = campaign?.decision;
  if (!decision) {
    renderComparisonProgress(delegation);
    return;
  }
  const matched = decision.candidates.filter((candidate) => candidate.eligible).length;
  stageContent.append(title(
    "AGENT COMPARISON",
    "Best fit selected",
    `${decision.candidates.length} CHECKED · ${matched} MATCH${matched === 1 ? "" : "ES"}`,
  ));
  const best = node("div", "best-fit-card");
  const bestCopy = node("div");
  bestCopy.append(
    node("span", "best-fit-label", "BEST FIT"),
    node("h3", "", decision.selected.productName),
    node("p", "", decision.rationale),
  );
  best.append(bestCopy, node("strong", "best-fit-price", `${decision.selected.quote.amountSats.toLocaleString()} sats`));
  stageContent.append(best);
  const list = node("div", "candidate-list");
  for (const candidate of decision.candidates) {
    const selected = candidate.productId === decision.selected.productId;
    const card = node("div", `candidate${selected ? " selected" : ""}${candidate.eligible ? "" : " rejected"}`);
    const head = node("div", "candidate-head");
    const status = selected ? "SELECTED" : candidate.eligible ? "MATCH" : "NOT A FIT";
    const price = candidate.quote ? `${candidate.quote.amountSats.toLocaleString()} sats` : "—";
    const result = node("div", "candidate-result");
    result.append(node("span", "candidate-status", status), node("span", "price", price));
    head.append(node("h3", "", candidate.productName), result);
    card.append(head, node("small", "", candidateReason(candidate, decision.selected.productId)));
    list.append(card);
  }
  stageContent.append(list);
  if (!transient && delegation.state === "awaiting_purchase_confirmation") {
    const confirm = node("button", "button confirm", `Approve ${decision.selected.productName} · ${decision.selected.quote.amountSats.toLocaleString()} sats`);
    confirm.addEventListener("click", () => act(`/v1/delegations/${encodeURIComponent(delegation.id)}/confirm-purchase`, {}));
    showActions(confirm);
  }
}

function renderPayment(delegation) {
  const campaign = delegation.campaign;
  const payment = campaign.sellerOrder?.payment ?? {};
  const simulated = payment.simulated === true || campaign.paymentAttempt?.receipt?.simulated === true;
  stageContent.append(title(simulated ? "PAYMENT PREVIEW" : "BITCOIN PAYMENT", "Authorizing the selected package"));
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

function renderProduction(delegation) {
  const campaign = delegation.campaign;
  const production = campaign.sellerOrder?.production ?? {};
  const simulated = campaign.sellerOrder?.payment?.simulated === true;
  stageContent.append(title("VIDEO PRODUCTION", simulated ? "Your campaign is being created" : "Payment unlocked production"));
  stageContent.append(dataGrid([
    ["PAYMENT", campaign.sellerOrder?.payment?.authorization ?? "pending"],
    ["PRODUCTION", production.state ?? "queued"],
  ]));
  const note = node("div", "payment-card");
  const copy = node("div");
  copy.append(node("h3", "", simulated ? "Preview authorization received" : "Payment is necessary"), node("p", "", simulated
    ? "Hypit was unlocked by a preview receipt; no Bitcoin moved."
    : "Hypit fulfillment remains locked until GoBTC reports status=paid."));
  note.append(copy, node("div", "amount", "HYPIT"));
  stageContent.append(note);
  if (campaign.lastError) stageContent.append(node("div", "notice", "Production paused before completion. You can safely retry the same order."));
  if (campaign.state === "fulfillment_failed") {
    const retry = node("button", "button secondary", "Retry the existing paid fulfillment");
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
    stageContent.append(node(
      "div",
      "decision-recap",
      `Compared ${campaign.decision.candidates.length} offers · Selected ${campaign.decision.selected.productName} at ${campaign.decision.selected.quote.amountSats.toLocaleString()} sats`,
    ));
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
    ["PACKAGE", campaignPackage.summary.selectedProduct.name],
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
    const revealDecision = /\/confirm$/u.test(path) && payload?.approved === true && result.campaign?.decision;
    if (revealDecision && result.state !== "awaiting_purchase_confirmation") {
      active = result;
      clear(stageContent);
      clear(actionBar);
      actionBar.classList.add("hidden");
      updateStages(result, "decision");
      renderDecision(result, { transient: true });
      await new Promise((resolve) => setTimeout(resolve, 2200));
    }
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
  if (["completed", "cancelled", "declined", "clarification_required", "approval_required", "awaiting_purchase_confirmation", "advisory_ready", "interpretation_failed", "campaign_failed"].includes(delegation.state)) return;
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
