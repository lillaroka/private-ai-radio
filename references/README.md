# Voice References

This directory contains voice reference audio files used for TTS (Text-to-Speech) cloning.

## Included Demo Voices

- `demo1_vocals.wav` — Demo voice sample 1
- `demo2_vocals.wav` — Demo voice sample 2

These are included so the project works out of the box with the built-in demo voices.

## Adding Custom Voices

To use your own voice references:

1. Prepare a clean audio recording of the voice you want to clone (15-30 seconds, no background noise)
2. Place the `.wav` file in this directory
3. Edit `lib/tts.mjs` to add a new entry in `VOICE_OPTIONS`:

```js
myvoice: { label: "My Voice", audio: "local:references/my_voice.wav", text: "参考文本..." },
```

The `text` field should be a transcript of what's spoken in the audio file — this helps the TTS model align the voice characteristics.

## Tips for Good Reference Audio

- Use **vocals-only** audio (remove background music)
- 15-30 seconds of continuous speech works best
- Natural speaking pace, no pauses longer than 1 second
- Clear audio, avoid clipping or distortion
- WAV format, 44100 Hz sample rate recommended
