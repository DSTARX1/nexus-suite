/**
 * pHash + audio fingerprint verification.
 * Computes perceptual hash (DCT-based from video frames) + chromaprint audio fingerprint.
 * Verifies Hamming distance > 5 between all variation pairs.
 * On collision: regenerate the colliding variation.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

const TMP_DIR = "/tmp";

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 }, (err, stdout, stderr) => {
      if (err && !stderr) {
        reject(new Error(`${cmd} failed: ${err.message}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// --- Perceptual Hash (DCT-based from video frames) ---

/**
 * Extract a frame from the video and compute a simple DCT-based perceptual hash.
 * Uses ffmpeg to extract a grayscale 8x8 thumbnail, then hashes pixel averages.
 */
export async function computeVideoPhash(videoPath: string): Promise<string> {
  const framePath = join(TMP_DIR, `phash-${randomUUID().slice(0, 8)}.gray`);

  try {
    // Extract a single frame at 1s, scale to 32x32 grayscale
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", [
        "-y",
        "-i", videoPath,
        "-ss", "1",
        "-frames:v", "1",
        "-vf", "scale=32:32,format=gray",
        "-f", "rawvideo",
        framePath,
      ], { timeout: 60_000 }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`frame extraction failed: ${stderr || err.message}`));
          return;
        }
        resolve();
      });
    });

    // Read raw pixel data and compute DCT-based hash
    const { readFile } = await import("node:fs/promises");
    const pixels = await readFile(framePath);

    // Simple DCT-inspired pHash: compute 8x8 mean of 32x32 blocks, then compare to median
    const blockSize = 4; // 32/8 = 4
    const means: number[] = [];

    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        let sum = 0;
        for (let y = 0; y < blockSize; y++) {
          for (let x = 0; x < blockSize; x++) {
            const idx = (by * blockSize + y) * 32 + (bx * blockSize + x);
            sum += pixels[idx] ?? 0;
          }
        }
        means.push(sum / (blockSize * blockSize));
      }
    }

    // Median
    const sorted = [...means].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    // Build 64-bit hash: each bit = 1 if block mean > median
    let hash = "";
    for (const m of means) {
      hash += m > median ? "1" : "0";
    }

    // Convert binary string to hex
    let hex = "";
    for (let i = 0; i < hash.length; i += 4) {
      hex += parseInt(hash.slice(i, i + 4), 2).toString(16);
    }

    return hex;
  } finally {
    try { await unlink(framePath); } catch { /* ignore */ }
  }
}

// --- Audio Fingerprint (chromaprint via fpcalc) ---

/**
 * Compute audio fingerprint using fpcalc (chromaprint).
 * Falls back to FFmpeg-based hash if fpcalc is not available.
 */
export async function computeAudioFingerprint(videoPath: string): Promise<string> {
  try {
    // Try fpcalc first
    const result = await exec("fpcalc", ["-raw", "-length", "30", videoPath]);
    const fpLine = result.stdout.split("\n").find((l) => l.startsWith("FINGERPRINT="));
    if (fpLine) {
      // Hash the raw fingerprint for consistent-length comparison
      return createHash("sha256").update(fpLine).digest("hex").slice(0, 16);
    }
  } catch {
    // fpcalc not available — fallback
  }

  // Fallback: extract audio samples and hash them
  const audioPath = join(TMP_DIR, `afp-${randomUUID().slice(0, 8)}.raw`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", [
        "-y",
        "-i", videoPath,
        "-t", "10",
        "-ac", "1",
        "-ar", "8000",
        "-f", "s16le",
        audioPath,
      ], { timeout: 60_000 }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`audio extract failed: ${stderr || err.message}`));
          return;
        }
        resolve();
      });
    });

    const { readFile } = await import("node:fs/promises");
    const data = await readFile(audioPath);
    return createHash("sha256").update(data).digest("hex").slice(0, 16);
  } finally {
    try { await unlink(audioPath); } catch { /* ignore */ }
  }
}

// --- Hamming Distance ---

/**
 * Compute Hamming distance between two hex strings of equal length.
 * Counts differing bits.
 */
export function hammingDistance(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  let distance = 0;

  for (let i = 0; i < minLen; i++) {
    const xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    // Count bits in xor (popcount for 4-bit value)
    distance += ((xor >> 0) & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }

  return distance;
}

// --- Verification ---

export interface VariationFingerprint {
  index: number;
  videoPath: string;
  pHash: string;
  audioFingerprint: string;
}

/**
 * Compute fingerprints for a single variation.
 */
export async function fingerprintVariation(
  videoPath: string,
  index: number,
): Promise<VariationFingerprint> {
  const [pHash, audioFingerprint] = await Promise.all([
    computeVideoPhash(videoPath),
    computeAudioFingerprint(videoPath),
  ]);

  return { index, videoPath, pHash, audioFingerprint };
}

export interface CollisionPair {
  indexA: number;
  indexB: number;
  pHashDistance: number;
  audioDistance: number;
}

const MIN_PHASH_DISTANCE = 5;

/**
 * Check all variation pairs for collisions (Hamming distance <= 5).
 * Returns pairs that collide.
 */
export function detectCollisions(fingerprints: VariationFingerprint[]): CollisionPair[] {
  const collisions: CollisionPair[] = [];

  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const a = fingerprints[i]!;
      const b = fingerprints[j]!;

      const pHashDist = hammingDistance(a.pHash, b.pHash);
      const audioDist = hammingDistance(a.audioFingerprint, b.audioFingerprint);

      // Collision if EITHER pHash or audio fingerprint is too close
      if (pHashDist <= MIN_PHASH_DISTANCE || audioDist <= MIN_PHASH_DISTANCE) {
        collisions.push({
          indexA: a.index,
          indexB: b.index,
          pHashDistance: pHashDist,
          audioDistance: audioDist,
        });
      }
    }
  }

  return collisions;
}

/**
 * Get indices of variations that need regeneration due to collisions.
 * For each colliding pair, marks the higher-index variation for regeneration.
 */
export function getCollisionIndices(collisions: CollisionPair[]): number[] {
  const indices = new Set<number>();
  for (const c of collisions) {
    // Regenerate the higher index to preserve earlier variations
    indices.add(Math.max(c.indexA, c.indexB));
  }
  return [...indices];
}
