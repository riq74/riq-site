const byId = id => document.getElementById(id);
const grid = byId('grid');
const batchMode = byId('batchMode');
const batchStatus = byId('batchStatus');
const btnProcess = byId('btnProcess');
const btnStop = byId('btnStop');
const btnClear = byId('btnClear');
const btnDownloadAll = byId('btnDownloadAll');
const tolSlider = byId('tolerance');
const featherSlider = byId('feather');
const items = [];
let batchBusy = false;
let batchStop = false;
let zipBusy = false;
let worker;
let requestId = 0;
let pending;

function status(element, message, error = false) {
  element.textContent = message;
  element.dataset.error = String(error);
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  byId('tab-batch').classList.toggle('active', tab === 'batch');
  byId('tab-manual').classList.toggle('active', tab === 'manual');
  if (tab === 'manual' && editor && !canvas.width) fitImage();
}

function createMaskWorker() {
  if (location.protocol !== 'file:') {
    return new Worker(new URL('./recorte-worker.js', location.href), { type: 'module' });
  }

  // A blob worker inherits the local page's origin and can load the remote WASM runtime.
  const source = new Blob([`(${startMaskWorker.toString()})();`], { type: 'text/javascript' });
  const url = URL.createObjectURL(source);
  try {
    const localWorker = new Worker(url);
    const release = () => URL.revokeObjectURL(url);
    localWorker.addEventListener('message', release, { once: true });
    localWorker.addEventListener('error', release, { once: true });
    return localWorker;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function aiMask(data, notify) {
  if (pending) return Promise.reject(new Error('Aguarde o processamento em andamento e tente novamente.'));
  if (!worker) {
    try {
      worker = createMaskWorker();
    } catch {
      return Promise.reject(new Error('Não foi possível iniciar a IA neste navegador. Você ainda pode usar o editor manual e o lote por cor.'));
    }
    worker.onmessage = ({ data: result }) => {
      if (result.id !== pending?.id) return;
      if (result.status) {
        pending.notify(result.status);
        return;
      }
      const { resolve, reject } = pending;
      pending = null;
      if (result.error) reject(new Error(result.error));
      else resolve(result.mask);
    };
    worker.onerror = () => {
      pending?.reject(new Error('A IA não iniciou neste navegador. Tente novamente ou use as ferramentas manuais.'));
      pending = null;
      worker.terminate();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending = { id, resolve, reject, notify };
    try {
      worker.postMessage({ ...data, id });
    } catch (error) {
      pending = null;
      reject(error);
    }
  });
}

async function decode(file) {
  let image;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error('Imagem inválida ou formato incompatível.');
  }
  // Bound canvas and undo memory while exporting supported images at full size.
  if (image.width * image.height > 16_000_000 || Math.max(image.width, image.height) > 8192) {
    image.close();
    throw new Error('A imagem excede 16 megapixels ou 8.192 pixels de largura ou altura.');
  }
  return image;
}

function canvasFor(width, height) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function png(element) {
  return new Promise((resolve, reject) => {
    element.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Não foi possível gerar o PNG.'));
    }, 'image/png');
  });
}

function alphaFrom(data) {
  const alpha = new Uint8ClampedArray(data.length / 4);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[4 * i + 3];
  return alpha;
}

function writeAlpha(data, alpha) {
  for (let i = 0; i < alpha.length; i++) data[4 * i + 3] = alpha[i];
}

function scaleAiMask(mask, width, height, original) {
  const source = canvasFor(mask.width, mask.height);
  const sourceCtx = source.getContext('2d');
  const pixels = sourceCtx.createImageData(mask.width, mask.height);
  writeAlpha(pixels.data, mask.alpha);
  sourceCtx.putImageData(pixels, 0, 0);

  const target = canvasFor(width, height);
  const ctx = target.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, mask.width * (mask.cropWidth ?? 1),
    mask.height * (mask.cropHeight ?? 1), 0, 0, width, height);
  const alpha = alphaFrom(ctx.getImageData(0, 0, width, height).data);
  for (let i = 0; i < alpha.length; i++) alpha[i] *= original[i] / 255;
  target.width = target.height = 0;
  return alpha;
}

function boxAverage(source, target, lines, length, along, across, radius) {
  const diameter = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const start = line * across;
    const last = start + (length - 1) * along;
    let sum = (radius + 1) * source[start];
    for (let x = 1; x <= radius; x++) {
      sum += source[Math.min(last, start + x * along)];
    }
    for (let x = 0; x < length; x++) {
      const i = start + x * along;
      target[i] = sum / diameter;
      sum += source[Math.min(last, i + (radius + 1) * along)]
        - source[Math.max(start, i - radius * along)];
    }
  }
}

function roundCoverage(coverage, scratch, width, height, radius) {
  for (let pass = 0; pass < 2; pass++) {
    boxAverage(coverage, scratch, height, width, 1, width, radius);
    boxAverage(scratch, coverage, width, height, width, 1, radius);
  }
}

function softenEdges(mask, original, width, height, strength) {
  if (!strength) return mask;

  const longSide = Math.max(width, height);
  const referenceRadius = [0, 1.6, 3.4, 6.0][strength];
  const radius = Math.max(1, Math.min(64, Math.round(referenceRadius * longSide / 400)));
  const coverage = new Uint8ClampedArray(mask.length);
  let hasTransparentPixels = false;
  for (let i = 0; i < mask.length; i++) {
    const alpha = original[i];
    if (alpha) coverage[i] = 255 * mask[i] / alpha;
    else hasTransparentPixels = true;
  }

  const scratch = new Uint8ClampedArray(mask.length);
  roundCoverage(coverage, scratch, width, height, radius);

  // Weight only pixels available in the original. Its alpha still caps the PNG.
  let weights;
  if (hasTransparentPixels) {
    weights = Uint8ClampedArray.from(original, alpha => alpha ? 255 : 0);
    roundCoverage(weights, scratch, width, height, radius);
  }
  const low = [0, 0.30, 0.32, 0.37][strength];
  const high = [0, 0.70, 0.73, 0.77][strength];
  for (let i = 0; i < coverage.length; i++) {
    const weight = weights ? weights[i] : 255;
    const normalized = weight ? coverage[i] / weight : 0;
    const t = Math.max(0, Math.min(1, (normalized - low) / (high - low)));
    coverage[i] = original[i] * t * t * (3 - 2 * t);
  }
  return coverage;
}

