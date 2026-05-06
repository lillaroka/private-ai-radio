# Private AI Radio

[中文文档](README.md)

AI-powered personal podcast generator. Turn your reading notes, URLs, and ideas into a two-host radio show with background music.

Give it a topic or paste an article, and Private AI Radio will:

1. **Research** — search the web for supplementary material (optional)
2. **Write** — generate a 7-10 minute two-host dialogue script
3. **Speak** — synthesize speech with dual voice cloning via SiliconFlow
4. **Mix** — blend in background music with automatic ducking

## Quick Start

### Prerequisites

- **Node.js** >= 20.6
- **ffmpeg** — required for audio encoding (`brew install ffmpeg` / `apt install ffmpeg` / `choco install ffmpeg`)

### Setup

```bash
# Clone the repository
git clone https://github.com/<your-username>/radio-craft.git
cd radio-craft

# Install dependencies
npm install

# Configure API keys
cp .env.example .env.local
# Edit .env.local with your API keys (at minimum, fill in the two required keys below)

# Start the app
npm run dev
```

Open `http://127.0.0.1:5173` in your browser.

### API Keys

| Service | Purpose | Required | Environment Variable |
|---------|---------|----------|---------------------|
| [DeepSeek](https://platform.deepseek.com/) | Script generation | Yes | `DEEPSEEK_API_KEY` |
| [SiliconFlow](https://cloud.siliconflow.cn/) | Text-to-speech (MOSS-TTSD) | Yes | `SILICONFLOW_API_KEY` |
| [OpenRouter](https://openrouter.ai/) | Web search (gracefully skipped if missing) | No | `OPENROUTER_API_KEY` |

## Architecture

```
radio-craft/
├── server.mjs              # Express server — API + static files
├── lib/
│   ├── llm.mjs             # LLM calls (DeepSeek for writing, OpenRouter for search)
│   ├── tts.mjs             # Voice configuration + SiliconFlow TTS
│   ├── audio-utils.mjs     # WAV parsing, mixing, normalization, BGM ducking
│   ├── episode-pipeline.mjs # Orchestrates the full generate → speak → mix pipeline
│   ├── episode-store.mjs   # Episode persistence + feedback
│   ├── memory.mjs          # User preference loading
│   └── load-local-env.mjs  # .env.local loader
├── src/                    # React frontend (Vite)
│   ├── pages/              # StudioPage (main) + EpisodePage (playback)
│   ├── components/         # VoiceSelectors, ScriptEditor, HistorySidebar
│   └── hooks/              # useSSE (Server-Sent Events)
├── memory/                 # User preference templates (edit these!)
├── scripts/                # CLI tools
└── music/                  # Background music (place your .mp3 here)
```

### Generation Pipeline

1. **Input** — User provides materials (text, URLs, topics) in the Studio
2. **Research** — OpenRouter web search finds supplementary sources (can be disabled)
3. **Script** — DeepSeek generates a multi-segment `[S1]`/`[S2]` dialogue script
4. **TTS** — SiliconFlow MOSS-TTSD synthesizes each segment with dual voice references
5. **Mix** — Audio is normalized, mixed with BGM (intro/outro + ducking), and combined

## Voice Customization

Private AI Radio ships with 4 built-in voice options:

- **Demo 1** / **Demo 2** — Included sample voice references
- **Anna** / **Diana** — Public preset voices from SiliconFlow

### Adding Your Own Voice

1. Record 15-30 seconds of clean, vocals-only audio (WAV, 44100 Hz)
2. Save it to `references/your_voice.wav`
3. Add an entry in `lib/tts.mjs`:

```js
const VOICE_OPTIONS = {
  myvoice: { label: "My Voice", audio: "local:references/your_voice.wav", text: "Exact transcript of what is spoken in the audio..." },
  // ...existing options
};
```

See [`references/README.md`](references/README.md) for detailed instructions.

### Environment Variable Override

You can also set custom voice references via environment variables without modifying code:

```env
MOSS_REFERENCE_S1_AUDIO=https://example.com/voice-s1.mp3
MOSS_REFERENCE_S1_TEXT=Reference transcript...
MOSS_REFERENCE_S2_AUDIO=https://example.com/voice-s2.mp3
MOSS_REFERENCE_S2_TEXT=Reference transcript...
```

## Memory System

What makes Private AI Radio generate episodes that feel like *yours* is the `memory/` directory. These files tell the AI who you are, what you care about, and what kind of conversation you want to hear. The AI reads them before generating every script.

| File | Purpose |
|------|---------|
| `memory/profile.md` | Who you are — your background and interests so the AI knows who it's talking to |
| `memory/taste.md` | What you like and can't stand — style, voice preferences, dealbreakers |
| `memory/host-bible.md` | Host personalities — S1 lays out the thread, S2 asks the follow-up questions |
| `memory/interests.json` | Interest tags — helps the search step find more relevant sources |

Customize these files with your own content, and the episodes will feel more like you.

After submitting episode feedback, the system automatically summarizes your preferences (every 5 entries) and appends them to `taste.md`.

## Background Music

Place `.mp3` files in `music/`. Private AI Radio will randomly pick one for each episode and apply:

- 8-second instrumental intro
- Automatic ducking when speech is active
- 10-second fade-out outro

## CLI Usage

```bash
# Generate an episode from the command line
npm run episode -- --input content/today.md

# Test TTS with different voice presets
node --env-file=.env.local scripts/siliconflow-tts.mjs --preset moss
```

## Development

```bash
# Type-check all backend modules and build frontend
npm run check

# Start dev server
npm run dev
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE)
