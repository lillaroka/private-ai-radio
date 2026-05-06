import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { loadLocalEnv } from "./lib/load-local-env.mjs";
import {
  generateScript,
  generateAudio,
  saveScript,
  fetchAndExtractArticle,
} from "./lib/episode-pipeline.mjs";
import { getVoiceOptions } from "./lib/tts.mjs";
import { loadEpisodeList, loadEpisode, saveFeedback, formatEpisodeId } from "./lib/episode-store.mjs";
import { loadInterests, saveInterests } from "./lib/memory.mjs";

const activeGenerations = new Map(); // episodeId → { stage, detail, error?, done?, episode? }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv(__dirname);

const app = express();
const port = Number(process.env.PORT ?? 5173);

app.use(express.json({ limit: "2mb" }));
app.use("/episodes", express.static(path.join(__dirname, "episodes")));

app.get("/api/episodes/:id/download/:file", async (request, response) => {
  const { id, file } = request.params;
  const filePath = path.join(__dirname, "episodes", id, file);
  try {
    await readFile(filePath);
  } catch {
    return response.status(404).send("Not found");
  }
  // Derive a friendly filename: read manifest title
  let title = id;
  try {
    const manifest = JSON.parse(await readFile(path.join(__dirname, "episodes", id, "manifest.json"), "utf-8"));
    if (manifest.title) title = manifest.title;
  } catch {}
  const ext = path.extname(file);
  const filename = file.startsWith("audio.")
    ? `${title} - full${ext}`
    : `${title} - part ${file.match(/(\d+)/)?.[1] ?? ""}${ext}`;
  response.download(filePath, filename);
});

app.get("/api/voices", (_request, response) => {
  response.json({ voices: getVoiceOptions() });
});

app.get("/api/materials", async (_request, response) => {
  const filePath = path.join(__dirname, "content", "materials.json");
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    response.json(data);
  } catch {
    response.json({ materials: [] });
  }
});

app.put("/api/materials", async (request, response) => {
  const materials = request.body?.materials;
  if (!Array.isArray(materials)) {
    response.status(400).json({ error: "materials must be an array." });
    return;
  }
  await mkdir(path.join(__dirname, "content"), { recursive: true });
  await writeFile(
    path.join(__dirname, "content", "materials.json"),
    `${JSON.stringify({ materials }, null, 2)}\n`,
  );
  response.json({ ok: true });
});

app.get("/api/episodes", async (_request, response) => {
  response.json({ episodes: await loadEpisodeList({ cwd: __dirname }) });
});

app.get("/api/episodes/:id", async (request, response) => {
  try {
    response.json({ episode: await loadEpisode({ cwd: __dirname, episodeId: request.params.id }) });
  } catch (error) {
    response.status(404).json({
      error: error?.message ?? String(error),
    });
  }
});

app.get("/api/generations/active", (_request, response) => {
  const active = [];
  for (const [id, entry] of activeGenerations) {
    if (!entry.done) {
      active.push({ id, stage: entry.stage, detail: entry.detail });
    }
  }
  response.json({ active });
});

app.get("/api/episodes/:id/progress", (request, response) => {
  const entry = activeGenerations.get(request.params.id);
  if (!entry) {
    response.status(404).json({ error: "No active generation for this episode." });
    return;
  }
  response.json({ id: request.params.id, ...entry });
});

