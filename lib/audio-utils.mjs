export function parseWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected RIFF/WAVE audio.");
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    }

    if (chunkId === "data") {
      data = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt || !data) {
    throw new Error("WAV file is missing fmt or data chunk.");
  }

  return { ...fmt, data };
}

export function wavFromPcm({ pcm, audioFormat, channels, sampleRate, bitsPerSample }) {
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function combineWavs(wavs, silenceMs) {
  const parsed = wavs.map(parseWav);
  const first = parsed[0];

  for (const current of parsed.slice(1)) {
    if (
      current.audioFormat !== first.audioFormat ||
      current.channels !== first.channels ||
      current.sampleRate !== first.sampleRate ||
      current.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error("Cannot combine WAV files with different audio formats.");
    }
  }

  const silence = makeSilence({
    durationMs: silenceMs,
    sampleRate: first.sampleRate,
    channels: first.channels,
    bitsPerSample: first.bitsPerSample,
  });

  const parts = [];
  parsed.forEach((current, index) => {
    parts.push(current.data);
    if (index < parsed.length - 1) {
      parts.push(silence);
    }
  });

  return wavFromPcm({
    pcm: Buffer.concat(parts),
    audioFormat: first.audioFormat,
    channels: first.channels,
    sampleRate: first.sampleRate,
    bitsPerSample: first.bitsPerSample,
  });
}

export function makeSilence({ durationMs, sampleRate, channels, bitsPerSample }) {
  const bytesPerSample = bitsPerSample / 8;
  const samples = Math.round((sampleRate * durationMs) / 1000);
  return Buffer.alloc(samples * channels * bytesPerSample);
}

export function createSilentWav({ seconds, sampleRate }) {
  const channels = 1;
  const bitsPerSample = 16;
  const pcm = Buffer.alloc(Math.round(seconds * sampleRate) * channels * (bitsPerSample / 8));
  return wavFromPcm({ pcm, audioFormat: 1, channels, sampleRate, bitsPerSample });
}

export function applyFadeOut(buffer, durationMs = 100) {
  const parsed = parseWav(buffer);
  const { data, audioFormat, channels, sampleRate, bitsPerSample } = parsed;
  if (bitsPerSample !== 2) return buffer;

  const totalSamples = data.length / 2;
  const fadeSamples = Math.round((durationMs / 1000) * sampleRate);
  const result = Buffer.from(data);

  for (let i = 0; i < Math.min(fadeSamples, totalSamples); i++) {
    const gain = 1 - i / fadeSamples;
    const idx = totalSamples - 1 - i;
    const val = Math.round(data.readInt16LE(idx * 2) * gain);
    result.writeInt16LE(Math.max(-32768, Math.min(32767, val)), idx * 2);
  }

  return wavFromPcm({ pcm: result, audioFormat, channels, sampleRate, bitsPerSample });
}

// Simple linear fade-in — no speech detection, just ramp from 0 to 1.
export function linearFadeIn(buffer, durationMs) {
  const parsed = parseWav(buffer);
  const { data, audioFormat, channels, sampleRate, bitsPerSample } = parsed;
  if (bitsPerSample !== 2) return buffer;

  const totalSamples = data.length / 2;
  const fadeSamples = Math.round((durationMs / 1000) * sampleRate);
  const result = Buffer.from(data);

  for (let i = 0; i < Math.min(fadeSamples, totalSamples); i++) {
    const gain = i / fadeSamples;
    const val = Math.round(data.readInt16LE(i * 2) * gain);
    result.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
  }

  return wavFromPcm({ pcm: result, audioFormat, channels, sampleRate, bitsPerSample });
}

export function fixWavHeader(buffer) {
  const parsed = parseWav(buffer);
  return wavFromPcm({
    pcm: parsed.data,
    audioFormat: parsed.audioFormat,
    channels: parsed.channels,
    sampleRate: parsed.sampleRate,
    bitsPerSample: parsed.bitsPerSample,
  });
}

export function normalizeVolume(buffer, targetDb = -14) {
  const parsed = parseWav(buffer);
  const { data, audioFormat, channels, sampleRate, bitsPerSample } = parsed;
  const bytesPerSample = bitsPerSample / 8;

  if (bytesPerSample !== 2) {
    return buffer;
  }

  const samples = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
  const floatSamples = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    floatSamples[i] = samples[i] / 32768;
  }

  // Step 1: Lookahead limiter — squash peaks to a low ceiling
  // TTS output has extreme transients (0 dB peaks with -24 dB RMS, 24 dB dynamic range).
  // By limiting to -12 dB, we free up ~12 dB of headroom for gain.
  const lookaheadMs = 5;
  const lookaheadSamps = Math.round((lookaheadMs / 1000) * sampleRate);
  const ceilingLin = Math.pow(10, -12 / 20); // -12 dB ceiling
  const releaseCoeff = 1 / Math.round(0.08 * sampleRate); // 80ms release

  const processed = new Float32Array(floatSamples.length);
  let limiterGain = 1;

  for (let i = 0; i < floatSamples.length; i++) {
    // Find max peak in lookahead window
    let maxPeak = 0;
    const lookEnd = Math.min(i + lookaheadSamps, floatSamples.length);
    for (let j = i; j < lookEnd; j++) {
      const av = Math.abs(floatSamples[j]);
      if (av > maxPeak) maxPeak = av;
    }

    const targetGain = maxPeak > ceilingLin ? ceilingLin / maxPeak : 1;

    // Instant attack, smooth release
    if (targetGain < limiterGain) {
      limiterGain = targetGain;
    } else {
      limiterGain += (targetGain - limiterGain) * releaseCoeff;
    }

    processed[i] = floatSamples[i] * limiterGain;
  }

  // Step 2: RMS normalize with peak protection
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < processed.length; i++) {
    sumSq += processed[i] * processed[i];
    const av = Math.abs(processed[i]);
    if (av > peak) peak = av;
  }
  const rms = Math.sqrt(sumSq / processed.length);
  if (rms === 0) return buffer;

  const targetRms = Math.pow(10, targetDb / 20);
  const rmsGain = targetRms / rms;
  const maxGain = peak > 0 ? 0.95 / peak : rmsGain;
  const gain = Math.min(rmsGain, maxGain);

  const result = Buffer.alloc(data.length);
  const resultSamples = new Int16Array(result.buffer, result.byteOffset, result.length / 2);

  for (let i = 0; i < processed.length; i++) {
    resultSamples[i] = Math.round(processed[i] * gain * 32768);
  }

  return wavFromPcm({ pcm: result, audioFormat, channels, sampleRate, bitsPerSample });
}

