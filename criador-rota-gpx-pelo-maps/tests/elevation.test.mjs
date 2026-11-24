import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  addElevation,
  fetchElevationBatch,
  buildOpenMeteoUrl,
  chunk,
  ElevationError,
  ELEVATION_BATCH_SIZE,
} from "../js/core/elevation.js";

const fixture = async (name) => JSON.parse(await readFile(new URL("./fixtures/" + name, import.meta.url), "utf8"));

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
      url: String(url),
      headers: { get: () => "application/json" },
      json: async () => result.body,
    };
  };
  impl.calls = calls;
  return impl;
}

function makePoints(count) {
  const points = [];
  for (let i = 0; i < count; i += 1) points.push({ lat: 38 + i / 1000, lng: -9 - i / 1000 });
  return points;
}

describe("chunk e URL do Open-Meteo", () => {
  test("chunk divide em lotes do tamanho pedido", () => {
    assert.equal(chunk([1, 2, 3, 4, 5], 2).length, 3);
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2)[2], [5]);
    assert.deepEqual(chunk([], 100), []);
    assert.equal(ELEVATION_BATCH_SIZE, 100);
  });

  test("buildOpenMeteoUrl usa latitude e longitude na ordem dos pontos", () => {
    const url = buildOpenMeteoUrl([{ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 }]);
    assert.equal(url, "https://api.open-meteo.com/v1/elevation?latitude=38.7223,41.1579&longitude=-9.1393,-8.6291");
  });
});

describe("fetchElevationBatch", () => {
  test("le o fixture real do Open-Meteo", async () => {
    const data = await fixture("open-meteo-elevation.json");
    const fetchImpl = mockFetch(() => ({ body: data.body }));
    const values = await fetchElevationBatch(
      [{ lat: 38.7223, lng: -9.1393 }, { lat: 38.75, lng: -9.25 }, { lat: 38.8029, lng: -9.3817 }],
      { fetchImpl }
    );
    assert.deepEqual(values, data.body.elevation);
    assert.equal(fetchImpl.calls[0].url.startsWith("https://api.open-meteo.com/v1/elevation?"), true);
  });

  test("rejeita lote acima de 100 sem chamar a rede", async () => {
    const fetchImpl = mockFetch(() => ({ body: { elevation: [] } }));
    await assert.rejects(() => fetchElevationBatch(makePoints(101), { fetchImpl }), (error) => {
      assert.equal(error instanceof ElevationError, true);
      assert.equal(error.code, "batch_too_large");
      return true;
    });
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("resposta com tamanho diferente do pedido falha", async () => {
    const fetchImpl = mockFetch(() => ({ body: { elevation: [10] } }));
    await assert.rejects(() => fetchElevationBatch(makePoints(3), { fetchImpl }), /valores para 3 pontos/);
  });

  test("com apiBase usa /api/elevation", async () => {
    const fetchImpl = mockFetch(() => ({ body: { ok: true, elevations: [1, 2, 3] } }));
    const values = await fetchElevationBatch(makePoints(3), { apiBase: "/api", fetchImpl });
    assert.deepEqual(values, [1, 2, 3]);
    assert.ok(fetchImpl.calls[0].url.startsWith("/api/elevation?points="));
    assert.ok(fetchImpl.calls[0].url.includes(encodeURIComponent("38,-9;38.001,-9.001")));
  });

  test("erro HTTP vira ElevationError", async () => {
    const fetchImpl = mockFetch(() => ({ status: 429, body: {} }));
    await assert.rejects(() => fetchElevationBatch(makePoints(2), { fetchImpl }), (error) => {
      assert.equal(error.code, "http_error");
      return true;
    });
  });
});

describe("addElevation", () => {
  test("adiciona ele em lotes de 100 e reporta progresso", async () => {
    const fetchImpl = mockFetch((url) => {
      const latitude = decodeURIComponent(url).split("latitude=")[1].split("&")[0];
      const count = latitude.split(",").length;
      const values = [];
      for (let i = 0; i < count; i += 1) values.push(100 + i);
      return { body: { elevation: values } };
    });
    const points = makePoints(250);
    const progress = [];
    const result = await addElevation(points, {
      fetchImpl,
      onProgress: (done, total) => progress.push(done + "/" + total),
    });

    assert.equal(result.length, 250);
    assert.equal(fetchImpl.calls.length, 3, "250 pontos = 3 lotes");
    assert.deepEqual(progress, ["100/250", "200/250", "250/250"]);
    for (const point of result) {
      assert.equal(typeof point.lat, "number");
      assert.equal(typeof point.lng, "number");
      assert.equal(typeof point.ele, "number");
    }
    assert.equal(result[0].ele, 100);
    assert.equal(result[100].ele, 100, "primeiro ponto do segundo lote");
  });

  test("lista vazia devolve lista vazia sem rede", async () => {
    const fetchImpl = mockFetch(() => ({ body: { elevation: [] } }));
    assert.deepEqual(await addElevation([], { fetchImpl }), []);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("allowPartial:true nao derruba tudo quando um lote falha", async () => {
    const fetchImpl = mockFetch((url, init, call) => {
      if (call === 2) return { status: 500, body: {} };
      const latitude = decodeURIComponent(url).split("latitude=")[1].split("&")[0];
      return { body: { elevation: latitude.split(",").map(() => 42) } };
    });
    const result = await addElevation(makePoints(150), { fetchImpl, allowPartial: true });
    assert.equal(result.length, 150);
    assert.equal(result[0].ele, 42);
    assert.equal(result[100].ele, null, "lote que falhou fica sem ele");
  });

  test("allowPartial:false (padrao) propaga o erro", async () => {
    const fetchImpl = mockFetch(() => ({ status: 500, body: {} }));
    await assert.rejects(() => addElevation(makePoints(3), { fetchImpl }), ElevationError);
  });

  test("pontos com coordenadas invalidas falham antes da rede", async () => {
    const fetchImpl = mockFetch(() => ({ body: {} }));
    await assert.rejects(() => addElevation([{ lat: 1 }, { lat: 2, lng: 3 }], { fetchImpl }), /coordenadas invalidas/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("aceita lon no lugar de lng e preserva ele existente", async () => {
    const fetchImpl = mockFetch(() => ({ body: { elevation: [7, 9] } }));
    const result = await addElevation([{ lat: 1, lon: 2 }, { lat: 3, lng: 4, ele: 55 }], { fetchImpl });
    assert.equal(result[0].lng, 2);
    assert.equal(result[1].ele, 9, "valor do servico tem prioridade");
  });
});
