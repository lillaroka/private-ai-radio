import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
import { createSilentWav, fixWavHeader, combineWavs, normalizeVolume, decodeMp3ToWav, mixWithBgm, mixSingleSegmentWithBgm, linearFadeIn, trimLeadingSilence } from "./audio-utils.mjs";
import { loadMemory, loadInterests, saveInterests, readTextFile } from "./memory.mjs";
import { getWriterModel, getSearchModels, generateEpisodeWithOpenRouter } from "./llm.mjs";
import { MOSS_MODEL, SAMPLE_RATE, getMossVoiceLabel, generateSpeechWithSiliconFlow } from "./tts.mjs";
import { parseMarkdownToSegments, formatEpisodeId, loadEpisodeList, loadEpisode, saveFeedback } from "./episode-store.mjs";

export async function generateScript({
  inputText,
  cwd = process.cwd(),
  mock = false,
  now = new Date(),
  onProgress,
  skipSearch = false,
} = {}) {
  if (!inputText?.trim()) {
    throw new Error("Episode input is empty.");
  }

  const memory = await loadMemory(cwd);
  const interests = await loadInterests(cwd);
  const episodeId = formatEpisodeId(now);
  const episodeDir = path.join(cwd, "episodes", episodeId);
  await mkdir(episodeDir, { recursive: true });
  await writeFile(path.join(episodeDir, "input.md"), inputText);
  console.log(`[pipeline] Episode ${episodeId} | input=materials | mock=${mock} | interests=${interests.interests.length}`);

  const generated = mock
    ? createMockMultiSegmentScript(inputText, memory)
    : await generateEpisodeWithOpenRouter({ input: inputText, memory, interests, onProgress, skipSearch });

  const segments = parseSegmentsFromGenerated(generated);

  const research = {
    generatedAt: now.toISOString(),
    writerModel: generated.writerModel ?? (mock ? "mock" : getWriterModel()),
    searchModel: generated.searchModel ?? (mock ? "mock" : getSearchModels()[0]),
    search: {
      provider: mock ? "mock" : "openrouter:web_search",
      max_total_results: 5,
    },
    title: generated.title,
    summary: generated.summary,
    search_queries: generated.search_queries ?? [],
    sources: (generated.sources ?? []).slice(0, 5),
    notes: generated.notes ?? "",
    usage: generated.usage ?? null,
  };

  const scriptMarkdown = renderMultiSegmentMarkdown(generated, segments);
  await writeFile(path.join(episodeDir, "research.json"), `${JSON.stringify(research, null, 2)}\n`);
  await writeFile(path.join(episodeDir, "script.md"), scriptMarkdown);

  const segmentsDir = path.join(episodeDir, "segments");
  await mkdir(segmentsDir, { recursive: true });

  const segmentResults = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segScript = normalizeScript(seg.script);
    const segFileBase = `segment-${i}`;
    await writeFile(path.join(segmentsDir, `${segFileBase}.md`), segScript);
    segmentResults.push({
      index: i,
      title: seg.title,
      scriptFile: `segments/${segFileBase}.md`,
      audioFile: `segments/${segFileBase}.wav`,
    });
  }

  const manifest = {
    id: episodeId,
    createdAt: now.toISOString(),
    status: "scripted",
    title: generated.title,
    summary: generated.summary,
    inputType: "materials",
    paths: {
      input: "input.md",
      research: "research.json",
      script: "script.md",
      audio: "audio.wav",
      feedback: "feedback.json",
    },
    segments: segmentResults,
    models: {
      writer: generated.writerModel ?? (mock ? "mock" : getWriterModel()),
      search: generated.searchModel ?? (mock ? "mock" : getSearchModels()[0]),
    },
  };
  await writeFile(path.join(episodeDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    id: episodeId,
    title: generated.title,
    summary: generated.summary,
    segments,
    scriptMarkdown,
    manifest,
  };
}

