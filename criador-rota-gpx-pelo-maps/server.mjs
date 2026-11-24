#!/usr/bin/env node
/**
 * rota-gpx-riq — servidor local (Node 22, ESM, zero dependências npm).
 *
 * Responsabilidades:
 *  - Servir os estáticos do app (index.html, css/, js/, assets/).
 *  - Proxy com CORS para APIs públicas, evitando problemas de CORS/rate-limit no browser:
 *      GET  /api/health
 *      GET  /api/expand?url=...
 *      POST /api/route
 *      GET  /api/geocode?q=...
 *      GET  /api/elevation?points=lat,lng;lat,lng
 *
 * Uso: npm start   (PORT=5178 por padrão)
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PORT = 5178;
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

const USER_AGENT = 'rota-gpx-riq/1.0 (contato: riq.ia.br)';

const EXPAND_TIMEOUT_MS = 8000;
const EXPAND_MAX_REDIRECTS = 5;
const EXPAND_MAX_HTML_BYTES = 1024 * 1024;

const ROUTE_TIMEOUT_MS = 12000;
const VALHALLA_TIMEOUT_MS = 15000;
const BROUTER_TIMEOUT_MS = 30000;
const GEOCODE_TIMEOUT_MS = 12000;
const ELEVATION_TIMEOUT_MS = 15000;

const ROUTE_RATE_LIMIT = 30; // requisições
const ROUTE_RATE_WINDOW_MS = 60_000; // por minuto, por IP

/**
 * Base URLs das APIs públicas. Cada uma pode ser sobrescrita por variável de
 * ambiente — é assim que a suíte de testes aponta para um servidor local de
 * fixtures, sem tocar na rede de terceiros.
 */
function envUrl(name, fallback) {
  const env = typeof process !== 'undefined' ? process.env || {} : {};
  const value = env[name];
  return value && String(value).trim() ? String(value).trim().replace(/[/]+$/, '') : fallback;
}

const DEFAULT_ENDPOINTS = {
  osrm: 'https://router.project-osrm.org/route/v1',
  valhalla: 'https://valhalla1.openstreetmap.de/route',
  brouter: 'https://brouter.de/brouter',
  nominatim: 'https://nominatim.openstreetmap.org/search',
  elevation: 'https://api.open-meteo.com/v1/elevation',
};

function endpointsFromEnv() {
  return {
    osrm: envUrl('OSRM_BASE_URL', DEFAULT_ENDPOINTS.osrm),
    valhalla: envUrl('VALHALLA_BASE_URL', DEFAULT_ENDPOINTS.valhalla),
    brouter: envUrl('BROUTER_BASE_URL', DEFAULT_ENDPOINTS.brouter),
    nominatim: envUrl('NOMINATIM_BASE_URL', DEFAULT_ENDPOINTS.nominatim),
    elevation: envUrl('ELEVATION_BASE_URL', DEFAULT_ENDPOINTS.elevation),
  };
}

/**
 * Configuração efetiva de uma instância do servidor. createServer() aceita
 * overrides por opção (usado nos testes) e, por padrão, lê as variáveis
 * OSRM_BASE_URL / VALHALLA_BASE_URL / BROUTER_BASE_URL / NOMINATIM_BASE_URL /
 * ELEVATION_BASE_URL, além de um fetchImpl injetável.
 */
function resolveConfig(options = {}) {
  const envEndpoints = endpointsFromEnv();
  const endpoints = Object.assign({}, envEndpoints, options.endpoints || {});
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const nominatimIsCustom = endpoints.nominatim !== DEFAULT_ENDPOINTS.nominatim;
  return {
    endpoints: endpoints,
    fetchImpl: fetchImpl,
    nominatimMinIntervalMs:
      options.nominatimMinIntervalMs !== undefined ? options.nominatimMinIntervalMs : nominatimIsCustom ? 0 : 1000,
    routeRateLimit: options.routeRateLimit !== undefined ? options.routeRateLimit : ROUTE_RATE_LIMIT,
    routeRateWindowMs: options.routeRateWindowMs !== undefined ? options.routeRateWindowMs : ROUTE_RATE_WINDOW_MS,
  };
}

