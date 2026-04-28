import { useEffect, useState } from "react";
import {
  SpaceBetween,
  Button,
  Table,
  Badge,
  Modal,
  FormField,
  Input,
  Textarea,
  Tabs,
  Alert,
  FileUpload,
  Box,
  Header,
} from "@cloudscape-design/components";
import { api } from "../api/client";

interface Source {
  sourceId: string;
  type: string;
  filename?: string;
  url?: string;
  title?: string;
  status: string;
}

interface Props {
  notebookId: string;
  onUploaded: () => void;
}

export default function SourceUploader({ notebookId, onUploaded }: Props) {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Form state
  const [url, setUrl] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    load();
    // Poll for status changes every 5s while any source is pending/processing
    const interval = setInterval(() => {
      const hasPending = sources.some((s) => ["PENDING", "PROCESSING"].includes(s.status));
      if (hasPending) load();
    }, 5000);
    return () => clearInterval(interval);
  }, [sources.length]);

  const load = async () => {
    const data = await api.get<{ sources: Source[] }>(`/notebooks/${notebookId}/sources`);
    setSources(data.sources);
    setLoading(false);
  };

  const submitUrl = async () => {
    setError("");
    setSubmitting(true);
    try {
      await api.post(`/notebooks/${notebookId}/sources/url`, { url });
      setUrl("");
      setAddOpen(false);
      await load();
      onUploaded();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to add URL");
    } finally {
      setSubmitting(false);
    }
  };

  const submitText = async () => {
    setError("");
    setSubmitting(true);
    try {
      await api.post(`/notebooks/${notebookId}/sources/text`, {
        content: textContent,
        title: textTitle || "Note",
      });
      setTextContent("");
      setTextTitle("");
      setAddOpen(false);
      await load();
      onUploaded();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to add text");
    } finally {
      setSubmitting(false);
    }
  };

  const submitPdf = async () => {
    if (!files[0]) return;
    setError("");
    setSubmitting(true);
    try {
      const file = files[0];
      const { uploadUrl, sourceId } = await api.post<{ uploadUrl: string; sourceId: string }>(
        `/notebooks/${notebookId}/sources/upload-url`,
        { filename: file.name, size: file.size }
      );
      await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "application/pdf" },
      });
      // File is now in S3 — trigger ingestion
      await api.post(`/notebooks/${notebookId}/sources/${sourceId}/ingest`, {});
      setFiles([]);
      setAddOpen(false);
      await load();
      onUploaded();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to upload PDF");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteSource = async (sourceId: string) => {
    await api.delete(`/notebooks/${notebookId}/sources/${sourceId}`);
    setSources((prev) => prev.filter((s) => s.sourceId !== sourceId));
    onUploaded();
  };

  const statusBadge = (status: string) => {
    const map: Record<string, "green" | "blue" | "red"> = {
      READY: "green", PROCESSING: "blue", PENDING: "blue", ERROR: "red",
    };
    return <Badge color={map[status] ?? "grey"}>{status}</Badge>;
  };

  return (
    <SpaceBetween size="m">
      <Table
        loading={loading}
        items={sources}
        columnDefinitions={[
          { id: "type", header: "Type", cell: (s) => s.type.toUpperCase() },
          {
            id: "name",
            header: "Name",
            cell: (s) => s.filename ?? s.title ?? s.url ?? "—",
          },
          { id: "status", header: "Status", cell: (s) => statusBadge(s.status) },
          {
            id: "actions",
            header: "",
            cell: (s) => (
              <Button variant="inline-icon" iconName="close" onClick={() => deleteSource(s.sourceId)} />
            ),
          },
        ]}
        header={
          <Header
            variant="h2"
            actions={
              <Button variant="primary" onClick={() => setAddOpen(true)} disabled={sources.length >= 10}>
                Add source
              </Button>
            }
            description={sources.length >= 10 ? "Maximum 10 sources reached" : undefined}
          >
            Sources
          </Header>
        }
        empty={<Box textAlign="center" padding="l">No sources yet — add PDFs, URLs, or text</Box>}
      />

      <Modal
        visible={addOpen}
        onDismiss={() => { setAddOpen(false); setError(""); }}
        header="Add source"
        size="medium"
      >
        <SpaceBetween size="m">
          {error && <Alert type="error">{error}</Alert>}
          <Tabs
            tabs={[
              {
                id: "pdf",
                label: "PDF",
                content: (
                  <SpaceBetween size="m">
                    <FormField label="PDF file" description="Max 5 MB">
                      <FileUpload
                        value={files}
                        onChange={(e) => setFiles(e.detail.value)}
                        accept=".pdf"
                        i18nStrings={{
                          uploadButtonText: () => "Choose PDF",
                          dropzoneText: () => "Drop PDF here",
                          removeFileAriaLabel: () => "Remove file",
                        }}
                      />
                    </FormField>
                    <Button variant="primary" loading={submitting} onClick={submitPdf} disabled={!files[0]}>
                      Upload
                    </Button>
                  </SpaceBetween>
                ),
              },
              {
                id: "url",
                label: "URL",
                content: (
                  <SpaceBetween size="m">
                    <FormField label="URL">
                      <Input
                        value={url}
                        onChange={(e) => setUrl(e.detail.value)}
                        placeholder="https://example.com/article"
                        type="url"
                      />
                    </FormField>
                    <Button variant="primary" loading={submitting} onClick={submitUrl} disabled={!url.trim()}>
                      Add URL
                    </Button>
                  </SpaceBetween>
                ),
              },
              {
                id: "text",
                label: "Text",
                content: (
                  <SpaceBetween size="m">
                    <FormField label="Title">
                      <Input value={textTitle} onChange={(e) => setTextTitle(e.detail.value)} placeholder="My notes" />
                    </FormField>
                    <FormField label="Content">
                      <Textarea
                        value={textContent}
                        onChange={(e) => setTextContent(e.detail.value)}
                        placeholder="Paste your text here..."
                        rows={8}
                      />
                    </FormField>
                    <Button variant="primary" loading={submitting} onClick={submitText} disabled={!textContent.trim()}>
                      Add text
                    </Button>
                  </SpaceBetween>
                ),
              },
            ]}
          />
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
