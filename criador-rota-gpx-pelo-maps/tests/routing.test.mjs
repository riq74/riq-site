import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fetchRoute,
  decodePolyline,
  reducePlaces,
  normalizeProfile,
  buildOsrmUrl,
  routesFromOsrmPayload,
  routesFromValhallaPayload,
  routesFromBrouterPayload,
  routeLengthKm,
  formatDuration,
  buildSummary,
  MAX_ROUTE_POINTS,
} from "../js/core/routing.js";
import { routeStats } from "../js/core/gpx.js";

const fixture = async (name) => JSON.parse(await readFile(new URL("./fixtures/" + name, import.meta.url), "utf8"));

/** fetch falso que devolve uma resposta a partir de um objeto. */
function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const result = await handler(String(url), init || {}, calls.length);
    if (result instanceof Error) throw result;
    const status = result.status === undefined ? 200 : result.status;
    return {
      ok: status >= 200 && status < 300,
      status: status,
      url: result.url || String(url),
      headers: { get: () => "application/json" },
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
    };
  };
  impl.calls = calls;
  return impl;
}

describe("decodePolyline (Valhalla polyline6)", () => {
  test("decodifica o shape real do fixture Lisboa->Sintra", async () => {
    const data = await fixture("valhalla-lisboa-sintra-bicycle.json");
    const shape = data.body.trip.legs[0].shape;
    const points = decodePolyline(shape, 6);
    assert.ok(points.length > 100, "pontos decodificados: " + points.length);
    assert.ok(Math.abs(points[0].lat - 38.7223) < 0.01, "lat inicial: " + points[0].lat);
    assert.ok(Math.abs(points[0].lng - -9.1393) < 0.01, "lng inicial: " + points[0].lng);
    const last = points[points.length - 1];
    assert.ok(Math.abs(last.lat - 38.8029) < 0.01, "lat final: " + last.lat);
    assert.ok(Math.abs(last.lng - -9.3817) < 0.01, "lng final: " + last.lng);
  });

  test("decodifica polyline5 conhecida (Google Encoded Polyline)", () => {
    const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq" + String.fromCharCode(96) + "@";
    const points = decodePolyline(encoded, 5);
    assert.equal(points.length, 3);
    assert.ok(Math.abs(points[0].lat - 38.5) < 1e-6);
    assert.ok(Math.abs(points[0].lng - -120.2) < 1e-6);
    assert.ok(Math.abs(points[2].lat - 43.252) < 1e-6);
    assert.ok(Math.abs(points[2].lng - -126.453) < 1e-6);
  });

  test("entrada vazia ou invalida devolve lista vazia", () => {
    assert.deepEqual(decodePolyline("", 6), []);
    assert.deepEqual(decodePolyline(null, 6), []);
    assert.deepEqual(decodePolyline(undefined, 6), []);
  });
});

describe("reducePlaces (limite pratico de 500 pontos)", () => {
  test("mantem listas pequenas intactas", () => {
    const points = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }];
    assert.deepEqual(reducePlaces(points, 500), points);
  });

  test("reduz para 500 mantendo primeiro e ultimo", () => {
    const points = [];
    for (let i = 0; i < 1200; i += 1) points.push({ lat: i, lng: i });
    const reduced = reducePlaces(points, MAX_ROUTE_POINTS);
    assert.equal(reduced.length, 500);
    assert.deepEqual(reduced[0], points[0]);
    assert.deepEqual(reduced[reduced.length - 1], points[points.length - 1]);
  });

  test("indices ficam em ordem crescente e sem duplicatas", () => {
    const points = [];
    for (let i = 0; i < 5000; i += 1) points.push({ lat: i, lng: i });
    const reduced = reducePlaces(points, 500);
    assert.equal(reduced.length, 500);
    for (let i = 1; i < reduced.length; i += 1) {
      assert.ok(reduced[i].lat > reduced[i - 1].lat, "ordem quebrada em " + i);
    }
  });

  test("distribui os pontos intermediarios", () => {
    const points = [];
    for (let i = 0; i < 1000; i += 1) points.push({ lat: i, lng: i });
    const reduced = reducePlaces(points, 100);
    const afterMid = reduced.filter((p) => p.lat > 500).length;
    assert.ok(Math.abs(afterMid - 49) <= 2, "distribuicao ruim: " + afterMid);
  });
});

