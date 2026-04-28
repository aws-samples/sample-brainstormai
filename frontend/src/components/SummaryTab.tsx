import { useEffect, useState } from "react";
import {
  SpaceBetween,
  Button,
  Container,
  Header,
  Box,
  Alert,
  Spinner,
  ColumnLayout,
  Select,
  FormField,
  ExpandableSection,
  StatusIndicator,
} from "@cloudscape-design/components";
import { api } from "../api/client";

interface Highlight {
  title: string;
  detail: string;
}

interface SummaryData {
  tldr: string;
  key_points: string[];
  highlights: Highlight[];
}

interface Artifact {
  artifactId: string;
  type: string;
  createdAt: string;
  summary?: SummaryData;
}

interface Props {
  notebookId: string;
  notebookStatus: string;
  onJobCreated: (jobId: string) => void;
  refreshKey: number;
}

const DEPTHS = [
  { label: "Brief", value: "brief" },
  { label: "Important Points", value: "important_points" },
  { label: "In-Depth", value: "in_depth" },
];

type LoadState = "idle" | "loading" | "generating" | "ready" | "error";

export default function SummaryTab({ notebookId, notebookStatus, onJobCreated, refreshKey }: Props) {
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryArtifact, setSummaryArtifact] = useState<Artifact | null>(null);
  const [depth, setDepth] = useState("important_points");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadLatestSummary();
  }, [refreshKey]);

  const loadLatestSummary = async () => {
    setLoadState("loading");
    setError("");
    try {
      const [artifactsData, jobsData] = await Promise.all([
        api.get<{ artifacts: Artifact[] }>(`/notebooks/${notebookId}/artifacts`),
        api.get<{ jobs: { type: string; status: string }[] }>(`/notebooks/${notebookId}/jobs`),
      ]);

      const summaries = artifactsData.artifacts.filter((a) => a.type === "summary");
      if (summaries.length > 0) {
        const detail = await api.get<Artifact>(
          `/notebooks/${notebookId}/artifacts/${summaries[0].artifactId}`
        );
        setSummaryArtifact(detail);
        setSummary(detail.summary ?? null);
        setLoadState("ready");
        return;
      }

      // No completed summary — check if one is in-flight
      const inFlight = jobsData.jobs.some(
        (j) => j.type === "summary" && (j.status === "QUEUED" || j.status === "RUNNING")
      );
      if (inFlight) {
        setLoadState("generating");
      } else {
        setLoadState("idle");
      }
    } catch {
      setLoadState("error");
      setError("Failed to load summary.");
    }
  };

  const generate = async () => {
    setError("");
    setSubmitting(true);
    try {
      const job = await api.post<{ jobId: string }>(`/notebooks/${notebookId}/jobs`, {
        type: "summary",
        params: { depth },
      });
      onJobCreated(job.jobId);
      setLoadState("generating");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start summary generation");
    } finally {
      setSubmitting(false);
    }
  };

  const notebookReady = notebookStatus === "READY";

  return (
    <SpaceBetween size="l">
      {/* Generate / regenerate controls */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              loadState === "ready" ? (
                <Button onClick={generate} loading={submitting} disabled={!notebookReady}>
                  Regenerate
                </Button>
              ) : undefined
            }
          >
            AI Summary
          </Header>
        }
      >
        {error && <Alert type="error">{error}</Alert>}

        {!notebookReady && (
          <Alert type="info">
            Sources are still being processed. The summary will use all sources once ingestion is complete — wait for the Sources tab to show all sources as READY before generating.
          </Alert>
        )}

        {loadState === "loading" && (
          <Box textAlign="center" padding="l">
            <Spinner /> <Box variant="p" color="text-body-secondary" padding={{ top: "s" }}>Loading…</Box>
          </Box>
        )}

        {loadState === "generating" && (
          <StatusIndicator type="in-progress">
            Generating summary… You'll be notified when it's ready.
          </StatusIndicator>
        )}

        {loadState === "idle" && (
          <SpaceBetween size="m">
            {!notebookReady && (
              <Alert type="info">
                Sources are still being processed. Wait for all sources to reach READY status before generating.
              </Alert>
            )}
            <ColumnLayout columns={2}>
              <FormField label="Depth">
                <Select
                  selectedOption={DEPTHS.find((d) => d.value === depth)!}
                  onChange={(e) => setDepth(e.detail.selectedOption.value!)}
                  options={DEPTHS}
                />
              </FormField>
            </ColumnLayout>
            <Button variant="primary" loading={submitting} disabled={!notebookReady} onClick={generate}>
              Generate summary
            </Button>
          </SpaceBetween>
        )}

        {loadState === "ready" && summary && (
          <SpaceBetween size="l">
            {/* TLDR */}
            <Box>
              <Box variant="awsui-key-label">Overview</Box>
              <Box variant="p">{summary.tldr}</Box>
            </Box>

            {/* Key points */}
            {summary.key_points?.length > 0 && (
              <Box>
                <Box variant="awsui-key-label" padding={{ bottom: "xs" }}>Key Points</Box>
                <SpaceBetween size="xxs">
                  {summary.key_points.map((pt, i) => (
                    <Box key={i} variant="p">
                      <span style={{ marginRight: 8, color: "#0972d3", fontWeight: 700 }}>•</span>
                      {pt}
                    </Box>
                  ))}
                </SpaceBetween>
              </Box>
            )}

            {/* Highlights */}
            {summary.highlights?.length > 0 && (
              <Box>
                <Box variant="awsui-key-label" padding={{ bottom: "xs" }}>Highlights</Box>
                <SpaceBetween size="xs">
                  {summary.highlights.map((h, i) => (
                    <ExpandableSection key={i} headerText={h.title} variant="default">
                      <Box variant="p" color="text-body-secondary">{h.detail}</Box>
                    </ExpandableSection>
                  ))}
                </SpaceBetween>
              </Box>
            )}

            {summaryArtifact && (
              <Box color="text-body-secondary" fontSize="body-s">
                Generated {new Date(summaryArtifact.createdAt).toLocaleString()}
              </Box>
            )}
          </SpaceBetween>
        )}
      </Container>
    </SpaceBetween>
  );
}
