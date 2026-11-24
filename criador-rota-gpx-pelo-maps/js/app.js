/**
 * RIQ · Google Maps -> GPX
 * Interface: lê o link, resolve os pontos, pede a rota, desenha no Leaflet e gera o GPX.
 * Toda a lógica de domínio vem de js/core (ver CONTRATO); aqui só há DOM e apresentação.
 */
import {
  parseMapsUrl,
  geocodePlace,
  resolveShortLink,
  fetchRoute,
  buildGpx,
  toFileName,
  addElevation,
} from './core/index.js';

/* ------------------------------------------------------------------ DOM --- */

const $ = (sel) => document.querySelector(sel);

const el = {
  form: $('#rota-form'),
  url: $('#maps-url'),
  urlFeedback: $('#maps-url-feedback'),
  modo: $('#modo'),
  nome: $('#nome'),
  elevacao: $('#incluir-elevacao'),
  btnGerar: $('#btn-gerar'),
  btnBaixar: $('#btn-baixar'),
  btnLimpar: $('#btn-limpar'),
  status: $('#status'),
  erro: $('#erro'),
  erroTitulo: $('#erro-titulo'),
  erroTexto: $('#erro-texto'),
  erroAcao: $('#erro-acao'),
  erroDetalhe: $('#erro-detalhe'),
  erroCodigo: $('#erro-codigo'),
  resultados: $('#resultados'),
  mapa: $('#mapa'),
  mapaFallback: $('#mapa-fallback'),
  btnMapaRetry: $('#btn-mapa-retry'),
  mapaDetalhes: $('#mapa-detalhes'),
  alternativas: $('#alternativas'),
  altList: $('#alt-list'),
  stats: $('#stats'),
  linkGpx: $('#link-gpx'),
  downloadHint: $('#download-hint'),
  fileMeta: $('#file-meta'),
  cardAvisos: $('#card-avisos'),
  avisos: $('#avisos'),
  listaPontos: $('#lista-pontos'),
};

const MODE_LABEL = { driving: 'Carro', bicycling: 'Ciclismo', walking: 'Caminhada', transit: 'Transporte público' };
const LEAFLET_VERSION = '1.9.4';
const LEAFLET_JS = 'https://unpkg.com/leaflet@' + LEAFLET_VERSION + '/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@' + LEAFLET_VERSION + '/dist/leaflet.css';
// Tiles do OpenStreetMap: sem chave de API e sem CDN comercial no meio.
// No tema escuro as mesmas tiles recebem um filtro CSS (ver rota.css).
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

/* ---------------------------------------------------------------- state --- */

const state = {
  apiBase: null,
  loading: false,
  userChangedMode: false,
  places: [],
  routes: [],
  selected: 0,
  warnings: [],
  elevationApplied: false,
  blobUrl: '',
  fileName: '',
  lastParsed: null,
  map: null,
  tileLayer: null,
  routeLayer: null,
  markerLayer: null,
  leafletPromise: null,
  mapSvgBroken: false,
};

/* --------------------------------------------------------------- helpers --- */

function setStatus(text, kind) {
  el.status.textContent = text;
  if (kind) el.status.dataset.state = kind;
  else delete el.status.dataset.state;
}

function setFeedback(text, kind) {
  el.urlFeedback.textContent = text;
  el.urlFeedback.dataset.state = kind || 'idle';
}

function setLoading(on, label) {
  state.loading = on;
  el.form.setAttribute('aria-busy', String(on));
  el.btnGerar.disabled = on;
  el.btnGerar.setAttribute('aria-busy', String(on));
  el.btnGerar.querySelector('.btn-label').textContent = on ? (label || 'Gerando…') : 'Gerar rota';
  if (on) el.url.setAttribute('aria-busy', 'true');
  else el.url.removeAttribute('aria-busy');
}

function clearError() {
  el.erro.hidden = true;
  el.erroTitulo.textContent = '';
  el.erroTexto.textContent = '';
  el.erroAcao.replaceChildren();
  el.erroDetalhe.hidden = true;
  el.erroCodigo.textContent = '';
  el.url.removeAttribute('aria-invalid');
}

function showError(spec) {
  clearError();
  el.erro.hidden = false;
  el.erroTitulo.textContent = spec.title || 'Não foi possível gerar a rota';
  el.erroTexto.replaceChildren();
  if (spec.message) el.erroTexto.append(document.createTextNode(spec.message));
  if (spec.link) {
    el.erroTexto.append(document.createTextNode(' '));
    const a = document.createElement('a');
    a.href = spec.link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = spec.link.label;
    el.erroTexto.append(a);
    el.erroTexto.append(document.createTextNode(spec.link.after || '.'));
  }
  (spec.actions || []).slice(0, 3).forEach((action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', action.run);
    el.erroAcao.append(btn);
  });
  if (spec.hint) {
    const hint = document.createElement('p');
    hint.className = 'alert-hint';
    hint.textContent = spec.hint;
    el.erroTexto.after(hint);
  }
  if (spec.detail) {
    el.erroDetalhe.hidden = false;
    el.erroCodigo.textContent = String(spec.detail);
  }
  setStatus(spec.title || 'Erro ao gerar a rota.', 'erro');
  if (spec.focusInput) {
    el.url.setAttribute('aria-invalid', 'true');
    el.url.focus();
  }
}

