/**
 * Geocodificacao de locais (Photon no browser; Nominatim via proxy quando existe).
 *
 * Modulo puro (sem DOM). No browser usa Photon (CORS liberado, sem chave).
 * Com apiBase, usa {apiBase}/geocode (Nominatim no servidor, que tem User-Agent proprio).
 *
 * @module js/core/geocode.js
 */

import { parseMapsUrl } from "./url-parser.js";

/** Endpoint publico do Photon (CORS *). */
export const PHOTON_URL = "https://photon.komoot.io/api/";

/** Limite de resultados por consulta no Photon. */
const PHOTON_MAX_LIMIT = 20;

/** Erro de geocodificacao com codigo estavel para a UI. */
export class GeocodeError extends Error {
  /**
   * @param {string} message Mensagem em pt-BR pronta para o usuario.
   * @param {string} code Codigo estavel (ex.: "not_found", "network", "timeout", "short_link_requires_backend").
   */
  constructor(message, code) {
    super(message);
    this.name = "GeocodeError";
    this.code = code;
  }
}

/**
 * Chama fetch injetado ou o global (sem perder o this do globalThis).
 * @param {Function|undefined} fetchImpl
 * @param {string} url
 * @param {object} init
 * @returns {Promise<Response>}
 */
function callFetch(fetchImpl, url, init) {
  if (typeof fetchImpl === "function") return fetchImpl(url, init);
  if (typeof globalThis.fetch !== "function") {
    return Promise.reject(new GeocodeError("Navegador sem suporte a fetch.", "unsupported"));
  }
  return globalThis.fetch(url, init);
}

/**
 * Executa uma promessa com timeout e abort opcional.
 * @param {(signal: AbortSignal) => Promise<any>} task
 * @param {{signal?:AbortSignal, timeoutMs?:number}} options
 * @returns {Promise<any>}
 */
export async function withTimeout(task, options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15000;
  const controller = new AbortController();
  let timer = null;
  let externalHandler = null;

  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else {
      externalHandler = function () { controller.abort(); };
      opts.signal.addEventListener("abort", externalHandler, { once: true });
    }
  }

  const timeoutPromise = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      controller.abort();
      reject(new GeocodeError("Tempo esgotado ao consultar o servico.", "timeout"));
    }, timeoutMs);
  });

  try {
    const taskPromise = task(controller.signal);
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (externalHandler && opts.signal) opts.signal.removeEventListener("abort", externalHandler);
  }
}

/**
 * Monta um nome legivel a partir das propriedades do Photon.
 * @param {Record<string, any>} properties
 * @returns {string}
 */
export function photonDisplayName(properties) {
  const props = properties || {};
  const parts = [];
  const street = props.street
    ? String(props.street) + (props.housenumber ? ", " + props.housenumber : "")
    : props.housenumber
      ? String(props.housenumber)
      : "";
  const head = props.name || street;
  if (head) parts.push(String(head));
  if (street && props.name && props.name !== street) parts.push(street);
  for (const key of ["district", "city", "county", "state", "postcode", "country"]) {
    const value = props[key];
    if (value && parts.indexOf(String(value)) === -1) parts.push(String(value));
  }
  return parts.join(", ");
}

/**
 * Converte uma feature do Photon em Place.
 * @param {any} feature
 * @param {string} raw
 * @returns {object}
 */
export function placeFromPhotonFeature(feature, raw) {
  const geometry = feature && feature.geometry;
  const coordinates = geometry && Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
  if (!coordinates || coordinates.length < 2) return null;
  const lng = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const properties = feature.properties || {};
  return {
    raw: raw,
    name: properties.name ? String(properties.name) : photonDisplayName(properties),
    displayName: photonDisplayName(properties),
    lat: lat,
    lng: lng,
    needsGeocode: false,
    sourceHint: "photon",
    details: {
      osmType: properties.osm_type || null,
      osmId: properties.osm_id || null,
      type: properties.type || null,
      country: properties.country || null,
      countryCode: properties.countrycode || null,
      city: properties.city || null,
    },
  };
}

/**
 * Consulta o Photon.
 * @param {string} text
 * @param {{fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number, limit?:number}} [options]
 * @returns {Promise<object[]>} Lista de Places (pode ser vazia).
 */
export async function geocodeWithPhoton(text, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(PHOTON_MAX_LIMIT, Number(opts.limit) || 5));
  const url = PHOTON_URL + "?q=" + encodeURIComponent(String(text).trim()) + "&limit=" + limit;

  const response = await withTimeout(function (signal) {
    return callFetch(opts.fetchImpl, url, { method: "GET", headers: { Accept: "application/json" }, signal: signal });
  }, opts);

  if (!response.ok) {
    throw new GeocodeError("O servico de busca de enderecos respondeu com erro (" + response.status + ").", "http_error");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GeocodeError("Resposta invalida do servico de busca de enderecos.", "bad_response");
  }

  const features = payload && Array.isArray(payload.features) ? payload.features : [];
  const places = [];
  for (const feature of features) {
    const place = placeFromPhotonFeature(feature, text);
    if (place) places.push(place);
  }
  return places;
}

