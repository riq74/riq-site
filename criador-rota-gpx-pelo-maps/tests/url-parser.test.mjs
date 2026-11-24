import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseMapsUrl, parseCoordsText, parseDataCoords } from "../js/core/url-parser.js";

describe("parseMapsUrl - direcoes por caminho", () => {
  test("/maps/dir/A/B devolve origem e destino", () => {
    const result = parseMapsUrl("https://www.google.com/maps/dir/Lisboa/Porto");
    assert.equal(result.ok, true);
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.raw, "Lisboa");
    assert.equal(result.origin.needsGeocode, true);
    assert.equal(result.destination.raw, "Porto");
    assert.deepEqual(result.waypoints, []);
    assert.equal(result.normalizedUrl, "https://www.google.com/maps/dir/Lisboa/Porto");
  });

  test("/dir/A/B/C/D cria dois waypoints na ordem", () => {
    const result = parseMapsUrl("https://www.google.com/maps/dir/Lisboa/Sintra/Cascais/Porto");
    assert.equal(result.ok, true);
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.raw, "Lisboa");
    assert.equal(result.destination.raw, "Porto");
    assert.deepEqual(result.waypoints.map((w) => w.raw), ["Sintra", "Cascais"]);
  });

  test("nomes com + e acentos sao decodificados", () => {
    const result = parseMapsUrl("https://www.google.com/maps/dir/S%C3%A3o+Paulo/Rio+de+Janeiro");
    assert.equal(result.origin.raw, "São Paulo");
    assert.equal(result.destination.raw, "Rio de Janeiro");
  });

  test("origem vazia (/dir//Porto) nao inventa origem", () => {
    const result = parseMapsUrl("https://www.google.com/maps/dir//Porto");
    assert.equal(result.ok, true);
    assert.equal(result.origin, null);
    assert.equal(result.destination.raw, "Porto");
  });

  test("query string extra (data=, !) e ignorada", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/Lisboa/Porto/data=!4m2!4m1!3e0?entry=ttu",
    );
    assert.equal(result.origin.raw, "Lisboa");
    assert.equal(result.destination.raw, "Porto");
  });
});

describe("parseMapsUrl - parametros de API", () => {
  test("?api=1&origin&destination&waypoints com separador |", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/?api=1&origin=Porto&destination=Lisboa&waypoints=Coimbra%7CAveiro&travelmode=bicycling",
    );
    assert.equal(result.ok, true);
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.raw, "Porto");
    assert.equal(result.destination.raw, "Lisboa");
    assert.deepEqual(result.waypoints.map((w) => w.raw), ["Coimbra", "Aveiro"]);
    assert.equal(result.travelmode, "bicycling");
  });

  test("?api=1 sem waypoints funciona", () => {
    const result = parseMapsUrl("https://www.google.com/maps/dir/?api=1&origin=Braga&destination=Faro");
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.raw, "Braga");
    assert.equal(result.destination.raw, "Faro");
    assert.deepEqual(result.waypoints, []);
  });

  test("?api=1 com coordenadas na query nao precisa geocodificar", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/?api=1&origin=-9.1393,38.7223&destination=-8.6291,41.1579",
    );
    assert.equal(result.origin.needsGeocode, false);
    assert.equal(result.origin.lat, -9.1393);
    assert.equal(result.origin.lng, 38.7223);
    assert.equal(result.destination.lat, -8.6291);
  });
});

