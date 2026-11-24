# Criador de rota GPX a partir do Google Maps (RIQ)

Cole um link de rota do Google Maps e receba o **traçado completo em pontos** e um
**arquivo GPX 1.1** pronto para Garmin, Wahoo, Komoot, Strava, OsmAnd, relógios e
ciclocomputadores.

Ferramenta própria, sem conta, sem chave de API e sem dependências npm. O motor de
roteamento é aberto (OpenStreetMap + OSRM / Valhalla / BRouter).

---

## Como rodar

```bash
node server.mjs          # ou: npm start
# abra http://localhost:5178
```

O servidor Node é opcional. No GitHub Pages, o navegador chama o Worker
`riq-maps-resolver.riq-ia-br.workers.dev` para abrir links curtos. Links completos
de direções seguem direto para o fluxo de conversão.

> Abrir o `index.html` com duplo clique (`file://`) **não** funciona: o app usa ES
> modules, que o navegador bloqueia nesse protocolo.

---

## O que ele faz

| Etapa | Como |
|---|---|
| 1. Lê o link | `js/core/url-parser.js` interpreta `/maps/dir/`, `?api=1&origin=…`, place, coordenadas, waypoints e links curtos |
| 2. Resolve os lugares | Cloudflare Worker para links curtos, Photon para nomes e Nominatim quando o servidor Node está ativo |
| 3. Calcula a rota | Carro → OSRM; bicicleta/caminhada → Valhalla; fallback BRouter |
| 4. Monta o GPX | `js/core/gpx.js` gera GPX 1.1 com `<wpt>` de início/fim, `<ele>` opcional e escape XML completo |
| 5. Mostra e baixa | Leaflet, estatísticas, alternativas de rota e download pelo botão Baixar GPX. |

### Modos e limites reais

- **Carro** — OSRM público; aceita alternativas.
- **Bicicleta / Caminhada** — Valhalla público, com teto de ~150 km por rota; acima
  disso o fallback BRouter assume.
- **Elevação** — Open-Meteo, em lotes de 100 pontos, com limite por minuto; se o
  limite estourar, o aviso aparece e o GPX ainda pode ser baixado sem elevação.

A rota é **recalculada** sobre o OpenStreetMap a partir dos pontos do link. O
roteador pode escolher vias diferentes daquelas que o Google Maps mostrou.

## Cloudflare Worker

O módulo principal é `server/cloudflare-worker.mjs`. Ele usa o binding
`DAILY_QUOTA` para a classe SQLite `DailyQuota` (`server/daily-quota.mjs`),
criada na migração `v1`. O Worker aceita apenas destinos reconhecidos do
Google Maps e valida cada redirecionamento antes de segui-lo.

A cota é de **20 expansões por IP por dia UTC**, compartilhada entre regiões
da Cloudflare. Uma consulta aceita conta mesmo se o Google responder que o
link expirou. A 21ª recebe HTTP 429 e `Retry-After`. Links completos no site,
preflight e a checagem de saúde ficam fora da contagem.

No primeiro deploy, envie também `server/maps-resolver.mjs` e
`js/core/url-parser.js`, mantendo os caminhos dos módulos. Em atualizações,
preserve a classe, o binding e a migração já aplicada para conservar a cota.

---

## Endpoints do servidor local

| Método | Rota | Função |
|---|---|---|
| GET | `/api/health` | `{ ok, version, uptime }` |
| GET | `/api/expand?url=` | segue o redirect de link curto (allowlist + proteção SSRF) |
| POST | `/api/route` | `{ points, profile, alternatives }` → rotas com pontos |
| GET | `/api/geocode?q=` | Nominatim, fila de 1 req/s, cache |
| GET | `/api/elevation?points=` | Open-Meteo, lotes de 100 |

Erros sempre em JSON: `{ ok:false, error, error_type }`. Rate limit de 30 req/min
por IP em `/api/route`; `/api/elevation` repassa 429 do upstream com `Retry-After`.

---

## Testes

```bash
npm test              # testes offline de servidor e módulos
npm run test:network  # opt-in: RUN_NETWORK_TESTS=1 npm run test:network
```

`node --test "tests/*.test.mjs"` — globs entre aspas são obrigatórios no Node 22
para Windows.

---

## Estrutura

```
index.html          interface (pt-BR, tema claro/escuro)
css/rota.css        estilos
js/core/            núcleo puro: parser, geocode, routing, gpx, elevation
js/app.js           DOM e apresentação
server.mjs          servidor local opcional (Node 22, zero deps)
server/             testes do servidor
tests/              testes e fixtures reais das APIs
docs/               análise do gpx2maps, pesquisa de stack, plano e auditoria
_research/          evidências e scripts de sondagem
```

---

## Créditos e licenças

Dados © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright),
sob ODbL. Rotas de carro por [OSRM](https://project-osrm.org/), bicicleta e caminhada
por [Valhalla](https://valhalla.github.io/valhalla/) e [BRouter](https://brouter.de/).
Elevação por [Open-Meteo](https://open-meteo.com/). Geocoding por
[Photon](https://photon.komoot.io/) e [Nominatim](https://nominatim.org/).
Mapa com [Leaflet](https://leafletjs.com/). Código deste projeto: MIT.

Os serviços públicos usados têm limites de uso e não oferecem garantia. Para uso
intenso, rode sua própria instância de OSRM/Valhalla/Photon.
