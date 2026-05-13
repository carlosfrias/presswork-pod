"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MarginBucket } from "@/lib/queries/ledger";

const v = (n: string) => `var(${n})`;

export function MarginHistogram({
  buckets,
  threshold,
}: {
  buckets: MarginBucket[];
  threshold: number;
}) {
  const thresholdBucketIdx = buckets.findIndex(
    (b) => threshold >= b.lower && threshold < b.upper,
  );

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={buckets} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={v("--surface-line")} strokeDasharray="2 4" />
        <XAxis dataKey="bucket" stroke={v("--text-muted")} fontSize={11} />
        <YAxis stroke={v("--text-muted")} fontSize={11} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: v("--surface-2"),
            border: `1px solid ${v("--surface-line")}`,
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Bar dataKey="count" fill={v("--accent-warm")} radius={[4, 4, 0, 0]} />
        {thresholdBucketIdx >= 0 && (
          <ReferenceLine
            x={buckets[thresholdBucketIdx].bucket}
            stroke={v("--accent-bad")}
            strokeDasharray="3 3"
            label={{
              value: `≥ $${threshold} threshold`,
              fill: v("--accent-bad"),
              fontSize: 10,
              position: "top",
            }}
          />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
