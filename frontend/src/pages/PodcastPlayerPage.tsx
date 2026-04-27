import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AppLayout,
  TopNavigation,
  ContentLayout,
  Header,
  SpaceBetween,
  Button,
  Box,
  ProgressBar,
  Badge,
  BreadcrumbGroup,
  Container,
  Input,
  Alert,
  StatusIndicator,
  ColumnLayout,
  Spinner,
} from "@cloudscape-design/components";
import { api, setTokenProvider } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { BrainstormWebSocket } from "../api/websocket";

interface PlaylistTurn {
  turnIndex: number;
  speaker: string;
  text: string;
  audioUrl: string;
}

type LoadState = "fetching" | "ready" | "error";
type PlayerState = "paused" | "playing" | "interrupted" | "answering" | "done";

const SPEEDS = ["0.75", "1", "1.25", "1.5", "2"];

function fmt(secs: number) {
  if (!isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PodcastPlayerPage() {
  const { notebookId, artifactId } = useParams<{ notebookId: string; artifactId: string }>();
  const { getIdToken, logout, user } = useAuth();
  const navigate = useNavigate();

  const audioRef         = useRef<HTMLAudioElement | null>(null);
  const answerAudioRef   = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef       = useRef<string | null>(null);
  const turnOffsetsRef   = useRef<number[]>([]);
  const wsRef            = useRef<BrainstormWebSocket | null>(null);
  const sessionIdRef     = useRef<string | null>(null);
  const activeLineRef    = useRef<HTMLDivElement | null>(null);

  const [loadState, setLoadState]       = useState<LoadState>("fetching");
  const [loadProgress, setLoadProgress] = useState(0);
  const [playlist, setPlaylist]         = useState<PlaylistTurn[]>([]);
  const [playerState, setPlayerState]   = useState<PlayerState>("paused");
  const [currentTime, setCurrentTime]   = useState(0);
  const [duration, setDuration]         = useState(0);
  const [speed, setSpeed]               = useState("1");
  const [currentTurnIdx, setCurrentTurnIdx] = useState(0);
  const [question, setQuestion]         = useState("");
  const [answerText, setAnswerText]     = useState("");

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
        const buffers = await Promise.all(
          pl.map((turn) =>
            fetch(turn.audioUrl)
              .then((r) => r.arrayBuffer())
              .then((buf) => { loaded++; setLoadProgress(Math.round((loaded / pl.length) * 100)); return buf; })
          )
        );

        const audioCtx = new AudioContext();
        const durations = await Promise.all(
          buffers.map((buf) => audioCtx.decodeAudioData(buf.slice(0)).then((d) => d.duration))
        );
        audioCtx.close();

        const offsets: number[] = [];
        let t = 0;
        for (const d of durations) { offsets.push(t); t += d; }
        turnOffsetsRef.current = offsets;

        const blob = new Blob(buffers, { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;
        audio.playbackRate = parseFloat(speed);
        audio.onloadedmetadata = () => setDuration(audio.duration);
        audio.ontimeupdate = () => {
          const ct = audio.currentTime;
          setCurrentTime(ct);
          const offs = turnOffsetsRef.current;
          let idx = 0;
          for (let i = offs.length - 1; i >= 0; i--) { if (offs[i] <= ct) { idx = i; break; } }
          setCurrentTurnIdx(idx);
        };
        audio.onended = () => setPlayerState("done");
        setLoadState("ready");
      } catch (e) {
        console.error(e);
        setLoadState("error");
      }
    };

    load();

    getIdToken().then((token) => {
      const ws = new BrainstormWebSocket(token);
      ws.on("podcast_turn", (msg) => {
        if (!sessionIdRef.current) sessionIdRef.current = (msg as { sessionId: string }).sessionId;
      });
      ws.on("podcast_answer", (msg) => {
        const p = msg as { text: string; audioUrl: string };
        setAnswerText(p.text);
        setPlayerState("answering");
        const a = new Audio(p.audioUrl);
        answerAudioRef.current = a;
        a.onended = () => setPlayerState("interrupted");
        a.play().catch(() => {});
      });
      wsRef.current = ws;
      ws.send({ action: "start_podcast", artifactId });
    });

    return () => {
      wsRef.current?.close();
      audioRef.current?.pause();
      answerAudioRef.current?.pause();
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, [artifactId]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = parseFloat(speed);
  }, [speed]);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentTurnIdx]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play(); setPlayerState("playing"); }
    else          { a.pause(); setPlayerState("paused"); }
  };

  const rewind = () => {
    if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
  };

  const seek = (v: number) => {
    if (audioRef.current) { audioRef.current.currentTime = v; setCurrentTime(v); }
  };

  const interrupt = () => {
    if (!question.trim() || !sessionIdRef.current) return;
    audioRef.current?.pause();
    setPlayerState("interrupted");
    wsRef.current?.send({ action: "interrupt", sessionId: sessionIdRef.current, text: question, turnIndex: currentTurnIdx });
    setQuestion("");
  };

  const resumeAfterQA = () => {
    setAnswerText("");
    audioRef.current?.play();
    setPlayerState("playing");
  };

  const progress      = duration > 0 ? (currentTime / duration) * 100 : 0;
  const currentTurn   = playlist[currentTurnIdx] ?? null;
  const canControl    = loadState === "ready" && playerState !== "done";
  const isPlaying     = playerState === "playing";
  const speakerColor  = (s: string): "blue" | "green" => s?.toLowerCase().startsWith("s") ? "green" : "blue";

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
              { text: "Notebook", href: `/notebooks/${notebookId}` },
              { text: "Podcast", href: "#" },
            ]}
            onFollow={(e) => { e.preventDefault(); if (e.detail.href !== "#") navigate(e.detail.href); }}
          />
        }
        content={
          <ContentLayout
            headerVariant="high-contrast"
            header={
              <Header
                variant="h1"
                description="Listen, control playback, and ask questions mid-episode."
              >
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
                  Could not download audio segments. Go back and try again.
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

                      {/* Current line */}
                      {currentTurn && (
                        <Box fontSize="heading-m" color="text-label">
                          {currentTurn.text}
                        </Box>
                      )}

                      {playerState === "done" && (
                        <StatusIndicator type="success">Podcast complete</StatusIndicator>
                      )}

                      {/* Progress bar + times */}
                      <SpaceBetween size="xxs">
                        <ProgressBar
                          value={progress}
                          description={`${fmt(currentTime)} / ${fmt(duration)}`}
                        />
                        <input
                          type="range"
                          min={0}
                          max={duration || 1}
                          step={0.5}
                          value={currentTime}
                          onChange={(e) => seek(parseFloat(e.target.value))}
                          disabled={!canControl}
                          style={{
                            width: "100%",
                            accentColor: "#0972d3",
                            cursor: canControl ? "pointer" : "default",
                          }}
                        />
                      </SpaceBetween>

                      {/* Transport */}
                      <ColumnLayout columns={2} variant="text-grid">
                        <SpaceBetween direction="horizontal" size="xs">
                          <Button
                            iconName="undo"
                            onClick={rewind}
                            disabled={!canControl}
                          >
                            −10s
                          </Button>
                          <Button
                            variant="primary"
                            iconName={isPlaying ? "pause" : "caret-right-filled"}
                            onClick={togglePlay}
                            disabled={!canControl || playerState === "interrupted" || playerState === "answering"}
                          >
                            {isPlaying ? "Pause" : "Play"}
                          </Button>
                        </SpaceBetween>

                        {/* Speed pills */}
                        <SpaceBetween direction="horizontal" size="xxs">
                          <Box color="text-body-secondary" fontSize="body-s" padding={{ top: "xs" }}>Speed:</Box>
                          {SPEEDS.map((s) => (
                            <Button
                              key={s}
                              variant={speed === s ? "primary" : "normal"}
                              onClick={() => setSpeed(s)}
                            >
                              {s}×
                            </Button>
                          ))}
                        </SpaceBetween>
                      </ColumnLayout>
                    </SpaceBetween>
                  </Container>

                  {/* Q&A answer */}
                  {answerText && (playerState === "answering" || playerState === "interrupted") && (
                    <Container header={<Header variant="h2">Listener Q&amp;A</Header>}>
                      <SpaceBetween size="m">
                        {playerState === "answering" && (
                          <StatusIndicator type="in-progress">Playing answer…</StatusIndicator>
                        )}
                        <Box color="text-body-secondary">{answerText}</Box>
                        {playerState === "interrupted" && (
                          <Button variant="primary" iconName="caret-right-filled" onClick={resumeAfterQA}>
                            Resume podcast
                          </Button>
                        )}
                      </SpaceBetween>
                    </Container>
                  )}

                  {/* Ask a question */}
                  {(playerState === "playing" || playerState === "paused" || playerState === "interrupted") && (
                    <Container header={<Header variant="h2">Ask a question</Header>}>
                      <SpaceBetween direction="horizontal" size="xs">
                        <div style={{ flex: 1 }}>
                          <Input
                            value={question}
                            onChange={(e) => setQuestion(e.detail.value)}
                            placeholder="Ask anything about the podcast…"
                            onKeyDown={(e) => e.detail.key === "Enter" && interrupt()}
                            disabled={playerState === "interrupted"}
                          />
                        </div>
                        <Button
                          variant="primary"
                          onClick={interrupt}
                          disabled={!question.trim() || playerState === "interrupted"}
                        >
                          Ask
                        </Button>
                      </SpaceBetween>
                    </Container>
                  )}

                  {/* Transcript */}
                  {playlist.length > 0 && (
                    <Container header={<Header variant="h2">Transcript</Header>}>
                      <SpaceBetween size="xs">
                        {playlist.map((t, i) => (
                          <div
                            key={t.turnIndex}
                            ref={i === currentTurnIdx ? activeLineRef : null}
                          >
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
        }
      />
    </>
  );
}
