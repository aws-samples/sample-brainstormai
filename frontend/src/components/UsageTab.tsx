import { useEffect, useState } from "react";
import {
  Box,
  SpaceBetween,
  Spinner,
  Alert,
  Container,
  Header,
} from "@cloudscape-design/components";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { api } from "../api/client";

interface UsageBreakdown {
  type: string;
  tokens: number;
}

interface DayUsage {
  date: string;
  breakdown: UsageBreakdown[];
  total: number;
}

interface UsageResponse {
  days: DayUsage[];
  breakdown: UsageBreakdown[];
  total: number;
}

interface Props {
  refreshKey: number;
  notebookId?: string;
}

const TYPE_COLORS: Record<string, string> = {
  podcast: "#0972d3",
  mindmap: "#037f0c",
  quiz:    "#7b2d8b",
  summary: "#c44d00",
};
const FALLBACK_COLORS = ["#00788a", "#5a4fcf", "#c01818"];

function colorFor(type: string, i: number) {
  return TYPE_COLORS[type] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

interface TooltipPayload { name: string; value: number }

function CustomTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div style={{
      background: "var(--color-background-container-content)",
      border: "1px solid var(--color-border-container-top)",
      borderRadius: 8,
      padding: "8px 14px",
      fontFamily: "var(--font-family-base)",
      fontSize: "var(--font-size-body-s)",
      color: "var(--color-text-body-primary)",
      boxShadow: "var(--shadow-container)",
    }}>
      <div style={{ fontWeight: "var(--font-weight-bold)" as React.CSSProperties["fontWeight"] }}>
        {name.charAt(0).toUpperCase() + name.slice(1)}
      </div>
      <div>{formatTokens(value)} tokens</div>
    </div>
  );
}

function DayChart({ day }: { day: DayUsage }) {
  const chartData = day.breakdown.map((b) => ({ name: b.type, value: b.tokens }));
  return (
    <Container header={<Header variant="h3">{formatDate(day.date)} — {formatTokens(day.total)} tokens</Header>}>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={90}
            paddingAngle={3}
            dataKey="value"
            nameKey="name"
            strokeWidth={0}
          >
            {chartData.map((entry, i) => (
              <Cell key={entry.name} fill={colorFor(entry.name, i)} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend
            formatter={(value: string) => (
              <span style={{
                fontFamily: "var(--font-family-base)",
                fontSize: "var(--font-size-body-s)",
                color: "var(--color-text-body-primary)",
              }}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
                {" — "}
                {formatTokens(day.breakdown.find((b) => b.type === value)?.tokens ?? 0)}
              </span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </Container>
  );
}

export default function UsageTab({ refreshKey, notebookId }: Props) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, [refreshKey, notebookId]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const url = notebookId ? `/usage?notebookId=${notebookId}` : "/usage";
      const res = await api.get<UsageResponse>(url);
      setData(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <Box textAlign="center" padding="xxl"><Spinner size="large" /></Box>;
  if (error)   return <Alert type="error">{error}</Alert>;
  if (!data || data.total === 0) {
    return (
      <Box textAlign="center" padding="xxl" color="text-body-secondary">
        No completed jobs yet — token usage will appear here after your first generation.
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Box>
        <Box variant="awsui-key-label">Total tokens used</Box>
        <Box fontSize="display-l" fontWeight="bold">{formatTokens(data.total)}</Box>
      </Box>

      <SpaceBetween size="m">
        <Header variant="h3">Daily breakdown</Header>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 16,
        }}>
          {data.days.map((day) => (
            <DayChart key={day.date} day={day} />
          ))}
        </div>
      </SpaceBetween>
    </SpaceBetween>
  );
}
