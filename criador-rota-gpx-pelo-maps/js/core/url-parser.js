/**
 * Parser de URLs do Google Maps.
 *
 * Modulo puro: sem DOM, sem dependencias npm. Importavel no browser e no Node 22.
 * Nao faz rede: apenas interpreta o link e devolve uma descricao da rota.
 *
 * Regra importante (verificada em producao): em links de DIRECOES, o segmento
 * "@lat,lng,15z" e apenas o centro do viewport do mapa, nunca um ponto da rota.
 * Ele e devolvido em "mapCenter" e NAO e usado como origem/destino.
 * Em links de LUGAR (/maps/place/...), "@lat,lng" e "!3dLAT!4dLNG" sao o ponto
 * do lugar e por isso viram coordenadas do Place.
 *
 * @module js/core/url-parser.js
 */

/** Hosts curtos do Google que precisam ser expandidos via proxy/redirect. */
const SHORT_HOSTS = new Set(["goo.gl", "www.goo.gl", "maps.app.goo.gl", "app.goo.gl", "g.co"]);

/** Hosts do Google Maps aceitos (google.com, google.com.br, google.pt, maps.google.com, ...). */
const GOOGLE_HOST_RE = /^(?:(?:www|maps)\.)?google\.[a-z]{2,4}(?:\.[a-z]{2})?$/i;

/** Coordenadas lat,lng em um unico segmento. */
const COORD_RE = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;

/** Marcador de centro do mapa: @lat,lng,15z (o zoom e opcional). */
const MAP_AT_RE = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/;

/** Ponto exato do lugar em links de place: !3dLAT!4dLNG. */
const PIN_3D4D_RE = /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/;

/** Codigos de modo de viagem usados no parametro data=!4m...!3eN. */
const TRAVEL_MODE_BY_CODE = { 0: "driving", 1: "bicycling", 2: "walking", 3: "transit" };

/** Aceita variacoes em portugues/ingles do modo de viagem. */
const TRAVEL_MODE_ALIASES = {
  driving: "driving",
  drive: "driving",
  car: "driving",
  carro: "driving",
  bicycling: "bicycling",
  cycling: "bicycling",
  bike: "bicycling",
  bicicleta: "bicycling",
  walking: "walking",
  walk: "walking",
  foot: "walking",
  pe: "walking",
  pedestrian: "walking",
  transit: "transit",
  transporte: "transit",
};

/**
 * @typedef {Object} Place
 * @property {string} raw Texto original do local (nome ou "lat,lng").
 * @property {string} [name] Nome legivel.
 * @property {number} [lat]
 * @property {number} [lng]
 * @property {boolean} needsGeocode True quando ainda e preciso geocodificar.
 * @property {string} [sourceHint] De onde veio o dado.
 */

/**
 * @typedef {Object} ParsedMapsUrl
 * @property {boolean} ok
 * @property {"directions"|"place"|"coords"|"short"|"unsupported"} kind
 * @property {"driving"|"bicycling"|"walking"|"transit"|null} travelmode
 * @property {Place|null} origin
 * @property {Place|null} destination
 * @property {Place[]} waypoints
 * @property {string} [reason] Motivo quando ok === false.
 * @property {string} normalizedUrl URL absoluta normalizada.
 * @property {{lat:number,lng:number,zoom:number|null}} [mapCenter] Centro do viewport.
 */

/**
 * Converte um texto "lat,lng" em coordenadas validadas.
 * @param {string} text
 * @returns {{lat:number,lng:number}|null}
 */
