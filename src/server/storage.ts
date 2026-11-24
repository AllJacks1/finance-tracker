import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ApiError } from "./errors";

/**
 * S3-compatible object storage (Railway Buckets, Cloudflare R2, AWS S3, …) for receipts and
 * backups. Railway's application filesystem is ephemeral, so nothing permanent is stored locally.
 * Reads process.env directly so the backup CLI can reuse it outside Next.js.
 */
export function storageConfigured(): boolean {
  return !!(
    process.env.S3_ENDPOINT &&
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  );
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!storageConfigured()) throw new ApiError(503, "storage_not_configured", "File storage is not configured.");
  client ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}
const bucket = () => process.env.S3_BUCKET!;

export async function putObject(key: string, body: Uint8Array, contentType: string, metadata?: Record<string, string>) {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
      // Ask the provider to encrypt at rest where supported (S3 SSE-S3). Providers that always
      // encrypt (e.g. R2) ignore it; see docs/SECURITY.md for what is verified per provider.
      ...(process.env.S3_SSE === "AES256" ? { ServerSideEncryption: "AES256" as const } : {}),
    }),
  );
}

export async function getObject(key: string): Promise<{ body: Uint8Array; contentType?: string }> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = await res.Body!.transformToByteArray();
  return { body, contentType: res.ContentType };
}

export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function listObjects(prefix: string) {
  const out: { key: string; size: number; lastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0, lastModified: o.LastModified });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}
