import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  geocodePlace,
  geocodeQuery,
  geocodeWithPhoton,
  geocodeWithNominatim,
  resolveShortLink,
  placeFromPhotonFeature,
  photonDisplayName,
  GeocodeError,
} from "../js/core/geocode.js";

const fixture = async (name) => JSON.parse(await readFile(new URL("./fixtures/" + name, import.meta.url), "utf8"));

function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const result = await handler(String(url), init || {});
    if (result instanceof Error) throw result;
    const status = result.status === undefined ? 200 : result.status;
    return {
      ok: status >= 200 && status < 300,
      status: status,
      url: result.url || String(url),
      headers: { get: () => "application/json" },
      json: async () => result.body,
    };
  };
  impl.calls = calls;
  return impl;
}

describe("Photon (provedor padrao no browser, sem chave)", () => {
  test("geocodeWithPhoton le o fixture real de Porto", async () => {
    const data = await fixture("photon-porto.json");
    const fetchImpl = mockFetch(() => ({ body: data.body }));
    const places = await geocodeWithPhoton("Porto", { fetchImpl, limit: 2 });

    assert.equal(places.length, 2);
    const porto = places[0];
    assert.equal(porto.lat, 41.1502195);
    assert.equal(porto.lng, -8.6103497);
    assert.equal(porto.needsGeocode, false);
    assert.equal(porto.sourceHint, "photon");
    assert.equal(porto.raw, "Porto");
    assert.ok(porto.displayName.includes("Porto"));
    assert.ok(porto.displayName.includes("Portugal"));
    assert.equal(fetchImpl.calls[0].url.startsWith("https://photon.komoot.io/api/?q=Porto"), true);
    assert.ok(fetchImpl.calls[0].url.includes("limit=2"));
  });

  test("geocodeWithPhoton le o fixture de Lisboa", async () => {
    const data = await fixture("photon-lisboa.json");
    const fetchImpl = mockFetch(() => ({ body: data.body }));
    const places = await geocodeWithPhoton("Avenida da Liberdade, Lisboa", { fetchImpl });
    assert.ok(places.length >= 1);
    const first = places[0];
    assert.ok(Math.abs(first.lat - 38.72) < 0.2, "lat: " + first.lat);
    assert.ok(Math.abs(first.lng - -9.14) < 0.2, "lng: " + first.lng);
  });

  test("placeFromPhotonFeature devolve null para feature sem coordenadas", () => {
    assert.equal(placeFromPhotonFeature({ geometry: { coordinates: [] }, properties: {} }, "x"), null);
    assert.equal(placeFromPhotonFeature({ geometry: null }, "x"), null);
    assert.equal(placeFromPhotonFeature(null, "x"), null);
  });

  test("photonDisplayName monta endereco legivel", () => {
    const name = photonDisplayName({ street: "Avenida da Liberdade", city: "Lisboa", country: "Portugal" });
    assert.equal(name, "Avenida da Liberdade, Lisboa, Portugal");
    const withNumber = photonDisplayName({ street: "Rua X", housenumber: "10", city: "Porto" });
    assert.equal(withNumber, "Rua X, 10, Porto");
  });

  test("erro HTTP do Photon vira GeocodeError http_error", async () => {
    const fetchImpl = mockFetch(() => ({ status: 500, body: {} }));
    await assert.rejects(() => geocodeWithPhoton("x", { fetchImpl }), (error) => {
      assert.equal(error instanceof GeocodeError, true);
      assert.equal(error.code, "http_error");
      return true;
    });
  });

  test("resposta sem features devolve lista vazia", async () => {
    const fetchImpl = mockFetch(() => ({ body: { features: [] } }));
    assert.deepEqual(await geocodeWithPhoton("zzz", { fetchImpl }), []);
  });
});

