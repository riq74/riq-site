import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGoogleMapsLink } from './maps-resolver.mjs';

const short = 'https://maps.app.goo.gl/test123';

test('expande uma rota curta com parada e ignora a posição da câmera', async () => {
  const destination = 'https://www.google.com.br/maps/dir/38.7,-9.1/39,-8/41.1,-8.6/@40,-7,10z';
  const result = await resolveGoogleMapsLink(short, async (url, options) => {
    assert.equal(url, short);
    assert.equal(options.redirect, 'manual');
    return Response.redirect(destination);
  });
  assert.equal(result.finalUrl, destination);
  assert.deepEqual(result.pontos, [{ lat: 38.7, lng: -9.1 }, { lat: 39, lng: -8 }, { lat: 41.1, lng: -8.6 }]);
});

test('um destino externo recebido de um encurtador não é consultado', async () => {
  const calls = [];
  await assert.rejects(resolveGoogleMapsLink(short, async (url) => {
    calls.push(url);
    return Response.redirect('https://example.org/maps/dir/A/B');
  }), { status: 422, code: 'redirect_not_allowed' });
  assert.deepEqual(calls, [short]);
});

test('retorna 404 se o Google indicar que o link expirou', async () => {
  await assert.rejects(resolveGoogleMapsLink(short, async () => new Response(null, { status: 404 })),
    { status: 404, code: 'invalid_link' });
});

test('mantém nomes na URL para o geocodificador e não consulta o Google em link completo', async () => {
  const url = 'https://www.google.com/maps/dir/?api=1&origin=Lisboa&destination=Porto';
  const result = await resolveGoogleMapsLink(url, () => assert.fail('O link já estava expandido'));
  assert.equal(result.finalUrl, url);
  assert.deepEqual(result.pontos, []);
});
