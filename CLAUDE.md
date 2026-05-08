# CLAUDE.md

Private AI Radio — AI 驱动的私人播客生成器。

## 生成播客

用户要求生成播客时，按以下流程操作：

1. 用搜索工具收集相关素材
2. 将搜索结果保存到临时文件（如 `/tmp/radio-search.md`）
3. 执行生成命令：

```bash
npm run episode -- --topic "<话题>" --search-results /tmp/radio-search.md
```

详细参数和用法见 [`AGENT_API.md`](AGENT_API.md)。

### 常用参数

- `--topic` — 话题（必传）
- `--search-results <path>` — 预搜索素材文件（agent 模式必传）
- `--url <url>` — 附加 URL 文章
- `--text <text>` — 附加文本
- `--skip-search` — 跳过搜索
- `--mock` — 测试模式（不调 API）
- `--voices s1=x,s2=y` — 指定语音

### 输出

成功后输出 episode ID、标题和 MP3 路径，从 `MP3:` 行提取文件路径即可用于后续操作（发送到 Telegram 等）。

## 项目结构

- `server.mjs` — Express Web 服务
- `lib/` — 核心 pipeline（不要修改）
- `scripts/generate-episode.mjs` — CLI 入口
- `AGENT_API.md` — 完整 API 文档
