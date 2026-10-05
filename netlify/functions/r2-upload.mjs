import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const PART_SIZE = 64 * 1024 * 1024; // 64 MiB; works well for 2GB+ mobile uploads
const MAX_PARTS = 10000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function authorized(req) {
  const configured = process.env.ADMIN_PASSWORD;
  const supplied = req.headers.get("x-admin-password");
  return Boolean(configured && supplied && supplied === configured);
}

function client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 is not configured. Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in Netlify environment variables.");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  });
}

function bucket() {
  const value = process.env.R2_BUCKET_NAME;
  if (!value) throw new Error("R2_BUCKET_NAME is missing.");
  return value;
}

function publicUrl(key) {
  const base = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("R2_PUBLIC_BASE_URL is missing. Set it to your public R2/custom-domain URL.");
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export default async (req) => {
  if (!authorized(req)) return json({ error: "Invalid admin password." }, 401);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    const action = body.action;
    const s3 = client();
    const Bucket = bucket();

    if (action === "create") {
      const safeName = String(body.fileName || "video.mp4")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(-180);
      const key = `dopa/videos/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
      const contentType = String(body.contentType || "video/mp4");
      const fileSize = Number(body.fileSize || 0);
      if (!fileSize || fileSize < 1) return json({ error: "Invalid file size." }, 400);

      const partCount = Math.ceil(fileSize / PART_SIZE);
      if (partCount > MAX_PARTS) return json({ error: "File is too large for this uploader." }, 400);

      const created = await s3.send(new CreateMultipartUploadCommand({
        Bucket, Key: key, ContentType: contentType
      }));

      const urls = [];
      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        const command = new UploadPartCommand({ Bucket, Key: key, UploadId: created.UploadId, PartNumber: partNumber });
        urls.push(await getSignedUrl(s3, command, { expiresIn: 21600 }));
      }

      return json({ key, uploadId: created.UploadId, partSize: PART_SIZE, partCount, urls });
    }

    if (action === "complete") {
      const key = String(body.key || "");
      const uploadId = String(body.uploadId || "");
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (!key || !uploadId || !parts.length) return json({ error: "Missing multipart upload details." }, 400);

      const completed = await s3.send(new CompleteMultipartUploadCommand({
        Bucket, Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: parts.map(p => ({ PartNumber: Number(p.PartNumber), ETag: String(p.ETag) })) }
      }));

      return json({ ok: true, url: publicUrl(key), key, location: completed.Location || null });
    }

    if (action === "abort") {
      const key = String(body.key || "");
      const uploadId = String(body.uploadId || "");
      if (key && uploadId) await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error?.message || "R2 upload error." }, 500);
  }
};
