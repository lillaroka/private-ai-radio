import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import VoiceSelectors from "../components/VoiceSelectors";
import ScriptEditor from "../components/ScriptEditor";
import HistorySidebar from "../components/HistorySidebar";
import { useSSE } from "../hooks/useSSE";

function isNetworkError(error) {
  return error?.name === "AbortError" ||
    error?.name === "TypeError" ||
    /fetch|network|Failed to fetch/i.test(error?.message ?? "");
}

export default function EpisodePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [episode, setEpisode] = useState(null);
  const [episodes, setEpisodes] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [mock, setMock] = useState(false);
  const [voiceOptions, setVoiceOptions] = useState([]);
  const [voiceS1, setVoiceS1] = useState("demo1");
  const [voiceS2, setVoiceS2] = useState("demo2");
  const [interests, setInterests] = useState([]);
  const [feedback, setFeedback] = useState({
    topic: 8,
    rhythm: 8,
    voice: 8,
    liked: "",
    disliked: "",
    next: "",
  });
  const [feedbackStatus, setFeedbackStatus] = useState("");
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [recoveringId, setRecoveringId] = useState(null);

  const recoveryRef = useRef(null);
  const { call: callSSE } = useSSE();

  function stopRecovery() {
    if (recoveryRef.current) {
      clearInterval(recoveryRef.current);
      recoveryRef.current = null;
    }
    setRecoveringId(null);
  }

  function startRecovery(episodeId) {
    stopRecovery();
    setRecoveringId(episodeId);
    setLoading(true);
    setError("");

    recoveryRef.current = setInterval(async () => {
      try {
        const response = await fetch(`/api/episodes/${episodeId}/progress`);
        if (response.status === 404) {
          // Server may have restarted — check if episode completed on disk
          stopRecovery();
          try {
            const epResponse = await fetch(`/api/episodes/${episodeId}`);
            if (epResponse.ok) {
              const epData = await epResponse.json();
              setEpisode(epData.episode);
              await loadEpisodes();
            }
          } catch {
            // Episode not found — stop polling
          }
          setLoading(false);
          setProgress(null);
          return;
        }

        const data = await response.json();

        if (data.error) {
          stopRecovery();
          setError(data.error);
          setLoading(false);
          setProgress(null);
          return;
        }

        setProgress({ stage: data.stage, detail: data.detail ?? {} });

        if (data.done && data.episode) {
          stopRecovery();
          await loadEpisode();
          await loadEpisodes();
          setLoading(false);
          setProgress(null);
        }
      } catch {
        // Network blip — keep polling
      }
    }, 2000);
  }

  useEffect(() => {
    loadEpisode();
    loadEpisodes();
    loadInterestsData();
    loadVoices();
    return () => stopRecovery();
  }, [id]);

  useEffect(() => {
    // Check if current episode has an active audio generation
    async function checkActive() {
      try {
        const response = await fetch(`/api/episodes/${id}/progress`);
        if (response.ok) {
          const data = await response.json();
          if (!data.done && !data.error) {
            startRecovery(id);
          }
        }
      } catch {
        // Ignore
      }
    }
    checkActive();
  }, [id]);

  async function loadVoices() {
    try {
      const response = await fetch("/api/voices");
      const data = await response.json();
      const voices = data.voices ?? [];
      setVoiceOptions(voices);
      if (voices.length >= 2) {
        setVoiceS1(voices[0].id);
        setVoiceS2(voices[1].id);
      }
    } catch {
      // Ignore
    }
  }

  async function loadEpisode() {
    setError("");
    try {
      const response = await fetch(`/api/episodes/${id}`);
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "读取节目失败");
        return;
      }
      setEpisode(data.episode);
    } catch {
      setError("读取节目失败");
    }
  }

  async function loadEpisodes() {
    const response = await fetch("/api/episodes");
    const data = await response.json();
    setEpisodes(data.episodes ?? []);
  }

  async function loadInterestsData() {
    try {
      const response = await fetch("/api/interests");
      const data = await response.json();
      setInterests(data.interests ?? []);
    } catch {
      // Ignore
    }
  }

  async function handleGenerateAudio() {
    setLoading(true);
    setError("");
    setProgress(null);
    setShowVoicePicker(false);
    stopRecovery();
    let recovering = false;

    try {
      const result = await callSSE(`/api/episodes/${id}/audio`, {
        body: { mock, voices: { s1: voiceS1, s2: voiceS2 } },
        onProgress: setProgress,
        onError: (msg) => { throw new Error(msg); },
        onDone: (data) => data,
      });

      // Reload to get fresh data
      await loadEpisode();
      await loadEpisodes();
    } catch (caught) {
      if (isNetworkError(caught)) {
        try {
          const response = await fetch("/api/generations/active");
          const data = await response.json();
          if (data.active?.length > 0) {
            recovering = true;
            startRecovery(data.active[0].id);
            return;
          }
        } catch {
          // Can't reach server — fall through to error
        }
      }
      setError(caught.message);
    } finally {
      if (!recovering) {
        setLoading(false);
        setProgress(null);
      }
    }
  }

  async function saveScriptEdits(scriptMarkdown) {
    const response = await fetch(`/api/episodes/${id}/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: scriptMarkdown }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error ?? "保存失败");
    }
    await loadEpisode();
  }

  async function submitFeedback() {
    if (!episode?.id) {
      setFeedbackStatus("先生成或选择一集。");
      return;
    }

    setFeedbackStatus("保存中...");
    const response = await fetch(`/api/episodes/${episode.id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feedback),
    });
    const data = await response.json();
    setFeedbackStatus(response.ok ? "反馈已保存到 memory/feedback.jsonl。" : data.error ?? "保存失败");
  }

  function progressText(stage, detail) {
    switch (stage) {
      case "generating_audio":
        return `合成第 ${detail.segment ?? "?"}/${detail.total ?? "?"} 段音频...`;
      case "audio_done":
        return null;
      case "combining":
        return "拼接完整音频...";
      case "done":
        return "生成完成";
      default:
        return null;
    }
  }

  const isScripted = episode?.status === "scripted";
  const isComplete = episode?.status === "complete" || (!episode?.status && episode?.audioUrl);

  return (
    <main className="shell">
      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <Link to="/" className="back-link">← Studio</Link>
            <h1>{episode?.title ?? "加载中..."}</h1>
            <p className="summary">{episode?.summary ?? ""}</p>
          </div>
          <div className="topbar-right">
            <label className="mock-toggle-pill">
              <input type="checkbox" checked={mock} onChange={(event) => setMock(event.target.checked)} />
              Mock
            </label>
          </div>
        </header>

        {error ? <p className="error">{error}</p> : null}

        {loading ? (
          <div className="progress-bar">
            <div className="progress-text">{progress ? progressText(progress.stage, progress.detail) : "启动中..."}</div>
          </div>
        ) : null}

        {isScripted ? (
          <section className="panel">
            <div className="panel-head">
              <h2>脚本（无音频）</h2>
              <div className="action-buttons">
                <button onClick={() => setShowVoicePicker(!showVoicePicker)} disabled={loading}>
                  生成音频
                </button>
              </div>
            </div>
            {showVoicePicker ? (
              <div className="regenerate-voice-picker">
                <VoiceSelectors
                  voiceOptions={voiceOptions}
                  voiceS1={voiceS1}
                  voiceS2={voiceS2}
                  onChangeS1={setVoiceS1}
                  onChangeS2={setVoiceS2}
                />
                <button onClick={handleGenerateAudio} disabled={loading}>
                  {loading ? "生成中..." : "确认生成"}
                </button>
              </div>
            ) : null}
            <ScriptEditor initialScript={episode?.script} onSave={saveScriptEdits} />
          </section>
        ) : null}

        {isComplete ? (
          <>
            <section className="panel episode-panel">
              <div className="panel-head">
                <h2>音频</h2>
                {episode?.wavUrl ? (
                  <a href={`/api/episodes/${id}/download/audio.wav`} className="download-link">下载 WAV</a>
                ) : null}
              </div>
              {episode?.audioUrl ? (
                <audio controls src={episode.audioUrl} />
              ) : null}

              {episode?.segments?.length > 1 ? (
                <div className="segments-section">
                  <h3>分段播放</h3>
                  {episode.segments.map((seg, i) => (
                    <SegmentCard key={i} segment={seg} index={i} episodeId={id} />
                  ))}
                </div>
              ) : null}
            </section>

            <section className="panel script-panel">
              <h2>脚本</h2>
              <ScriptEditor initialScript={episode?.script} onSave={saveScriptEdits} />
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>重新生成音频</h2>
                <button onClick={() => setShowVoicePicker(!showVoicePicker)} disabled={loading}>
                  {showVoicePicker ? "收起" : "换声线"}
                </button>
              </div>
              {showVoicePicker ? (
                <div className="regenerate-voice-picker">
                  <VoiceSelectors
                    voiceOptions={voiceOptions}
                    voiceS1={voiceS1}
                    voiceS2={voiceS2}
                    onChangeS1={setVoiceS1}
                    onChangeS2={setVoiceS2}
                  />
                  <button onClick={handleGenerateAudio} disabled={loading}>
                    {loading ? "生成中..." : "重新生成"}
                  </button>
                </div>
              ) : null}
            </section>

            <section className="panel feedback-panel">
              <h2>听后反馈</h2>
              <StarRating label="选题" value={feedback.topic} onChange={(topic) => setFeedback({ ...feedback, topic })} />
              <StarRating label="节奏" value={feedback.rhythm} onChange={(rhythm) => setFeedback({ ...feedback, rhythm })} />
              <StarRating label="声音" value={feedback.voice} onChange={(voice) => setFeedback({ ...feedback, voice })} />
              <div className="feedback-cards">
                <div className="feedback-card">
                  <div className="feedback-card-title">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                    <span>喜欢</span>
                  </div>
                  <input type="text" value={feedback.liked} onChange={(event) => setFeedback({ ...feedback, liked: event.target.value })} placeholder="你最喜欢这个节目的什么..." />
                </div>
                <div className="feedback-card">
                  <div className="feedback-card-title">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>不太喜欢</span>
                  </div>
                  <input type="text" value={feedback.disliked} onChange={(event) => setFeedback({ ...feedback, disliked: event.target.value })} placeholder="有什么可以改进的地方..." />
                </div>
                <div className="feedback-card">
                  <div className="feedback-card-title">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z" />
                    </svg>
                    <span>下次想听</span>
                  </div>
                  <input type="text" value={feedback.next} onChange={(event) => setFeedback({ ...feedback, next: event.target.value })} placeholder="想听什么新话题..." />
                </div>
              </div>
              <button className="btn-primary" onClick={submitFeedback}>保存反馈</button>
              <p className="status">{feedbackStatus}</p>
            </section>
          </>
        ) : null}
      </section>

      <HistorySidebar
        episodes={episodes}
        interests={interests}
        onInterestsChange={setInterests}
        onEpisodeDeleted={(deletedId) => {
          loadEpisodes();
          if (deletedId === id) navigate("/");
        }}
      />
    </main>
  );
}

