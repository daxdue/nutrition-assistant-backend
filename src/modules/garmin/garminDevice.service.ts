import crypto from 'crypto';
import { prisma } from '../../db/client';
import { randomBase64Url, sha256Base64Url } from '../../shared/crypto/hash';

const LEGACY_API_KEY_BYTES = 32;

export function generateDeviceToken(): { token: string; tokenHash: string } {
  const token = randomBase64Url(32);
  return { token, tokenHash: sha256Base64Url(token) };
}

export async function findDeviceByToken(token: string) {
  const tokenHash = sha256Base64Url(token);
  const device = await prisma.garminDevice.findUnique({
    where: { deviceTokenHash: tokenHash },
  });

  if (!device || device.tokenRevokedAt) {
    return null;
  }

  return device;
}

export async function upsertGarminDeviceWithToken(params: {
  userId: string;
  deviceId: string;
  deviceName?: string | null;
}) {
  const { token, tokenHash } = generateDeviceToken();
  const now = new Date();

  const device = await prisma.garminDevice.upsert({
    where: { deviceId: params.deviceId },
    update: {
      userId: params.userId,
      deviceName: params.deviceName ?? undefined,
      deviceTokenHash: tokenHash,
      tokenCreatedAt: now,
      tokenRevokedAt: null,
    },
    create: {
      userId: params.userId,
      deviceId: params.deviceId,
      deviceName: params.deviceName ?? null,
      apiKey: crypto.randomBytes(LEGACY_API_KEY_BYTES).toString('hex'),
      deviceTokenHash: tokenHash,
      tokenCreatedAt: now,
      tokenRevokedAt: null,
    },
  });

  return { device, token };
}
