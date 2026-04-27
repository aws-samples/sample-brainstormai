import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Table,
  Badge,
  Button,
  Box,
  SpaceBetween,
} from "@cloudscape-design/components";

import { api } from "../api/client";

interface Artifact {
  artifactId: string;
  type: string;
  coverageScore: number;
  coverageWarning: boolean;
  createdAt: string;
  params?: Record<string, string>;
}

interface Props {
  notebookId: string;
  refreshKey: number;
}

export default function ArtifactsList({ notebookId, refreshKey }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    load();
  }, [refreshKey]);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<{ artifacts: Artifact[] }>(
        `/notebooks/${notebookId}/artifacts`
      );
      setArtifacts(data.artifacts);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Table
      loading={loading}
      items={artifacts}
      columnDefinitions={[
        {
          id: "type",
          header: "Type",
          cell: (a) => {
            const label = a.type.charAt(0).toUpperCase() + a.type.slice(1);
            const p = a.params ?? {};
            const parts: string[] = [];
            if (p.depth)    parts.push(p.depth.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
            if (p.genre)    parts.push(p.genre.charAt(0).toUpperCase() + p.genre.slice(1));
            if (p.language) parts.push(p.language.charAt(0).toUpperCase() + p.language.slice(1));
            return parts.length > 0 ? `${label} (${parts.join(" / ")})` : label;
          },
        },
        {
          id: "coverage",
          header: "Coverage",
          cell: (a) => (
            <SpaceBetween direction="horizontal" size="xs">
              <Badge
                color={
                  a.coverageScore >= 80 ? "green"
                  : a.coverageScore >= 60 ? "blue"
                  : "red"
                }
              >
                {a.coverageScore}%
              </Badge>
              {a.coverageWarning && <Badge color="red">!</Badge>}
            </SpaceBetween>
          ),
        },
        {
          id: "created",
          header: "Created",
          cell: (a) => new Date(a.createdAt).toLocaleString(),
        },
        {
          id: "actions",
          header: "",
          cell: (a) => (
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                onClick={() =>
                  navigate(`/notebooks/${notebookId}/artifacts/${a.artifactId}`)
                }
              >
                View
              </Button>
              {a.type === "podcast" && (
                <Button
                  variant="primary"
                  onClick={() =>
                    navigate(`/notebooks/${notebookId}/artifacts/${a.artifactId}/play`)
                  }
                >
                  Play
                </Button>
              )}
            </SpaceBetween>
          ),
        },
      ]}
      empty={
        <Box textAlign="center" padding="l">
          No artifacts yet — generate one from the Generate tab
        </Box>
      }
    />
  );
}
