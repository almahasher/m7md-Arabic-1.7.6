import { config } from '../config.js';
import { getProvidersStatus } from '../services/subtitleService.js';

function statusLabel(provider) {
  if (!provider?.enabled) return 'disabled';
  return provider.configured ? 'ready' : 'missing key';
}

export function validateEnv() {
  const providers = getProvidersStatus();
  const anyReady = [providers.subdl, providers.openSubtitles, providers.subsource].some(provider => provider.configured);

  console.log('\n┌─ Startup Check ──────────────────────────────┐');
  console.log(`│  App                 ${config.app.name.slice(0, 24).padEnd(24)} │`);
  console.log(`│  Version             ${config.app.version.padEnd(24)} │`);
  console.log(`│  Redis               ${(config.cache.redisUrl ? 'enabled' : 'memory fallback').padEnd(24)} │`);
  console.log(`│  SubDL               ${statusLabel(providers.subdl).padEnd(24)} │`);
  console.log(`│  OpenSubtitles       ${statusLabel(providers.openSubtitles).padEnd(24)} │`);
  console.log(`│  SubSource           ${statusLabel(providers.subsource).padEnd(24)} │`);
  console.log(`│  DeepSeek AI         ${statusLabel(providers.ai).padEnd(24)} │`);
  console.log('└──────────────────────────────────────────────┘');

  if (!anyReady) {
    console.warn('[Startup] No subtitle providers configured. Add SUBDL_API_KEY, OPENSUBTITLES_API_KEY, or SUBSOURCE_API_KEY.');
  }

  if (config.server.isProd && config.encodingProxy.enabled && !config.encodingProxy.secret) {
    console.warn('[Startup] ENCODING_PROXY_SECRET is recommended in production to prevent forged proxy links.');
  }
}
