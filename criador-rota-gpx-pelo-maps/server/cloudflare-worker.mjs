import { checkedMapsUrl, MapsLinkError, resolveGoogleMapsLink } from './maps-resolver.mjs';

const SITE_ORIGINS = new Set(['https://riq.ia.br', 'https://www.riq.ia.br', 'https://riq74.github.io']);
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const json = (data, status = 200) => Response.json(data, { status, headers });
    const fail = (status, error_type, error) => json({ ok: false, error_type, error }, status);
    if (origin && !SITE_ORIGINS.has(origin) && !LOCAL_ORIGIN.test(origin)) {
      return fail(403, 'origin_not_allowed', 'Origem não autorizada.');
    }
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Expose-Headers', 'Retry-After, X-RateLimit-Remaining');
    }

    if (!['/api/health', '/api/expand'].includes(url.pathname)) {
      return fail(404, 'not_found', 'Endpoint não encontrado.');
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') {
      headers.set('Allow', 'GET, OPTIONS');
      return fail(405, 'method_not_allowed', 'Use uma requisição GET.');
    }
    if (url.pathname === '/api/health') return json({ ok: true });

    const input = url.searchParams.get('url');
    try {
      const target = checkedMapsUrl(input);
      const ip = request.headers.get('CF-Connecting-IP');
      if (!ip) return fail(503, 'client_ip_unavailable', 'Não foi possível identificar o IP da conexão.');
      const quota = await env.DAILY_QUOTA.getByName(ip).take();
      headers.set('X-RateLimit-Remaining', String(quota.remaining));
      if (!quota.allowed) {
        headers.set('Retry-After', String(Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1000))));
        return fail(429, 'daily_quota', 'Limite de 20 consultas por IP atingido. Tente novamente após a virada do dia UTC ou cole o link completo.');
      }
      return json(await resolveGoogleMapsLink(target.url.href));
    } catch (error) {
      if (error instanceof MapsLinkError) return fail(error.status, error.code, error.message);
      return fail(503, 'service_unavailable', 'O resolvedor está temporariamente indisponível. Tente novamente ou cole a URL completa.');
    }
  },
};

export { DailyQuota } from './daily-quota.mjs';