function formatKm(km) {
  return Number(km).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatDistance(km) {
  return km < 10 ? km.toFixed(2).replace('.', ',') : formatKm(km);
}

function formatDuration(min) {
  const total = Math.max(1, Math.round(min));
  if (total < 60) return total + ' min';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? h + ' h' : h + ' h ' + m + ' min';
}

function formatPoints(n) {
  return Number(n).toLocaleString('pt-BR');
}

function shortPlace(place) {
  const name = (place && (place.name || place.displayName || place.raw)) || '';
  return name.length > 46 ? name.slice(0, 44).trim() + '…' : name;
}

function coordText(place) {
  if (typeof place.lat !== 'number' || typeof place.lng !== 'number') return 'coordenadas pendentes';
  return place.lat.toFixed(5) + ', ' + place.lng.toFixed(5);
}

function debounce(fn, wait) {
  let timer = 0;
  return function debounced() {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, arguments), wait);
  };
}

function downloadName(name) {
  return toFileName(name, 'rota');
}

const PUBLIC_EXPAND_API = 'https://riq-maps-resolver.riq-ia-br.workers.dev/api';

async function detectEnv() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch('api/health', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.ok && (await res.json())?.ok) state.apiBase = 'api';
  } catch {
    // O servidor Node é opcional. No modo estático, as APIs são chamadas pelo navegador.
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------- leitura do link --- */

function classify(parsed) {
  if (!parsed || !parsed.ok) return 'erro';
  if (parsed.kind === 'short') return 'curto';
  if (parsed.kind === 'directions' || parsed.kind === 'coords') return 'rota';
  return 'outro';
}

function feedbackFor(parsed) {
  const kind = classify(parsed);
  if (kind === 'erro') {
    const reason = parsed && parsed.reason ? String(parsed.reason) : '';
    if (reason === 'empty' || reason === 'invalid_url') return { text: 'Cole um link do Google Maps.', state: 'idle' };
    if (reason === 'unsupported_host' || reason === 'not_maps' || reason === 'not-a-url' || reason === 'not-google-maps') {
      return { text: 'Isso não parece um link do Google Maps.', state: 'erro' };
    }
    if (reason === 'my_maps') {
      return { text: 'Link do My Maps não é uma rota de direções. Use um link de direções.', state: 'erro' };
    }
    if (reason === 'no_places' || reason === 'missing-places') {
      return { text: 'O link de direções não trouxe origem e destino legíveis.', state: 'erro' };
    }
    if (reason === 'unsupported-link') {
      return { text: 'Link do Google Maps sem rota reconhecível. Use um link de direções.', state: 'erro' };
    }
    return { text: 'Link não reconhecido. Confira se copiou o endereço completo.', state: 'erro' };
  }
  if (kind === 'curto') {
    return { text: 'Link curto detectado. A ferramenta vai abrir o endereço para ler a rota.', state: 'info' };
  }
  if (kind === 'rota') {
    const stops = 2 + (parsed.waypoints ? parsed.waypoints.length : 0);
    const mode = parsed.travelmode && MODE_LABEL[parsed.travelmode] ? MODE_LABEL[parsed.travelmode].toLowerCase() : null;
    return {
      text: 'Rota reconhecida: ' + stops + ' ponto' + (stops > 1 ? 's' : '') + (mode ? ' · ' + mode : '') + '.',
      state: 'ok',
    };
  }
  return { text: 'Link reconhecido, mas não é uma rota com origem e destino.', state: 'erro' };
}

const updateFeedback = debounce(function () {
  const value = el.url.value.trim();
  if (!value) {
    setFeedback('Cole um link para começar.', 'idle');
    return;
  }
  let parsed = null;
  try {
    parsed = parseMapsUrl(value);
  } catch (err) {
    setFeedback('Não foi possível interpretar esse link.', 'erro');
    return;
  }
  const fb = feedbackFor(parsed);
  setFeedback(fb.text, fb.state);
}, 320);

el.url.addEventListener('input', function () {
  updateFeedback();
  if (!el.erro.hidden) clearError();
});
el.url.addEventListener('paste', function () { setTimeout(updateFeedback, 20); });
el.modo.addEventListener('change', function () { state.userChangedMode = true; });

/* ------------------------------------------------------------ geocoding --- */

async function resolvePlaces(parsed) {
  const origin = parsed.origin;
  const destination = parsed.destination;
  const middle = Array.isArray(parsed.waypoints) ? parsed.waypoints : [];
  const ordered = [origin].concat(middle).concat(destination ? [destination] : []).filter(Boolean);
  if (ordered.length < 2) {
    throw Object.assign(new Error('A rota precisa de origem e destino.'), { userCode: 'missing-places' });
  }
  const out = [];
  for (let i = 0; i < ordered.length; i++) {
    const place = ordered[i];
    if (typeof place.lat === 'number' && typeof place.lng === 'number') {
      out.push(place);
      continue;
    }
    const fila = state.apiBase && ordered.length > 2 ? ' (o servidor local enfileira 1 consulta por segundo, pode demorar)' : '';
    setStatus('Localizando ponto ' + (i + 1) + ' de ' + ordered.length + ': ' + (shortPlace(place) || 'sem nome') + '…' + fila, 'loading');
    try {
      const resolved = await geocodePlace(place, { apiBase: state.apiBase });
      if (!resolved || typeof resolved.lat !== 'number' || typeof resolved.lng !== 'number') {
        throw new Error('O geocodificador não devolveu coordenadas para ' + shortPlace(place) + '.');
      }
      out.push(resolved);
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        userCode: 'geocode-failed',
        stage: 'geocode',
        place: shortPlace(place) || 'um dos pontos',
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------- roteamento --- */

function routeSignature(routes) {
  return routes.map(function (r) { return Math.round(r.distanceKm * 100); }).join('-');
}

async function requestRoute(places, profile) {
  const alternatives = profile === 'driving' ? 2 : 0;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 45000);
  try {
    const result = await fetchRoute({
      places: places,
      profile: profile,
      alternatives: alternatives,
      apiBase: state.apiBase,
      signal: controller.signal,
    });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- mensagens --- */

function describeError(err) {
  const raw = err && err.message ? String(err.message) : 'Erro desconhecido.';
  const code = (err && (err.userCode || err.code)) ? String(err.userCode || err.code) : '';
  const status = err && err.status ? ' HTTP ' + err.status : '';
  const all = (code + ' ' + raw + status).toLowerCase();
  const detail = (err && (err.code || err.userCode) ? '[' + (err.userCode || err.code) + '] ' : '') + raw + status;

  if (code === 'short-link-needs-proxy' || /short.*(proxy|expand|servidor)|cors.*short/.test(all)) {
    return {
      title: 'Link curto precisa do servidor local',
      message:
        'Links curtos (maps.app.goo.gl, goo.gl/maps) são redirecionamentos que o navegador não consegue ' +
        'seguir por causa do CORS. Duas saídas: (1) abra o link no Google Maps, use Compartilhar > Copiar link ' +
        'e cole aqui a URL longa; ou (2) rode "npm start" e abra http://localhost:5178, que expande o link. ' +
        'Atalho:',
      link: { href: 'https://www.google.com/maps', label: 'abrir o Google Maps', after: '.' },
      actions: [
        { label: 'Copiar dica', run: function () {
            const tip = 'Abra o link curto no Google Maps, toque em Compartilhar > Copiar link e cole a URL longa aqui.';
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(tip).then(function () {
                setStatus('Dica copiada para a área de transferência.', 'ok');
              }).catch(function () { setStatus(tip, 'info'); });
            } else {
              setStatus(tip, 'info');
            }
          } },
      ],
      detail: detail,
    };
  }
  if (/limite de requisi|rate.?limit|429|too many/.test(all)) {
    const retry = err && Number(err.retryAfter) > 0 ? Math.ceil(Number(err.retryAfter)) : null;
    const espera = retry ? retry + ' segundo' + (retry === 1 ? '' : 's') : '30 a 60 segundos';
    return {
      title: 'Muitas requisições ao serviço público',
      message:
        'O serviço de rotas está limitando pedidos (HTTP 429). Aguarde ' + espera + ' e tente de novo. ' +
        'O servidor local ("npm start") tem cache e limite próprio, então costuma ajudar.',
      actions: [{ label: 'Tentar de novo', run: function () { runGenerate(); } }],
      detail: detail,
    };
  }
  if (/cors|access-control|cross-origin|failed to fetch|networkerror|load failed|network|offline|err_internet/.test(all)) {
    return {
      title: 'Falha de rede',
      message:
        'Não foi possível falar com o serviço de rotas. Confira a conexão, se algum bloqueador/extensão está ' +
        'barrando o domínio, e tente novamente. O servidor local ("npm start") também contorna bloqueios de CORS.',
      actions: [{ label: 'Tentar de novo', run: function () { runGenerate(); } }],
      detail: detail,
    };
  }
  if (code === 'distance-limit' || /150|distanc|max distance|exceeds/.test(all)) {
    return {
      title: 'Rota longa demais para este modo',
      message:
        'Rotas de bicicleta e caminhada no Valhalla público têm limite de cerca de 150 km por rota, e o ' +
        'fallback BRouter também não venceu essa distância. Divida o trajeto em trechos menores ou use o ' +
        'modo Carro, cujo OSRM não tem esse limite.',
      actions: [{ label: 'Tentar de novo', run: function () { runGenerate(); } }],
      detail: detail,
    };
  }
  if (/sem rota|no route|noroute|no-route|not found|could not find|sem caminho/.test(all)) {
    return {
      title: 'Nenhuma rota encontrada',
      message:
        'O roteador não achou um caminho válido entre os pontos. Um dos extremos pode estar em área sem vias ' +
        'mapeadas ou fora da cobertura (por exemplo, no meio do mar ou de um aeroporto). Confira os pontos no mapa.',
      detail: detail,
    };
  }
  if (code === 'missing-places' || code === 'no-places' || code === 'no-coords' || code === 'not-enough-points') {
    return {
      title: 'Rota incompleta',
      message:
        'Faltaram origem ou destino. Cole um link de direções do Google Maps que tenha os dois pontos, ' +
        'como google.com/maps/dir/PONTO-A/PONTO-B.',
      focusInput: true,
      detail: detail,
    };
  }
  if (code === 'geocode-failed' || /geocod|nominatim|photon|localiz/.test(all) || /not_found|not-found/.test(all)) {
    const alvo = err && err.place ? err.place : 'um dos pontos';
    return {
      title: 'Não localizei um dos pontos',
      message:
        'O ponto "' + alvo + '" é um NOME de lugar (condomínio, prédio, empresa) e esse nome não existe nas ' +
        'bases do OpenStreetMap, então não dá para transformá-lo em coordenadas. Acontece com link longo e ' +
        'curto igualmente: o problema é o nome, não o link curto.',
      hint: 'Como resolver em 30 segundos: abra o trajeto no Google Maps, clique com o botão direito no ponto ' +
        'de partida e no de chegada e copie as coordenadas de cada um. Depois monte o link no formato ' +
        'google.com/maps/dir/LAT,LNG/LAT,LNG. Ruas, bairros e cidades costumam funcionar por nome; condomínios ' +
        'e empresas frequentemente não.',
      focusInput: true,
      actions: [{
        label: 'Copiar link de exemplo',
        run: function () {
          const exemplo = 'https://www.google.com/maps/dir/-23.5505,-46.6333/-22.9068,-43.1729';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(exemplo).then(function () {
              setStatus('Link de exemplo copiado. Troque os números pelas suas coordenadas.', 'ok');
            }).catch(function () { setStatus('Formato: ' + exemplo, 'info'); });
          } else {
            setStatus('Formato: ' + exemplo, 'info');
          }
        },
      }],
      detail: detail,
    };
  }
  if (/timeout|abort/.test(all)) {
    return {
      title: 'O serviço demorou demais',
      message: 'O cálculo passou de 45 segundos e foi cancelado. Tente novamente; rotas muito longas ou o serviço público sobrecarregado causam isso.',
      actions: [{ label: 'Tentar de novo', run: function () { runGenerate(); } }],
      detail: detail,
    };
  }
  const tentativas = err && Array.isArray(err.attempts) && err.attempts.length
    ? ' Tentativas: ' + err.attempts.join(' | ')
    : '';
  return {
    title: 'Não foi possível gerar a rota',
    message: raw + tentativas,
    actions: [{ label: 'Tentar de novo', run: function () { runGenerate(); } }],
    detail: detail,
  };
}

/* ---------------------------------------------------------------- Leaflet --- */

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (state.leafletPromise) return state.leafletPromise;
  state.leafletPromise = new Promise(function (resolve, reject) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS;
    link.crossOrigin = '';
    document.head.append(link);

    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.crossOrigin = '';
    script.async = true;
    const timer = setTimeout(function () { finish(new Error('timeout-cdn')); }, 9000);
    let done = false;

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (err) reject(err);
      else if (window.L) resolve(window.L);
      else reject(new Error('leaflet-sem-global'));
    }

    script.onload = function () { finish(null); };
    script.onerror = function () { finish(new Error('cdn-falhou')); };
    document.head.append(script);
  }).catch(function (err) {
    state.leafletPromise = null;
    throw err;
  });
  return state.leafletPromise;
}