describe("parseMapsUrl - coordenadas", () => {
  test("coords em segmentos de /dir/", () => {
    const result = parseMapsUrl("https://www.google.com/maps/dir/-9.1393,38.7223/-8.6291,41.1579");
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.needsGeocode, false);
    assert.equal(result.origin.lat, -9.1393);
    assert.equal(result.origin.lng, 38.7223);
    assert.equal(result.destination.lat, -8.6291);
    assert.equal(result.destination.lng, 41.1579);
  });

  test("parseCoordsText valida faixas", () => {
    assert.deepEqual(parseCoordsText("-9.1393,38.7223"), { lat: -9.1393, lng: 38.7223 });
    assert.equal(parseCoordsText("91,0"), null);
    assert.equal(parseCoordsText("0,181"), null);
    assert.equal(parseCoordsText("abc"), null);
    assert.equal(parseCoordsText("38.7223"), null);
  });

  test("/maps?q=lat,lng vira kind coords", () => {
    const result = parseMapsUrl("https://www.google.com/maps?q=-9.1393,38.7223");
    assert.equal(result.ok, true);
    assert.equal(result.kind, "coords");
    assert.equal(result.origin.lat, -9.1393);
    assert.equal(result.origin.lng, 38.7223);
    assert.equal(result.origin.needsGeocode, false);
  });
});

describe("parseMapsUrl - @lat,lng (viewport)", () => {
  test("@lat,lng,15z em link de direcoes vira mapCenter e NAO ponto da rota", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/Lisboa/Porto/@39.5,-8.2,15z/data=!4m2!4m1!3e0",
    );
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.raw, "Lisboa");
    assert.equal(result.origin.needsGeocode, true);
    assert.equal(result.origin.lat, undefined);
    assert.deepEqual(result.mapCenter, { lat: 39.5, lng: -8.2, zoom: 15 });
  });

  test("viewport diferente do lugar nunca contamina os pontos", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/Porto/Lisboa/@-23.67,-46.56,11z",
    );
    assert.equal(result.origin.raw, "Porto");
    assert.equal(result.destination.raw, "Lisboa");
    assert.equal(result.origin.lat, undefined);
    assert.equal(result.destination.lng, undefined);
    assert.deepEqual(result.mapCenter, { lat: -23.67, lng: -46.56, zoom: 11 });
  });

  test("/maps/place/Nome/@lat,lng usa o ponto do lugar", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/place/Museu+Calouste+Gulbenkian/@38.7365,-9.1536,17z",
    );
    assert.equal(result.ok, true);
    assert.equal(result.kind, "place");
    assert.equal(result.origin.name, "Museu Calouste Gulbenkian");
    assert.equal(result.origin.needsGeocode, false);
    assert.equal(result.origin.lat, 38.7365);
    assert.equal(result.origin.lng, -9.1536);
  });

  test("/maps/place com !3d!4d usa o pino exato", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/place/Porto/@41.15,-8.61,13z/data=!4m2!3d41.1579!4d-8.6291",
    );
    assert.equal(result.origin.lat, 41.1579);
    assert.equal(result.origin.lng, -8.6291);
  });
});

describe("parseMapsUrl - busca e links curtos", () => {
  test("/maps?q=Nome vira kind place aguardando geocode", () => {
    const result = parseMapsUrl("https://www.google.com/maps?q=Avenida+Paulista,+S%C3%A3o+Paulo");
    assert.equal(result.ok, true);
    assert.equal(result.kind, "place");
    assert.equal(result.origin.name, "Avenida Paulista, São Paulo");
    assert.equal(result.origin.needsGeocode, true);
  });

  test("goo.gl/maps/xxx vira kind short", () => {
    const result = parseMapsUrl("https://goo.gl/maps/abc123XYZ");
    assert.equal(result.ok, true);
    assert.equal(result.kind, "short");
    assert.equal(result.origin, null);
    assert.equal(result.destination, null);
  });

  test("maps.app.goo.gl/xxx vira kind short", () => {
    const result = parseMapsUrl("https://maps.app.goo.gl/xyz987");
    assert.equal(result.ok, true);
    assert.equal(result.kind, "short");
  });
});

