import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';
import compression from 'compression';
import subtitlesRoute from './api/routes/subtitles.js';
import { errorHandler } from './api/middleware/errorHandler.js';
import { apiLimiter } from './api/middleware/rateLimit.js';
import { requestId } from './api/middleware/requestId.js';
import { getBreakersStatus, getProvidersStatus } from './services/subtitleService.js';
import { closeRedis, getCacheStatus } from './cache/redis.js';
import { validateEnv } from './utils/startup.js';
import { createManifest, getBaseUrl } from './utils/stremio.js';
import { config } from './config.js';

validateEnv();

const app = express();
const manifestJson = createManifest();
const manifestStr = JSON.stringify(manifestJson);
const manifestBuf = Buffer.from(manifestStr);

if (config.server.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.disable('etag');

app.use(requestId);
app.use(compression({ threshold: 1024, level: 1 }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: config.server.allowedOrigins,
  methods: ['GET', 'HEAD', 'OPTIONS'],
  credentials: false,
}));

if (!config.server.isProd) {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    skip: (req) => req.path === '/health' || req.path === '/manifest.json',
  }));
}

app.use(apiLimiter);

const homeHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${config.app.name}</title></head>
<body>
  <h1>${config.app.name}</h1>
  <p>Manifest: <a href="/manifest.json">/manifest.json</a></p>
  <p>Health: <a href="/health">/health</a></p>
</body>
</html>`;
const homeHtmlBuf = Buffer.from(homeHtml);

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Length', homeHtmlBuf.byteLength);
  res.end(homeHtmlBuf);
});

app.get('/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // لا نستخدم كاش طويل للـ manifest أثناء التطوير والتحديثات؛ Stremio والمتصفح قد يثبتان نسخة قديمة.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Length', manifestBuf.byteLength);
  res.end(manifestBuf);
});

let cachedHealthBuf = null;
let healthCacheTime = 0;

app.get('/health', (_req, res) => {
  const now = Date.now();
  if (!cachedHealthBuf || now - healthCacheTime > 5000) {
    cachedHealthBuf = Buffer.from(JSON.stringify({
      status: 'ok',
      version: config.app.version,
      uptime: process.uptime(),
      providers: getProvidersStatus(),
      cache: getCacheStatus(),
      breakers: getBreakersStatus(),
    }));
    healthCacheTime = now;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, max-age=5');
  res.setHeader('Content-Length', cachedHealthBuf.byteLength);
  res.end(cachedHealthBuf);
});

app.use(subtitlesRoute);
app.use(errorHandler);

const server = app.listen(config.server.port, () => {
  console.log(`[Server] running on port ${config.server.port} (${config.server.isProd ? 'production' : 'development'})`);
});

async function shutdown(signal) {
  console.log(`\n[Server] received ${signal} — shutting down gracefully`);

  server.close(async () => {
    await closeRedis();
    console.log('[Server] closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[Server] forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
