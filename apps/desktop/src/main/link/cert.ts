import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import selfsigned from "selfsigned";

export interface LinkCert { cert: string; key: string; sha256: string }

export const fingerprintOf = (certPem: string) =>
  new X509Certificate(certPem).fingerprint256.replace(/:/g, "").toLowerCase();

/** Self-signed TLS cert, generated once and persisted so paired phones can pin its fingerprint. */
export async function loadOrCreateCert(file: string): Promise<LinkCert> {
  if (existsSync(file)) {
    try {
      const { cert, key } = JSON.parse(readFileSync(file, "utf8"));
      return { cert, key, sha256: fingerprintOf(cert) };
    } catch { /* regenerate */ }
  }
  const pems = await selfsigned.generate([{ name: "commonName", value: "solo-desktop" }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 86_400_000),
    notAfterDate: new Date(Date.now() + 10 * 365 * 86_400_000),
  } as never);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ cert: pems.cert, key: pems.private }), { mode: 0o600 });
  return { cert: pems.cert, key: pems.private, sha256: fingerprintOf(pems.cert) };
}