// O demo público do OSRM tem APENAS o perfil de carro: pedir "cycling"/"walking"
// devolve 200 com a mesma rota de carro. Por isso o OSRM só é usado em driving.
const OSRM_PROFILES = { driving: 'driving', transit: 'driving' };
const VALHALLA_COSTING = { driving: 'auto', bicycling: 'bicycle', walking: 'pedestrian', transit: 'auto', cycling: 'bicycle' };
const BROUTER_PROFILES = { driving: 'car-fast', bicycling: 'trekking', walking: 'hiking-mountain', transit: 'car-fast' };
const VALHALLA_MAX_DISTANCE_M = 150_000; // limite público do Valhalla p/ bike e pedestrian
const PUBLIC_PROFILES = new Set(['driving', 'bicycling', 'walking']);

const ALLOWED_EXPAND_HOSTS = new Set(['goo.gl', 'g.co', 'google.com', 'www.google.com', 'maps.google.com']);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, message, errorType, headers) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorType = errorType || 'error';
    this.headers = headers || null;
  }
}

class LruCache {
  constructor(max = 200, ttlMs = 600_000) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

function createCaches() {
  return {
    route: new LruCache(200, 10 * 60_000),
    geocode: new LruCache(200, 10 * 60_000),
    elevation: new LruCache(100, 10 * 60_000),
  };
}

/** Rate limit por instância de servidor (buckets isolados entre testes). */
function createRateLimiter() {
  const buckets = new Map();
  return function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (now >= v.resetAt) buckets.delete(k);
      }
    }
    if (bucket.count > limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    return { allowed: true, remaining: Math.max(0, limit - bucket.count) };
  };
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconhecido';
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text) {
  if (res.headersSent) return;
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new ApiError(413, 'Corpo da requisição muito grande (limite: 1 MB).', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!failed) {
        failed = true;
        reject(new ApiError(400, 'Falha ao ler a requisição.', 'bad_request'));
      }
    });
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) throw new ApiError(400, 'Corpo JSON obrigatório.', 'missing_body');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('não é objeto');
    }
    return parsed;
  } catch {
    throw new ApiError(400, 'JSON inválido no corpo da requisição.', 'invalid_json');
  }
}

/* ------------------------------------------------------------------ */
/* Requisições externas                                                */
/* ------------------------------------------------------------------ */

async function fetchJson(url, { timeoutMs = 12000, method = 'GET', body, headers, fetchImpl = globalThis.fetch } = {}) {
  const init = {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = body;
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status + ' em ' + (typeof url === 'string' ? url : url.href));
    error.status = response.status;
    error.retryAfter = response.headers?.get?.('retry-after') || null;
    throw error;
  }
  return response.json();
}

function upstreamError(message) {
  return new ApiError(502, message, 'upstream_error');
}

/* ------------------------------------------------------------------ */
/* /api/health                                                         */
/* ------------------------------------------------------------------ */

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    uptime: round(process.uptime(), 1),
  });
}

/* ------------------------------------------------------------------ */
/* /api/expand                                                         */
/* ------------------------------------------------------------------ */

function isAllowedGoogleHost(hostname) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (ALLOWED_EXPAND_HOSTS.has(host)) return true;
  // Subdomínios dos encurtadores (ex.: maps.app.goo.gl, www.goo.gl).
  if (host.endsWith('.goo.gl') || host.endsWith('.g.co')) return true;
  // Subdomínios de google.<tld> (ex.: maps.google.com.br, www.google.co.uk).
  return /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
}

/**
 * Proteção SSRF: o servidor roda na máquina do usuário, então mesmo dentro da
 * allowlist do Google recusamos IPs literais privados/loopback/link-local e
 * nomes internos (localhost, *.local, *.internal, *.lan).
 */