describe("normalizeProfile e formatacao", () => {
  test("mapeia aliases para os tres perfis", () => {
    assert.equal(normalizeProfile("driving"), "driving");
    assert.equal(normalizeProfile("car"), "driving");
    assert.equal(normalizeProfile("bike"), "bicycling");
    assert.equal(normalizeProfile("cycling"), "bicycling");
    assert.equal(normalizeProfile("foot"), "walking");
    assert.equal(normalizeProfile("pedestrian"), "walking");
    assert.equal(normalizeProfile("qualquer"), "driving");
    assert.equal(normalizeProfile(undefined), "driving");
  });

  test("formatDuration e buildSummary", () => {
    assert.equal(formatDuration(45), "45 min");
    assert.equal(formatDuration(60), "1 h");
    assert.equal(formatDuration(90), "1 h 30 min");
    assert.equal(formatDuration(0), "0 min");
    assert.equal(buildSummary(314.216, 206.31), "314 km - 3 h 26 min");
    assert.equal(buildSummary(8.4, 12), "8.4 km - 12 min");
  });
});

describe("buildOsrmUrl", () => {
  test("monta lon,lat;lon,lat com overview/geometries/alternatives", () => {
    const url = buildOsrmUrl([{ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 }], { alternatives: 2 });
    assert.equal(
      url,
      "https://router.project-osrm.org/route/v1/driving/-9.1393,38.7223;-8.6291,41.1579?overview=full&geometries=geojson&alternatives=2"
    );
  });

  test("limita alternatives a 3", () => {
    const url = buildOsrmUrl([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], { alternatives: 9 });
    assert.ok(url.endsWith("alternatives=3"));
  });
});

