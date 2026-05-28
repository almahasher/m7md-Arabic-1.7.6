import { config } from '../../config.js';

export function errorHandler(err, req, res, _next) {
  const status = Number(err.status || 500);
  const requestId = req.id || null;

  console.error(`[Error] requestId=${requestId || '—'} status=${status} ${err.stack || err.message}`);

  res.status(status).json({
    success: false,
    requestId,
    error: config.server.isProd && status === 500
      ? 'Internal server error'
      : err.message || 'Internal server error',
    ...(err.details && !config.server.isProd ? { details: err.details } : {}),
  });
}