/**
 * Consulta o Nominatim pelo proxy do servidor local.
 * @param {string} text
 * @param {{apiBase?:string, fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number, limit?:number}} [options]
 * @returns {Promise<object[]>}
 */
export async function geocodeWithNominatim(text, options) {
  const opts = options || {};
  const apiBase = String(opts.apiBase || "").replace(/\/+$/, "");
  if (!apiBase) {
    throw new GeocodeError("Nominatim exige o servidor local (npm start).", "requires_backend");
  }
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 5));
  const url = apiBase + "/geocode?q=" + encodeURIComponent(String(text).trim()) + "&limit=" + limit;

  const response = await withTimeout(function (signal) {
    return callFetch(opts.fetchImpl, url, { method: "GET", headers: { Accept: "application/json" }, signal: signal });
  }, opts);

  if (!response.ok) {
    throw new GeocodeError("Busca de enderecos falhou no servidor local (" + response.status + ").", "http_error");
  }

  const payload = await response.json();
  if (payload && payload.ok === false) {
    throw new GeocodeError(payload.error || "Busca de enderecos falhou.", payload.error_type || "backend_error");
  }
  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  const places = [];
  for (const item of results) {
    const lat = Number(item.lat);
    const lng = Number(item.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const displayName = item.displayName || item.display_name || String(text);
    places.push({
      raw: text,
      name: displayName,
      displayName: displayName,
      lat: lat,
      lng: lng,
      needsGeocode: false,
      sourceHint: "nominatim",
    });
  }
  return places;
}

/**
 * Geocodifica um texto livre e devolve o primeiro resultado.
 *
 * Ordem dos provedores: com apiBase, Nominatim (proxy) e depois Photon;
 * sem apiBase, apenas Photon (CORS).
 *
 * @param {string} text
 * @param {{apiBase?:string|null, fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number, limit?:number}} [options]
 * @returns {Promise<object>} Place preenchido.
 * @throws {GeocodeError}
 */
export async function geocodeQuery(text, options) {
  const opts = options || {};
  const query = String(text === undefined || text === null ? "" : text).trim();
  if (!query) throw new GeocodeError("Informe um endereco ou lugar para buscar.", "empty_query");

  const providers = opts.apiBase ? ["nominatim", "photon"] : ["photon"];
  const failures = [];

  for (const provider of providers) {
    try {
      const places =
        provider === "nominatim"
          ? await geocodeWithNominatim(query, opts)
          : await geocodeWithPhoton(query, opts);
      if (places.length > 0) return places[0];
      failures.push(provider + ": nenhum resultado");
    } catch (error) {
      failures.push(provider + ": " + (error && error.message ? error.message : String(error)));
      if (error && (error.code === "timeout" || error.code === "unsupported")) break;
    }
  }

  throw new GeocodeError(
    "Nao encontramos esse lugar. Tente incluir cidade/pais ou use coordenadas (lat,lng).",
    "not_found"
  );
}

/**
 * Completa um Place com coordenadas, se ainda faltarem.
 * Places que ja tem lat/lng sao devolvidos como estao.
 *
 * @param {object} place
 * @param {{apiBase?:string|null, fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number}} [options]
 * @returns {Promise<object>}
 */
export async function geocodePlace(place, options) {
  if (!place || typeof place !== "object") {
    throw new GeocodeError("Local invalido para geocodificar.", "invalid_place");
  }
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return Object.assign({}, place, { lat: lat, lng: lng, needsGeocode: false });
  }
  const text = place.raw || place.name;
  if (!text) throw new GeocodeError("Local sem nome nem coordenadas.", "invalid_place");

  const found = await geocodeQuery(text, options);
  return Object.assign({}, found, { raw: text, sourceHint: found.sourceHint });
}

/**
 * Resolve todos os locais de um resultado de parseMapsUrl, geocodificando os
 * que ainda nao tem coordenadas (em serie, para respeitar o rate limit dos
 * servicos publicos de geocodificacao).
 *
 * Aceita opcoes de geocodificacao (apiBase, fetchImpl, signal, timeoutMs) e
 * tambem { profile } apenas para repassar nada ao resultado.
 *
 * @param {object} parsed Resultado de parseMapsUrl.
 * @param {{apiBase?:string|null, fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number}} [options]
 * @returns {Promise<{origin:object|null, destination:object|null, waypoints:object[], places:object[]}>}
 * @throws {GeocodeError} Se algum local obrigatorio nao puder ser resolvido.
 */