app.post("/api/episodes", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  let clientConnected = true;
  response.on("close", () => { console.log("[sse] client disconnected"); clientConnected = false; });

  function sendEvent(data) {
    if (clientConnected) {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  const now = new Date();
  const episodeId = formatEpisodeId(now);
  activeGenerations.set(episodeId, { stage: "starting", detail: {} });

  try {
    const materials = Array.isArray(request.body?.materials) ? request.body.materials : [];
    const mock = Boolean(request.body?.mock);
    const skipSearch = Boolean(request.body?.skipSearch);
    const voices = request.body?.voices;

    if (materials.length === 0) {
      sendEvent({ stage: "error", error: "请至少添加一条素材。" });
      activeGenerations.delete(episodeId);
      if (clientConnected) response.end();
      return;
    }

    const combinedInput = await buildInputFromMaterials(materials);

    const scripted = await generateScript({
      cwd: __dirname,
      inputText: combinedInput,
      mock,
      now,
      skipSearch,
      onProgress(stage, detail) {
        activeGenerations.set(episodeId, { stage, detail });
        sendEvent({ stage, detail });
      },
    });

    const episode = await generateAudio({
      episodeId: scripted.id,
      cwd: __dirname,
      voices,
      mock,
      onProgress(stage, detail) {
        activeGenerations.set(episodeId, { stage, detail });
        sendEvent({ stage, detail });
      },
    });

    const episodeData = {
      id: episode.id,
      title: episode.manifest.title,
      summary: episode.manifest.summary,
      script: episode.scriptMarkdown,
      audioUrl: `/episodes/${episode.id}/audio.mp3`,
      wavUrl: `/episodes/${episode.id}/audio.wav`,
      segments: episode.manifest.segments.map((seg) => ({
        ...seg,
        audioUrl: `/episodes/${episode.id}/${seg.mp3File ?? seg.audioFile}`,
      })),
    };

    activeGenerations.set(episodeId, { stage: "done", detail: {}, done: true, episode: episodeData });
    sendEvent({ stage: "done", episode: episodeData });
  } catch (error) {
    activeGenerations.set(episodeId, { stage: "error", detail: {}, error: error?.message ?? String(error) });
    sendEvent({ stage: "error", error: error?.message ?? String(error) });
  } finally {
    if (clientConnected) response.end();
    // Clean up progress entry after 60s
    setTimeout(() => activeGenerations.delete(episodeId), 60_000);
  }
});

app.post("/api/episodes/script", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  let clientConnected = true;
  response.on("close", () => { console.log("[sse] client disconnected"); clientConnected = false; });

  function sendEvent(data) {
    if (clientConnected) {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  const now = new Date();
  const episodeId = formatEpisodeId(now);
  activeGenerations.set(episodeId, { stage: "starting", detail: {} });

  try {
    const materials = Array.isArray(request.body?.materials) ? request.body.materials : [];
    const mock = Boolean(request.body?.mock);
    const skipSearch = Boolean(request.body?.skipSearch);

    if (materials.length === 0) {
      sendEvent({ stage: "error", error: "请至少添加一条素材。" });
      activeGenerations.delete(episodeId);
      if (clientConnected) response.end();
      return;
    }

    const combinedInput = await buildInputFromMaterials(materials);

    const scripted = await generateScript({
      cwd: __dirname,
      inputText: combinedInput,
      mock,
      now,
      skipSearch,
      onProgress(stage, detail) {
        activeGenerations.set(episodeId, { stage, detail });
        sendEvent({ stage, detail });
      },
    });

    const episodeData = {
      id: scripted.id,
      title: scripted.title,
      summary: scripted.summary,
      script: scripted.scriptMarkdown,
      status: "scripted",
      audioUrl: null,
      segments: scripted.manifest.segments.map((seg) => ({
        ...seg,
      })),
    };

    activeGenerations.set(episodeId, { stage: "done", detail: {}, done: true, episode: episodeData });
    sendEvent({ stage: "done", episode: episodeData });
  } catch (error) {
    activeGenerations.set(episodeId, { stage: "error", detail: {}, error: error?.message ?? String(error) });
    sendEvent({ stage: "error", error: error?.message ?? String(error) });
  } finally {
    if (clientConnected) response.end();
    setTimeout(() => activeGenerations.delete(episodeId), 60_000);
  }
});

app.post("/api/episodes/:id/audio", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  let clientConnected = true;
  response.on("close", () => { console.log("[sse] client disconnected"); clientConnected = false; });

  function sendEvent(data) {
    if (clientConnected) {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  const episodeId = request.params.id;
  activeGenerations.set(episodeId, { stage: "starting", detail: {} });

  try {
    const mock = Boolean(request.body?.mock);
    const voices = request.body?.voices;

    const result = await generateAudio({
      episodeId,
      cwd: __dirname,
      voices,
      mock,
      onProgress(stage, detail) {
        activeGenerations.set(episodeId, { stage, detail });
        sendEvent({ stage, detail });
      },
    });

    const episodeData = {
      id: result.id,
      audioUrl: `/episodes/${result.id}/audio.mp3`,
      wavUrl: `/episodes/${result.id}/audio.wav`,
      status: "complete",
      segments: result.manifest.segments.map((seg) => ({
        ...seg,
        audioUrl: `/episodes/${result.id}/${seg.mp3File ?? seg.audioFile}`,
      })),
    };

    activeGenerations.set(episodeId, { stage: "done", detail: {}, done: true, episode: episodeData });
    sendEvent({ stage: "done", episode: episodeData });
  } catch (error) {
    activeGenerations.set(episodeId, { stage: "error", detail: {}, error: error?.message ?? String(error) });
    sendEvent({ stage: "error", error: error?.message ?? String(error) });
  } finally {
    if (clientConnected) response.end();
    setTimeout(() => activeGenerations.delete(episodeId), 60_000);
  }
});

app.put("/api/episodes/:id/script", async (request, response) => {
  try {
    const scriptMarkdown = request.body?.script;
    if (!scriptMarkdown?.trim()) {
      response.status(400).json({ error: "Script content is required." });
      return;
    }

    const result = await saveScript({
      episodeId: request.params.id,
      scriptMarkdown,
      cwd: __dirname,
    });

    response.json({ ok: true, segments: result.segments });
  } catch (error) {
    response.status(500).json({
      error: error?.message ?? String(error),
    });
  }
});

async function buildInputFromMaterials(materials) {
  const parts = [];
  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    const typeLabels = { text: "文本笔记", url: "URL 文章", topic: "话题" };
    const label = typeLabels[m.type] ?? "素材";
    if (m.type === "url") {
      let content = m.content;
      try {
        content = await fetchAndExtractArticle(m.content);
      } catch {
        content = m.preview || m.content;
      }
      parts.push(`=== 素材 ${i + 1}（${label}）===\n${content}`);
    } else if (m.type === "topic") {
      parts.push(`=== 素材 ${i + 1}（话题：${m.content}）===\n[话题，请搜索相关素材]`);
    } else {
      parts.push(`=== 素材 ${i + 1}（${label}）===\n${m.content}`);
    }
  }
  return parts.join("\n\n");
}

app.post("/api/fetch-url", async (request, response) => {
  try {
    const url = String(request.body?.url ?? "").trim();
    if (!url) {
      response.status(400).json({ error: "Missing url parameter." });
      return;
    }
    const text = await fetchAndExtractArticle(url);
    response.json({ text });
  } catch (error) {
    response.status(500).json({
      error: error?.message ?? String(error),
    });
  }
});

app.get("/api/interests", async (_request, response) => {
  const data = await loadInterests(__dirname);
  response.json(data);
});

app.put("/api/interests", async (request, response) => {
  const interests = request.body?.interests;
  if (!Array.isArray(interests)) {
    response.status(400).json({ error: "interests must be an array." });
    return;
  }
  await saveInterests({ cwd: __dirname, interests });
  response.json({ ok: true });
});

app.delete("/api/episodes/:id", async (request, response) => {
  try {
    const episodeDir = path.join(__dirname, "episodes", request.params.id);
    await rm(episodeDir, { recursive: true, force: true });
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error?.message ?? "删除失败" });
  }
});

app.post("/api/episodes/:id/feedback", async (request, response) => {
  try {
    const feedback = await saveFeedback({
      cwd: __dirname,
      episodeId: request.params.id,
      feedback: request.body,
    });
    response.json({ feedback });
  } catch (error) {
    response.status(500).json({
      error: error?.message ?? String(error),
    });
  }
});

app.use(express.static(path.join(__dirname, "dist")));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, "dist", "index.html"));
});

const server = app.listen(port, "127.0.0.1", async () => {
  console.log(`Private AI Radio is running at http://127.0.0.1:${port}`);

  // Check ffmpeg availability
  try {
    const { execFile: checkExec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(checkExec)("ffmpeg", ["-version"], { stdio: "pipe" });
  } catch {
    console.warn("[warn] ffmpeg not found — audio generation will fail. Install: brew install ffmpeg");
  }
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
