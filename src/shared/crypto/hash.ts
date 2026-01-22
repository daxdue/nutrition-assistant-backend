import crypto from 'crypto';

export function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Base64Url(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function timingSafeEqualBase64Url(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    const aBuf = Buffer.from(a, 'base64url');
    const bBuf = Buffer.from(b, 'base64url');
    if (aBuf.length !== bBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}