function showMapFallback() {
  el.mapaFallback.hidden = false;
  if (state.map) {
    el.mapa.style.visibility = 'hidden';
  }
}

function hideMapFallback() {
  el.mapaFallback.hidden = true;
  el.mapa.style.visibility = '';
}

function markerIcon(role, label) {
  return window.L.divIcon({
    className: 'marker-wrap',
    html: '<span class="marker-pin" data-role="' + role + '">' + label + '</span>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14],
  });
}

function pointRoleLabel(index, total) {
  if (index === 0) return 'Início';
  if (index === total - 1) return 'Fim';
  return 'Parada ' + index;
}

async function ensureMap() {
  if (state.map) return state.map;
  let L;
  try {
    L = await loadLeaflet();
  } catch (err) {
    showMapFallback();
    addWarning('O mapa não carregou (CDN do Leaflet indisponível). A rota, as estatísticas e o GPX continuam funcionando.');
    setStatus('Mapa indisponível, mas a rota foi gerada. Use "Baixar GPX" normalmente.', 'ok');
    return null;
  }
  hideMapFallback();
  state.map = L.map(el.mapa, {
    zoomControl: true,
    scrollWheelZoom: true,
    attributionControl: true,
    keyboard: true,
  }).setView([-15.79, -47.88], 4);
  state.tileLayer = L.tileLayer(TILE_URL, {
    maxZoom: 19,
    attribution: TILE_ATTR,
    crossOrigin: true,
  }).addTo(state.map);
  state.tileLayer.on('tileerror', function () {
    if (state.tileErrorLogged) return;
    state.tileErrorLogged = true;
    addWarning('Algumas imagens do mapa não carregaram (servidor de tiles do OpenStreetMap). O traçado e o GPX não são afetados.');
  });
  state.markerLayer = L.layerGroup().addTo(state.map);
  return state.map;
}

