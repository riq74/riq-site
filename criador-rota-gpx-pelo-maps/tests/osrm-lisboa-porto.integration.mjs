/**
 * Teste de integracao REAL contra o OSRM publico (Lisboa -> Porto).
 *
 * Fica fora do run padrao (nao termina em .test.mjs) para nao depender de rede
 * em CI. Rode com:
 *   node --test tests/osrm-lisboa-porto.integration.mjs
 *
 * O equivalente offline usa tests/fixtures/osrm-lisboa-porto.json.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchRoute } from "../js/core/routing.js";
import { buildGpx, routeStats } from "../js/core/gpx.js";

describe("integracao real: OSRM Lisboa -> Porto", () => {
  test("gera GPX com milhares de trkpt", { timeout: 120000 }, async () => {
    const result = await fetchRoute({
      places: [
        { lat: 38.7223, lng: -9.1393 }, // Lisboa
        { lat: 41.1579, lng: -8.6291 }, // Porto
      ],
      profile: "driving",
      alternatives: 0,
      timeoutMs: 90000,
    });

    assert.equal(result.ok, true, "fetchRoute falhou: " + JSON.stringify(result.attempts));
    assert.equal(result.source, "osrm");

    const route = result.routes[0];
    assert.ok(route.points.length > 2000, "esperava milhares de pontos, veio " + route.points.length);
    assert.ok(route.distanceKm > 300 && route.distanceKm < 340, "distancia: " + route.distanceKm);

    const stats = routeStats(route.points);
    assert.ok(stats.distanceKm > 280, "estatisticas: " + stats.distanceKm);

    const gpx = buildGpx({
      name: "Lisboa - Porto",
      desc: "Rota gerada pelo nucleo (teste de integracao real)",
      points: route.points,
      waypoints: [{ lat: 39.5, lng: -8.5, name: "Parada" }],
    });
    const trkpts = gpx.match(/<trkpt /g) || [];
    assert.equal(trkpts.length, route.points.length);
    assert.ok(trkpts.length > 2000, "trkpts: " + trkpts.length);
    assert.ok(gpx.includes("<wpt "));

    console.log("[integracao] pontos:", route.points.length, "|", route.summary, "| source:", result.source);
  });
});
