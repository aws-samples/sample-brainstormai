import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AppLayout,
  TopNavigation,
  ContentLayout,
  Header,
  SpaceBetween,
  Button,
  Box,
  Alert,
  Badge,
  BreadcrumbGroup,
} from "@cloudscape-design/components";
import { api, setTokenProvider } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import MindMapViewer from "../components/MindMapViewer";
import QuizPlayer from "../components/QuizPlayer";

interface Artifact {
  artifactId: string;
  type: string;
  coverageScore: number;
  coverageWarning: boolean;
  playlist?: PlaylistTurn[];
  artifactUrl?: string;
  createdAt: string;
}

interface PlaylistTurn {
  turnIndex: number;
  speaker: string;
  text: string;
  audioUrl: string;
}

interface Notebook {
  notebookId: string;
  title: string;
}

interface MindMapNode {
  title: string;
  children: MindMapNode[];
}
interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export default function ArtifactPage() {
  const { notebookId, artifactId } = useParams<{ notebookId: string; artifactId: string }>();
  const { getIdToken, logout, user } = useAuth();
  const navigate = useNavigate();
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactData, setArtifactData] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setTokenProvider(getIdToken);
    load();
  }, [artifactId]);

  const load = async () => {
    setLoading(true);
    try {
      const [nb, data] = await Promise.all([
        api.get<Notebook>(`/notebooks/${notebookId}`),
        api.get<Artifact>(`/notebooks/${notebookId}/artifacts/${artifactId}`),
      ]);
      setNotebook(nb);
      setArtifact(data);

      if (data.artifactUrl) {
        const res = await fetch(data.artifactUrl);
        setArtifactData(await res.json());
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading || !artifact) return null;

  const typeLabel = artifact.type.charAt(0).toUpperCase() + artifact.type.slice(1);

  return (
    <>
      <TopNavigation
        identity={{
          href: "/notebooks",
          title: "",
          logo: { src: "/banner.png", alt: "BrainstormAI" },
        }}
        utilities={[
          {
            type: "menu-dropdown",
            text: user?.email ?? "Account",
            iconName: "user-profile",
            items: [{ id: "signout", text: "Sign out" }],
            onItemClick: () => logout(),
          },
        ]}
      />

      <AppLayout
        navigationHide
        toolsHide
        headerVariant="high-contrast"
        breadcrumbs={
          <BreadcrumbGroup
            items={[
              { text: "My Notebooks", href: "/notebooks" },
              { text: notebook?.title ?? "Notebook", href: `/notebooks/${notebookId}` },
              { text: typeLabel, href: "#" },
            ]}
            onFollow={(e) => {
              e.preventDefault();
              if (e.detail.href !== "#") navigate(e.detail.href);
            }}
          />
        }
        content={
          <ContentLayout
            headerVariant="high-contrast"
            disableOverlap
            header={
              <Header
                variant="h1"
                description={
                  <SpaceBetween direction="horizontal" size="xs">
                    <Badge color={artifact.coverageScore >= 80 ? "green" : artifact.coverageScore >= 60 ? "blue" : "red"}>
                      Coverage {artifact.coverageScore}%
                    </Badge>
                    <Box color="text-body-secondary" fontSize="body-s">
                      Generated {new Date(artifact.createdAt).toLocaleString()}
                    </Box>
                  </SpaceBetween>
                }
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={() => navigate(`/notebooks/${notebookId}`)}>
                      Back to notebook
                    </Button>
                    {artifact.type === "podcast" && (
                      <Button
                        variant="primary"
                        onClick={() => navigate(`/notebooks/${notebookId}/artifacts/${artifactId}/play`)}
                      >
                        Play podcast
                      </Button>
                    )}
                  </SpaceBetween>
                }
              >
                {typeLabel}
              </Header>
            }
          >
            <SpaceBetween size="m">
              {artifact.coverageWarning && (
                <Alert type="warning">
                  This artifact may not cover all source material. Consider regenerating with a higher depth setting.
                </Alert>
              )}

              {artifact.type === "podcast" && artifact.playlist != null && (
                <Box>
                  <Box variant="h3">Script preview</Box>
                  <SpaceBetween size="xs">
                    {artifact.playlist.slice(0, 5).map((t) => (
                      <Box key={t.turnIndex} fontSize="body-s">
                        <strong>{t.speaker}:</strong> {t.text}
                      </Box>
                    ))}
                    {artifact.playlist.length > 5 && (
                      <Box color="text-body-secondary">…and {artifact.playlist.length - 5} more turns</Box>
                    )}
                  </SpaceBetween>
                </Box>
              )}

              {artifact.type === "mindmap" && artifactData != null && (
                <MindMapViewer data={artifactData as MindMapNode} />
              )}

              {artifact.type === "quiz" && artifactData != null && (
                <QuizPlayer questions={artifactData as QuizQuestion[]} />
              )}
            </SpaceBetween>
          </ContentLayout>
        }
      />
    </>
  );
}
