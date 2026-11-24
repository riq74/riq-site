/**
 * Smoke test do servidor local (rota-gpx-riq).
 *
 *   node --test "server/*.test.mjs"
 *
 * Por padrão roda 100% OFFLINE: sobe um servidor de fixtures local que
 * responde com os payloads reais gravados em tests/fixtures/ e aponta o
 * servidor da aplicação para ele via OSRM_BASE_URL / VALHALLA_BASE_URL /
 * BROUTER_BASE_URL / NOMINATIM_BASE_URL / ELEVATION_BASE_URL.
 *
 * Os testes que batem nas APIs públicas de verdade são opt-in:
 *
 *   RUN_NETWORK_TESTS=1 node --test "server/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

import { createServer, resolveConfig, endpointsFromEnv, DEFAULT_ENDPOINTS } from '../server.mjs';

const RUN_NETWORK = process.env.RUN_NETWORK_TESTS === '1';

/* ------------------------------------------------------------------ */
/* Fixtures + fake upstream                                            */
/* ------------------------------------------------------------------ */

const fixture = async (name) => JSON.parse(await readFile(new URL('../tests/fixtures/' + name, import.meta.url), 'utf8'));

function bodyOf(fixtureValue) {
  return fixtureValue && fixtureValue.body !== undefined ? fixtureValue.body : fixtureValue;
}

/** Servidor HTTP local que imita as APIs públicas usando os fixtures reais. */
async function startFakeUpstream(state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.calls.push({ path: url.pathname, query: url.search, method: req.method });

    const json = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
      res.end(body);
    };

    if (url.pathname.includes('/route/v1/')) {
      if (state.failOsrm) return json(500, { code: 'Error', message: 'fixture failure' });
      return json(200, bodyOf(state.osrm));
    }
    if (url.pathname.endsWith('/route')) {
      if (state.failValhalla) {
        return json(400, { error_code: 154, error: 'Path distance exceeds the max distance limit: 150000 meters' });
      }
      return json(200, bodyOf(state.valhalla));
    }
    if (url.pathname.endsWith('/brouter')) {
      if (state.failBrouter) return json(500, { error: 'fixture failure' });
      return json(200, bodyOf(state.brouter));
    }
    if (url.pathname.endsWith('/search')) {
      if (state.failNominatim) return json(503, { error: 'fixture failure' });
      return json(200, bodyOf(state.nominatim));
    }
    if (url.pathname.endsWith('/elevation')) {
      // 429 do provedor: propaga como 429 + Retry-After (ver teste específico).
      if (state.failElevation === 429) {
        res.setHeader('Retry-After', '42');
        return json(429, { error: true, reason: 'Minutely API request limit exceeded' });
      }
      if (state.failElevation) return json(500, { error: true, reason: 'fixture failure' });

      // Espelha o Open-Meteo: uma elevação por coordenada pedida, resolvida POR
      // COORDENADA (não por índice). O fixture cobre
      //   38.7223,-9.1393 -> 66 | 38.75,-9.25 -> 133 | 38.8029,-9.3817 -> 203
      // Assim qualquer subconjunto devolve os valores reais daquelas posições.
      const lats = String(url.searchParams.get('latitude') || '').split(',').filter(Boolean).map(Number);
      const lngs = String(url.searchParams.get('longitude') || '').split(',').filter(Boolean).map(Number);
      const count = Math.max(lats.length, lngs.length) || 1;
      const elevation = Array.from({ length: count }, (_, i) => {
        const known = state.elevationIndex.find(
          (entry) => Math.abs(entry.lat - lats[i]) < 1e-4 && Math.abs(entry.lng - lngs[i]) < 1e-4,
        );
        return known ? known.ele : 0;
      });
      return json(200, { elevation });
    }
    return json(404, { error: 'rota de fixture desconhecida: ' + url.pathname });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const base = 'http://127.0.0.1:' + port;
  return {
    server,
    base,
    urls: {
      osrm: base + '/route/v1',
      valhalla: base + '/route',
      brouter: base + '/brouter',
      nominatim: base + '/search',
      elevation: base + '/elevation',
    },
  };
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + app.address().port;
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