function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home')) {
    return true;
  }

  // IPv6
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 (ULA)
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 (link-local)
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped) return isPrivateOrLocalHost(mapped[1]);
    return false;
  }

  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function assertSafeExpandHost(hostname) {
  if (isPrivateOrLocalHost(hostname)) {
    throw new ApiError(400, 'Endereço local/privado não é permitido.', 'host_not_allowed');
  }
  if (!isAllowedGoogleHost(hostname)) {
    throw new ApiError(
      400,
      'Host não permitido: ' + hostname + '. Use links do Google Maps (google.com, goo.gl, maps.app.goo.gl, g.co).',
      'host_not_allowed',
    );
  }
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Marcadores ESPECÍFICOS do lugar/marcador. De propósito, NÃO usamos o centro do
// mapa nem arrays genéricos de viewport: em links /maps/dir/... o Google devolve a
// posição padrão da sessão (ex.: São Paulo), o que inventaria coordenadas erradas.
const PLACE_COORD_PATTERNS = [
  /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
  /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
  /[?&]ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
  /[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
  /center=(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/i,
];

function extractFromText(text) {
  if (!text) return {};
  const patterns = PLACE_COORD_PATTERNS;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (validCoords(lat, lng)) return { lat, lng };
  }
  return {};
}

function placeNameFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const match = /\/place\/([^/@?]+)/.exec(parsed.pathname + '/');
    if (match && match[1]) {
      const name = decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
      if (name) return name;
    }
    const q = parsed.searchParams.get('q');
    if (q && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(q) && !/^https?:/i.test(q)) {
      return q.trim() || undefined;
    }
  } catch {
    /* ignora */
  }
  return undefined;
}

function placeNameFromHtml(html) {
  if (!html) return undefined;
  const candidates = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) candidates.push(title[1]);
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og) candidates.push(og[1]);
  const ogAlt = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
  if (ogAlt) candidates.push(ogAlt[1]);
  for (let name of candidates) {
    name = decodeHtmlEntities(name).replace(/\s+/g, ' ').trim();
    name = name.replace(/\s*[-–—|·]\s*Google\s*Maps.*$/i, '').trim();
    if (name && !/^google maps$/i.test(name)) return name;
  }
  return undefined;
}

async function readLimitedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const slice = value.byteLength > maxBytes - total ? value.subarray(0, maxBytes - total) : value;
      chunks.push(Buffer.from(slice));
      total += slice.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignora */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function expandUrl(inputUrl) {
  let current;
  try {
    current = new URL(String(inputUrl).trim());
  } catch {
    throw new ApiError(400, 'URL inválida.', 'invalid_url');
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    throw new ApiError(400, 'A URL precisa começar com http:// ou https://.', 'invalid_url');
  }
  assertSafeExpandHost(current.hostname);

  const quick = extractFromText(current.href);
  const quickName = placeNameFromUrl(current.href);
  if (quick.lat !== undefined) {
    return { ok: true, finalUrl: current.href, lat: quick.lat, lng: quick.lng, placeName: quickName, source: 'url' };
  }

  const signal = AbortSignal.timeout(EXPAND_TIMEOUT_MS);
  let finalUrl = current.href;
  let html = '';

  for (let hop = 0; hop <= EXPAND_MAX_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetch(current.href, {
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ApiError(
        504,
        timedOut ? 'O Google Maps demorou demais para responder. Tente novamente.' : 'Não foi possível acessar o link agora. Tente novamente.',
        timedOut ? 'expand_timeout' : 'expand_failed',
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      try {
        await response.body?.cancel();
      } catch {
        /* ignora */
      }
      if (!location) break;
      let next;
      try {
        next = new URL(location, current);
      } catch {
        break;
      }
      assertSafeExpandHost(next.hostname);
      finalUrl = next.href;
      current = next;
      continue;
    }

    if (response.ok) {
      try {
        html = await readLimitedText(response, EXPAND_MAX_HTML_BYTES);
      } catch {
        html = '';
      }
    } else {
      try {
        await response.body?.cancel();
      } catch {
        /* ignora */
      }
    }
    finalUrl = current.href;
    break;
  }

  const fromUrl = extractFromText(finalUrl);
  // O HTML só é consultado quando a URL final é de um LUGAR/marcador. Para
  // /maps/dir/... e /maps/search/... o HTML traz o viewport da sessão, que não é
  // o ponto do usuário — extrair dali inventaria coordenadas.
  const isPlaceLikeUrl = /\/maps\/place\//i.test(finalUrl) || /\/maps\/\?/.test(finalUrl) || finalUrl.includes('!3d');
  const fromHtml = fromUrl.lat === undefined && isPlaceLikeUrl ? extractFromText(html) : {};
  const coords = fromUrl.lat !== undefined ? fromUrl : fromHtml;
  const placeName = placeNameFromHtml(html) || placeNameFromUrl(finalUrl);

  const result = { ok: true, finalUrl, source: coords.lat !== undefined ? (fromUrl.lat !== undefined ? 'url' : 'html') : 'none' };
  if (coords.lat !== undefined) {
    result.lat = coords.lat;
    result.lng = coords.lng;
  }
  if (placeName) result.placeName = placeName;
  return result;
}

async function handleExpand(req, res, url) {
  const raw = url.searchParams.get('url');
  if (!raw || !raw.trim()) throw new ApiError(400, 'Parâmetro "url" é obrigatório.', 'missing_url');
  const result = await expandUrl(raw);
  sendJson(res, 200, result, CORS_HEADERS);
}

/* ------------------------------------------------------------------ */
/* /api/route                                                          */
/* ------------------------------------------------------------------ */

function normalizeRoutePoints(rawPoints) {
  if (!Array.isArray(rawPoints)) throw new ApiError(400, 'Campo "points" deve ser um array.', 'invalid_points');
  if (rawPoints.length < 2) throw new ApiError(400, 'Informe ao menos 2 pontos para calcular a rota.', 'invalid_points');
  if (rawPoints.length > 200) throw new ApiError(400, 'No máximo 200 pontos por rota.', 'invalid_points');
  return rawPoints.map((point, index) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!validCoords(lat, lng)) {
      throw new ApiError(400, 'Ponto ' + (index + 1) + ' inválido: lat/lng fora do intervalo.', 'invalid_points');
    }
    return { lat, lng };
  });
}

