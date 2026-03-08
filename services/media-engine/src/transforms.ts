/**
 * 4-layer hash alteration transform definitions.
 * Each layer returns FFmpeg filter/option fragments.
 */

// --- Utilities ---

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(randBetween(min, max + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// --- Types ---

export interface TransformFragment {
  videoFilters: string[];
  audioFilters: string[];
  outputArgs: string[];
}

function emptyFragment(): TransformFragment {
  return { videoFilters: [], audioFilters: [], outputArgs: [] };
}

// --- Layer 1: File-level hash ---
// Strip metadata, randomize timestamps, re-mux

export function layer1FileHash(): TransformFragment {
  const frag = emptyFragment();
  frag.outputArgs.push(
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-metadata", `creation_time=${randomTimestamp()}`,
  );
  return frag;
}

function randomTimestamp(): string {
  const base = Date.now() - randInt(86400_000, 365 * 86400_000);
  return new Date(base).toISOString();
}

// --- Layer 2: Visual pHash alteration ---

export interface Layer2Options {
  mirror?: boolean;
  cropPercent?: number;     // 2-5
  speedFactor?: number;     // 0.95-1.05
  colorShiftHue?: number;   // degrees
  colorBalanceRs?: number;
  padding?: number;         // pixels
  noiseStrength?: number;   // 0-100
  darAdjust?: number;       // micro aspect ratio shift
}

export function layer2Visual(opts?: Partial<Layer2Options>): TransformFragment {
  const frag = emptyFragment();
  const o: Layer2Options = {
    mirror: opts?.mirror ?? Math.random() > 0.5,
    cropPercent: opts?.cropPercent ?? randBetween(2, 5),
    speedFactor: opts?.speedFactor ?? randBetween(0.95, 1.05),
    colorShiftHue: opts?.colorShiftHue ?? randBetween(-15, 15),
    colorBalanceRs: opts?.colorBalanceRs ?? randBetween(-0.1, 0.1),
    padding: opts?.padding ?? randInt(1, 4),
    noiseStrength: opts?.noiseStrength ?? randInt(3, 8),
    darAdjust: opts?.darAdjust ?? randBetween(-0.02, 0.02),
    ...opts,
  };

  if (o.mirror) {
    frag.videoFilters.push("hflip");
  }

  const cropRatio = o.cropPercent! / 100;
  frag.videoFilters.push(
    `crop=iw*${(1 - cropRatio).toFixed(4)}:ih*${(1 - cropRatio).toFixed(4)}`
  );

  const pts = (1 / o.speedFactor!).toFixed(6);
  frag.videoFilters.push(`setpts=${pts}*PTS`);

  frag.videoFilters.push(`hue=h=${o.colorShiftHue!.toFixed(2)}`);
  frag.videoFilters.push(
    `colorbalance=rs=${o.colorBalanceRs!.toFixed(3)}:gs=${(o.colorBalanceRs! * 0.5).toFixed(3)}`
  );

  frag.videoFilters.push(`pad=iw+${o.padding! * 2}:ih+${o.padding! * 2}:${o.padding}:${o.padding}`);
  frag.videoFilters.push(`noise=alls=${o.noiseStrength}:allf=t`);

  const dar = 16 / 9 + o.darAdjust!;
  frag.videoFilters.push(`setdar=${dar.toFixed(6)}`);

  return frag;
}

// --- Layer 3: Audio fingerprint alteration ---

export interface Layer3Options {
  pitchSemitones?: number;  // +-2
  tempoFactor?: number;     // 0.97-1.03
  noiseDbfs?: number;       // -60 to -50
  audioBitrate?: string;    // e.g. "128k", "192k"
}

export function layer3Audio(opts?: Partial<Layer3Options>): TransformFragment {
  const frag = emptyFragment();
  const o: Layer3Options = {
    pitchSemitones: opts?.pitchSemitones ?? randBetween(-2, 2),
    tempoFactor: opts?.tempoFactor ?? randBetween(0.97, 1.03),
    noiseDbfs: opts?.noiseDbfs ?? randBetween(-60, -50),
    audioBitrate: opts?.audioBitrate ?? pick(["128k", "160k", "192k", "256k"]),
    ...opts,
  };

  // Pitch shift via asetrate + aresample
  const semitones = o.pitchSemitones!;
  const rateMultiplier = Math.pow(2, semitones / 12);
  const newRate = Math.round(44100 * rateMultiplier);
  frag.audioFilters.push(`asetrate=${newRate}`);
  frag.audioFilters.push("aresample=44100");

  // Tempo adjust
  frag.audioFilters.push(`atempo=${o.tempoFactor!.toFixed(4)}`);

  // White noise floor mix
  const noiseVol = Math.pow(10, o.noiseDbfs! / 20).toFixed(8);
  frag.audioFilters.push(
    `anoisesrc=d=0:c=white:a=${noiseVol}[noise]`,
  );
  // The noise mix requires a complex filtergraph — handled by pipeline builder

  // Bitrate set via output args
  frag.outputArgs.push("-b:a", o.audioBitrate!);

  return frag;
}

// --- Layer 4: Structural uniqueness ---

export interface Layer4Options {
  crf?: number;        // 18-23
  preset?: string;     // medium/slow
  gop?: number;        // 24-60
  pixFmt?: string;     // yuv420p / yuv420p10le
}

export function layer4Structural(opts?: Partial<Layer4Options>): TransformFragment {
  const frag = emptyFragment();
  const o: Layer4Options = {
    crf: opts?.crf ?? randInt(18, 23),
    preset: opts?.preset ?? pick(["medium", "slow"]),
    gop: opts?.gop ?? randInt(24, 60),
    pixFmt: opts?.pixFmt ?? pick(["yuv420p", "yuv420p10le"]),
    ...opts,
  };

  frag.outputArgs.push(
    "-crf", String(o.crf),
    "-preset", o.preset!,
    "-g", String(o.gop),
    "-pix_fmt", o.pixFmt!,
  );

  return frag;
}

// --- Compose all layers ---

export interface TransformConfig {
  layer1?: boolean;
  layer2?: Partial<Layer2Options>;
  layer3?: Partial<Layer3Options>;
  layer4?: Partial<Layer4Options>;
}

export function composeTransforms(config?: TransformConfig): TransformFragment {
  const fragments: TransformFragment[] = [];

  if (config?.layer1 !== false) {
    fragments.push(layer1FileHash());
  }
  fragments.push(layer2Visual(config?.layer2));
  fragments.push(layer3Audio(config?.layer3));
  fragments.push(layer4Structural(config?.layer4));

  const merged = emptyFragment();
  for (const f of fragments) {
    merged.videoFilters.push(...f.videoFilters);
    merged.audioFilters.push(...f.audioFilters);
    merged.outputArgs.push(...f.outputArgs);
  }
  return merged;
}
