import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

const accountId = process.env.R2_ACCOUNT_ID!;
const accessKeyId = process.env.R2_ACCESS_KEY_ID!;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;
const bucket = process.env.R2_BUCKET_NAME ?? "nexus-storage";

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

export interface UploadResult {
  key: string;
  bucket: string;
  size: number;
}

export async function uploadToR2(
  localPath: string,
  key?: string
): Promise<UploadResult> {
  const storageKey = key ?? `media/${Date.now()}-${basename(localPath)}`;
  const fileStat = await stat(localPath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: createReadStream(localPath),
      ContentLength: fileStat.size,
    })
  );

  return { key: storageKey, bucket, size: fileStat.size };
}
