# Nucleo (js/core) - testes

Modulos puros (sem DOM, sem dependencias npm). Rodam no browser e no Node 22.

## Como rodar

```bash
# suite offline (120 testes) - nao usa rede
node --test "tests/*.test.mjs"

# teste de integracao REAL contra o OSRM publico (usa rede: Lisboa -> Porto)
node --test tests/osrm-lisboa-porto.integration.mjs
```

> Observacao: neste ambiente (Node v22.23.0 no Windows) `node --test tests`
> falha com `Cannot find module ...\tests`, mesmo em diretorios com um unico
> teste trivial - e limitacao do runner nesta build, nao dos testes. Use o
> glob entre aspas acima.

## Arquivos

| Arquivo | Cobre |
| --- | --- |
| `url-parser.test.mjs` | `/maps/dir/A/B`, waypoints, `?api=1&origin=&destination=&waypoints=`, coordenadas, `@lat,lng` (viewport), `/maps/place/`, `/maps?q=`, links curtos, My Maps, lixo |
| `gpx.test.mjs` | `buildGpx` (XML bem formado, escaping `& < > " '`, wpt inicio/fim, `ele` opcional), `buildGeoJSON`, `toFileName`, `routeStats`, haversine |
| `geocode.test.mjs` | Photon (fixture real), Nominatim via proxy, `geocodePlace`, `resolveShortLink`, `resolvePlaces` |
| `routing.test.mjs` | OSRM/Valhalla/BRouter, polyline6, limite de 500 pontos, 429, fallback |
| `elevation.test.mjs` | Open-Meteo em lotes de 100, progresso, `allowPartial` |
| `flow.test.mjs` | Fluxo completo offline: link -> geocode -> rota -> GPX |
| `real-fixture.test.mjs` | Geometria real dos fixtures (>=100 pts, sem rede) |
| `osrm-lisboa-porto.integration.mjs` | Chamada REAL ao OSRM (fora do glob padrao) |

## Fixtures (capturados das APIs reais)

- `osrm-lisboa-porto.json` - OSRM demo, driving Lisboa->Porto (3157 pontos, 314 km)
- `valhalla-lisboa-sintra-bicycle.json` - Valhalla, bicycle (polyline6, 30,1 km)
- `brouter-trekking-short.json` - BRouter trekking (GeoJSON com elevacao)
- `photon-porto.json`, `photon-lisboa.json` - Photon geocoding
- `open-meteo-elevation.json` - Open-Meteo elevation
- `lisboa-porto.osrm.real.gpx` / `.geojson` - exemplo real gerado pelo nucleo