describe("parseMapsUrl - My Maps e erros", () => {
  test("/maps/d/... e My Maps (unsupported + reason my_maps)", () => {
    const result = parseMapsUrl("https://www.google.com/maps/d/viewer?mid=1abcDEF&ll=38.7,-9.1&z=11");
    assert.equal(result.ok, false);
    assert.equal(result.kind, "unsupported");
    assert.equal(result.reason, "my_maps");
    assert.equal(result.normalizedUrl.startsWith("https://www.google.com/maps/d/"), true);
  });

  test("texto que nao e URL vira invalid_url", () => {
    for (const input of ["", "   ", "isso nao e uma url", "javascript:alert(1)", "http://"]) {
      const result = parseMapsUrl(input);
      assert.equal(result.ok, false, "deveria falhar: " + JSON.stringify(input));
      assert.equal(result.kind, "unsupported");
      assert.equal(result.reason, "invalid_url");
    }
  });

  test("URL de outro site vira unsupported_host", () => {
    const result = parseMapsUrl("https://www.example.com/maps/dir/A/B");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsupported_host");
  });

  test("entrada sem protocolo e aceita", () => {
    const result = parseMapsUrl("www.google.com/maps/dir/Lisboa/Porto");
    assert.equal(result.ok, true);
    assert.equal(result.normalizedUrl, "https://www.google.com/maps/dir/Lisboa/Porto");
  });

  test("nunca lanca excecao", () => {
    for (const input of [null, undefined, 42, {}, [], "%", "https://"]) {
      assert.doesNotThrow(() => parseMapsUrl(input));
      assert.equal(parseMapsUrl(input).ok, false);
    }
  });
});

