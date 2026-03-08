import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stat } from "node:fs/promises";

const TMP_DIR = "/tmp";

export interface DownloadOptions {
  url: string;
  proxy?: string;
  format?: string;
}

export interface DownloadResult {
  localPath: string;
  filename: string;
  size: number;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function download(opts: DownloadOptions): Promise<DownloadResult> {
  const id = randomUUID().slice(0, 8);
  const outputTemplate = join(TMP_DIR, `ytdl-${id}-%(title).30s.%(ext)s`);

  const args: string[] = [
    opts.url,
    "-o", outputTemplate,
    "--no-playlist",
    "--no-overwrites",
    "--print", "after_move:filepath",
  ];

  if (opts.format) {
    args.push("-f", opts.format);
  }

  const proxy = opts.proxy ?? process.env.PROXY_DATACENTER_ENDPOINT;
  if (proxy) {
    args.push("--proxy", proxy);
  }

  const output = await exec("yt-dlp", args);
  const localPath = output.split("\n").pop()!.trim();

  const fileStat = await stat(localPath);

  return {
    localPath,
    filename: localPath.split("/").pop()!,
    size: fileStat.size,
  };
}