export async function resolvePlaces(parsed, options) {
  const data = parsed || {};
  const opts = options || {};

  if (data.kind === "short") {
    throw new GeocodeError(
      "Este e um link curto do Google Maps. Expanda-o primeiro com resolveShortLink (requer o servidor local).",
      "short-link-needs-proxy"
    );
  }
  if (data.ok === false) {
    throw new GeocodeError(
      "O link informado nao descreve uma rota valida do Google Maps.",
      data.reason || "invalid_url"
    );
  }

  const origin = data.origin ? await geocodePlace(data.origin, opts) : null;

  const waypoints = [];
  const rawWaypoints = Array.isArray(data.waypoints) ? data.waypoints : [];
  for (const waypoint of rawWaypoints) {
    waypoints.push(await geocodePlace(waypoint, opts));
  }

  let destination = null;
  if (data.destination) {
    destination = await geocodePlace(data.destination, opts);
  }

  const places = [];
  if (origin) places.push(origin);
  for (const waypoint of waypoints) places.push(waypoint);
  if (destination) places.push(destination);

  return { origin: origin, destination: destination, waypoints: waypoints, places: places };
}

/**
 * Resolve um link curto do Google Maps (goo.gl, maps.app.goo.gl).
 *
 * No browser o redirecionamento e bloqueado por CORS: e necessario o proxy
 * do servidor local (apiBase, ex.: "/api"). No Node, se nenhum apiBase for
 * informado, tenta seguir o redirect diretamente.
 *
 * @param {string} url
 * @param {{apiBase?:string|null, fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number}} [options]
 * @returns {Promise<{finalUrl:string, parsed:object}>}
 */
export async function resolveShortLink(url, options) {
  const opts = options || {};
  const input = String(url || "").trim();
  if (!input) throw new GeocodeError("Informe o link curto do Google Maps.", "invalid_url");

  const apiBase = String(opts.apiBase || "").replace(/\/+$/, "");
  const parsedInput = parseMapsUrl(input);
  if (parsedInput.ok && parsedInput.kind !== "short") {
    // Nao e link curto: nada a expandir.
    return { finalUrl: parsedInput.normalizedUrl || input, parsed: parsedInput };
  }

  if (!apiBase) {
    // Sem proxy nao ha como seguir o redirect do Google (CORS bloqueia o navegador).
    // Isso vale tambem no Node, para o comportamento ser deterministico.
    if (opts.allowDirect !== true) {
      throw new GeocodeError(
        "Links curtos do Google Maps precisam do servidor local para serem expandidos. Rode npm start e tente novamente.",
        "short-link-needs-proxy"
      );
    }
    try {
      const response = await withTimeout(function (signal) {
        return callFetch(opts.fetchImpl, input, { method: "GET", redirect: "follow", signal: signal });
      }, opts);
      const finalUrl = response && response.url ? String(response.url) : input;
      if (!finalUrl || finalUrl === input) {
        throw new GeocodeError("O link curto nao redirecionou para uma URL do Google Maps.", "expand_failed");
      }
      const parsed = parseMapsUrl(finalUrl);
      return { finalUrl: finalUrl, parsed: parsed };
    } catch (error) {
      if (error instanceof GeocodeError) throw error;
      throw new GeocodeError(
        "Nao foi possivel expandir o link curto agora. Tente novamente em instantes.",
        "expand_failed"
      );
    }
  }

  const expandUrl = apiBase + "/expand?url=" + encodeURIComponent(parsedInput.normalizedUrl || input);
  const response = await withTimeout(function (signal) {
    return callFetch(opts.fetchImpl, expandUrl, { method: "GET", headers: { Accept: "application/json" }, signal: signal });
  }, opts);

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new GeocodeError(payload?.error || "Não foi possível expandir o link curto.", payload?.error_type || "http_error");
    error.status = response.status;
    throw error;
  }
  if (payload && payload.ok === false) {
    throw new GeocodeError(payload.error || "Nao foi possivel expandir o link curto.", payload.error_type || "expand_failed");
  }

  const finalUrl = payload && payload.finalUrl ? String(payload.finalUrl) : "";
  if (!finalUrl) throw new GeocodeError("O servidor nao devolveu a URL final do link.", "expand_failed");

  const parsed = parseMapsUrl(finalUrl);
  if (!parsed.ok && payload.placeName) {
    parsed.ok = true;
    parsed.kind = "place";
    parsed.origin = { raw: payload.placeName, name: payload.placeName, needsGeocode: true, sourceHint: "short" };
  }

  // O servidor so devolve lat/lng de paginas de LUGAR (nunca de direcoes).
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && parsed.origin && parsed.origin.needsGeocode) {
    parsed.origin.lat = lat;
    parsed.origin.lng = lng;
    parsed.origin.needsGeocode = false;
    parsed.origin.sourceHint = "expand";
  }

  return { finalUrl: finalUrl, parsed: parsed };
}
