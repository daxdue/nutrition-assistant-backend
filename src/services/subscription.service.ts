import {
  PromoCode,
  SubscriptionInterval,
  SubscriptionPlan,
  SubscriptionStatus,
  UserSubscription,
} from '@prisma/client';
import { prisma } from '../db/client';

class SubscriptionError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function addDays(base: Date, days: number): Date {
  const result = new Date(base);
  result.setDate(result.getDate() + days);
  return result;
}

function addInterval(base: Date, interval: SubscriptionInterval): Date {
  const result = new Date(base);

  if (interval === SubscriptionInterval.MONTHLY) {
    result.setMonth(result.getMonth() + 1);
  } else {
    result.setFullYear(result.getFullYear() + 1);
  }

  return result;
}

function calculateFinalPrice(priceCents: number, discountPercent: number): number {
  if (discountPercent <= 0) return priceCents;
  const discounted = Math.round(priceCents * (1 - discountPercent / 100));
  return Math.max(0, discounted);
}

async function resolveUserIdFromTelegram(telegramUserId: bigint): Promise<string> {
  const user = await prisma.user.findUnique({ where: { telegramUserId } });

  if (!user) {
    throw new SubscriptionError('USER_NOT_FOUND', 'User not found', 404);
  }

  return user.id;
}

function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

async function validatePromoCode(
  code: string,
  planId: string
): Promise<PromoCode> {
  const normalized = normalizePromoCode(code);
  const promo = await prisma.promoCode.findUnique({ where: { code: normalized } });

  if (!promo || !promo.active) {
    throw new SubscriptionError('PROMO_INVALID', 'Promo code is invalid or inactive', 404);
  }

  const now = new Date();

  if (promo.expiresAt && promo.expiresAt.getTime() < now.getTime()) {
    throw new SubscriptionError('PROMO_EXPIRED', 'Promo code has expired', 400);
  }

  if (promo.maxRedemptions && promo.redeemedCount >= promo.maxRedemptions) {
    throw new SubscriptionError('PROMO_LIMIT', 'Promo code redemption limit reached', 400);
  }

  if (promo.planId && promo.planId !== planId) {
    throw new SubscriptionError('PROMO_NOT_APPLICABLE', 'Promo code is not valid for this plan', 400);
  }

  return promo;
}

function resolveEffectiveStatus(subscription: UserSubscription): SubscriptionStatus {
  const now = new Date();

  if (subscription.status === SubscriptionStatus.CANCELED) {
    return SubscriptionStatus.CANCELED;
  }

  if (subscription.trialEndsAt && now < subscription.trialEndsAt) {
    return SubscriptionStatus.IN_TRIAL;
  }

  if (subscription.currentPeriodEnd > now) {
    return SubscriptionStatus.ACTIVE;
  }

  return SubscriptionStatus.EXPIRED;
}

async function ensureLatestStatus(subscription: UserSubscription): Promise<SubscriptionStatus> {
  const effectiveStatus = resolveEffectiveStatus(subscription);

  if (effectiveStatus !== subscription.status) {
    await prisma.userSubscription.update({
      where: { id: subscription.id },
      data: { status: effectiveStatus },
    });
  }

  return effectiveStatus;
}

export async function getActivePlans(): Promise<SubscriptionPlan[]> {
  return prisma.subscriptionPlan.findMany({
    where: { active: true },
    orderBy: [{ priceCents: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function startSubscription(opts: {
  userId: string;
  planId: string;
  promoCode?: string;
}): Promise<
  UserSubscription & {
    plan: SubscriptionPlan;
    promoCode: PromoCode | null;
  }
> {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: opts.planId } });

  if (!plan || !plan.active) {
    throw new SubscriptionError('PLAN_NOT_AVAILABLE', 'Subscription plan is unavailable', 404);
  }

  const latestSubscription = await prisma.userSubscription.findFirst({
    where: { userId: opts.userId },
    orderBy: { startedAt: 'desc' },
  });

  if (latestSubscription) {
    const effectiveStatus = resolveEffectiveStatus(latestSubscription);

    if (effectiveStatus === SubscriptionStatus.ACTIVE || effectiveStatus === SubscriptionStatus.IN_TRIAL) {
      throw new SubscriptionError('ALREADY_SUBSCRIBED', 'User already has an active subscription', 409);
    }

    if (effectiveStatus !== latestSubscription.status) {
      await prisma.userSubscription.update({
        where: { id: latestSubscription.id },
        data: { status: effectiveStatus },
      });
    }
  }

  let appliedPromo: PromoCode | null = null;

  if (opts.promoCode) {
    appliedPromo = await validatePromoCode(opts.promoCode, plan.id);
  }

  const now = new Date();
  const trialEndsAt = plan.trialDays > 0 ? addDays(now, plan.trialDays) : null;
  const billingAnchor = trialEndsAt ?? now;
  const currentPeriodEnd = addInterval(billingAnchor, plan.interval);
  const status = plan.trialDays > 0 ? SubscriptionStatus.IN_TRIAL : SubscriptionStatus.ACTIVE;
  const discountPercent = appliedPromo?.discountPercent ?? 0;
  const finalPriceCents = calculateFinalPrice(plan.priceCents, discountPercent);

  return prisma.$transaction(async (tx) => {
    if (appliedPromo) {
      await tx.promoCode.update({
        where: { id: appliedPromo.id },
        data: { redeemedCount: { increment: 1 } },
      });
    }

    return tx.userSubscription.create({
      data: {
        userId: opts.userId,
        planId: plan.id,
        status,
        trialEndsAt,
        currentPeriodEnd,
        priceCents: plan.priceCents,
        discountPercent,
        finalPriceCents,
        promoCodeId: appliedPromo?.id ?? null,
      },
      include: { plan: true, promoCode: true },
    });
  });
}

export async function startSubscriptionForTelegram(opts: {
  telegramUserId: bigint;
  planId: string;
  promoCode?: string;
}) {
  const userId = await resolveUserIdFromTelegram(opts.telegramUserId);

  return startSubscription({
    userId,
    planId: opts.planId,
    promoCode: opts.promoCode,
  });
}

export async function getLatestSubscriptionForTelegram(telegramUserId: bigint) {
  const userId = await resolveUserIdFromTelegram(telegramUserId);

  const subscription = await prisma.userSubscription.findFirst({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    include: { plan: true, promoCode: true },
  });

  if (!subscription) {
    return null;
  }

  const status = await ensureLatestStatus(subscription);

  return {
    ...subscription,
    status,
    effectiveStatus: status,
  };
}

export function subscriptionToResponse(sub:
  (UserSubscription & { plan: SubscriptionPlan; promoCode: PromoCode | null }) | null
) {
  if (!sub) return null;

  return {
    id: sub.id,
    status: sub.status,
    startedAt: sub.startedAt,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodEnd: sub.currentPeriodEnd,
    autoRenew: sub.autoRenew,
    priceCents: sub.priceCents,
    finalPriceCents: sub.finalPriceCents,
    discountPercent: sub.discountPercent,
    plan: {
      id: sub.plan.id,
      name: sub.plan.name,
      interval: sub.plan.interval,
      priceCents: sub.plan.priceCents,
      trialDays: sub.plan.trialDays,
      description: sub.plan.description,
    },
    promoCode: sub.promoCode ? { code: sub.promoCode.code, discountPercent: sub.promoCode.discountPercent } : null,
  };
}

export { SubscriptionError };
