import { parseMapsUrl } from '../js/core/url-parser.js';

const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'www.goo.gl', 'app.goo.gl', 'g.co']);
const GOOGLE_SUFFIXES = new Set([
  'com', 'com.br', 'pt', 'es', 'fr', 'de', 'it', 'nl', 'be', 'at', 'ch', 'ca',
  'co.uk', 'ie', 'com.au', 'co.nz', 'co.jp', 'co.in', 'com.mx', 'com.ar',
  'cl', 'com.co', 'com.pe', 'com.ec', 'com.uy', 'com.py',
]);
const REDIRECT_LIMIT = 5;

export class MapsLinkError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isGoogleMapsUrl(url) {
  const host = /^(?:(?:www|maps)\.)?google\.(.+)$/.exec(url.hostname);
  return host && GOOGLE_SUFFIXES.has(host[1]) && /^\/maps(?:\/|$)/i.test(url.pathname);
}

export function checkedMapsUrl(input) {
  let url;
  try {
    const value = String(input ?? '').trim();
    if (!value || value.length > 8192) throw new Error();
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : 'https://' + value);
  } catch {
    throw new MapsLinkError(400, 'invalid_url', 'Informe um link válido do Google Maps.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new MapsLinkError(400, 'host_not_allowed', 'Use um link padrão do Google Maps.');
  }

  const short = SHORT_HOSTS.has(url.hostname);
  const path = url.hostname === 'goo.gl' || url.hostname === 'www.goo.gl'
    ? /^\/maps\/[a-z0-9_-]+\/?$/i
    : /^\/(?:maps\/)?[a-z0-9_-]+\/?$/i;
  if ((short && !path.test(url.pathname)) || (!short && !isGoogleMapsUrl(url))) {
    throw new MapsLinkError(400, 'host_not_allowed', 'Use um link de rota do Google Maps.');
  }

  url.protocol = 'https:';
  url.hash = '';
  return { url, short };
}

export async function resolveGoogleMapsLink(input, fetchImpl = globalThis.fetch) {
  let target = checkedMapsUrl(input);
  const seen = new Set();
  const signal = AbortSignal.timeout(8000);

  while (target.short) {
    if (seen.has(target.url.href) || seen.size >= REDIRECT_LIMIT) {
      throw new MapsLinkError(422, 'expand_failed', 'O link curto não abriu uma rota. Tente a URL completa.');
    }
    seen.add(target.url.href);

    let response;
    try {
      response = await fetchImpl(target.url.href, {
        redirect: 'manual',
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        },
      });
    } catch {
      throw new MapsLinkError(signal.aborted ? 504 : 502, 'expand_failed', 'O Google Maps não respondeu à consulta. Tente novamente ou cole a URL completa.');
    }

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (response.status === 404 || response.status === 410) {
      throw new MapsLinkError(404, 'invalid_link', 'O link curto do Google Maps é inválido ou expirou.');
    }
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new MapsLinkError(422, 'expand_failed', 'O link curto não redirecionou para o mapa. Abra as direções no Google Maps e cole a URL completa.');
    }
    try {
      target = checkedMapsUrl(new URL(location, target.url).href);
    } catch {
      throw new MapsLinkError(422, 'redirect_not_allowed', 'O link curto redirecionou para fora do Google Maps.');
    }
  }

  const finalUrl = target.url.href;
  const parsed = parseMapsUrl(finalUrl);
  const points = [parsed.origin, ...parsed.waypoints, parsed.destination]
    .filter(place => Number.isFinite(place?.lat) && Number.isFinite(place?.lng))
    .map(({ lat, lng }) => ({ lat, lng }));
  return { ok: true, finalUrl, pontos: points, source: points.length ? 'url' : 'none' };
}
