/**
 * Audio copyright safety: detect music vs speech-only via FFmpeg ebur128 + silence detection.
 * If music detected: strip audio, inject silent placeholder.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stat } from "node:fs/promises";

const TMP_DIR = "/tmp";

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 }, (err, stdout, stderr) => {
      if (err && !stderr) {
        reject(new Error(`${cmd} failed: ${err.message}`));
        return;
      }
      // ffmpeg writes analysis to stderr even on success
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export interface AudioAnalysis {
  hasAudio: boolean;
  integratedLoudness: number; // LUFS
  loudnessRange: number;      // LU
  silenceRatio: number;       // 0-1 (fraction of total duration that is silence)
  likelyMusic: boolean;
}

/**
 * Analyze audio track using ebur128 loudness + silence detection.
 * Music typically has: high loudness range, low silence ratio, consistent loudness.
 * Speech-only: variable silence ratio, lower loudness range.
 */
export async function analyzeAudio(inputPath: string): Promise<AudioAnalysis> {
  // Check if file has an audio stream
  const probeResult = await exec("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0",
    inputPath,
  ]);

  if (!probeResult.stdout.includes("audio")) {
    return {
      hasAudio: false,
      integratedLoudness: -Infinity,
      loudnessRange: 0,
      silenceRatio: 1,
      likelyMusic: false,
    };
  }

  // Get duration
  const durationResult = await exec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    inputPath,
  ]);
  const duration = parseFloat(durationResult.stdout) || 0;

  // Run ebur128 loudness analysis
  let integratedLoudness = -70;
  let loudnessRange = 0;
  try {
    const ebur128Result = await exec("ffmpeg", [
      "-i", inputPath,
      "-af", "ebur128=framelog=verbose",
      "-f", "null", "-",
    ]);
    const stderr = ebur128Result.stderr;
    const ilMatch = stderr.match(/I:\s*([-\d.]+)\s*LUFS/);
    const lraMatch = stderr.match(/LRA:\s*([-\d.]+)\s*LU/);
    if (ilMatch) integratedLoudness = parseFloat(ilMatch[1]);
    if (lraMatch) loudnessRange = parseFloat(lraMatch[1]);
  } catch {
    // ebur128 may fail on very short clips — use defaults
  }

  // Run silence detection
  let silenceDuration = 0;
  try {
    const silenceResult = await exec("ffmpeg", [
      "-i", inputPath,
      "-af", "silencedetect=noise=-30dB:d=0.5",
      "-f", "null", "-",
    ]);
    const silenceMatches = silenceResult.stderr.matchAll(/silence_duration:\s*([\d.]+)/g);
    for (const m of silenceMatches) {
      silenceDuration += parseFloat(m[1]);
    }
  } catch {
    // silence detection failure — assume no silence
  }

  const silenceRatio = duration > 0 ? Math.min(silenceDuration / duration, 1) : 0;

  // Heuristic: music has low silence ratio (<30%), moderate-high loudness range (>5 LU),
  // and reasonable loudness (> -40 LUFS)
  const likelyMusic =
    silenceRatio < 0.3 &&
    loudnessRange > 5 &&
    integratedLoudness > -40;

  return {
    hasAudio: true,
    integratedLoudness,
    loudnessRange,
    silenceRatio,
    likelyMusic,
  };
}

export interface SafeAudioResult {
  outputPath: string;
  audioStripped: boolean;
  analysis: AudioAnalysis;
}

/**
 * If music is detected, strip audio and inject a silent track.
 * Otherwise, pass through unchanged.
 */
export async function ensureAudioSafe(inputPath: string): Promise<SafeAudioResult> {
  const analysis = await analyzeAudio(inputPath);

  if (!analysis.hasAudio || !analysis.likelyMusic) {
    return { outputPath: inputPath, audioStripped: false, analysis };
  }

  // Strip original audio, add silent audio track
  const ext = inputPath.split(".").pop() ?? "mp4";
  const outputPath = join(TMP_DIR, `safe-${randomUUID().slice(0, 8)}.${ext}`);

  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      "-map", "0:v:0",
      "-map", "1:a:0",
      outputPath,
    ], { timeout: 300_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`audio strip failed: ${stderr || err.message}`));
        return;
      }
      resolve();
    });
  });

  await stat(outputPath); // verify output exists
  return { outputPath, audioStripped: true, analysis };
}
