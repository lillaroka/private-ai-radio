const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEFAULT_SEARCH_MODEL = "qwen/qwen3.6-plus";

function getDeepSeekConfig() {
  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_SCRIPT_MODEL || DEFAULT_DEEPSEEK_MODEL;
  return { baseUrl, apiKey, model };
}

function getSearchModel() {
  return process.env.OPENROUTER_SEARCH_MODEL || DEFAULT_SEARCH_MODEL;
}

export function getWriterModel() {
  return getDeepSeekConfig().model;
}

export function getSearchModels() {
  return [getSearchModel()];
}

export function parseJsonFromText(text) {
  const trimmed = String(text).trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // 1. Try parsing as-is
  try {
    return JSON.parse(withoutFence);
  } catch {}

  // 2. Try extracting a complete JSON object
  const match = withoutFence.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  // 3. Repair truncated JSON
  let partial = withoutFence.trimEnd();
  const opens = { "[": "]", "{": "}" };
  const stack = [];
  let inString = false;
  let escape = false;
  for (const ch of partial) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    if (ch === "}" || ch === "]") stack.pop();
  }

  // Close open string
  if (inString) {
    partial += '"';
  }

  // If we're inside an incomplete value, strip back to last valid delimiter
  if (inString || stack.length > 0) {
    const lastColon = partial.lastIndexOf('":');
    const lastComma = partial.lastIndexOf(",");
    const cutPoint = Math.max(lastColon > -1 ? lastColon + 1 : -1, lastComma > -1 ? lastComma + 1 : -1);
    if (cutPoint > 0) {
      const truncated = partial.slice(0, cutPoint);
      const stack2 = [];
      let inStr2 = false;
      let esc2 = false;
      for (const ch of truncated) {
        if (esc2) { esc2 = false; continue; }
        if (ch === "\\") { esc2 = true; continue; }
        if (ch === '"') { inStr2 = !inStr2; continue; }
        if (inStr2) continue;
        if (ch === "{" || ch === "[") stack2.push(ch);
        if (ch === "}" || ch === "]") stack2.pop();
      }
      if (inStr2) {
        let repaired = truncated + '"';
        const afterKey = truncated.match(/"([^"]*)"s*:\s*"$/);
        if (afterKey) {
          repaired = truncated.slice(0, -1) + '""';
        }
        while (stack2.length) repaired += opens[stack2.pop()];
        try {
          return JSON.parse(repaired);
        } catch {}
      }
      let repaired = truncated;
      while (stack2.length) repaired += opens[stack2.pop()];
      try {
        return JSON.parse(repaired);
      } catch {}
    }
  }

  // Simple bracket closing as last resort
  let repaired = partial;
  if (inString) repaired += '"';
  const finalStack = [];
  let fStr = false;
  let fEsc = false;
  for (const ch of repaired) {
    if (fEsc) { fEsc = false; continue; }
    if (ch === "\\") { fEsc = true; continue; }
    if (ch === '"') { fStr = !fStr; continue; }
    if (fStr) continue;
    if (ch === "{" || ch === "[") finalStack.push(ch);
    if (ch === "}" || ch === "]") finalStack.pop();
  }
  while (finalStack.length) repaired += opens[finalStack.pop()];
  try {
    return JSON.parse(repaired);
  } catch {
    throw new Error(`Model did not return valid JSON:\n${text.slice(0, 500)}`);
  }
}

export function isRetryableModelError(error) {
  return /not available|model.*not|region|403|404/i.test(error.message);
}

// --- DeepSeek calls ---

async function callDeepSeek({ messages, temperature = 1.0, maxTokens = 16384 }) {
  const { baseUrl, apiKey, model } = getDeepSeekConfig();
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY.");
  }

  console.log(`[pipeline] Calling DeepSeek ${model}...`);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const data = await response.json();
  return { data, model, usage: data.usage ?? null };
}

// --- OpenRouter search (kept for web search only) ---

async function callOpenRouterSearch({ messages, tools }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[pipeline] OPENROUTER_API_KEY not set, skipping search.");
    return null;
  }

  const model = getSearchModel();
  console.log(`[pipeline] Research: calling ${model} via OpenRouter...`);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(process.env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER } : {}),
      ...(process.env.OPENROUTER_APP_TITLE ? { "X-Title": process.env.OPENROUTER_APP_TITLE } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Research request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return { data: await response.json(), model };
}

