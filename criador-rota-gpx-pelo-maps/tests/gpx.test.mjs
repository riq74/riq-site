import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildGpx,
  buildGeoJSON,
  toFileName,
  routeStats,
  haversineKm,
  escapeXml,
  normalizePoints,
  GPX_NS,
} from "../js/core/gpx.js";

/**
 * Verificador de XML bem formado, sem dependencias:
 * valida pares de tags, auto-fechamento e aspas dos atributos.
 * @param {string} xml
 */
function assertWellFormedXml(xml) {
  assert.equal(typeof xml, "string");
  assert.ok(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"), "deve comecar com a declaracao XML");
  const body = xml.replace(/^<\?xml[^>]*\?>/, "").trim();
  assert.equal(body.length > 0, true, "corpo vazio");

  const tokenRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"<]*")*)\s*(\/?)>/g;
  const stack = [];
  let consumed = 0;
  let match;
  while ((match = tokenRe.exec(body)) !== null) {
    // Texto entre tags e valido, mas nao pode conter "<" cru nem "&" sem entidade.
    const gap = body.slice(consumed, match.index);
    const rawAmp = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(gap);
    assert.equal(gap.includes("<") || rawAmp, false, "texto invalido entre tags: " + JSON.stringify(gap.slice(0, 60)));
    consumed = match.index + match[0].length;
    const closing = match[1] === "/";
    const tag = match[2];
    const selfClosing = match[4] === "/";
    if (closing) {
      const open = stack.pop();
      assert.equal(open, tag, "tag fechada fora de ordem: esperava " + open + ", veio " + tag);
    } else if (!selfClosing) {
      stack.push(tag);
    }
  }
  // nada depois do ultimo token (ignorando \n e \r)
  assert.equal(body.slice(consumed).trim(), "", "sobrou conteudo apos a ultima tag: " + body.slice(consumed).trim());
  assert.deepEqual(stack, [], "tags nao fechadas: " + stack.join(","));
}

const POINTS = [
  { lat: 38.7223, lng: -9.1393 },
  { lat: 39.0, lng: -8.9 },
  { lat: 41.1579, lng: -8.6291 },
];

