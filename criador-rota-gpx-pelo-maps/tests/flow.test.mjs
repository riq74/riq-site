/**
 * Fluxo completo do nucleo, SEM rede: link do Google Maps -> rota -> GPX.
 * Usa apenas os fixtures reais capturados das APIs publicas.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseMapsUrl,
  geocodePlace,
  fetchRoute,
  addElevation,
  buildGpx,
  buildGeoJSON,
  routeStats,
  toFileName,
  resolveShortLink,
  resolvePlaces,
} from "../js/core/index.js";

const fixture = async (name) => JSON.parse(await readFile(new URL("./fixtures/" + name, import.meta.url), "utf8"));

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    for (const rule of routes) {
      if (rule.match(url)) {
        const result = await rule.reply(String(url), init || {});
        const status = result.status === undefined ? 200 : result.status;
        return {
          ok: status >= 200 && status < 300,
          status: status,
          url: String(url),
          headers: { get: () => "application/json" },
          json: async () => result.body,
        };
      }
    }
    throw new Error("fetch nao esperado: " + url);
  };
  impl.calls = calls;
  return impl;
}

describe("fluxo completo com fixtures reais (offline)", () => {
  test("link /maps/dir + geocode Photon + OSRM + GPX", async () => {
    const photon = await fixture("photon-porto.json");
    const photonLisboa = await fixture("photon-lisboa.json");
    const osrm = await fixture("osrm-lisboa-porto.json");

    const fetchImpl = mockFetch([
      {
        match: (url) => url.includes("photon.komoot.io") && url.includes("Lisboa"),
        reply: () => ({ body: photonLisboa.body }),
      },
      {
        match: (url) => url.includes("photon.komoot.io") && url.includes("Porto"),
        reply: () => ({ body: photon.body }),
      },
      { match: (url) => url.includes("router.project-osrm.org"), reply: () => ({ body: osrm.body }) },
    ]);

    // 1) usuario cola o link
    const parsed = parseMapsUrl("https://www.google.com/maps/dir/Lisboa/Porto");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "directions");

    // 2) geocodifica origem, waypoints e destino
    const origin = await geocodePlace(parsed.origin, { fetchImpl });
    const destination = await geocodePlace(parsed.destination, { fetchImpl });
    assert.equal(origin.needsGeocode, false);
    assert.equal(destination.needsGeocode, false);

    // 3) calcula a rota
    const routeResult = await fetchRoute({
      places: [origin, destination],
      profile: parsed.travelmode || "driving",
      alternatives: 1,
      fetchImpl,
    });
    assert.equal(routeResult.ok, true);
    assert.equal(routeResult.source, "osrm");
    assert.equal(routeResult.routes.length, 2);

    const route = routeResult.routes[0];
    const stats = routeStats(route.points);
    assert.ok(stats.distanceKm > 280 && stats.distanceKm < 340, "distancia: " + stats.distanceKm);

    // 4) gera o GPX
    const gpx = buildGpx({
      name: "Lisboa - Porto",
      desc: "Rota gerada a partir do Google Maps",
      points: route.points,
      waypoints: parsed.waypoints,
    });
    const trkpts = gpx.match(/<trkpt /g) || [];
    assert.equal(trkpts.length, route.points.length);
    assert.ok(trkpts.length > 2000, "trkpts: " + trkpts.length);
    assert.equal(toFileName("Lisboa - Porto"), "lisboa-porto.gpx");

    // 5) GeoJSON para o mapa
    const geojson = buildGeoJSON(route.points, { name: "Lisboa - Porto" });
    assert.equal(geojson.features[0].geometry.coordinates.length, route.points.length);
    assert.deepEqual(geojson.features[0].geometry.coordinates[0], [route.points[0].lng, route.points[0].lat]);
  });

  test("rota bike usa Valhalla e o GPX sai com elevacao do Open-Meteo", async () => {
    const valhalla = await fixture("valhalla-lisboa-sintra-bicycle.json");
    const fetchImpl = mockFetch([
      { match: (url) => url.includes("valhalla"), reply: () => ({ body: valhalla.body }) },
      {
        match: (url) => url.includes("open-meteo.com"),
        reply: (url) => {
          const latitude = decodeURIComponent(url).split("latitude=")[1].split("&")[0];
          const count = latitude.split(",").length;
          const elevation = [];
          for (let i = 0; i < count; i += 1) elevation.push(60 + i);
          return { body: { elevation: elevation } };
        },
      },
    ]);

    const parsed = parseMapsUrl(
      "https://www.google.com/maps/dir/?api=1&origin=38.7223,-9.1393&destination=38.8029,-9.3817&travelmode=bicycling"
    );
    assert.equal(parsed.travelmode, "bicycling");
    assert.equal(parsed.origin.needsGeocode, false);

    const routeResult = await fetchRoute({
      places: [parsed.origin, parsed.destination],
      profile: parsed.travelmode,
      fetchImpl,
    });
    assert.equal(routeResult.ok, true);
    assert.equal(routeResult.source, "valhalla");
    const points = routeResult.routes[0].points;
    assert.ok(points.length > 100);

    const withElevation = await addElevation(points, { fetchImpl });
    assert.equal(withElevation.length, points.length);
    assert.equal(withElevation[0].ele, 60);

    const stats = routeStats(withElevation);
    assert.equal(stats.hasElevation, true);
    assert.ok(stats.maxElevation > stats.minElevation);

    const gpx = buildGpx({ name: "Lisboa - Sintra (bike)", points: withElevation, elevation: true });
    const eles = gpx.match(/<ele>/g) || [];
    assert.equal(eles.length, withElevation.length);
    assert.ok(gpx.includes("<wpt "));
  });

  test("bike acima de 150 km cai no BRouter e ainda gera GPX", async () => {
    const brouter = await fixture("brouter-trekking-short.json");
    const fetchImpl = mockFetch([
      { match: (url) => url.includes("valhalla"), reply: () => ({ status: 400, body: { error_code: 154, error: "Path distance exceeds the max distance limit: 150000 meters" } }) },
      { match: (url) => url.includes("brouter"), reply: () => ({ body: brouter.body }) },
    ]);

    const result = await fetchRoute({
      places: [{ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 }],
      profile: "bicycling",
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "brouter");
    const gpx = buildGpx({ name: "Longa de bike", points: result.routes[0].points });
    assert.ok((gpx.match(/<trkpt /g) || []).length > 10);
  });

  test("resolvePlaces geocodifica origem, waypoints e destino em ordem", async () => {
    const photon = await fixture("photon-porto.json");
    const photonLisboa = await fixture("photon-lisboa.json");
    const fetchImpl = mockFetch([
      { match: (url) => url.includes("photon.komoot.io") && url.includes("Lisboa"), reply: () => ({ body: photonLisboa.body }) },
      { match: (url) => url.includes("photon.komoot.io") && url.includes("Porto"), reply: () => ({ body: photon.body }) },
    ]);

    const parsed = parseMapsUrl("https://www.google.com/maps/dir/Lisboa/Porto");
    const resolved = await resolvePlaces(parsed, { fetchImpl });

    assert.equal(resolved.places.length, 2);
    assert.equal(resolved.origin.needsGeocode, false);
    assert.equal(resolved.destination.needsGeocode, false);
    assert.equal(resolved.waypoints.length, 0);
    assert.ok(Math.abs(resolved.origin.lat - 38.7) < 1, "origem Lisboa");
    assert.ok(Math.abs(resolved.destination.lat - 41.15) < 0.1, "destino Porto");
    // a ordem enviada a fetchRoute e origem -> destino
    assert.deepEqual(resolved.places[0], resolved.origin);
    assert.deepEqual(resolved.places[1], resolved.destination);
  });

  test("resolvePlaces rejeita link curto e link invalido", async () => {
    await assert.rejects(
      () => resolvePlaces(parseMapsUrl("https://maps.app.goo.gl/abc")),
      (error) => error.code === "short-link-needs-proxy"
    );
    await assert.rejects(
      () => resolvePlaces(parseMapsUrl("nao e url")),
      (error) => error instanceof Error
    );
  });

  test("link curto sem servidor local explica o que fazer", async () => {
    // resolveShortLink precisa de proxy: sem apiBase lanca short-link-needs-proxy.
    await assert.rejects(
      () => resolveShortLink("https://maps.app.goo.gl/abc123"),
      (error) => error.code === "short-link-needs-proxy" && /npm start/i.test(error.message)
    );

    // fetchRoute sem pontos suficientes nao lanca: devolve ok:false com code.
    const result = await fetchRoute({ places: [] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "not-enough-points");
    assert.ok(result.error.message.includes("2 pontos"));
  });
});
