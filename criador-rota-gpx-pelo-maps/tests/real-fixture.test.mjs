/**
 * Validacao da geometria REAL capturada das APIs publicas (sem rede).
 *
 * Os fixtures foram gravados uma vez a partir de:
 *  - OSRM demo:  https://router.project-osrm.org/route/v1/driving/... (Lisboa -> Porto)
 *  - Valhalla:   https://valhalla1.openstreetmap.de/route (Lisboa -> Sintra, bicycle)
 *  - BRouter:    https://brouter.de/brouter (trecho curto, trekking)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  routesFromOsrmPayload,
  routesFromValhallaPayload,
  routesFromBrouterPayload,
  decodePolyline,
} from "../js/core/routing.js";
import { buildGpx, haversineKm, routeStats } from "../js/core/gpx.js";

const url = (name) => new URL("./fixtures/" + name, import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(url(name), "utf8"));

describe("fixture OSRM real (Lisboa -> Porto)", () => {
  test("a geometria tem milhares de pontos e cobre o trajeto", async () => {
    const data = await fixture("osrm-lisboa-porto.json");
    assert.equal(data.status, 200);
    assert.equal(data.body.code, "Ok");

    const routes = routesFromOsrmPayload(data.body, 0);
    const points = routes[0].points;
    assert.ok(points.length >= 100, "exigido >= 100 pontos, veio " + points.length);
    assert.ok(points.length > 2000, "esperava milhares de pontos, veio " + points.length);

    // extremos: Lisboa no inicio, Porto no fim
    assert.ok(Math.abs(points[0].lat - 38.7223) < 0.02);
    assert.ok(Math.abs(points[0].lng - -9.1393) < 0.02);
    const last = points[points.length - 1];
    assert.ok(Math.abs(last.lat - 41.1579) < 0.02);
    assert.ok(Math.abs(last.lng - -8.6291) < 0.02);

    // distancia somada pelos pontos ~ distancia informada pelo OSRM
    const summed = points.reduce((total, point, i) => (i === 0 ? 0 : total + haversineKm(points[i - 1], point)), 0);
    assert.ok(Math.abs(summed - routes[0].distanceKm) / routes[0].distanceKm < 0.05, "soma: " + summed + " vs " + routes[0].distanceKm);

    const stats = routeStats(points);
    assert.ok(stats.distanceKm > 280 && stats.distanceKm < 340);
    assert.deepEqual(stats.bounds && Object.keys(stats.bounds), ["minLat", "minLng", "maxLat", "maxLng"]);
  });

  test("gera GPX com um trkpt por ponto da geometria", async () => {
    const data = await fixture("osrm-lisboa-porto.json");
    const route = routesFromOsrmPayload(data.body, 0)[0];
    const gpx = buildGpx({ name: "Lisboa - Porto", points: route.points });
    assert.equal((gpx.match(/<trkpt /g) || []).length, route.points.length);
    assert.ok(gpx.startsWith("<?xml"));
    assert.ok(gpx.endsWith("</gpx>\n"));
  });

  test("o exemplo .real.gpx salvo tem >= 100 pontos e e bem formado", async () => {
    const gpx = await readFile(url("lisboa-porto.osrm.real.gpx"), "utf8");
    const trkpts = gpx.match(/<trkpt [^>]*\/>/g) || [];
    assert.ok(trkpts.length >= 100, "exemplo com " + trkpts.length + " trkpts");
    assert.ok(gpx.includes("<metadata>"));
    assert.ok(gpx.includes("<name>Lisboa - Porto</name>"));
    // tags balanceadas
    assert.equal((gpx.match(/<trkpt /g) || []).length, (gpx.match(/<\/trkpt>|<trkpt [^>]*\/>/g) || []).length);
    assert.equal((gpx.match(/<\/gpx>/g) || []).length, 1);
    // lat/lon plausiveis em todos os pontos
    for (const match of gpx.matchAll(/lat="(-?[\d.]+)" lon="(-?[\d.]+)"/g)) {
      const lat = Number(match[1]);
      const lon = Number(match[2]);
      assert.ok(lat >= 38.5 && lat <= 41.3, "lat fora de Portugal: " + lat);
      assert.ok(lon >= -9.5 && lon <= -8.4, "lon fora de Portugal: " + lon);
    }
  });

  test("o GeoJSON salvo e valido", async () => {
    const geojson = await fixture("lisboa-porto.osrm.real.geojson");
    assert.equal(geojson.type, "FeatureCollection");
    const geometry = geojson.features[0].geometry;
    assert.equal(geometry.type, "LineString");
    assert.ok(geometry.coordinates.length >= 100);
    const [lng, lat] = geometry.coordinates[0];
    assert.ok(Math.abs(lat - 38.7223) < 0.02);
    assert.ok(Math.abs(lng - -9.1393) < 0.02);
  });
});

describe("fixture Valhalla real (Lisboa -> Sintra, bicycle)", () => {
  test("polyline6 decodifica e gera GPX", async () => {
    const data = await fixture("valhalla-lisboa-sintra-bicycle.json");
    assert.equal(data.status, 200);
    const shape = data.body.trip.legs[0].shape;
    const decoded = decodePolyline(shape, 6);
    assert.ok(decoded.length > 1000, "pontos do shape: " + decoded.length);

    const route = routesFromValhallaPayload(data.body)[0];
    assert.ok(route.points.length > 100);
    assert.ok(Math.abs(route.distanceKm - 30.108) < 0.01);
    assert.ok(route.durationMin > 100 && route.durationMin < 200, "duracao (min): " + route.durationMin);

    const gpx = buildGpx({ name: "Lisboa - Sintra", points: route.points });
    assert.equal((gpx.match(/<trkpt /g) || []).length, route.points.length);
  });
});

describe("fixture BRouter real (trekking)", () => {
  test("traz elevacao em cada ponto e tamanho do trajeto", async () => {
    const data = await fixture("brouter-trekking-short.json");
    const route = routesFromBrouterPayload(data.body)[0];
    assert.ok(route.points.length >= 50, "pontos: " + route.points.length);
    for (const point of route.points) {
      assert.equal(typeof point.ele, "number");
    }
    assert.ok(route.distanceKm > 0.5 && route.distanceKm < 5, "distancia: " + route.distanceKm);
    const withEle = buildGpx({ name: "Trecho", points: route.points, elevation: true });
    assert.equal((withEle.match(/<ele>/g) || []).length, route.points.length);
  });
});