async function drawRoute(route, places) {
  await ensureMap();
  const L = window.L;
  if (!L || !state.map) return;
  if (state.routeLayer) {
    state.map.removeLayer(state.routeLayer);
    state.routeLayer = null;
  }
  state.markerLayer.clearLayers();

  const latlngs = route.points.map(function (p) { return [p.lat, p.lng]; });
  // Cor de traçado com bom contraste nos dois temas (verde-oliva escuro no claro,
  // verde-limão no escuro, onde as tiles do OSM são invertidas por CSS).
  const dark = document.documentElement.dataset.theme === 'dark';
  state.routeLayer = L.polyline(latlngs, {
    color: dark ? '#dcf264' : '#4f6203',
    weight: 5,
    opacity: 0.95,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(state.map);

  state.routeLayer.bindTooltip(
    formatDistance(route.distanceKm) + ' km · ' + formatDuration(route.durationMin),
    { sticky: true }
  );

  const total = places.length;
  places.forEach(function (place, i) {
    if (typeof place.lat !== 'number') return;
    const role = i === 0 ? 'inicio' : i === total - 1 ? 'fim' : 'parada';
    const label = i === 0 ? 'A' : i === total - 1 ? 'B' : String(i);
    L.marker([place.lat, place.lng], {
      icon: markerIcon(role, label),
      title: pointRoleLabel(i, total) + ': ' + (place.name || 'ponto'),
      alt: pointRoleLabel(i, total) + ': ' + (place.name || 'ponto'),
      keyboard: true,
    })
      .bindPopup(
        '<strong>' + pointRoleLabel(i, total) + '</strong><br>' +
        escapeHtml(shortPlace(place) || 'ponto sem nome') + '<br>' +
        '<small>' + escapeHtml(coordText(place)) + '</small>'
      )
      .addTo(state.markerLayer);
  });

  state.map.fitBounds(state.routeLayer.getBounds(), { padding: [28, 28], maxZoom: 16 });
  requestAnimationFrame(function () { if (state.map) state.map.invalidateSize(); });
  state.mapSvgBroken = false;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

/* -------------------------------------------------------------- painéis --- */

function renderStats(route, places) {
  const mode = el.modo.value;
  const stats = [
    ['Distância', formatDistance(route.distanceKm), 'km', true],
    ['Duração', formatDuration(route.durationMin), '', false],
    ['Pontos', formatPoints(route.points.length), '', false],
    ['Modo', MODE_LABEL[mode] || mode, '', false],
  ];
  if (state.elevationApplied) {
    const gain = elevationGain(route.points);
    if (gain !== null) stats.push(['Subida', formatPoints(Math.round(gain)), 'm', false]);
  }
  el.stats.replaceChildren();
  stats.forEach(function (row) {
    const wrap = document.createElement('div');
    wrap.className = 'stat' + (row[3] ? ' stat-stat-highlight' : '');
    const dt = document.createElement('dt');
    dt.textContent = row[0];
    const dd = document.createElement('dd');
    dd.textContent = row[1];
    if (row[2]) {
      const small = document.createElement('small');
      small.textContent = row[2];
      dd.append(small);
    }
    wrap.append(dt, dd);
    el.stats.append(wrap);
  });
}

function elevationGain(points) {
  let gain = 0;
  let found = false;
  for (let i = 1; i < points.length; i++) {
    if (typeof points[i].ele === 'number' && typeof points[i - 1].ele === 'number') {
      found = true;
      const delta = points[i].ele - points[i - 1].ele;
      if (delta > 0) gain += delta;
    }
  }
  return found ? gain : null;
}

function renderPlaces(places) {
  el.listaPontos.replaceChildren();
  const total = places.length;
  places.forEach(function (place, i) {
    const li = document.createElement('li');
    li.dataset.role = i === 0 ? 'inicio' : i === total - 1 ? 'fim' : 'parada';
    const badge = document.createElement('span');
    badge.className = 'place-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = i === 0 ? 'A' : i === total - 1 ? 'B' : String(i);
    const box = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'place-name';
    name.textContent = shortPlace(place) || pointRoleLabel(i, total);
    const coords = document.createElement('p');
    coords.className = 'place-coords';
    coords.textContent = coordText(place);
    box.append(name, coords);
    li.append(badge, box);
    el.listaPontos.append(li);
  });
  el.listaPontos.hidden = places.length === 0;
}

function renderAlternatives() {
  el.altList.replaceChildren();
  if (state.routes.length < 2) {
    el.alternativas.hidden = true;
    return;
  }
  el.alternativas.hidden = false;
  state.routes.forEach(function (route, i) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'alt-tab';
    btn.setAttribute('aria-pressed', String(i === state.selected));

    // O núcleo já resume como "442 km - 5 h 41 min"; usamos isso como rótulo
    // principal e deixamos a segunda linha só com o papel da alternativa.
    const strong = document.createElement('strong');
    // O summary cru do núcleo usa ponto decimal e minutos totais ("442.8 km - 341.3 min").
    // Reescrevemos em pt-BR para ficar coerente com o resto da interface.
    strong.textContent = formatDistance(route.distanceKm) + ' km · ' + formatDuration(route.durationMin);

    const span = document.createElement('span');
    span.textContent = i === 0 ? 'Recomendada' : 'Alternativa ' + i;

    btn.append(strong, span);
    btn.addEventListener('click', function () { selectRoute(i); });
    el.altList.append(btn);
  });
}

function renderMapDetails() {
  if (!state.routes.length) {
    el.mapaDetalhes.hidden = true;
    return;
  }
  const route = state.routes[state.selected];
  const parts = [formatPoints(route.points.length) + ' pontos no traçado'];
  if (state.routes.length > 1) parts.push('alternativa ' + (state.selected + 1) + ' de ' + state.routes.length);
  el.mapaDetalhes.textContent = parts.join(' · ');
  el.mapaDetalhes.hidden = false;
}

function addWarning(text) {
  if (state.warnings.indexOf(text) !== -1) return;
  state.warnings.push(text);
  const li = document.createElement('li');
  li.textContent = text;
  el.avisos.append(li);
  el.cardAvisos.hidden = false;
}

function clearWarnings() {
  state.warnings = [];
  el.avisos.replaceChildren();
  el.cardAvisos.hidden = true;
}

/* ------------------------------------------------------------------ GPX --- */

function routeDisplayName(places) {
  const typed = el.nome.value.trim();
  if (typed) return typed;
  if (places.length >= 2) {
    // Nomes geocodificados vêm longos ("São Paulo, Região Sudeste, Brasil"):
    // usamos só a primeira parte, antes da primeira vírgula.
    const first = String(places[0].name || places[0].displayName || '').split(',')[0].trim();
    const last = String(places[places.length - 1].name || places[places.length - 1].displayName || '').split(',')[0].trim();
    if (first && last) return first + ' a ' + last;
  }
  return 'Rota sem nome';
}

function rebuildGpx(places) {
  const route = state.routes[state.selected];
  if (!route) return;
  const name = routeDisplayName(places);
  const desc = 'Gerado por RIQ · Google Maps para GPX · traçado via OpenStreetMap/OSRM';
  let gpx = '';
  try {
    // O núcleo já grava <wpt> de Início e Fim (includeStartEnd), então aqui
    // passamos apenas as paradas intermediárias para não duplicar pontos.
    const paradas = places.slice(1, Math.max(1, places.length - 1)).map(function (place, i) {
      return {
        lat: place.lat,
        lng: place.lng,
        name: place.name || place.displayName || 'Parada ' + (i + 1),
      };
    });
    gpx = buildGpx({
      name: name,
      desc: desc,
      points: route.points,
      waypoints: paradas,
      elevation: state.elevationApplied,
      creator: 'RIQ · Google Maps para GPX',
    });
  } catch (err) {
    showError({
      title: 'Falha ao montar o GPX',
      message: 'A rota foi calculada, mas o gerador de GPX falhou. Isso não deveria acontecer; tente gerar de novo.',
      detail: err && err.message ? err.message : String(err),
    });
    return;
  }
  if (!gpx || !/<gpx/i.test(gpx)) {
    showError({
      title: 'GPX vazio',
      message: 'O gerador devolveu um arquivo inválido. Tente gerar a rota novamente.',
    });
    return;
  }
  state.fileName = downloadName(name);
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  const blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8' });
  state.blobUrl = URL.createObjectURL(blob);

  el.linkGpx.href = state.blobUrl;
  el.linkGpx.download = state.fileName;
  el.linkGpx.hidden = false;
  el.btnBaixar.disabled = false;
  el.downloadHint.hidden = true;
  const kb = Math.max(1, Math.round(blob.size / 1024));
  el.fileMeta.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = state.fileName;
  el.fileMeta.append(strong, document.createTextNode(' · ' + kb + ' KB · ' + formatPoints(route.points.length) + ' pontos' + (state.elevationApplied ? ' · com elevação' : ' · sem elevação')));
}

function selectRoute(index) {
  if (index < 0 || index >= state.routes.length) return;
  state.selected = index;
  const route = state.routes[index];
  renderAlternatives();
  renderMapDetails();
  renderStats(route, state.places);
  rebuildGpx(state.places);
  drawRoute(route, state.places).catch(function (mapErr) {
    showMapFallback();
    addWarning('Desenho do mapa falhou (' + (mapErr && mapErr.message ? mapErr.message : 'erro no Leaflet') + '). Estatísticas e GPX não são afetados.');
  });
  setStatus('Mostrando ' + (index === 0 ? 'rota recomendada' : 'alternativa ' + index) + ': ' + formatDistance(route.distanceKm) + ' km · ' + formatDuration(route.durationMin) + '.', 'ok');
}

/* -------------------------------------------------------------- fluxo --- */

function resetResults() {
  state.routes = [];
  state.selected = 0;
  state.places = [];
  state.fileName = '';
  state.elevationApplied = false;
  clearWarnings();
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = '';
  }
  el.linkGpx.hidden = true;
  el.linkGpx.removeAttribute('href');
  el.linkGpx.removeAttribute('download');
  el.btnBaixar.disabled = true;
  el.downloadHint.hidden = false;
  el.fileMeta.replaceChildren();
  el.stats.replaceChildren();
  el.listaPontos.replaceChildren();
  el.altList.replaceChildren();
  el.alternativas.hidden = true;
  el.mapaDetalhes.hidden = true;
  el.resultados.hidden = true;
  if (state.routeLayer && state.map) {
    state.map.removeLayer(state.routeLayer);
    state.routeLayer = null;
  }
  if (state.markerLayer) state.markerLayer.clearLayers();
}

async function applyElevation(routes) {
  setStatus('Consultando elevação no Open-Meteo…', 'loading');
  let applied = 0;
  for (let i = 0; i < routes.length; i++) {
    try {
      // allowPartial: se um lote falhar, mantemos a elevação dos lotes que deram certo.
      const withEle = await addElevation(routes[i].points, {
        apiBase: state.apiBase,
        allowPartial: true,
        onProgress: function (done, total) {
          if (total > 1) setStatus('Consultando elevação: lote ' + done + ' de ' + total + '…', 'loading');
        },
      });
      if (Array.isArray(withEle) && withEle.length) {
        routes[i].points = withEle;
        const comEle = withEle.filter(function (p) { return typeof p.ele === 'number'; }).length;
        if (comEle > 0) {
          applied += 1;
          if (comEle < withEle.length) {
            addWarning('A elevação veio parcial: ' + formatPoints(comEle) + ' de ' + formatPoints(withEle.length) + ' pontos têm altitude. O restante fica sem <ele>.');
          }
        } else {
          addWarning('O Open-Meteo não devolveu altitude para esta rota. O GPX será gerado sem <ele>.');
        }
      }
    } catch (err) {
      const msg = String(err && err.message ? err.message : 'falha no Open-Meteo');
      const code = String((err && err.code) || '');
      if (code === 'rate_limited' || /429|limite|rate.?limit|too many/i.test(msg)) {
        addWarning('Limite temporário de elevação no Open-Meteo (429). Você pode baixar o GPX agora, sem elevação, e tentar de novo em cerca de 1 minuto.');
      } else {
        addWarning('Não foi possível obter a elevação (' + msg + '). O GPX será gerado sem <ele>.');
      }
    }
  }
  state.elevationApplied = applied > 0;
  return applied;
}

let running = false;

async function runGenerate() {
  if (running) return;
  const value = el.url.value.trim();

  // Uma tentativa que falha depois de um resultado bem-sucedido não pode deixar
  // o mapa, as estatísticas e o GPX antigos na tela: o arquivo baixado deixaria
  // de corresponder ao link que está no campo.
  resetResults();

  if (!value) {
    showError({
      title: 'Cole um link do Google Maps',
      message: 'Sem o link não há como montar a rota. Copie o endereço da aba do Google Maps com origem e destino e cole no campo acima.',
      focusInput: true,
    });
    return;
  }

  let parsed = null;
  try {
    parsed = parseMapsUrl(value);
  } catch (err) {
    showError({
      title: 'Link inválido',
      message: 'Não consegui interpretar esse texto como um link do Google Maps. Copie novamente a URL completa do navegador.',
      focusInput: true,
      detail: err && err.message ? err.message : String(err),
    });
    return;
  }

  if (!parsed || !parsed.ok) {
    const fb = feedbackFor(parsed || { ok: false });
    showError({
      title: 'Link não reconhecido',
      message: fb.text + ' Use um link de direções do Google Maps, por exemplo google.com/maps/dir/Origem/Destino.',
      focusInput: true,
      detail: parsed && parsed.reason ? 'reason: ' + parsed.reason : undefined,
    });
    return;
  }

  if (parsed.kind === 'short') {
    running = true;
    setLoading(true, 'Expandindo…');
    clearError();
    setStatus('Abrindo o link curto do Google Maps…', 'loading');
    let expanded = null;
    let expandErr = null;
    try {
      expanded = await resolveShortLink(value, { apiBase: PUBLIC_EXPAND_API, timeoutMs: 15000 });
    } catch (err) {
      expandErr = err;
    }

    // O resolvedor devolve 404 para links expirados e 429 quando o IP atinge a cota.
    if (expandErr) {
      running = false;
      setLoading(false);
      const status = expandErr && expandErr.status ? Number(expandErr.status) : 0;
      const msg = String(expandErr && expandErr.message ? expandErr.message : expandErr);
      if (status === 429) {
        showError({ title: 'Limite diário de links curtos atingido', message: msg, focusInput: true });
        return;
      }
      const expirado = status === 404 || /404|not.?found|expirad|expired|invalid_link/i.test(msg);
      showError({
        title: expirado ? 'Link curto inválido ou expirado' : 'Não consegui expandir o link curto',
        message: expirado
          ? 'Este link curto não existe mais ou expirou. Abra o Google Maps, monte a rota e copie a URL completa (a que começa com google.com/maps/dir/).'
          : 'Abra as direções no Google Maps pelo navegador e cole aqui a URL da barra de endereços.',
        focusInput: true,
        detail: msg + (status ? ' (HTTP ' + status + ')' : ''),
      });
      return;
    }

    const next = expanded && expanded.parsed ? expanded.parsed : null;
    if (!next) {
      running = false;
      setLoading(false);
      showError({
        title: 'Não consegui expandir o link curto',
        message: 'O redirecionamento não levou a uma rota do Google Maps reconhecível. Abra o link no navegador, copie a URL longa e cole aqui.',
        focusInput: true,
        detail: expanded && expanded.finalUrl ? 'URL final: ' + expanded.finalUrl : undefined,
      });
      return;
    }
    if (!next.ok) {
      running = false;
      setLoading(false);
      showError({
        title: 'Link curto sem rota',
        message: 'O link curto foi aberto, mas não aponta para uma rota de direções. Abra as direções no Google Maps e copie a URL completa.',
        focusInput: true,
        detail: 'reason: ' + (next.reason || 'desconhecido'),
      });
      return;
    }

    // Link curto costuma resolver para /maps/search/lat,lng (um LUGAR), não para /dir/.
    if (next.kind === 'place' || next.kind === 'coords' || next.kind === 'unsupported') {
      running = false;
      setLoading(false);
      showError({
        title: 'O link curto aponta para um local, não para uma rota',
        message:
          'Ele abre um ponto no mapa, sem origem e destino. Abra as direções no Google Maps (Rota > defina A e B), ' +
          'copie a URL completa e cole aqui. A URL de rota começa com google.com/maps/dir/.',
        focusInput: true,
        detail: 'kind: ' + (next.kind || 'desconhecido'),
      });
      return;
    }
    parsed = next;
    el.url.value = expanded.finalUrl || value;
    setFeedback('Link curto expandido.', 'ok');
  }

  if (parsed.kind !== 'directions' && parsed.kind !== 'coords') {
    showError({
      title: 'Esse link não é de uma rota',
      message:
        'O link abre um lugar, não um trajeto com origem e destino. No Google Maps, trace a rota (Rota > definir A e B) e copie a URL, ' +
        'que fica no formato google.com/maps/dir/ORIGEM/DESTINO.',
      focusInput: true,
      detail: 'kind: ' + parsed.kind,
    });
    return;
  }

  if (parsed.travelmode && parsed.travelmode !== 'transit' && !state.userChangedMode) {
    el.modo.value = parsed.travelmode;
  }
  if (parsed.travelmode === 'transit') {
    addWarning('O link pedia transporte público. Este modo não é suportado pelas APIs públicas gratuitas de rota; geramos o traçado de carro.');
    if (!state.userChangedMode) el.modo.value = 'driving';
  }

  const profile = el.modo.value;
  running = true;
  setLoading(true, 'Calculando…');
  clearError();
  resetResults();
  state.lastParsed = parsed;
  setStatus('Lendo o link…', 'loading');

  try {
    state.places = await resolvePlaces(parsed);
    setStatus(
      profile === 'driving'
        ? 'Calculando a rota de carro com OSRM (OpenStreetMap)…'
        : 'Calculando a rota com Valhalla (OpenStreetMap)…',
      'loading'
    );

    const result = await requestRoute(state.places, profile);
    if (!result || !result.ok || !Array.isArray(result.routes) || !result.routes.length) {
      const routeError = result && result.error ? result.error : null;
      // O núcleo devolve error como objeto { code, message } (mas aceitamos string também).
      const message = routeError
        ? (typeof routeError === 'string' ? routeError : (routeError.message || String(routeError)))
        : 'O roteador não devolveu nenhuma rota.';
      const code = routeError && typeof routeError === 'object' ? routeError.code : 'no-route';
      const attempts = result && Array.isArray(result.attempts) ? result.attempts : null;
      throw Object.assign(new Error(message), {
        userCode: code,
        attempts: attempts,
        status: result && result.status,
      });
    }

    const usable = result.routes.filter(function (r) { return r && Array.isArray(r.points) && r.points.length >= 2; });
    if (!usable.length) {
      throw Object.assign(new Error('As rotas retornadas vieram sem pontos utilizáveis.'), { userCode: 'no-route' });
    }

    state.routes = usable;
    state.selected = 0;
    state.detectedProfile = result.profile || profile;

    if (el.elevacao.checked) {
      await applyElevation(state.routes);
    } else {
      state.elevationApplied = false;
    }

    el.resultados.hidden = false;
    renderPlaces(state.places);
    renderAlternatives();
    renderMapDetails();
    renderStats(state.routes[0], state.places);
    rebuildGpx(state.places);

    // O mapa é acessório: se o Leaflet falhar aqui, a rota e o GPX seguem válidos.
    try {
      await drawRoute(state.routes[0], state.places);
    } catch (mapErr) {
      showMapFallback();
      addWarning('Desenho do mapa falhou (' + (mapErr && mapErr.message ? mapErr.message : 'erro no Leaflet') + '). Estatísticas e GPX não são afetados.');
    }

    const route = state.routes[0];
    setStatus('Rota pronta: ' + formatDistance(route.distanceKm) + ' km · ' + formatDuration(route.durationMin) + ' · ' + formatPoints(route.points.length) + ' pontos.', 'ok');
    if (el.erro.hidden) setLoading(false);
    el.resultados.focus({ preventScroll: true });
    el.resultados.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    resetResults();
    showError(describeError(err));
  } finally {
    running = false;
    setLoading(false);
  }
}

el.form.addEventListener('submit', function (event) {
  event.preventDefault();
  runGenerate();
});

el.btnBaixar.addEventListener('click', function () {
  if (el.linkGpx.href) el.linkGpx.click();
});

el.btnLimpar.addEventListener('click', function () {
  el.url.value = '';
  el.nome.value = '';
  el.elevacao.checked = false;
  el.modo.value = 'driving';
  state.userChangedMode = false;
  resetResults();
  clearError();
  setFeedback('Cole um link para começar.', 'idle');
  setStatus('Cole um link e clique em Gerar rota.', 'idle');
  el.url.focus();
});

el.btnMapaRetry.addEventListener('click', async function () {
  el.mapaFallback.hidden = true;
  try {
    await ensureMap();
    if (state.routes.length) await drawRoute(state.routes[state.selected], state.places);
    if (!el.mapaFallback.hidden) return;
    setStatus('Mapa carregado de novo.', 'ok');
  } catch (err) {
    showMapFallback();
    setStatus('O mapa continua indisponível. O GPX e as estatísticas não dependem dele.', 'erro');
  }
});

window.addEventListener('beforeunload', function () {
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
});

/* ----------------------------------------------------------------- init --- */

el.btnGerar.querySelector('.btn-label').textContent = 'Gerar rota';
setStatus('Cole um link e clique em Gerar rota.', 'idle');
detectEnv();
