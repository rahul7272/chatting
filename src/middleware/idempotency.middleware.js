const logger = require('../utils/logger');
const statusCodes = require('../constants/statusCodes');

/**
 * In-memory idempotency cache for duplicate submission prevention (VikasBuilds State 3)
 * Key: userScope:idempotencyKey
 * Value: { status: 'PENDING' | 'COMPLETED', statusCode, body, createdAt, ttlMs }
 */
const idempotencyStore = new Map();
const DEFAULT_TTL_MS = 120 * 1000; // 120 seconds TTL window

// Periodically clean up expired idempotency keys
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of idempotencyStore.entries()) {
    const itemTtl = value.ttlMs || DEFAULT_TTL_MS;
    if (now - value.createdAt > itemTtl) {
      idempotencyStore.delete(key);
    }
  }
}, 60 * 1000);

// Prevent cleanup interval from blocking process termination during tests
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

/**
 * Idempotency Middleware
 * Intercepts mutating requests (POST, PUT, PATCH, DELETE) containing an `X-Idempotency-Key` or `Idempotency-Key` header.
 * - Rejects concurrent duplicates with HTTP 409 Conflict while original request is in-flight.
 * - Replays identical cached HTTP status and body if identical request was already completed within 120s.
 * - Caches completed responses without modifying application payload structures.
 */
const idempotency = (options = {}) => {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;

  return (req, res, next) => {
    // Only intercept state-mutating HTTP methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    const rawKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      return next();
    }

    const trimmedKey = rawKey.trim();
    // Scope key to user ID if authenticated to avoid cross-tenant / cross-user key collision
    const userScope = req.user ? (req.user.id || req.user._id || 'user') : 'guest';
    const storeKey = `${userScope}:${trimmedKey}`;

    const cached = idempotencyStore.get(storeKey);

    if (cached) {
      if (cached.status === 'PENDING') {
        logger.warn(`[Idempotency] Concurrent duplicate request blocked for key: ${storeKey}`);
        return res.status(statusCodes.CONFLICT || 409).json({
          success: false,
          code: 'IDEMPOTENT_REQUEST_IN_PROGRESS',
          message: 'A submission with this Idempotency-Key is currently being processed. Please wait for completion.',
        });
      }

      if (cached.status === 'COMPLETED') {
        logger.info(`[Idempotency] Replaying cached idempotent response for key: ${storeKey}`);
        res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
        return res.status(cached.statusCode).json(cached.body);
      }
    }

    // Mark as PENDING during processing
    idempotencyStore.set(storeKey, {
      status: 'PENDING',
      createdAt: Date.now(),
      ttlMs,
    });

    // Intercept res.json and res.send to capture response upon completion
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let isCaptured = false;

    const captureAndSave = (body, isJson = true) => {
      if (isCaptured) return;
      isCaptured = true;

      // Do not store server-side 5xx errors so the client can safely retry
      if (res.statusCode >= 500) {
        idempotencyStore.delete(storeKey);
        return;
      }

      let parsedBody = body;
      if (typeof body === 'string' && isJson) {
        try {
          parsedBody = JSON.parse(body);
        } catch (_) {}
      }

      idempotencyStore.set(storeKey, {
        status: 'COMPLETED',
        statusCode: res.statusCode,
        body: parsedBody,
        createdAt: Date.now(),
        ttlMs,
      });
    };

    res.json = (body) => {
      captureAndSave(body, true);
      return originalJson(body);
    };

    res.send = (body) => {
      captureAndSave(body, false);
      return originalSend(body);
    };

    // If client connection closes before response finishes, release pending lock
    res.on('close', () => {
      const entry = idempotencyStore.get(storeKey);
      if (entry && entry.status === 'PENDING') {
        idempotencyStore.delete(storeKey);
      }
    });

    next();
  };
};

module.exports = {
  idempotency,
  idempotencyStore,
};