export async function generateAudio({
  episodeId,
  voices,
  cwd = process.cwd(),
  mock = false,
  onProgress,
} = {}) {
  const episodeDir = path.join(cwd, "episodes", episodeId);
  const manifestPath = path.join(episodeDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const scriptMarkdown = await readTextFile(path.join(episodeDir, "script.md"), "");

  const segments = parseMarkdownToSegments(scriptMarkdown);
  const segmentsDir = path.join(episodeDir, "segments");
  await mkdir(segmentsDir, { recursive: true });

  const bgmWav = await pickRandomBgm(cwd);

  const segmentResults = [];
  const rawSegmentWavs = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segScript = cleanScriptForSave(seg.script);
    const segFileBase = `segment-${i}`;
    const isFirst = i === 0;

    await writeFile(path.join(segmentsDir, `${segFileBase}.md`), segScript);
    console.log(`[pipeline] Generating audio for segment ${i + 1}/${segments.length}: ${seg.title}`);
    onProgress?.("generating_audio", { segment: i + 1, total: segments.length });

    let segAudio = mock
      ? createSilentWav({ seconds: 3, sampleRate: SAMPLE_RATE })
      : await generateSpeechWithSiliconFlow(segScript, voices);

    segAudio = fixWavHeader(segAudio);

    // VAD: trim leading noise from TTS output
    if (!mock) {
      const trimMs = await detectLeadingNoise(segAudio, cwd);
      if (trimMs > 100) {
        console.log(`[pipeline] VAD trim: ${trimMs}ms from segment ${i + 1}`);
        segAudio = trimLeadingSilence(segAudio, trimMs);
      }
    }

    segAudio = normalizeVolume(segAudio);
    if (!isFirst) {
      segAudio = linearFadeIn(segAudio, 1000);
    }

    rawSegmentWavs.push(segAudio);

    const segAudioFinal = bgmWav ? mixSingleSegmentWithBgm(segAudio, bgmWav) : segAudio;
    const segWavPath = path.join(segmentsDir, `${segFileBase}.wav`);
    await writeFile(segWavPath, segAudioFinal);
    await wavToMp3(segWavPath, path.join(segmentsDir, `${segFileBase}.mp3`));

    onProgress?.("audio_done", { segment: i + 1, total: segments.length });
    segmentResults.push({
      index: i,
      title: seg.title,
      scriptFile: `segments/${segFileBase}.md`,
      audioFile: `segments/${segFileBase}.wav`,
      mp3File: `segments/${segFileBase}.mp3`,
    });
  }

  onProgress?.("combining", {});
  let fullAudio = normalizeVolume(combineWavs(rawSegmentWavs, 4000));

  if (bgmWav) {
    fullAudio = mixWithBgm(fullAudio, bgmWav, { speechFadeIn: 1.5 });
    console.log("[pipeline] Mixed with background music.");
  }

  await writeFile(path.join(episodeDir, "audio.wav"), fullAudio);
  await wavToMp3(path.join(episodeDir, "audio.wav"), path.join(episodeDir, "audio.mp3"));

  manifest.status = "complete";
  manifest.segments = segmentResults;
  manifest.models = {
    ...manifest.models,
    speech: mock ? "mock-silence" : MOSS_MODEL,
    voice: mock ? "mock" : getMossVoiceLabel(voices),
  };
  await writeFile(path.join(episodeDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    id: episodeId,
    dir: episodeDir,
    title: manifest.title,
    summary: manifest.summary,
    scriptMarkdown,
    audioPath: path.join(episodeDir, "audio.wav"),
    segments,
    manifest,
  };
}

export async function saveScript({ episodeId, scriptMarkdown, cwd = process.cwd() }) {
  const episodeDir = path.join(cwd, "episodes", episodeId);
  const manifestPath = path.join(episodeDir, "manifest.json");

  await writeFile(path.join(episodeDir, "script.md"), scriptMarkdown);

  const segments = parseMarkdownToSegments(scriptMarkdown);
  const segmentsDir = path.join(episodeDir, "segments");
  await mkdir(segmentsDir, { recursive: true });

  const segmentResults = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segScript = cleanScriptForSave(seg.script);
    const segFileBase = `segment-${i}`;
    await writeFile(path.join(segmentsDir, `${segFileBase}.md`), segScript);
    segmentResults.push({
      index: i,
      title: seg.title,
      scriptFile: `segments/${segFileBase}.md`,
    });
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.segments = segmentResults;
  await writeFile(path.join(episodeDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { segments, manifest };
}

export async function fetchAndExtractArticle(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RadioCraft/1.0)",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();

  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html, { url });
  const { Readability } = await import("@mozilla/readability");
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.textContent?.trim()) {
    throw new Error("Could not extract article content from the URL.");
  }

  const parts = [];
  if (article.title) parts.push(`# ${article.title}`);
  if (article.byline) parts.push(`作者：${article.byline}`);
  parts.push("");
  parts.push(
    article.textContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n"),
  );
  return parts.join("\n");
}

