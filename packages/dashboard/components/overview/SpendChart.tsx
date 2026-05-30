"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface MarginChartProps {
  data: {
    day: string;
    margin_usd: number;
  }[];
}

const cssVar = (v: string) => `var(${v})`;

export function SpendChart({ data }: MarginChartProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={cssVar("--surface-line")} strokeDasharray="2 4" />
        <XAxis
          dataKey="day"
          tickFormatter={(d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          stroke={cssVar("--text-muted")}
          fontSize={11}
        />
        <YAxis
          stroke={cssVar("--text-muted")}
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
          formatter={(value: number) => ["$" + value.toFixed(2), "Margin"]}
        />
        <Area
          type="monotone"
          dataKey="margin_usd"
          name="Margin"
          stroke={cssVar("--accent-good")}
          fill={cssVar("--accent-good")}
          fillOpacity={0.15}
          strokeWidth={2}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