// --- Public API ---

export async function summarizeFeedbackWithDeepSeek({ feedbackEntries, currentTaste }) {
  const { apiKey } = getDeepSeekConfig();
  if (!apiKey) return null;

  const feedbackLines = feedbackEntries.map((f, i) => {
    const parts = [`#${i + 1} ${f.createdAt}: 选题${f.topic}/10 节奏${f.rhythm}/10 声音${f.voice}/10`];
    if (f.liked) parts.push(`  喜欢：${f.liked}`);
    if (f.disliked) parts.push(`  不喜欢：${f.disliked}`);
    if (f.next) parts.push(`  建议：${f.next}`);
    return parts.join("\n");
  });

  const messages = [
    {
      role: "system",
      content: "你是一个播客偏好分析师。根据用户反馈数据，总结用户的品味偏好。只输出偏好描述，不超过 200 字。",
    },
    {
      role: "user",
      content: [
        "根据以下用户反馈，总结用户的播客品味偏好。",
        "",
        "用户反馈记录：",
        ...feedbackLines,
        "",
        currentTaste ? `当前已知偏好：\n${currentTaste}` : "",
        "",
        "请输出一段精简的偏好描述，涵盖：偏好的节目风格和节奏、声音特质、反感的元素、其他值得注意的偏好。只输出偏好描述。",
      ].filter(Boolean).join("\n"),
    },
  ];

  try {
    const { data } = await callDeepSeek({ messages, temperature: 0.3, maxTokens: 512 });
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (summary) {
      console.log("[pipeline] Taste summary updated.");
      return summary;
    }
  } catch (error) {
    console.error("[pipeline] Feedback summarization failed:", error.message);
  }
  return null;
}

// Backward-compatible alias
export const summarizeFeedbackWithOpenRouter = summarizeFeedbackWithDeepSeek;

export async function generateEpisode({ input, memory, interests, onProgress, skipSearch }) {
  let researchResult;

  if (skipSearch) {
    console.log("[pipeline] Skipping research (user disabled search)");
    researchResult = { search_queries: [], sources: [], notes: "", model: "none", usage: null };
  } else {
    console.log("[pipeline] Step 1: Researching supplementary material...");
    onProgress?.("researching", { model: getSearchModel() });
    researchResult = await researchWithOpenRouter({ input, memory, interests });
    onProgress?.("researched", { queries: researchResult.search_queries, sources: researchResult.sources?.length ?? 0 });
    console.log(`[pipeline] Research done | model=${researchResult.model} | queries=${JSON.stringify(researchResult.search_queries)} | sources=${researchResult.sources?.length ?? 0}`);
  }

  console.log("[pipeline] Step 2: Generating script with DeepSeek...");
  const { model: writerModel } = getDeepSeekConfig();
  onProgress?.("writing", { model: writerModel });
  const scriptResult = await generateScriptWithDeepSeek({ input, memory, interests, researchResult });
  onProgress?.("written", { title: scriptResult.title, segments: scriptResult.segments?.length ?? 0 });
  console.log(`[pipeline] Script done | model=${scriptResult.writerModel} | title=${scriptResult.title} | segments=${scriptResult.segments?.length ?? 0}`);

  return {
    ...scriptResult,
    search_queries: researchResult.search_queries,
    sources: researchResult.sources,
    searchModel: researchResult.model,
    usage: {
      search: researchResult.usage,
      writer: scriptResult.usage,
    },
  };
}

// Backward-compatible alias
export const generateEpisodeWithOpenRouter = generateEpisode;

// --- Research (OpenRouter, web search only) ---

