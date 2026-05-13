"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface SpendChartProps {
  data: {
    day: string;
    fal_spend_usd: number;
    anthropic_spend_usd: number;
    etsy_fees_usd: number;
    margin_usd: number;
  }[];
}

const cssVar = (v: string) => `var(${v})`;

export function SpendChart({ data }: SpendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={cssVar("--surface-line")} strokeDasharray="2 4" />
        <XAxis
          dataKey="day"
          tickFormatter={(d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          stroke={cssVar("--text-muted")}
          fontSize={11}
        />
        <YAxis
          yAxisId="cost"
          stroke={cssVar("--text-muted")}
          fontSize={11}
          tickFormatter={(v) => `$${v}`}
        />
        <YAxis
          yAxisId="margin"
          orientation="right"
          stroke={cssVar("--accent-good")}
          fontSize={11}
          tickFormatter={(v) => `$${v}`}
        />
        <Tooltip
          contentStyle={{
            background: cssVar("--surface-2"),
            border: `1px solid ${cssVar("--surface-line")}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(d) => new Date(d).toLocaleDateString()}
          formatter={(value: number) => `$${value.toFixed(2)}`}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area
          yAxisId="cost"
          type="monotone"
          dataKey="fal_spend_usd"
          name="fal.ai"
          stackId="cost"
          stroke={cssVar("--accent-warm")}
          fill={cssVar("--accent-warm")}
          fillOpacity={0.25}
        />
        <Area
          yAxisId="cost"
          type="monotone"
          dataKey="anthropic_spend_usd"
          name="Anthropic"
          stackId="cost"
          stroke={cssVar("--accent-cool")}
          fill={cssVar("--accent-cool")}
          fillOpacity={0.25}
        />
        <Area
          yAxisId="cost"
          type="monotone"
          dataKey="etsy_fees_usd"
          name="Etsy fees"
          stackId="cost"
          stroke={cssVar("--accent-warn")}
          fill={cssVar("--accent-warn")}
          fillOpacity={0.2}
        />
        <Line
          yAxisId="margin"
          type="monotone"
          dataKey="margin_usd"
          name="Margin"
          stroke={cssVar("--accent-good")}
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
