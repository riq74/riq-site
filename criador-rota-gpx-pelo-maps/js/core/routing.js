/**
 * Roteamento: OSRM (carro), Valhalla (bike/pe) e BRouter (fallback).
 *
 * Modulo puro (sem DOM). No browser (apiBase = null) chama as APIs publicas
 * diretamente (todas com CORS liberado). Com apiBase, delega para
 * {apiBase}/route (servidor local, que tambem faz fallback).
 *
 * Observacao medida em producao: o OSRM demo (router.project-osrm.org) SO tem
 * o perfil de carro. Pedir /route/v1/bike/... devolve a MESMA rota de carro.
 * Por isso bike/pe usam Valhalla (polyline6) com fallback BRouter.
 *
 * @module js/core/routing.js
 */

import { buildGeoJSON, haversineKm } from "./gpx.js";

/** Endpoint publico do OSRM (perfil driving). */
export const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

/** Endpoint publico do Valhalla (bike/pe/auto). */
export const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";

/** Endpoint publico do BRouter (fallback, aceita GET). */
export const BROUTER_URL = "https://brouter.de/brouter";

/** Limite maximo de pontos de passagem enviados ao roteador. */
export const MAX_ROUTE_POINTS = 500;

/** Mapeamento de perfil interno -> parametros de cada provedor. */
export const PROFILE_MAP = {
  driving: { osrm: "driving", valhalla: "auto", brouter: "car-fast" },
  bicycling: { osrm: null, valhalla: "bicycle", brouter: "trekking" },
  walking: { osrm: null, valhalla: "pedestrian", brouter: "hiking-beta" },
};

/** Perfis aceitos pela API publica. */
export const SUPPORTED_PROFILES = ["driving", "bicycling", "walking"];

/** Distancia maxima que o Valhalla publico aceita para bike/pe (metros). */
const VALHALLA_MAX_DISTANCE_M = 150000;

/**
 * Cria o objeto de falha consumido pela UI.
 * Tem code/message e tambem toString(), entao funciona tanto como
 * result.error.code quanto como String(result.error) / "${result.error}".
 * @param {string} code
 * @param {string} message
 * @returns {{code:string,message:string,toString:()=>string}}
 */
export function routingFailure(code, message) {
  const failure = {
    code: code,
    message: message,
    toString: function () { return message; },
  };
  return failure;
}

/** Erro de roteamento com codigo estavel. */
export class RoutingError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
  }
}

/**
 * Normaliza o perfil recebido.
 * @param {string} profile
 * @returns {"driving"|"bicycling"|"walking"}
 */
export function normalizeProfile(profile) {
  const value = String(profile || "driving").trim().toLowerCase();
  if (value === "bike" || value === "cycling" || value === "bicycle") return "bicycling";
  if (value === "foot" || value === "pedestrian" || value === "walk" || value === "pe") return "walking";
  if (value === "car" || value === "drive" || value === "auto") return "driving";
  if (SUPPORTED_PROFILES.indexOf(value) >= 0) return value;
  return "driving";
}

/**
 * Reduz a lista de pontos para no maximo maxPoints, mantendo o primeiro e o
 * ultimo e distribuindo os demais uniformemente.
 *
 * @param {Array<{lat:number,lng:number}>} points
 * @param {number} [maxPoints]
 * @returns {Array<{lat:number,lng:number}>}
 */
export function reducePlaces(points, maxPoints) {
  const list = Array.isArray(points) ? points : [];
  const limit = Math.max(2, Number(maxPoints) || MAX_ROUTE_POINTS);
  if (list.length <= limit) return list.slice();

  const result = [list[0]];
  const interior = limit - 2;
  const last = list.length - 1;
  for (let i = 1; i <= interior; i += 1) {
    // Indices estritamente crescentes entre 1 e last-1.
    result.push(list[Math.round((i * last) / (interior + 1))]);
  }
  result.push(list[last]);
  return result;
}

/**
 * Decodifica uma polyline codificada (formato do Google/Valhalla).
 *
 * @param {string} encoded
 * @param {number} [precision=6] 6 para Valhalla, 5 para o padrao Google.
 * @returns {Array<{lat:number,lng:number}>}
 */
