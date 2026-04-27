import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppLayout,
  TopNavigation,
  ContentLayout,
  Header,
  Cards,
  Button,
  SpaceBetween,
  Modal,
  FormField,
  Input,
  Box,
  StatusIndicator,
} from "@cloudscape-design/components";
import { api, setTokenProvider } from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface Notebook {
  notebookId: string;
  title: string;
  status: string;
  sourceCount: number;
  createdAt: string;
}

function statusIndicatorType(status: string): "success" | "in-progress" | "warning" | "error" | "pending" {
  if (status === "READY")          return "success";
  if (status === "INGESTING")      return "in-progress";
  if (status === "PARTIAL_ERROR")  return "warning";
  if (status === "ERROR")          return "error";
  return "pending";
}

export default function NotebooksPage() {
  const { getIdToken, logout, user } = useAuth();
  const navigate = useNavigate();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setTokenProvider(getIdToken);
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<{ notebooks: Notebook[] }>("/notebooks");
      setNotebooks(data.notebooks);
    } finally {
      setLoading(false);
    }
  };

  const deleteNotebook = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/notebooks/${deleteTarget.notebookId}`);
      setNotebooks((prev) => prev.filter((n) => n.notebookId !== deleteTarget.notebookId));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const create = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const nb = await api.post<Notebook>("/notebooks", { title: newTitle.trim() });
      setNotebooks((prev) => [nb, ...prev]);
      setCreateOpen(false);
      setNewTitle("");
      navigate(`/notebooks/${nb.notebookId}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <TopNavigation
        identity={{
          href: "/notebooks",
          title: "",
          logo: {
            src: "/banner.png",
            alt: "BrainstormAI",
          },
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
        content={
          <ContentLayout
            headerVariant="high-contrast"
            disableOverlap
            header={
              <Header
                variant="h1"
                description="Create notebooks, add sources, and generate podcasts, mind maps, and quizzes."
                actions={
                  <Button
                    variant="primary"
                    onClick={() => setCreateOpen(true)}
                  >
                    New notebook
                  </Button>
                }
              >
                My Notebooks
              </Header>
            }
          >
            <Box padding={{ top: "l" }}>
            <Cards
              loading={loading}
              loadingText="Loading notebooks…"
              items={notebooks}
              cardDefinition={{
                header: (nb) => (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                    <Button
                      variant="link"
                      onClick={() => navigate(`/notebooks/${nb.notebookId}`)}
                    >
                      {nb.title}
                    </Button>
                    <Button
                      variant="inline-icon"
                      iconName="close"
                      ariaLabel="Delete notebook"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(nb); }}
                    />
                  </div>
                ),
                sections: [
                  {
                    id: "status",
                    content: (nb) => (
                      <StatusIndicator type={statusIndicatorType(nb.status)}>
                        {nb.status.charAt(0) + nb.status.slice(1).toLowerCase().replace("_", " ")}
                      </StatusIndicator>
                    ),
                  },
                  {
                    id: "sources",
                    content: (nb) => (
                      <Box color="text-body-secondary" fontSize="body-s">
                        {nb.sourceCount} source{nb.sourceCount !== 1 ? "s" : ""}
                      </Box>
                    ),
                  },
                  {
                    id: "date",
                    content: (nb) => (
                      <Box color="text-body-secondary" fontSize="body-s">
                        Created {new Date(nb.createdAt).toLocaleDateString(undefined, {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                      </Box>
                    ),
                  },
                ],
              }}
              cardsPerRow={[
                { cards: 1 },
                { minWidth: 600, cards: 2 },
                { minWidth: 960, cards: 3 },
              ]}
              empty={
                <Box textAlign="center" padding="xxl">
                  <Box variant="strong" fontSize="heading-m">No notebooks yet</Box>
                  <Box color="text-body-secondary" padding={{ top: "s" }}>
                    Create a notebook to get started
                  </Box>
                  <Box padding={{ top: "m" }}>
                    <Button variant="primary" onClick={() => setCreateOpen(true)}>
                      New notebook
                    </Button>
                  </Box>
                </Box>
              }
            />
            </Box>

            <Modal
              visible={!!deleteTarget}
              onDismiss={() => setDeleteTarget(null)}
              header="Delete notebook"
              footer={
                <Box float="right">
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
                    <Button variant="primary" loading={deleting} onClick={deleteNotebook}>
                      Delete
                    </Button>
                  </SpaceBetween>
                </Box>
              }
            >
              <Box>
                Permanently delete <strong>{deleteTarget?.title}</strong>? This removes all sources, jobs, and artifacts and cannot be undone.
              </Box>
            </Modal>

            <Modal
              visible={createOpen}
              onDismiss={() => { setCreateOpen(false); setNewTitle(""); }}
              header="New notebook"
              footer={
                <Box float="right">
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={() => { setCreateOpen(false); setNewTitle(""); }}>Cancel</Button>
                    <Button variant="primary" loading={creating} onClick={create} disabled={!newTitle.trim()}>
                      Create
                    </Button>
                  </SpaceBetween>
                </Box>
              }
            >
              <FormField label="Title">
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.detail.value)}
                  placeholder="e.g. Quantum Computing Research"
                  onKeyDown={(e) => e.detail.key === "Enter" && create()}
                  autoFocus
                />
              </FormField>
            </Modal>
          </ContentLayout>
        }
      />
    </>
  );
}