export function parseCoordsText(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(COORD_RE);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Decodifica um segmento de caminho do Google Maps ("+" vira espaco).
 * @param {string} segment
 * @returns {string}
 */
function decodeSegment(segment) {
  const withSpaces = String(segment).replace(/\+/g, " ");
  try {
    return decodeURIComponent(withSpaces).trim();
  } catch {
    return withSpaces.trim();
  }
}

/**
 * Cria um Place a partir de texto livre ou de coordenadas.
 * @param {string} text
 * @param {string} sourceHint
 * @returns {Place}
 */
function makePlace(text, sourceHint) {
  const clean = String(text).trim();
  const coords = parseCoordsText(clean);
  if (coords) {
    return { raw: clean, lat: coords.lat, lng: coords.lng, needsGeocode: false, sourceHint: sourceHint };
  }
  return { raw: clean, name: clean, needsGeocode: true, sourceHint: sourceHint };
}

/**
 * Normaliza textos de modo de viagem.
 * @param {string} value
 * @returns {"driving"|"bicycling"|"walking"|"transit"|null}
 */
function normalizeTravelMode(value) {
  if (!value) return null;
  return TRAVEL_MODE_ALIASES[String(value).trim().toLowerCase()] || null;
}

/**
 * Extrai o modo de viagem do link (data=!3eN, travelmode=, mode=, dirflg=).
 * @param {URL} url
 * @returns {"driving"|"bicycling"|"walking"|"transit"|null}
 */
function detectTravelMode(url) {
  const dataMatch = url.href.match(/[!&]3e([0-3])/);
  if (dataMatch) return TRAVEL_MODE_BY_CODE[dataMatch[1]] || null;

  const explicit = normalizeTravelMode(url.searchParams.get("travelmode") || url.searchParams.get("mode"));
  if (explicit) return explicit;

  const dirflg = String(url.searchParams.get("dirflg") || "").trim().toLowerCase();
  if (dirflg) return { d: "driving", w: "walking", b: "bicycling", r: "transit" }[dirflg] || null;

  return null;
}

/**
 * Extrai o centro do mapa (@lat,lng,zoom) do caminho ou da query.
 * @param {URL} url
 * @returns {{lat:number,lng:number,zoom:number|null}|undefined}
 */
function detectMapCenter(url) {
  const match = String(url.pathname + url.search).match(MAP_AT_RE);
  if (!match) return undefined;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  const zoom = match[3] === undefined ? null : Number(match[3]);
  return { lat: lat, lng: lng, zoom: Number.isFinite(zoom) ? zoom : null };
}

/**
 * Extrai o ponto exato de um lugar (!3dLAT!4dLNG).
 * @param {URL} url
 * @returns {{lat:number,lng:number}|null}
 */
function detectPin(url) {
  const match = String(url.pathname + url.search + url.hash).match(PIN_3D4D_RE);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: lat, lng: lng };
}

/**
 * Bloco de coordenadas de um ponto da rota dentro do parametro data=:
 * !2m2!1dLNG!2dLAT (convencao do Google). A variante inversa tambem e aceita.
 */
const DATA_COORD_BLOCK_RE = /!2m2!(?:1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)|2d(-?\d+(?:\.\d+)?)!1d(-?\d+(?:\.\d+)?))/g;

/**
 * Extrai os pares de coordenadas embutidos no parametro data= do Google Maps.
 *
 * Em links de direcoes, cada ponto que veio como NOME (e nao como "lat,lng")
 * carrega o proprio ponto no bloco !2m2!1dLNG!2dLAT. Essas coordenadas sao
 * exatas e evitam geocodificar nomes que nao existem nas bases do OSM
 * (ex.: nome de condominio).
 *
 * @param {string} dataString Conteudo de data= (com ou sem o prefixo "data=").
 * @returns {Array<{lat:number,lng:number}>} Pares na ordem em que aparecem.
 */
