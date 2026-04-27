import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AppLayout,
  TopNavigation,
  ContentLayout,
  Header,
  Tabs,
  StatusIndicator,
  BreadcrumbGroup,
} from "@cloudscape-design/components";
import { api, setTokenProvider } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { BrainstormWebSocket } from "../api/websocket";
import SourceUploader from "../components/SourceUploader";
import JobCreator from "../components/JobCreator";
import ArtifactsList from "../components/ArtifactsList";
import SummaryTab from "../components/SummaryTab";

interface Notebook {
  notebookId: string;
  title: string;
  status: string;
  sourceCount: number;
}

function statusIndicatorType(status: string): "success" | "in-progress" | "warning" | "error" | "pending" {
  if (status === "READY")         return "success";
  if (status === "INGESTING")     return "in-progress";
  if (status === "PARTIAL_ERROR") return "warning";
  if (status === "ERROR")         return "error";
  return "pending";
}

export default function NotebookDetailPage() {
  const { notebookId } = useParams<{ notebookId: string }>();
  const { getIdToken, logout, user } = useAuth();
  const navigate = useNavigate();
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const wsRef = useRef<BrainstormWebSocket | null>(null);
  const [refreshArtifacts, setRefreshArtifacts] = useState(0);

  useEffect(() => {
    setTokenProvider(getIdToken);
    loadNotebook();

    getIdToken().then((token) => {
      const ws = new BrainstormWebSocket(token);
      ws.on("job_complete", () => {
        setRefreshArtifacts((n) => n + 1);
        loadNotebook();
      });
      wsRef.current = ws;
    });

    return () => wsRef.current?.close();
  }, [notebookId]);

  const loadNotebook = async () => {
    const data = await api.get<Notebook>(`/notebooks/${notebookId}`);
    setNotebook(data);
  };

  const subscribeJob = (jobId: string) => {
    wsRef.current?.send({ action: "subscribe_job", jobId });
  };

  if (!notebook) return null;

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
              { text: notebook.title, href: "#" },
            ]}
            onFollow={(e) => { e.preventDefault(); if (e.detail.href !== "#") navigate(e.detail.href); }}
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
                  <StatusIndicator type={statusIndicatorType(notebook.status)}>
                    {notebook.status.charAt(0) + notebook.status.slice(1).toLowerCase().replace("_", " ")}
                  </StatusIndicator>
                }
              >
                {notebook.title}
              </Header>
            }
          >
            <Tabs
                tabs={[
                  {
                    id: "sources",
                    label: `Sources (${notebook.sourceCount})`,
                    content: (
                      <SourceUploader
                        notebookId={notebookId!}
                        onUploaded={loadNotebook}
                      />
                    ),
                  },
                  {
                    id: "generate",
                    label: "Generate",
                    content: (
                      <JobCreator
                        notebookId={notebookId!}
                        notebookStatus={notebook.status}
                        onJobCreated={subscribeJob}
                        refreshKey={refreshArtifacts}
                      />
                    ),
                  },
                  {
                    id: "artifacts",
                    label: "Artifacts",
                    content: (
                      <ArtifactsList
                        notebookId={notebookId!}
                        refreshKey={refreshArtifacts}
                      />
                    ),
                  },
                  {
                    id: "summary",
                    label: "Summary",
                    content: (
                      <SummaryTab
                        notebookId={notebookId!}
                        notebookStatus={notebook.status}
                        onJobCreated={subscribeJob}
                        refreshKey={refreshArtifacts}
                      />
                    ),
                  },
                ]}
              />
          </ContentLayout>
        }
      />
    </>
  );
}