function editorAlpha(state) {
  const { original, rgba, selection } = state;
  const { mask, edgeStrength } = selection?.mask ? selection : state;
  return softenEdges(mask, original, rgba.width, rgba.height, edgeStrength);
}

function contentFrame(alpha, width, height) {
  let peak = 0;
  for (const value of alpha) {
    peak = Math.max(peak, value);
    if (peak >= 240) break;
  }
  if (!peak) return null;
  const cutoff = Math.min(24, Math.max(1, Math.round(peak / 10)));
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    let first = 0;
    while (first < width && alpha[offset + first] < cutoff) first++;
    if (first === width) continue;

    let last = width - 1;
    while (last > first && alpha[offset + last] < cutoff) last--;
    left = Math.min(left, first);
    right = Math.max(right, last);
    top = Math.min(top, y);
    bottom = y;
  }
  const contentWidth = right - left + 1;
  const contentHeight = bottom - top + 1;
  if (contentWidth === width && contentHeight === height) return null;

  let padding = Math.max(1, Math.round(Math.max(contentWidth, contentHeight) * 0.04));
  while (padding && ((contentWidth + 2 * padding) * (contentHeight + 2 * padding) > 16_000_000
    || Math.max(contentWidth, contentHeight) + 2 * padding > 8192)) padding--;
  return {
    x: left - padding, y: top - padding,
    width: contentWidth + 2 * padding, height: contentHeight + 2 * padding,
  };
}

async function encodeResult(source, frame, autoFrame) {
  if (!frame) return { blob: await png(source), frame, autoFrame };
  const framed = canvasFor(frame.width, frame.height);
  try {
    framed.getContext('2d').drawImage(source, -frame.x, -frame.y);
    return { blob: await png(framed), frame, autoFrame };
  } finally {
    framed.width = framed.height = 0;
  }
}

function wirePicker(zone, input, select) {
  zone.addEventListener('dragover', event => {
    event.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', event => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    select(event.dataTransfer.files);
  });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    select(input.files);
    input.value = '';
  });
}

wirePicker(byId('dropZone'), byId('fileInput'), addFiles);
wirePicker(byId('mDrop'), byId('mFileIn'), files => {
  if (files[0]) loadEditor(files[0]);
});

function addFiles(files) {
  if (batchBusy || zipBusy) {
    status(batchStatus, 'Aguarde o lote atual para adicionar imagens.');
    return;
  }
  for (const file of files) {
    const item = { file, originalUrl: URL.createObjectURL(file), blob: null, resultUrl: null };
    items.push(item);
    renderCard(item);
  }
  byId('batchToolbar').style.display = items.length ? 'flex' : 'none';
  byId('batchNameOptions').hidden = !items.length;
  updatePreview();
  updateBatchButtons();
}