// --- Internal helpers ---

async function detectLeadingNoise(wavBuffer, cwd) {
  const tmpWav = path.join(cwd, ".tmp-vad.wav");
  try {
    await writeFile(tmpWav, wavBuffer);
    const script = path.join(cwd, "lib", "vad-detect.py");
    const venvPython = path.join(cwd, ".venv", "bin", "python");
    const python = await fileExists(venvPython) ? venvPython : "python3";
    const { stdout } = await execFileAsync(python, [script, tmpWav], { stdio: ["pipe", "pipe", "pipe"] });
    return parseInt(stdout.trim(), 10) || 0;
  } catch (error) {
    console.log(`[pipeline] VAD detection failed: ${error.message}`);
    return 0;
  } finally {
    try { await rm(tmpWav); } catch {}
  }
}

async function fileExists(p) {
  try { await readFile(p); return true; } catch { return false; }
}

async function wavToMp3(wavPath, mp3Path) {
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-b:a", "128k", mp3Path], {
      stdio: "pipe",
    });
  } catch (error) {
    throw new Error(
      `ffmpeg failed (is it installed?): ${error.message}\n` +
      "Install: brew install ffmpeg / apt install ffmpeg / choco install ffmpeg",
    );
  }
}

let _lastBgmFile = null;

async function pickRandomBgm(cwd) {
  const musicDir = path.join(cwd, "music");
  let files;
  try {
    files = (await readdir(musicDir)).filter((f) => f.endsWith(".mp3"));
  } catch {
    console.log("[pipeline] No music directory found.");
    return null;
  }

  if (files.length === 0) {
    console.log("[pipeline] No mp3 files in music directory.");
    return null;
  }

  // Avoid repeating the same track consecutively
  let chosen;
  if (files.length === 1) {
    chosen = files[0];
  } else {
    const candidates = files.filter((f) => f !== _lastBgmFile);
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
  }

  _lastBgmFile = chosen;
  const bgmPath = path.join(musicDir, chosen);
  console.log(`[pipeline] BGM: ${chosen}`);
  try {
    return await decodeMp3ToWav(bgmPath);
  } catch {
    console.log("[pipeline] Failed to decode BGM.");
    return null;
  }
}

function parseSegmentsFromGenerated(generated) {
  if (Array.isArray(generated.segments) && generated.segments.length > 0) {
    return generated.segments.map((seg, i) => ({
      title: seg.title ?? `段落 ${i + 1}`,
      script: ensureS1Starts(seg.script ?? ""),
    }));
  }

  if (generated.script) {
    return [{ title: generated.title ?? "完整节目", script: ensureS1Starts(generated.script) }];
  }

  throw new Error("Generated output has neither segments nor script.");
}

function renderMultiSegmentMarkdown(generated, segments) {
  const sources = (generated.sources ?? [])
    .slice(0, 5)
    .map((source, index) => `${index + 1}. [${source.title}](${source.url}) — ${source.note ?? ""}`)
    .join("\n");

  const segmentParts = segments.map((seg, i) => {
    const heading = `## 段落 ${i + 1}：${seg.title}`;
    return `${heading}\n\n${seg.script}`;
  });

  return [
    `# ${generated.title ?? "私人电台"}`,
    "",
    generated.summary ?? "",
    "",
    "## Sources",
    "",
    sources || "无外部来源。",
    "",
    segmentParts.join("\n\n"),
    "",
  ].join("\n");
}

