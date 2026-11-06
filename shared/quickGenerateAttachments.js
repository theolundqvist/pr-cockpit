// Shared by the browser and server; limits apply to decoded bytes, not base64 characters.
export const ATTACHMENT_LIMITS = Object.freeze({ count: 8, fileBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 });
export const IMAGE_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** @type {Record<string, true>} */
const TEXT_MIME_TYPES = {
  "application/json": true, "application/xml": true, "application/javascript": true,
  "application/typescript": true, "application/x-javascript": true, "application/x-sh": true,
  "application/x-shellscript": true, "application/yaml": true, "application/x-yaml": true,
  "application/toml": true, "application/sql": true, "application/graphql": true, "image/svg+xml": true,
};

/** @param {string} mimeType @returns {'image' | 'pdf' | 'text' | null} */
export function attachmentKind(mimeType) {
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (IMAGE_MIME_TYPES.includes(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || TEXT_MIME_TYPES[mime] === true || /^application\/[\w.+-]+\+(?:json|xml)$/.test(mime)) return "text";
  return null;
}

/** @type {Record<string, string[]>} */
const FILE_SIGNATURES = {
  "image/png": ["\x89PNG\r\n\x1a\n"],
  "image/jpeg": ["\xff\xd8\xff"],
  "image/gif": ["GIF87a", "GIF89a"],
  "image/webp": ["RIFF"],
};

/** @param {Uint8Array} bytes @param {string} signature @param {number} offset */
function signatureAt(bytes, signature, offset) {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index++) if (bytes[offset + index] !== signature.charCodeAt(index)) return false;
  return true;
}

/** @param {Uint8Array} bytes @param {string} mimeType */
export function hasAttachmentSignature(bytes, mimeType) {
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (mime === "application/pdf") return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
  return (FILE_SIGNATURES[mime]?.some((signature) => signatureAt(bytes, signature, 0)) ?? false)
    && (mime !== "image/webp" || signatureAt(bytes, "WEBP", 8));
}
