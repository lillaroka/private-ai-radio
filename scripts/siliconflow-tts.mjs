#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseWav, wavFromPcm, combineWavs, makeSilence } from "../lib/audio-utils.mjs";

const DEFAULT_MODEL = "FunAudioLLM/CosyVoice2-0.5B";
const DEFAULT_MOSS_MODEL = "fnlp/MOSS-TTSD-v0.5";
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_SAMPLE_RATE = 44100;

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.SILICONFLOW_API_KEY;
const baseUrl = (args.baseUrl ?? process.env.SILICONFLOW_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const preset = args.preset ?? "mixed";
const model = args.model ?? (preset === "moss" ? DEFAULT_MOSS_MODEL : DEFAULT_MODEL);
const presetConfig = getPresetConfig(preset, model);
const outDir = args.outDir ?? "samples/tts";
const sampleRate = Number(args.sampleRate ?? DEFAULT_SAMPLE_RATE);
const responseFormat = args.responseFormat ?? "wav";
const silenceMs = Number(args.silenceMs ?? presetConfig.silenceMs);
const speed = Number(args.speed ?? presetConfig.speed);
const gain = Number(args.gain ?? 0);

const voices = {
  A: args.voiceA ?? presetConfig.voices.A,
  B: args.voiceB ?? presetConfig.voices.B,
};

const instructions = {
  A: args.instructionsA ?? presetConfig.instructions.A,
  B: args.instructionsB ?? presetConfig.instructions.B,
};

const turns = presetConfig.turns;

if (!apiKey) {
  console.error("Missing SILICONFLOW_API_KEY.");
  console.error("Run: node --env-file=.env.local scripts/siliconflow-tts.mjs");
  process.exit(1);
}

if (args.diagnose) {
  await diagnoseSiliconFlow(apiKey);
  process.exit(0);
}

if (responseFormat !== "wav") {
  console.error("This script currently combines only WAV output. Use --responseFormat wav.");
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(outDir, `siliconflow-${timestamp}`);
await mkdir(runDir, { recursive: true });

const wavs = [];

if (presetConfig.mode === "dialogue") {
  const wav = await createSpeech({
    apiKey,
    model,
    input: formatDialogueInput(presetConfig.turns),
    voice: args.voice ?? presetConfig.voice,
    instructions: "",
    responseFormat,
    sampleRate,
    speed,
    gain,
    maxTokens: Number(args.maxTokens ?? 4096),
  });

  const outPath = path.join(runDir, `dialogue-${safeName(model)}-${safeName(args.voice ?? presetConfig.voice)}.wav`);
  await writeFile(outPath, wav);
  await writeManifest({
    runDir,
    output: outPath,
    extra: {
      mode: presetConfig.mode,
      voice: args.voice ?? presetConfig.voice,
    },
  });

  console.log(`Generated: ${outPath}`);
  process.exit(0);
}

for (const [index, turn] of turns.entries()) {
  const wav = await createSpeech({
    apiKey,
    model,
    input: formatInputForModel(model, turn),
    voice: voices[turn.speaker],
    instructions: instructions[turn.speaker],
    responseFormat,
    sampleRate,
    speed: turn.speed ?? speed,
    gain,
  });

  const fileName = `${String(index + 1).padStart(2, "0")}-${turn.speaker}.wav`;
  await writeFile(path.join(runDir, fileName), wav);
  wavs.push(wav);
}

function formatInputForModel(model, turn) {
  if (model.includes("CosyVoice")) {
    return `${turn.emotion}<|endofprompt|>${turn.text}`;
  }

  return turn.text;
}

const combined = combineWavs(wavs, silenceMs);
const outPath = path.join(runDir, `dialogue-${safeName(model)}.wav`);
await writeFile(outPath, combined);

await writeManifest({ runDir, output: outPath });

console.log(`Generated: ${outPath}`);

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

function getPresetConfig(preset, model) {
  const voice = (name) => `${model}:${name}`;
  const commonA =
    "中文私人播客对谈。像一个聪明、放松、在认真听的人。不要播音腔，不要广告配音，不要逐字正音。允许自然连读、轻重音变化、短暂停顿和真实情绪。";
  const commonB =
    "中文私人播客对谈。像一个成年、松弛、聪明的朋友实时接话。声音不要幼态、不要甜美卖萌、不要新闻主播腔、客服腔或短视频配音感。要有口语节奏、情绪转折和自然连读。";

  const presets = {
    mixed: {
      speed: 1.08,
      silenceMs: 100,
      voices: {
        A: voice("alex"),
        B: voice("diana"),
      },
      instructions: {
        A: commonA,
        B: commonB,
      },
      turns: [
        {
          speaker: "A",
          speed: 1.04,
          emotion: "用低一点、放松、有一点试探感的语气说。",
          text: "那我们这次换一男一女。先别追求完美，先听听它像不像真的有人在说话。",
        },
        {
          speaker: "B",
          speed: 1.12,
          emotion: "用成年、放松、自然、不甜腻的语气说。",
          text: "对，而且我不想再听那种标准主持人了。太主流，太安全，反而不亲近。",
        },
        {
          speaker: "A",
          speed: 1.06,
          emotion: "用认真思考、稍微压低一点的语气说。",
          text: "私人播客的声音，应该有一点生活痕迹。比如停一下，想一下，再接着说。",
        },
        {
          speaker: "B",
          speed: 1.14,
          emotion: "用有反应、有情绪、但克制、不幼态的语气说。",
          text: "嗯，我同意。哪怕没那么完美，也别像模板。模板感一出来，人就想关掉。",
        },
      ],
    },
    male: {
      speed: 1.18,
      silenceMs: 120,
      voices: {
        A: voice("benjamin"),
        B: voice("alex"),
      },
      instructions: {
        A: commonA,
        B: commonB,
      },
      turns: [
        {
          speaker: "A",
          emotion: "用自然、认真、带一点点无奈的语气说。",
          text: "我觉得我们刚才已经确认一件事：标准 AI 声音，真的不适合做私人电台。",
        },
        {
          speaker: "B",
          emotion: "用口语、轻快、稍微吐槽但不夸张的语气说。",
          text: "嗯，尤其是那种太端正的声音。它没有错，但就是，很难让人想连续听七天。",
        },
        {
          speaker: "A",
          emotion: "用放松、思考中的语气说，语速自然，有轻重音。",
          text: "所以这版我们换一个方向：不追求播音质感，先追求像人在聊天。",
        },
        {
          speaker: "B",
          emotion: "用有反应、有一点着急、但温和的语气说。",
          text: "对，哪怕有一点点不完美也行。重点是别吓人，要有情绪，要能接住注意力。",
        },
      ],
    },
    moss: {
      mode: "dialogue",
      speed: 1,
      silenceMs: 0,
      voice: voice("anna"),
      voices: {
        A: voice("anna"),
        B: voice("anna"),
      },
      instructions: {
        A: "",
        B: "",
      },
      turns: [
        {
          speaker: "S1",
          text: "我们换一个声音方向吧。我觉得前面那几组都太像平台默认主持人了。",
        },
        {
          speaker: "S2",
          text: "嗯，我懂。就是技术上已经挺自然了，但一听就知道它在努力显得自然。",
        },
        {
          speaker: "S1",
          text: "对，私人播客的声音不应该那么满。它要有一点松弛，一点犹豫，还要有一点人自己的气味。",
        },
        {
          speaker: "S2",
          text: "所以这版我们先试试对谈模型。别急着好听，先看它像不像两个人真的在接话。",
        },
      ],
    },
  };

  const config = presets[preset];
  if (!config) {
    console.error(`Unknown preset "${preset}". Use one of: ${Object.keys(presets).join(", ")}`);
    process.exit(1);
  }

  return config;
}

function formatDialogueInput(turns) {
  return turns.map((turn) => `[${turn.speaker}]${turn.text}`).join("\n");
}

async function writeManifest({ runDir, output, extra = {} }) {
  await writeFile(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        provider: "siliconflow",
        baseUrl,
        model,
        preset,
        voices,
        sampleRate,
        responseFormat,
        speed,
        gain,
        silenceMs,
        turns,
        output,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

async function diagnoseSiliconFlow(apiKey) {
  for (const endpoint of ["https://api.siliconflow.cn/v1/models", "https://api.siliconflow.com/v1/models"]) {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const text = await response.text();
    const message = text.slice(0, 120).replace(/\s+/g, " ");
    console.log(`${endpoint.replace("https://api.", "api.")} -> ${response.status} ${response.statusText} ${message}`);
  }
}

async function createSpeech({
  apiKey,
  model,
  input,
  voice,
  instructions,
  responseFormat,
  sampleRate,
  speed,
  gain,
  maxTokens,
}) {
  const body = {
    model,
    input,
    voice,
    response_format: responseFormat,
    sample_rate: sampleRate,
    speed,
    gain,
    instructions,
  };

  if (maxTokens) {
    body.max_tokens = maxTokens;
  }

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SiliconFlow TTS failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await response.json();
    const url = json.url ?? json.audio_url ?? json.data?.url;
    if (!url) {
      throw new Error(`SiliconFlow returned JSON without an audio URL:\n${JSON.stringify(json, null, 2)}`);
    }

    const audioResponse = await fetch(url);
    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      throw new Error(`Failed to download generated audio: ${audioResponse.status} ${audioResponse.statusText}\n${errorText}`);
    }

    return Buffer.from(await audioResponse.arrayBuffer());
  }

  return Buffer.from(await response.arrayBuffer());
}

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "");
}