function formatSummary(distanceKm, durationMin) {
  return round(distanceKm, 1) + ' km · ' + round(durationMin, 1) + ' min';
}

function decodePolyline(encoded, precision = 6) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

async function osrmRoute(points, profile, alternatives, config) {
  const osrmProfile = OSRM_PROFILES[profile] || 'driving';
  const coordinates = points.map((point) => point.lng + ',' + point.lat).join(';');
  const requestUrl = new URL(config.endpoints.osrm + '/' + osrmProfile + '/' + coordinates);
  requestUrl.searchParams.set('overview', 'full');
  requestUrl.searchParams.set('geometries', 'geojson');
  requestUrl.searchParams.set('steps', 'false');
  requestUrl.searchParams.set('alternatives', alternatives > 0 ? 'true' : 'false');

  const data = await fetchJson(requestUrl, { timeoutMs: ROUTE_TIMEOUT_MS, fetchImpl: config.fetchImpl });
  if (data.code !== 'Ok' || !Array.isArray(data.routes) || data.routes.length === 0) {
    throw new Error('OSRM não retornou rotas (code: ' + String(data.code) + ')');
  }

  const maxRoutes = Math.max(1, Math.min(data.routes.length, alternatives > 0 ? alternatives + 1 : 1));
  const routes = data.routes.slice(0, maxRoutes).map((route, index) => {
    const distanceKm = round((route.distance || 0) / 1000, 1);
    const durationMin = round((route.duration || 0) / 60, 1);
    const coordinatesList = route.geometry?.coordinates || [];
    return {
      index,
      summary: formatSummary(distanceKm, durationMin),
      distanceKm,
      durationMin,
      points: coordinatesList.map(([lng, lat]) => ({ lat, lng })),
    };
  });
  return { source: 'osrm', routes };
}

