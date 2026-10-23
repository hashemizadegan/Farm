/**
 * Uploads the review screenshots (tests/review-shots/*.jpg, written by e2e/preview-screens.spec.ts) to the preview
 * project's private bucket: the images under review/<commit>/ (browsable by the owner in the Railway dashboard: bucket →
 * Files), and an encrypted transfer copy under transfer/<commit>/ (RSA-OAEP-SHA256 wrapped AES-256-GCM key, for the
 * reviewer's public key REVIEW_SHOTS_PUBKEY, base64 PEM). Prints one short-lived pre-signed URL per transfer copy: they
 * reach ciphertext only. Bucket credentials come from in-project references and are never printed.
 */
import { createCipheriv, publicEncrypt, randomBytes, constants } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../review-shots");
const req = createRequire("/repo/apps/api/package.json");
const { S3Client, PutObjectCommand, GetObjectCommand } = req("@aws-sdk/client-s3");
const { getSignedUrl } = req("@aws-sdk/s3-request-presigner");

const { BUCKET, REVIEW_SHOTS_PUBKEY } = process.env;
const commit = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown").slice(0, 7);
if (!BUCKET || !REVIEW_SHOTS_PUBKEY) throw new Error("BUCKET and REVIEW_SHOTS_PUBKEY are required");
const publicKey = Buffer.from(REVIEW_SHOTS_PUBKEY, "base64").toString("utf8");
const s3 = new S3Client({
  endpoint: process.env.ENDPOINT,
  region: process.env.REGION ?? "auto",
  credentials: { accessKeyId: process.env.ACCESS_KEY_ID, secretAccessKey: process.env.SECRET_ACCESS_KEY },
});

function seal(plain) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(wrapped.length);
  return Buffer.concat([len, wrapped, iv, cipher.getAuthTag(), body]);
}

for (const file of readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort()) {
  const plain = readFileSync(path.join(dir, file));
  const name = file.replace(/\.jpg$/, "");
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `review/${commit}/${file}`, Body: plain, ContentType: "image/jpeg" }));
  const key = `transfer/${commit}/${file}.enc`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: seal(plain), ContentType: "application/octet-stream" }));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
  console.log(`SHOT-URL ${name}=${url}`);
}
console.log(`SHOT-UPLOADED review/${commit}/`);
