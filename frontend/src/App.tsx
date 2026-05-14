import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import LoginPage from "./pages/LoginPage";
import NotebooksPage from "./pages/NotebooksPage";
import NotebookDetailPage from "./pages/NotebookDetailPage";
import ArtifactPage from "./pages/ArtifactPage";
import PodcastPlayerPage from "./pages/PodcastPlayerPage";
import UsagePage from "./pages/UsagePage";

export default function App() {
  const { user } = useAuth();

  if (!user) {
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/notebooks" replace />} />
      <Route path="/notebooks" element={<NotebooksPage />} />
      <Route path="/notebooks/:notebookId" element={<NotebookDetailPage />} />
      <Route path="/notebooks/:notebookId/artifacts/:artifactId" element={<ArtifactPage />} />
      <Route path="/notebooks/:notebookId/artifacts/:artifactId/play" element={<PodcastPlayerPage />} />
      <Route path="/usage" element={<UsagePage />} />
    </Routes>
  );
}