async function valhallaRoute(points, profile, config) {
  const body = JSON.stringify({
    locations: points.map((point) => ({ lat: point.lat, lon: point.lng })),
    costing: VALHALLA_COSTING[profile] || 'auto',
    directions_options: { units: 'kilometers' },
  });

  let response;
  try {
    response = await config.fetchImpl(config.endpoints.valhalla, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(VALHALLA_TIMEOUT_MS),
    });
  } catch (error) {
    throw upstreamError('Valhalla não respondeu.');
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      /* ignora */
    }
    // 400 com error_code 154 = limite de 150 km do servidor público (bike/pe).
    const exceedsLimit =
      response.status === 400 && (/"error_code"\s*:\s*154/.test(detail) || /exceeds the max distance limit/i.test(detail));
    const error = new Error('Valhalla HTTP ' + response.status + (exceedsLimit ? ' (limite de distância)' : ''));
    error.exceedsDistanceLimit = exceedsLimit;
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const trip = data?.trip;
  if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) {
    throw new Error('Valhalla não retornou rotas');
  }
  const merged = [];
  for (const leg of trip.legs) {
    const decoded = decodePolyline(String(leg.shape || ''), 6);
    for (const point of decoded) {
      const previous = merged[merged.length - 1];
      if (previous && Math.abs(previous.lat - point.lat) < 1e-7 && Math.abs(previous.lng - point.lng) < 1e-7) continue;
      merged.push(point);
    }
  }
  if (merged.length < 2) throw new Error('Valhalla retornou geometria vazia');

  const distanceKm = round(Number(trip.summary?.length) || 0, 1);
  const durationMin = round((Number(trip.summary?.time) || 0) / 60, 1);
  return {
    source: 'valhalla',
    routes: [
      {
        index: 0,
        summary: formatSummary(distanceKm, durationMin),
        distanceKm,
        durationMin,
        points: merged,
      },
    ],
  };
}

async function brouterRoute(points, profile, config) {
  // BRouter recebe lon,lat|lon,lat e devolve GeoJSON com a geometria pronta.
  const lonlats = points.map((point) => point.lng + ',' + point.lat).join('|');
  const requestUrl = new URL(config.endpoints.brouter);
  requestUrl.searchParams.set('lonlats', lonlats);
  requestUrl.searchParams.set('profile', BROUTER_PROFILES[profile] || 'car-fast');
  requestUrl.searchParams.set('format', 'geojson');
  requestUrl.searchParams.set('alternativeidx', '0');

  let response;
  try {
    response = await config.fetchImpl(requestUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(BROUTER_TIMEOUT_MS),
    });
  } catch {
    throw upstreamError('BRouter não respondeu.');
  }
  if (!response.ok) throw upstreamError('BRouter HTTP ' + response.status);

  const data = await response.json();
  const features = Array.isArray(data?.features) ? data.features : [];
  if (features.length === 0) throw upstreamError('BRouter não retornou rotas.');

  const routes = [];
  for (const feature of features) {
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const props = feature.properties || {};
    const distanceM = Number(props['track-length']);
    const timeS = Number(props['total-time']);
    const distanceKm = round(Number.isFinite(distanceM) ? distanceM / 1000 : 0, 1);
    const durationMin = round(Number.isFinite(timeS) ? timeS / 60 : 0, 1);
    routes.push({
      index: routes.length,
      summary: formatSummary(distanceKm, durationMin),
      distanceKm,
      durationMin,
      points: coordinates.map(([lng, lat]) => ({ lat, lng })),
    });
    if (routes.length >= 5) break;
  }
  if (routes.length === 0) throw upstreamError('BRouter retornou geometria vazia.');
  return { source: 'brouter', routes };
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function approximateDistanceKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1], points[i]);
  return total;
}

/**
 * Cadeia de roteamento (espelha o desenho combinado com o time):
 *  - driving: OSRM público (com alternativas) e, se falhar, Valhalla auto.
 *  - bicycling / walking: Valhalla (o OSRM demo ignora o perfil) e, se falhar
 *    ou passar do limite público de 150 km, BRouter.
 */
