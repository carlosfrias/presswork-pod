// Documentary — Railway cron schedule is the actual trigger
export const RECEIPT_POLL_INTERVAL_MS = 30 * 60 * 1000;

// How far back the poll reaches per run. Etsy returns receipts most-recent-first;
// the unique constraint on orders.etsy_order_id makes re-scanning safe.
export const RECEIPT_POLL_PAGE_LIMIT = 100;

// Slack alert threshold (USD). Margin below this on a freshly-logged order
// fires a per-order warning; the daily digest still summarises totals.
export const MARGIN_WARNING_THRESHOLD_USD = 5.0;

// Per-blueprint flat print cost (USD). Update when adding new blueprints.
export const BLUEPRINT_PRINT_COST_USD: Record<number, number> = {
  145: 8.5, // Gildan 64000 t-shirt — must match printify_blueprint_id written by Design (packages/design/constants.py)
};

// Etsy fee components per CLAUDE.md "Per-Unit Economics"
export const ETSY_FEE_TRANSACTION_PCT = 0.065;
export const ETSY_FEE_PROCESSING_PCT = 0.03;
export const ETSY_FEE_PROCESSING_FIXED_USD = 0.25;
export const ETSY_FEE_LISTING_USD = 0.2;

// Static USD conversion rates per ISO 4217 code. Refresh manually when the
// shop expands to new currencies or when a rate drifts >5%. The rates here
// are approximate — exact reporting should use Etsy's payout records.
export const USD_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.25,
  CAD: 0.74,
  AUD: 0.66,
  JPY: 0.0064,
  CHF: 1.13,
  SEK: 0.094,
  NOK: 0.094,
  DKK: 0.145,
  NZD: 0.61,
  MXN: 0.058,
};
