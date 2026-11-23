# Files: bytes, object storage, uploads, quotas, lifecycle

`FileService` keeps file records (metadata) and, from 0.21.0, the bytes. Every operation is a
gateway effect (`files.read`, `files.write`, `files.delete`) with an `operation` resource attribute,
and every object-store call is part of that effect's evidence (`provider` = the store id,
`credentialRef` for S3).

## Object stores

| Store | Bytes live in | Presigned URLs |
| --- | --- | --- |
| `FeltDbObjectStore` (default) | the services' FeltDB instance, in chunk records (`file_object_chunks`, 512 KiB raw each, under a managed authority's 1 MiB request cap) with a manifest (`file_objects`) | no |
| `S3ObjectStore({ bucket, region, endpoint?, forcePathStyle?, accessKeyId, credentialRef, prefix?, minPartSize? })` | AWS S3 or an S3-compatible store (Cloudflare R2: `endpoint: 'https://<account>.r2.cloudflarestorage.com', region: 'auto'`; MinIO) | yes |

`createServices({ files: { objectStore, quota, presignExpiresSeconds?, uploadExpiresSeconds?, partSize? } })`;
`objectStore: false` keeps metadata only. The S3 secret access key is a `credential-ref` into custody
(a string, or `{ secretAccessKey, sessionToken? }`), resolved per operation. Requests are signed with
AWS Signature Version 4 implemented here (`signAwsRequest`, `presignAwsUrl`, `verifyAwsSignature`),
verified against AWS's published examples.

## Operations

| Method | Capability / `operation` | |
| --- | --- | --- |
| `upload({ name, data \| dataBase64, contentType?, owner?, metadata?, retainUntil?, expiresAt? })` | `files.write` / `upload` | one call, up to `MAX_INLINE_UPLOAD_BYTES` (64 MiB) |
| `download(tenantId, id)` → `{ file, bytes }` | `files.read` / `download` | |
| `createUploadUrl({ name, size, ... , expiresInSeconds? })` → `{ file, upload }`, then `confirmUpload(tenantId, fileId)` | `files.write` / `presign-upload`, `confirm-upload` | S3; the file is `pending` until the stored size is checked |
| `createDownloadUrl(tenantId, id, { expiresInSeconds?, filename? })` | `files.read` / `presign-download` | S3 |
| `beginUpload({ name, size, partSize?, ... })` → `FileUploadView` | `files.write` / `upload` | resumable |
| `uploadPart(tenantId, uploadId, partNumber, bytes \| base64)` | `files.write` / `upload-part` | re-sending a part replaces it |
| `createPartUploadUrl(tenantId, uploadId, partNumber)` | `files.write` / `presign-part` | S3 |
| `uploadStatus(tenantId, uploadId)` → `{ receivedParts, missingParts, ... }` | `files.read` / `upload-status` | resume after a failure or restart |
| `completeUpload(tenantId, uploadId, { parts? })` | `files.write` / `complete-upload` | `parts`: ETags of presigned parts |
| `abortUpload(tenantId, uploadId)` | `files.write` / `abort-upload` | releases parts and quota |
| `usage(tenantId)` → `{ bytes, files, quota? }` | `files.read` / `usage` | |
| `sweep(tenantId, { limit? })` → `{ deleted, retained, abortedUploads, complete }` | `files.delete` / `lifecycle` | run it from a schedule |

Through `invoke`, the same operations are `files.write` / `files.read` / `files.delete` with
`operation` in the input (bytes as `dataBase64`).

Resumable uploads are durable (`file_uploads`): the session holds the store's multipart upload id,
the part size and every part received. Each part except the last is exactly `partSize` bytes.

## Quotas

`quota: { maxBytes?, maxFiles?, maxFileBytes? }`, or a function of the tenant. Usage (`file_usage`,
per tenant and application, compare-and-set) counts every file record and every upload in progress
(the declared size is reserved when the upload starts). A write that would exceed the quota is
refused with `QUOTA_EXCEEDED` (HTTP 413) before any byte is written.

## Retention and lifecycle

`retainUntil`: the file cannot be deleted before then (`DENIED`, reason `retention_active`); it can be
extended, never shortened. `expiresAt`: `sweep` deletes the file after then (once retention allows) and
releases its bytes when no other live file names the same storage key. Open uploads past their expiry
are aborted by `sweep`.