export function parseDataCoords(dataString) {
  const text = String(dataString === undefined || dataString === null ? "" : dataString);
  const coordinates = [];
  DATA_COORD_BLOCK_RE.lastIndex = 0;

  let match;
  while ((match = DATA_COORD_BLOCK_RE.exec(text)) !== null) {
    let lng;
    let lat;
    if (match[1] !== undefined) {
      lng = Number(match[1]);
      lat = Number(match[2]);
    } else {
      // Variante !2d!1d: o primeiro double e a latitude.
      lat = Number(match[3]);
      lng = Number(match[4]);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    coordinates.push({ lat: lat, lng: lng });
  }

  return coordinates;
}

/**
 * Coleta os data= do link (segmento de caminho e/ou query string).
 * @param {URL} url
 * @returns {string[]}
 */
function extractDataStrings(url) {
  const list = [];
  const queryData = url.searchParams.get("data");
  if (queryData) list.push(queryData);
  for (const segment of url.pathname.split("/")) {
    if (segment.toLowerCase().startsWith("data=")) list.push(segment.slice(5));
  }
  return list;
}

/**
 * Junta as coordenadas de todos os blocos data= do link, na ordem.
 * @param {URL} url
 * @returns {Array<{lat:number,lng:number}>}
 */
function collectDataCoords(url) {
  const all = [];
  for (const dataString of extractDataStrings(url)) {
    for (const coordinate of parseDataCoords(dataString)) all.push(coordinate);
  }
  return all;
}

/**
 * Aplica as coordenadas do data= aos pontos que ainda precisariam de geocode.
 *
 * Regra conservadora: so atribui quando a quantidade de blocos bate exatamente
 * com a quantidade de pontos nomeados (na ordem da rota). Se divergir, NAO
 * inventa coordenada: deixa o ponto para geocodificacao e expoe dataCoords
 * apenas para depuracao.
 *
 * @param {object} result Resultado em construcao.
 * @param {Array<object>} orderedPlaces Pontos da rota na ordem, sem nulos.
 * @param {Array<{lat:number,lng:number}>} dataCoords
 * @returns {object}
 */
function applyDataCoordinates(result, orderedPlaces, dataCoords) {
  if (!dataCoords || dataCoords.length === 0) return result;
  result.dataCoords = dataCoords.map(function (item) { return { lat: item.lat, lng: item.lng }; });

  const named = [];
  for (const place of orderedPlaces) {
    if (place && place.needsGeocode) named.push(place);
  }
  if (named.length === 0 || dataCoords.length !== named.length) return result;

  for (let i = 0; i < named.length; i += 1) {
    named[i].lat = dataCoords[i].lat;
    named[i].lng = dataCoords[i].lng;
    named[i].needsGeocode = false;
    if (!named[i].name) named[i].name = named[i].raw;
    named[i].sourceHint = (named[i].sourceHint || "path") + "+data";
  }
  return result;
}

/**
 * Separa waypoints de query ("C|D", "C%7CD", "C;D").
 * @param {string|null} value
 * @returns {string[]}
 */
function splitWaypoints(value) {
  if (!value) return [];
  return String(value)
    .split(/[|;]/)
    .map(function (part) { return part.trim(); })
    .filter(function (part) { return part.length > 0; });
}

/**
 * Le um parametro de query limpo.
 * @param {URL} url
 * @param {string} name
 * @returns {string|null}
 */
function queryParam(url, name) {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  const clean = value.trim();
  return clean.length > 0 ? clean : null;
}

/**
 * Cria o esqueleto do resultado.
 * @param {string} normalizedUrl
 * @returns {ParsedMapsUrl}
 */
function baseResult(normalizedUrl) {
  return {
    ok: false,
    kind: "unsupported",
    travelmode: null,
    origin: null,
    destination: null,
    waypoints: [],
    normalizedUrl: normalizedUrl || "",
  };
}

/**
 * Resultado de erro.
 * @param {string} reason
 * @param {string} [normalizedUrl]
 * @returns {ParsedMapsUrl}
 */
function fail(reason, normalizedUrl) {
  return Object.assign(baseResult(normalizedUrl), { reason: reason });
}

/**
 * Monta rota a partir dos parametros de API (?api=1&origin=&destination=&waypoints=).
 * @param {URL} url
 * @param {string} href
 * @returns {ParsedMapsUrl|null}
 */
function parseApiParams(url, href) {
  const originText = queryParam(url, "origin");
  const destinationText = queryParam(url, "destination");
  const waypointTexts = splitWaypoints(queryParam(url, "waypoints") || queryParam(url, "waypoint"));

  if (!originText && !destinationText) return null;

  const origin = originText ? makePlace(originText, "query") : null;
  const destination = destinationText ? makePlace(destinationText, "query") : null;
  const waypoints = waypointTexts.map(function (text) { return makePlace(text, "query"); });
  // Em links ?api=1 nao ha pin de viewport confiavel: so usa !3d!4d e o data=.
  const pin = detectPin(url);

  if (!destination && origin) {
    // Apenas origem: trata como local unico.
    const place = Object.assign({}, origin);
    if (place.needsGeocode && pin) {
      place.lat = pin.lat;
      place.lng = pin.lng;
      place.needsGeocode = false;
      place.sourceHint = "query+pin";
    }
    return Object.assign(baseResult(href), {
      ok: true,
      kind: parseCoordsText(originText) !== null ? "coords" : "place",
      origin: place,
      travelmode: detectTravelMode(url),
      mapCenter: detectMapCenter(url),
    });
  }

  const result = Object.assign(baseResult(href), {
    ok: true,
    kind: "directions",
    travelmode: detectTravelMode(url),
    origin: origin,
    destination: destination,
    waypoints: waypoints,
    mapCenter: detectMapCenter(url),
  });

  const ordered = [];
  if (origin) ordered.push(origin);
  for (const waypoint of waypoints) ordered.push(waypoint);
  if (destination) ordered.push(destination);

  return applyDataCoordinates(result, ordered, collectDataCoords(url));
}

/**
 * Rotas /maps/dir/A/B[/C/D]...
 * @param {URL} url
 * @param {string} href
 * @returns {ParsedMapsUrl}
 */
function parseDirectionsPath(url, href) {
  const parts = url.pathname.split("/");
  const dirIndex = parts.findIndex(function (part) { return part.toLowerCase() === "dir"; });
  const rest = dirIndex >= 0 ? parts.slice(dirIndex + 1) : [];
  while (rest.length > 0 && rest[rest.length - 1] === "") rest.pop();

  const hadEmptyOrigin = rest.length > 0 && rest[0] === "";
  /** @type {Place[]} */
  const places = [];
  for (const segment of rest) {
    if (!segment) continue;
    const lower = segment.toLowerCase();
    if (segment.startsWith("@") || lower.startsWith("data=") || segment.startsWith("!")) continue;
    const text = decodeSegment(segment);
    if (text) places.push(makePlace(text, "path"));
  }

  if (places.length === 0) {
    const fromApi = parseApiParams(url, href);
    if (fromApi) return fromApi;
    return fail("no_places", href);
  }

  // Coordenadas exatas dos pontos nomeados vem no bloco data=!2m2!1dLNG!2dLAT.
  const dataCoords = collectDataCoords(url);

  if (places.length === 1) {
    const single = Object.assign(baseResult(href), {
      ok: true,
      kind: "directions",
      travelmode: detectTravelMode(url),
      origin: null,
      destination: places[0],
      waypoints: [],
      mapCenter: detectMapCenter(url),
    });
    return applyDataCoordinates(single, [places[0]], dataCoords);
  }

  const result = Object.assign(baseResult(href), {
    ok: true,
    kind: "directions",
    travelmode: detectTravelMode(url),
    origin: hadEmptyOrigin ? null : places[0],
    destination: places[places.length - 1],
    waypoints: places.slice(1, -1),
    mapCenter: detectMapCenter(url),
  });

  const ordered = hadEmptyOrigin ? places.slice(1) : places.slice();
  return applyDataCoordinates(result, ordered, dataCoords);
}

/**
 * Links /maps/place/Nome/@lat,lng,15z, /maps/search/..., /maps?q=...
 * @param {URL} url
 * @param {string} href
 * @returns {ParsedMapsUrl}
 */
function parsePlaceLike(url, href) {
  const parts = url.pathname.split("/");
  let markerIndex = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const lower = parts[i].toLowerCase();
    if (lower === "place" || lower === "search") {
      markerIndex = i;
      break;
    }
  }

  let text = null;
  let sourceHint = "place";
  if (markerIndex >= 0) {
    sourceHint = parts[markerIndex].toLowerCase() === "search" ? "search" : "place";
    for (let i = markerIndex + 1; i < parts.length; i += 1) {
      const segment = parts[i];
      if (!segment) continue;
      const lower = segment.toLowerCase();
      if (segment.startsWith("@") || lower.startsWith("data=") || segment.startsWith("!")) continue;
      const decoded = decodeSegment(segment);
      if (decoded) {
        text = decoded;
        break;
      }
    }
  }

  if (!text) {
    text = queryParam(url, "q") || queryParam(url, "query") || queryParam(url, "ll");
    sourceHint = "query";
  }

  const isPlaceUrl = markerIndex >= 0 && parts[markerIndex].toLowerCase() === "place";
  // Apenas em links de LUGAR o @lat,lng / !3d!4d representam o ponto do lugar.
  const pin = isPlaceUrl ? detectPin(url) || detectMapCenter(url) : null;

  if (text) {
    const textIsCoords = parseCoordsText(text) !== null;
    const place = makePlace(text, sourceHint);
    if (place.needsGeocode && pin) {
      place.lat = pin.lat;
      place.lng = pin.lng;
      place.needsGeocode = false;
      place.sourceHint = sourceHint + "+pin";
    }
    return Object.assign(baseResult(href), {
      ok: true,
      kind: textIsCoords ? "coords" : "place",
      travelmode: detectTravelMode(url),
      origin: place,
      mapCenter: detectMapCenter(url),
    });
  }

  const mapCenter = detectMapCenter(url);
  if (mapCenter) {
    // Link de mapa sem nome: usa o centro como ponto de referencia.
    return Object.assign(baseResult(href), {
      ok: true,
      kind: "coords",
      travelmode: detectTravelMode(url),
      origin: {
        raw: mapCenter.lat + "," + mapCenter.lng,
        lat: mapCenter.lat,
        lng: mapCenter.lng,
        needsGeocode: false,
        sourceHint: "map_at",
      },
      mapCenter: mapCenter,
    });
  }

  return fail("no_places", href);
}