function jsonRequest(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getJson(base, path, init) {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

/* ------------------------------------------------------------------ */
/* Suíte offline (padrão)                                              */
/* ------------------------------------------------------------------ */

test.describe('offline (fixtures locais)', () => {
  let state;
  let upstream;
  let app;
  let baseUrl;

  test.before(async () => {
    const [osrm, valhalla, brouter, elevation] = await Promise.all([
      fixture('osrm-lisboa-porto.json'),
      fixture('valhalla-lisboa-sintra-bicycle.json'),
      fixture('brouter-trekking-short.json'),
      fixture('open-meteo-elevation.json'),
    ]);
    const nominatim = [
      { lat: '41.1502195', lon: '-8.6103497', display_name: 'Porto, Portugal', osm_type: 'relation', place_rank: 16 },
      { lat: '41.1537738', lon: '-8.6144367', display_name: 'Cedofeita, Porto, Portugal', osm_type: 'relation', place_rank: 20 },
    ];

    // Índice coordenada -> elevação, derivado do próprio fixture real.
    const elevationValues = (elevation.body || elevation).elevation;
    const sourceUrl = new URL(elevation._fixture.source);
    const fixtureLats = sourceUrl.searchParams.get('latitude').split(',').map(Number);
    const fixtureLngs = sourceUrl.searchParams.get('longitude').split(',').map(Number);
    const elevationIndex = fixtureLats.map((lat, i) => ({ lat, lng: fixtureLngs[i], ele: elevationValues[i] }));

    state = { osrm, valhalla, brouter, nominatim, elevation, elevationIndex, calls: [] };
    upstream = await startFakeUpstream(state);
    app = createServer({ log: false, endpoints: upstream.urls });
    baseUrl = await listen(app);
  });

  test.after(async () => {
    await close(app);
    await close(upstream && upstream.server);
  });

  test('GET /api/health responde ok com version e uptime', async () => {
    const { response, body } = await getJson(baseUrl, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(body.ok, true);
    assert.match(String(body.version), /^\d+\.\d+\.\d+$/);
    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.uptime >= 0);
  });

  test('OPTIONS /api/route responde 204 com CORS', async () => {
    const response = await fetch(baseUrl + '/api/route', { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    await response.body?.cancel();
  });

  test('POST /api/route Lisboa -> Porto usa o OSRM e devolve a geometria do fixture', async () => {
    const { response, body } = await getJson(
      baseUrl,
      '/api/route',
      jsonRequest({
        points: [
          { lat: 38.7223, lng: -9.1393 },
          { lat: 41.1579, lng: -8.6291 },
        ],
        profile: 'driving',
        alternatives: 0,
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.profile, 'driving');
    assert.equal(body.source, 'osrm');
    assert.equal(response.headers.get('x-cache'), 'MISS');

    const route = body.routes[0];
    assert.equal(route.index, 0);
    assert.ok(typeof route.summary === 'string' && route.summary.length > 0);
    // 314,2 km / 12.378 s no fixture real.
    assert.ok(route.distanceKm > 300 && route.distanceKm < 400, 'distância ~314 km, veio ' + route.distanceKm);
    assert.ok(route.durationMin > 150, 'duração > 150 min, veio ' + route.durationMin);
    assert.ok(route.points.length > 1000, 'geometria real tem 3157 pontos, veio ' + route.points.length);

    const first = route.points[0];
    const last = route.points[route.points.length - 1];
    assert.ok(Math.abs(first.lat - 38.72) < 0.05, 'primeiro ponto em Lisboa, veio ' + JSON.stringify(first));
    assert.ok(Math.abs(last.lat - 41.16) < 0.05, 'último ponto no Porto, veio ' + JSON.stringify(last));

    const osrmCalls = state.calls.filter((call) => call.path.includes('/route/v1/'));
    assert.ok(osrmCalls.length >= 1, 'deveria ter chamado o OSRM de fixture');
  });

  test('POST /api/route usa o cache na segunda chamada idêntica', async () => {
    const payload = {
      points: [
        { lat: 38.7223, lng: -9.1393 },
        { lat: 41.1579, lng: -8.6291 },
      ],
      profile: 'driving',
      alternatives: 0,
    };
    const first = await getJson(baseUrl, '/api/route', jsonRequest(payload));
    const second = await getJson(baseUrl, '/api/route', jsonRequest(payload));
    assert.equal(second.response.status, 200);
    assert.equal(second.response.headers.get('x-cache'), 'HIT');
    assert.equal(second.body.routes[0].distanceKm, first.body.routes[0].distanceKm);
  });

  test('POST /api/route bicycling usa o Valhalla e decodifica o polyline6', async () => {
    const { response, body } = await getJson(
      baseUrl,
      '/api/route',
      jsonRequest({
        // Lisboa -> Sintra: exatamente o trecho do fixture.
        points: [
          { lat: 38.7223, lng: -9.1393 },
          { lat: 38.8029, lng: -9.3817 },
        ],
        profile: 'bicycling',
        alternatives: 0,
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(body.profile, 'bicycling');
    assert.equal(body.source, 'valhalla');
    const route = body.routes[0];
    assert.ok(route.distanceKm > 25 && route.distanceKm < 60, 'Lisboa->Sintra de bike ~30 km, veio ' + route.distanceKm);
    assert.ok(route.points.length > 50, 'geometria decodificada deve ter muitos pontos');
    assert.ok(route.points.every((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)));
  });

  test('POST /api/route bike/pe acima de 150 km cai no BRouter', async () => {
    const { response, body } = await getJson(
      baseUrl,
      '/api/route',
      jsonRequest({
        points: [
          { lat: 38.7223, lng: -9.1393 },
          { lat: 41.1579, lng: -8.6291 }, // ~314 km: acima do limite do Valhalla
        ],
        profile: 'bicycling',
        alternatives: 0,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(body.source, 'brouter');
    assert.ok(body.routes[0].points.length >= 2);
  });

  test('POST /api/route devolve 422 claro quando Valhalla e BRouter falham', async () => {
    state.failBrouter = true;
    try {
      const { response, body } = await getJson(
        baseUrl,
        '/api/route',
        jsonRequest({
          points: [
            { lat: 38.0, lng: -9.5 },
            { lat: 41.9, lng: -8.0 },
          ],
          profile: 'walking',
          alternatives: 0,
        }),
      );
      assert.equal(response.status, 422);
      assert.equal(body.ok, false);
      assert.equal(body.error_type, 'route_too_long');
      assert.match(body.error, /150 km/);
    } finally {
      state.failBrouter = false;
    }
  });

  test('POST /api/route valida entrada inválida com JSON de erro', async () => {
    const semPontos = await getJson(baseUrl, '/api/route', jsonRequest({ points: [{ lat: 38.7, lng: -9.1 }] }));
    assert.equal(semPontos.response.status, 400);
    assert.equal(semPontos.body.ok, false);
    assert.equal(semPontos.body.error_type, 'invalid_points');

    const perfilRuim = await getJson(
      baseUrl,
      '/api/route',
      jsonRequest({
        points: [
          { lat: 38.7, lng: -9.1 },
          { lat: 41.1, lng: -8.6 },
        ],
        profile: 'flying',
      }),
    );
    assert.equal(perfilRuim.response.status, 400);
    assert.equal(perfilRuim.body.error_type, 'invalid_profile');

    const jsonQuebrado = await getJson(baseUrl, '/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ nao-e-json',
    });
    assert.equal(jsonQuebrado.response.status, 400);
    assert.equal(jsonQuebrado.body.error_type, 'invalid_json');
  });

  test('GET /api/geocode devolve resultados do provedor com lat/lng', async () => {
    const { response, body } = await getJson(baseUrl, '/api/geocode?q=' + encodeURIComponent('Porto, Portugal'));
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.results));
    assert.ok(body.results.length > 0);
    const porto = body.results[0];
    assert.ok(Math.abs(porto.lat - 41.1502195) < 1e-6);
    assert.ok(Math.abs(porto.lng + 8.6103497) < 1e-6);
    assert.equal(porto.displayName, 'Porto, Portugal');
  });

  test('GET /api/elevation devolve uma elevação por ponto', async () => {
    // Lisboa (66 m) e o ponto do fixture seguinte (133 m).
    const { response, body } = await getJson(
      baseUrl,
      '/api/elevation?points=' + encodeURIComponent('38.7223,-9.1393;38.75,-9.25'),
    );
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.elevations, [66, 133]);
  });

  test('GET /api/elevation com 2 pontos reais devolve 2 valores na ordem', async () => {
    const { response, body } = await getJson(
      baseUrl,
      '/api/elevation?points=' + encodeURIComponent('38.7223,-9.1393;38.8029,-9.3817'),
    );
    assert.equal(response.status, 200);
    assert.equal(body.elevations.length, 2);
    assert.deepEqual(body.elevations, [66, 203]);
  });

  test('GET /api/elevation repassa 429 do provedor com Retry-After', async () => {
    state.failElevation = 429;
    try {
      const { response, body } = await getJson(
        baseUrl,
        '/api/elevation?points=' + encodeURIComponent('1.0,2.0;3.0,4.0'),
      );
      assert.equal(response.status, 429);
      assert.equal(body.ok, false);
      assert.equal(body.error_type, 'rate_limited');
      assert.equal(response.headers.get('retry-after'), '42');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
    } finally {
      state.failElevation = false;
    }
  });

  test('GET /api/elevation devolve 502 JSON quando o provedor falha', async () => {
    state.failElevation = 500;
    try {
      const { response, body } = await getJson(baseUrl, '/api/elevation?points=' + encodeURIComponent('10.0,20.0;11.0,21.0'));
      assert.equal(response.status, 502);
      assert.equal(body.ok, false);
      assert.equal(body.error_type, 'upstream_error');
      assert.equal(typeof body.error, 'string');
    } finally {
      state.failElevation = false;
    }
  });

  test('GET /api/elevation valida o parâmetro points', async () => {
    const semPontos = await getJson(baseUrl, '/api/elevation');
    assert.equal(semPontos.response.status, 400);
    assert.equal(semPontos.body.error_type, 'missing_points');

    const ruim = await getJson(baseUrl, '/api/elevation?points=' + encodeURIComponent('abc,def'));
    assert.equal(ruim.response.status, 400);
    assert.equal(ruim.body.error_type, 'invalid_points');
  });

  test('GET /api/expand aceita link completo do Google Maps e extrai coordenadas', async () => {
    const mapsUrl = 'https://www.google.com/maps/place/Porto/@41.1579,-8.6291,13z';
    const { response, body } = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent(mapsUrl));
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.finalUrl === 'string' && body.finalUrl.startsWith('http'));
    assert.ok(Math.abs(body.lat - 41.1579) < 0.001);
    assert.ok(Math.abs(body.lng + 8.6291) < 0.001);
    assert.equal(body.placeName, 'Porto');
  });

  test('GET /api/expand extrai lat/lng de /@lat,lng e de !3d!4d', async () => {
    const at = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent('https://www.google.com/maps/place/Lisboa/@38.7223,-9.1393,12z'));
    assert.equal(at.body.lat, 38.7223);
    assert.equal(at.body.lng, -9.1393);

    const bang = await getJson(
      baseUrl,
      '/api/expand?url=' + encodeURIComponent('https://www.google.com/maps/place/Porto/data=!4m2!3d41.1579!4d-8.6291'),
    );
    assert.equal(bang.body.lat, 41.1579);
    assert.equal(bang.body.lng, -8.6291);
  });

  test('GET /api/expand NÃO inventa coordenadas em links /maps/dir/ ou /maps/search/', async () => {
    // Regressão: o HTML desses links traz o viewport da sessão, não o ponto do usuário.
    for (const link of ['https://www.google.com/maps/dir/Lisboa/Porto', 'https://www.google.com/maps/search/cafes+em+lisboa']) {
      const { response, body } = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent(link));
      assert.equal(response.status, 200);
      assert.equal(body.lat, undefined, 'não deve inventar lat para ' + link);
      assert.equal(body.lng, undefined, 'não deve inventar lng para ' + link);
      assert.equal(body.source, 'none');
    }
  });

  test('GET /api/expand bloqueia host fora da allowlist e IP privado', async () => {
    const externo = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent('https://example.com/maps'));
    assert.equal(externo.response.status, 400);
    assert.equal(externo.body.error_type, 'host_not_allowed');

    const privado = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent('https://127.0.0.1/maps'));
    assert.equal(privado.response.status, 400);
    assert.equal(privado.body.error_type, 'host_not_allowed');

    const localhost = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent('http://localhost:5178/maps'));
    assert.equal(localhost.response.status, 400);
    assert.equal(localhost.body.error_type, 'host_not_allowed');

    const semUrl = await getJson(baseUrl, '/api/expand');
    assert.equal(semUrl.response.status, 400);
    assert.equal(semUrl.body.error_type, 'missing_url');
  });

  test('GET /api/expand aceita os hosts reais de link curto do Google Maps', async () => {
    for (const host of ['maps.app.goo.gl', 'goo.gl', 'g.co', 'www.goo.gl', 'maps.google.com.br']) {
      const { body } = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent('https://' + host + '/abc123'));
      assert.notEqual(body.error_type, 'host_not_allowed', host + ' deveria ser permitido');
    }
  });

  test('GET /api/expand responde 400 em URL inválida', async () => {
    const { response, body } = await getJson(baseUrl, '/api/expand?url=' + encodeURIComponent('nao-e-url'));
    assert.equal(response.status, 400);
    assert.equal(body.error_type, 'invalid_url');
  });

  test('estáticos: MIME, cache-control curto, 404 limpo e travessia bloqueada', async () => {
    const pkg = await fetch(baseUrl + '/package.json');
    assert.equal(pkg.status, 200);
    assert.match(pkg.headers.get('content-type') || '', /application\/json/);
    assert.match(pkg.headers.get('cache-control') || '', /max-age=60/);
    assert.equal(JSON.parse(await pkg.text()).type, 'module');

    const missing = await fetch(baseUrl + '/nao-existe-xyz.txt');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /text\/plain/);
    assert.doesNotMatch(await missing.text(), /cannot get|ENOENT/i);

    const traversal = await fetch(baseUrl + '/%2e%2e/%2e%2e/%2e%2e/Windows/win.ini');
    assert.ok([400, 403, 404].includes(traversal.status), 'travessia deve falhar, veio ' + traversal.status);
    assert.doesNotMatch(await traversal.text(), /\[fonts\]|\[boot loader\]/i);
  });

  test('estáticos: serve index.html com MIME correto quando a UI existe', async (t) => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(new URL('../index.html', import.meta.url))) {
      t.skip('index.html ainda não existe (escopo da interface).');
      return;
    }
    const index = await fetch(baseUrl + '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') || '', /text\/html/);
    assert.match(await index.text(), /<html/i);
  });

  test('rota desconhecida em /api devolve 404 JSON { ok:false }', async () => {
    const { response, body } = await getJson(baseUrl, '/api/nao-existe');
    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error_type, 'not_found');
  });

  test('rate limit por IP responde 429 com Retry-After e CORS', async () => {
    const limited = createServer({ log: false, endpoints: upstream.urls, routeRateLimit: 2, routeRateWindowMs: 60_000 });
    const limitedUrl = await listen(limited);
    try {
      for (let i = 0; i < 2; i += 1) {
        const ok = await getJson(
          limitedUrl,
          '/api/route',
          jsonRequest({
            points: [
              { lat: 38.7223, lng: -9.1393 },
              { lat: 41.1579, lng: -8.6291 },
            ],
            profile: 'driving',
            alternatives: 0,
          }),
        );
        assert.equal(ok.response.status, 200);
      }
      const blocked = await getJson(
        limitedUrl,
        '/api/route',
        jsonRequest({
          points: [
            { lat: 39.0, lng: -9.0 },
            { lat: 41.0, lng: -8.0 },
          ],
          profile: 'driving',
        }),
      );
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.body.error_type, 'rate_limited');
      assert.equal(blocked.response.headers.get('access-control-allow-origin'), '*');
      assert.ok(Number(blocked.response.headers.get('retry-after')) >= 1);
    } finally {
      await close(limited);
    }
  });

  test('config: resolveConfig aceita overrides e mantém os DEFAULT_ENDPOINTS', async () => {
    const custom = resolveConfig({ endpoints: { elevation: 'http://127.0.0.1:9/elevacao' } });
    assert.equal(custom.endpoints.elevation, 'http://127.0.0.1:9/elevacao');
    assert.equal(custom.endpoints.osrm, DEFAULT_ENDPOINTS.osrm);

    const fromEnv = endpointsFromEnv();
    assert.equal(typeof fromEnv.nominatim, 'string');
    assert.ok(fromEnv.nominatim.startsWith('http'));
  });
});