function SegmentCard({ segment, index, episodeId }) {
  const [expanded, setExpanded] = useState(false);
  // segment.audioFile looks like "segments/segment-1.wav"; use mp3File if available
  const downloadFile = segment.mp3File ?? segment.audioFile;

  return (
    <div className="segment-card">
      <div className="segment-card-head">
        <button className="segment-title-btn" onClick={() => setExpanded(!expanded)}>
          <span>{index + 1}. {segment.title}</span>
          <span className="segment-toggle">{expanded ? "▾" : "▸"}</span>
        </button>
        <div className="segment-audio-row">
          {segment.audioUrl ? (
            <audio controls src={segment.audioUrl} className="segment-audio" />
          ) : null}
          {downloadFile ? (
            <a href={`/api/episodes/${episodeId}/download/${downloadFile}`} className="download-link">下载</a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const STAR_VALUES = [2, 4, 6, 8, 10];

function StarRating({ label, value, onChange }) {
  const [hovered, setHovered] = useState(-1);

  return (
    <div className="star-rating">
      <span className="star-rating-label">{label}</span>
      <div
        className="star-rating-stars"
        onMouseLeave={() => setHovered(-1)}
      >
        {STAR_VALUES.map((starValue, i) => {
          const filled = hovered >= 0 ? i <= hovered : value >= starValue;
          return (
            <button
              key={i}
              type="button"
              className={`star-btn${filled ? " filled" : ""}`}
              onClick={() => onChange(starValue)}
              onMouseEnter={() => setHovered(i)}
            >
              <svg viewBox="-1 -1 26 26" width="28" height="28" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}