function createMockMultiSegmentScript(input, memory) {
  return {
    title: "私人电台升级版：多段落测试",
    summary: "测试多段落脚本生成和分段音频合成。",
    search_queries: ["AI podcast multi-segment", "private radio long form"],
    sources: [
      {
        title: "Mock source",
        url: "https://example.com/mock",
        note: "Mock 模式用于测试文件产物。",
      },
    ],
    notes: "Mock multi-segment episode generated without API calls.",
    segments: [
      {
        title: "开场",
        script: normalizeScript(
          [
            "[S1]今天我们来聊聊一个新东西，就是我们自己的私人电台终于升级了。",
            "[S2]嗯，之前每次只有两三分钟，感觉刚进入状态就结束了。",
            "[S1]对，所以现在我们把节目拉长到了七八分钟，拆成几个段落。每段有自己的主题，但整体是一个连贯的对话。",
            "[S2]而且每段都可以单独播放，想听哪段跳哪段。拼接起来就是完整版。",
            "[S1]这样的话，听节目的方式就灵活多了。通勤的时候可以听一段，回家接着听完。",
            "[S2]对，这才是私人电台该有的样子。不是一口灌完，而是像泡茶一样，慢慢来。",
          ].join("\n"),
        ),
      },
      {
        title: "展开",
        script: normalizeScript(
          [
            "[S1]说到升级，这次还加了几个新功能。比如你现在可以直接贴一个 URL，系统会自动提取文章内容。",
            "[S2]这个很实用。以前得手动复制粘贴整篇文章，现在扔个链接就行了。",
            "[S1]还有兴趣系统。你可以在侧栏设置自己感兴趣的方向，生成节目的时候会联网搜索相关素材补充进来。",
            "[S2]也就是说，每期节目不只是基于你今天的输入，还会带上你长期关注的话题。",
            "[S1]对，它慢慢会变成一个真正懂你的电台。不是那种推荐算法的懂，而是你自己定义的懂。",
            "[S2]嗯，这个区别很重要。推荐算法是猜你想看什么，而这是我们告诉它我们关心什么。",
          ].join("\n"),
        ),
      },
      {
        title: "收束",
        script: normalizeScript(
          [
            "[S1]所以整体来看，这次升级把私人电台从一个实验品变成了一个可以日常使用的工具。",
            "[S2]我觉得最关键的变化是时长的扩展。两三分钟最多聊一个点，七八分钟可以真正展开一个话题。",
            "[S1]而且音频质量也修复了。之前 WAV 文件头有个 bug，现在修好了。",
            "[S2]这种基础设施的修复虽然不显眼，但对长期使用来说特别重要。",
            "[S1]没错。好了，这期测试就到这里。下次用真实内容再试试。",
            "[S2]期待。我觉得这个版本已经可以开始正经用了。",
          ].join("\n"),
        ),
      },
    ],
  };
}

function ensureS1Starts(script) {
  const lines = script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines[0].startsWith("[S2]") && lines[1].startsWith("[S1]")) {
    [lines[0], lines[1]] = [lines[1], lines[0]];
  }
  return lines.join("\n");
}

function cleanScriptForSave(script) {
  return String(script ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (/^S1[:：]/.test(trimmed)) return trimmed.replace(/^S1[:：]\s*/, "[S1]");
      if (/^S2[:：]/.test(trimmed)) return trimmed.replace(/^S2[:：]\s*/, "[S2]");
      return trimmed;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizeScript(script) {
  const lines = String(script ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^\[(S1|S2)\]/.test(line)) {
        return line;
      }
      if (/^S1[:：]/.test(line)) {
        return line.replace(/^S1[:：]\s*/, "[S1]");
      }
      if (/^S2[:：]/.test(line)) {
        return line.replace(/^S2[:：]\s*/, "[S2]");
      }
      return `[S1]${line}`;
    });

  if (lines.length < 2 || !lines.some((line) => line.startsWith("[S1]")) || !lines.some((line) => line.startsWith("[S2]"))) {
    throw new Error("Generated script must contain both [S1] and [S2] turns.");
  }

  return lines.join("\n");
}
