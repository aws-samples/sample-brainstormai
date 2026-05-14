import { useEffect, useRef, useState } from "react";
import {
  SpaceBetween,
  Button,
  FormField,
  Select,
  Alert,
  Container,
  Header,
  ColumnLayout,
  Box,
  Table,
  StatusIndicator,
} from "@cloudscape-design/components";
import { api } from "../api/client";

interface Job {
  jobId: string;
  type: string;
  status: string;
  createdAt: string;
  errorMessage?: string;
  params?: Record<string, string>;
}

interface Props {
  notebookId: string;
  notebookStatus: string;
  onJobCreated: (jobId: string) => void;
  onJobCompleted: () => void;
  refreshKey: number;
}

const ARTIFACT_TYPES = [
  { label: "Podcast", value: "podcast" },
  { label: "Mind Map", value: "mindmap" },
  { label: "Quiz", value: "quiz" },
];

const GENRES = [
  { label: "Educational", value: "educational" },
  { label: "Debate", value: "debate" },
  { label: "Sporty", value: "sporty" },
];

const DEPTHS_PODCAST = [
  { label: "Brief (5+ min)", value: "brief" },
  { label: "Important Points (10+ min)", value: "important_points" },
  { label: "In-Depth (18+ min)", value: "in_depth" },
];

const DEPTHS_OTHER = [
  { label: "Brief", value: "brief" },
  { label: "Important Points", value: "important_points" },
  { label: "In-Depth", value: "in_depth" },
];

const LANGUAGES = [
  { label: "English", value: "english" },
  { label: "Hindi", value: "hindi" },
  { label: "Mandarin", value: "mandarin" },
  { label: "Spanish", value: "spanish" },
  { label: "French", value: "french" },
];

const STATUS_INDICATOR: Record<string, "success" | "in-progress" | "pending" | "error" | "stopped"> = {
  QUEUED:    "pending",
  RUNNING:   "in-progress",
  COMPLETED: "success",
  FAILED:    "error",
  CANCELLED: "stopped",
};