async function calculateRoutes(points, profile, alternatives, config) {
  const isCar = profile === 'driving' || profile === 'transit';
  const approximateKm = approximateDistanceKm(points);
  const overValhallaLimit = approximateKm > VALHALLA_MAX_DISTANCE_M / 1000;

  if (isCar) {
    try {
      return await osrmRoute(points, profile, alternatives, config);
    } catch {
      try {
        return await valhallaRoute(points, profile, config);
      } catch {
        throw upstreamError('Não foi possível calcular a rota de carro agora (OSRM e Valhalla indisponíveis). Tente novamente em instantes.');
      }
    }
  }

  let valhallaLimitHit = false;
  if (!overValhallaLimit) {
    try {
      return await valhallaRoute(points, profile, config);
    } catch (error) {
      valhallaLimitHit = Boolean(error && error.exceedsDistanceLimit);
    }
  }

  // Fallback BRouter (sem o limite de 150 km do Valhalla público).
  try {
    return await brouterRoute(points, profile, config);
  } catch {
    /* cai no erro claro abaixo */
  }

  if (valhallaLimitHit || overValhallaLimit) {
    throw new ApiError(
      422,
      'Rota de bike/pe acima de 150 km não é suportada pelo servidor público Valhalla e o BRouter não respondeu. Reduza a distância ou use o modo carro.',
      'route_too_long',
    );
  }
  throw upstreamError('Não foi possível calcular a rota agora (Valhalla e BRouter indisponíveis). Tente novamente em instantes.');
}

async function handleRoute(req, res, config) {
  if (req.method !== 'POST') throw new ApiError(405, 'Use POST em /api/route.', 'method_not_allowed');

  const limit = config.rateLimit('route:' + clientIp(req), config.routeRateLimit, config.routeRateWindowMs);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    throw new ApiError(429, 'Muitas requisições. Aguarde ' + limit.retryAfter + 's e tente novamente.', 'rate_limited');
  }

  const body = await readJsonBody(req);
  const points = normalizeRoutePoints(body.points);

  let profile = body.profile === undefined || body.profile === null ? 'driving' : String(body.profile).toLowerCase();
  if (profile === 'cycling' || profile === 'bike' || profile === 'foot' || profile === 'pedestrian') {
    profile = profile === 'cycling' || profile === 'bike' ? 'bicycling' : 'walking';
  }
  if (!PUBLIC_PROFILES.has(profile) && profile !== 'transit') {
    throw new ApiError(400, 'Perfil inválido. Use driving, bicycling ou walking.', 'invalid_profile');
  }

  let alternatives = 0;
  if (typeof body.alternatives === 'boolean') alternatives = body.alternatives ? 3 : 0;
  else if (body.alternatives !== undefined && body.alternatives !== null) {
    alternatives = Number(body.alternatives);
    if (!Number.isFinite(alternatives) || alternatives < 0) {
      throw new ApiError(400, 'Campo "alternatives" deve ser um número >= 0.', 'invalid_alternatives');
    }
    alternatives = Math.min(Math.floor(alternatives), 3);
  }

  const cacheKey = JSON.stringify({
    p: points.map((point) => [round(point.lat, 6), round(point.lng, 6)]),
    profile,
    alternatives,
  });
  const cached = config.caches.route.get(cacheKey);
  if (cached) {
    sendJson(res, 200, cached, { ...CORS_HEADERS, 'X-Cache': 'HIT' });
    return;
  }

  const result = await calculateRoutes(points, profile, alternatives, config);
  const payload = { ok: true, profile, routes: result.routes, source: result.source };
  config.caches.route.set(cacheKey, payload);
  sendJson(res, 200, payload, { ...CORS_HEADERS, 'X-Cache': 'MISS' });
}

/* ------------------------------------------------------------------ */
/* /api/geocode                                                        */
/* ------------------------------------------------------------------ */

/** Cria a fila de 1 req/s do Nominatim (uma por instância de servidor). */
function createNominatimQueue(minIntervalMs) {
  let chain = Promise.resolve();
  let lastCall = 0;
  return function slot() {
    const run = async () => {
      const wait = minIntervalMs - (Date.now() - lastCall);
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
    };
    const scheduled = chain.then(run, run);
    chain = scheduled.catch(() => {});
    return scheduled;
  };
}

