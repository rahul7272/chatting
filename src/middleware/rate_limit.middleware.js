const rateLimit = require('express-rate-limit');

/**
 * VikasBuilds State 29: Too Many Requests (Rate Limiting) Middleware
 * Standardized rate limiting using express-rate-limit, emitting HTTP 429
 * with Retry-After header and structured JSON body.
 */
const createLimiter = (options = {}) => {
  return rateLimit({
    windowMs: options.windowMs || 60 * 1000, // 1 minute default
    max: options.max || 60, // Limit each IP to 60 requests per window
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: true, // Return `X-RateLimit-*` headers
    handler: (req, res) => {
      const retryAfter = Math.ceil((options.windowMs || 60000) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        success: false,
        code: 'TOO_MANY_REQUESTS',
        message: options.message || 'Too many requests. Please wait before retrying.',
        retryAfter,
      });
    },
    ...options,
  });
};

// 1. Strict rate limiter for Authentication & OTP routes (5 requests per minute)
const authLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many authentication attempts. Please wait 60 seconds before trying again.',
});

// 2. Message sending rate limiter (30 messages per minute to prevent chat flooding)
const messageLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Message sending rate limit exceeded. Please wait a moment before sending more messages.',
});

// 3. General API limiter (120 requests per minute)
const apiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'API rate limit exceeded. Please slow down your requests.',
});

module.exports = {
  createLimiter,
  authLimiter,
  messageLimiter,
  apiLimiter,
};