export function decodePolyline(encoded, precision) {
  const factor = Math.pow(10, Number.isFinite(precision) ? precision : 6);
  const points = [];
  const text = String(encoded || "");
  let index = 0;

  if (!text) return points;

  let lat = 0;
  let lng = 0;

  while (index < text.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = text.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < text.length);
    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      byte = text.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < text.length);
    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push({ lat: lat / factor, lng: lng / factor });
  }

  return points;
}

/**
 * Chama fetch injetado ou o global.
 * @param {Function|undefined} fetchImpl
 * @param {string} url
 * @param {object} init
 * @returns {Promise<Response>}
 */
function callFetch(fetchImpl, url, init) {
  if (typeof fetchImpl === "function") return fetchImpl(url, init);
  if (typeof globalThis.fetch !== "function") {
    return Promise.reject(new RoutingError("Ambiente sem suporte a fetch.", "unsupported"));
  }
  return globalThis.fetch(url, init);
}

/**
 * Executa com timeout + abort externo.
 * @param {(signal:AbortSignal) => Promise<any>} task
 * @param {{signal?:AbortSignal, timeoutMs?:number}} options
 * @returns {Promise<any>}
 */
export async function withTimeout(task, options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
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
      reject(new RoutingError("Tempo esgotado ao calcular a rota.", "timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (externalHandler && opts.signal) opts.signal.removeEventListener("abort", externalHandler);
  }
}

/**
 * Formata a duracao para resumo legivel.
 * @param {number} minutes
 * @returns {string}
 */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return mins + " min";
  if (mins === 0) return hours + " h";
  return hours + " h " + mins + " min";
}

/**
 * Monta o resumo textual de uma rota.
 * @param {number} distanceKm
 * @param {number} durationMin
 * @returns {string}
 */
export function buildSummary(distanceKm, durationMin) {
  const km = Number(distanceKm) || 0;
  const distanceText = km >= 10 ? km.toFixed(0) + " km" : km.toFixed(1) + " km";
  return distanceText + " - " + formatDuration(durationMin);
}

/**
 * Monta a URL do OSRM.
 * @param {Array<{lat:number,lng:number}>} points
 * @param {{alternatives?:number, overview?:string, geometries?:string}} [options]
 * @returns {string}
 */
export function buildOsrmUrl(points, options) {
  const opts = options || {};
  const overview = opts.overview || "full";
  const geometries = opts.geometries || "geojson";
  const alternatives = Math.max(0, Math.min(3, Number(opts.alternatives) || 0));
  const coordinates = points
    .map(function (point) { return Number(point.lng) + "," + Number(point.lat); })
    .join(";");
  return (
    OSRM_BASE + "/" + coordinates + "?overview=" + overview + "&geometries=" + geometries + "&alternatives=" + alternatives
  );
}

/**
 * Converte uma rota do OSRM no formato interno.
 * @param {any} route
 * @param {number} index
 * @returns {object|null}
 */
