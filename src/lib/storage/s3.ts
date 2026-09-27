import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

// All Cloudflare R2 configuration comes from environment variables; no
// credentials, account IDs, endpoints, or bucket names are hardcoded here.
// R2 is S3-compatible, so the existing @aws-sdk/client-s3 stack is retained.
//
// This layer was migrated from local MinIO to Cloudflare R2 at explicit user
// direction, overriding the MinIO-for-local-development choice previously
// locked in AGENTS.md Section 2 — do not "restore" MinIO or its fallbacks.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing Cloudflare R2 configuration: ${name} is not set. See .env.example.`
    );
  }
  return value;
}

const R2_ENDPOINT = requireEnv("R2_ENDPOINT");
const R2_BUCKET = requireEnv("R2_BUCKET");
const R2_REGION = requireEnv("R2_REGION");
const R2_ACCESS_KEY_ID = requireEnv("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = requireEnv("R2_SECRET_ACCESS_KEY");

export const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  // R2 requires path-style addressing for its S3-compatible API
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = R2_BUCKET;

export function generateStorageKey(
  userId: string,
  jobId: string,
  fileName: string
): string {
  const sanitizeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `receipts/${userId}/${jobId}-${sanitizeName}`;
}

export async function uploadFileToStorage(
  key: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  });
  await s3Client.send(command);
  return key;
}

export async function getFileFromStorage(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  const response = await s3Client.send(command);
  if (!response.Body) {
    throw new Error(`Storage object body empty for key: ${key}`);
  }

  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}