describe("fetchRoute no browser (apiBase null)", () => {
  test("driving usa OSRM e devolve rota + geojson", async () => {
    const data = await fixture("osrm-lisboa-porto.json");
    const fetchImpl = mockFetch(() => ({ body: data.body, status: 200 }));
    const result = await fetchRoute({
      places: [{ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 }],
      profile: "driving",
      alternatives: 1,
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "osrm");
    assert.equal(result.profile, "driving");
    assert.equal(result.routes.length, 2);
    const route = result.routes[0];
    assert.ok(route.points.length > 1000, "pontos: " + route.points.length);
    assert.ok(route.distanceKm > 300 && route.distanceKm < 330, "distancia: " + route.distanceKm);
    assert.ok(route.durationMin > 180 && route.durationMin < 230, "duracao: " + route.durationMin);
    assert.equal(route.geojson.type, "FeatureCollection");
    assert.equal(route.geojson.features[0].geometry.type, "LineString");
    assert.equal(fetchImpl.calls[0].url.includes("router.project-osrm.org/route/v1/driving/"), true);
    assert.equal(fetchImpl.calls[0].url.includes("overview=full"), true);
    assert.equal(fetchImpl.calls[0].url.includes("geometries=geojson"), true);
  });

  test("bicycling usa Valhalla com costing bicycle (OSRM demo ignora bike)", async () => {
    const data = await fixture("valhalla-lisboa-sintra-bicycle.json");
    const fetchImpl = mockFetch(() => ({ body: data.body, status: 200 }));
    const result = await fetchRoute({
      places: [{ lat: 38.7223, lng: -9.1393 }, { lat: 38.8029, lng: -9.3817 }],
      profile: "bicycling",
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "valhalla");
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, "https://valhalla1.openstreetmap.de/route");
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(body.costing, "bicycle");
    assert.deepEqual(body.locations[0], { lat: 38.7223, lon: -9.1393 });
    assert.equal(result.routes[0].points.length > 100, true);
    assert.ok(Math.abs(result.routes[0].distanceKm - 30.108) < 0.01);
  });

  test("walking usa Valhalla com costing pedestrian", async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: { trip: { legs: [{ shape: "_p~iF~ps|U_ulLnnqC" }], summary: { length: 1.5, time: 1200 } } },
    }));
    const result = await fetchRoute({
      places: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }],
      profile: "walking",
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(fetchImpl.calls[0].init.body).costing, "pedestrian");
  });

  test("limite de distancia do Valhalla cai para BRouter", async () => {
    const brouter = await fixture("brouter-trekking-short.json");
    const fetchImpl = mockFetch((url) => {
      if (url.includes("valhalla")) {
        return { status: 400, body: { error_code: 154, error: "Path distance exceeds the max distance limit: 150000 meters" } };
      }
      return { body: brouter.body, status: 200 };
    });
    const result = await fetchRoute({
      places: [{ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 }],
      profile: "bicycling",
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "brouter");
    assert.equal(fetchImpl.calls.length, 2);
    assert.ok(fetchImpl.calls[1].url.includes("brouter.de/brouter"));
    assert.ok(fetchImpl.calls[1].url.includes("profile=trekking"));
    assert.ok(fetchImpl.calls[1].url.includes("format=geojson"));
    assert.ok(result.routes[0].points.length > 10);
    assert.equal(result.attempts.length, 1);
    assert.ok(result.attempts[0].includes("valhalla"));
  });

  test("OSRM 429 devolve erro claro e tenta o proximo provedor", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.includes("osrm")) return { status: 429, body: { code: "TooManyRequests" } };
      return { status: 400, body: { error: "nao suportado" } };
    });
    const result = await fetchRoute({
      places: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }],
      profile: "driving",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "object");
    assert.equal(typeof result.error.code, "string");
    assert.ok(result.error.message.length > 10);
    assert.equal(String(result.error), result.error.message);
    assert.ok(result.attempts.some((a) => a.includes("429")));
  });

  test("todos os provedores falhando devolve erro em pt-BR com code", async () => {
    const fetchImpl = mockFetch(() => ({ status: 503, body: {} }));
    const result = await fetchRoute({
      places: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }],
      profile: "walking",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.routes.length, 0);
    assert.ok(result.error.code === "routing-failed" || result.error.code === "distance-limit");
    assert.ok(/rota|servico/i.test(result.error.message));
    assert.equal(result.attempts.length, 2);
  });

  test("menos de 2 pontos falha sem chamar a rede", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: {} }));
    const result = await fetchRoute({ places: [{ lat: 1, lng: 2 }], fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "not-enough-points");
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("pontos invalidos sao descartados", async () => {
    const data = await fixture("osrm-lisboa-porto.json");
    const fetchImpl = mockFetch(() => ({ body: data.body, status: 200 }));
    const result = await fetchRoute({
      places: [{ lat: "x", lng: 2 }, { lat: 38.7223, lng: -9.1393 }, { lat: 95, lng: 0 }, { lat: 41.1579, lng: -8.6291 }],
      profile: "driving",
      fetchImpl,
    });
    assert.equal(result.ok, true);
    const url = fetchImpl.calls[0].url;
    assert.equal((url.match(/;/g) || []).length, 1, "deveria enviar exatamente 2 pontos");
  });

  test("mais de 500 pontos e reduzido mantendo primeiro e ultimo", async () => {
    const data = await fixture("osrm-lisboa-porto.json");
    const fetchImpl = mockFetch(() => ({ body: data.body, status: 200 }));
    const places = [];
    for (let i = 0; i < 1200; i += 1) places.push({ lat: 38 + i / 10000, lng: -9 });
    const result = await fetchRoute({ places, profile: "driving", fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.reducedFrom, 1200);
    const coordinates = fetchImpl.calls[0].url.split("?")[0].split("/").pop().split(";");
    assert.equal(coordinates.length, 500);
    assert.equal(coordinates[0], "-9,38");
    assert.ok(coordinates[coordinates.length - 1].startsWith("-9,38.11"));
  });
});

