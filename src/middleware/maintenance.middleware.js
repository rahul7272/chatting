/**
 * VikasBuilds State 23: Maintenance State Middleware
 * Intercepts requests when MAINTENANCE_MODE=true and responds with HTTP 503
 * and structured return window information.
 */
const maintenanceMiddleware = (req, res, next) => {
  // Allow healthcheck and status bypass endpoints
  if (req.path === '/api/v1/health' || req.path === '/health') {
    return next();
  }

  if (process.env.MAINTENANCE_MODE === 'true') {
    return res.status(503).json({
      success: false,
      code: 'MAINTENANCE_MODE',
      message: 'Academy servers are currently undergoing scheduled maintenance.',
      estimatedReturn: process.env.MAINTENANCE_ESTIMATED_RETURN || 'Today at 02:00 AM IST',
      supportContact: 'support@academy.com',
      retryable: true,
    });
  }

  next();
};

module.exports = maintenanceMiddleware;