async function researchWithOpenRouter({ input, memory, interests }) {
  const today = new Date().toISOString().slice(0, 10);
  const interestLines = (interests?.interests ?? []).length > 0
    ? [
        "用户兴趣标签（如果与今日输入相关，用这些方向构造搜索查询；不相关则忽略）：",
        (interests.interests)
          .map((i) => `- "${i.label}"（可用搜索方向：${i.queries.join("、")}）`)
          .join("\n"),
      ]
    : [];

  const messages = [
    {
      role: "system",
      content: [
        "你是一个研究助手。你的任务是分析用户输入，识别信息缺口，然后联网搜索补充素材。",
        "输出必须是 JSON，不要 markdown fence。",
        "",
        "搜索策略：",
        "搜索的目的是补充用户输入中缺失的事实、数据或不同视角，而不是重复已知信息。",
        "构造 search_queries 时遵循以下原则：",
        "1. 先思考：用户输入里哪些观点缺乏证据？哪些概念有争议？哪些数据可以让讨论更有说服力？",
        "2. 查询必须具体、有针对性。禁止宽泛查询如「AI 最新进展」「科技新闻」。",
        "3. 好的查询示例：「mixture of experts inference latency benchmark 2025」「RLHF vs DPO alignment comparison」",
        "4. 如果用户输入已经足够完整、不需要外部补充，search_queries 可以为空数组。宁缺毋滥。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "请分析以下输入，识别信息缺口，搜索补充素材。",
        "",
        `今天是 ${today}。搜索时优先查最新的信息。`,
        "JSON schema:",
        "{",
        '  "search_queries": ["2-3 个精准英文查询。如果输入已足够完整，写空数组 []"],',
        '  "sources": [{"title":"来源标题","url":"https://...","note":"一句话摘要，为什么相关"}],',
        '  "notes": "研究说明：找到了什么，对节目有什么补充价值"',
        "}",
        "",
        ...interestLines,
        "",
        "今日输入：",
        input,
        "",
        "用户 profile：",
        memory.profile,
      ].join("\n"),
    },
  ];

  try {
    const result = await callOpenRouterSearch({
      messages,
      tools: [
        {
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            max_results: 5,
            max_total_results: 5,
            search_context_size: "medium",
            user_location: {
              type: "approximate",
              country: process.env.SEARCH_COUNTRY || "CN",
              timezone: "Asia/Shanghai",
            },
          },
        },
      ],
    });

    if (!result) {
      return { search_queries: [], sources: [], notes: "Search skipped (no API key).", model: "none", usage: null };
    }

    const { data, model } = result;
    const message = data.choices?.[0]?.message ?? {};
    const parsed = parseJsonFromText(message.content ?? "");
    parsed.usage = data.usage ?? null;
    parsed.model = model;

    if ((!parsed.sources || parsed.sources.length === 0) && Array.isArray(message.annotations)) {
      parsed.sources = message.annotations
        .filter((item) => item.type === "url_citation")
        .map((item) => ({
          title: item.url_citation?.title ?? item.url_citation?.url ?? "Web source",
          url: item.url_citation?.url ?? "",
          note: item.url_citation?.content ?? "",
        }))
        .filter((item) => item.url)
        .slice(0, 5);
    }

    return parsed;
  } catch (error) {
    console.warn(`Research failed, proceeding without: ${error.message}`);
    return { search_queries: [], sources: [], notes: "Search unavailable.", model: "none", usage: null };
  }
}

// --- Script generation (DeepSeek) ---