describe("geocodeQuery", () => {
  test("sem apiBase usa apenas Photon", async () => {
    const data = await fixture("photon-porto.json");
    const fetchImpl = mockFetch(() => ({ body: data.body }));
    const place = await geocodeQuery("Porto", { fetchImpl });
    assert.equal(place.needsGeocode, false);
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(fetchImpl.calls[0].url.includes("photon.komoot.io"));
  });

  test("lanca not_found quando nenhum provedor acha", async () => {
    const fetchImpl = mockFetch(() => ({ body: { features: [] } }));
    await assert.rejects(() => geocodeQuery("lugar inexistente xyz", { fetchImpl }), (error) => {
      assert.equal(error.code, "not_found");
      assert.ok(error.message.includes("Nao encontramos"));
      return true;
    });
  });

  test("query vazia lanca empty_query sem chamar a rede", async () => {
    const fetchImpl = mockFetch(() => ({ body: { features: [] } }));
    await assert.rejects(() => geocodeQuery("   ", { fetchImpl }), /Informe um endereco/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("com apiBase tenta Nominatim (proxy) primeiro", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.startsWith("/api/geocode")) {
        return { body: { ok: true, results: [{ lat: 41.15, lng: -8.61, displayName: "Porto, Portugal" }] } };
      }
      return { body: { features: [] } };
    });
    const place = await geocodeQuery("Porto", { apiBase: "/api", fetchImpl });
    assert.equal(place.lat, 41.15);
    assert.equal(place.lng, -8.61);
    assert.equal(place.sourceHint, "nominatim");
    assert.equal(place.displayName, "Porto, Portugal");
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(fetchImpl.calls[0].url.startsWith("/api/geocode?q=Porto"));
  });

  test("com apiBase cai para Photon se o proxy falhar", async () => {
    const data = await fixture("photon-porto.json");
    const fetchImpl = mockFetch((url) => {
      if (url.startsWith("/api/geocode")) return { status: 500, body: {} };
      return { body: data.body };
    });
    const place = await geocodeQuery("Porto", { apiBase: "/api", fetchImpl });
    assert.equal(place.sourceHint, "photon");
    assert.equal(fetchImpl.calls.length, 2);
  });
});

describe("geocodePlace", () => {
  test("place que ja tem lat/lng nao chama a rede", async () => {
    const fetchImpl = mockFetch(() => ({ body: {} }));
    const place = await geocodePlace({ raw: "x", lat: 38.7, lng: -9.1, needsGeocode: true }, { fetchImpl });
    assert.equal(place.lat, 38.7);
    assert.equal(place.needsGeocode, false);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("place sem coordenadas e geocodificado", async () => {
    const data = await fixture("photon-porto.json");
    const fetchImpl = mockFetch(() => ({ body: data.body }));
    const place = await geocodePlace({ raw: "Porto", name: "Porto", needsGeocode: true }, { fetchImpl });
    assert.equal(place.needsGeocode, false);
    assert.equal(place.lat, 41.1502195);
    assert.equal(place.raw, "Porto");
  });

  test("place invalido lanca erro claro", async () => {
    await assert.rejects(() => geocodePlace(null), /Local invalido/);
    await assert.rejects(() => geocodePlace({ needsGeocode: true }), /sem nome nem coordenadas/);
  });
});

describe("resolveShortLink", () => {
  test("link curto com apiBase chama /api/expand e devolve parsed", async () => {
    const fetchImpl = mockFetch(() => ({
      body: {
        ok: true,
        finalUrl: "https://www.google.com/maps/place/Museu+Calouste+Gulbenkian/@38.7365,-9.1536,17z",
        lat: 38.7365,
        lng: -9.1536,
        placeName: "Museu Calouste Gulbenkian",
        source: "html",
      },
    }));
    const result = await resolveShortLink("https://maps.app.goo.gl/xyz987", { apiBase: "/api", fetchImpl });
    assert.equal(result.finalUrl.includes("/maps/place/"), true);
    assert.equal(result.parsed.ok, true);
    assert.ok(fetchImpl.calls[0].url.startsWith("/api/expand?url="));
    assert.ok(fetchImpl.calls[0].url.includes(encodeURIComponent("https://maps.app.goo.gl/xyz987")));
  });

  test("link curto sem apiBase lanca short-link-needs-proxy", async () => {
    await assert.rejects(() => resolveShortLink("https://maps.app.goo.gl/xyz987", {}), (error) => {
      assert.equal(error instanceof GeocodeError, true);
      assert.equal(error.code, "short-link-needs-proxy");
      assert.ok(/npm start/i.test(error.message));
      return true;
    });
  });

  test("URL normal (nao curta) volta sem rede", async () => {
    const fetchImpl = mockFetch(() => ({ body: {} }));
    const result = await resolveShortLink("https://www.google.com/maps/dir/Lisboa/Porto", { fetchImpl });
    assert.equal(result.parsed.kind, "directions");
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("servidor devolve erro de expansao", async () => {
    const fetchImpl = mockFetch(() => ({ body: { ok: false, error: "Host nao permitido", error_type: "bad_host" } }));
    await assert.rejects(() => resolveShortLink("https://goo.gl/maps/abc", { apiBase: "/api", fetchImpl }), /Host nao permitido/);
  });

  test("URL vazia lanca invalid_url", async () => {
    await assert.rejects(() => resolveShortLink(""), /Informe o link curto/);
  });
});
