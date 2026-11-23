/** Satora / Lendaswap swap statuses, grouped once for every flow (escrow funding and `mark swap`). */
/** Waiting for the payment: the only state in which an invoice / address is shown as payable. */
export const SWAP_UNPAID = new Set(["pending"]);
/** Paid, the provider is funding its side: keep waiting, never pay again. */
export const SWAP_PAID = new Set(["clientfundingseen", "clientfunded"]);
/** Unpaid or paid-but-not-funded: still in progress. */
export const SWAP_WAITING = new Set([...SWAP_UNPAID, ...SWAP_PAID]);
/** The provider's side holds the funds: claimable. clientredeeming = a claim was started but not finished (resume it). */
export const SWAP_CLAIMABLE = new Set(["serverfunded", "clientredeeming"]);
export const SWAP_DONE = new Set(["clientredeemed", "serverredeemed"]);
/** Final states in which nothing was (or will be) paid out to the target. */
export const SWAP_FAILED = new Set(["expired", "clientrefunded", "clientfundedserverrefunded", "clientrefundedserverfunded", "clientrefundedserverrefunded", "serverwontfund", "clientinvalidfunded", "clientfundedtoolate"]);