export async function decodeMp3ToWav(mp3Path) {
  const { readFile } = await import("node:fs/promises");
  const { MPEGDecoder } = await import("mpg123-decoder");

  const mp3Data = await readFile(mp3Path);
  const decoder = new MPEGDecoder();
  await decoder.ready;

  const result = decoder.decode(mp3Data);
  decoder.free();

  // Take left channel (mono)
  const floatData = result.channelData[0];
  const pcm = Buffer.alloc(floatData.length * 2);
  for (let i = 0; i < floatData.length; i++) {
    let val = Math.round(floatData[i] * 32768);
    if (val > 32767) val = 32767;
    if (val < -32768) val = -32768;
    pcm.writeInt16LE(val, i * 2);
  }

  return wavFromPcm({
    pcm,
    audioFormat: 1,
    channels: 1,
    sampleRate: result.sampleRate,
    bitsPerSample: 16,
  });
}

export function mixWithBgm(speechWav, bgmWav, options = {}) {
  const { speechFadeIn: speechFadeInSec = 0 } = options;

  const speech = parseWav(speechWav);
  const bgm = parseWav(bgmWav);

  const speechLen = speech.data.length / 2;
  const bgmLen = bgm.data.length / 2;
  const sampleRate = speech.sampleRate;

  const speechFloat = new Float32Array(speechLen);
  for (let i = 0; i < speechLen; i++) {
    speechFloat[i] = speech.data.readInt16LE(i * 2) / 32768;
  }

  // Decode BGM to float and normalize to match speech RMS (-14 dB)
  let bgmSumSq = 0;
  for (let i = 0; i < bgmLen; i++) {
    bgmSumSq += Math.pow(bgm.data.readInt16LE(i * 2) / 32768, 2);
  }
  const bgmRms = Math.sqrt(bgmSumSq / bgmLen);
  const targetRms = Math.pow(10, -14 / 20);
  const bgmNormGain = bgmRms > 0 ? targetRms / bgmRms : 1;

  // Loop BGM to match speech length + intro
  const introSeconds = 8;
  const introSamples = introSeconds * sampleRate;
  const totalLen = introSamples + speechLen;
  const outroSeconds = 10;
  const outroSamples = outroSeconds * sampleRate;
  const finalLen = totalLen + outroSamples;
  const bgmFloat = new Float32Array(finalLen);
  for (let i = 0; i < finalLen; i++) {
    const bgmIdx = i % bgmLen;
    bgmFloat[i] = (bgm.data.readInt16LE(bgmIdx * 2) / 32768) * bgmNormGain;
  }

  // Ducking: now BGM is at same RMS as speech (-14 dB).
  // These gains are applied on top of the normalized BGM.
  const bgmIntro = 0.50;
  const bgmActive = 0.12;
  const bgmIdle = 0.22;

  const windowMs = 50;
  const windowSamples = Math.round((windowMs / 1000) * sampleRate);
  const speechThreshold = 0.01;
  const attackCoeff = 1 / Math.round(0.01 * sampleRate);
  const releaseCoeff = 1 / Math.round(0.2 * sampleRate);

  // Pre-compute speech RMS per window
  const windowCount = Math.ceil(speechLen / windowSamples);
  const speechActive = new Uint8Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    let sumSq = 0;
    const start = w * windowSamples;
    const end = Math.min(start + windowSamples, speechLen);
    for (let i = start; i < end; i++) {
      sumSq += speechFloat[i] * speechFloat[i];
    }
    const rms = Math.sqrt(sumSq / (end - start));
    speechActive[w] = rms > speechThreshold ? 1 : 0;
  }

  // Speech fade-in at the beginning (like a radio knob slowly turning up)
  const speechFadeInSamples = Math.round(speechFadeInSec * sampleRate);

  // Mix: intro (BGM only) + speech section (ducked BGM) + outro (BGM fade out)
  const mixed = new Float32Array(finalLen);
  let bgmGain = bgmIntro;
  const bgmFadeInSamples = 2 * sampleRate;

  for (let i = 0; i < finalLen; i++) {
    if (i < introSamples) {
      // Intro: BGM only with fade-in
      const fadeRatio = Math.min(1, i / bgmFadeInSamples);
      bgmGain = bgmIntro * fadeRatio;
      mixed[i] = bgmFloat[i] * bgmGain;
    } else if (i < totalLen) {
      // Speech section: ducked BGM
      const speechIdx = i - introSamples;
      const w = Math.floor(speechIdx / windowSamples);
      const targetGain = speechActive[w] ? bgmActive : bgmIdle;

      if (targetGain < bgmGain) {
        bgmGain += (targetGain - bgmGain) * attackCoeff;
      } else {
        bgmGain += (targetGain - bgmGain) * releaseCoeff;
      }

      // Apply speech fade-in at the beginning
      let speechGain = 1;
      if (speechFadeInSamples > 0 && speechIdx < speechFadeInSamples) {
        speechGain = speechIdx / speechFadeInSamples;
      }

      mixed[i] = speechFloat[speechIdx] * speechGain + bgmFloat[i] * bgmGain;
    } else {
      // Outro: BGM only with fade-out
      const outroIdx = i - totalLen;
      const fadeRatio = 1 - outroIdx / outroSamples;
      bgmGain = bgmIntro * fadeRatio;
      mixed[i] = bgmFloat[i] * bgmGain;
    }
  }

  // Clamp and convert back to 16-bit
  const resultPcm = Buffer.alloc(finalLen * 2);
  for (let i = 0; i < finalLen; i++) {
    let val = Math.round(mixed[i] * 32768);
    if (val > 32767) val = 32767;
    if (val < -32768) val = -32768;
    resultPcm.writeInt16LE(val, i * 2);
  }

  return wavFromPcm({
    pcm: resultPcm,
    audioFormat: 1,
    channels: 1,
    sampleRate,
    bitsPerSample: 16,
  });
}

