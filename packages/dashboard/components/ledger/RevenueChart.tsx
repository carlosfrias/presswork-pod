"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface RevenueChartProps {
  data: {
    day: string;
    revenue_usd: number;
    etsy_fees_usd: number;
    margin_usd: number;
  }[];
}

const v = (n: string) => `var(${n})`;

export function RevenueChart({ data }: RevenueChartProps) {
  const enriched = data.map((d) => ({
    ...d,
    print_cost_usd: Math.max(
      0,
      d.revenue_usd - d.etsy_fees_usd - d.margin_usd,
    ),
  }));
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={enriched} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={v("--surface-line")} strokeDasharray="2 4" />
        <XAxis
          dataKey="day"
          tickFormatter={(d) =>
            new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          }
          stroke={v("--text-muted")}
          fontSize={11}
        />
        <YAxis stroke={v("--text-muted")} fontSize={11} tickFormatter={(n) => `$${n}`} />
        <Tooltip
          contentStyle={{
            background: v("--surface-2"),
            border: `1px solid ${v("--surface-line")}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(d) => new Date(d).toLocaleDateString()}
          formatter={(value: number) => `$${value.toFixed(2)}`}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area
          type="monotone"
          dataKey="margin_usd"
          name="Margin"
          stackId="rev"
          stroke={v("--accent-good")}
          fill={v("--accent-good")}
          fillOpacity={0.5}
        />
        <Area
          type="monotone"
          dataKey="print_cost_usd"
          name="Print cost"
          stackId="rev"
          stroke={v("--accent-cool")}
          fill={v("--accent-cool")}
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="etsy_fees_usd"
          name="Etsy fees"
          stackId="rev"
          stroke={v("--accent-warn")}
          fill={v("--accent-warn")}
          fillOpacity={0.25}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
