// Documentary — Railway cron schedules are the actual triggers
export const RECEIPT_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const TRACKING_POLL_INTERVAL_MS = 30 * 60 * 1000;

// 5-minute replay window for webhook HMAC verification
export const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;

export const MAX_RETRIES = 3;

// Per-blueprint flat print cost (USD). Checked 2026-05-09 against CLAUDE.md.
// Update when adding new blueprints.
export const BLUEPRINT_PRINT_COST_USD: Record<number, number> = {
  6: 8.5, // Gildan 64000 t-shirt
};

// Etsy fee components per CLAUDE.md "Estimated Per-Unit Economics"
export const ETSY_FEE_TRANSACTION_PCT = 0.065;
export const ETSY_FEE_PROCESSING_PCT = 0.03;
export const ETSY_FEE_PROCESSING_FIXED_USD = 0.25;
export const ETSY_FEE_LISTING_USD = 0.2;