// Mix a single segment with BGM for individual segment playback.
// Short intro/outro (2s each), BGM ducking underneath speech.
export function mixSingleSegmentWithBgm(segmentWav, bgmWav) {
  const speech = parseWav(segmentWav);
  const bgm = parseWav(bgmWav);

  const speechLen = speech.data.length / 2;
  const bgmLen = bgm.data.length / 2;
  const sampleRate = speech.sampleRate;

  const speechFloat = new Float32Array(speechLen);
  for (let i = 0; i < speechLen; i++) {
    speechFloat[i] = speech.data.readInt16LE(i * 2) / 32768;
  }

  let bgmSumSq = 0;
  for (let i = 0; i < bgmLen; i++) {
    bgmSumSq += Math.pow(bgm.data.readInt16LE(i * 2) / 32768, 2);
  }
  const bgmRms = Math.sqrt(bgmSumSq / bgmLen);
  const targetRms = Math.pow(10, -14 / 20);
  const bgmNormGain = bgmRms > 0 ? targetRms / bgmRms : 1;

  const introSamples = 2 * sampleRate;
  const outroSamples = 2 * sampleRate;
  const totalLen = introSamples + speechLen + outroSamples;

  const bgmFloat = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i++) {
    bgmFloat[i] = (bgm.data.readInt16LE((i % bgmLen) * 2) / 32768) * bgmNormGain;
  }

  const bgmIntro = 0.50;
  const bgmActive = 0.12;
  const bgmIdle = 0.22;
  const windowMs = 50;
  const windowSamples = Math.round((windowMs / 1000) * sampleRate);
  const speechThreshold = 0.01;
  const attackCoeff = 1 / Math.round(0.01 * sampleRate);
  const releaseCoeff = 1 / Math.round(0.2 * sampleRate);

  const windowCount = Math.ceil(speechLen / windowSamples);
  const speechActive = new Uint8Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    let sumSq = 0;
    const start = w * windowSamples;
    const end = Math.min(start + windowSamples, speechLen);
    for (let i = start; i < end; i++) {
      sumSq += speechFloat[i] * speechFloat[i];
    }
    speechActive[w] = Math.sqrt(sumSq / (end - start)) > speechThreshold ? 1 : 0;
  }

  const mixed = new Float32Array(totalLen);
  let bgmGain = bgmIntro;
  const bgmFadeIn = 1 * sampleRate;

  for (let i = 0; i < totalLen; i++) {
    if (i < introSamples) {
      const fadeRatio = Math.min(1, i / bgmFadeIn);
      bgmGain = bgmIntro * fadeRatio;
      mixed[i] = bgmFloat[i] * bgmGain;
    } else if (i < introSamples + speechLen) {
      const speechIdx = i - introSamples;
      const w = Math.floor(speechIdx / windowSamples);
      const targetGain = speechActive[w] ? bgmActive : bgmIdle;
      if (targetGain < bgmGain) {
        bgmGain += (targetGain - bgmGain) * attackCoeff;
      } else {
        bgmGain += (targetGain - bgmGain) * releaseCoeff;
      }
      mixed[i] = speechFloat[speechIdx] + bgmFloat[i] * bgmGain;
    } else {
      const outroIdx = i - introSamples - speechLen;
      const fadeRatio = 1 - outroIdx / outroSamples;
      bgmGain = bgmIntro * fadeRatio;
      mixed[i] = bgmFloat[i] * bgmGain;
    }
  }

  const resultPcm = Buffer.alloc(totalLen * 2);
  for (let i = 0; i < totalLen; i++) {
    let val = Math.round(mixed[i] * 32768);
    val = Math.max(-32768, Math.min(32767, val));
    resultPcm.writeInt16LE(val, i * 2);
  }

  return wavFromPcm({ pcm: resultPcm, audioFormat: 1, channels: 1, sampleRate, bitsPerSample: 16 });
}