async function generateScriptWithDeepSeek({ input, memory, interests, researchResult }) {
  const today = new Date().toISOString().slice(0, 10);
  const researchContext = (researchResult.sources?.length > 0 || researchResult.notes)
    ? [
        "",
        "## 已搜集的补充素材（请自然融入脚本，不要逐条念）：",
        researchResult.notes ? `研究说明：${researchResult.notes}` : "",
        ...(researchResult.sources ?? []).map(
          (source, i) => `${i + 1}. [${source.title}](${source.url}) — ${source.note ?? ""}`,
        ),
      ].join("\n")
    : "";

  const interestLines = (interests?.interests ?? []).length > 0
    ? [
        "用户兴趣标签（结合素材和输入，在相关话题上深入讨论）：",
        (interests.interests)
          .map((i) => `- "${i.label}"（搜索方向：${i.queries.join("、")}）`)
          .join("\n"),
      ]
    : [];

  const messages = [
    {
      role: "system",
      content: [
        "你是私人双人电台的总编剧和策展人。你要作为编剧，先理解这段素材值得挖掘的地方，再决定这一集的S1和S2分别承载什么情感逻辑或认知位置。",
        "目标：生成一集 7-10 分钟中文私人双人电台节目，拆成 2-3 个段落。",
        "硬性要求：脚本有效对话内容必须在 2000 字以上。这是最低要求，宁多勿少。不要压缩内容来节省字数。",
        "输出必须是 JSON，不要 markdown fence。",
        "节目脚本必须只使用 [S1] 和 [S2] 行，适合 MOSS-TTSD spoken dialogue 一次性生成。",
        "两人是熟悉的朋友，聊天自然随意，不需要每集重新定义关系或设定人设。",
        "两人的性别、气质不做硬性规定，避免所有性别刻板印象的语音习惯标注。",
        "节目像两个人真实自然接话，不像资讯摘要、播音稿、广告或客服。",
        "补充素材要自然融入对话，不能像在念新闻稿或文献综述。",
        "对话要有气口和节奏变化，不要一句接一句像在赶进度。",
        "两个声部都聪明、敏锐、有成年人的质感，允许轻微摩擦和不同判断。",
        "每个段落的每一行都必须由 [S1] 先开口。[S2] 永远不要作为段落的第一行。这是硬性规则。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "请根据以下输入、记忆和补充素材生成节目。",
        "",
        `今天是 ${today}。`,
        "JSON schema:",
        "{",
        '  "title": "短标题",',
        '  "summary": "一句话摘要",',
        '  "notes": "策划说明，简短",',
        '  "segments": [',
        '    { "title": "段落标题", "script": "[S1]...\\n[S2]...\\n..." },',
        '    { "title": "段落标题", "script": "[S1]...\\n[S2]...\\n..." }',
        "  ]",
        "}",
        "",
        "脚本要求：",
        "- 有效对话内容总计必须超过 2000 个中文字（约 3 段 × 每段 700-900 字）。如果不够，在每个段落里多展开一些讨论、追问、补充例子。宁长勿短。",
        "- 目标音频时长 7-10 分钟。",
        "- 拆成 2-3 个段落，每段 600-900 字 / 10-15 个 turn。",
        "- 段落之间有自然过渡（开场 → 展开 → 收束）。",
        "- 第一个段落必须以轻松的打招呼开场，S1简短介绍今天的主题，S2自然接话，像朋友聊天一样进入话题。",
        "- 最后一个段落自然收尾。在聊完内容后，用一句轻松的话结束节目，比如「那么今天的节目就到这里啦，感谢收听」「今天聊得挺开心的，下次见」之类的风格，不要生硬也不要过于正式。",
        "- 两人的性别、气质不做硬性规定。不需要为角色编造背景设定或人物关系，直接进入对话就好。避免所有性别刻板印象的语音习惯标注。",
        "- 每段必须由 [S1] 先说话。[S2] 绝不能作为段落开头。",
        "- 两个声部都聪明、敏锐、有成年人的质感，允许轻微摩擦和不同判断。",
        "- 节奏要有呼吸感。不要每句都是密集输出——有些话可以短到只有「嗯……」「对……」「等一下，你是说……」，可以有真实迟疑，可以有思考的间隙。但注意不要形成口癖",
        "- 对方说完一段比较长的话之后，接话方不要立刻开始长篇回复，先用短句反应一下再展开。",
        "- 不要写舞台说明、括号表演说明、音效、旁白或主持人名字。",
        "- 禁止使用 AI 典型句式：不要用「不是……而是……」「值得注意的是」「一方面……另一方面」「毫无疑问」这类模板化表达。不要用整齐的排比递进连用。如果发现自己在写工整的三段递进，立刻打断，换成口语化的说法。",
        "- 如果有补充素材，自然融入对话中，不要逐条引用或念来源列表。",
        ...interestLines,
        "",
        "今日输入：",
        input,
        researchContext,
        "",
        "长期 profile：",
        memory.profile,
        "",
        "节目品味：",
        memory.taste,
        "",
        "主持人设：",
        memory.hostBible,
      ].join("\n"),
    },
  ];

  const { data, model, usage } = await callDeepSeek({ messages, temperature: 1.0, maxTokens: 16384 });
  const parsed = parseJsonFromText(data.choices?.[0]?.message?.content ?? "");
  parsed.writerModel = model;
  parsed.usage = usage;
  return parsed;
}
