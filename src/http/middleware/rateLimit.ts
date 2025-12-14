// src/http/middleware/rateLimit.ts
import { Request, Response, NextFunction } from 'express';

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

// In-memory store for rate limiting
// TODO: For production, consider using Redis or a more robust solution
const rateLimitStore: RateLimitStore = {};

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(rateLimitStore).forEach((key) => {
    if (rateLimitStore[key].resetTime < now) {
      delete rateLimitStore[key];
    }
  });
}, 5 * 60 * 1000);

interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyGenerator?: (req: Request) => string; // Function to generate rate limit key
  message?: string; // Custom error message
}

/**
 * Rate limiting middleware
 * @param options Rate limit configuration
 */
export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = (req) => req.ip || 'unknown',
    message = 'Too many requests, please try again later',
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyGenerator(req);
    const now = Date.now();

    // Get or create rate limit entry
    let entry = rateLimitStore[key];

    if (!entry || entry.resetTime < now) {
      // Create new entry or reset expired entry
      entry = {
        count: 0,
        resetTime: now + windowMs,
      };
      rateLimitStore[key] = entry;
    }

    entry.count++;

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count).toString());
    res.setHeader('X-RateLimit-Reset', new Date(entry.resetTime).toISOString());

    if (entry.count > maxRequests) {
      res.status(429).json({
        error: message,
        retryAfter: Math.ceil((entry.resetTime - now) / 1000), // seconds
      });
      return;
    }

    next();
  };
}

/**
 * Rate limiter for Garmin device endpoints
 * Limits to 10 requests per minute per API key
 */
export function garminDeviceRateLimit() {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10, // 10 requests per minute
    keyGenerator: (req) => {
      // Rate limit by API key if available, otherwise by IP
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.substring(7).trim();
        // Use first 16 chars of API key as identifier (don't store full key)
        return `api:${apiKey.substring(0, 16)}`;
      }
      return req.ip || 'unknown';
    },
    message: 'Too many requests from this device, please try again later',
  });
}