describe("buildGpx", () => {
  test("gera XML bem formado com raiz GPX 1.1", () => {
    const xml = buildGpx({ name: "Lisboa - Porto", desc: "Rota de teste", points: POINTS });
    assertWellFormedXml(xml);
    assert.ok(xml.includes('xmlns="' + GPX_NS + '"'));
    assert.ok(xml.includes('version="1.1"'));
    assert.ok(xml.includes("<metadata>"));
    assert.ok(xml.includes("<trk>"));
    assert.ok(xml.includes("<trkseg>"));
    assert.equal((xml.match(/<trkpt /g) || []).length, POINTS.length);
  });

  test("faz escaping de & < > \" e '", () => {
    const xml = buildGpx({ name: "A & B <teste> \"x\" 'y'", desc: "1 < 2 & 3 > 2", points: POINTS });
    assertWellFormedXml(xml);
    assert.ok(xml.includes("&amp;"));
    assert.ok(xml.includes("&lt;teste&gt;"));
    assert.ok(xml.includes("&quot;x&quot;"));
    assert.ok(xml.includes("&apos;y&apos;"));
    assert.equal(/A & B/.test(xml), false, "& cru nao pode aparecer");
    assert.equal(/<teste>/.test(xml), false);
  });

  test("escapeXml trata caracteres de controle e nulos", () => {
    assert.equal(escapeXml(null), "");
    assert.equal(escapeXml(undefined), "");
    assert.equal(escapeXml("a\u0001b"), "ab");
    assert.equal(escapeXml("<>&\"'"), "&lt;&gt;&amp;&quot;&apos;");
  });

  test("cria wpt de inicio e fim", () => {
    const xml = buildGpx({ name: "R", points: POINTS });
    const wpts = xml.match(/<wpt [^>]*>[\s\S]*?<\/wpt>/g) || [];
    assert.equal(wpts.length, 2);
    assert.ok(wpts[0].includes("<name>Inicio</name>"));
    assert.ok(wpts[0].includes('lat="38.7223"'));
    assert.ok(wpts[0].includes('lon="-9.1393"'));
    assert.ok(wpts[1].includes("<name>Fim</name>"));
    assert.ok(wpts[1].includes('lat="41.1579"'));
    assert.ok(wpts[1].includes('lon="-8.6291"'));
  });

  test("includeStartEnd:false remove os wpt automaticos", () => {
    const xml = buildGpx({ name: "R", points: POINTS, includeStartEnd: false });
    assertWellFormedXml(xml);
    assert.equal(/<wpt /.test(xml), false);
  });

  test("waypoints extras viram wpt", () => {
    const xml = buildGpx({
      name: "R",
      points: POINTS,
      waypoints: [{ lat: 39.5, lng: -8.5, name: "Parada & Cia" }],
    });
    assertWellFormedXml(xml);
    const wpts = xml.match(/<wpt /g) || [];
    assert.equal(wpts.length, 3);
    assert.ok(xml.includes("Parada &amp; Cia"));
  });

  test("ele e opcional: ausente por padrao", () => {
    const withEleData = POINTS.map((p, i) => ({ ...p, ele: 100 + i * 10 }));
    const semEle = buildGpx({ name: "R", points: withEleData });
    assert.equal(/<ele>/.test(semEle), false);
    assertWellFormedXml(semEle);

    const comEle = buildGpx({ name: "R", points: withEleData, elevation: true });
    assert.equal((comEle.match(/<ele>/g) || []).length, POINTS.length);
    assert.ok(comEle.includes("<ele>100</ele>"));
    assert.ok(comEle.includes("<ele>110</ele>"));
    assertWellFormedXml(comEle);

    // pontos sem altitude continuam validos mesmo com elevation:true
    const semAltitude = buildGpx({ name: "R", points: POINTS, elevation: true });
    assertWellFormedXml(semAltitude);
    assert.equal(/<ele>/.test(semAltitude), false);
  });

  test("um unico ponto nao cria wpt de fim", () => {
    const xml = buildGpx({ name: "R", points: [POINTS[0]] });
    assertWellFormedXml(xml);
    assert.equal((xml.match(/<wpt /g) || []).length, 1);
    assert.equal((xml.match(/<trkpt /g) || []).length, 1);
  });

  test("nome padrao e creator padrao", () => {
    const xml = buildGpx({ points: POINTS });
    assert.ok(xml.includes("<name>Rota</name>"));
    assert.ok(xml.includes("creator=\"RIQ Rota GPX - riq.site\""));
    const custom = buildGpx({ points: POINTS, creator: "Meu App" });
    assert.ok(custom.includes('creator="Meu App"'));
  });

  test("lanca erro claro sem pontos validos", () => {
    assert.throws(() => buildGpx({ points: [] }), /ao menos um ponto/);
    assert.throws(() => buildGpx({}), /ao menos um ponto/);
    assert.throws(() => buildGpx({ points: [{ lat: "x", lng: "y" }] }), /ao menos um ponto/);
  });

  test("ignora pontos invalidos e aceita lon no lugar de lng", () => {
    const xml = buildGpx({ points: [{ lat: 1, lon: 2 }, { lat: "x", lng: 2 }, null] });
    assertWellFormedXml(xml);
    assert.equal((xml.match(/<trkpt /g) || []).length, 1);
    assert.ok(xml.includes('lat="1" lon="2"'));
  });

  test("geracao e deterministica", () => {
    assert.equal(buildGpx({ name: "R", points: POINTS }), buildGpx({ name: "R", points: POINTS }));
  });
});

describe("buildGeoJSON", () => {
  test("FeatureCollection com LineString em [lng,lat]", () => {
    const geojson = buildGeoJSON(POINTS, { name: "Lisboa-Porto" });
    assert.equal(geojson.type, "FeatureCollection");
    assert.equal(geojson.features.length, 1);
    const feature = geojson.features[0];
    assert.equal(feature.geometry.type, "LineString");
    assert.deepEqual(feature.geometry.coordinates[0], [-9.1393, 38.7223]);
    assert.equal(feature.geometry.coordinates.length, POINTS.length);
    assert.equal(feature.properties.name, "Lisboa-Porto");
  });

  test("inclui altitude como terceira coordenada quando existir", () => {
    const geojson = buildGeoJSON([{ lat: 1, lng: 2, ele: 30 }]);
    assert.deepEqual(geojson.features[0].geometry.coordinates[0], [2, 1, 30]);
  });

  test("lista vazia gera LineString vazia", () => {
    const geojson = buildGeoJSON([]);
    assert.deepEqual(geojson.features[0].geometry.coordinates, []);
  });
});

