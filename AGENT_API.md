# Agent CLI API

Private AI Radio 支持通过命令行直接生成播客节目，供 AI agent（Claude Code、Codex 等）或自动化脚本调用，无需启动 Web 服务器。

生成的节目与 Web UI 共享 `episodes/` 目录，启动 Web 服务后可在页面历史列表中看到。

## 命令格式

```bash
npm run episode -- [options]
```

`--` 是必需的，用于将后续参数传递给底层脚本，而不是被 npm 自身消费。

## 输入参数（四选一，可组合）

| 参数 | 说明 | 示例 |
|------|------|------|
| `--topic <string>` | 话题模式，系统会联网搜索相关素材 | `--topic "人工智能最新进展"` |
| `--url <url>` | URL 文章，自动提取正文内容 | `--url https://example.com/article` |
| `--input <path>` | 本地 Markdown/文本文件路径 | `--input content/today.md` |
| `--text <string>` | 直接传入文本内容 | `--text "今天想聊一下..."` |

可以同时使用多个输入参数，它们会被合并为多段素材。

## 可选参数

| 参数 | 说明 |
|------|------|
| `--skip-search` | 跳过联网搜索环节 |
| `--mock` | 测试模式，不调用 LLM/TTS API，生成静音音频（用于验证流程） |
| `--voices s1=demo1,s2=demo2` | 指定双声线语音 ID（对应 `content/voices.json` 中的 key） |

不指定 `--voices` 时，默认使用 `content/voices.json` 中前两个配置。

## 输出格式

脚本成功后向 stdout 输出结构化信息：

```
=== Episode Generated ===
ID:     2025-05-08T14-30-00
Title:  私人电台：人工智能最新进展
MP3:    /path/to/radio-craft/episodes/2025-05-08T14-30-00/audio.mp3
WAV:    /path/to/radio-craft/episodes/2025-05-08T14-30-00/audio.wav
```

Agent 可从输出中提取 MP3 路径（匹配 `MP3:` 开头的行）。

进度信息以 `[episode]` 前缀输出到 stderr/stdout，不影响结果解析。

## 前置条件

1. **Node.js** >= 20.6
2. **ffmpeg** — 已安装并在 PATH 中（`brew install ffmpeg`）
3. **.env.local** — 配置至少以下 API key：
   - `DEEPSEEK_API_KEY` — 脚本生成（必需）
   - `SILICONFLOW_API_KEY` — 语音合成（必需）
   - `OPENROUTER_API_KEY` — 联网搜索（可选，缺失时自动跳过搜索）
4. **content/voices.json** — 语音配置文件（首次使用：`cp content/voices.example.json content/voices.json`）
5. **memory/** — 用户偏好目录（首次使用：`cp -r content/demo-memory memory`）

## 使用示例

### 话题模式

```bash
npm run episode -- --topic "人工智能最新进展" --skip-search
```

### URL 模式

```bash
npm run episode -- --url https://sspai.com/post/12345
```

### 文件输入

```bash
npm run episode -- --input content/today.md
```

### 直接文本

```bash
npm run episode -- --text "今天读了费曼的自传，有几个观点很有意思..."
```

### Mock 模式（快速测试）

```bash
npm run episode -- --topic "测试" --mock
```

### 指定语音

```bash
npm run episode -- --topic "科技新闻" --voices s1=demo1,s2=demo2
```

### 组合多种输入

```bash
npm run episode -- --topic "量子计算" --url https://example.com/quantum-article
```

## Agent 工作流示例

### 生成节目 + 发送到 Telegram

```bash
# 1. 生成节目
npm run episode -- --topic "今日科技要闻" --skip-search

# 2. 从输出提取 MP3 路径（agent 解析 stdout 中的 "MP3:" 行）

# 3. 发送到 Telegram
curl -F "chat_id=<CHAT_ID>" \
     -F "audio=@<MP3_PATH>" \
     https://api.telegram.org/bot<TOKEN>/sendAudio
```

### Claude Code 调用示例

```
> 请帮我生成一期关于"大模型推理能力"的播客
```

Claude Code 会执行：
```bash
npm run episode -- --topic "大模型推理能力"
```

然后从输出中解析出 MP3 路径，继续后续操作。

## 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 失败（错误信息输出到 stderr） |

## 与 Web UI 的关系

CLI 生成的节目存储在 `episodes/` 目录，与 Web UI 完全共享。启动 Web 服务（`npm run dev`）后，在页面历史列表中可以看到并播放 CLI 生成的节目。
