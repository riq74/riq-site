/**
 * API publica do nucleo (unico ponto de import para a UI).
 *
 * @example
 *   import { parseMapsUrl, geocodePlace, fetchRoute, buildGpx, toFileName } from "./core/index.js";
 *
 * Modulos puros: sem DOM, sem dependencias npm, funcionam no browser e no Node 22.
 * No browser use apiBase = null (APIs publicas com CORS); com o servidor local
 * use apiBase = "/api" para geocodificacao Nominatim e expansao de links curtos.
 *
 * @module js/core/index.js
 */

export { parseMapsUrl, parseCoordsText, parseDataCoords } from "./url-parser.js";

export {
  geocodePlace,
  geocodeQuery,
  resolvePlaces,
  resolveShortLink,
  geocodeWithPhoton,
  geocodeWithNominatim,
  placeFromPhotonFeature,
  photonDisplayName,
  GeocodeError,
  PHOTON_URL,
} from "./geocode.js";

export {
  fetchRoute,
  decodePolyline,
  reducePlaces,
  normalizeProfile,
  formatDuration,
  buildSummary,
  buildOsrmUrl,
  routeFromOsrm,
  routesFromOsrmPayload,
  routesFromValhallaPayload,
  pointsFromValhalla,
  routesFromBrouterPayload,
  routeLengthKm,
  routingFailure,
  RoutingError,
  MAX_ROUTE_POINTS,
  OSRM_BASE,
  VALHALLA_URL,
  BROUTER_URL,
  PROFILE_MAP,
  SUPPORTED_PROFILES,
} from "./routing.js";

export {
  buildGpx,
  buildGeoJSON,
  toFileName,
  routeStats,
  haversineKm,
  escapeXml,
  normalizePoints,
  GPX_NS,
  DEFAULT_CREATOR,
} from "./gpx.js";

export {
  addElevation,
  fetchElevationBatch,
  buildOpenMeteoUrl,
  chunk,
  ElevationError,
  ELEVATION_BATCH_SIZE,
  OPEN_METEO_ELEVATION_URL,
} from "./elevation.js";
