import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { readTextFile, readFeedbackCount, readFeedbackEntries, readSummaryState, writeSummaryState, shouldSummarize, writeTasteSummary } from "./memory.mjs";
import { summarizeFeedbackWithOpenRouter } from "./llm.mjs";

export function parseMarkdownToSegments(markdown) {
  const lines = markdown.split(/\r?\n/);
  const segments = [];
  let currentTitle = null;
  let currentLines = [];
  let foundFirstSegment = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+段落\s*\d+\s*[：:]\s*(.+)$/);
    if (headingMatch) {
      if (foundFirstSegment) {
        segments.push({ title: currentTitle, script: currentLines.join("\n") });
      }
      currentTitle = headingMatch[1].trim();
      currentLines = [];
      foundFirstSegment = true;
    } else if (foundFirstSegment) {
      currentLines.push(line);
    }
  }

  if (foundFirstSegment && currentLines.some((l) => l.trim())) {
    segments.push({ title: currentTitle, script: currentLines.join("\n") });
  }

  if (segments.length === 0) {
    segments.push({ title: "完整节目", script: markdown });
  }

  return segments;
}

export function formatEpisodeId(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export async function loadEpisodeList({ cwd = process.cwd() } = {}) {
  const episodesDir = path.join(cwd, "episodes");
  await mkdir(episodesDir, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(episodesDir, { withFileTypes: true });
  const episodes = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(episodesDir, entry.name, "manifest.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const status = manifest.status ?? (manifest.segments?.every((seg) => seg.audioFile) ? "complete" : "scripted");
      episodes.push({
        id: entry.name,
        title: manifest.title ?? entry.name,
        summary: manifest.summary ?? "",
        createdAt: manifest.createdAt ?? "",
        status,
        audioUrl: status === "complete" ? `/episodes/${entry.name}/audio.mp3` : null,
        wavUrl: status === "complete" ? `/episodes/${entry.name}/audio.wav` : null,
        segments: (manifest.segments ?? []).map((seg) => ({
          ...seg,
          ...(status === "complete" ? { audioUrl: `/episodes/${entry.name}/${seg.mp3File ?? seg.audioFile}` } : {}),
        })),
      });
    } catch {
      // Skip incomplete episode folders.
    }
  }

  return episodes.sort((a, b) => b.id.localeCompare(a.id));
}

export async function loadEpisode({ episodeId, cwd = process.cwd() }) {
  const episodeDir = path.join(cwd, "episodes", episodeId);
  const manifest = JSON.parse(await readFile(path.join(episodeDir, "manifest.json"), "utf8"));
  const script = await readTextFile(path.join(episodeDir, "script.md"), "");

  const status = manifest.status ?? (manifest.segments?.every((seg) => seg.audioFile) ? "complete" : "scripted");

  const segments = (manifest.segments ?? []).map((seg) => ({
    ...seg,
    scriptUrl: `/episodes/${episodeId}/${seg.scriptFile}`,
    ...(status === "complete" ? { audioUrl: `/episodes/${episodeId}/${seg.mp3File ?? seg.audioFile}` } : {}),
  }));

  return {
    id: episodeId,
    title: manifest.title ?? episodeId,
    summary: manifest.summary ?? "",
    createdAt: manifest.createdAt ?? "",
    status,
    audioUrl: status === "complete" ? `/episodes/${episodeId}/audio.mp3` : null,
    wavUrl: status === "complete" ? `/episodes/${episodeId}/audio.wav` : null,
    segments,
    script,
  };
}

export async function saveFeedback({
  episodeId,
  feedback,
  cwd = process.cwd(),
  now = new Date(),
}) {
  if (!episodeId) {
    throw new Error("Missing episodeId.");
  }

  const normalized = {
    episodeId,
    createdAt: now.toISOString(),
    topic: Number(feedback.topic ?? 0),
    rhythm: Number(feedback.rhythm ?? 0),
    voice: Number(feedback.voice ?? 0),
    liked: String(feedback.liked ?? "").trim(),
    disliked: String(feedback.disliked ?? "").trim(),
    next: String(feedback.next ?? "").trim(),
  };

  const episodeDir = path.join(cwd, "episodes", episodeId);
  await writeFile(path.join(episodeDir, "feedback.json"), `${JSON.stringify(normalized, null, 2)}\n`);
  await appendFile(path.join(cwd, "memory", "feedback.jsonl"), `${JSON.stringify(normalized)}\n`);

  // Check if we should summarize feedback
  const totalCount = await readFeedbackCount(cwd);
  const state = await readSummaryState(cwd);
  if (shouldSummarize(totalCount, state.summarizedCount)) {
    const entries = await readFeedbackEntries(cwd);
    const summary = await summarizeFeedbackWithOpenRouter({ feedbackEntries: entries, currentTaste: "" });
    if (summary) {
      await writeTasteSummary(cwd, summary);
      await writeSummaryState(cwd, totalCount);
    }
  }

  return normalized;
}
