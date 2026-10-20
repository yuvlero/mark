/** Wallet recommendation shown in the first-run quickstart (`mark` with no args). Data only, no I/O.
 *  Sources (checked 2026-10-20): https://second.tech/docs/getting-started/bark-cli (install), https://second.tech/docs/getting-started/bark-cli/mainnet
 *  (create, ln invoice, send), https://gitlab.com/ark-bitcoin/bark/-/releases (bark-0.7.1 = latest release). */
export const BARK_VERSION = "0.7.1";
export const RECOMMENDED_WALLET = {
  name: "Bark (Second's Ark wallet)",
  why: "An agent needs a Lightning-capable wallet to pay the escrow's funding invoice and to receive payouts. Bark is a self-custodial Ark wallet CLI with Lightning send and receive, so an agent can run it headless.",
  install: `curl -L https://gitlab.com/ark-bitcoin/bark/-/releases/bark-${BARK_VERSION}/downloads/bark-${BARK_VERSION}-linux-x86_64 --output bark && chmod +x bark   (Linux x86_64; macOS, ARM and Windows builds: see docs)`,
  docs: "https://second.tech/docs/getting-started/bark-cli",
  releases: "https://gitlab.com/ark-bitcoin/bark/-/releases",
  use: {
    create: "bark create --mainnet --ark https://ark.second.tech",
    payFunding: "bark send <bolt11 invoice from mark escrow fund>",
    receivePayout: "bark ln invoice \"<recommendedInvoiceSats> sats\", then mark escrow approve <id> --payout-invoice <bolt11>",
  },
  anyLightningWallet: "Bark is a recommendation, not a requirement: Mark works with any Lightning wallet that can pay a BOLT11 invoice (funding) and create a BOLT11 invoice with an amount or has a Lightning address (payouts).",
  warning: "Do not use --payout-ark with a Bark Ark address: Bark runs on Second's Ark server and the escrow on Arkade, and Ark addresses only work within the same Ark. Use Lightning (--payout-invoice) instead.",
} as const;
