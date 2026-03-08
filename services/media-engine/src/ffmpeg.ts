import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { type TransformFragment, type TransformConfig, composeTransforms } from "./transforms.js";
import { ensureAudioSafe } from "./audio-safety.js";

const TMP_DIR = "/tmp";

export interface FfmpegResult {
  outputPath: string;
  size: number;
  audioStripped?: boolean;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Build ffmpeg args from a TransformFragment.
 * Handles the audio noise mix via complex filtergraph when needed.
 */
export function buildArgs(
  inputPath: string,
  outputPath: string,
  fragment: TransformFragment,
): string[] {
  const args: string[] = ["-y", "-i", inputPath];

  const hasNoiseFilter = fragment.audioFilters.some((f) => f.startsWith("anoisesrc="));
  const plainAudioFilters = fragment.audioFilters.filter((f) => !f.startsWith("anoisesrc="));

  if (hasNoiseFilter) {
    // Complex filtergraph for audio noise mix
    const noiseFilter = fragment.audioFilters.find((f) => f.startsWith("anoisesrc="))!;
    // Extract noise amplitude from the filter
    const noiseMatch = noiseFilter.match(/a=([\d.e-]+)/);
    const noiseAmp = noiseMatch ? noiseMatch[1] : "0.001";

    const vf = fragment.videoFilters.length > 0
      ? `[0:v]${fragment.videoFilters.join(",")}[vout]`
      : "";

    const af = [
      `[0:a]${plainAudioFilters.join(",")}[apre]`,
      `anoisesrc=color=white:sample_rate=44100:amplitude=${noiseAmp}[noise]`,
      `[apre][noise]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    ].join(";");

    const filterComplex = [vf, af].filter(Boolean).join(";");
    args.push("-filter_complex", filterComplex);

    if (vf) args.push("-map", "[vout]");
    args.push("-map", "[aout]");
  } else {
    // Simple filtergraph
    if (fragment.videoFilters.length > 0) {
      args.push("-vf", fragment.videoFilters.join(","));
    }
    if (plainAudioFilters.length > 0) {
      args.push("-af", plainAudioFilters.join(","));
    }
  }

  args.push(...fragment.outputArgs, outputPath);
  return args;
}

/**
 * Run the full 4-layer transform pipeline on a video file.
 */
export async function runPipeline(
  inputPath: string,
  config?: TransformConfig,
): Promise<FfmpegResult> {
  const safeResult = await ensureAudioSafe(inputPath);
  const effectiveInput = safeResult.outputPath;

  const fragment = composeTransforms(config);
  const ext = effectiveInput.split(".").pop() ?? "mp4";
  const outputPath = join(TMP_DIR, `ffout-${randomUUID().slice(0, 8)}.${ext}`);

  const args = buildArgs(effectiveInput, outputPath, fragment);
  await exec("ffmpeg", args);

  const fileStat = await stat(outputPath);
  return { outputPath, size: fileStat.size, audioStripped: safeResult.audioStripped };
}

/**
 * Run ffmpeg with explicit pre-built args (for agent-specified transforms).
 */
export async function runRaw(
  inputPath: string,
  fragment: TransformFragment,
  outputExt = "mp4",
): Promise<FfmpegResult> {
  const outputPath = join(TMP_DIR, `ffout-${randomUUID().slice(0, 8)}.${outputExt}`);
  const args = buildArgs(inputPath, outputPath, fragment);
  await exec("ffmpeg", args);

  const fileStat = await stat(outputPath);
  return { outputPath, size: fileStat.size };
}