export default function JobCreator({ notebookId, notebookStatus, onJobCreated, onJobCompleted, refreshKey }: Props) {
  const [artifactType, setArtifactType] = useState("podcast");
  const [genre, setGenre] = useState("educational");
  const [depth, setDepth] = useState("important_points");
  const [language, setLanguage] = useState("english");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);

  useEffect(() => {
    loadJobs();
  }, [refreshKey]);

  // Poll every 8s while any job is active; fire onJobCompleted on transitions to COMPLETED
  const prevJobsRef = useRef<Job[]>([]);
  useEffect(() => {
    const prev = prevJobsRef.current;
    jobs.forEach((j) => {
      const wasActive = prev.some((p: Job) => p.jobId === j.jobId && (p.status === "QUEUED" || p.status === "RUNNING"));
      if (wasActive && j.status === "COMPLETED") onJobCompleted();
    });
    prevJobsRef.current = jobs;

    const active = jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING");
    if (!active) return;
    const t = setInterval(loadJobs, 8000);
    return () => clearInterval(t);
  }, [jobs]);

  const loadJobs = async () => {
    setLoadingJobs(true);
    try {
      const data = await api.get<{ jobs: Job[] }>(`/notebooks/${notebookId}/jobs`);
      setJobs(data.jobs);
    } finally {
      setLoadingJobs(false);
    }
  };

  const cancelJob = async (jobId: string) => {
    setDeletingJobId(jobId);
    try {
      await api.delete(`/notebooks/${notebookId}/jobs/${jobId}`);
      setJobs((prev) => prev.map((j) => j.jobId === jobId ? { ...j, status: "CANCELLED" } : j));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to cancel job");
    } finally {
      setDeletingJobId(null);
    }
  };

  const notebookReady = notebookStatus === "READY";

  const create = async () => {
    setError("");
    setSuccess("");
    setSubmitting(true);
    try {
      const params: Record<string, string> = { depth };
      if (artifactType === "podcast") {
        params.genre = genre;
        params.language = language;
      }
      const job = await api.post<{ jobId: string; status?: string }>(`/notebooks/${notebookId}/jobs`, {
        type: artifactType,
        params,
      });
      if (job.status === "COMPLETED") {
        onJobCompleted();
        setSuccess(`${artifactType} artifact ready (served from cache).`);
      } else {
        onJobCreated(job.jobId);
        setSuccess(`${artifactType} job queued. You'll be notified when it's ready.`);
      }
      loadJobs();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create job");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={
            <Button
              variant="primary"
              loading={submitting}
              disabled={!notebookReady}
              onClick={create}
            >
              Generate {artifactType}
            </Button>
          }
        >
          Generate artifact
        </Header>
      }
    >
      <SpaceBetween size="m">
        {!notebookReady && (
          <Alert type="info">
            Sources are still being processed. Wait for all sources to reach READY status.
          </Alert>
        )}
        {error && <Alert type="error">{error}</Alert>}
        {success && <Alert type="success">{success}</Alert>}

        <ColumnLayout columns={2}>
          <FormField label="Artifact type">
            <Select
              selectedOption={ARTIFACT_TYPES.find((t) => t.value === artifactType)!}
              onChange={(e) => setArtifactType(e.detail.selectedOption.value!)}
              options={ARTIFACT_TYPES}
            />
          </FormField>

          <FormField label="Depth">
            {(() => {
              const opts = artifactType === "podcast" ? DEPTHS_PODCAST : DEPTHS_OTHER;
              return (
                <Select
                  selectedOption={opts.find((d) => d.value === depth) ?? opts[1]}
                  onChange={(e) => setDepth(e.detail.selectedOption.value!)}
                  options={opts}
                />
              );
            })()}
          </FormField>

          {artifactType === "podcast" && (
            <>
              <FormField label="Genre">
                <Select
                  selectedOption={GENRES.find((g) => g.value === genre)!}
                  onChange={(e) => setGenre(e.detail.selectedOption.value!)}
                  options={GENRES}
                />
              </FormField>
              <FormField label="Language">
                <Select
                  selectedOption={LANGUAGES.find((l) => l.value === language)!}
                  onChange={(e) => setLanguage(e.detail.selectedOption.value!)}
                  options={LANGUAGES}
                />
              </FormField>
            </>
          )}
        </ColumnLayout>
      </SpaceBetween>

      {(jobs.length > 0 || loadingJobs) && (
        <div style={{ marginTop: 24 }}>
        <Container header={<Header variant="h3">Jobs</Header>}>
          <Table
            loading={loadingJobs && jobs.length === 0}
            items={jobs}
            columnDefinitions={[
              {
                id: "type",
                header: "Type",
                cell: (j) => {
                  const label = j.type.charAt(0).toUpperCase() + j.type.slice(1);
                  const p = j.params ?? {};
                  const parts: string[] = [];
                  if (p.depth)    parts.push(p.depth.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
                  if (p.genre)    parts.push(p.genre.charAt(0).toUpperCase() + p.genre.slice(1));
                  if (p.language) parts.push(p.language.charAt(0).toUpperCase() + p.language.slice(1));
                  return parts.length > 0 ? `${label} (${parts.join(" / ")})` : label;
                },
              },
              {
                id: "status",
                header: "Status",
                cell: (j) => (
                  <StatusIndicator type={STATUS_INDICATOR[j.status] ?? "pending"}>
                    {j.status}
                  </StatusIndicator>
                ),
              },
              {
                id: "created",
                header: "Started",
                cell: (j) => new Date(j.createdAt).toLocaleString(),
              },
              {
                id: "error",
                header: "Error",
                cell: (j) => (j.status === "FAILED" || j.status === "CANCELLED") ? (j.errorMessage ?? "—") : "—",
              },
              {
                id: "actions",
                header: "",
                cell: (j) =>
                  j.status === "QUEUED" ? (
                    <Button
                      variant="inline-icon"
                      iconName="close"
                      ariaLabel="Cancel job"
                      loading={deletingJobId === j.jobId}
                      onClick={() => cancelJob(j.jobId)}
                    />
                  ) : null,
              },
            ]}
            empty={<Box textAlign="center">No jobs yet</Box>}
          />
        </Container>
        </div>
      )}
    </Container>
  );
}
