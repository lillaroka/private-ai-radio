#!/usr/bin/env python3
"""Detect speech start in a WAV file using WebRTC VAD + energy check.

Usage: python vad-detect.py <wav_path> [--max-scan-ms 5000] [--threshold 5] [--aggressiveness 3]

Prints the number of milliseconds to trim from the start (0 if clean).

Two-phase detection:
1. WebRTC VAD finds candidate speech start (N consecutive speech frames)
2. Energy check ensures speech has sufficient RMS (skips low-energy TTS artifacts)
"""
import argparse
import math
import struct
import sys
import wave

import webrtcvad


def resample_mono_16k(raw_pcm, src_rate, channels, bits_per_sample):
    """Convert raw PCM bytes to 16kHz mono 16-bit samples."""
    if bits_per_sample != 16:
        raise ValueError(f"Only 16-bit audio supported, got {bits_per_sample}-bit")

    count = len(raw_pcm) // 2
    samples = struct.unpack(f"<{count}h", raw_pcm)

    # Stereo to mono
    if channels == 2:
        samples = samples[0::2]

    # Resample to 16kHz by simple decimation
    if src_rate != 16000:
        ratio = src_rate / 16000
        new_len = int(len(samples) / ratio)
        samples = tuple(samples[int(i * ratio)] for i in range(new_len))

    return struct.pack(f"<{len(samples)}h", *samples)


def frame_rms(raw_pcm, bits_per_sample):
    """Compute RMS of a raw PCM frame as float in [0, 1]."""
    if bits_per_sample != 16:
        return 0.0
    count = len(raw_pcm) // 2
    if count == 0:
        return 0.0
    samples = struct.unpack(f"<{count}h", raw_pcm)
    sum_sq = sum(s * s for s in samples)
    return math.sqrt(sum_sq / count) / 32768


def detect_speech_start(wav_path, max_scan_ms=5000, threshold=5, aggressiveness=3):
    vad = webrtcvad.Vad(aggressiveness)
    frame_ms = 30

    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate()
        channels = wf.getnchannels()
        bits = wf.getsampwidth() * 8
        total_frames = wf.getnframes()
        total_ms = int(total_frames / sr * 1000)

        # Read the entire file for energy reference
        all_raw = wf.readframes(total_frames)

    # Compute reference RMS from the middle 50% of the audio
    total_samples = len(all_raw) // 2
    all_samples = struct.unpack(f"<{total_samples}h", all_raw)
    if channels == 2:
        all_samples = all_samples[0::2]

    mid_start = total_samples // 4
    mid_end = total_samples * 3 // 4
    mid_samples = all_samples[mid_start:mid_end]
    if mid_samples:
        ref_rms = math.sqrt(sum(s * s for s in mid_samples) / len(mid_samples)) / 32768
    else:
        ref_rms = 0.01

    # Energy threshold: speech must be at least 12 dB below the reference RMS
    # This skips low-energy TTS artifacts that WebRTC VAD misclassifies as speech
    energy_threshold = ref_rms * 0.25  # -12 dB below reference

    # Two-phase scan
    frame_bytes = int(sr * frame_ms / 1000) * (bits // 8) * channels
    frames_to_check = int(max_scan_ms / frame_ms)
    consecutive_speech = 0

    for i in range(frames_to_check):
        offset = i * frame_bytes
        raw = all_raw[offset : offset + frame_bytes]
        if len(raw) < frame_bytes:
            break

        try:
            pcm = resample_mono_16k(raw, sr, channels, bits)
        except (ValueError, struct.error):
            break

        try:
            is_speech = vad.is_speech(pcm, 16000)
        except Exception:
            break

        rms = frame_rms(raw, bits)

        if is_speech and rms >= energy_threshold:
            consecutive_speech += 1
            if consecutive_speech >= threshold:
                speech_start = (i - threshold + 1) * frame_ms
                return speech_start
        else:
            consecutive_speech = 0

    return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path")
    parser.add_argument("--max-scan-ms", type=int, default=5000)
    parser.add_argument("--threshold", type=int, default=5)
    parser.add_argument("--aggressiveness", type=int, default=3, choices=[0, 1, 2, 3])
    args = parser.parse_args()

    result = detect_speech_start(
        args.wav_path,
        max_scan_ms=args.max_scan_ms,
        threshold=args.threshold,
        aggressiveness=args.aggressiveness,
    )
    print(result if result is not None else 0)
