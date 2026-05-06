import { useState } from "react";
import { Link } from "react-router";

const PAGE_SIZE = 5;

function formatEpisodeTime(id) {
  // IDs are like "2026-05-05T00-56-23" or "2026-05-05T00:56:23"
  const match = id.match(/^(\d{4})-(\d{2})-(\d{2})T?(\d{2})[-:](\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}\u00A0·\u00A0${match[4]}:${match[5]}`;
  }
  return id;
}

export default function HistorySidebar({ episodes, interests, onInterestsChange, onEpisodeDeleted }) {
  const [newInterestLabel, setNewInterestLabel] = useState("");
  const [newInterestQueries, setNewInterestQueries] = useState("");
  const [showAll, setShowAll] = useState(false);

  async function deleteEpisode(episodeId, event) {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm(`确定删除这期节目吗？脚本和音频都会被永久删除。`)) return;
    try {
      const response = await fetch(`/api/episodes/${episodeId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        alert(data.error ?? "删除失败");
        return;
      }
      onEpisodeDeleted?.(episodeId);
    } catch {
      alert("删除失败");
    }
  }

  function addInterest() {
    if (!newInterestLabel.trim()) return;
    const queries = newInterestQueries
      .split(/[,，、]/)
      .map((q) => q.trim())
      .filter(Boolean);
    const updated = [
      ...interests,
      { id: Date.now().toString(36), label: newInterestLabel.trim(), queries: queries.length ? queries : [newInterestLabel.trim()] },
    ];
    onInterestsChange?.(updated);
    setNewInterestLabel("");
    setNewInterestQueries("");
    fetch("/api/interests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interests: updated }),
    });
  }

  function removeInterest(id) {
    const updated = interests.filter((i) => i.id !== id);
    onInterestsChange?.(updated);
    fetch("/api/interests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interests: updated }),
    });
  }

  const visibleEpisodes = showAll ? episodes : episodes.slice(0, PAGE_SIZE);
  const hasMore = episodes.length > PAGE_SIZE;

  return (
    <aside className="history">
      <div className="history-header">
        <div className="history-title-row">
          <svg className="history-title-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <polyline points="8,4.5 8,8 10.5,9.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <h2>历史节目</h2>
        </div>
        <p className="history-subtitle">已保存的私人频段</p>
      </div>

      {visibleEpisodes.map((episode) => (
        <div key={episode.id} className="episode-card-wrapper">
          <Link
            className={`episode-card ${episode.status === "scripted" ? "episode-scripted" : ""}`}
            to={`/episode/${episode.id}`}
          >
            <div className="episode-icon-block">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 18v-6a9 9 0 0118 0v6" />
                <path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
              </svg>
            </div>
            <div className="episode-card-body">
              <strong>{episode.title}</strong>
              <div className="episode-meta">
                <span className="episode-time">{formatEpisodeTime(episode.id)}</span>
                {episode.status === "scripted" ? (
                  <span className="episode-pill">仅脚本</span>
                ) : null}
              </div>
            </div>
          </Link>
          <button className="episode-delete" onClick={(e) => deleteEpisode(episode.id, e)} title="删除节目">×</button>
        </div>
      ))}

      {hasMore ? (
        <button className="history-show-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "收起" : `查看更多（${episodes.length - PAGE_SIZE}）`}
        </button>
      ) : null}

      <div className="interests-section">
        <h2>兴趣标签</h2>
        {interests.map((interest) => (
          <div key={interest.id} className="interest-tag">
            <span>{interest.label}</span>
            <button className="interest-remove" onClick={() => removeInterest(interest.id)}>×</button>
          </div>
        ))}
        <div className="interest-add">
          <input
            value={newInterestLabel}
            onChange={(e) => setNewInterestLabel(e.target.value)}
            placeholder="兴趣描述"
          />
          <input
            value={newInterestQueries}
            onChange={(e) => setNewInterestQueries(e.target.value)}
            placeholder="搜索词（逗号分隔）"
          />
          <button onClick={addInterest} disabled={!newInterestLabel.trim()}>添加</button>
        </div>
      </div>
    </aside>
  );
}