describe("toFileName", () => {
  test("gera nome seguro e com extensao .gpx", () => {
    assert.equal(toFileName("Lisboa - Porto"), "lisboa-porto.gpx");
    assert.equal(toFileName("Rota São Paulo → Rio & Cia!"), "rota-sao-paulo-rio-cia.gpx");
    assert.equal(toFileName("Rota 2026/01"), "rota-2026-01.gpx");
  });

  test("nao duplica a extensao", () => {
    assert.equal(toFileName("rota.gpx"), "rota.gpx");
    assert.equal(toFileName("ROTA.GPX"), "rota.gpx");
  });

  test("fallback quando o nome fica vazio", () => {
    assert.equal(toFileName(""), "rota.gpx");
    assert.equal(toFileName(null), "rota.gpx");
    assert.equal(toFileName("***"), "rota.gpx");
    assert.equal(toFileName("", "minha-rota"), "minha-rota.gpx");
  });

  test("limita o tamanho", () => {
    const long = "a".repeat(200);
    assert.equal(toFileName(long).length <= 84, true);
  });
});

describe("haversineKm e routeStats", () => {
  test("haversine confere com a referencia", () => {
    // 1 grau de latitude ~ 111,19 km
    const d = haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    assert.ok(d > 111.1 && d < 111.3, "1 grau de latitude: " + d);
    // Lisboa -> Porto em linha reta ~ 274 km
    const lisPorto = haversineKm({ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 });
    assert.ok(lisPorto > 270 && lisPorto < 280, "Lisboa-Porto: " + lisPorto);
    // distancia de um ponto a ele mesmo
    assert.equal(haversineKm({ lat: 10, lng: 10 }, { lat: 10, lng: 10 }), 0);
  });

  test("routeStats soma segmentos e calcula bounds", () => {
    const stats = routeStats(POINTS);
    assert.equal(stats.pointCount, 3);
    assert.equal(stats.hasElevation, false);
    assert.equal(stats.ascentM, null);
    const manual =
      haversineKm(POINTS[0], POINTS[1]) + haversineKm(POINTS[1], POINTS[2]);
    assert.ok(Math.abs(stats.distanceKm - manual) < 1e-9);
    assert.ok(stats.distanceKm > 150);
    assert.deepEqual(stats.bounds, { minLat: 38.7223, minLng: -9.1393, maxLat: 41.1579, maxLng: -8.6291 });
  });

  test("routeStats calcula ganho e perda de altitude", () => {
    const stats = routeStats([
      { lat: 0, lng: 0, ele: 100 },
      { lat: 0.01, lng: 0, ele: 150 },
      { lat: 0.02, lng: 0, ele: 120 },
    ]);
    assert.equal(stats.hasElevation, true);
    assert.equal(stats.ascentM, 50);
    assert.equal(stats.descentM, 30);
    assert.equal(stats.minElevation, 100);
    assert.equal(stats.maxElevation, 150);
  });

  test("routeStats com lista vazia e ponto unico", () => {
    const empty = routeStats([]);
    assert.equal(empty.distanceKm, 0);
    assert.equal(empty.pointCount, 0);
    assert.equal(empty.bounds, null);
    const single = routeStats([POINTS[0]]);
    assert.equal(single.distanceKm, 0);
    assert.equal(single.pointCount, 1);
  });

  test("normalizePoints descarta entradas invalidas", () => {
    assert.deepEqual(normalizePoints(null), []);
    assert.deepEqual(normalizePoints([{ lat: 95, lng: 0 }]), []);
    assert.equal(normalizePoints([{ lat: 1, lng: 2 }, { lat: "a", lng: 1 }]).length, 1);
  });
});