function renderCard(item) {
  const card = document.createElement('article');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-imgs">
      <div class="orig"><span class="badge">Original</span></div>
      <div class="cdivider"></div>
      <div class="result"><div class="processing">Aguardando</div></div>
    </div>
    <div class="card-info">
      <span class="card-name"></span>
      <button class="card-dl" disabled>Editar</button>
      <button class="card-dl" disabled>PNG</button>
    </div>`;
  card.querySelector('.orig').prepend(previewButton(item, 'original'));
  const name = card.querySelector('.card-name');
  name.textContent = name.title = item.file.name;
  item.result = card.querySelector('.result');
  [item.edit, item.download] = card.querySelectorAll('.card-info button');
  item.edit.addEventListener('click', () => {
    switchTab('manual');
    loadEditor(item.file, item);
  });
  item.download.addEventListener('click', () => download(item.blob, outputName(item, items.indexOf(item))));
  grid.append(card);
}

function itemMessage(item, message, error = false) {
  const label = document.createElement('div');
  label.className = error ? 'processing item-error' : 'processing';
  label.textContent = message;
  item.result.replaceChildren(label);
  if (item.resultUrl) item.result.prepend(previewButton(item, 'result'));
}

function setResult(item, { blob, frame, autoFrame }) {
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  Object.assign(item, { blob, frame, autoFrame });
  item.resultUrl = URL.createObjectURL(blob);
  const label = document.createElement('span');
  label.className = 'badge';
  label.textContent = 'Recorte';
  item.result.replaceChildren(previewButton(item, 'result'), label);
  if (previewItem === item) updateBatchPreview();
}

const previewDialog = byId('batchPreview');
let previewItem;
let previewSide;

function previewButton(item, side) {
  const original = side === 'original';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'preview-thumb';
  button.setAttribute('aria-label', `Ampliar ${original ? 'original' : 'recorte'} de ${item.file.name}`);
  const image = new Image();
  image.alt = '';
  image.loading = 'lazy';
  image.src = original ? item.originalUrl : item.resultUrl;
  button.append(image);
  button.addEventListener('click', () => {
    previewItem = item;
    previewSide = side;
    byId('previewTitle').textContent = item.file.name;
    updateBatchPreview();
    previewDialog.showModal();
  });
  return button;
}

function updateBatchPreview() {
  const original = previewSide === 'original';
  const image = byId('previewImage');
  image.src = original ? previewItem.originalUrl : previewItem.resultUrl;
  image.alt = original ? 'Imagem original' : 'Recorte com fundo transparente';
  byId('previewOriginal').setAttribute('aria-pressed', String(original));
  byId('previewResult').setAttribute('aria-pressed', String(!original));
  byId('previewResult').disabled = !previewItem.resultUrl;
}

for (const [id, side] of [['previewOriginal', 'original'], ['previewResult', 'result']]) {
  byId(id).addEventListener('click', () => {
    previewSide = side;
    updateBatchPreview();
  });
}
previewDialog.addEventListener('close', () => {
  if (previewDialog.open) return;
  previewItem = null;
  byId('previewImage').removeAttribute('src');
});
previewDialog.addEventListener('click', event => {
  if (event.target === previewDialog) previewDialog.close();
});

batchMode.addEventListener('change', () => {
  byId('whiteControls').hidden = batchMode.value !== 'white';
  byId('batchAiHint').hidden = batchMode.value !== 'auto';
});
for (const [slider, label] of [[tolSlider, 'tolVal'], [featherSlider, 'featherVal']]) {
  slider.addEventListener('input', () => { byId(label).textContent = slider.value; });
  slider.addEventListener('change', () => {
    if (byId('reprocess').checked && items.length && batchMode.value === 'white') processAll();
  });
}

function updateBatchButtons() {
  const locked = batchBusy || zipBusy;
  btnProcess.disabled = btnClear.disabled = batchMode.disabled = locked;
  tolSlider.disabled = featherSlider.disabled = locked;
  byId('batchAutoFrame').disabled = locked;
  btnDownloadAll.disabled = locked || !items.some(item => item.blob);
  for (const item of items) {
    item.edit.disabled = locked || !item.blob;
    item.download.disabled = !item.blob;
  }
  syncEditorButtons();
}

async function processAll() {
  if (batchBusy || zipBusy || !items.length) return;
  const mode = batchMode.value;
  if (mode === 'auto' && pending) {
    status(batchStatus, 'Aguarde a IA terminar no editor e tente novamente.', true);
    return;
  }
  batchBusy = true;
  batchStop = false;
  btnStop.hidden = false;
  btnStop.disabled = false;
  byId('progressBar').style.display = 'block';
  byId('progressFill').style.width = '0%';
  updateBatchButtons();
  let completed = 0;
  let failed = 0;
  const tolerance = Number(tolSlider.value);
  const feather = Number(featherSlider.value);
  const autoFrame = byId('batchAutoFrame').checked;
  try {
    for (const item of items) {
      if (batchStop) break;
      const progress = `${completed + 1} de ${items.length}`;
      itemMessage(item, 'Processando…');
      status(batchStatus, `Processando imagem ${progress}…`);
      try {
        const result = await processItem(item.file, mode, tolerance, feather, autoFrame, message => {
          if (!batchStop) status(batchStatus, `Imagem ${progress} · ${message}`);
        });
        setResult(item, result);
        item.download.disabled = false;
      } catch (error) {
        failed++;
        itemMessage(item, error.message, true);
      }
      completed++;
      byId('progressFill').style.width = `${100 * completed / items.length}%`;
    }
    const failures = failed ? ` · ${failed} com erro` : '';
    status(batchStatus, `${batchStop && completed < items.length ? 'Lote interrompido' : 'Lote concluído'} · ${completed - failed} concluída(s)${failures}.`, Boolean(failed));
  } finally {
    batchBusy = false;
    btnStop.hidden = true;
    updateBatchButtons();
  }
}

async function processItem(file, mode, tolerance, feather, autoFrame, notify) {
  const image = await decode(file);
  const out = canvasFor(image.width, image.height);
  try {
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, out.width, out.height);
    const original = alphaFrom(pixels.data);
    const alpha = mode === 'auto'
      ? scaleAiMask(await aiMask({ mode, file }, notify), out.width, out.height, original)
      : whiteMask(pixels, original, tolerance, feather);
    writeAlpha(pixels.data, alpha);
    ctx.putImageData(pixels, 0, 0);
    return await encodeResult(out, autoFrame ? contentFrame(alpha, out.width, out.height) : null, autoFrame);
  } finally {
    image.close();
    out.width = out.height = 0;
  }
}

function whiteMask({ data, width, height }, original, tolerance, feather) {
  const mask = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[4 * i];
    const g = data[4 * i + 1];
    const b = data[4 * i + 2];
    const low = Math.min(r, g, b);
    const white = low > 255 - tolerance && Math.max(r, g, b) - low < tolerance;
    mask[i] = white ? 0 : 1;
  }
  const soft = feather ? gaussianBlur(mask, width, height, feather) : mask;
  return Uint8ClampedArray.from(original, (alpha, i) => alpha * soft[i]);
}

function gaussianBlur(source, width, height, radius) {
  const kernel = Float32Array.from({ length: 2 * radius + 1 },
    (_, i) => Math.exp(-((i - radius) ** 2) / (2 * (radius / 2.5) ** 2)));
  const temp = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  for (let axis = 0; axis < 2; axis++) {
    const [input, output] = axis === 0 ? [source, temp] : [temp, result];
    const stride = axis === 0 ? 1 : width;
    const length = axis === 0 ? width : height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const center = axis === 0 ? x : y;
        let value = 0;
        let weight = 0;
        for (let d = Math.max(-radius, -center); d <= Math.min(radius, length - 1 - center); d++) {
          const coefficient = kernel[d + radius];
          value += input[index + d * stride] * coefficient;
          weight += coefficient;
        }
        output[index] = value / weight;
      }
    }
  }
  return result;
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-');
}

function batchPrefix() {
  return safeName(byId('baseName').value.trim());
}

function startNumber() {
  const value = byId('startNum').valueAsNumber;
  return Number.isInteger(value) ? value : 1;
}

function outputName(item, index) {
  const prefix = batchPrefix();
  return prefix ? `${prefix}-${startNumber() + index}.png` : `${safeName(item.file.name.replace(/\.[^.]+$/, ''))}_sem_fundo.png`;
}

function updatePreview() {
  const prefix = batchPrefix();
  byId('renamePreview').textContent = prefix
    ? `${prefix}-${startNumber()}.png, ${prefix}-${startNumber() + 1}.png …`
    : 'Nome original mantido';
}

function download(blob, name) {
  if (!blob) return;
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadZip() {
  zipBusy = true;
  updateBatchButtons();
  const used = new Set();
  try {
    if (typeof JSZip !== 'function') throw new Error('O ZIP está indisponível. Baixe os PNGs individuais ou tente novamente.');
    const zip = new JSZip();
    items.forEach((item, index) => {
      if (!item.blob) return;
      const name = outputName(item, index);
      let unique = name;
      for (let n = 2; used.has(unique); n++) unique = `${name.slice(0, -4)}-${n}.png`;
      used.add(unique);
      zip.file(unique, item.blob);
    });
    status(batchStatus, 'Gerando ZIP…');
    download(await zip.generateAsync({ type: 'blob' }), 'imagens_sem_fundo.zip');
    status(batchStatus, 'ZIP pronto.');
  } catch (error) {
    status(batchStatus, error.message, true);
  } finally {
    zipBusy = false;
    updateBatchButtons();
  }
}

btnProcess.addEventListener('click', processAll);
btnDownloadAll.addEventListener('click', downloadZip);
btnStop.addEventListener('click', () => {
  batchStop = true;
  btnStop.disabled = true;
  status(batchStatus, 'Interrompendo após a imagem atual…');
});
btnClear.addEventListener('click', () => {
  for (const item of items) {
    URL.revokeObjectURL(item.originalUrl);
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  }
  items.length = 0;
  grid.replaceChildren();
  byId('batchToolbar').style.display = 'none';
  byId('batchNameOptions').hidden = true;
  byId('batchNameOptions').open = false;
  byId('progressBar').style.display = 'none';
  byId('baseName').value = '';
  status(batchStatus, '');
  updatePreview();
  updateBatchButtons();
});

const canvas = byId('mCv');
const canvasCtx = canvas.getContext('2d');
const editorStatus = byId('editorStatus');
const originalCanvas = canvasFor(0, 0);
const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });
const displayCanvas = canvasFor(0, 0);
const displayCtx = displayCanvas.getContext('2d');
const editorTools = { wand: 'tWand', brush: 'tBrush', eraser: 'tEraser', pan: 'tPan' };
let editor;
let imageId = 0;
let loadId = 0;
let view = { x: 0, y: 0, scale: 1 };
let viewFrame = '';
let background = 'chk';
let checkers;
let gesture;
let spaceHeld = false;
let paintFrame = 0;

async function loadEditor(file, item) {
  const id = ++loadId;
  const loadStatus = byId('manualLoadStatus');
  loadStatus.hidden = false;
  status(loadStatus, 'Abrindo imagem…');
  let image;
  let edited;
  try {
    image = await decode(file);
    if (item?.blob) edited = await decode(item.blob);
    if (id !== loadId) return;

    closeEditor();
    originalCanvas.width = displayCanvas.width = image.width;
    originalCanvas.height = displayCanvas.height = image.height;
    originalCtx.drawImage(image, 0, 0);
    const rgba = originalCtx.getImageData(0, 0, image.width, image.height);
    const original = alphaFrom(rgba.data);
    const display = displayCtx.createImageData(image.width, image.height);
    let mask = original.slice();
    if (edited) {
      displayCtx.drawImage(edited, item.frame?.x ?? 0, item.frame?.y ?? 0);
      mask = alphaFrom(displayCtx.getImageData(0, 0, image.width, image.height).data);
    }
    // An existing transparent PNG can be framed without running the remover again.
    const alreadyCut = Boolean(edited || (original.includes(0) && contentFrame(original, image.width, image.height)));
    editor = {
      autoFrame: item?.autoFrame ?? true, frame: null,
      id: ++imageId, file, item, rgba, display, original, mask,
      history: [], edgeStrength: 0, ready: alreadyCut, choosing: !alreadyCut, tool: 'pan', preview: alreadyCut, selection: null, busy: false, saving: false,
    };
    byId('mSaveName').value = file.name.replace(/\.[^.]+$/, '') + '_sem_fundo';
    byId('mDrop').hidden = true;
    byId('mEditor').hidden = false;
    byId('editorFileName').textContent = file.name;
    byId('editorDimensions').textContent = `${image.width} × ${image.height} px`;
    loadStatus.hidden = true;
    byId('mRefine').open = false;
    byId('manualTools').open = false;
    byId('editorFileOptions').open = false;
    byId('stageOptions').open = false;
    status(editorStatus, '');
    fitImage();
    refreshEditor();
    byId('editorAiTitle').focus({ preventScroll: true });
  } catch (error) {
    if (id === loadId) status(loadStatus, error.message, true);
  } finally {
    image?.close();
    edited?.close();
  }
}

function closeEditor() {
  if (editor) worker?.postMessage({ mode: 'release', imageId: editor.id });
  editor = null;
  gesture = null;
  originalCanvas.width = originalCanvas.height = 0;
  displayCanvas.width = displayCanvas.height = 0;
}

function mNewImg() {
  loadId++;
  closeEditor();
  byId('mEditor').hidden = true;
  byId('mDrop').hidden = false;
  byId('manualLoadStatus').hidden = true;
  byId('mDrop').focus();
}

function syncEditorButtons() {
  const state = editor;
  if (!state) return;
  const selection = state.selection;
  const blocked = batchBusy || state.busy || state.saving;
  const drawing = selection?.mode === 'guided' && !selection.trace;
  const reviewing = Boolean(selection?.mask && !selection.retry && !state.busy);
  const draft = Boolean(selection?.trace && !selection.confirmed);
  const heading = !selection
    ? state.choosing ? 'Como você quer recortar?' : 'Imagem pronta'
    : state.busy ? 'Preparando a imagem'
    : selection.retry ? 'O recorte não terminou'
    : reviewing ? 'Confira o recorte'
    : drawing ? 'Desenhe na imagem' : 'Confira seu desenho';
  const title = byId('editorAiTitle');
  if (title.textContent !== heading) title.textContent = heading;
  byId('editorChoices').hidden = Boolean(selection) || !state.choosing;
  byId('mAuto').disabled = byId('mCircle').disabled = blocked;
  byId('mCancel').hidden = !selection;
  byId('mConfirmTrace').hidden = !draft;
  byId('mConfirmTrace').disabled = blocked;
  byId('mTryCircle').hidden = selection?.mode !== 'auto' || !(reviewing || selection.retry);
  byId('mTryCircle').disabled = blocked;
  byId('mRedraw').hidden = !selection?.trace || state.busy;
  byId('mRedraw').disabled = blocked;
  const refine = byId('mRefine');
  refine.hidden = !(selection?.trace && !selection.manual && (draft || reviewing || selection.retry));
  const refineLabel = draft ? 'Outras opções de recorte' : 'Preciso corrigir o recorte';
  if (byId('mRefineLabel').textContent !== refineLabel) byId('mRefineLabel').textContent = refineLabel;
  byId('pointHint').hidden = !reviewing;
  byId('mUseTrace').hidden = refine.hidden;
  byId('mUseTrace').disabled = blocked;
  byId('mApply').hidden = !reviewing;
  byId('mApply').disabled = blocked;
  byId('mRetry').hidden = !selection?.retry;
  byId('mRetry').disabled = blocked;
  for (const [id, tool] of [['mKeepPoint', 'keep'], ['mRemovePoint', 'remove']]) {
    const button = byId(id);
    button.hidden = !selection?.box || !selection?.mask || selection.manual;
    button.disabled = blocked;
    button.setAttribute('aria-pressed', String(selection?.tool === tool));
  }
  byId('mUndoPoint').hidden = !selection?.points?.length || selection.manual;
  byId('mUndoPoint').disabled = blocked;
  byId('mSaveButton').hidden = Boolean(selection) || !(state.ready || state.history.length);
  byId('mSaveButton').disabled = state.saving;
  byId('mChooseAgain').hidden = Boolean(selection) || state.choosing;
  byId('editorUndo').hidden = Boolean(selection) || !state.history.length;
  byId('mSaveBatch').hidden = Boolean(selection) || !state.item || !items.includes(state.item);
  byId('mSaveBatch').disabled = batchBusy || zipBusy || state.saving;
  byId('mSaveButton').classList.toggle('ai-primary', byId('mSaveBatch').hidden);
  byId('mPrevBtn').hidden = Boolean(selection);
  byId('mCompare').hidden = !selection?.mask;
  byId('mCompare').setAttribute('aria-pressed', String(Boolean(selection?.comparing)));
  byId('mCompare').textContent = selection?.comparing ? 'Ver recorte' : 'Ver original';
  const edgeVisible = Boolean(selection?.mask || (!selection && (state.ready || state.history.length)));
  byId('edgeControls').hidden = !edgeVisible;
  byId('autoFrame').checked = state.autoFrame;
  byId('autoFrame').disabled = state.busy || state.saving;
  byId('mEdge').disabled = state.busy || state.saving;
  byId('mEdge').value = String(selection?.edgeStrength ?? state.edgeStrength);
  byId('mWrap').setAttribute('aria-busy', String(state.busy));
  byId('manualTools').hidden = Boolean(selection);
  byId('editorFileOptions').hidden = Boolean(selection) || byId('mSaveButton').hidden;
  byId('mNewImage').hidden = Boolean(selection);
}

function refreshEditor() {
  if (!editor) return;
  byId('mPrevBtn').textContent = editor.preview ? 'Voltar à edição' : 'Pré-visualizar';
  for (const [tool, id] of Object.entries(editorTools)) {
    const active = editor.selection ? tool === 'pan' && Boolean(editor.selection.pan) : editor.tool === tool;
    byId(id).classList.toggle('on', active);
    byId(id).setAttribute('aria-pressed', String(active));
  }
  byId('slTol').style.display = editor.tool === 'wand' && !editor.selection ? 'grid' : 'none';
  byId('slBrush').style.display = ['brush', 'eraser'].includes(editor.tool) && !editor.selection ? 'grid' : 'none';
  byId('mWrap').dataset.panning = String(editor.selection ? Boolean(editor.selection.pan) : editor.tool === 'pan');
  syncEditorButtons();
  updateImage();
  drawEditor();
}

function setTool(tool) {
  if (!editor || editor.saving) return;
  if (tool === 'pan' && editor.selection) {
    editor.selection.pan = !editor.selection.pan;
    refreshEditor();
    return;
  }
  endSelection();
  editor.tool = tool;
  editor.preview = false;
  refreshEditor();
}

function togglePrev() {
  if (!editor || editor.selection) return;
  editor.preview = !editor.preview;
  refreshEditor();
}

function setBg(mode) {
  background = mode;
  for (const [id, value] of [['bgChk', 'chk'], ['bgLt', 'lt'], ['bgDk', 'dk']]) {
    byId(id).classList.toggle('on', value === mode);
    byId(id).setAttribute('aria-pressed', String(value === mode));
  }
  drawEditor();
}

function undoSnapshot() {
  const { history, mask } = editor;
  const limit = Math.max(1, Math.min(25, Math.floor(32_000_000 / mask.length)));
  if (history.length >= limit) history.shift();
  history.push({ mask: mask.slice(), edgeStrength: editor.edgeStrength });
}

function mUndo() {
  if (!editor || editor.saving) return;
  if (editor.selection) {
    cancelSelection();
    return;
  }
  if (editor.history.length) {
    Object.assign(editor, editor.history.pop());
    refreshEditor();
  }
}

function mReset() {
  if (!editor || editor.saving) return;
  endSelection();
  undoSnapshot();
  editor.mask.set(editor.original);
  editor.edgeStrength = 0;
  refreshEditor();
}

function updateImage() {
  const { rgba, display, mask, original, preview, selection } = editor;
  const { data } = display;
  if (selection?.mask || preview) {
    data.set(rgba.data);
    const alpha = editorAlpha(editor);
    editor.frame = editor.autoFrame ? contentFrame(alpha, rgba.width, rgba.height) : null;
    writeAlpha(data, alpha);
  } else {
    editor.frame = null;
    // Render an overlay that also shows partially removed pixels.
    for (let i = 0; i < mask.length; i++) {
      const index = i * 4;
      data[index] = 210;
      data[index + 1] = 40;
      data[index + 2] = 40;
      data[index + 3] = Math.round((original[i] - mask[i]) * 0.55);
    }
  }
  displayCtx.putImageData(display, 0, 0);
}

function drawTracePath(ctx, trace, x, y, width, height) {
  ctx.beginPath();
  ctx.moveTo(x + trace[0][0] * width, y + trace[0][1] * height);
  for (let i = 1; i < trace.length; i++) {
    const [px, py] = trace[i];
    ctx.lineTo(x + px * width, y + py * height);
  }
}

function drawEditor() {
  if (!editor) return;
  if (!checkers) {
    const tile = canvasFor(16, 16);
    const ctx = tile.getContext('2d');
    ctx.fillStyle = '#f0f2f7';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#d8dce7';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    checkers = canvasCtx.createPattern(tile, 'repeat');
  }
  canvasCtx.fillStyle = background === 'chk' ? checkers : background === 'lt' ? '#f0f0f0' : '#1a1a1a';
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  const drawing = gesture?.type === 'circle';
  const showingResult = !drawing && (editor.selection
    ? editor.selection.mask && !editor.selection.comparing
    : editor.preview);
  const frame = showingResult ? editor.frame : null;
  const frameKey = frame ? `${frame.x},${frame.y},${frame.width},${frame.height}` : 'original';
  if (frameKey !== viewFrame) {
    const width = frame?.width ?? originalCanvas.width;
    const height = frame?.height ?? originalCanvas.height;
    const scale = 0.93 * Math.min(canvas.width / width, canvas.height / height);
    view = {
      scale,
      x: (canvas.width - width * scale) / 2 - (frame?.x ?? 0) * scale,
      y: (canvas.height - height * scale) / 2 - (frame?.y ?? 0) * scale,
    };
    viewFrame = frameKey;
  }
  const { x, y, scale } = view;
  const width = originalCanvas.width * scale;
  const height = originalCanvas.height * scale;
  if (showingResult) {
    canvasCtx.save();
    if (frame) {
      canvasCtx.beginPath();
      canvasCtx.rect(x + frame.x * scale, y + frame.y * scale, frame.width * scale, frame.height * scale);
      canvasCtx.clip();
    }
    canvasCtx.drawImage(displayCanvas, x, y, width, height);
    canvasCtx.restore();
  } else {
    canvasCtx.drawImage(originalCanvas, x, y, width, height);
    if (!editor.selection) canvasCtx.drawImage(displayCanvas, x, y, width, height);
  }
  const dimensions = `${frame?.width ?? originalCanvas.width} × ${frame?.height ?? originalCanvas.height} px`;
  if (byId('editorDimensions').textContent !== dimensions) byId('editorDimensions').textContent = dimensions;

  const showOutline = !showingResult && !editor.selection?.comparing;
  const trace = drawing ? gesture.trace : (showOutline ? editor.selection?.trace : null);
  if (trace?.length) {
    drawTracePath(canvasCtx, trace, x, y, width, height);
    if (!drawing) {
      canvasCtx.closePath();
      canvasCtx.fillStyle = '#aa78ff28';
      canvasCtx.fill('evenodd');
    }
    canvasCtx.strokeStyle = '#302453';
    canvasCtx.lineWidth = 5;
    canvasCtx.stroke();
    canvasCtx.strokeStyle = '#e5d8ff';
    canvasCtx.lineWidth = 2;
    canvasCtx.stroke();
  }
  for (const [px, py, label] of editor.selection?.comparing ? [] : (editor.selection?.points ?? [])) {
    const sx = x + px * width;
    const sy = y + py * height;
    canvasCtx.beginPath();
    canvasCtx.arc(sx, sy, 8, 0, 2 * Math.PI);
    canvasCtx.fillStyle = label ? '#147344' : '#a82b34';
    canvasCtx.fill();
    canvasCtx.strokeStyle = '#fff';
    canvasCtx.lineWidth = 1.5;
    canvasCtx.stroke();
    canvasCtx.beginPath();
    canvasCtx.moveTo(sx - 4, sy);
    canvasCtx.lineTo(sx + 4, sy);
    if (label) {
      canvasCtx.moveTo(sx, sy - 4);
      canvasCtx.lineTo(sx, sy + 4);
    }
    canvasCtx.stroke();
  }
  byId('mZoom').textContent = `${Math.round(scale * 100)}%`;
}

function fitImage() {
  if (!editor) return;
  const wrap = byId('mWrap');
  if (!wrap.clientWidth || !wrap.clientHeight) {
    canvas.width = 0;
    return;
  }
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  viewFrame = '';
  drawEditor();
}

function zoomAt(x, y, factor) {
  if (!editor || gesture) return;
  const scale = Math.max(Math.min(0.04, view.scale), Math.min(25, view.scale * factor));
  const ratio = scale / view.scale;
  view = { x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio, scale };
  drawEditor();
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function imagePoint([x, y], clamp = false) {
  const nx = (x - view.x) / (view.scale * originalCanvas.width);
  const ny = (y - view.y) / (view.scale * originalCanvas.height);
  if (clamp) return [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
  return nx >= 0 && nx < 1 && ny >= 0 && ny < 1 ? [nx, ny] : null;
}

function schedulePaint() {
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0;
    if (!editor) return;
    updateImage();
    drawEditor();
  });
}

function pixelPoint([x, y]) {
  return [
    Math.min(originalCanvas.width - 1, Math.floor(x * originalCanvas.width)),
    Math.min(originalCanvas.height - 1, Math.floor(y * originalCanvas.height)),
  ];
}

function fill(x, y) {
  const { width, height } = originalCanvas;
  const { original, mask, rgba: { data } } = editor;
  const seed = y * width + x;
  if (!original[seed]) return;
  const limit = (Number(byId('mTol').value) * 2.5) ** 2;
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  queue[0] = seed;
  visited[seed] = 1;
  let tail = 1;

  function visit(i) {
    if (visited[i]) return;
    visited[i] = 1;
    if (!original[i]) return;
    const r = data[i * 4] - data[seed * 4];
    const g = data[i * 4 + 1] - data[seed * 4 + 1];
    const b = data[i * 4 + 2] - data[seed * 4 + 2];
    if (r * r + g * g + b * b <= limit) queue[tail++] = i;
  }

  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const col = i % width;
    mask[i] = 0;
    if (col > 0) visit(i - 1);
    if (col < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < mask.length - width) visit(i + width);
  }
}

function paint(x, y) {
  const { width, height } = originalCanvas;
  const { original, mask, tool } = editor;
  const radius = Number(byId('mBr').value);
  for (let row = Math.max(0, y - radius); row <= Math.min(height - 1, y + radius); row++) {
    for (let col = Math.max(0, x - radius); col <= Math.min(width - 1, x + radius); col++) {
      if ((col - x) ** 2 + (row - y) ** 2 > radius ** 2) continue;
      const i = row * width + col;
      mask[i] = tool === 'eraser' ? original[i] : 0;
    }
  }
}

function endSelection() {
  if (!editor.selection) return;
  editor.selection = null;
  status(editorStatus, '');
}

function cancelSelection() {
  if (!editor?.selection) return;
  endSelection();
  refreshEditor();
  if (!byId('editorChoices').hidden) byId('mAuto').focus();
  else byId('mChooseAgain').focus();
}

function backFromPreview() {
  const selection = editor?.selection;
  if (!selection?.trace || !selection.confirmed || editor.busy) {
    cancelSelection();
    return;
  }
  Object.assign(selection, {
    mask: null, points: [], tool: 'circle', confirmed: false, manual: false,
    retry: false, comparing: false, pan: false,
  });
  byId('mRefine').open = false;
  status(editorStatus, 'Você pode corrigir o desenho ou ver a prévia de novo.');
  refreshEditor();
  byId('mConfirmTrace').focus();
}

function startSelection(mode) {
  if (!editor || editor.busy || batchBusy || editor.saving) return;
  byId('mRefine').open = false;
  editor.selection = {
    mode, tool: 'circle', box: null, points: [], mask: null, retry: false,
    edgeStrength: mode === 'guided' ? 1 : 0,
  };
  if (mode === 'guided') {
    status(editorStatus, 'Arraste o mouse ou o dedo ao redor do que quer manter. Deixe um pouco de espaço em volta.');
    refreshEditor();
    byId('editorAiTitle').focus({ preventScroll: true });
  } else {
    refreshEditor();
    runSelection();
  }
}

async function runSelection() {
  const state = editor;
  const selection = state?.selection;
  if (!selection || state.busy || batchBusy || (selection.mode === 'guided' && !selection.confirmed)) return;
  state.busy = true;
  selection.retry = false;
  selection.comparing = false;
  syncEditorButtons();
  drawEditor();
  status(editorStatus, 'Preparando o recorte…');
  try {
    const { mode, box, points, trace } = selection;
    const mask = await aiMask({ mode, file: state.file, imageId: state.id, box, points, trace }, message => {
      if (editor === state && state.selection === selection) status(editorStatus, message);
    });
    if (editor !== state || state.selection !== selection) return;
    selection.mask = scaleAiMask(mask, state.rgba.width, state.rgba.height, state.original);
    if (selection.tool === 'circle') selection.tool = null;
    status(editorStatus, 'Gostou do resultado? Use este recorte para liberar o download.');
  } catch (error) {
    if (editor === state && state.selection === selection) {
      selection.retry = true;
      status(editorStatus, error.message, true);
    }
  } finally {
    state.busy = false;
    if (editor === state) {
      refreshEditor();
      if (state.selection === selection && document.activeElement === document.body
        && byId('tab-manual').classList.contains('active')) {
        byId(selection.retry ? 'mRetry' : 'mApply').focus({ preventScroll: true });
      }
    }
  }
}

function applySelection() {
  if (!editor?.selection?.mask || editor.busy || editor.selection.retry) return;
  undoSnapshot();
  editor.mask = editor.selection.mask;
  editor.edgeStrength = editor.selection.edgeStrength;
  editor.selection = null;
  editor.preview = true;
  editor.ready = true;
  editor.choosing = false;
  status(editorStatus, '');
  refreshEditor();
  const nextAction = byId('mSaveBatch').hidden ? byId('mSaveButton') : byId('mSaveBatch');
  nextAction.focus();
}

function circleFinished(trace) {
  if (!editor?.selection) return;
  const xs = trace.map(point => point[0]);
  const ys = trace.map(point => point[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if (trace.length < 3 || (box[2] - box[0]) * originalCanvas.width * view.scale < 10
    || (box[3] - box[1]) * originalCanvas.height * view.scale < 10) {
    status(editorStatus, 'Faça um traço maior ao redor do objeto.', true);
    drawEditor();
    return;
  }
  Object.assign(editor.selection, { trace, box, points: [], mask: null, confirmed: false });
  status(editorStatus, 'Se o desenho pegou tudo o que deve ficar, veja a prévia.');
  refreshEditor();
  byId('mConfirmTrace').focus();
}

function useManualTrace() {
  const state = editor;
  const selection = state?.selection;
  if (!selection?.trace || state.busy || state.saving) return;
  const { width, height } = state.rgba;
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const matte = canvasFor(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = matte.getContext('2d');
  drawTracePath(ctx, selection.trace, 0, 0, matte.width, matte.height);
  ctx.closePath();
  ctx.fill('evenodd');
  const alpha = alphaFrom(ctx.getImageData(0, 0, matte.width, matte.height).data);
  const mask = scaleAiMask({ alpha, width: matte.width, height: matte.height }, width, height, state.original);
  Object.assign(selection, { mask, manual: true, confirmed: true, comparing: false, points: [], retry: false });
  status(editorStatus, 'Esta prévia mantém tudo dentro do desenho.');
  refreshEditor();
  byId('mApply').focus();
}

canvas.addEventListener('pointerdown', event => {
  if (!editor || gesture || (event.button !== 0 && event.button !== 1)) return;
  const position = canvasPoint(event);
  const pan = editor.selection ? editor.selection.pan : editor.tool === 'pan';
  if (event.button === 1 || spaceHeld || pan) {
    event.preventDefault();
    gesture = { type: 'pan', id: event.pointerId, position, view: { ...view } };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (editor.busy || editor.saving) return;
  const point = imagePoint(position);
  if (!point) return;
  event.preventDefault();
  const selection = editor.selection;
  if (selection) {
    if (selection.manual) return;
    if (selection.tool === 'circle') {
      gesture = { type: 'circle', id: event.pointerId, trace: [point] };
      canvas.setPointerCapture(event.pointerId);
    } else if (selection.mask && byId('mRefine').open && selection.tool && selection.points.length < 30) {
      selection.points.push([...point, Number(selection.tool === 'keep')]);
      runSelection();
    } else if (selection.points.length >= 30) {
      status(editorStatus, 'Aplique o recorte para continuar os retoques com os pincéis.');
    }
    return;
  }
  if (editor.preview) return;
  const [x, y] = pixelPoint(point);
  undoSnapshot();
  syncEditorButtons();
  if (editor.tool === 'wand') {
    fill(x, y);
  } else {
    gesture = { type: 'paint', id: event.pointerId, last: [x, y] };
    canvas.setPointerCapture(event.pointerId);
    paint(x, y);
  }
  schedulePaint();
});

canvas.addEventListener('pointermove', event => {
  if (!editor || event.pointerId !== gesture?.id) return;
  const position = canvasPoint(event);
  if (gesture.type === 'pan') {
    view.x = gesture.view.x + position[0] - gesture.position[0];
    view.y = gesture.view.y + position[1] - gesture.position[1];
    drawEditor();
  } else if (gesture.type === 'circle') {
    gesture.trace.push(imagePoint(position, true));
    drawEditor();
  } else {
    const [x, y] = pixelPoint(imagePoint(position, true));
    const [fromX, fromY] = gesture.last;
    const dx = x - fromX;
    const dy = y - fromY;
    const steps = Math.ceil(Math.hypot(dx, dy) / Math.max(1, Number(byId('mBr').value) / 3));
    for (let i = 1; i <= steps; i++) paint(Math.round(fromX + dx * i / steps), Math.round(fromY + dy * i / steps));
    gesture.last = [x, y];
    schedulePaint();
  }
});

function finishGesture(event) {
  if (gesture?.id !== event.pointerId) return;
  const finished = gesture;
  gesture = null;
  if (finished.type === 'circle') {
    if (event.type === 'pointerup') circleFinished([...finished.trace, imagePoint(canvasPoint(event), true)]);
    else drawEditor();
  }
}

for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, finishGesture);
canvas.addEventListener('wheel', event => {
  if (!editor) return;
  event.preventDefault();
  zoomAt(...canvasPoint(event), event.deltaY < 0 ? 1.13 : 1 / 1.13);
}, { passive: false });

window.addEventListener('keydown', event => {
  if (!editor || !byId('tab-manual').classList.contains('active')
      || event.target.closest?.('input, textarea, button, select, [contenteditable], [role="button"]')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    spaceHeld = true;
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    mUndo();
  } else if (event.key === 'Escape' && editor.selection) {
    cancelSelection();
  }
});
window.addEventListener('keyup', event => { if (event.code === 'Space') spaceHeld = false; });
window.addEventListener('blur', () => { spaceHeld = false; });
window.addEventListener('resize', fitImage);

async function mSave(toBatch = false) {
  const state = editor;
  if (!state || state.selection || state.saving) return;
  if (toBatch && (batchBusy || zipBusy || !items.includes(state.item))) return;
  state.saving = true;
  syncEditorButtons();
  const out = canvasFor(state.rgba.width, state.rgba.height);
  try {
    const pixels = new ImageData(state.rgba.data.slice(), out.width, out.height);
    const alpha = editorAlpha(state);
    writeAlpha(pixels.data, alpha);
    out.getContext('2d').putImageData(pixels, 0, 0);
    const frame = state.autoFrame ? contentFrame(alpha, out.width, out.height) : null;
    const result = await encodeResult(out, frame, state.autoFrame);
    if (editor !== state) return;
    if (toBatch) {
      if (!items.includes(state.item) || batchBusy || zipBusy) {
        throw new Error('O lote mudou. O recorte ainda pode ser salvo como PNG.');
      }
      setResult(state.item, result);
      status(batchStatus, 'Recorte atualizado no lote.');
      updateBatchButtons();
      switchTab('batch');
    } else {
      const name = safeName(byId('mSaveName').value.trim() || 'imagem_sem_fundo');
      download(result.blob, name.replace(/\.png$/i, '') + '.png');
      status(editorStatus, 'Download iniciado.');
    }
  } catch (error) {
    if (editor === state) status(editorStatus, error.message, true);
  } finally {
    out.width = out.height = 0;
    state.saving = false;
    if (editor === state) syncEditorButtons();
  }
}

byId('mAuto').addEventListener('click', () => startSelection('auto'));
byId('mCircle').addEventListener('click', () => startSelection('guided'));
byId('mApply').addEventListener('click', applySelection);
byId('autoFrame').addEventListener('change', event => {
  if (!editor || editor.busy || editor.saving) return;
  editor.autoFrame = event.target.checked;
  if (editor.selection?.mask) editor.selection.comparing = false;
  else editor.preview = true;
  refreshEditor();
});
byId('mEdge').addEventListener('change', event => {
  if (!editor || editor.busy || editor.saving) return;
  const strength = Number(event.target.value);
  if (editor.selection?.mask) {
    editor.selection.edgeStrength = strength;
    editor.selection.comparing = false;
  } else if (!editor.selection) {
    undoSnapshot();
    editor.edgeStrength = strength;
    editor.preview = true;
  }
  refreshEditor();
});
byId('mChooseAgain').addEventListener('click', () => {
  if (!editor) return;
  editor.choosing = true;
  status(editorStatus, '');
  refreshEditor();
  byId('mAuto').focus();
});
byId('mConfirmTrace').addEventListener('click', () => {
  if (!editor?.selection?.trace || editor.selection.confirmed) return;
  editor.selection.confirmed = true;
  runSelection();
});
byId('mRedraw').addEventListener('click', () => startSelection('guided'));
byId('mTryCircle').addEventListener('click', () => startSelection('guided'));
byId('mUseTrace').addEventListener('click', useManualTrace);
byId('mCompare').addEventListener('click', () => {
  if (!editor?.selection?.mask) return;
  editor.selection.comparing = !editor.selection.comparing;
  syncEditorButtons();
  drawEditor();
});
byId('mCancel').addEventListener('click', backFromPreview);
byId('mRetry').addEventListener('click', runSelection);
for (const [id, tool] of [['mKeepPoint', 'keep'], ['mRemovePoint', 'remove']]) {
  byId(id).addEventListener('click', () => {
    if (!editor?.selection) return;
    editor.selection.tool = tool;
    editor.selection.pan = false;
    editor.selection.comparing = false;
    status(editorStatus, tool === 'keep' ? 'Toque em uma parte que deve ficar.' : 'Toque em uma parte que deve sair.');
    refreshEditor();
  });
}
byId('mUndoPoint').addEventListener('click', () => {
  editor.selection.points.pop();
  runSelection();
});
byId('mSaveBatch').addEventListener('click', () => mSave(true));
byId('mZoomIn').addEventListener('click', () => zoomAt(canvas.width / 2, canvas.height / 2, 1.25));
byId('mZoomOut').addEventListener('click', () => zoomAt(canvas.width / 2, canvas.height / 2, 0.8));
