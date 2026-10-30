import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Field-level encryption at rest for the PII we must keep readable (date of birth, caller phone,
// email). AES-256-GCM with a random 96-bit IV per value. Ciphertext format:
//   enc:v1:<key id>:<iv b64>:<ciphertext+tag b64>
// The key id lets a previous key keep decrypting old rows during a rotation.

const PREFIX = "enc:v1:";

export interface FieldCipher {
  encrypt(plain: string): string;
  decrypt(value: string): string;
  isEncrypted(value: string): boolean;
}

const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

export function createFieldCipher(currentB64: string, previousB64?: string): FieldCipher {
  const current = Buffer.from(currentB64, "base64");
  if (current.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes");
  const ring = new Map<string, Buffer>([[keyId(current), current]]);
  if (previousB64) {
    const prev = Buffer.from(previousB64, "base64");
    if (prev.length !== 32) throw new Error("DATA_ENCRYPTION_KEY_PREVIOUS must be 32 bytes");
    ring.set(keyId(prev), prev);
  }
  const currentId = keyId(current);

  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", current, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
      return `${PREFIX}${currentId}:${iv.toString("base64")}:${body.toString("base64")}`;
    },
    decrypt(value) {
      if (!value.startsWith(PREFIX)) return value; // legacy plaintext row (dual-read during backfill)
      const [kid, ivB64, bodyB64] = value.slice(PREFIX.length).split(":");
      const key = ring.get(kid ?? "");
      if (!key || !ivB64 || !bodyB64) throw new Error(`cannot decrypt field: unknown key ${kid}`);
      const body = Buffer.from(bodyB64, "base64");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      d.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
    },
    isEncrypted: (value) => value.startsWith(PREFIX),
  };
}

/** Development/test fallback: a fixed key so local runs work; production config refuses to boot without a real key. */
export const DEV_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