export function routeFromOsrm(route, index) {
  if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) return null;
  const points = [];
  for (const coordinate of route.geometry.coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const lng = Number(coordinate[0]);
    const lat = Number(coordinate[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push({ lat: lat, lng: lng });
  }
  if (points.length === 0) return null;
  const distanceKm = (Number(route.distance) || 0) / 1000;
  const durationMin = (Number(route.duration) || 0) / 60;
  return {
    index: index,
    summary: buildSummary(distanceKm, durationMin),
    distanceKm: distanceKm,
    durationMin: durationMin,
    points: points,
    geojson: buildGeoJSON(points),
    source: "osrm",
  };
}

/**
 * Interpreta a resposta do OSRM.
 * @param {any} payload
 * @param {number} alternatives
 * @returns {object[]}
 * @throws {RoutingError}
 */
export function routesFromOsrmPayload(payload, alternatives) {
  if (!payload || payload.code !== "Ok" || !Array.isArray(payload.routes) || payload.routes.length === 0) {
    const code = payload && payload.code ? String(payload.code) : "unknown";
    throw new RoutingError("OSRM nao retornou rota (" + code + ").", "osrm_" + code.toLowerCase());
  }
  const limit = Math.max(1, Math.min(3, (Number(alternatives) || 0) + 1));
  const routes = [];
  for (let i = 0; i < payload.routes.length && i < limit; i += 1) {
    const route = routeFromOsrm(payload.routes[i], i);
    if (route) routes.push(route);
  }
  if (routes.length === 0) throw new RoutingError("OSRM retornou geometria vazia.", "osrm_empty");
  return routes;
}

/**
 * Extrai pontos de uma resposta do Valhalla (polyline6 nas legs).
 * @param {any} payload
 * @returns {Array<{lat:number,lng:number}>}
 */
export function pointsFromValhalla(payload) {
  const trip = payload && payload.trip;
  if (!trip || !Array.isArray(trip.legs)) return [];
  const points = [];
  for (const leg of trip.legs) {
    const decoded = decodePolyline(leg && leg.shape, 6);
    const start = points.length > 0 ? 1 : 0;
    for (let i = start; i < decoded.length; i += 1) {
      // evita duplicar o ponto de juncao entre legs
      if (points.length > 0) {
        const last = points[points.length - 1];
        if (Math.abs(last.lat - decoded[i].lat) < 1e-9 && Math.abs(last.lng - decoded[i].lng) < 1e-9) continue;
      }
      points.push(decoded[i]);
    }
  }
  return points;
}

/**
 * Converte a resposta do Valhalla no formato interno.
 * @param {any} payload
 * @returns {object[]}
 * @throws {RoutingError}
 */
export function routesFromValhallaPayload(payload) {
  const trip = payload && payload.trip;
  if (!trip) {
    const message = (payload && payload.error) || "Valhalla nao retornou rota.";
    const code = payload && payload.error_code ? "valhalla_" + payload.error_code : "valhalla_error";
    throw new RoutingError(String(message), code);
  }
  const points = pointsFromValhalla(payload);
  if (points.length < 2) throw new RoutingError("Valhalla retornou geometria vazia.", "valhalla_empty");

  const summary = trip.summary || {};
  const distanceKm = Number(summary.length) || 0;
  const durationMin = (Number(summary.time) || 0) / 60;
  return [
    {
      index: 0,
      summary: buildSummary(distanceKm, durationMin),
      distanceKm: distanceKm,
      durationMin: durationMin,
      points: points,
      geojson: buildGeoJSON(points),
      source: "valhalla",
    },
  ];
}

/**
 * Converte a resposta do BRouter (GeoJSON) no formato interno.
 * @param {any} payload
 * @returns {object[]}
 * @throws {RoutingError}
 */
export function routesFromBrouterPayload(payload) {
  const feature = payload && Array.isArray(payload.features) ? payload.features[0] : null;
  const coordinates = feature && feature.geometry && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates
    : null;
  if (!coordinates || coordinates.length < 2) {
    throw new RoutingError("BRouter retornou geometria vazia.", "brouter_empty");
  }

  const points = [];
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const lng = Number(coordinate[0]);
    const lat = Number(coordinate[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const point = { lat: lat, lng: lng };
    if (coordinate.length > 2 && Number.isFinite(Number(coordinate[2]))) point.ele = Number(coordinate[2]);
    points.push(point);
  }
  if (points.length < 2) throw new RoutingError("BRouter retornou geometria invalida.", "brouter_empty");

  const properties = feature.properties || {};
  const lengthMeters = Number(properties["track-length"]);
  const durationSeconds = Number(properties["total-time"]);
  const distanceKm = Number.isFinite(lengthMeters) ? lengthMeters / 1000 : routeLengthKm(points);
  const durationMin = Number.isFinite(durationSeconds) ? durationSeconds / 60 : 0;

  return [
    {
      index: 0,
      summary: buildSummary(distanceKm, durationMin),
      distanceKm: distanceKm,
      durationMin: durationMin,
      points: points,
      geojson: buildGeoJSON(points),
      source: "brouter",
    },
  ];
}

/**
 * Comprimento aproximado de uma sequencia de pontos, em km.
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {number}
 */
export function routeLengthKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1], points[i]);
  return total;
}