async function handleGeocode(req, res, url, config) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) throw new ApiError(400, 'Parâmetro "q" é obrigatório.', 'missing_query');
  if (query.length > 300) throw new ApiError(400, 'Consulta muito longa (máximo 300 caracteres).', 'invalid_query');

  const cacheKey = query.toLowerCase();
  const cached = config.caches.geocode.get(cacheKey);
  if (cached) {
    sendJson(res, 200, cached, { ...CORS_HEADERS, 'X-Cache': 'HIT' });
    return;
  }

  await config.nominatimSlot();

  const requestUrl = new URL(config.endpoints.nominatim);
  requestUrl.searchParams.set('format', 'jsonv2');
  requestUrl.searchParams.set('q', query);
  requestUrl.searchParams.set('limit', '5');
  requestUrl.searchParams.set('addressdetails', '0');
  requestUrl.searchParams.set('accept-language', 'pt-BR,pt,en');

  let data;
  try {
    data = await fetchJson(requestUrl, {
      timeoutMs: GEOCODE_TIMEOUT_MS,
      fetchImpl: config.fetchImpl,
      headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    });
  } catch {
    throw upstreamError('Não foi possível consultar o serviço de geocodificação agora. Tente novamente.');
  }
  if (!Array.isArray(data)) {
    throw upstreamError('Resposta inesperada do serviço de geocodificação.');
  }

  const results = data
    .map((item) => {
      const lat = Number(item?.lat);
      const lng = Number(item?.lon);
      if (!validCoords(lat, lng)) return null;
      return { lat, lng, displayName: String(item.display_name || '') };
    })
    .filter(Boolean);

  const payload = { ok: true, results };
  config.caches.geocode.set(cacheKey, payload);
  sendJson(res, 200, payload, { ...CORS_HEADERS, 'X-Cache': 'MISS' });
}

/* ------------------------------------------------------------------ */
/* /api/elevation                                                      */
/* ------------------------------------------------------------------ */

function parsePointsParam(raw) {
  if (!raw || !raw.trim()) {
    throw new ApiError(400, 'Parâmetro "points" é obrigatório no formato lat,lng;lat,lng.', 'missing_points');
  }
  const parts = raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new ApiError(400, 'Nenhum ponto informado.', 'invalid_points');
  if (parts.length > 1000) throw new ApiError(400, 'No máximo 1000 pontos por requisição de elevação.', 'invalid_points');

  return parts.map((part, index) => {
    const pieces = part.split(',');
    const lat = Number(pieces[0]);
    const lng = Number(pieces[1]);
    if (pieces.length !== 2 || !validCoords(lat, lng)) {
      throw new ApiError(400, 'Ponto ' + (index + 1) + ' inválido: use lat,lng.', 'invalid_points');
    }
    return { lat, lng };
  });
}

async function fetchElevations(points, config) {
  const elevations = [];
  for (let start = 0; start < points.length; start += 100) {
    const chunk = points.slice(start, start + 100);
    const requestUrl = new URL(config.endpoints.elevation);
    requestUrl.searchParams.set('latitude', chunk.map((point) => point.lat).join(','));
    requestUrl.searchParams.set('longitude', chunk.map((point) => point.lng).join(','));
    let data;
    try {
      data = await fetchJson(requestUrl, { timeoutMs: ELEVATION_TIMEOUT_MS, fetchImpl: config.fetchImpl });
    } catch (error) {
      // O Open-Meteo limita por minuto ("Minutely API request limit exceeded").
      // Repassar 429 + Retry-After é mais honesto que mascarar como 502.
      if (error && error.status === 429) {
        const retryAfter = Number(error.retryAfter) > 0 ? Number(error.retryAfter) : 60;
        throw new ApiError(
          429,
          'Limite de requisições do serviço de elevação atingido. Tente novamente em ' + retryAfter + 's.',
          'rate_limited',
          { 'Retry-After': String(retryAfter) },
        );
      }
      throw upstreamError('Não foi possível obter a elevação agora. Tente novamente.');
    }
    const values = data?.elevation;
    if (!Array.isArray(values) || values.length !== chunk.length) {
      throw upstreamError('Resposta inesperada do serviço de elevação.');
    }
    for (const value of values) elevations.push(Number(value));
  }
  return elevations;
}

async function handleElevation(req, res, url, config) {
  const points = parsePointsParam(url.searchParams.get('points'));
  const cacheKey = points.map((point) => round(point.lat, 5) + ',' + round(point.lng, 5)).join(';');
  const cached = config.caches.elevation.get(cacheKey);
  if (cached) {
    sendJson(res, 200, cached, { ...CORS_HEADERS, 'X-Cache': 'HIT' });
    return;
  }
  const elevations = await fetchElevations(points, config);
  const payload = { ok: true, elevations };
  config.caches.elevation.set(cacheKey, payload);
  sendJson(res, 200, payload, { ...CORS_HEADERS, 'X-Cache': 'MISS' });
}

