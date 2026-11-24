/**
 * Geracao de GPX 1.1 e utilitarios de geometria.
 *
 * Modulo puro: sem DOM, sem dependencias npm. Importavel no browser e no Node 22.
 *
 * @module js/core/gpx.js
 */

/** Namespace oficial do GPX 1.1. */
export const GPX_NS = "http://www.topografix.com/GPX/1/1";

/** Creator padrao gravado no arquivo. */
export const DEFAULT_CREATOR = "RIQ Rota GPX - riq.site";

const EARTH_RADIUS_KM = 6371.0088;

/**
 * Escapa texto para XML 1.0 e remove caracteres de controle invalidos.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  if (value === null || value === undefined) return "";
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  return String(value)
    .replace(/[&<>"']/g, function (char) { return map[char]; })
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

/**
 * Converte coordenada em texto estavel (7 casas, sem zeros sobrando).
 * @param {number} value
 * @returns {string}
 */
function formatCoordinate(value) {
  const text = Number(value).toFixed(7);
  return text.indexOf(".") >= 0 ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/**
 * Converte altitude em texto estavel (1 casa, sem ".0").
 * @param {number} value
 * @returns {string}
 */
function formatElevation(value) {
  return Number(value).toFixed(1).replace(/\.0$/, "");
}

/**
 * Valida e normaliza uma lista de pontos.
 * @param {Array<object>} points
 * @returns {Array<{lat:number,lng:number,ele:number|null}>}
 */
export function normalizePoints(points) {
  if (!Array.isArray(points)) return [];
  const result = [];
  for (const point of points) {
    if (!point || typeof point !== "object") continue;
    const lat = Number(point.lat);
    const lng = Number(point.lng !== undefined ? point.lng : point.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const rawEle = point.ele !== undefined ? point.ele : point.elevation;
    const ele = rawEle === undefined || rawEle === null ? NaN : Number(rawEle);
    result.push({ lat: lat, lng: lng, ele: Number.isFinite(ele) ? ele : null });
  }
  return result;
}

/**
 * Distancia haversine entre dois pontos, em quilometros.
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number}
 */
export function haversineKm(a, b) {
  const lat1 = (Number(a.lat) * Math.PI) / 180;
  const lat2 = (Number(b.lat) * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((Number(b.lng) - Number(a.lng)) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Estatisticas de uma geometria de rota.
 *
 * @param {Array<{lat:number,lng:number,ele?:number}>} points
 * @returns {{
 *   distanceKm:number,
 *   pointCount:number,
 *   hasElevation:boolean,
 *   ascentM:number|null,
 *   descentM:number|null,
 *   minElevation:number|null,
 *   maxElevation:number|null,
 *   bounds:{minLat:number,minLng:number,maxLat:number,maxLng:number}|null
 * }}
 */
export function routeStats(points) {
  const normalized = normalizePoints(points);
  if (normalized.length === 0) {
    return {
      distanceKm: 0,
      pointCount: 0,
      hasElevation: false,
      ascentM: null,
      descentM: null,
      minElevation: null,
      maxElevation: null,
      bounds: null,
    };
  }

  let distanceKm = 0;
  const bounds = {
    minLat: normalized[0].lat,
    minLng: normalized[0].lng,
    maxLat: normalized[0].lat,
    maxLng: normalized[0].lng,
  };
  for (let i = 0; i < normalized.length; i += 1) {
    const point = normalized[i];
    bounds.minLat = Math.min(bounds.minLat, point.lat);
    bounds.maxLat = Math.max(bounds.maxLat, point.lat);
    bounds.minLng = Math.min(bounds.minLng, point.lng);
    bounds.maxLng = Math.max(bounds.maxLng, point.lng);
    if (i > 0) distanceKm += haversineKm(normalized[i - 1], point);
  }

  const elevations = [];
  for (const point of normalized) {
    if (point.ele !== null) elevations.push(point.ele);
  }

  let ascentM = null;
  let descentM = null;
  if (elevations.length > 0) {
    ascentM = 0;
    descentM = 0;
    for (let i = 1; i < elevations.length; i += 1) {
      const delta = elevations[i] - elevations[i - 1];
      if (delta > 0) ascentM += delta;
      else descentM += -delta;
    }
    ascentM = Math.round(ascentM);
    descentM = Math.round(descentM);
  }

  return {
    distanceKm: distanceKm,
    pointCount: normalized.length,
    hasElevation: elevations.length > 0,
    ascentM: ascentM,
    descentM: descentM,
    minElevation: elevations.length > 0 ? Math.min.apply(null, elevations) : null,
    maxElevation: elevations.length > 0 ? Math.max.apply(null, elevations) : null,
    bounds: bounds,
  };
}

/**
 * Valida waypoints adicionais (paradas intermediarias).
 * @param {Array<object>} waypoints
 * @returns {Array<{lat:number,lng:number,name:string,desc:string}>}
 */
function normalizeWaypoints(waypoints) {
  if (!Array.isArray(waypoints)) return [];
  const result = [];
  for (const item of waypoints) {
    if (!item || typeof item !== "object") continue;
    const lat = Number(item.lat);
    const lng = Number(item.lng !== undefined ? item.lng : item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    result.push({
      lat: lat,
      lng: lng,
      name: String(item.name || item.raw || "Parada"),
      desc: item.desc ? String(item.desc) : "",
    });
  }
  return result;
}

/**
 * Gera um documento GPX 1.1 valido.
 *
 * @param {Object} options
 * @param {string} [options.name] Nome da rota (metadata + trk).
 * @param {string} [options.desc] Descricao.
 * @param {Array<{lat:number,lng:number,ele?:number}>} options.points Pontos da geometria.
 * @param {Array<object>} [options.waypoints] Paradas intermediarias ({lat,lng,name}).
 * @param {boolean} [options.elevation] Inclui <ele> quando os pontos tiverem altitude.
 * @param {string} [options.creator]
 * @param {string} [options.time] Data ISO 8601 opcional para o metadata.
 * @param {boolean} [options.includeStartEnd=true] Cria wpt de inicio e fim.
 * @returns {string}
 */
export function buildGpx(options) {
  const opts = options || {};
  const name = opts.name === undefined || opts.name === null || opts.name === "" ? "Rota" : String(opts.name);
  const desc = opts.desc ? String(opts.desc) : "";
  const creator = opts.creator ? String(opts.creator) : DEFAULT_CREATOR;
  const time = opts.time ? String(opts.time) : null;
  const includeStartEnd = opts.includeStartEnd !== false;
  const withElevation = opts.elevation === true;

  const normalized = normalizePoints(opts.points || []);
  if (normalized.length === 0) {
    throw new Error("buildGpx: informe ao menos um ponto com lat/lng validos.");
  }

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<gpx xmlns="' + GPX_NS + '" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="' + GPX_NS + " " + GPX_NS + '/gpx.xsd" ' +
      'version="1.1" creator="' + escapeXml(creator) + '">'
  );

  lines.push("  <metadata>");
  lines.push("    <name>" + escapeXml(name) + "</name>");
  if (desc) lines.push("    <desc>" + escapeXml(desc) + "</desc>");
  if (time) lines.push("    <time>" + escapeXml(time) + "</time>");
  lines.push("  </metadata>");

  const writeWaypoint = function (lat, lng, wptName, wptDesc) {
    const attrs = 'lat="' + formatCoordinate(lat) + '" lon="' + formatCoordinate(lng) + '"';
    lines.push("  <wpt " + attrs + ">");
    lines.push("    <name>" + escapeXml(wptName) + "</name>");
    if (wptDesc) lines.push("    <desc>" + escapeXml(wptDesc) + "</desc>");
    lines.push("  </wpt>");
  };

  if (includeStartEnd) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    writeWaypoint(first.lat, first.lng, "Inicio", "Ponto de partida");
    if (normalized.length > 1) {
      writeWaypoint(last.lat, last.lng, "Fim", "Ponto de chegada");
    }
  }

  const extraWaypoints = normalizeWaypoints(opts.waypoints);
  for (let i = 0; i < extraWaypoints.length; i += 1) {
    const wpt = extraWaypoints[i];
    writeWaypoint(wpt.lat, wpt.lng, wpt.name || "Parada " + (i + 1), wpt.desc);
  }

  lines.push("  <trk>");
  lines.push("    <name>" + escapeXml(name) + "</name>");
  if (desc) lines.push("    <desc>" + escapeXml(desc) + "</desc>");
  lines.push("    <trkseg>");
  for (const point of normalized) {
    const attrs = 'lat="' + formatCoordinate(point.lat) + '" lon="' + formatCoordinate(point.lng) + '"';
    if (withElevation && point.ele !== null) {
      lines.push("      <trkpt " + attrs + "><ele>" + formatElevation(point.ele) + "</ele></trkpt>");
    } else {
      lines.push("      <trkpt " + attrs + "/>");
    }
  }
  lines.push("    </trkseg>");
  lines.push("  </trk>");
  lines.push("</gpx>");

  return lines.join("\n") + "\n";
}

/**
 * Converte os pontos em um GeoJSON FeatureCollection com LineString.
 *
 * @param {Array<{lat:number,lng:number,ele?:number}>} points
 * @param {{name?:string, desc?:string}} [properties]
 * @returns {{type:"FeatureCollection", features:Array<object>}}
 */
export function buildGeoJSON(points, properties) {
  const props = properties || {};
  const normalized = normalizePoints(points);
  const coordinates = [];
  for (const point of normalized) {
    const coordinate = [point.lng, point.lat];
    if (point.ele !== null && point.ele !== undefined) coordinate.push(point.ele);
    coordinates.push(coordinate);
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          name: props.name === undefined ? "Rota" : props.name,
          desc: props.desc === undefined ? "" : props.desc,
          pointCount: normalized.length,
        },
        geometry: { type: "LineString", coordinates: coordinates },
      },
    ],
  };
}

/**
 * Transforma um nome de rota em nome de arquivo seguro (.gpx).
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function toFileName(name, fallback) {
  const base = String(name === undefined || name === null ? "" : name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.gpx$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  let safe = base.length > 80 ? base.slice(0, 80).replace(/-+$/g, "") : base;
  if (!safe) safe = fallback || "rota";
  return safe.replace(/\.gpx$/i, "") + ".gpx";
}
