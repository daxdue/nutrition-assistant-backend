import { GarminPairStatus } from '@prisma/client';
import { prisma } from '../../db/client';
import { GARMIN_CLAIM_CODE_TTL_SECONDS, GARMIN_PAIR_TTL_SECONDS } from '../../config/env';
import {
  randomBase64Url,
  sha256Base64Url,
  timingSafeEqualBase64Url,
} from '../../shared/crypto/hash';
import { upsertGarminDeviceWithToken } from './garminDevice.service';

const claimCodeCache = new Map<string, { code: string; expiresAt: number }>();

function cleanupClaimCodeCache() {
  const now = Date.now();
  for (const [state, entry] of claimCodeCache.entries()) {
    if (entry.expiresAt <= now) {
      claimCodeCache.delete(state);
    }
  }
}

setInterval(cleanupClaimCodeCache, 60 * 1000);

function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

async function markSessionExpired(sessionId: string) {
  await prisma.garminPairSession.update({
    where: { id: sessionId },
    data: { status: GarminPairStatus.EXPIRED },
  });
}

function getCachedClaimCode(state: string): string | undefined {
  const entry = claimCodeCache.get(state);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    claimCodeCache.delete(state);
    return undefined;
  }
  return entry.code;
}

async function ensureClaimCode(session: {
  id: string;
  state: string;
  claimCodeHash: string | null;
  claimCodeExpiresAt: Date | null;
  claimCodeUsedAt: Date | null;
}) {
  const cached = getCachedClaimCode(session.state);
  if (cached) {
    return { code: cached, expiresAt: session.claimCodeExpiresAt ?? new Date() };
  }

  const now = Date.now();
  const hasValidCode =
    session.claimCodeHash &&
    session.claimCodeExpiresAt &&
    session.claimCodeExpiresAt.getTime() > now &&
    !session.claimCodeUsedAt;

  if (hasValidCode) {
    // No cached code available; issue a fresh one to ensure we can return the raw value.
  }

  const code = randomBase64Url(24);
  const expiresAt = new Date(now + GARMIN_CLAIM_CODE_TTL_SECONDS * 1000);

  await prisma.garminPairSession.update({
    where: { id: session.id },
    data: {
      claimCodeHash: sha256Base64Url(code),
      claimCodeExpiresAt: expiresAt,
      claimCodeUsedAt: null,
    },
  });

  claimCodeCache.set(session.state, { code, expiresAt: expiresAt.getTime() });
  return { code, expiresAt };
}

export async function createPairingSession(params: {
  deviceId: string;
  deviceName?: string | null;
}) {
  const state = randomBase64Url(32);
  const wst = randomBase64Url(32);
  const expiresAt = new Date(Date.now() + GARMIN_PAIR_TTL_SECONDS * 1000);

  await prisma.$transaction([
    prisma.garminPairSession.updateMany({
      where: {
        deviceId: params.deviceId,
        status: { in: [GarminPairStatus.PENDING, GarminPairStatus.CONFIRMED] },
      },
      data: { status: GarminPairStatus.EXPIRED },
    }),
    prisma.garminPairSession.create({
      data: {
        state,
        wstHash: sha256Base64Url(wst),
        deviceId: params.deviceId,
        deviceName: params.deviceName ?? null,
        expiresAt,
      },
    }),
  ]);

  return { state, wst, expiresAt };
}

export async function validateWebviewAuth(state: string, wst: string) {
  const session = await prisma.garminPairSession.findUnique({
    where: { state },
  });

  if (!session) {
    return { ok: false, reason: 'INVALID' as const };
  }

  if (isExpired(session.expiresAt)) {
    if (session.status !== GarminPairStatus.EXPIRED) {
      await markSessionExpired(session.id);
    }
    return { ok: false, reason: 'EXPIRED' as const };
  }

  const wstHash = sha256Base64Url(wst);
  if (!timingSafeEqualBase64Url(wstHash, session.wstHash)) {
    return { ok: false, reason: 'INVALID' as const };
  }

  return { ok: true as const };
}

