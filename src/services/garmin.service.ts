import { prisma } from "../db/client";
import crypto from 'crypto';
import QRCode from 'qrcode';

export const generatePairingToken = async (userId: string) => {
    try {
        if (!userId) {
            return null;
        }

        // Verify user exists
        const user = await prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            return null;
        }

        // Generate a secure random token
        const token = crypto.randomBytes(32).toString('hex');

        // Token expires in 10 minutes
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 10);

        // Invalidate any existing unused tokens for this user
        await prisma.pairingToken.updateMany({
            where: {
                userId,
                used: false,
            },
            data: {
                used: true,
            },
        });

        // Create new token
        const pairingToken = await prisma.pairingToken.create({
            data: {
                token,
                userId,
                expiresAt,
            },
        });

        return pairingToken;

    } catch (err) {
        console.error(err);
        return null;
    }
};

export const isPairingTokenValid = async (token: string) => {
    const pairingToken = await prisma.pairingToken.findUnique({
        where: { token },
        include: { user: true },
    });

    if (!pairingToken) {
        return false;
    }

    if (pairingToken.used) {
        return false;
    }

    if (new Date() > pairingToken.expiresAt) {
        return false;
    }

    return true;
};

export const generatePairingQRCode = async (deviceId: string): Promise<Buffer | null> => {
    if (!deviceId) return null;

    return QRCode.toBuffer(deviceId, {
        errorCorrectionLevel: 'M',
        type: 'png',
        width: 300,
        margin: 1,
    });
};
