/**
 * Altimetria via Open-Meteo (CORS liberado, sem chave).
 *
 * Modulo puro (sem DOM). Envia no maximo 100 coordenadas por requisicao.
 *
 * @module js/core/elevation.js
 */

/** Endpoint publico de elevacao do Open-Meteo. */
export const OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";

/** Limite do Open-Meteo por requisicao. */
export const ELEVATION_BATCH_SIZE = 100;

/** Erro de altimetria com codigo estavel. */
export class ElevationError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = "ElevationError";
    this.code = code;
  }
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
    return Promise.reject(new ElevationError("Ambiente sem suporte a fetch.", "unsupported"));
  }
  return globalThis.fetch(url, init);
}

/**
 * Executa com timeout.
 * @param {(signal:AbortSignal) => Promise<any>} task
 * @param {{signal?:AbortSignal, timeoutMs?:number}} options
 * @returns {Promise<any>}
 */
export async function withTimeout(task, options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 25000;
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
      reject(new ElevationError("Tempo esgotado ao buscar a altimetria.", "timeout"));
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
 * Divide a lista em lotes.
 * @param {Array<any>} list
 * @param {number} size
 * @returns {Array<Array<any>>}
 */
export function chunk(list, size) {
  const result = [];
  const step = Math.max(1, Number(size) || ELEVATION_BATCH_SIZE);
  for (let i = 0; i < list.length; i += step) result.push(list.slice(i, i + step));
  return result;
}

/**
 * Monta a URL do Open-Meteo para um lote de pontos.
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {string}
 */
export function buildOpenMeteoUrl(points) {
  const latitudes = points.map(function (point) { return Number(point.lat); }).join(",");
  const longitudes = points.map(function (point) { return Number(point.lng); }).join(",");
  return OPEN_METEO_ELEVATION_URL + "?latitude=" + latitudes + "&longitude=" + longitudes;
}

/**
 * Consulta a altimetria para no maximo 100 pontos (uma requisicao).
 * @param {Array<{lat:number,lng:number}>} points
 * @param {{apiBase?:string|null, fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number}} [options]
 * @returns {Promise<Array<number|null>>}
 */
export async function fetchElevationBatch(points, options) {
  const opts = options || {};
  if (points.length > ELEVATION_BATCH_SIZE) {
    throw new ElevationError(
      "Lote de altimetria com " + points.length + " pontos; o maximo e " + ELEVATION_BATCH_SIZE + ".",
      "batch_too_large"
    );
  }

  const apiBase = String(opts.apiBase || "").replace(/\/+$/, "");
  let url;
  let init = { method: "GET", headers: { Accept: "application/json" } };

  if (apiBase) {
    const encoded = points.map(function (point) { return point.lat + "," + point.lng; }).join(";");
    url = apiBase + "/elevation?points=" + encodeURIComponent(encoded);
  } else {
    url = buildOpenMeteoUrl(points);
  }

  const response = await withTimeout(function (signal) {
    return callFetch(opts.fetchImpl, url, Object.assign({}, init, { signal: signal }));
  }, opts);

  if (!response.ok) {
    throw new ElevationError("Servico de altimetria respondeu " + response.status + ".", "http_error");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ElevationError("Resposta invalida do servico de altimetria.", "bad_response");
  }

  if (payload && payload.ok === false) {
    throw new ElevationError(payload.error || "Servico de altimetria falhou.", payload.error_type || "backend_error");
  }

  const values = payload && Array.isArray(payload.elevations)
    ? payload.elevations
    : payload && Array.isArray(payload.elevation)
      ? payload.elevation
      : null;

  if (!values) throw new ElevationError("Resposta de altimetria sem lista de elevacoes.", "bad_response");
  if (values.length !== points.length) {
    throw new ElevationError(
      "Servico de altimetria devolveu " + values.length + " valores para " + points.length + " pontos.",
      "length_mismatch"
    );
  }

  return values.map(function (value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  });
}

/**
 * Adiciona altitude (ele) a uma lista de pontos, em lotes de ate 100.
 *
 * @param {Array<{lat:number,lng:number,ele?:number}>} points
 * @param {{
 *   apiBase?:string|null,
 *   fetchImpl?:Function,
 *   signal?:AbortSignal,
 *   timeoutMs?:number,
 *   batchSize?:number,
 *   onProgress?:(done:number,total:number)=>void,
 *   allowPartial?:boolean
 * }} [options]
 * @returns {Promise<Array<{lat:number,lng:number,ele:number|null}>>}
 */
export async function addElevation(points, options) {
  const opts = options || {};
  const input = Array.isArray(points) ? points : [];
  if (input.length === 0) return [];

  const normalized = input.map(function (point) {
    const lat = Number(point && point.lat);
    const lng = Number(point && (point.lng !== undefined ? point.lng : point.lon));
    const item = { lat: lat, lng: lng };
    const existing = Number(point && (point.ele !== undefined ? point.ele : point.elevation));
    if (Number.isFinite(existing)) item.ele = existing;
    return item;
  });

  const invalid = normalized.some(function (point) {
    return !Number.isFinite(point.lat) || !Number.isFinite(point.lng);
  });
  if (invalid) throw new ElevationError("Ha pontos com coordenadas invalidas.", "invalid_points");

  const batchSize = Math.max(1, Math.min(ELEVATION_BATCH_SIZE, Number(opts.batchSize) || ELEVATION_BATCH_SIZE));
  const batches = chunk(normalized, batchSize);
  const result = [];
  let done = 0;
  const allowPartial = opts.allowPartial === true;

  for (const batch of batches) {
    let values = null;
    try {
      values = await fetchElevationBatch(batch, Object.assign({}, opts, { timeoutMs: opts.timeoutMs }));
    } catch (error) {
      if (!allowPartial) throw error;
      values = batch.map(function () { return null; });
    }

    for (let i = 0; i < batch.length; i += 1) {
      const point = batch[i];
      const value = values ? values[i] : null;
      const item = { lat: point.lat, lng: point.lng, ele: value === null || value === undefined ? null : Number(value) };
      if (item.ele !== null && !Number.isFinite(item.ele)) item.ele = null;
      result.push(item);
    }

    done += batch.length;
    if (typeof opts.onProgress === "function") opts.onProgress(done, normalized.length);
  }

  return result;
}
