import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import VoiceSelectors from "../components/VoiceSelectors";
import ScriptEditor from "../components/ScriptEditor";
import HistorySidebar from "../components/HistorySidebar";
import { useSSE } from "../hooks/useSSE";

function isNetworkError(error) {
  return error?.name === "AbortError" ||
    error?.name === "TypeError" ||
    /fetch|network|Failed to fetch/i.test(error?.message ?? "");
}

function todayTag() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export default function StudioPage() {
  const [materials, setMaterials] = useState([]);
  const [episodes, setEpisodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);
  const [mock, setMock] = useState(false);
  const [voiceOptions, setVoiceOptions] = useState([]);
  const [voiceS1, setVoiceS1] = useState("demo1");
  const [voiceS2, setVoiceS2] = useState("demo2");
  const [interests, setInterests] = useState([]);
  const [scriptedEpisode, setScriptedEpisode] = useState(null);
  const [recoveringId, setRecoveringId] = useState(null);
  const [skipSearch, setSkipSearch] = useState(() => localStorage.getItem("skipSearch") === "true");

  const saveTimerRef = useRef(null);
  const recoveryRef = useRef(null);
  const navigate = useNavigate();
  const { call: callSSE, abort } = useSSE();

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
          // Server may have restarted — check if episode exists on disk
          stopRecovery();
          try {
            const epResponse = await fetch(`/api/episodes/${episodeId}`);
            if (epResponse.ok) {
              const epData = await epResponse.json();
              await refresh();
              if (epData.episode?.status === "complete") {
                navigate(`/episode/${episodeId}`);
              } else if (epData.episode?.status === "scripted") {
                setScriptedEpisode(epData.episode);
              }
            }
          } catch {
            // Episode not found either — stop polling
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
          await refresh();
          if (data.episode.status === "scripted") {
            setScriptedEpisode(data.episode);
          } else {
            navigate(`/episode/${episodeId}`);
          }
          setLoading(false);
          setProgress(null);
        }
      } catch {
        // Network blip — keep polling
      }
    }, 2000);
  }

  async function checkForInProgressGeneration() {
    try {
      const response = await fetch("/api/generations/active");
      const data = await response.json();
      if (data.active?.length > 0) {
        startRecovery(data.active[0].id);
      }
    } catch {
      // Ignore
    }
  }

  useEffect(() => {
    refresh();
    loadInterestsData();
    loadVoices();
    checkForInProgressGeneration();
    return () => stopRecovery();
  }, []);

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

  const saveMaterials = useCallback((updated) => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch("/api/materials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materials: updated }),
      });
    }, 300);
  }, []);

  async function refresh() {
    const [materialsResponse, episodesResponse] = await Promise.all([
      fetch("/api/materials"),
      fetch("/api/episodes"),
    ]);
    const materialsData = await materialsResponse.json();
    const episodesData = await episodesResponse.json();
    setMaterials(materialsData.materials ?? []);
    setEpisodes(episodesData.episodes ?? []);
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

  function addMaterial(type, content, preview) {
    const item = {
      id: Date.now().toString(36),
      type,
      content,
      preview: preview ?? "",
    };
    const updated = [...materials, item];
    setMaterials(updated);
    saveMaterials(updated);
  }

  function removeMaterial(id) {
    const updated = materials.filter((m) => m.id !== id);
    setMaterials(updated);
    saveMaterials(updated);
  }

  async function generateScriptOnly() {
    setLoading(true);
    setError("");
    setProgress(null);
    setScriptedEpisode(null);
    stopRecovery();
    let recovering = false;

    try {
      const episodeData = await callSSE("/api/episodes/script", {
        body: { materials, mock, skipSearch },
        onProgress: setProgress,
        onError: (msg) => { throw new Error(msg); },
        onDone: (data) => data,
      });

      setScriptedEpisode(episodeData);
      await refresh();
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

  async function generateFull() {
    setLoading(true);
    setError("");
    setProgress(null);
    setScriptedEpisode(null);
    stopRecovery();
    let recovering = false;

    try {
      const episodeData = await callSSE("/api/episodes", {
        body: { materials, mock, skipSearch, voices: { s1: voiceS1, s2: voiceS2 } },
        onProgress: setProgress,
        onError: (msg) => { throw new Error(msg); },
        onDone: (data) => data,
      });

      await refresh();
      navigate(`/episode/${episodeData.id}`);
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

  async function generateAudioForScripted() {
    if (!scriptedEpisode?.id) return;
    setLoading(true);
    setError("");
    setProgress(null);
    stopRecovery();
    let recovering = false;

    try {
      const episodeData = await callSSE(`/api/episodes/${scriptedEpisode.id}/audio`, {
        body: { mock, voices: { s1: voiceS1, s2: voiceS2 } },
        onProgress: setProgress,
        onError: (msg) => { throw new Error(msg); },
        onDone: (data) => data,
      });

      await refresh();
      navigate(`/episode/${episodeData.id}`);
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
    if (!scriptedEpisode?.id) return;
    const response = await fetch(`/api/episodes/${scriptedEpisode.id}/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: scriptMarkdown }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error ?? "保存失败");
    }
  }

  function progressText(stage, detail) {
    switch (stage) {
      case "researching":
        return "搜索补充素材中...";
      case "researched":
        return `搜索完成，找到 ${detail.sources ?? 0} 条素材`;
      case "writing":
        return "撰写脚本中...";
      case "written":
        return `脚本完成，共 ${detail.segments ?? 0} 个段落`;
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

  const typeLabels = { text: "文本", url: "URL", topic: "话题" };

  return (
    <main className="shell">
      {/* Background decorations */}
      <svg className="bg-decoration bg-leaf-shadow" viewBox="0 0 500 500" fill="none" aria-hidden="true">
        <defs>
          <filter id="leaf-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" />
          </filter>
          <g id="broad-leaf">
            <path d="M 0,0 C 34,-40 50,-90 34,-130 C 18,-160 8,-170 0,-175 C -8,-170 -18,-160 -34,-130 C -50,-90 -34,-40 0,0 Z" fill="#6b8b6b" />
            <line x1="0" y1="0" x2="0" y2="-170" stroke="#6b8b6b" strokeWidth="1" opacity="0.6" />
          </g>
        </defs>
        <g filter="url(#leaf-shadow)" opacity="0.10">
          <line x1="50" y1="450" x2="365" y2="180" stroke="#6b8b6b" strokeWidth="3" strokeLinecap="round" />
          <g transform="translate(97, 409)">
            <use href="#broad-leaf" transform="rotate(-10) scale(0.6)" />
            <use href="#broad-leaf" transform="rotate(110) scale(0.6)" />
          </g>
          <g transform="translate(160, 356)">
            <use href="#broad-leaf" transform="rotate(-2.5) scale(0.55)" />
            <use href="#broad-leaf" transform="rotate(102.5) scale(0.55)" />
          </g>
          <g transform="translate(223, 301)">
            <use href="#broad-leaf" transform="rotate(5) scale(0.5)" />
            <use href="#broad-leaf" transform="rotate(95) scale(0.5)" />
          </g>
          <g transform="translate(286, 247)">
            <use href="#broad-leaf" transform="rotate(12.5) scale(0.45)" />
            <use href="#broad-leaf" transform="rotate(87.5) scale(0.45)" />
          </g>
          <g transform="translate(349, 193)">
            <use href="#broad-leaf" transform="rotate(20) scale(0.4)" />
            <use href="#broad-leaf" transform="rotate(80) scale(0.4)" />
          </g>
          <g transform="translate(375, 176)">
            <use href="#broad-leaf" transform="rotate(50) scale(0.6)" />
          </g>
        </g>
      </svg>
      <svg className="bg-decoration bg-leaf-upper" viewBox="0 0 500 500" fill="none" aria-hidden="true">
        <defs>
          <filter id="leaf-shadow-upper" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
          </filter>
          <g id="broad-leaf-upper">
            <path d="M 0,0 C 34,-40 50,-90 34,-130 C 18,-160 8,-170 0,-175 C -8,-170 -18,-160 -34,-130 C -50,-90 -34,-40 0,0 Z" fill="#6b8b6b" />
            <line x1="0" y1="0" x2="0" y2="-170" stroke="#6b8b6b" strokeWidth="1" opacity="0.6" />
          </g>
        </defs>
        <g filter="url(#leaf-shadow-upper)" opacity="0.07">
          <line x1="20" y1="20" x2="220" y2="220" stroke="#6b8b6b" strokeWidth="2.5" strokeLinecap="round" />
          <g transform="translate(80, 80)"><use href="#broad-leaf-upper" transform="rotate(35) scale(0.45)" /><use href="#broad-leaf-upper" transform="rotate(155) scale(0.45)" /></g>
          <g transform="translate(150, 150)"><use href="#broad-leaf-upper" transform="rotate(45) scale(0.4)" /><use href="#broad-leaf-upper" transform="rotate(145) scale(0.4)" /></g>
          <g transform="translate(220, 220)"><use href="#broad-leaf-upper" transform="rotate(90) scale(0.45)" /></g>
        </g>
      </svg>
      <svg className="bg-decoration bg-wave-ripples" viewBox="0 0 760 300" fill="none" aria-hidden="true">
        <ellipse cx="380" cy="300" rx="70" ry="45" stroke="#DDD2BF" strokeWidth="1.6" opacity="0.35" />
        <ellipse cx="380" cy="300" rx="120" ry="75" stroke="#DDD2BF" strokeWidth="1.5" opacity="0.30" />
        <ellipse cx="380" cy="300" rx="170" ry="105" stroke="#DDD2BF" strokeWidth="1.4" opacity="0.25" />
        <ellipse cx="380" cy="300" rx="220" ry="135" stroke="#DDD2BF" strokeWidth="1.2" opacity="0.21" />
        <ellipse cx="380" cy="300" rx="270" ry="165" stroke="#DDD2BF" strokeWidth="1.0" opacity="0.17" />
        <ellipse cx="380" cy="300" rx="320" ry="195" stroke="#DDD2BF" strokeWidth="0.8" opacity="0.13" />
        <ellipse cx="380" cy="300" rx="370" ry="225" stroke="#DDD2BF" strokeWidth="0.7" opacity="0.10" />
      </svg>
      <svg className="bg-decoration bg-wave-top" viewBox="0 0 500 400" fill="none" aria-hidden="true">
        <ellipse cx="500" cy="0" rx="80" ry="55" stroke="#CFC1AB" strokeWidth="1.6" opacity="0.32" />
        <ellipse cx="500" cy="0" rx="140" ry="95" stroke="#CFC1AB" strokeWidth="1.4" opacity="0.26" />
        <ellipse cx="500" cy="0" rx="210" ry="140" stroke="#CFC1AB" strokeWidth="1.2" opacity="0.20" />
        <ellipse cx="500" cy="0" rx="290" ry="190" stroke="#CFC1AB" strokeWidth="1.0" opacity="0.15" />
        <ellipse cx="500" cy="0" rx="380" ry="245" stroke="#CFC1AB" strokeWidth="0.8" opacity="0.10" />
        <ellipse cx="500" cy="0" rx="480" ry="310" stroke="#CFC1AB" strokeWidth="0.7" opacity="0.06" />
      </svg>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <h1 className="site-title">Private AI Radio</h1>
            <div className="frequency-line">
              <svg className="frequency-line-svg" width="92" height="18" viewBox="0 0 92 18" fill="none" aria-hidden="true">
                <circle cx="3" cy="9" r="2.5" fill="#1F7A67" />
                <rect x="12" y="6" width="2" height="6" rx="1" fill="#1F7A67" />
                <rect x="18" y="3" width="2" height="12" rx="1" fill="#1F7A67" />
                <rect x="24" y="1" width="2" height="16" rx="1" fill="#1F7A67" />
                <rect x="30" y="4" width="2" height="10" rx="1" fill="#1F7A67" />
                <rect x="36" y="6" width="2" height="6" rx="1" fill="#1F7A67" />
                <line x1="46" y1="9" x2="92" y2="9" stroke="#D7D0C3" strokeWidth="1" />
              </svg>
              <span className="frequency-label">私人频段 · 今日入站</span>
              <span className="frequency-line-tail" />
            </div>
            <p className="site-subtitle">把今天的碎片，调成一段只给你们听的双人电台。</p>
          </div>
          <div className="topbar-right">
            <span className="pill pill-date">今日频段 {todayTag()}</span>
            <label className="mock-toggle-pill">
              <input type="checkbox" checked={mock} onChange={(event) => setMock(event.target.checked)} />
              Mock
            </label>
          </div>
        </header>

        <section className="panel input-panel">
          <div className="panel-head">
            <div className="panel-title-row">
              <div className="panel-title-accent" />
              <h2>今日素材</h2>
              <button
                className={`search-toggle${skipSearch ? " off" : ""}`}
                onClick={() => setSkipSearch((v) => { const next = !v; localStorage.setItem("skipSearch", next); return next; })}
                title={skipSearch ? "搜索已关闭，点击开启" : "搜索已开启，点击关闭"}
              >
                {skipSearch ? (
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="8.5" cy="8.5" r="5.5" />
                    <line x1="12.5" y1="12.5" x2="17" y2="17" />
                    <line x1="3" y1="3" x2="14" y2="14" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="8.5" cy="8.5" r="5.5" />
                    <line x1="12.5" y1="12.5" x2="17" y2="17" />
                  </svg>
                )}
              </button>
              <span className="status-indicator">
                <span className="status-dot" />
                待开播
              </span>
            </div>
            <div className="action-buttons">
              <button className="btn-ghost" onClick={generateScriptOnly} disabled={loading || materials.length === 0}>
                {loading && !progress ? "启动中..." : "只写脚本"}
              </button>
              <button className="btn-primary" onClick={generateFull} disabled={loading || materials.length === 0}>
                {loading ? (progress ? progressText(progress.stage, progress.detail) : "启动中...") : "一键生成"}
              </button>
            </div>
          </div>

          <VoiceSelectors
            voiceOptions={voiceOptions}
            voiceS1={voiceS1}
            voiceS2={voiceS2}
            onChangeS1={setVoiceS1}
            onChangeS2={setVoiceS2}
          />

          {loading ? (
            <div className="progress-bar">
              <div className="progress-text">{progress ? progressText(progress.stage, progress.detail) : "启动中..."}</div>
            </div>
          ) : null}

          <div className="materials-list">
            {materials.map((m) => (
              <div key={m.id} className="material-card">
                <span className="material-type">{typeLabels[m.type] ?? m.type}</span>
                <span className="material-content">
                  {m.type === "url" && m.preview
                    ? m.preview.slice(0, 120) + (m.preview.length > 120 ? "..." : "")
                    : m.content.length > 200
                      ? m.content.slice(0, 200) + "..."
                      : m.content}
                </span>
                <button className="material-remove" onClick={() => removeMaterial(m.id)}>&times;</button>
              </div>
            ))}
          </div>

          <MaterialAddRow onAdd={addMaterial} />

          {error ? <p className="error">{error}</p> : null}
        </section>

        {scriptedEpisode ? (
          <section className="panel script-panel">
            <div className="panel-head">
              <h2>{scriptedEpisode.title ?? "脚本预览"}</h2>
              <button className="btn-primary" onClick={generateAudioForScripted} disabled={loading}>
                {loading ? "生成音频中..." : "生成音频"}
              </button>
            </div>
            <p className="summary">{scriptedEpisode.summary ?? ""}</p>
            <ScriptEditor initialScript={scriptedEpisode.script} onSave={saveScriptEdits} />
          </section>
        ) : null}
      </section>

      <HistorySidebar
        episodes={episodes}
        interests={interests}
        onInterestsChange={setInterests}
        onEpisodeDeleted={() => refresh()}
      />
    </main>
  );
}

function MaterialAddRow({ onAdd }) {
  const [type, setType] = useState("text");
  const [content, setContent] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    if (!content.trim()) return;

    let preview = "";
    if (type === "url") {
      setAdding(true);
      try {
        const response = await fetch("/api/fetch-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: content.trim() }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "提取失败");
        }
        preview = (data.text ?? "").slice(0, 200);
      } catch {
        // Still add the URL even if extraction fails
      } finally {
        setAdding(false);
      }
    }

    onAdd(type, content.trim(), preview);
    setContent("");
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey && type !== "text") {
      event.preventDefault();
      handleAdd();
    }
  }

  return (
    <div className="material-add-row">
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="text">文本</option>
        <option value="url">URL</option>
        <option value="topic">话题</option>
      </select>
      <input
        type="text"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={type === "url" ? "https://..." : type === "topic" ? "想聊的话题..." : "输入文本内容..."}
        spellCheck="false"
      />
      <button onClick={handleAdd} disabled={adding || !content.trim()}>
        {adding ? "..." : "+"}
      </button>
    </div>
  );
}