/**
 * Interpreta um link do Google Maps e devolve a rota descrita nele.
 *
 * Casos suportados:
 * - https://www.google.com/maps/dir/A/B (e com waypoints /dir/A/B/C/D)
 * - https://www.google.com/maps/dir/?api=1&origin=A&destination=B&waypoints=C|D
 * - coordenadas "-9.1393,38.7223" em segmentos ou na query
 * - /maps/place/Nome/@lat,lng,15z
 * - /maps?q=... (nome ou coordenadas)
 * - links curtos goo.gl/maps/xxx e maps.app.goo.gl/xxx (kind "short")
 * - My Maps /maps/d/... (kind "unsupported", reason "my_maps")
 *
 * Nunca lanca excecao: erros viram { ok:false, reason }.
 *
 * @param {string} input Link colado pelo usuario.
 * @returns {ParsedMapsUrl}
 */
export function parseMapsUrl(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return fail("invalid_url");

  let url;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    url = new URL(hasScheme ? raw : "https://" + raw);
  } catch {
    return fail("invalid_url");
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.port) {
    return fail("invalid_url");
  }

  const href = url.href;
  const host = url.hostname.toLowerCase();

  if (SHORT_HOSTS.has(host)) {
    return Object.assign(baseResult(href), { ok: true, kind: "short" });
  }

  if (!GOOGLE_HOST_RE.test(host)) return fail("unsupported_host", href);

  const lowerPath = (url.pathname || "/").toLowerCase();
  const mapCenter = detectMapCenter(url);

  // My Maps (/maps/d/...) nao e uma rota de direcoes.
  if (/^\/maps\/d(?:\/|$)/.test(lowerPath)) {
    const result = fail("my_maps", href);
    if (mapCenter) result.mapCenter = mapCenter;
    return result;
  }

  if (/^\/maps\/dir(?:\/|$)/.test(lowerPath)) {
    const result = parseDirectionsPath(url, href);
    if (result.ok && mapCenter) result.mapCenter = mapCenter;
    return result;
  }

  if (!/^\/maps(?:\/|$)/.test(lowerPath)) return fail("not_maps", href);

  const result = parsePlaceLike(url, href);
  if (result.ok && mapCenter) result.mapCenter = mapCenter;
  return result;
}

export default parseMapsUrl;
