#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/load-local-env.mjs";
import { generateScript, generateAudio, fetchAndExtractArticle } from "../lib/episode-pipeline.mjs";
import { getVoiceOptions } from "../lib/tts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
loadLocalEnv(projectRoot);

const args = parseArgs(process.argv.slice(2));

try {
  const inputText = await resolveInput(args);

  if (!inputText?.trim()) {
    console.error("Error: No input provided. Use one of: --topic, --url, --input, --text, --search-results");
    process.exit(1);
  }

  const voices = await resolveVoices(args.voices);

  const cwd = projectRoot;
  const mock = Boolean(args.mock);
  const skipSearch = Boolean(args.skipSearch) || Boolean(args["search-results"]);

  console.log("[episode] Generating script...");

  const scripted = await generateScript({
    inputText,
    cwd,
    mock,
    skipSearch,
    onProgress(stage, detail) {
      if (stage === "searching") {
        console.log(`[episode] Searching... ${detail.query ?? ""}`);
      } else if (stage === "writing") {
        console.log(`[episode] Writing script...`);
      } else {
        console.log(`[episode] ${stage}`, Object.keys(detail).length ? JSON.stringify(detail) : "");
      }
    },
  });

  console.log(`[episode] Script done: ${scripted.title}`);
  console.log(`[episode] Generating audio...`);

  const episode = await generateAudio({
    episodeId: scripted.id,
    voices,
    cwd,
    mock,
    onProgress(stage, detail) {
      if (stage === "generating_audio") {
        console.log(`[episode] Audio segment ${detail.segment}/${detail.total}`);
      } else if (stage === "combining") {
        console.log("[episode] Combining segments...");
      } else {
        console.log(`[episode] ${stage}`, Object.keys(detail).length ? JSON.stringify(detail) : "");
      }
    },
  });

  const mp3Path = path.join(episode.dir, "audio.mp3");
  console.log("");
  console.log("=== Episode Generated ===");
  console.log(`ID:     ${episode.id}`);
  console.log(`Title:  ${episode.manifest.title}`);
  console.log(`MP3:    ${mp3Path}`);
  console.log(`WAV:    ${episode.audioPath}`);
} catch (error) {
  console.error(`Error: ${error?.message ?? error}`);
  if (error?.stack) console.error(error.stack);
  process.exit(1);
}

// --- Input resolution ---

async function resolveInput(args) {
  const sources = [];
  if (args.topic) sources.push({ type: "topic", content: args.topic });
  if (args.url) sources.push({ type: "url", content: args.url });
  if (args.input) {
    const filePath = path.resolve(args.input);
    const content = await readFile(filePath, "utf8");
    sources.push({ type: "text", content });
  }
  if (args.text) sources.push({ type: "text", content: args.text });
  if (args["search-results"]) {
    const filePath = path.resolve(args["search-results"]);
    const content = await readFile(filePath, "utf8");
    sources.push({ type: "search", content });
  }

  if (sources.length === 0) return null;

  const parts = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const typeLabels = { text: "文本笔记", url: "URL 文章", topic: "话题", search: "搜索结果" };
    const label = typeLabels[s.type] ?? "素材";
    if (s.type === "url") {
      let content = s.content;
      try {
        console.log(`[episode] Fetching URL: ${s.content}`);
        content = await fetchAndExtractArticle(s.content);
      } catch {
        console.warn(`[episode] Warning: Failed to fetch URL, using raw URL as content.`);
      }
      parts.push(`=== 素材 ${i + 1}（${label}）===\n${content}`);
    } else if (s.type === "topic") {
      parts.push(`=== 素材 ${i + 1}（话题：${s.content}）===\n[话题，请搜索相关素材]`);
    } else if (s.type === "search") {
      parts.push(`=== 搜索结果 ===\n${s.content}`);
    } else {
      parts.push(`=== 素材 ${i + 1}（${label}）===\n${s.content}`);
    }
  }
  return parts.join("\n\n");
}

// --- Voice resolution ---

async function resolveVoices(voicesArg) {
  if (!voicesArg) {
    // Use the first two entries from voices.json
    const options = await getVoiceOptions();
    if (options.length >= 2) {
      return { s1: options[0].id, s2: options[1].id };
    }
    return undefined;
  }

  const pairs = voicesArg.split(",").map((pair) => pair.trim());
  const result = {};
  for (const pair of pairs) {
    const [key, value] = pair.split("=").map((s) => s.trim());
    if (key && value) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// --- Argument parser ---

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}