describe("fetchRoute com apiBase (servidor local)", () => {
  test("delega para POST {apiBase}/route e normaliza a resposta", async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: {
        ok: true,
        profile: "walking",
        source: "valhalla",
        routes: [
          {
            index: 0,
            summary: "1.6 km - 21 min",
            distanceKm: 1.561,
            durationMin: 21.2,
            points: [{ lat: 38.73, lng: -9.15 }, { lat: 38.74, lng: -9.16 }],
          },
        ],
      },
    }));
    const result = await fetchRoute({
      places: [{ lat: 38.72, lng: -9.13 }, { lat: 38.74, lng: -9.16 }],
      profile: "walking",
      alternatives: 1,
      apiBase: "/api",
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "valhalla");
    assert.equal(fetchImpl.calls[0].url, "/api/route");
    assert.equal(fetchImpl.calls[0].init.method, "POST");
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(body.profile, "walking");
    assert.equal(body.alternatives, 1);
    assert.deepEqual(body.points[0], { lat: 38.72, lng: -9.13 });
    assert.equal(result.routes[0].distanceKm, 1.561);
    assert.equal(result.routes[0].geojson.features[0].geometry.coordinates.length, 2);
  });

  test("apiBase com erro devolve backend-error sem tentar APIs publicas", async () => {
    const fetchImpl = mockFetch(() => ({ status: 500, body: { ok: false, error: "falhou" } }));
    const result = await fetchRoute({
      places: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }],
      apiBase: "/api/",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "backend-error");
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, "/api/route");
  });
});

describe("parsers de resposta", () => {
  test("routesFromOsrmPayload respeita alternatives", async () => {
    const data = await fixture("osrm-lisboa-porto.json");
    const parsed = routesFromOsrmPayload(data.body, 0);
    assert.equal(parsed.length, 1);
    const all = routesFromOsrmPayload(data.body, 3);
    assert.equal(all.length, 2, "o fixture tem 2 rotas");
    assert.ok(all[0].distanceKm > 0 && all[0].durationMin > 0);
  });

  test("routesFromValhallaPayload le o fixture real", async () => {
    const data = await fixture("valhalla-lisboa-sintra-bicycle.json");
    const parsed = routesFromValhallaPayload(data.body);
    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].points.length > 100);
    assert.equal(parsed[0].source, "valhalla");
  });

  test("routesFromBrouterPayload le track-length e total-time", async () => {
    const data = await fixture("brouter-trekking-short.json");
    const parsed = routesFromBrouterPayload(data.body);
    const props = data.body.features[0].properties;
    assert.equal(parsed[0].points.length, data.body.features[0].geometry.coordinates.length);
    assert.ok(Math.abs(parsed[0].distanceKm - Number(props["track-length"]) / 1000) < 1e-6);
    assert.ok(Math.abs(parsed[0].durationMin - Number(props["total-time"]) / 60) < 1e-6);
    assert.equal(parsed[0].source, "brouter");
    assert.equal(typeof parsed[0].points[0].ele, "number");
  });

  test("payloads invalidos lancam erro", () => {
    assert.throws(() => routesFromOsrmPayload({ code: "NoRoute", routes: [] }, 0), /OSRM/);
    assert.throws(() => routesFromValhallaPayload({ error: "falhou", error_code: 154 }), /falhou/);
    assert.throws(() => routesFromBrouterPayload({ features: [] }), /BRouter/);
  });
});

describe("routeLengthKm", () => {
  test("soma distancias haversine", () => {
    const km = routeLengthKm([{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 2, lng: 0 }]);
    assert.ok(km > 222 && km < 223, "esperava ~222.4 km, veio " + km);
  });
});