describe("parseMapsUrl - coordenadas exatas no bloco data= (!2m2!1d!2d)", () => {
  const FIXTURE_URL =
    "https://www.google.com/maps/dir/38.7223,-9.1393/Lugar+Fict%C3%ADcio/" +
    "@39,-8,12z/data=!3m1!4b1!4m9!4m8!1m0!1m5!1m1!1s0x1:0x2!2m2!1d-8.6291!2d41.1579!3e0?entry=tts";

  test("destino nomeado recebe as coordenadas do bloco data=", () => {
    const result = parseMapsUrl(FIXTURE_URL);
    assert.equal(result.ok, true);
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.needsGeocode, false);
    assert.equal(result.origin.lat, 38.7223);
    assert.equal(result.origin.lng, -9.1393);
    assert.equal(result.destination.needsGeocode, false);
    assert.equal(result.destination.lat, 41.1579);
    assert.equal(result.destination.lng, -8.6291);
    assert.equal(result.destination.name, "Lugar Fictício");
    assert.equal(result.destination.sourceHint, "path+data");
    assert.deepEqual(result.mapCenter, { lat: 39, lng: -8, zoom: 12 });
    assert.notEqual(result.destination.lat, result.mapCenter.lat);
  });

  test("dataCoords expoe os pares crus para depuracao", () => {
    const result = parseMapsUrl(FIXTURE_URL);
    assert.deepEqual(result.dataCoords, [{ lat: 41.1579, lng: -8.6291 }]);
  });

  test("parseDataCoords le !2m2!1dLNG!2dLAT na ordem", () => {
    const pairs = parseDataCoords("!4m9!1m5!2m2!1d-46.5630739!2d-23.6849865!2m2!1d-9.1393!2d38.7223");
    assert.deepEqual(pairs, [
      { lat: -23.6849865, lng: -46.5630739 },
      { lat: 38.7223, lng: -9.1393 },
    ]);
  });

  test("parseDataCoords aceita a variante !2d!1d e ignora valores invalidos", () => {
    assert.deepEqual(parseDataCoords("!2m2!2d-23.6!1d-46.5"), [{ lat: -23.6, lng: -46.5 }]);
    assert.deepEqual(parseDataCoords("!2m2!1d999!2d-46.5"), []);
    assert.deepEqual(parseDataCoords(""), []);
    assert.deepEqual(parseDataCoords(null), []);
  });

  test("com 2 pontos nomeados e 2 blocos, cada um recebe o seu par na ordem", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/Ponto+A/Ponto+B/data=!4m2!2m2!1d-46.5!2d-23.6!2m2!1d-46.7!2d-23.8"
    );
    assert.equal(result.origin.needsGeocode, false);
    assert.equal(result.origin.lat, -23.6);
    assert.equal(result.origin.lng, -46.5);
    assert.equal(result.destination.lat, -23.8);
    assert.equal(result.destination.lng, -46.7);
  });

  test("contagem divergente NAO inventa coordenada (deixa para geocode)", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/Ponto+A/Ponto+B/data=!4m2!2m2!1d-46.5!2d-23.6"
    );
    assert.equal(result.origin.needsGeocode, true);
    assert.equal(result.destination.needsGeocode, true);
    assert.equal(result.origin.lat, undefined);
    assert.deepEqual(result.dataCoords, [{ lat: -23.6, lng: -46.5 }]);
  });

  test("pontos que ja eram coordenadas nao consomem os blocos do data=", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/-23.58,-46.65/Nome+do+Lugar/data=!4m2!2m2!1d-46.56!2d-23.68"
    );
    assert.equal(result.origin.needsGeocode, false);
    assert.equal(result.origin.lat, -23.58);
    assert.equal(result.destination.needsGeocode, false);
    assert.equal(result.destination.lat, -23.68);
    assert.equal(result.destination.lng, -46.56);
  });

  test("viewport em link de direcoes continua ignorado", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/Lisboa/Porto/@-23.67,-46.56,11z/data=!3m1!4b1"
    );
    assert.equal(result.origin.lat, undefined);
    assert.equal(result.destination.lat, undefined);
    assert.equal(result.origin.needsGeocode, true);
    assert.deepEqual(result.mapCenter, { lat: -23.67, lng: -46.56, zoom: 11 });
  });

  test("?api=1 tambem aproveita o data= (origem em coords, destino nomeado)", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/?api=1&origin=-23.58,-46.65&destination=Nome+B&data=!4m2!2m2!1d-46.5!2d-23.6"
    );
    assert.equal(result.kind, "directions");
    assert.equal(result.origin.needsGeocode, false);
    assert.equal(result.destination.needsGeocode, false);
    assert.equal(result.destination.lat, -23.6);
    assert.equal(result.destination.lng, -46.5);
  });

  test("?api=1 com 2 nomes e 1 bloco nao adivinha qual ponto recebe", () => {
    const result = parseMapsUrl(
      "https://www.google.com/maps/dir/?api=1&origin=Nome+A&destination=Nome+B&data=!4m2!2m2!1d-46.5!2d-23.6"
    );
    assert.equal(result.origin.needsGeocode, true);
    assert.equal(result.destination.needsGeocode, true);
    assert.deepEqual(result.dataCoords, [{ lat: -23.6, lng: -46.5 }]);
  });
});

describe("parseMapsUrl - modo de viagem", () => {
  test("data=!3eN", () => {
    assert.equal(parseMapsUrl("https://www.google.com/maps/dir/A/B/data=!4m2!3e0").travelmode, "driving");
    assert.equal(parseMapsUrl("https://www.google.com/maps/dir/A/B/data=!4m2!3e1").travelmode, "bicycling");
    assert.equal(parseMapsUrl("https://www.google.com/maps/dir/A/B/data=!4m2!3e2").travelmode, "walking");
    assert.equal(parseMapsUrl("https://www.google.com/maps/dir/A/B/data=!4m2!3e3").travelmode, "transit");
  });

  test("travelmode= e dirflg=", () => {
    assert.equal(parseMapsUrl("https://www.google.com/maps/dir/A/B?travelmode=walking").travelmode, "walking");
    assert.equal(parseMapsUrl("https://www.google.com/maps/dir/A/B?dirflg=b").travelmode, "bicycling");
    assert.equal(parseMapsUrl("https://www.google.com/maps/dir/A/B").travelmode, null);
  });
});
