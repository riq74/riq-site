(() => {
  'use strict';

  /* ==========================================================================
     Constantes e Formatos
     ========================================================================== */
  const DB_NAME = 'riq-tipografia-rua-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'letters';

  const FORMATS = {
    story: { w: 1080, h: 1920, label: '1080 × 1920 px' },
    feed: { w: 1080, h: 1350, label: '1080 × 1350 px' },
    square: { w: 1080, h: 1080, label: '1080 × 1080 px' },
    a4: { w: 1240, h: 1754, label: '1240 × 1754 px' },
    wide: { w: 1920, h: 1080, label: '1920 × 1080 px' }
  };

  const BACKGROUNDS = {
    paper: { bg: '#f3efe4', ink: '#18181b', muted: 'rgba(24,24,27,0.55)', border: '#ffffff' },
    concrete: { bg: '#1c2026', ink: '#f1f5f9', muted: 'rgba(241,245,249,0.55)', border: '#e2e8f0' },
    gallery: { bg: '#090b10', ink: '#f8fafc', muted: 'rgba(248,250,252,0.55)', border: '#f8fafc' },
    clean: { bg: '#ffffff', ink: '#0f172a', muted: 'rgba(15,23,42,0.5)', border: '#e2e8f0' },
    blueprint: { bg: '#0f2847', ink: '#e0f2fe', muted: 'rgba(224,242,254,0.6)', border: '#bae6fd' }
  };

  const RAW_COLLECTION = window.streetCollection || {};
  const COLLECTION = {
    sources: RAW_COLLECTION.sources || {},
    letters: Array.isArray(RAW_COLLECTION.letters) ? RAW_COLLECTION.letters : []
  };
  const STUDIO_DRAFT_KEY = 'riq-tipografia-poster-draft';
  const POSTER_FIELDS = [
    'posterTextInput', 'formatSelect', 'bgSelect', 'customBgInput', 'footerTextInput',
    'letterScaleRange', 'trackingRange', 'jitterRange', 'alignSelect', 'collageBorderToggle',
    'autoMixToggle', 'textureToggle'
  ];

  /* ==========================================================================
     Estado Global
     ========================================================================== */
  const state = {
    db: null,
    letters: [], // { id, char, dataUrl, origin, createdAt, width, height }
    imageCache: new Map(), // id -> HTMLImageElement
    sourceImage: null, // HTMLImageElement | HTMLCanvasElement
    rotatedSource: null,
    cropBox: { x: 80, y: 60, w: 120, h: 150 },
    dragMode: null, // 'move' | 'draw' | 'nw' | 'ne' | 'sw' | 'se'
    dragStart: { x: 0, y: 0 },
    dragStartBox: null,
    selectedChar: null,
    variantChoices: new Map(),
    posterSources: new Set(),
    mode: 'poster', // 'poster' | 'specimen'
    posterOffset: { x: 0, y: 0 },
    posterPhoto: null,
    posterDrag: null,
    posterZoom: 1,
    shuffleSeed: 42,
    paddlePromise: null,
    ocrWorkerPromise: null,
    ocrWorkerQueue: Promise.resolve(),
    ocrRunId: 0,
    scanRunId: 0,
    suggestedChar: '',
    detectedItems: []
  };

  /* ==========================================================================
     Referências DOM
     ========================================================================== */
  const el = {
    uploadPhotoBtn: document.getElementById('uploadPhotoBtn'),
    photoInput: document.getElementById('photoInput'),
    sampleSignBtn: document.getElementById('sampleSignBtn'),
    sampleNeonBtn: document.getElementById('sampleNeonBtn'),
    autoScanOnUploadToggle: document.getElementById('autoScanOnUploadToggle'),
    aiPipelineStatus: document.getElementById('aiPipelineStatus'),

    cropperArea: document.getElementById('cropperArea'),
    cropperCanvas: document.getElementById('cropperCanvas'),
    cropPreviewCanvas: document.getElementById('cropPreviewCanvas'),
    cropQualityLabel: document.getElementById('cropQualityLabel'),
    charInput: document.getElementById('charInput'),
    ocrStatusLabel: document.getElementById('ocrStatusLabel'),
    detectCharBtn: document.getElementById('detectCharBtn'),
    autoOcrToggle: document.getElementById('autoOcrToggle'),
    cutFilterSelect: document.getElementById('cutFilterSelect'),
    originInput: document.getElementById('originInput'),
    rotateRange: document.getElementById('rotateRange'),
    rotateValue: document.getElementById('rotateValue'),
    saveLetterBtn: document.getElementById('saveLetterBtn'),
    autoScanSelectionBtn: document.getElementById('autoScanSelectionBtn'),
    autoScanPhotoBtn: document.getElementById('autoScanPhotoBtn'),
    resetCropBoxBtn: document.getElementById('resetCropBoxBtn'),
    detectedLettersBar: document.getElementById('detectedLettersBar'),
    detectedBarTitle: document.getElementById('detectedBarTitle'),
    saveAllDetectedBtn: document.getElementById('saveAllDetectedBtn'),
    closeDetectedBtn: document.getElementById('closeDetectedBtn'),
    detectedList: document.getElementById('detectedList'),

    alphabetStats: document.getElementById('alphabetStats'),
    alphabetGrid: document.getElementById('alphabetGrid'),
    collectionFilter: document.getElementById('collectionFilter'),
    collectionCredits: document.getElementById('collectionCredits'),
    downloadCreditsBtn: document.getElementById('downloadCreditsBtn'),
    alphabetEmptyHint: document.getElementById('alphabetEmptyHint'),
    variantDrawer: document.getElementById('variantDrawer'),
    variantDrawerTitle: document.getElementById('variantDrawerTitle'),
    variantDrawerList: document.getElementById('variantDrawerList'),
    closeVariantDrawerBtn: document.getElementById('closeVariantDrawerBtn'),
    exportAlphabetBtn: document.getElementById('exportAlphabetBtn'),
    importAlphabetBtn: document.getElementById('importAlphabetBtn'),
    importAlphabetInput: document.getElementById('importAlphabetInput'),
    clearAlphabetBtn: document.getElementById('clearAlphabetBtn'),

    modeButtons: Array.from(document.querySelectorAll('.mode-btn')),
    phraseGroup: document.getElementById('phraseGroup'),
    posterTextInput: document.getElementById('posterTextInput'),
    missingCharsHint: document.getElementById('missingCharsHint'),
    formatSelect: document.getElementById('formatSelect'),
    bgSelect: document.getElementById('bgSelect'),
    customBgWrap: document.getElementById('customBgWrap'),
    photoBgWrap: document.getElementById('photoBgWrap'),
    posterPhotoInput: document.getElementById('posterPhotoInput'),
    downloadTransparentBtn: document.getElementById('downloadTransparentBtn'),
    resetPositionBtn: document.getElementById('resetPositionBtn'),
    customBgInput: document.getElementById('customBgInput'),
    footerTextInput: document.getElementById('footerTextInput'),
    letterScaleRange: document.getElementById('letterScaleRange'),
    letterScaleValue: document.getElementById('letterScaleValue'),
    trackingRange: document.getElementById('trackingRange'),
    trackingValue: document.getElementById('trackingValue'),
    jitterRange: document.getElementById('jitterRange'),
    jitterValue: document.getElementById('jitterValue'),
    alignSelect: document.getElementById('alignSelect'),
    collageBorderToggle: document.getElementById('collageBorderToggle'),
    autoMixToggle: document.getElementById('autoMixToggle'),
    textureToggle: document.getElementById('textureToggle'),
    shuffleVariantsBtn: document.getElementById('shuffleVariantsBtn'),

    posterDimsLabel: document.getElementById('posterDimsLabel'),
    posterCanvas: document.getElementById('posterCanvas'),
    posterZoomRange: document.getElementById('posterZoomRange'),
    posterZoomValue: document.getElementById('posterZoomValue'),
    resetZoomBtn: document.getElementById('resetZoomBtn'),
    sharePosterBtn: document.getElementById('sharePosterBtn'),
    posterSaveHint: document.getElementById('posterSaveHint'),
    downloadPosterBtn: document.getElementById('downloadPosterBtn'),
    toastContainer: document.getElementById('toastContainer')
  };

  /* ==========================================================================
     Utilitários
     ========================================================================== */
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3400);
  }

  function normalizeChar(raw) {
    const cleaned = (raw || '')
      .trim()
      .toLocaleUpperCase('pt-BR')
      .normalize('NFC');
    return cleaned ? Array.from(cleaned)[0] : '';
  }

  function seededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function getContrastInk(hex) {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return '#ffffff';
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#111827' : '#f8fafc';
  }

  /* ==========================================================================
     IndexedDB
     ========================================================================== */
  function openDb() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  function photoStorage(file) {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) { resolve(null); return; }
      const request = indexedDB.open('riq-tipografia-foto-db', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('draft');
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('draft', file ? 'readwrite' : 'readonly');
        const op = file ? tx.objectStore('draft').put(file, 'photo') : tx.objectStore('draft').get('photo');
        let value = null;
        op.onsuccess = () => { value = file || op.result || null; };
        tx.oncomplete = () => { db.close(); resolve(value); };
        tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
      };
    });
  }

  async function loadPosterPhoto(file) {
    const url = URL.createObjectURL(file);
    try { return await loadImage(url); }
    finally { URL.revokeObjectURL(url); }
  }

  function dbGetAll() {
    return new Promise((resolve) => {
      if (!state.db) {
        resolve([]);
        return;
      }
      const tx = state.db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  function dbPut(item) {
    return new Promise((resolve) => {
      if (!state.db) {
        resolve();
        return;
      }
      const tx = state.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  function dbDelete(id) {
    return new Promise((resolve) => {
      if (!state.db) {
        resolve();
        return;
      }
      const tx = state.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  function dbClear() {
    return new Promise((resolve) => {
      if (!state.db) {
        resolve();
        return;
      }
      const tx = state.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async function hydrateCache() {
    await Promise.all(
      [...COLLECTION.letters, ...state.letters].map(async (item) => {
        if (!state.imageCache.has(item.id)) {
          try {
            const img = await loadImage(item.dataUrl);
            state.imageCache.set(item.id, img);
          } catch {
            // Ignora imagem corrompida
          }
        }
      })
    );
  }

  /* ==========================================================================
     Fotos de Rua Sintéticas (para teste imediato)
     ========================================================================== */
  function generateSamplePhoto(kind) {
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 640;
    const ctx = c.getContext('2d');

    if (kind === 'sign') {
      // Parede de azulejo/reboco com placa esmaltada retrô
      ctx.fillStyle = '#d6cec0';
      ctx.fillRect(0, 0, c.width, c.height);

      // Textura sutil de muro
      for (let i = 0; i < 4500; i++) {
        ctx.fillStyle = i % 2 === 0 ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)';
        ctx.fillRect(Math.random() * c.width, Math.random() * c.height, 3, 3);
      }

      // Placa azul esmaltada
      ctx.save();
      ctx.translate(480, 230);
      ctx.rotate(-0.03);
      ctx.fillStyle = '#123a6d';
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 10;
      ctx.fillRect(-350, -110, 700, 220);
      ctx.strokeRect(-338, -98, 676, 196);

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 104px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('RUA NOVA', 0, -14);
      ctx.font = '600 32px sans-serif';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText('CENTRO · Nº 248', 0, 62);
      ctx.restore();

      // Fachada amarela embaixo
      ctx.save();
      ctx.translate(480, 495);
      ctx.rotate(0.02);
      ctx.fillStyle = '#eab308';
      ctx.fillRect(-360, -82, 720, 164);
      ctx.strokeStyle = '#713f12';
      ctx.lineWidth = 6;
      ctx.strokeRect(-360, -82, 720, 164);
      ctx.fillStyle = '#1e1b18';
      ctx.font = '900 84px Impact, Arial Black, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('PADARIA SOL', 0, 4);
      ctx.restore();
    } else {
      // Muro escuro com letreiro neon e estêncil
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, c.width, c.height);

      // Tijolos sutis
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 2;
      for (let y = 0; y < c.height; y += 48) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(c.width, y);
        ctx.stroke();
      }

      // Letreiro Neon
      ctx.save();
      ctx.translate(480, 210);
      ctx.shadowColor = '#d8f057';
      ctx.shadowBlur = 24;
      ctx.fillStyle = '#ecfccb';
      ctx.font = '900 108px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CAFE & BAR', 0, 0);
      ctx.restore();

      // Estêncil vermelho em placa metálica
      ctx.save();
      ctx.translate(480, 460);
      ctx.rotate(-0.025);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(-340, -90, 680, 180);
      ctx.fillStyle = '#dc2626';
      ctx.font = '900 96px Arial Black, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ARTE VIVA!', 0, 0);
      ctx.restore();
    }

    return c;
  }

  /* ==========================================================================
     Recortador Interativo
     ========================================================================== */
  function setSourceImage(img, autoRun = true) {
    state.sourceImage = img;
    state.rotatedSource = null;
    clearScan();
    el.cropperArea.classList.remove('hidden');
    el.rotateRange.value = '0';
    el.rotateValue.textContent = '0°';
    setupCropperDimensions();
    resetCropBox();

    if (autoRun && el.autoScanOnUploadToggle?.checked) {
      scanPhotoForLetters(false);
    }
  }

  function setupCropperDimensions() {
    if (!state.sourceImage) return;
    const maxW = Math.min(680, el.cropperCanvas.parentElement.clientWidth - 16 || 600);
    const maxH = 380;
    const scale = Math.min(maxW / state.sourceImage.width, maxH / state.sourceImage.height, 1);
    el.cropperCanvas.width = Math.max(1, Math.round(state.sourceImage.width * scale));
    el.cropperCanvas.height = Math.max(1, Math.round(state.sourceImage.height * scale));
  }

  function resetCropBox() {
    const w = el.cropperCanvas.width;
    const h = el.cropperCanvas.height;
    const boxW = Math.round(Math.min(110, w * 0.28));
    const boxH = Math.round(Math.min(140, h * 0.42));
    resetCropRecognition();
    state.cropBox = {
      x: Math.round((w - boxW) / 2),
      y: Math.round((h - boxH) / 2),
      w: Math.max(1, boxW),
      h: Math.max(1, boxH)
    };
    drawCropper();
  }

  function getCropSource() {
    const image = state.sourceImage;
    const angle = Number(el.rotateRange.value);
    if (!angle) return image;
    if (state.rotatedSource?.angle === angle) return state.rotatedSource.canvas;

    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(image, -canvas.width / 2, -canvas.height / 2);
    state.rotatedSource = { angle, canvas };
    return canvas;
  }

  function getSourceCropBox() {
    const { width, height } = state.sourceImage;
    const scaleX = width / el.cropperCanvas.width;
    const scaleY = height / el.cropperCanvas.height;
    const { x, y, w, h } = state.cropBox;
    const sx = Math.max(0, Math.min(width - 1, Math.round(x * scaleX)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(y * scaleY)));
    const sw = Math.max(1, Math.min(width, Math.round((x + w) * scaleX)) - sx);
    const sh = Math.max(1, Math.min(height, Math.round((y + h) * scaleY)) - sy);
    return { sx, sy, sw, sh };
  }

  function toDisplayCropBox({ sx, sy, sw, sh }) {
    const scaleX = el.cropperCanvas.width / state.sourceImage.width;
    const scaleY = el.cropperCanvas.height / state.sourceImage.height;
    return { x: sx * scaleX, y: sy * scaleY, w: sw * scaleX, h: sh * scaleY };
  }

  function drawCropper() {
    if (!state.sourceImage) return;
    const ctx = el.cropperCanvas.getContext('2d');
    const w = el.cropperCanvas.width;
    const h = el.cropperCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#090b10';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(getCropSource(), 0, 0, w, h);

    const b = state.cropBox;
    // Escurece área externa
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, w, b.y);
    ctx.fillRect(0, b.y, b.x, b.h);
    ctx.fillRect(b.x + b.w, b.y, w - (b.x + b.w), b.h);
    ctx.fillRect(0, b.y + b.h, w, h - (b.y + b.h));

    // Borda da caixa
    ctx.strokeStyle = '#d8f057';
    ctx.lineWidth = Math.min(2, Math.max(0.8, Math.min(b.w, b.h) / 6));
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    // Alças dos 4 cantos
    const handleSize = Math.min(10, Math.max(2, Math.min(b.w, b.h) * 0.3));
    const corners = [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x, b.y + b.h],
      [b.x + b.w, b.y + b.h]
    ];
    ctx.fillStyle = '#d8f057';
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - handleSize / 2, cy - handleSize / 2, handleSize, handleSize);
    }

    updateCutPreview();
  }

  function applyCutFilter(ctx, w, h, filter) {
    if (filter === 'original') return;
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    if (filter === 'enhanced') {
      // Suavização leve preservando bordas + Unsharp Mask para reduzir pixelado
      const src = new Uint8ClampedArray(d);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const center = src[i + c];
            const n = src[((y - 1) * w + x) * 4 + c];
            const s = src[((y + 1) * w + x) * 4 + c];
            const l = src[(y * w + (x - 1)) * 4 + c];
            const r = src[(y * w + (x + 1)) * 4 + c];
            const avg = (n + s + l + r) * 0.25;
            const diff = center - avg;
            const val = Math.abs(diff) < 5 ? center - diff * 0.2 : center + diff * 0.25;
            d[i + c] = Math.min(255, Math.max(0, Math.round(val)));
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
      return;
    }

    // Para P&B e Duotone: calcula limiar Otsu na imagem já ampliada e aplica curva sigmoide suave (anti-pixel)
    const lumArr = new Uint8Array(w * h);
    for (let i = 0; i < lumArr.length; i++) {
      const p = i * 4;
      lumArr[i] = Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
    }
    const thr = computeOtsuThreshold(lumArr);

    for (let i = 0; i < lumArr.length; i++) {
      const p = i * 4;
      const t = 1 / (1 + Math.exp(-(lumArr[i] - thr) / 14));
      if (filter === 'bw') {
        const v = Math.round(t * 255);
        d[p] = d[p + 1] = d[p + 2] = v;
      } else if (filter === 'duotone') {
        d[p] = Math.round(24 + t * (243 - 24));
        d[p + 1] = Math.round(24 + t * (239 - 24));
        d[p + 2] = Math.round(27 + t * (228 - 27));
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function createEnhancedCutCanvas(source, sx, sy, sw, sh, filterMode, previewSize = 0) {
    const longestSide = Math.max(sw, sh);
    const upscale = filterMode === 'original' ? 1 : Math.max(1, Math.min(8, 512 / longestSide));
    const scale = previewSize ? previewSize / longestSide : Math.min(upscale, 1600 / longestSide);
    const raw = document.createElement('canvas');
    raw.width = sw;
    raw.height = sh;
    raw.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);

    // Amostra só os pixels do recorte ao redimensionar, inclusive nas bordas.
    let out = raw;
    if (scale !== 1) {
      out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(sw * scale));
      out.height = Math.max(1, Math.round(sh * scale));
      const ctx = out.getContext('2d', { willReadFrequently: filterMode !== 'original' });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(raw, 0, 0, out.width, out.height);
    }
    applyCutFilter(out.getContext('2d'), out.width, out.height, filterMode);
    return out;
  }

  function extractCroppedCanvas(filterMode = el.cutFilterSelect.value, previewSize = 0) {
    if (!state.sourceImage) return null;
    const { sx, sy, sw, sh } = getSourceCropBox();
    return createEnhancedCutCanvas(getCropSource(), sx, sy, sw, sh, filterMode, previewSize);
  }

  function updateCutPreview() {
    const { width, height } = el.cropPreviewCanvas;
    const ctx = el.cropPreviewCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    if (!state.sourceImage) return;

    const cut = extractCroppedCanvas(el.cutFilterSelect.value, Math.min(width, height));
    ctx.drawImage(cut, (width - cut.width) / 2, (height - cut.height) / 2);
    const { sw, sh } = getSourceCropBox();
    el.cropQualityLabel.textContent = sh < 24
      ? `${sw} × ${sh} px na foto · poucos detalhes`
      : `${sw} × ${sh} px na foto`;
  }

  function getCanvasCoords(evt) {
    const rect = el.cropperCanvas.getBoundingClientRect();
    const scaleX = el.cropperCanvas.width / rect.width;
    const scaleY = el.cropperCanvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY
    };
  }

  function hitTestCropBox(px, py) {
    const b = state.cropBox;
    const tol = Math.min(10, b.w / 3, b.h / 3);
    if (Math.abs(px - b.x) < tol && Math.abs(py - b.y) < tol) return 'nw';
    if (Math.abs(px - (b.x + b.w)) < tol && Math.abs(py - b.y) < tol) return 'ne';
    if (Math.abs(px - b.x) < tol && Math.abs(py - (b.y + b.h)) < tol) return 'sw';
    if (Math.abs(px - (b.x + b.w)) < tol && Math.abs(py - (b.y + b.h)) < tol) return 'se';
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return 'move';
    return 'draw';
  }

  function clampCropBox(b) {
    const maxW = el.cropperCanvas.width;
    const maxH = el.cropperCanvas.height;
    b.w = Math.max(1, Math.min(b.w, maxW));
    b.h = Math.max(1, Math.min(b.h, maxH));
    b.x = Math.max(0, Math.min(b.x, maxW - b.w));
    b.y = Math.max(0, Math.min(b.y, maxH - b.h));
    return b;
  }

  el.cropperCanvas?.addEventListener('pointerdown', (evt) => {
    if (!state.sourceImage) return;
    resetCropRecognition();
    el.cropperCanvas.setPointerCapture(evt.pointerId);
    const pt = getCanvasCoords(evt);
    state.dragMode = hitTestCropBox(pt.x, pt.y);
    state.dragStart = pt;
    state.dragStartBox = { ...state.cropBox };
  });

  el.cropperCanvas?.addEventListener('pointermove', (evt) => {
    if (!state.dragMode || !state.sourceImage) return;
    const pt = getCanvasCoords(evt);
    const dx = pt.x - state.dragStart.x;
    const dy = pt.y - state.dragStart.y;
    const sb = state.dragStartBox;
    const w = el.cropperCanvas.width;
    const h = el.cropperCanvas.height;

    if (state.dragMode === 'move') {
      state.cropBox = clampCropBox({
        x: sb.x + dx,
        y: sb.y + dy,
        w: sb.w,
        h: sb.h
      });
    } else if (state.dragMode === 'draw') {
      const x1 = Math.max(0, Math.min(state.dragStart.x, pt.x));
      const y1 = Math.max(0, Math.min(state.dragStart.y, pt.y));
      const x2 = Math.min(w, Math.max(state.dragStart.x, pt.x));
      const y2 = Math.min(h, Math.max(state.dragStart.y, pt.y));
      if (x2 - x1 >= 2 && y2 - y1 >= 2) {
        state.cropBox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
    } else {
      let { x, y, w: bw, h: bh } = sb;
      if (state.dragMode.includes('n')) {
        const newY = Math.min(sb.y + sb.h - 1, Math.max(0, sb.y + dy));
        bh = sb.y + sb.h - newY;
        y = newY;
      }
      if (state.dragMode.includes('s')) {
        bh = Math.max(1, Math.min(h - sb.y, sb.h + dy));
      }
      if (state.dragMode.includes('w')) {
        const newX = Math.min(sb.x + sb.w - 1, Math.max(0, sb.x + dx));
        bw = sb.x + sb.w - newX;
        x = newX;
      }
      if (state.dragMode.includes('e')) {
        bw = Math.max(1, Math.min(w - sb.x, sb.w + dx));
      }
      state.cropBox = { x, y, w: bw, h: bh };
    }
    drawCropper();
  });

  el.cropperCanvas?.addEventListener('pointercancel', () => { state.dragMode = null; });
  el.cropperCanvas?.addEventListener('pointerup', () => {
    const wasDragging = Boolean(state.dragMode);
    state.dragMode = null;
    if (wasDragging && el.autoOcrToggle?.checked) {
      detectCurrentCropChar(true);
    }
  });

  /* ==========================================================================
     OCR local (PP-OCRv6 e Tesseract) e segmentação de letras
     ========================================================================== */
  function clearScan() {
    state.scanRunId++;
    state.detectedItems = [];
    el.aiPipelineStatus.textContent = '';
    el.detectedLettersBar.classList.add('hidden');
    el.autoScanPhotoBtn.disabled = false;
    el.autoScanSelectionBtn.disabled = false;
  }

  function resetCropRecognition() {
    state.ocrRunId++;
    if (state.suggestedChar && el.charInput.value === state.suggestedChar) el.charInput.value = '';
    state.suggestedChar = '';
    el.ocrStatusLabel.textContent = '';
  }

  function normalizeTextStr(raw) {
    return (raw || '').toLocaleUpperCase('pt-BR').normalize('NFC');
  }

  async function getPaddleService() {
    if (!state.paddlePromise) {
      state.paddlePromise = (async () => {
        const mod = await import('https://esm.sh/ppu-paddle-ocr@6.7.1/web');
        const service = new mod.PaddleOcrService({
          model: mod.V6_SMALL_MODEL,
          detection: {
            maxSideLength: 1440,
            minimumAreaThreshold: 32,
            paddingVertical: 0.16,
            paddingHorizontal: 0.12
          },
          recognition: {
            minimumConfidence: 0.58,
            strategy: 'per-box'
          }
        });
        await service.initialize();
        return service;
      })().catch((err) => {
        state.paddlePromise = null;
        throw err;
      });
    }
    return state.paddlePromise;
  }

  function computeOtsuThreshold(lumArray) {
    const hist = new Int32Array(256);
    for (let i = 0; i < lumArray.length; i++) hist[lumArray[i]]++;
    const total = lumArray.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];

    let sumB = 0;
    let wB = 0;
    let maxVar = -1;
    let threshold = 128;

    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) {
        maxVar = between;
        threshold = t;
      }
    }
    return threshold;
  }

  function connectedGlyphs(plane, w, h, threshold, typicalWidth, vertical) {
    const ink = Uint8Array.from(plane, (value) => Number(value > threshold));
    const queue = new Int32Array(ink.length);
    const components = [];
    for (let start = 0; start < ink.length; start++) {
      if (!ink[start]) continue;
      queue[0] = start;
      ink[start] = 0;
      let tail = 1;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (let head = 0; head < tail; head++) {
        const i = queue[head];
        const x = i % w, y = Math.floor(i / w);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
        for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
            const next = ny * w + nx;
            if (ink[next]) {
              ink[next] = 0;
              queue[tail++] = next;
            }
          }
        }
      }
      if (tail >= 3) components.push({ x0, y0, x1, y1, area: tail });
    }

    const minHeight = Math.max(5, Math.min(h * 0.28, typicalWidth * 0.72));
    const glyphs = components.filter((b) => {
      const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
      const span = vertical ? bh : bw;
      return bw >= 2 && bh >= minHeight && bw <= bh * 1.75 && span <= typicalWidth * 1.8 &&
        b.area >= minHeight * 1.5 && b.x0 > 0 && b.x1 < w && b.y0 > 0 && b.y1 < h;
    });
    if (!vertical) {
      for (const dot of components) {
        if (glyphs.includes(dot)) continue;
        const host = glyphs.find((b) => {
          const overlap = Math.min(dot.x1, b.x1) - Math.max(dot.x0, b.x0);
          const gap = Math.max(b.y0 - dot.y1, dot.y0 - b.y1);
          return overlap >= (dot.x1 - dot.x0) * 0.6 && gap >= 0 && gap <= (b.y1 - b.y0) * 0.25 &&
            dot.y1 - dot.y0 <= (b.y1 - b.y0) * 0.42 && dot.area <= b.area * 0.35;
        });
        if (host) {
          host.y0 = Math.min(host.y0, dot.y0);
          host.y1 = Math.max(host.y1, dot.y1);
        }
      }
    }
    return glyphs.sort((a, b) => vertical ? a.y0 - b.y0 : a.x0 - b.x0);
  }

  function splitByInkValleys(plane, w, h, chars, threshold) {
    if (chars.length < 3 || chars.length > 12 || w < h * 1.6) return [];
    const top = Math.round(h * 0.34), bottom = Math.round(h * 0.76);
    const ink = new Float32Array(w);
    for (let y = top; y < bottom; y++) {
      for (let x = 0; x < w; x++) {
        if (plane[y * w + x] > threshold) ink[x] += 1 / (bottom - top);
      }
    }
    const weights = chars.map((ch) => 'I1'.includes(ch) ? 0.5 : 'MW'.includes(ch) ? 1.25 : 1);
    const unit = w / weights.reduce((sum, weight) => sum + weight, 0);
    const cuts = [0];
    let expected = 0;
    for (const weight of weights.slice(0, -1)) {
      expected += weight * unit;
      const start = Math.max(cuts.at(-1) + Math.round(unit * 0.48), Math.round(expected - unit * 0.37));
      const end = Math.min(w - 2, Math.round(expected + unit * 0.37));
      let best = -1, bestScore = Infinity;
      for (let x = start; x <= end; x++) {
        const valley = Math.min(ink[x - 1], ink[x]);
        if (valley > 0.14) continue;
        const score = Math.max(ink[x - 1], ink[x]) + Math.abs(expected - x) / unit * 0.33;
        if (score < bestScore) {
          best = x;
          bestScore = score;
        }
      }
      if (best < 0) return [];
      cuts.push(best);
    }
    cuts.push(w);

    const boxes = [];
    for (let i = 0; i < chars.length; i++) {
      let x0 = cuts[i], x1 = cuts[i + 1];
      const width = x1 - x0;
      if (width < unit * 0.4 || width > unit * 1.65) return [];
      while (x1 - x0 > 1 && ink[x0] < 0.12) x0++;
      while (x1 - x0 > 1 && ink[x1 - 1] < 0.12) x1--;
      if (x1 - x0 < width * 0.48) return [];
      let y0 = Math.round(h * 0.14), y1 = Math.round(h * 0.9);
      const rowHasInk = (y) => {
        let count = 0;
        for (let x = x0; x < x1; x++) {
          if (plane[y * w + x] > threshold) count++;
        }
        return count >= (x1 - x0) * 0.22;
      };
      while (y0 < top && !rowHasInk(y0)) y0++;
      while (y1 > bottom && !rowHasInk(y1 - 1)) y1--;
      if (y1 - y0 < h * 0.42) return [];
      boxes.push({ x0, y0, x1, y1 });
    }
    return boxes;
  }

  function segmentCharactersInLineBox(source, box, rawText) {
    const text = normalizeTextStr(rawText).replace(/[\s.,:;()'’/_–—°º-]/g, '');
    if (!/^[A-ZÀ-ÖØ-Þ0-9!?&]+$/.test(text)) return [];
    const chars = Array.from(text);
    const rx = Math.max(0, Math.floor(box.x) - 1);
    const ry = Math.max(0, Math.floor(box.y) - 1);
    const rw = Math.min(source.width, Math.ceil(box.x + box.width) + 1) - rx;
    const rh = Math.min(source.height, Math.ceil(box.y + box.height) + 1) - ry;
    if (rw < 4 || rh < 7) return [];

    const scale = Math.min(1, 1400 / rw, 240 / rh);
    const canvas = createEnhancedCutCanvas(source, rx, ry, rw, rh, 'original', Math.max(rw, rh) * scale);
    const { width: w, height: h } = canvas;
    const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
    const light = new Uint8Array(w * h), dark = new Uint8Array(w * h), darkColor = new Uint8Array(w * h);
    for (let i = 0; i < light.length; i++) {
      const p = i * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      light[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      dark[i] = 255 - light[i];
      darkColor[i] = 255 - Math.max(r, g, b);
    }
    const vertical = h > w * 1.6 && chars.length > 1;
    const span = vertical ? h : w;
    const typicalWidth = span / chars.length;
    let glyphs = [], bestScore = -Infinity;
    for (const plane of [dark, light, darkColor]) {
      const otsu = computeOtsuThreshold(plane);
      for (const change of [0, 12, -8, 26, 42]) {
        const boxes = connectedGlyphs(plane, w, h, otsu + change, typicalWidth, vertical);
        if (boxes.length !== chars.length) continue;
        const heights = boxes.map((b) => b.y1 - b.y0);
        const width = vertical ? boxes.at(-1).y1 - boxes[0].y0 : boxes.at(-1).x1 - boxes[0].x0;
        if (width < span * 0.59 || Math.min(...heights) < Math.max(...heights) * 0.52) continue;
        if (boxes.some((b, i) => i > 0 && (vertical ? boxes[i - 1].y1 > b.y0 : boxes[i - 1].x1 > b.x0))) continue;
        const score = Math.min(...heights) / Math.max(...heights) + width / span +
          boxes.reduce((sum, b) => sum + b.area, 0) / (w * h) * 0.3;
        if (score > bestScore) {
          glyphs = boxes;
          bestScore = score;
        }
      }
    }

    // Só separa letras coladas onde o perfil de tinta tem um vale verificável.
    if (!glyphs.length && /^[a-zÀ-ÖØ-öø-ÿ\d]+$/i.test(rawText.trim())) {
      for (const plane of [dark, darkColor, light]) {
        glyphs = splitByInkValleys(plane, w, h, chars, computeOtsuThreshold(plane) + 13);
        if (glyphs.length) break;
      }
    }
    return glyphs.map((b, i) => {
      const x0 = rx + b.x0 * rw / w, y0 = ry + b.y0 * rh / h;
      const x1 = rx + b.x1 * rw / w, y1 = ry + b.y1 * rh / h;
      return { ch: chars[i], box: { x0, y0, x1, y1, bw: x1 - x0, bh: y1 - y0 } };
    });
  }

  function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) {
        resolve();
        return;
      }
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        s.remove();
        reject(new Error('Falha ao carregar o OCR.'));
      };
      document.head.appendChild(s);
    });
  }

  async function getOcrWorker() {
    if (!state.ocrWorkerPromise) {
      state.ocrWorkerPromise = (async () => {
        await loadExternalScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
        try {
          // Modelo LSTM de alta acurácia (4.0.0_best)
          return await window.Tesseract.createWorker('por', 1, {
            langPath: 'https://tessdata.projectnaptha.com/4.0.0_best'
          });
        } catch {
          return await window.Tesseract.createWorker('por');
        }
      })().catch((err) => {
        state.ocrWorkerPromise = null;
        throw err;
      });
    }
    return state.ocrWorkerPromise;
  }

  function runTesseract(canvas, parameters, output) {
    const next = state.ocrWorkerQueue.then(async () => {
      const worker = await getOcrWorker();
      await worker.setParameters(parameters);
      return worker.recognize(canvas, {}, output);
    });
    state.ocrWorkerQueue = next.catch(() => {});
    return next;
  }

  function prepareOcrCanvas(source, { sx, sy, sw, sh }, scale, pad, background, smoothing = 'high') {
    const cut = createEnhancedCutCanvas(source, sx, sy, sw, sh, 'original', Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * scale));
    const height = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width + pad * 2;
    canvas.height = height + pad * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = smoothing;
    ctx.drawImage(cut, pad, pad, width, height);
    return { canvas, scaleX: width / sw, scaleY: height / sh };
  }

  async function detectCurrentCropChar(silent = false) {
    if (!state.sourceImage) return;
    resetCropRecognition();
    const runId = state.ocrRunId;
    const source = getCropSource();
    const box = getSourceCropBox();
    const selected = { x0: box.sx, y0: box.sy, x1: box.sx + box.sw, y1: box.sy + box.sh };
    const scale = Math.min(5, 220 / Math.max(box.sw, box.sh));
    let text = state.detectedItems.find(({ rawBox: { sx, sy, sw, sh } }) => (
      boxIoU(selected, { x0: sx, y0: sy, x1: sx + sw, y1: sy + sh }) >= 0.68
    ))?.char || '';
    let ambiguous = false;

    if (!text) {
      el.ocrStatusLabel.textContent = 'Identificando…';
      try {
        const service = await getPaddleService();
        if (runId !== state.ocrRunId) return;
        const { canvas } = prepareOcrCanvas(source, box, scale, 18, '#808080');
        const result = await service.recognize(canvas, { flatten: true });
        if (runId !== state.ocrRunId) return;
        text = normalizeTextStr(result.text).trim();
        if (text.length <= 1 && box.sw <= box.sh * 2) {
          const photo = { sx: 0, sy: 0, sw: source.width, sh: source.height };
          const context = await scanWithPaddle(service, source, photo, 0, 16);
          const match = context.find((item) => boxIoU(selected, item.box) >= 0.6);
          if (match) {
            text = match.ch;
          } else if (/^[A-ZÀ-ÖØ-Þ0-9!?&-]$/.test(text)) {
            const alternate = prepareOcrCanvas(source, box, scale * 0.65, 14, '#808080');
            const second = await service.recognize(alternate.canvas, { flatten: true });
            ambiguous = text !== normalizeTextStr(second.text).trim();
            if (ambiguous) text = '';
          }
        }
      } catch (err) {
        console.warn('[Tipografia de Rua] PP-OCRv6 indisponível:', err);
      }
    }

    if (!text && !ambiguous && runId === state.ocrRunId) {
      try {
        const { canvas } = prepareOcrCanvas(source, box, scale, 24, '#ffffff');
        const { data } = await runTesseract(canvas, { tessedit_pageseg_mode: '8', tessedit_char_whitelist: '' });
        if (data.confidence >= 80) text = normalizeTextStr(data.text).trim();
      } catch (err) {
        console.warn('[Tipografia de Rua] Tesseract indisponível:', err);
      }
    }

    if (runId !== state.ocrRunId) return;
    if (/^[A-ZÀ-ÖØ-Þ0-9!?&-]$/.test(text)) {
      state.suggestedChar = text;
      el.charInput.value = text;
      el.ocrStatusLabel.textContent = 'Sugestão';
      return;
    }
    const message = text.length > 1 ? 'Selecione uma letra por vez' : 'Sem leitura segura';
    el.ocrStatusLabel.textContent = message;
    if (!silent) showToast(message, 'info');
  }

  function boxIoU(a, b) {
    const ix0 = Math.max(a.x0, b.x0);
    const iy0 = Math.max(a.y0, b.y0);
    const ix1 = Math.min(a.x1, b.x1);
    const iy1 = Math.min(a.y1, b.y1);
    const iw = Math.max(0, ix1 - ix0);
    const ih = Math.max(0, iy1 - iy0);
    const inter = iw * ih;
    if (!inter) return 0;
    const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
    const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
    return inter / Math.max(1, areaA + areaB - inter);
  }

  async function scanWithTesseractFallback(source, region, onlySelection) {
    const { sx, sy, sw, sh } = region;
    const scale = Math.min(onlySelection ? 3 : 2, 1600 / Math.max(sw, sh));
    const pad = onlySelection ? 16 : 0;
    const { canvas, scaleX, scaleY } = prepareOcrCanvas(source, region, scale, pad, '#ffffff', 'low');
    const { data } = await runTesseract(canvas, {
      tessedit_pageseg_mode: onlySelection ? '6' : '11',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÀÂÃÉÊÍÓÔÕÚÜÇáàâãéêíóôõúüç0123456789!?&-'
    }, { blocks: true });

    const lines = (data.blocks || []).flatMap((block) => block.paragraphs.flatMap((para) => para.lines));
    const candidates = [];
    for (const line of lines) {
      for (const word of line.words) {
        const minConfidence = word.symbols.length === 1 ? (onlySelection ? 78 : 90) : 50;
        if (word.confidence < minConfidence) continue;
        const wordBox = word.bbox;
        const refined = segmentCharactersInLineBox(source, {
          x: sx + (wordBox.x0 - pad) / scaleX,
          y: sy + (wordBox.y0 - pad) / scaleY,
          width: (wordBox.x1 - wordBox.x0) / scaleX,
          height: (wordBox.y1 - wordBox.y0) / scaleY
        }, word.text);
        if (refined.length) {
          candidates.push(...refined.map((glyph) => ({ ...glyph, conf: word.confidence })));
          continue;
        }
        for (const sym of word.symbols) {
          const ch = normalizeTextStr(sym.text);
          if (sym.confidence < 70 || !/^[A-ZÀ-ÖØ-Þ0-9!?&]$/.test(ch)) continue;
          const bb = sym.bbox;
          const x0 = sx + (bb.x0 - pad) / scaleX, y0 = sy + (bb.y0 - pad) / scaleY;
          const x1 = sx + (bb.x1 - pad) / scaleX, y1 = sy + (bb.y1 - pad) / scaleY;
          const bw = x1 - x0, bh = y1 - y0;
          if (bw < 8 || bh < 12 || bw > bh * 1.55) continue;
          const touchesNeighbor = word.symbols.some((other) => other !== sym &&
            Math.min(bb.x1, other.bbox.x1) - Math.max(bb.x0, other.bbox.x0) > (bb.x1 - bb.x0) * 0.35);
          if (!touchesNeighbor) candidates.push({ ch, conf: sym.confidence, box: { x0, y0, x1, y1, bw, bh } });
        }
      }
    }
    return candidates;
  }

  async function scanWithPaddle(service, source, region, pad, minLineHeight) {
    const { sx, sy, sw, sh } = region;
    const scale = Math.min(1, 1400 / Math.max(sw, sh));
    const { canvas, scaleX, scaleY } = prepareOcrCanvas(source, region, scale, pad, '#808080');
    const result = await service.recognize(canvas, { flatten: true });
    const candidates = [];
    for (const item of result.results) {
      const lineBox = {
        x: sx + (item.box.x - pad) / scaleX,
        y: sy + (item.box.y - pad) / scaleY,
        width: item.box.width / scaleX,
        height: item.box.height / scaleY
      };
      if (item.confidence < 0.58 || lineBox.height < minLineHeight) continue;
      const glyphs = segmentCharactersInLineBox(source, lineBox, item.text);
      candidates.push(...glyphs.map((glyph) => ({ ...glyph, conf: item.confidence * 100 })));
    }
    return candidates;
  }

  function fitCandidateToRegion(candidate, { sx, sy, sw, sh }) {
    const box = candidate.box;
    const x0 = Math.max(sx, box.x0);
    const y0 = Math.max(sy, box.y0);
    const x1 = Math.min(sx + sw, box.x1);
    const y1 = Math.min(sy + sh, box.y1);
    if (x1 - x0 < Math.max(1, box.bw - 1) || y1 - y0 < Math.max(1, box.bh - 1)) return null;
    return { ...candidate, box: { x0, y0, x1, y1, bw: x1 - x0, bh: y1 - y0 } };
  }

  async function scanPhotoForLetters(onlySelection = false) {
    if (!state.sourceImage) return;
    clearScan();
    const runId = state.scanRunId;
    el.autoScanPhotoBtn.disabled = true;
    el.autoScanSelectionBtn.disabled = true;
    el.aiPipelineStatus.textContent = 'Carregando reconhecimento…';

    try {
      const source = getCropSource();
      const { width, height } = source;
      const photo = { sx: 0, sy: 0, sw: width, sh: height };
      const region = onlySelection ? getSourceCropBox() : photo;
      let candidates = [];
      let engine = 'PP-OCRv6';

      try {
        const service = await getPaddleService();
        if (runId !== state.scanRunId) return;
        el.aiPipelineStatus.textContent = onlySelection ? 'Lendo área selecionada…' : 'Detectando texto na foto…';
        candidates = (await scanWithPaddle(service, source, region, onlySelection ? 16 : 0, onlySelection ? 10 : 16))
          .map((candidate) => fitCandidateToRegion(candidate, region)).filter(Boolean);
        if (runId !== state.scanRunId) return;
        if (onlySelection && !candidates.length) {
          candidates = (await scanWithPaddle(service, source, photo, 0, 16))
            .map((candidate) => fitCandidateToRegion(candidate, region)).filter(Boolean);
        }
      } catch (err) {
        console.warn('[Tipografia de Rua] PP-OCRv6 indisponível:', err);
      }

      if (runId !== state.scanRunId) return;
      if (!candidates.length) {
        engine = 'Tesseract';
        el.aiPipelineStatus.textContent = 'Tentando outro reconhecimento…';
        candidates = (await scanWithTesseractFallback(source, region, onlySelection))
          .map((candidate) => fitCandidateToRegion(candidate, region)).filter(Boolean);
      }
      if (runId !== state.scanRunId) return;

      candidates.sort((a, b) => b.conf - a.conf);
      const kept = [];
      for (const candidate of candidates) {
        if (kept.some((other) => boxIoU(other.box, candidate.box) > 0.4)) continue;
        kept.push(candidate);
      }
      kept.sort((a, b) => {
        const rowDiff = Math.abs(a.box.y0 - b.box.y0);
        if (rowDiff > Math.min(a.box.bh, b.box.bh) * 0.55) return a.box.y0 - b.box.y0;
        return a.box.x0 - b.box.x0;
      });

      const filter = el.cutFilterSelect.value;
      state.detectedItems = kept.map(({ ch, conf, box }) => {
        const sx = Math.round(box.x0);
        const sy = Math.round(box.y0);
        const sw = Math.max(1, Math.round(box.x1) - sx);
        const sh = Math.max(1, Math.round(box.y1) - sy);
        const out = createEnhancedCutCanvas(source, sx, sy, sw, sh, filter);
        return {
          char: ch, conf: Math.round(conf), rawBox: { sx, sy, sw, sh },
          dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height, savedId: null
        };
      });

      renderDetectedBar();
      const count = state.detectedItems.length;
      el.aiPipelineStatus.textContent = count ? `${engine} · ${count} sugestões` : 'Nenhuma letra isolada';
      if (!count) showToast('Enquadre apenas o letreiro ou faça um recorte manual.', 'info');
    } catch (err) {
      if (runId !== state.scanRunId) return;
      console.warn('[Tipografia de Rua] Falha no reconhecimento:', err);
      el.aiPipelineStatus.textContent = 'OCR indisponível';
      showToast('Falha no reconhecimento. O recorte manual continua disponível.', 'error');
    } finally {
      if (runId === state.scanRunId) {
        el.autoScanPhotoBtn.disabled = false;
        el.autoScanSelectionBtn.disabled = false;
      }
    }
  }

  function renderDetectedBar() {
    if (!state.detectedItems.length) {
      el.detectedLettersBar.classList.add('hidden');
      return;
    }
    el.detectedLettersBar.classList.remove('hidden');
    const pending = state.detectedItems.filter((d) => !d.savedId);
    el.detectedBarTitle.textContent = `${state.detectedItems.length} sugestão(ões) — revise antes de salvar`;
    el.saveAllDetectedBtn.classList.toggle('hidden', pending.length === 0);
    el.detectedList.innerHTML = '';

    state.detectedItems.forEach((item, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'detected-chip';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'detected-chip__btn';
      selectBtn.title = `${item.rawBox.sw} × ${item.rawBox.sh} px na foto · leitura OCR ${item.conf}%`;

      selectBtn.setAttribute('aria-label', `Ajustar recorte de ${item.char}`);
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = item.char;
      selectBtn.appendChild(img);

      selectBtn.addEventListener('click', () => {
        resetCropRecognition();
        state.cropBox = toDisplayCropBox(item.rawBox);
        el.charInput.value = item.char;
        state.suggestedChar = item.char;
        el.ocrStatusLabel.textContent = 'Sugestão';
        drawCropper();
      });

      const editRow = document.createElement('div');
      editRow.className = 'detected-chip__edit';

      const charEdit = document.createElement('input');
      charEdit.type = 'text';
      charEdit.maxLength = 1;
      charEdit.className = 'detected-chip__input';
      charEdit.value = item.char;
      charEdit.setAttribute('aria-label', `Letra detectada ${item.char}`);
      charEdit.addEventListener('input', () => {
        const norm = normalizeChar(charEdit.value);
        if (norm) item.char = norm;
      });

      const saveOneBtn = document.createElement('button');
      saveOneBtn.type = 'button';
      saveOneBtn.className = 'detected-chip__save';
      saveOneBtn.textContent = item.savedId ? '✓' : '+';
      saveOneBtn.title = item.savedId ? 'Já salva no alfabeto' : 'Salvar esta letra no alfabeto';
      saveOneBtn.disabled = Boolean(item.savedId);
      saveOneBtn.addEventListener('click', async () => {
        const ch = normalizeChar(charEdit.value) || item.char;
        if (!ch) return;
        item.char = ch;
        const id = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const saved = {
          id,
          char: ch,
          dataUrl: item.dataUrl,
          origin: el.originInput.value.trim(),
          createdAt: Date.now(),
          width: item.width,
          height: item.height
        };
        item.savedId = id;
        state.letters.push(saved);
        await dbPut(saved);
        await hydrateCache();
        renderAlphabetBank();
        renderPoster();
        renderDetectedBar();
        showToast(`Letra "${ch}" salva!`, 'success');
      });

      editRow.appendChild(charEdit);
      editRow.appendChild(saveOneBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'detected-chip__remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Descartar sugestão';
      removeBtn.addEventListener('click', async () => {
        const removed = state.detectedItems.splice(idx, 1)[0];
        if (removed?.savedId) {
          state.letters = state.letters.filter((l) => l.id !== removed.savedId);
          state.imageCache.delete(removed.savedId);
          await dbDelete(removed.savedId);
          renderAlphabetBank();
          renderPoster();
        }
        renderDetectedBar();
      });

      wrap.appendChild(selectBtn);
      wrap.appendChild(editRow);
      wrap.appendChild(removeBtn);
      el.detectedList.appendChild(wrap);
    });
  }

  /* ==========================================================================
     Banco do Alfabeto
     ========================================================================== */
  function groupLettersByChar(letters) {
    const map = new Map();
    for (const item of letters) {
      if (!map.has(item.char)) map.set(item.char, []);
      map.get(item.char).push(item);
    }
    return map;
  }

  function compareGlyphChars(a, b) {
    const group = (char) => /^[A-Z]$/.test(char) ? 0 : /^[0-9]$/.test(char) ? 1 : 2;
    const groupOrder = group(a) - group(b);
    if (groupOrder) return groupOrder;
    return a.localeCompare(b, 'pt-BR');
  }

  function getVisibleLetters() {
    const filter = el.collectionFilter?.value || 'personal';
    if (filter === 'personal') return state.letters;
    if (filter === 'all') return [...COLLECTION.letters, ...state.letters];
    if (filter === 'streetscape') {
      return COLLECTION.letters.filter((item) => COLLECTION.sources[item.source]?.category !== 'sign');
    }
    if (filter.startsWith('source:')) {
      return COLLECTION.letters.filter((item) => item.source === filter.slice(7));
    }
    return COLLECTION.letters.filter((item) => COLLECTION.sources[item.source]?.category === filter);
  }

  function renderAlphabetBank() {
    const visible = getVisibleLetters();
    const grouped = groupLettersByChar(visible);
    const chars = Array.from(grouped.keys()).sort(compareGlyphChars);
    el.alphabetStats.textContent = visible.length ? `${chars.length} caracteres · ${visible.length} recortes` : '0 recortes';
    el.alphabetEmptyHint.classList.toggle('hidden', visible.length > 0);
    el.alphabetGrid.replaceChildren();

    for (const ch of chars) {
      const list = grouped.get(ch);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.char = ch;
      chip.className = 'letter-chip';
      chip.setAttribute('aria-controls', 'variantDrawer');
      chip.setAttribute('aria-label', `${ch}, ${list.length} variantes`);
      const img = document.createElement('img');
      img.src = list[0].dataUrl;
      img.alt = '';
      img.loading = 'lazy';
      const label = document.createElement('span');
      label.className = 'letter-chip__char';
      label.textContent = ch;
      chip.append(img, label);
      if (list.length > 1) {
        const count = document.createElement('span');
        count.className = 'letter-chip__count';
        count.textContent = `×${list.length}`;
        chip.appendChild(count);
      }
      chip.addEventListener('click', () => {
        displayGlyphVariants(state.selectedChar === ch ? null : ch);
        if (state.selectedChar) {
          const title = el.variantDrawerTitle;
          title.tabIndex = -1;
          title.focus();
        }
      });
      el.alphabetGrid.appendChild(chip);
    }
    displayGlyphVariants(grouped.has(state.selectedChar) ? state.selectedChar : null);
  }

  function displayGlyphVariants(ch) {
    state.selectedChar = ch;
    el.variantDrawer.classList.toggle('hidden', !ch);
    for (const chip of el.alphabetGrid.children) {
      const active = chip.dataset.char === ch;
      chip.classList.toggle('is-selected', active);
      chip.setAttribute('aria-expanded', String(active));
    }
    if (!ch) return;
    const list = getVisibleLetters().filter((item) => item.char === ch);
    el.variantDrawerTitle.textContent = `Variantes de ${ch}`;
    el.variantDrawerList.replaceChildren();

    for (const item of list) {
      const source = COLLECTION.sources[item.source];
      const card = document.createElement('article');
      card.className = 'variant-item';
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = `Variante de ${ch}`;
      const origin = document.createElement('span');
      origin.className = 'variant-item__origin';
      origin.textContent = source
        ? `${source.name} · ${source.city}`
        : item.origin || (item.source ? `Acervo #${item.source}` : 'Foto própria');
      card.append(img, origin);
      if (item.adapted) {
        const note = document.createElement('small');
        note.className = 'variant-note';
        note.textContent = 'Acento composto';
        card.appendChild(note);
      }

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'pill-btn pill-btn--sm';
      if (el.posterCanvas) {
        const styleAction = (button, active) => {
          button.setAttribute('aria-pressed', String(active));
          button.textContent = active ? 'Em uso' : 'Usar no pôster';
          button.classList.toggle('pill-btn--lime', active);
        };
        styleAction(action, state.variantChoices.get(ch) === item.id);
        action.addEventListener('click', () => {
          const active = state.variantChoices.get(ch) !== item.id;
          if (active) state.variantChoices.set(ch, item.id);
          else state.variantChoices.delete(ch);
          for (const other of el.variantDrawerList.querySelectorAll('button')) {
            styleAction(other, active && other === action);
          }
          renderPoster();
        });
      } else {
        action.classList.add('btn-danger');
        action.textContent = 'Remover';
        action.addEventListener('click', async () => {
          await dbDelete(item.id);
          state.letters = state.letters.filter((letter) => letter.id !== item.id);
          state.imageCache.delete(item.id);
          renderAlphabetBank();
          showToast(`Recorte de ${ch} removido.`);
        });
      }
      card.append(action);
      el.variantDrawerList.appendChild(card);
    }
  }

  function pickPosterVariant(ch, list, random, autoMix) {
    const chosen = state.variantChoices.get(ch);
    const pinned = list.find((item) => item.id === chosen);
    if (pinned) return pinned;
    const storefronts = list.filter((item) => COLLECTION.sources[item.source]?.category !== 'sign');
    const variants = storefronts.length ? storefronts : list;
    return variants[autoMix ? Math.floor(random() * variants.length) : 0];
  }

  function rememberStudioDraft() {
    const controls = Object.fromEntries(POSTER_FIELDS.map((key) => [
      key, el[key].type === 'checkbox' ? el[key].checked : el[key].value
    ]));
    try {
      sessionStorage.setItem(STUDIO_DRAFT_KEY, JSON.stringify({
        controls, mode: state.mode, seed: state.shuffleSeed, offset: state.posterOffset, zoom: state.posterZoom, variants: [...state.variantChoices]
      }));
    } catch {
      // O compositor ainda funciona se o armazenamento da sessão estiver indisponível.
    }
  }

  function restoreStudioDraft() {
    try {
      const draft = JSON.parse(sessionStorage.getItem(STUDIO_DRAFT_KEY));
      if (!draft) return;
      for (const key of POSTER_FIELDS) {
        const control = el[key];
        const value = draft.controls?.[key];
        if (control.type === 'checkbox' && typeof value === 'boolean') control.checked = value;
        if (control.type !== 'checkbox' && typeof value === 'string') control.value = value;
      }
      if (Number.isFinite(draft.offset?.x) && Number.isFinite(draft.offset?.y)) state.posterOffset = draft.offset;
      if (Number.isFinite(draft.zoom)) state.posterZoom = Math.max(0.25, Math.min(3, draft.zoom));
      if (draft.controls?.bgSelect === 'photo' && !state.posterPhoto) el.bgSelect.value = 'paper';
      if (draft.mode === 'specimen') state.mode = 'specimen';
      if (Number.isInteger(draft.seed)) state.shuffleSeed = draft.seed;
      if (Array.isArray(draft.variants)) state.variantChoices = new Map(draft.variants);
    } catch {
      // Mantém o rascunho padrão se a sessão não puder ser restaurada.
    }
    for (const button of el.modeButtons) {
      const active = state.mode === button.dataset.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    el.phraseGroup.classList.toggle('hidden', state.mode === 'specimen');
    el.customBgWrap.classList.toggle('hidden', el.bgSelect.value !== 'custom');
    el.posterZoomRange.value = Math.round(state.posterZoom * 100);
    el.posterZoomValue.textContent = el.posterZoomRange.value + '%';
    el.letterScaleValue.textContent = el.letterScaleRange.value + '%';
    el.trackingValue.textContent = el.trackingRange.value + 'px';
    el.jitterValue.textContent = el.jitterRange.value + '°';
  }

  function renderCollectionCredits() {
    const sources = Object.entries(COLLECTION.sources).sort(([, a], [, b]) => a.name.localeCompare(b.name, 'pt-BR'));
    if (!sources.length) {
      if (el.collectionFilter) {
        for (const opt of el.collectionFilter.querySelectorAll('option[value="facade"], option[value="bar"], option[value="sign"]')) {
          opt.hidden = true;
        }
      }
      return;
    }
    const letreiros = document.createElement('optgroup');
    letreiros.label = 'Por letreiro';
    for (const [id, source] of sources) {
      letreiros.appendChild(new Option(source.name, 'source:' + id));
      if (!el.collectionCredits) continue;
      const row = document.createElement('li');
      const photo = document.createElement('a');
      photo.href = source.page;
      photo.textContent = `${source.name} · ${source.city}`;
      row.append(photo, ` — ${source.author}`);
      if (source.changes) row.append(` · Alterações: ${source.changes}`);
      row.append(' · ');
      if (source.licenseUrl) {
        const license = document.createElement('a');
        license.href = source.licenseUrl;
        license.textContent = source.license;
        row.appendChild(license);
      } else {
        row.append(source.license);
      }
      el.collectionCredits.appendChild(row);
    }
    el.collectionFilter.appendChild(letreiros);
  }

  function downloadPosterCredits() {
    const credits = ['Tipografia de Rua', 'As fotografias foram recortadas e tratadas para compor as letras deste pôster.', ''];
    let shareAlike = false;
    for (const id of state.posterSources) {
      const source = COLLECTION.sources[id];
      if (!source) continue;
      credits.push(`${source.name} (${source.city}) — ${source.author}`, source.page,
        [source.license, source.licenseUrl].filter(Boolean).join(' · '));
      if (source.changes) credits.push(`Alterações: ${source.changes}`);
      credits.push('');
      if (source.license?.includes('BY-SA')) shareAlike = true;
    }
    if (shareAlike) {
      credits.push('Para compartilhar, preserve os créditos e siga as condições de atribuição e compartilhamento das licenças acima.');
    }
    const url = URL.createObjectURL(new Blob([credits.join('\n')], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tipografia-de-rua-creditos.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ==========================================================================
     Compositor de Pôster & Cartela
     ========================================================================== */
  function getActiveBackground() {
    const val = el.bgSelect.value;
    if (val === 'custom') {
      const hex = el.customBgInput.value || '#16202a';
      const ink = getContrastInk(hex);
      return {
        bg: hex,
        ink,
        muted: ink === '#111827' ? 'rgba(17,24,39,0.55)' : 'rgba(248,250,252,0.6)',
        border: ink === '#111827' ? '#ffffff' : '#e2e8f0'
      };
    }
    return BACKGROUNDS[val] || BACKGROUNDS.paper;
  }

  function drawPaperGrain(ctx, w, h, seed) {
    const rand = seededRandom(seed + 99);
    ctx.save();
    for (let i = 0; i < 3200; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.045)';
      ctx.fillRect(rand() * w, rand() * h, 2, 2);
    }
    ctx.restore();
  }

  function drawCutoutTile(ctx, img, cx, cy, drawW, drawH, angleRad, withBorder, borderColor) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad);

    if (withBorder) {
      const pad = Math.max(4, Math.round(drawW * 0.055));
      ctx.shadowColor = 'rgba(0, 0, 0, 0.36)';
      ctx.shadowBlur = Math.max(10, drawW * 0.14);
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = borderColor;
      ctx.fillRect(-drawW / 2 - pad, -drawH / 2 - pad, drawW + pad * 2, drawH + pad * 2);
      ctx.shadowColor = 'transparent';
    }

    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }

  function renderPoster(transparent = false) {
    if (!el.posterCanvas) return;
    state.posterSources.clear();
    const fmt = FORMATS[el.formatSelect.value] || FORMATS.feed;
    el.posterDimsLabel.textContent = fmt.label;

    const canvas = el.posterCanvas;
    canvas.width = fmt.w;
    canvas.height = fmt.h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';

    const theme = getActiveBackground();
    const background = el.bgSelect.value;
    if (!transparent && background !== 'transparent') {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, fmt.w, fmt.h);
      if (background === 'photo' && state.posterPhoto) {
        const img = state.posterPhoto;
        const scale = Math.max(fmt.w / img.width, fmt.h / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (fmt.w - w) / 2, (fmt.h - h) / 2, w, h);
      }
    }

    if (!transparent && background !== 'transparent' && background !== 'photo' && el.textureToggle.checked) {
      drawPaperGrain(ctx, fmt.w, fmt.h, state.shuffleSeed);
    }

    const grouped = groupLettersByChar([...COLLECTION.letters, ...state.letters]);
    const rand = seededRandom(state.shuffleSeed);
    const jitterDeg = parseFloat(el.jitterRange.value) || 0;
    const withBorder = el.collageBorderToggle.checked;
    const autoMix = el.autoMixToggle.checked;
    const scalePct = (parseFloat(el.letterScaleRange.value) || 100) / 100;
    const trackingPx = (parseFloat(el.trackingRange.value) || 0) * (fmt.w / 1080);

    const marginX = Math.round(fmt.w * 0.08);
    const marginTop = Math.round(fmt.h * 0.08);
    const footerSpace = el.footerTextInput.value.trim() ? Math.round(fmt.h * 0.085) : Math.round(fmt.h * 0.05);
    const availW = fmt.w - marginX * 2;
    const availH = fmt.h - marginTop - footerSpace;

    ctx.save();
    ctx.translate(fmt.w / 2 + state.posterOffset.x * fmt.w, fmt.h / 2 + state.posterOffset.y * fmt.h);
    ctx.scale(state.posterZoom, state.posterZoom);
    ctx.translate(-fmt.w / 2, -fmt.h / 2);
    if (state.mode === 'specimen') {
      // Modo Cartela do Alfabeto A-Z
      el.missingCharsHint.textContent = '';
      const chars = Array.from(grouped.keys()).sort(compareGlyphChars);

      // Título da cartela
      ctx.fillStyle = theme.ink;
      ctx.font = `700 ${Math.round(fmt.w * 0.036)}px "Space Grotesk", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('TIPOGRAFIA DE RUA', fmt.w / 2, marginTop + Math.round(fmt.h * 0.015));

      const headerOffset = Math.round(fmt.h * 0.06);
      const gridH = availH - headerOffset;

      if (!chars.length) {
        ctx.fillStyle = theme.muted;
        ctx.font = `500 ${Math.round(fmt.w * 0.026)}px sans-serif`;
        ctx.fillText('Recorte letras ou carregue o alfabeto demo', fmt.w / 2, fmt.h / 2);
      } else {
        const cols = Math.min(fmt.w > fmt.h ? 12 : 9, Math.max(3, Math.ceil(Math.sqrt(chars.length * fmt.w / fmt.h))));
        const rows = Math.ceil(chars.length / cols);
        const cellW = availW / cols;
        const cellH = Math.min(cellW * 1.25, gridH / rows);
        const startY = marginTop + headerOffset + (gridH - rows * cellH) / 2;

        chars.forEach((ch, idx) => {
          const list = grouped.get(ch);
          const pick = pickPosterVariant(ch, list, rand, autoMix);
          const img = state.imageCache.get(pick.id);
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const cx = marginX + col * cellW + cellW / 2;
          const cy = startY + row * cellH + cellH * 0.42;

          if (img) {
            if (pick.source && COLLECTION.sources[pick.source]) state.posterSources.add(pick.source);
            const maxW = cellW * 0.72 * scalePct;
            const maxH = cellH * 0.66 * scalePct;
            const ratio = Math.min(maxW / img.width, maxH / img.height);
            const dw = img.width * ratio;
            const dh = img.height * ratio;
            const angle = ((rand() - 0.5) * 2 * jitterDeg * Math.PI) / 180;
            drawCutoutTile(ctx, img, cx, cy, dw, dh, angle, withBorder, theme.border);
          }

          ctx.fillStyle = theme.muted;
          ctx.font = `700 ${Math.round(cellH * 0.14)}px monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(ch, cx, startY + row * cellH + cellH * 0.88);
        });
      }
    } else {
      // Modo Frase Livre
      const rawText = normalizeTextStr(el.posterTextInput.value);
      const lines = rawText.split('\n').map((l) => l.trimEnd());
      const missing = new Set();

      const nonEmptyLines = lines.length ? lines : [''];
      const lineGap = Math.round(fmt.h * 0.025);
      const baseRowH = Math.min(
        (availH - lineGap * (nonEmptyLines.length - 1)) / nonEmptyLines.length,
        fmt.h * 0.24
      ) * scalePct;

      // Calcula largura de cada linha para ajustar escala se ultrapassar availW
      const preparedLines = nonEmptyLines.map((line) => {
        const glyphs = Array.from(line);
        const items = glyphs.map((ch) => {
          if (ch === ' ') {
            return { type: 'space', w: baseRowH * 0.34, h: baseRowH };
          }
          const list = grouped.get(ch);
          if (!list || !list.length) {
            missing.add(ch);
            return { type: 'missing', char: ch, w: baseRowH * 0.72, h: baseRowH };
          }
          const pick = pickPosterVariant(ch, list, rand, autoMix);
          const img = state.imageCache.get(pick.id);
          if (!img) {
            return { type: 'missing', char: ch, w: baseRowH * 0.72, h: baseRowH };
          }
          const aspect = img.width / img.height;
          const clampedAspect = Math.max(0.45, Math.min(1.4, aspect));
          return { type: 'img', img, source: pick.source, w: baseRowH * clampedAspect, h: baseRowH };
        });

        const totalW = items.reduce((sum, it, i) => sum + it.w + (i > 0 ? trackingPx : 0), 0);
        const fitScale = totalW > availW && totalW > 0 ? availW / totalW : 1;
        return { items, totalW: totalW * fitScale, fitScale };
      });

      // Atualiza dica de letras faltantes
      if (missing.size > 0) {
        const listStr = Array.from(missing).join(', ');
        el.missingCharsHint.textContent = `Letras ainda não recortadas: ${listStr}`;
        el.missingCharsHint.className = 'helper-text helper-text--warn';
      } else {
        el.missingCharsHint.textContent = '';
        el.missingCharsHint.className = 'helper-text';
      }

      const totalBlockH = preparedLines.reduce((acc, pl, idx) => {
        const rh = baseRowH * pl.fitScale;
        return acc + rh + (idx > 0 ? lineGap : 0);
      }, 0);

      let cursorY = marginTop + Math.max(0, (availH - totalBlockH) / 2);
      const align = el.alignSelect.value;

      for (const pl of preparedLines) {
        const rowH = baseRowH * pl.fitScale;
        const rowTrack = trackingPx * pl.fitScale;
        let cursorX = marginX;
        if (align === 'center') cursorX = marginX + (availW - pl.totalW) / 2;
        else if (align === 'right') cursorX = marginX + (availW - pl.totalW);

        for (const item of pl.items) {
          const w = item.w * pl.fitScale;
          const h = item.h * pl.fitScale;
          const cx = cursorX + w / 2;
          const cy = cursorY + h / 2;

          if (item.type === 'img') {
            const angle = ((rand() - 0.5) * 2 * jitterDeg * Math.PI) / 180;
            if (item.source && COLLECTION.sources[item.source]) state.posterSources.add(item.source);
            const scale = Math.min(w / item.img.width, h / item.img.height);
            drawCutoutTile(ctx, item.img, cx, cy, item.img.width * scale, item.img.height * scale, angle, withBorder, theme.border);
          } else if (item.type === 'missing') {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.strokeStyle = theme.muted;
            ctx.setLineDash([6, 6]);
            ctx.lineWidth = 2;
            ctx.strokeRect(-w / 2, -h / 2, w, h);
            ctx.fillStyle = theme.muted;
            ctx.font = `700 ${Math.round(h * 0.5)}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.char, 0, 0);
            ctx.restore();
          }

          cursorX += w + rowTrack;
        }

        cursorY += rowH + lineGap;
      }
    }

    // Rodapé / Assinatura
    const footer = el.footerTextInput.value.trim();
    if (footer) {
      ctx.fillStyle = theme.muted;
      ctx.font = `600 ${Math.round(fmt.w * 0.021)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(footer.toUpperCase(), fmt.w / 2, fmt.h - Math.round(footerSpace * 0.52), availW);
    }
    ctx.restore();
    if (el.downloadCreditsBtn) el.downloadCreditsBtn.hidden = state.posterSources.size === 0;
    rememberStudioDraft();
  }

  /* ==========================================================================
     Eventos e Inicialização
     ========================================================================== */
  function bindCropperEvents() {
    el.uploadPhotoBtn.addEventListener('click', () => el.photoInput.click());

    el.photoInput.addEventListener('change', async (evt) => {
      const file = evt.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        setSourceImage(img);
        if (!el.autoScanOnUploadToggle?.checked) {
          showToast('Foto carregada! Arraste sobre a letra que deseja recortar.', 'success');
        }
      } catch {
        showToast('Não foi possível abrir essa imagem.', 'error');
      } finally {
        URL.revokeObjectURL(url);
        el.photoInput.value = '';
      }
    });

    // Drag & drop + Paste
    el.uploadPhotoBtn.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.uploadPhotoBtn.classList.add('drag-over');
    });
    el.uploadPhotoBtn.addEventListener('dragleave', () => {
      el.uploadPhotoBtn.classList.remove('drag-over');
    });
    el.uploadPhotoBtn.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.uploadPhotoBtn.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        setSourceImage(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    });

    window.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (!blob) continue;
          const url = URL.createObjectURL(blob);
          try {
            const img = await loadImage(url);
            setSourceImage(img);
            if (!el.autoScanOnUploadToggle?.checked) {
              showToast('Imagem colada da área de transferência.', 'success');
            }
          } finally {
            URL.revokeObjectURL(url);
          }
          break;
        }
      }
    });

    el.sampleSignBtn.addEventListener('click', () => {
      if (!el.originInput.value) el.originInput.value = 'Placa Rua Nova';
      setSourceImage(generateSamplePhoto('sign'));
      if (!el.autoScanOnUploadToggle?.checked) {
        showToast('Foto de teste carregada. Selecione uma letra!', 'success');
      }
    });

    el.sampleNeonBtn.addEventListener('click', () => {
      if (!el.originInput.value) el.originInput.value = 'Letreiro Urbano';
      setSourceImage(generateSamplePhoto('neon'));
      if (!el.autoScanOnUploadToggle?.checked) {
        showToast('Foto de teste carregada. Selecione uma letra!', 'success');
      }
    });

    el.rotateRange.addEventListener('input', () => {
      el.rotateValue.textContent = `${el.rotateRange.value}°`;
      state.rotatedSource = null;
      resetCropRecognition();
      clearScan();
      drawCropper();
    });

    el.cutFilterSelect.addEventListener('change', () => {
      updateCutPreview();
      if (state.sourceImage && state.detectedItems.length) {
        const source = getCropSource();
        const mode = el.cutFilterSelect.value;
        for (const item of state.detectedItems) {
          if (!item.rawBox || item.savedId) continue;
          const out = createEnhancedCutCanvas(
            source,
            item.rawBox.sx,
            item.rawBox.sy,
            item.rawBox.sw,
            item.rawBox.sh,
            mode
          );
          item.dataUrl = out.toDataURL('image/png');
          item.width = out.width;
          item.height = out.height;
        }
        renderDetectedBar();
      }
    });
    el.resetCropBoxBtn.addEventListener('click', resetCropBox);
    el.detectCharBtn.addEventListener('click', () => detectCurrentCropChar(false));
    el.charInput.addEventListener('input', () => {
      state.suggestedChar = '';
      resetCropRecognition();
    });
    el.autoScanSelectionBtn.addEventListener('click', () => scanPhotoForLetters(true));
    el.autoScanPhotoBtn.addEventListener('click', () => scanPhotoForLetters(false));
    el.closeDetectedBtn.addEventListener('click', () => {
      clearScan();
    });
    el.saveAllDetectedBtn.addEventListener('click', async () => {
      const pending = state.detectedItems.filter((d) => !d.savedId);
      if (!pending.length) return;
      const origin = el.originInput.value.trim();
      for (const d of pending) {
        const id = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const item = {
          id,
          char: d.char,
          dataUrl: d.dataUrl,
          origin,
          createdAt: Date.now(),
          width: d.width,
          height: d.height
        };
        d.savedId = id;
        state.letters.push(item);
        await dbPut(item);
      }
      renderDetectedBar();
      await hydrateCache();
      renderAlphabetBank();
      renderPoster();
      showToast(`${pending.length} letra(s) salva(s) no alfabeto!`, 'success');
    });

    async function handleSaveLetter() {
      const ch = normalizeChar(el.charInput.value);
      if (!ch) {
        showToast('Digite qual letra ou símbolo você recortou.', 'error');
        el.charInput.focus();
        return;
      }
      const cut = extractCroppedCanvas();
      if (!cut) {
        showToast('Carregue uma foto antes de salvar.', 'error');
        return;
      }

      const item = {
        id: `cut-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        char: ch,
        dataUrl: cut.toDataURL('image/png'),
        origin: el.originInput.value.trim(),
        createdAt: Date.now(),
        width: cut.width,
        height: cut.height
      };

      state.letters.push(item);
      await dbPut(item);
      await hydrateCache();
      renderAlphabetBank();
      renderPoster();

      el.charInput.value = '';
      el.charInput.focus();
      showToast(`Letra "${ch}" salva no alfabeto!`, 'success');
    }

    el.saveLetterBtn.addEventListener('click', handleSaveLetter);
    el.charInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSaveLetter();
      }
    });

    window.addEventListener('resize', () => {
      if (state.sourceImage) {
        const previousBox = getSourceCropBox();
        setupCropperDimensions();
        state.cropBox = toDisplayCropBox(previousBox);
        drawCropper();
      }
    });
  }

  function bindAlphabetEvents() {
    el.closeVariantDrawerBtn.addEventListener('click', () => {
      const previous = state.selectedChar;
      displayGlyphVariants(null);
      [...el.alphabetGrid.children].find((chip) => chip.dataset.char === previous)?.focus();
    });
    if (!el.exportAlphabetBtn) return;

    el.exportAlphabetBtn.addEventListener('click', () => {
      if (!state.letters.length) {
        showToast('Seu alfabeto está vazio.', 'error');
        return;
      }
      const payload = JSON.stringify({ version: 1, letters: state.letters }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'alfabeto-de-rua.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Alfabeto exportado em JSON.', 'success');
    });

    el.importAlphabetBtn.addEventListener('click', () => el.importAlphabetInput.click());
    el.importAlphabetInput.addEventListener('change', async (evt) => {
      const file = evt.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const imported = Array.isArray(data?.letters) ? data.letters : [];
        let added = 0;
        for (const item of imported) {
          if (item && item.char && item.dataUrl) {
            const normalized = {
              id: item.id || `imp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              char: normalizeChar(item.char),
              dataUrl: item.dataUrl,
              origin: item.origin || '',
              createdAt: item.createdAt || Date.now(),
              width: item.width || 120,
              height: item.height || 120
            };
            if (!normalized.char || state.letters.some((letter) => letter.id === normalized.id)) continue;
            state.letters.push(normalized);
            await dbPut(normalized);
            added++;
          }
        }
        await hydrateCache();
        renderAlphabetBank();
        renderPoster();
        showToast(`${added} recorte(s) importado(s)!`, 'success');
      } catch {
        showToast('Arquivo JSON inválido.', 'error');
      } finally {
        el.importAlphabetInput.value = '';
      }
    });

    el.clearAlphabetBtn.addEventListener('click', async () => {
      if (!state.letters.length || !window.confirm('Apagar seus recortes salvos neste navegador?')) return;
      state.letters = [];
      state.imageCache.clear();
      state.selectedChar = null;
      await dbClear();
      renderAlphabetBank();
      renderPoster();
      showToast('Alfabeto limpo.');
    });

  }

  function bindPosterEvents() {
    // Modo Pôster vs Cartela
    el.modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        el.modeButtons.forEach((b) => {
          const active = b === btn;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        el.phraseGroup.classList.toggle('hidden', state.mode === 'specimen');
        renderPoster();
      });
    });

    // Controles do pôster
    const rerenderControls = [
      el.posterTextInput,
      el.formatSelect,
      el.bgSelect,
      el.customBgInput,
      el.footerTextInput,
      el.alignSelect,
      el.collageBorderToggle,
      el.autoMixToggle,
      el.textureToggle
    ];
    rerenderControls.forEach((ctrl) => {
      ctrl.addEventListener('input', () => {
        if (ctrl === el.bgSelect) {
          el.customBgWrap.classList.toggle('hidden', el.bgSelect.value !== 'custom');
          el.posterPhotoInput.value = '';
        }
        renderPoster();
      });
      ctrl.addEventListener('change', () => renderPoster());
    });

    el.letterScaleRange.addEventListener('input', () => {
      el.letterScaleValue.textContent = `${el.letterScaleRange.value}%`;
      renderPoster();
    });
    el.trackingRange.addEventListener('input', () => {
      el.trackingValue.textContent = `${el.trackingRange.value}px`;
      renderPoster();
    });
    el.jitterRange.addEventListener('input', () => {
      el.jitterValue.textContent = `${el.jitterRange.value}°`;
      renderPoster();
    });

    el.collectionFilter.addEventListener('change', () => {
      displayGlyphVariants(null);
      renderAlphabetBank();
      rememberStudioDraft();
    });

    el.downloadCreditsBtn.addEventListener('click', downloadPosterCredits);

    el.shuffleVariantsBtn.addEventListener('click', () => {
      state.shuffleSeed = Math.floor(Math.random() * 100000) + 1;
      renderPoster();
    });

    el.posterPhotoInput.addEventListener('change', async () => {
      const file = el.posterPhotoInput.files?.[0];
      if (!file) return;
      try {
        state.posterPhoto = await loadPosterPhoto(file);
        el.bgSelect.value = 'photo';
        el.customBgWrap.classList.add('hidden');
        renderPoster();
        if (!await photoStorage(file)) showToast('Foto carregada, mas não foi possível salvá-la neste navegador.', 'error');
      } catch {
        showToast('Não foi possível abrir a foto. Escolha outra imagem.', 'error');
      }
    });

    const posterPointers = new Map();
    function startPosterGesture() {
      const points = [...posterPointers.values()];
      if (!points.length) { state.posterDrag = null; el.posterCanvas.classList.remove('is-dragging'); return; }
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const distance = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
      state.posterDrag = { x, y, distance, offset: { ...state.posterOffset }, zoom: state.posterZoom };
      el.posterCanvas.classList.add('is-dragging');
    }
    function updatePosterZoom(zoom) {
      state.posterZoom = Math.max(0.25, Math.min(3, zoom));
      el.posterZoomRange.value = Math.round(state.posterZoom * 100);
      el.posterZoomValue.textContent = `${el.posterZoomRange.value}%`;
    }
    el.posterZoomRange.addEventListener('input', () => { updatePosterZoom(Number(el.posterZoomRange.value) / 100); renderPoster(); });
    el.resetZoomBtn.addEventListener('click', () => { updatePosterZoom(1); renderPoster(); });
    document.querySelector('a[href="#acervo"]').addEventListener('click', () => { document.getElementById('acervo').open = true; });
    el.posterCanvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || posterPointers.size >= 2) return;
      posterPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      el.posterCanvas.setPointerCapture(event.pointerId);
      startPosterGesture();
    });
    el.posterCanvas.addEventListener('pointermove', (event) => {
      if (!posterPointers.has(event.pointerId) || !state.posterDrag) return;
      posterPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...posterPointers.values()];
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const rect = el.posterCanvas.getBoundingClientRect();
      state.posterOffset = { x: state.posterDrag.offset.x + (x - state.posterDrag.x) / rect.width, y: state.posterDrag.offset.y + (y - state.posterDrag.y) / rect.height };
      if (points.length === 2 && state.posterDrag.distance > 0) {
        updatePosterZoom(state.posterDrag.zoom * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / state.posterDrag.distance);
      }
      renderPoster();
    });
    const endPosterDrag = (event) => { if (posterPointers.delete(event.pointerId)) startPosterGesture(); };
    el.posterCanvas.addEventListener('pointerup', endPosterDrag);
    el.posterCanvas.addEventListener('pointercancel', endPosterDrag);
    el.posterCanvas.addEventListener('lostpointercapture', endPosterDrag);
    el.posterCanvas.addEventListener('keydown', (event) => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!directions[event.key]) return;
      event.preventDefault();
      const [x, y] = directions[event.key];
      const step = event.shiftKey ? 0.05 : 0.01;
      state.posterOffset.x += x * step;
      state.posterOffset.y += y * step;
      renderPoster();
    });
    el.resetPositionBtn.addEventListener('click', () => { state.posterOffset = { x: 0, y: 0 }; renderPoster(); });
    el.sharePosterBtn.addEventListener('click', async () => {
      if (!navigator.share || !navigator.canShare) {
        el.posterSaveHint.textContent = 'Compartilhamento indisponível neste navegador. Baixe o PNG e escolha a imagem no Instagram.';
        return;
      }
      const blob = await new Promise((resolve) => el.posterCanvas.toBlob(resolve, 'image/png'));
      if (!blob) { showToast('Não foi possível preparar a imagem. Tente baixar o PNG.', 'error'); return; }
      const file = new File([blob], 'tipografia-de-rua.png', { type: 'image/png' });
      if (!navigator.canShare({ files: [file] })) {
        el.posterSaveHint.textContent = 'Este navegador não compartilha imagens. Baixe o PNG e escolha a imagem no Instagram.';
        return;
      }
      try { await navigator.share({ files: [file] }); }
      catch (error) {
        if (error.name !== 'AbortError') el.posterSaveHint.textContent = 'Não foi possível compartilhar. Baixe o PNG e escolha a imagem no Instagram.';
      }
    });
    el.downloadTransparentBtn.addEventListener('click', () => {
      renderPoster(true);
      const link = document.createElement('a');
      link.download = `tipografia-de-rua-${el.formatSelect.value}-transparente.png`;
      link.href = el.posterCanvas.toDataURL('image/png');
      link.click();
      renderPoster();
      el.posterSaveHint.textContent = 'Download iniciado. Depois, abra o Instagram e escolha a imagem salva no celular.';
    });

    el.downloadPosterBtn.addEventListener('click', () => {
      const link = document.createElement('a');
      link.download = `tipografia-de-rua-${el.formatSelect.value}.png`;
      link.href = el.posterCanvas.toDataURL('image/png');
      link.click();
      el.posterSaveHint.textContent = 'Download iniciado. Depois, abra o Instagram e escolha a imagem salva no celular.';
    });




  }

  async function init() {
    state.db = await openDb();
    state.letters = await dbGetAll();
    await hydrateCache();
    bindAlphabetEvents();
    if (el.cropperCanvas) bindCropperEvents();
    if (el.posterCanvas) {
      bindPosterEvents();
      renderCollectionCredits();
      try {
        const draft = JSON.parse(sessionStorage.getItem(STUDIO_DRAFT_KEY));
        if (draft?.controls?.bgSelect === 'photo') {
          const photo = await photoStorage();
          if (photo) state.posterPhoto = await loadPosterPhoto(photo);
        }
      } catch { /* A edição continua sem a foto se ela não puder ser recuperada. */ }
      restoreStudioDraft();
    }
    renderAlphabetBank();
    renderPoster();
    window.addEventListener('pageshow', async (event) => {
      if (!event.persisted) return;
      state.letters = await dbGetAll();
      await hydrateCache();
      renderAlphabetBank();
      renderPoster();
    });
  }

  init();
})();
