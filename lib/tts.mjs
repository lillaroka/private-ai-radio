import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const MOSS_MODEL = "fnlp/MOSS-TTSD-v0.5";
const MOSS_VOICE = "fnlp/MOSS-TTSD-v0.5:anna";
const MOSS_REFERENCE_TEXT = "他又躺在那里，眼睛闭着，仍然沉浸在梦境的气氛里。那是个庞杂而亮堂的梦";
export const SAMPLE_RATE = 44100;

const MOSS_DEFAULT_REFERENCES = [
  {
    label: "anna",
    audio: "https://sf-maas-uat-prod.oss-cn-shanghai.aliyuncs.com/voice_template/fish_audio-Anna.mp3",
    text: MOSS_REFERENCE_TEXT,
  },
  {
    label: "diana",
    audio: "https://sf-maas-uat-prod.oss-cn-shanghai.aliyuncs.com/voice_template/fish_audio-Diana.mp3",
    text: MOSS_REFERENCE_TEXT,
  },
];

const VOICE_OPTIONS = {
  demo1:  { label: "Demo 1", audio: "local:references/demo1_vocals.wav", text: "不知道你有没有发现逃亡其实就是逃生。当然，这种截然相反的矛盾冲突感不只是一场文字游戏，而是我们发现大逃杀、生存游戏、无限流、循环流这些概念本身就是最矛盾的存在。在这个概念的两端，一边是被压缩到极致单一的生存方式与空间，只有唯一甚者能够存活，另一端则是蔓延至无。" },
  demo2:  { label: "Demo 2", audio: "local:references/demo2_vocals.wav", text: "他对他说，道路径，他说要2元，对他说不要搬了，他说也仍然要2元。青皮固然是不足违法的，但他任性却大可以佩服，要求经济权也一样。有人说这事情太臣府了，就答到要经济权，说太卑鄙了，就达到要经济权，说是经济制度要改变了，用不着再操心，也仍然达到要。" },
  anna:   { label: "Anna",   audio: MOSS_DEFAULT_REFERENCES[0].audio, text: MOSS_REFERENCE_TEXT },
  diana:  { label: "Diana",  audio: MOSS_DEFAULT_REFERENCES[1].audio, text: MOSS_REFERENCE_TEXT },
};

export function getVoiceOptions() {
  return Object.entries(VOICE_OPTIONS).map(([id, { label }]) => ({ id, label }));
}

export function getMossVoiceLabel(voices) {
  if (voices?.s1 && voices?.s2) {
    return `references:${voices.s1}+${voices.s2}`;
  }
  if (process.env.MOSS_REFERENCE_S1_AUDIO && process.env.MOSS_REFERENCE_S2_AUDIO) {
    return "references:custom-s1+custom-s2";
  }
  return `references:${MOSS_DEFAULT_REFERENCES.map((item) => item.label).join("+")}`;
}

export { MOSS_MODEL };

async function resolveVoiceAudio(option) {
  if (option.audio.startsWith("local:")) {
    const relPath = option.audio.slice(6);
    const absPath = path.resolve(process.cwd(), relPath);
    const data = await readFile(absPath);
    const b64 = data.toString("base64");
    return `data:audio/wav;base64,${b64}`;
  }
  return option.audio;
}

async function getMossReferences(voices) {
  if (voices?.s1 && voices?.s2) {
    const s1Option = VOICE_OPTIONS[voices.s1];
    const s2Option = VOICE_OPTIONS[voices.s2];
    if (s1Option && s2Option) {
      const [s1Audio, s2Audio] = await Promise.all([
        resolveVoiceAudio(s1Option),
        resolveVoiceAudio(s2Option),
      ]);
      return [
        { audio: s1Audio, text: s1Option.text || MOSS_REFERENCE_TEXT },
        { audio: s2Audio, text: s2Option.text || MOSS_REFERENCE_TEXT },
      ];
    }
  }

  const envReferences = [
    {
      label: "s1",
      audio: process.env.MOSS_REFERENCE_S1_AUDIO,
      text: process.env.MOSS_REFERENCE_S1_TEXT || MOSS_REFERENCE_TEXT,
    },
    {
      label: "s2",
      audio: process.env.MOSS_REFERENCE_S2_AUDIO,
      text: process.env.MOSS_REFERENCE_S2_TEXT || MOSS_REFERENCE_TEXT,
    },
  ];

  const references = envReferences.every((item) => item.audio) ? envReferences : MOSS_DEFAULT_REFERENCES;
  return references.map(({ audio, text }) => ({ audio, text }));
}

export async function generateSpeechWithSiliconFlow(script, voices) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("Missing SILICONFLOW_API_KEY.");
  }

  const baseUrl = (process.env.SILICONFLOW_BASE_URL ?? DEFAULT_SILICONFLOW_BASE_URL).replace(/\/$/, "");
  const references = await getMossReferences(voices);
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MOSS_MODEL,
      input: script,
      ...(references.length === 2 ? { references } : { voice: MOSS_VOICE }),
      response_format: "wav",
      sample_rate: SAMPLE_RATE,
      speed: 0.9,
      gain: 0,
      max_tokens: 16384,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SiliconFlow speech generation failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await response.json();
    const url = json.url ?? json.audio_url ?? json.data?.url;
    if (!url) {
      throw new Error(`SiliconFlow returned JSON without audio URL:\n${JSON.stringify(json, null, 2)}`);
    }
    const audioResponse = await fetch(url);
    if (!audioResponse.ok) {
      const text = await audioResponse.text();
      throw new Error(`Audio download failed: ${audioResponse.status} ${audioResponse.statusText}\n${text}`);
    }
    return Buffer.from(await audioResponse.arrayBuffer());
  }

  return Buffer.from(await response.arrayBuffer());
}
