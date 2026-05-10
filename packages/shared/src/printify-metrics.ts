const RING_SIZE = 200;
const ALERT_THRESHOLD_PCT = 4; // 1 percentage point below Printify's 5% enforcement limit

type Outcome = "success" | "4xx" | "5xx";

// Module-level ring buffer — shared across all calls in a process lifetime
const _ring: Outcome[] = [];

export function _recordPrintifyOutcome(outcome: Outcome): void {
  if (_ring.length >= RING_SIZE) _ring.shift();
  _ring.push(outcome);
}

export interface PrintifyErrorRate {
  sample_size: number;
  error_rate_4xx_pct: number;
  error_rate_5xx_pct: number;
  ok: boolean;
}

export function getPrintifyErrorRate(): PrintifyErrorRate {
  const total = _ring.length;
  if (total === 0) {
    return { sample_size: 0, error_rate_4xx_pct: 0, error_rate_5xx_pct: 0, ok: true };
  }

  let count4xx = 0;
  let count5xx = 0;
  for (const o of _ring) {
    if (o === "4xx") count4xx++;
    else if (o === "5xx") count5xx++;
  }

  const pct = (n: number) => Math.round((n / total) * 10000) / 100;
  const error_rate_4xx_pct = pct(count4xx);
  const error_rate_5xx_pct = pct(count5xx);

  return {
    sample_size: total,
    error_rate_4xx_pct,
    error_rate_5xx_pct,
    ok: error_rate_4xx_pct + error_rate_5xx_pct < ALERT_THRESHOLD_PCT,
  };
}