/* ------------------------------------------------------------------ */
/* Estáticos                                                           */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, '405 · Método não permitido');
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, '400 · Requisição inválida');
    return;
  }
  if (decoded.includes('\0')) {
    sendText(res, 400, '400 · Requisição inválida');
    return;
  }

  const relative = decoded.replace(/^[/\\]+/, '');
  let target = path.resolve(ROOT, relative);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    sendText(res, 404, '404 · Não encontrado');
    return;
  }
  if (relative === 'shared/theme.js') target = path.resolve(ROOT, '../shared/theme.js');

  let statInfo;
  try {
    statInfo = await stat(target);
    if (statInfo.isDirectory()) {
      target = path.join(target, 'index.html');
      statInfo = await stat(target);
    }
  } catch {
    sendText(res, 404, '404 · Não encontrado');
    return;
  }
  if (!statInfo.isFile()) {
    sendText(res, 404, '404 · Não encontrado');
    return;
  }

  let data;
  try {
    data = await readFile(target);
  } catch {
    sendText(res, 404, '404 · Não encontrado');
    return;
  }

  const extension = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'public, max-age=60, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ------------------------------------------------------------------ */
/* Roteamento HTTP                                                     */
/* ------------------------------------------------------------------ */

function createServer(options = {}) {
  const logEnabled = options.log !== false;
  const config = resolveConfig(options);
  config.caches = createCaches();
  config.nominatimSlot = createNominatimQueue(config.nominatimMinIntervalMs);
  config.rateLimit = createRateLimiter();

  const handler = async (req, res) => {
    const startedAt = performance.now();
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      /* mantém '/' */
    }

    res.on('finish', () => {
      if (!logEnabled) return;
      const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
      console.log(req.method + ' ' + pathname + ' ' + res.statusCode + ' ' + elapsed + 'ms');
    });

    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Allow-Headers': 'Content-Type, Accept' });
          res.end();
          return;
        }
        for (const [header, value] of Object.entries(CORS_HEADERS)) res.setHeader(header, value);

        switch (url.pathname) {
          case '/api/health':
            handleHealth(req, res);
            return;
          case '/api/expand':
            await handleExpand(req, res, url);
            return;
          case '/api/route':
            await handleRoute(req, res, config);
            return;
          case '/api/geocode':
            await handleGeocode(req, res, url, config);
            return;
          case '/api/elevation':
            await handleElevation(req, res, url, config);
            return;
          default:
            throw new ApiError(404, 'Endpoint não encontrado: ' + url.pathname, 'not_found');
        }
      }

      await serveStatic(req, res, url.pathname);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(
          res,
          error.status,
          { ok: false, error: error.message, error_type: error.errorType },
          { ...CORS_HEADERS, ...(error.headers || {}) },
        );
        return;
      }
      console.error('[erro interno]', error);
      sendJson(res, 500, { ok: false, error: 'Erro interno do servidor.', error_type: 'internal_error' }, CORS_HEADERS);
    }
  };

  return http.createServer((req, res) => {
    handler(req, res);
  });
}

function startServer(port = Number(process.env.PORT) || DEFAULT_PORT) {
  const server = createServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error('Porta ' + port + ' já está em uso. Defina PORT com outra porta.');
    } else {
      console.error('Falha ao iniciar o servidor:', error);
    }
    process.exitCode = 1;
  });
  server.listen(port, () => {
    console.log('rota-gpx-riq v' + VERSION + ' — servidor em http://localhost:' + port);
  });
  return server;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) startServer();

export {
  createServer,
  startServer,
  expandUrl,
  decodePolyline,
  isAllowedGoogleHost,
  isPrivateOrLocalHost,
  resolveConfig,
  endpointsFromEnv,
  DEFAULT_ENDPOINTS,
  VERSION,
  ROOT,
};
export default createServer;
