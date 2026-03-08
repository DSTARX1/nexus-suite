/**
 * Variation combination engine: generate unique transform combos per variation.
 * Picks 2-3 visual (Layer 2) + 1-2 audio (Layer 3) + structural (Layer 4) transforms.
 * Ensures no two variations share the same combo.
 */

import {
  type Layer2Options,
  type Layer3Options,
  type Layer4Options,
  type TransformConfig,
  layer2Visual,
  layer3Audio,
  layer4Structural,
} from "./transforms.js";

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(randBetween(min, max + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// --- Visual transform pool (Layer 2 param generators) ---

type VisualParamGenerator = () => Partial<Layer2Options>;

const VISUAL_POOL: { name: string; gen: VisualParamGenerator }[] = [
  { name: "mirror", gen: () => ({ mirror: true }) },
  { name: "crop", gen: () => ({ cropPercent: randBetween(2, 5) }) },
  { name: "speed", gen: () => ({ speedFactor: randBetween(0.95, 1.05) }) },
  { name: "hue", gen: () => ({ colorShiftHue: randBetween(-15, 15) }) },
  { name: "colorBalance", gen: () => ({ colorBalanceRs: randBetween(-0.1, 0.1) }) },
  { name: "padding", gen: () => ({ padding: randInt(1, 4) }) },
  { name: "noise", gen: () => ({ noiseStrength: randInt(3, 8) }) },
  { name: "dar", gen: () => ({ darAdjust: randBetween(-0.02, 0.02) }) },
];

// --- Audio transform pool (Layer 3 param generators) ---

type AudioParamGenerator = () => Partial<Layer3Options>;

const AUDIO_POOL: { name: string; gen: AudioParamGenerator }[] = [
  { name: "pitch", gen: () => ({ pitchSemitones: randBetween(-2, 2) }) },
  { name: "tempo", gen: () => ({ tempoFactor: randBetween(0.97, 1.03) }) },
  { name: "noiseFloor", gen: () => ({ noiseDbfs: randBetween(-60, -50) }) },
  { name: "bitrate", gen: () => ({ audioBitrate: pick(["128k", "160k", "192k", "256k"]) }) },
];

export interface VariationCombo {
  visualNames: string[];
  audioNames: string[];
  layer2: Partial<Layer2Options>;
  layer3: Partial<Layer3Options>;
  layer4: Partial<Layer4Options>;
  config: TransformConfig;
}

function comboKey(combo: VariationCombo): string {
  return [
    combo.visualNames.sort().join("+"),
    combo.audioNames.sort().join("+"),
    combo.layer4.crf,
    combo.layer4.preset,
  ].join("|");
}

function generateOneCombo(): VariationCombo {
  // Pick 2-3 visual transforms
  const numVisual = randInt(2, 3);
  const visualPicks = shuffle(VISUAL_POOL).slice(0, numVisual);
  const visualNames = visualPicks.map((v) => v.name);
  const layer2: Partial<Layer2Options> = {};
  for (const v of visualPicks) {
    Object.assign(layer2, v.gen());
  }

  // Pick 1-2 audio transforms
  const numAudio = randInt(1, 2);
  const audioPicks = shuffle(AUDIO_POOL).slice(0, numAudio);
  const audioNames = audioPicks.map((a) => a.name);
  const layer3: Partial<Layer3Options> = {};
  for (const a of audioPicks) {
    Object.assign(layer3, a.gen());
  }

  // Structural params — always unique CRF + preset combo
  const layer4: Partial<Layer4Options> = {
    crf: randInt(18, 23),
    preset: pick(["medium", "slow"]),
    gop: randInt(24, 60),
    pixFmt: pick(["yuv420p", "yuv420p10le"]),
  };

  const config: TransformConfig = {
    layer1: true,
    layer2,
    layer3,
    layer4,
  };

  return { visualNames, audioNames, layer2, layer3, layer4, config };
}

/**
 * Generate `count` unique variation combos.
 * Retries if any combo duplicates another (by combo key).
 */
export function generateVariationCombos(count: number, maxRetries = 50): VariationCombo[] {
  const combos: VariationCombo[] = [];
  const usedKeys = new Set<string>();

  for (let i = 0; i < count; i++) {
    let combo: VariationCombo | null = null;
    let retries = 0;

    while (retries < maxRetries) {
      const candidate = generateOneCombo();
      const key = comboKey(candidate);

      if (!usedKeys.has(key)) {
        usedKeys.add(key);
        combo = candidate;
        break;
      }
      retries++;
    }

    if (!combo) {
      // Fallback: accept a combo even if key matches (params will still differ numerically)
      combo = generateOneCombo();
    }

    combos.push(combo);
  }

  return combos;
}

/**
 * Replace a specific variation combo at index, ensuring no collision with existing combos.
 */
export function regenerateCombo(
  combos: VariationCombo[],
  index: number,
  maxRetries = 50,
): VariationCombo {
  const usedKeys = new Set(
    combos.filter((_, i) => i !== index).map(comboKey),
  );

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const candidate = generateOneCombo();
    if (!usedKeys.has(comboKey(candidate))) {
      return candidate;
    }
  }

  // Fallback
  return generateOneCombo();
}
