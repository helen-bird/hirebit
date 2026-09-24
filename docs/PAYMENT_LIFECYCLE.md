# Payment, cancellation and dispute lifecycle

This is the implementation boundary, not a claim that Hirebit is a licensed escrow or a
production-ready refund operator. GoBTC's `paid` status is the provider's accepted instant
authorization. Seller production may start then; `paidAt` and transaction IDs can arrive later
with batch settlement. For the registered Buyer instant-wallet flow, BTC remains in the Buyer's
multisig UTXO until settlement, subject to the
provider's signing/recovery rules. No on-chain transaction or Seller receipt is inferred from a
platform receipt alone.

The advertised package price is the Buyer's **maximum total wallet debit**, inclusive of the
Bitcoin network fee. Seller quotes a lower invoice and absorbs a bounded fee allowance in its
margin; unused allowance remains in the Buyer wallet. The Buyer checks the actual PSBT fee
against both that quote-specific allowance and its policy before signing. If the fee is too high,
payment pauses before submission; the Buyer must receive a new quote and, where required,
confirm the changed purchase. Neither rail pretends that a real Bitcoin miner fee is zero.
Automatic replacement of an already-issued GoBTC invoice is not implemented: the Buyer may safely
recheck the same unpaid order when fees change, but a higher-priced replacement requires
provider-confirmed terminal status for the original invoice before a new quote/order is allowed.

| Event | Hirebit action | Remaining money or work risk |
| --- | --- | --- |
| Buyer asks to cancel before order/payment | Stop the local purchasing path and release the reservation | No Seller order should be created unless an already-running request was in flight |
| Order exists; GoBTC has not confirmed payment | Persist a Seller production stop, retain payment reconciliation, and show cancellation pending | An invoice or payment submission may still be in flight; expiry on Hirebit's clock is not proof GoBTC cancelled it |
| GoBTC says `paid` after the stop, before billable production | Never start production; record the service price as refund review required | Network fees already incurred are not promised back; BTC refund is a separate outgoing payment and has **not** been sent |
| Buyer requests cancellation after production starts | Preserve the running build and enter cost review | Only documented, actually incurred costs may be deducted; the remainder is refund-eligible after review. A provider job already running may be impossible to stop immediately |
| Seller delivery is disputed within 72 hours | Record the delivered file, expected and observed result, optional timecode, package-manifest hash, and maximum quality refund for review | No free rework is included. An approved quality refund is limited to 20% of the service price; the current app records the case but does not yet adjudicate or send a refund |
| Payment outcome is uncertain | Keep the spend reservation, reconcile the original GoBTC payment, never blindly resubmit | Human intervention remains necessary if provider evidence conflicts or is unavailable |
| Invoice is `paid` without a matching Buyer submission receipt | Pause Buyer accounting and repeat payment attempts; review who funded the invoice | The Seller may have received outside-wallet funds; `paid` alone cannot establish a debit from this Buyer or identify the proper refund owner |
| Invoice creation response is lost, then the idempotent retry returns an already-paid invoice | Link the existing Seller order but pause Buyer signing and accounting for payer-source review | The original payment may be external or an earlier uncertain Buyer submission; no second invoice or signature is attempted |
| GoBTC later reports chain settlement | Add `paidAt` and transaction IDs; do not charge or produce again | Provider settlement evidence is not an independent chain audit |

The Seller stop request and production claim use the same durable transaction, so only one can
win the pre-start race. The Buyer checks cancellation again at the final submit gate, after
preparing a signed payment. A request after that gate cannot unsend the submission; the Seller
stop still prevents new production where possible and the resulting payment is reconciled.
After production starts, cancellation persists a stop marker. The production adapter checks both
the durable Seller cancellation state and the marker before later paid copy, voice, Veo and Hypit
Build steps. This is best effort: an external
request already sent cannot be assumed stopped, and a request racing between the check and the
provider call may still incur a charge. Those costs require evidence at the recorded cutoff.
Veo and Hypit Build submissions retain durable provider IDs for reattachment; an ambiguous
Hypit submission without an ID blocks automatic resubmission. Seller-side copy, voice, reference
analysis and Veo segments may each make at most two provider attempts for the same work item,
with durable counters across restarts. Seller absorbs any duplicate supplier cost; this never
creates a second Buyer payment or raises the agreed price. A recovered Veo operation ID is polled
rather than submitted again. After both attempts fail, or after an ambiguous Hypit Build with no
recoverable ID, fulfillment remains a Seller-side unresolved obligation rather than a completed
delivery. Intake interpretation permits at
most 10 reserved attempts per brief per rolling hour; a client timeout may still have incurred a
provider charge, so this is a cost bound rather than exactly-once billing.
Package downloads compare the opened file with its recorded size and SHA-256 before serving it.
This prevents a partially refreshed or altered file from being delivered as the approved package;
it does not create a separate immutable media archive or restore missing bytes.
New Seller exports carry a size and SHA-256 that are checked at both Seller download and Buyer
packaging. Shareable payment proof omits the GoBTC payment ID, which the official guide treats as
a read token; older previously generated packages have not been rewritten.
Cancellation and refund records explicitly say `not_issued` until an actual outbound payment is
implemented and verified. The refund amount is the service price before production; a production-
started cancellation case has no automatic refund amount until itemized costs are reviewed. A
completed-delivery quality dispute records a ceiling of `floor(servicePriceSats / 5)` when the
original Seller order amount is available; this is a ceiling, not an approved or issued refund.
Review should
count costs incurred before the request and unavoidable charges already committed by then; later
avoidable costs belong to the Seller. Never subtract a fixed percentage without evidence.

Current commercial gaps: this is a single-customer preview with a shared access token, not
independently authenticated customer accounts. There is no independent case authorization, operator
adjudication UI/workflow, no durable itemized-cost evidence ingestion, no Seller-controlled
outgoing refund wallet and verified refund destination, and
no verified live GoBTC settlement/refund tests. Real BTC refunds must remain disabled until those
are designed, audited and tested. The public demo is still a preview, not an escrow service.
The Hypit social-video downloader caps individual reference files at 1 GB (1,000,000,000 bytes) while downloading and
terminates its process group on overage. Transient muxing may still use up to about 3 GB. The
re-fetchable reference cache evicts older entries before admitting a new file beyond 10 GB;
temporary extraction files and completed order inputs are outside that cache cap. Paid-job
quality checks validate technical media properties but cannot prove that the creative matches the
customer's product or the reference action; such disputes still require human review.

For local operator triage, run `npm run transaction:review -- demo` (or `mainnet` for the
separate real-payment state files). This is read-only and prints case IDs and action categories,
not payment IDs, wallet addresses, API tokens, PSBTs or customer brief text. It flags pending
refund/cost reviews, disputes, uncertain or unattributed payments, failed or stalled paid production, unconfirmed
invoice expiry and non-simulated settlement still pending after 24 hours. A settlement flag is
only a follow-up prompt, not proof of provider failure: the published ~12-hour figure is an
average, not a deadline. The command neither retries a payment nor issues a refund.

References: [official build guide](https://pioneers.agnic.ai/build/bitcoin-pay),
[GoBTC Pay](https://gobtcpay.com/).