/**
 * Busca rotas.
 *
 * @param {Object} options
 * @param {Array<{lat:number,lng:number}>} options.places Pontos (>= 2).
 * @param {string} [options.profile="driving"] driving|bicycling|walking.
 * @param {number} [options.alternatives=0] 0..3.
 * @param {string|null} [options.apiBase=null] Ex.: "/api" para usar o servidor local.
 * @param {Function} [options.fetchImpl] fetch injetado (testes).
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<{ok:boolean, profile:string, source?:string, routes:object[], error?:string, attempts?:string[], reducedFrom?:number}>}
 */
export async function fetchRoute(options) {
  const opts = options || {};
  const profile = normalizeProfile(opts.profile);
  const alternatives = Math.max(0, Math.min(3, Number(opts.alternatives) || 0));
  const inputPlaces = Array.isArray(opts.places) ? opts.places : [];
  const attempts = [];

  const validPoints = [];
  for (const place of inputPlaces) {
    const lat = Number(place && place.lat);
    const lng = Number(place && place.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    validPoints.push({ lat: lat, lng: lng });
  }

  if (validPoints.length < 2) {
    return {
      ok: false,
      profile: profile,
      routes: [],
      error: routingFailure(
        "not-enough-points",
        "Sao necessarios ao menos 2 pontos com coordenadas. Geocodifique os lugares antes de calcular a rota."
      ),
      attempts: attempts,
    };
  }

  const reduced = reducePlaces(validPoints, MAX_ROUTE_POINTS);
  const reducedFrom = reduced.length < validPoints.length ? validPoints.length : undefined;

  // 1) Servidor local: delega tudo para {apiBase}/route.
  const apiBase = String(opts.apiBase || "").replace(/\/+$/, "");
  if (apiBase) {
    try {
      const response = await withTimeout(function (signal) {
        return callFetch(opts.fetchImpl, apiBase + "/route", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ points: reduced, profile: profile, alternatives: alternatives }),
          signal: signal,
        });
      }, opts);

      if (!response.ok) {
        throw new RoutingError("Servidor local respondeu " + response.status + " no calculo de rota.", "backend_http");
      }
      const payload = await response.json();
      if (!payload || payload.ok === false || !Array.isArray(payload.routes) || payload.routes.length === 0) {
        throw new RoutingError((payload && payload.error) || "Servidor local nao retornou rota.", "backend_error");
      }

      const routes = payload.routes.map(function (route, index) {
        const points = Array.isArray(route.points) ? route.points.map(function (point) {
          const normalized = { lat: Number(point.lat), lng: Number(point.lng) };
          if (Number.isFinite(Number(point.ele))) normalized.ele = Number(point.ele);
          return normalized;
        }) : [];
        const distanceKm = Number(route.distanceKm);
        const durationMin = Number(route.durationMin);
        return {
          index: Number.isFinite(Number(route.index)) ? Number(route.index) : index,
          summary: route.summary || buildSummary(distanceKm, durationMin),
          distanceKm: Number.isFinite(distanceKm) ? distanceKm : routeLengthKm(points),
          durationMin: Number.isFinite(durationMin) ? durationMin : 0,
          points: points,
          geojson: route.geojson || buildGeoJSON(points),
          source: payload.source || route.source || "backend",
        };
      });

      return {
        ok: true,
        profile: payload.profile || profile,
        source: payload.source || "backend",
        routes: routes,
        attempts: attempts,
        reducedFrom: reducedFrom,
      };
    } catch (error) {
      attempts.push("servidor local: " + (error && error.message ? error.message : String(error)));
      return {
        ok: false,
        profile: profile,
        routes: [],
        error: routingFailure(
          "backend-error",
          "Nao foi possivel calcular a rota pelo servidor local. Verifique se ele esta rodando (npm start) e tente novamente."
        ),
        attempts: attempts,
        reducedFrom: reducedFrom,
      };
    }
  }

  // 2) APIs publicas direto do navegador.
  const providers = profile === "driving" ? ["osrm", "valhalla", "brouter"] : ["valhalla", "brouter"];

  for (const provider of providers) {
    try {
      if (provider === "osrm") {
        const url = buildOsrmUrl(reduced, { alternatives: alternatives });
        const response = await withTimeout(function (signal) {
          return callFetch(opts.fetchImpl, url, { method: "GET", headers: { Accept: "application/json" }, signal: signal });
        }, opts);
        if (response.status === 429) {
          throw new RoutingError("O servidor OSRM publico esta limitando requisicoes (429). Aguarde e tente de novo.", "rate_limited");
        }
        if (!response.ok) {
          throw new RoutingError("OSRM respondeu " + response.status + ".", "osrm_http");
        }
        const payload = await response.json();
        return {
          ok: true,
          profile: profile,
          source: "osrm",
          routes: routesFromOsrmPayload(payload, alternatives),
          attempts: attempts,
          reducedFrom: reducedFrom,
        };
      }

      if (provider === "valhalla") {
        const body = JSON.stringify({
          locations: reduced.map(function (point) { return { lat: point.lat, lon: point.lng }; }),
          costing: PROFILE_MAP[profile].valhalla,
          directions_options: { units: "kilometers" },
        });
        const response = await withTimeout(function (signal) {
          return callFetch(opts.fetchImpl, VALHALLA_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: body,
            signal: signal,
          });
        }, opts);

        if (!response.ok) {
          let detail = "";
          try {
            const payload = await response.json();
            detail = payload && (payload.error || payload.status_message) ? String(payload.error || payload.status_message) : "";
            if (payload && payload.error_code === 154) {
              throw new RoutingError(
                "Rota longa demais para o Valhalla publico (limite de 150 km para bike/pe). Tentando outro provedor...",
                "valhalla_distance_limit"
              );
            }
          } catch (parseError) {
            if (parseError instanceof RoutingError) throw parseError;
          }
          throw new RoutingError("Valhalla respondeu " + response.status + (detail ? ": " + detail : "."), "valhalla_http");
        }

        const payload = await response.json();
        return {
          ok: true,
          profile: profile,
          source: "valhalla",
          routes: routesFromValhallaPayload(payload),
          attempts: attempts,
          reducedFrom: reducedFrom,
        };
      }

      // provider === "brouter"
      const lonlats = reduced.map(function (point) { return point.lng + "," + point.lat; }).join("|");
      const url = BROUTER_URL + "?lonlats=" + lonlats + "&profile=" + PROFILE_MAP[profile].brouter + "&format=geojson";
      const response = await withTimeout(function (signal) {
        return callFetch(opts.fetchImpl, url, { method: "GET", headers: { Accept: "application/json" }, signal: signal });
      }, Object.assign({}, opts, { timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 45000 }));

      if (!response.ok) {
        throw new RoutingError("BRouter respondeu " + response.status + ".", "brouter_http");
      }
      const payload = await response.json();
      return {
        ok: true,
        profile: profile,
        source: "brouter",
        routes: routesFromBrouterPayload(payload),
        attempts: attempts,
        reducedFrom: reducedFrom,
      };
    } catch (error) {
      attempts.push(provider + ": " + (error && error.message ? error.message : String(error)));
      if (error && error.code === "timeout") continue;
    }
  }

  const limits = profile === "driving" ? "" : " O Valhalla publico so calcula bike/pe ate 150 km; para distancias maiores divida o trajeto em etapas.";
  const distanceLimited = attempts.some(function (item) { return item.indexOf("valhalla_distance_limit") >= 0 || item.indexOf("150000") >= 0; });
  return {
    ok: false,
    profile: profile,
    routes: [],
    error: routingFailure(
      distanceLimited ? "distance-limit" : "routing-failed",
      "Nao foi possivel calcular a rota agora. Os servicos publicos podem estar ocupados - tente novamente em instantes." + limits
    ),
    attempts: attempts,
    reducedFrom: reducedFrom,
  };
}
