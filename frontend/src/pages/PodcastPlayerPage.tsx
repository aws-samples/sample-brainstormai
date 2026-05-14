import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Button,
  Box,
  ProgressBar,
  Badge,
  BreadcrumbGroup,
  Container,
  Alert,
  StatusIndicator,
  ColumnLayout,
  Spinner,
  FormField,
  Textarea,
} from "@cloudscape-design/components";
import { api, setTokenProvider } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import AppShell from "../components/AppShell";
import { BrainstormWebSocket } from "../api/websocket";

interface PlaylistTurn {
  turnIndex: number;
  speaker: string;
  text: string;
  audioUrl: string;
}

type LoadState = "fetching" | "ready" | "error";
type PlayerState = "paused" | "playing" | "done" | "interrupted";

const SPEEDS = ["0.75", "1", "1.25", "1.5", "2"];

function fmt(secs: number) {
  if (!isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PodcastPlayerPage() {
  const { notebookId, artifactId } = useParams<{ notebookId: string; artifactId: string }>();
  const { getIdToken } = useAuth();
  const navigate = useNavigate();

  // Audio — one Audio element per turn, played sequentially
  const audioRef         = useRef<HTMLAudioElement | null>(null);
  const blobUrlsRef      = useRef<string[]>([]);
  const wsRef            = useRef<BrainstormWebSocket | null>(null);
  const sessionIdRef     = useRef<string | null>(null);
  const activeLineRef    = useRef<HTMLDivElement | null>(null);
  const playerStateRef   = useRef<PlayerState>("paused");

  const [loadState, setLoadState]       = useState<LoadState>("fetching");
  const [loadError, setLoadError]       = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [playlist, setPlaylist]         = useState<PlaylistTurn[]>([]);
  const [playerState, setPlayerState]   = useState<PlayerState>("paused");
  const [currentTurnIdx, setCurrentTurnIdx] = useState(0);
  const [currentTime, setCurrentTime]   = useState(0);
  const [duration, setDuration]         = useState(0);
  const [speed, setSpeed]               = useState("1");

  // Q&A state
  const [question, setQuestion]         = useState("");
  const [qaAnswer, setQaAnswer]         = useState<{ question: string; answer: string } | null>(null);
  const [qaLoading, setQaLoading]       = useState(false);
  const [qaError, setQaError]           = useState<string | null>(null);

  const setPS = (s: PlayerState) => {
    playerStateRef.current = s;
    setPlayerState(s);
  };

  // Play a single turn by index
  const playTurn = useCallback((idx: number, pl: PlaylistTurn[], urls: string[]) => {
    const url = urls[idx];
    if (!url) { setPS("done"); return; }

    const prev = audioRef.current;
    if (prev) { prev.pause(); prev.src = ""; }

    const audio = new Audio(url);
    audioRef.current = audio;
    audio.playbackRate = parseFloat(speed);
    audio.onloadedmetadata = () => setDuration(audio.duration);
    audio.ontimeupdate = () => setCurrentTime(audio.currentTime);
    audio.onended = () => {
      // Only auto-advance if not interrupted
      if (playerStateRef.current !== "interrupted") {
        const next = idx + 1;
        if (next < pl.length) {
          setCurrentTurnIdx(next);
          playTurn(next, pl, urls);
        } else {
          setPS("done");
        }
      }
    };
    setCurrentTurnIdx(idx);
    setCurrentTime(0);
    setDuration(0);
    audio.play();
    setPS("playing");
  }, [speed]);

  useEffect(() => {
    setTokenProvider(getIdToken);

    const load = async () => {
      try {
        const artifact = await api.get<{ playlist: PlaylistTurn[] }>(
          `/notebooks/${notebookId}/artifacts/${artifactId}`
        );
        const pl = artifact.playlist;
        setPlaylist(pl);

        let loaded = 0;
        const urls: string[] = [];

        await Promise.all(
          pl.map(async (turn, i) => {
            const res = await fetch(turn.audioUrl);
            if (!res.ok) throw new Error(`Segment ${i} fetch failed: ${res.status} ${res.statusText} — ${turn.audioUrl}`);
            const buf = await res.arrayBuffer();
            const blob = new Blob([buf], { type: "audio/mpeg" });
            const url = URL.createObjectURL(blob);
            urls[i] = url;
            loaded++;
            setLoadProgress(Math.round((loaded / pl.length) * 100));
          })
        );

        blobUrlsRef.current = urls;
        setLoadState("ready");

        // Auto-start first turn
        playTurn(0, pl, urls);
      } catch (e) {
        console.error("[PodcastPlayer] load error:", e);
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoadState("error");
      }
    };

    load();

    getIdToken().then((token) => {
      // Guard against React strict-mode double-mount creating two sessions
      if (wsRef.current) return;

      const ws = new BrainstormWebSocket(token);
      wsRef.current = ws;

      ws.on("podcast_turn", (msg) => {
        const m = msg as { sessionId: string };
        // Always update to the latest session (handles reconnect case)
        sessionIdRef.current = m.sessionId;
      });

      ws.on("podcast_answer", (msg) => {
        const m = msg as { question: string; answer: string; audioUrl: string };
        setQaLoading(false);
        setQaAnswer({ question: m.question, answer: m.answer });
        const answerAudio = new Audio(m.audioUrl);
        answerAudio.onended = () => {
          setQaAnswer(null);
          setQuestion("");
          const urls = blobUrlsRef.current;
          const resumeIdx = currentTurnIdxRef.current;
          setPlaylist((pl) => { playTurn(resumeIdx, pl, urls); return pl; });
        };
        answerAudio.play();
      });

      ws.on("error", (msg) => {
        setQaLoading((loading) => {
          if (loading) {
            setQaError((msg as { message: string }).message ?? "Failed to get answer");
            setPS("paused");
          }
          return false;
        });
      });

      ws.send({ action: "start_podcast", artifactId });
    });

    return () => {
      wsRef.current?.close();
      audioRef.current?.pause();
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [artifactId]);

  // Keep a ref of currentTurnIdx for use inside callbacks
  const currentTurnIdxRef = useRef(0);
  useEffect(() => { currentTurnIdxRef.current = currentTurnIdx; }, [currentTurnIdx]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = parseFloat(speed);
  }, [speed]);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentTurnIdx]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a || playerState === "interrupted") return;
    if (a.paused) { a.play(); setPS("playing"); }
    else          { a.pause(); setPS("paused"); }
  };

  const rewind = () => {
    if (audioRef.current && playerState !== "interrupted") {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
    }
  };

  const seek = (v: number) => {
    if (audioRef.current && playerState !== "interrupted") {
      audioRef.current.currentTime = v;
      setCurrentTime(v);
    }
  };

  const handleInterrupt = () => {
    audioRef.current?.pause();
    setPS("interrupted");
    setQaAnswer(null);
    setQaError(null);
  };

  const handleAskQuestion = () => {
    const q = question.trim();
    const sessionId = sessionIdRef.current;
    if (!q) { setQaError("Please enter a question."); return; }
    if (!sessionId) { setQaError("Session not ready — please wait a moment and try again."); return; }
    console.log("[QA] sending interrupt", { sessionId, question: q });
    setQaLoading(true);
    setQaError(null);
    wsRef.current?.send({ action: "interrupt", sessionId, question: q });
  };

  const handleDismissQa = () => {
    setPS("paused");
    setQaAnswer(null);
    setQaError(null);
    setQuestion("");
  };

  const progress    = duration > 0 ? (currentTime / duration) * 100 : 0;
  const currentTurn = playlist[currentTurnIdx] ?? null;
  const canControl  = loadState === "ready" && playerState !== "done" && playerState !== "interrupted";
  const isPlaying   = playerState === "playing";
  const speakerColor = (s: string): "blue" | "green" => s?.toLowerCase().startsWith("s") ? "green" : "blue";

  return (
    <AppShell
      breadcrumbs={
        <BreadcrumbGroup
          items={[
            { text: "My Notebooks", href: "/notebooks" },
            { text: "Notebook", href: `/notebooks/${notebookId}` },
            { text: "Podcast", href: "#" },
          ]}
          onFollow={(e) => { e.preventDefault(); if (e.detail.href !== "#") navigate(e.detail.href); }}
        />
      }
    >
      <ContentLayout
        headerVariant="high-contrast"
        header={
          <Header variant="h1" description="Listen and ask questions mid-playback.">
            Podcast Player
          </Header>
        }
      >
        <SpaceBetween size="l">

          {/* Loading */}
          {loadState === "fetching" && (
            <Container>
              <SpaceBetween size="m">
                <Box textAlign="center">
                  <Spinner size="large" />
                  <Box variant="p" color="text-body-secondary" padding={{ top: "s" }}>
                    Loading audio…
                  </Box>
                </Box>
                <ProgressBar
                  value={loadProgress}
                  label="Downloading segments"
                  description={`${loadProgress}% of ${playlist.length || "…"} segments`}
                />
              </SpaceBetween>
            </Container>
          )}

          {loadState === "error" && (
            <Alert type="error" header="Failed to load podcast">
              {loadError ?? "Could not download audio segments. Go back and try again."}
            </Alert>
          )}

          {loadState === "ready" && (
            <>
              {/* Player controls */}
              <Container
                header={
                  <Header variant="h2">
                    {currentTurn ? (
                      <SpaceBetween direction="horizontal" size="xs">
                        <Badge color={speakerColor(currentTurn.speaker)}>{currentTurn.speaker}</Badge>
                        <span>Turn {currentTurnIdx + 1} of {playlist.length}</span>
                      </SpaceBetween>
                    ) : "Player"}
                  </Header>
                }
              >
                <SpaceBetween size="l">

                  {currentTurn && (
                    <Box fontSize="heading-m" color="text-label">
                      {currentTurn.text}
                    </Box>
                  )}

                  {playerState === "done" && (
                    <StatusIndicator type="success">Podcast complete</StatusIndicator>
                  )}

                  {/* Progress */}
                  <SpaceBetween size="xxs">
                    <ProgressBar value={progress} description={`${fmt(currentTime)} / ${fmt(duration)}`} />
                    <input
                      type="range"
                      min={0}
                      max={duration || 1}
                      step={0.5}
                      value={currentTime}
                      onChange={(e) => seek(parseFloat(e.target.value))}
                      disabled={!canControl}
                      style={{ width: "100%", accentColor: "#0972d3", cursor: canControl ? "pointer" : "default" }}
                    />
                  </SpaceBetween>

                  {/* Transport */}
                  <ColumnLayout columns={2} variant="text-grid">
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button iconName="undo" onClick={rewind} disabled={!canControl}>−10s</Button>
                      <Button
                        variant="primary"
                        iconName={isPlaying ? "pause" : "caret-right-filled"}
                        onClick={togglePlay}
                        disabled={!canControl}
                      >
                        {isPlaying ? "Pause" : "Play"}
                      </Button>
                      {(playerState === "playing" || playerState === "paused") && (
                        <Button iconName="contact" onClick={handleInterrupt}>
                          Ask a Question
                        </Button>
                      )}
                    </SpaceBetween>

                    {/* Speed */}
                    <SpaceBetween direction="horizontal" size="xxs">
                      <Box color="text-body-secondary" fontSize="body-s" padding={{ top: "xs" }}>Speed:</Box>
                      {SPEEDS.map((s) => (
                        <Button key={s} variant={speed === s ? "primary" : "normal"} onClick={() => setSpeed(s)}>
                          {s}×
                        </Button>
                      ))}
                    </SpaceBetween>
                  </ColumnLayout>
                </SpaceBetween>
              </Container>

              {/* Q&A panel — shown when interrupted */}
              {playerState === "interrupted" && (
                <Container header={<Header variant="h2">Ask a Question</Header>}>
                  <SpaceBetween size="m">
                    <Box color="text-body-secondary" fontSize="body-s">
                      Podcast paused. Ask anything about what you've heard so far.
                    </Box>

                    {qaError && (
                      <Alert type="error" dismissible onDismiss={() => setQaError(null)}>
                        {qaError}
                      </Alert>
                    )}

                    {qaAnswer ? (
                      <SpaceBetween size="s">
                        <Box fontWeight="bold">Q: {qaAnswer.question}</Box>
                        <Box>A: {qaAnswer.answer}</Box>
                        <Box color="text-body-secondary" fontSize="body-s">
                          Playing answer audio… podcast will resume automatically.
                        </Box>
                        <Button onClick={handleDismissQa}>Resume Now</Button>
                      </SpaceBetween>
                    ) : (
                      <SpaceBetween size="s">
                        <FormField label="Your question">
                          <Textarea
                            value={question}
                            onChange={({ detail }) => setQuestion(detail.value)}
                            placeholder="What did they mean by…?"
                            rows={3}
                            disabled={qaLoading}
                          />
                        </FormField>
                        <SpaceBetween direction="horizontal" size="xs">
                          <Button
                            variant="primary"
                            onClick={handleAskQuestion}
                            loading={qaLoading}
                            disabled={!question.trim() || qaLoading}
                          >
                            {qaLoading ? "Getting answer…" : "Ask"}
                          </Button>
                          <Button onClick={handleDismissQa} disabled={qaLoading}>
                            Cancel &amp; Resume
                          </Button>
                        </SpaceBetween>
                      </SpaceBetween>
                    )}
                  </SpaceBetween>
                </Container>
              )}

              {/* Transcript */}
              {playlist.length > 0 && (
                <Container header={<Header variant="h2">Transcript</Header>}>
                  <SpaceBetween size="xs">
                    {playlist.map((t, i) => (
                      <div key={t.turnIndex} ref={i === currentTurnIdx ? activeLineRef : null}>
                        <SpaceBetween direction="horizontal" size="xs">
                          <Badge color={speakerColor(t.speaker)}>{t.speaker}</Badge>
                          <Box
                            color={i === currentTurnIdx ? "text-label" : "text-body-secondary"}
                            fontSize="body-s"
                          >
                            {t.text}
                          </Box>
                        </SpaceBetween>
                      </div>
                    ))}
                  </SpaceBetween>
                </Container>
              )}
            </>
          )}
        </SpaceBetween>
      </ContentLayout>
    </AppShell>
  );
}