export async function getPairingStatus(state: string) {
  const session = await prisma.garminPairSession.findUnique({
    where: { state },
  });

  if (!session) {
    return { status: 'EXPIRED' as const };
  }

  if (isExpired(session.expiresAt)) {
    if (session.status !== GarminPairStatus.EXPIRED) {
      await markSessionExpired(session.id);
    }
    return { status: 'EXPIRED' as const };
  }

  if (session.status === GarminPairStatus.DENIED) {
    return { status: 'DENIED' as const };
  }

  if (session.status === GarminPairStatus.CONFIRMED) {
    const { code } = await ensureClaimCode(session);
    return { status: 'CONFIRMED' as const, code };
  }

  if (session.status === GarminPairStatus.COMPLETED) {
    const code = getCachedClaimCode(session.state);
    return code ? { status: 'CONFIRMED' as const, code } : { status: 'CONFIRMED' as const };
  }

  return { status: 'PENDING' as const };
}

export async function confirmPairingSession(params: { state: string; userId: string }) {
  const session = await prisma.garminPairSession.findUnique({
    where: { state: params.state },
  });

  if (!session) {
    return { ok: false, reason: 'INVALID' as const };
  }

  if (isExpired(session.expiresAt)) {
    if (session.status !== GarminPairStatus.EXPIRED) {
      await markSessionExpired(session.id);
    }
    return { ok: false, reason: 'EXPIRED' as const };
  }

  if (session.status === GarminPairStatus.DENIED) {
    return { ok: false, reason: 'DENIED' as const };
  }

  if (session.confirmedUserId && session.confirmedUserId !== params.userId) {
    return { ok: false, reason: 'DENIED' as const };
  }

  if (
    session.status === GarminPairStatus.CONFIRMED ||
    session.status === GarminPairStatus.COMPLETED
  ) {
    return { ok: true, alreadyConfirmed: true };
  }

  await prisma.garminPairSession.update({
    where: { id: session.id },
    data: {
      status: GarminPairStatus.CONFIRMED,
      confirmedUserId: params.userId,
      confirmedAt: new Date(),
    },
  });

  return { ok: true };
}

export async function getPairingResult(state: string) {
  const session = await prisma.garminPairSession.findUnique({
    where: { state },
  });

  if (!session) {
    return { status: 'expired' as const, state };
  }

  if (isExpired(session.expiresAt)) {
    if (session.status !== GarminPairStatus.EXPIRED) {
      await markSessionExpired(session.id);
    }
    return { status: 'expired' as const, state };
  }

  if (session.status === GarminPairStatus.DENIED) {
    return { status: 'denied' as const, state };
  }

  if (
    session.status !== GarminPairStatus.CONFIRMED &&
    session.status !== GarminPairStatus.COMPLETED
  ) {
    return { status: 'pending' as const, state };
  }

  const { code } = await ensureClaimCode(session);
  return { status: 'success' as const, state, code };
}

export async function claimDeviceToken(params: {
  state: string;
  code: string;
  deviceId: string;
  deviceName?: string | null;
}) {
  const session = await prisma.garminPairSession.findUnique({
    where: { state: params.state },
  });

  if (!session) {
    return { ok: false, reason: 'INVALID' as const };
  }

  if (isExpired(session.expiresAt)) {
    if (session.status !== GarminPairStatus.EXPIRED) {
      await markSessionExpired(session.id);
    }
    return { ok: false, reason: 'EXPIRED' as const };
  }

  if (
    session.status !== GarminPairStatus.CONFIRMED ||
    !session.confirmedUserId ||
    session.deviceId !== params.deviceId
  ) {
    return { ok: false, reason: 'DENIED' as const };
  }

  if (
    !session.claimCodeHash ||
    !session.claimCodeExpiresAt ||
    session.claimCodeUsedAt ||
    session.claimCodeExpiresAt.getTime() <= Date.now()
  ) {
    return { ok: false, reason: 'EXPIRED' as const };
  }

  const codeHash = sha256Base64Url(params.code);
  if (!timingSafeEqualBase64Url(codeHash, session.claimCodeHash)) {
    return { ok: false, reason: 'DENIED' as const };
  }

  const { token } = await upsertGarminDeviceWithToken({
    userId: session.confirmedUserId,
    deviceId: session.deviceId,
    deviceName: params.deviceName ?? session.deviceName,
  });

  await prisma.garminPairSession.update({
    where: { id: session.id },
    data: {
      status: GarminPairStatus.COMPLETED,
      claimCodeUsedAt: new Date(),
      completedAt: new Date(),
    },
  });

  claimCodeCache.delete(session.state);
  return { ok: true, access_token: token };
}