/* ------------------------------------------------------------------ */
/* Suíte de rede real (opt-in)                                         */
/* ------------------------------------------------------------------ */

test.describe('rede real (RUN_NETWORK_TESTS=1)', { skip: !RUN_NETWORK && 'defina RUN_NETWORK_TESTS=1 para rodar' }, () => {
  let app;
  let baseUrl;

  test.before(async () => {
    // Sem endpoints customizados: usa as APIs públicas de verdade.
    app = createServer({ log: false, routeRateLimit: 1_000_000 });
    baseUrl = await listen(app);
  });

  test.after(async () => {
    await close(app);
  });

  test('GET /api/route Lisboa -> Porto pela rede real (~300 km)', async () => {
    const { response, body } = await getJson(
      baseUrl,
      '/api/route',
      jsonRequest({
        points: [
          { lat: 38.7223, lng: -9.1393 },
          { lat: 41.1579, lng: -8.6291 },
        ],
        profile: 'driving',
        alternatives: 0,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    const route = body.routes[0];
    assert.ok(route.distanceKm > 300 && route.distanceKm < 400, 'distância real ~314 km, veio ' + route.distanceKm);
    assert.ok(route.points.length > 100);
  });

  test('GET /api/geocode "Porto, Portugal" pela rede real', async () => {
    const { response, body } = await getJson(baseUrl, '/api/geocode?q=' + encodeURIComponent('Porto, Portugal'));
    assert.equal(response.status, 200);
    assert.ok(body.results.length > 0);
    assert.ok(body.results.some((result) => Math.abs(result.lat - 41.15) < 0.7));
  });

  test('GET /api/elevation pela rede real (tolera 429/502 do provedor)', async () => {
    const { response, body } = await getJson(baseUrl, '/api/elevation?points=' + encodeURIComponent('38.7223,-9.1393;41.1579,-8.6291'));
    if (response.status === 200) {
      assert.equal(body.ok, true);
      assert.equal(body.elevations.length, 2);
      for (const value of body.elevations) {
        assert.equal(typeof value, 'number');
        assert.ok(value > -500 && value < 5000);
      }
      return;
    }
    // Upstream instável (ex.: Open-Meteo 429 'Minutely API request limit exceeded')
    // não pode deixar a suíte vermelha: verificamos o contrato do erro e pulamos
    // o valor real, documentando o motivo.
    assert.ok([429, 502].includes(response.status), 'status inesperado do provedor: ' + response.status);
    assert.equal(body.ok, false);
    assert.equal(body.error_type, 'upstream_error');
  });
});
