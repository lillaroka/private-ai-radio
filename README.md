# Radio Craft

[English](README.en.md)

AI 驱动的私人播客生成器。把你的阅读笔记、URL、话题想法，变成一段带背景音乐的双人电台节目。

给它一个话题或贴一篇文章，Radio Craft 会：

1. **搜索** — 联网搜索补充素材（可选）
2. **写稿** — 生成 7-10 分钟的双人对谈脚本
3. **合成** — 用 SiliconFlow 双声线语音克隆合成语音
4. **混音** — 自动混入背景音乐，带 ducking 和淡入淡出

## 快速开始

### 环境要求

- **Node.js** >= 20.6
- **ffmpeg** — 音频编码依赖（`brew install ffmpeg` / `apt install ffmpeg` / `choco install ffmpeg`）

### 安装

```bash
git clone https://github.com/<your-username>/radio-craft.git
cd radio-craft

npm install

# 配置 API 密钥
cp .env.example .env.local
# 编辑 .env.local，填入至少两个必填 key

npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。

### API 密钥

| 服务 | 用途 | 必填 | 环境变量 |
|------|------|------|----------|
| [DeepSeek](https://platform.deepseek.com/) | 脚本生成 | 是 | `DEEPSEEK_API_KEY` |
| [SiliconFlow](https://cloud.siliconflow.cn/) | 语音合成（MOSS-TTSD） | 是 | `SILICONFLOW_API_KEY` |
| [OpenRouter](https://openrouter.ai/) | 联网搜索（不填则跳过搜索） | 否 | `OPENROUTER_API_KEY` |

## 项目结构

```
radio-craft/
├── server.mjs              # Express 服务端 — API + 静态文件
├── lib/
│   ├── llm.mjs             # LLM 调用（DeepSeek 写稿，OpenRouter 搜索）
│   ├── tts.mjs             # 语音配置 + SiliconFlow TTS
│   ├── audio-utils.mjs     # WAV 解析、混音、响度归一化、BGM ducking
│   ├── episode-pipeline.mjs # 完整的 生成→合成→混音 流水线
│   ├── episode-store.mjs   # 节目持久化 + 反馈存储
│   ├── memory.mjs          # 用户偏好加载
│   └── load-local-env.mjs  # .env.local 加载器
├── src/                    # React 前端（Vite）
│   ├── pages/              # StudioPage（主页）+ EpisodePage（播放页）
│   ├── components/         # VoiceSelectors、ScriptEditor、HistorySidebar
│   └── hooks/              # useSSE（Server-Sent Events）
├── memory/                 # 用户偏好模板（编辑这些文件！）
├── scripts/                # CLI 工具
└── music/                  # 背景音乐（放 .mp3 文件进来）
```

### 生成流水线

1. **输入** — 在 Studio 页面添加素材（文本、URL、话题）
2. **搜索** — 通过 OpenRouter 联网搜索补充来源（可在界面关闭）
3. **脚本** — DeepSeek 生成多段落 `[S1]`/`[S2]` 对话脚本
4. **语音** — SiliconFlow MOSS-TTSD 用双声线参考音频合成各段落
5. **混音** — 音频响度归一化，混入 BGM（8 秒前奏 + ducking + 10 秒尾奏）

## 语音自定义

Radio Craft 内置 4 个语音选项：

- **Demo 1** / **Demo 2** — 附带的示例语音参考
- **Anna** / **Diana** — SiliconFlow 公开预设语音

### 用你自己的声音

1. 录制 15-30 秒干净的人声（WAV，44100 Hz，无背景音）
2. 保存到 `references/your_voice.wav`
3. 在 `lib/tts.mjs` 中添加条目：

```js
const VOICE_OPTIONS = {
  myvoice: { label: "我的声音", audio: "local:references/your_voice.wav", text: "音频中说的那段话的精确文字..." },
  // ...已有选项
};
```

详见 [`references/README.md`](references/README.md)。

### 环境变量覆盖

不修改代码，通过环境变量设置自定义语音参考：

```env
MOSS_REFERENCE_S1_AUDIO=https://example.com/voice-s1.mp3
MOSS_REFERENCE_S1_TEXT=参考文本...
MOSS_REFERENCE_S2_AUDIO=https://example.com/voice-s2.mp3
MOSS_REFERENCE_S2_TEXT=参考文本...
```

## Memory 系统

Radio Craft 之所以能生成"像你"的节目，靠的是 `memory/` 里的几份文件。它们告诉 AI 你是谁、你关心什么、你想要什么样的聊天氛围。生成每一集脚本时，AI 都会读一遍。

| 文件 | 作用 |
|------|------|
| `memory/profile.md` | 你是谁、你的背景和兴趣 — 让 AI 知道在跟谁聊天 |
| `memory/taste.md` | 你喜欢什么、受不了什么 — 节目风格、声音偏好、雷区 |
| `memory/host-bible.md` | 两个主持人的性格和分工 — S1 梳理主线，S2 追问和接话 |
| `memory/interests.json` | 兴趣标签 — 帮搜索环节找到更相关的素材 |

把这些文件改成你自己的内容，生成的节目就会越来越对味。

听完节目后可以提交反馈，系统攒够 5 条后会自动总结你的偏好，更新到 `taste.md` 里。

## 背景音乐

把 `.mp3` 文件放到 `music/` 目录。Radio Craft 会随机选一首，自动处理：

- 8 秒纯音乐前奏
- 说话时自动压低 BGM（ducking）
- 10 秒淡出尾奏

## CLI 使用

```bash
# 命令行生成一集节目
npm run episode -- --input content/today.md

# 测试不同语音预设的 TTS
node --env-file=.env.local scripts/siliconflow-tts.mjs --preset moss
```

## 开发

```bash
# 语法检查 + 构建前端
npm run check

# 启动开发服务器
npm run dev
```

## 贡献

欢迎提交 PR！

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feature/amazing-feature`）
3. 提交改动（`git commit -m 'Add amazing feature'`）
4. 推送到分支（`git push origin feature/amazing-feature`）
5. 发起 Pull Request

## 许可证

[MIT](LICENSE)
