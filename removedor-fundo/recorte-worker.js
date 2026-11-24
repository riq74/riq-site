function startMaskWorker() {
  const runtimeBase = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';
  const isnet = 'https://huggingface.co/SacredNoir/isnet-general-use-onnx/resolve/ff56cb825ee2637d4726f8a739fb7bf1bf4bea04/isnet-general-use-q8.onnx';
  const slimsam = 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/';
  const size = 1024;

  let runtime, automatic, encoder, decoder, encoded;

  async function session(url, notify) {
    runtime ??= import(runtimeBase + 'ort.wasm.min.mjs').catch(error => {
      runtime = null;
      throw error;
    });
    const ort = await runtime;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = runtimeBase;
    let cache;
    try {
      cache = await self.caches?.open('riq-background-models-v1');
    } catch {
      // Cache Storage can be unavailable when the page opens from a local file.
    }
    let response = await cache?.match(url).catch(() => null);
    if (!response) {
      notify('Baixando modelo de IA…');
      response = await fetch(url);
      if (!response.ok) throw new Error('Download do modelo indisponível.');
      if (cache) await cache.put(url, response.clone()).catch(() => {});
    }
    notify('Preparando modelo de IA…');
    return ort.InferenceSession.create(await response.arrayBuffer(), { executionProviders: ['wasm'] });
  }

  async function imageTensor(file, guided) {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = size / Math.max(bitmap.width, bitmap.height);
      const width = guided ? Math.max(1, Math.round(bitmap.width * scale)) : size;
      const height = guided ? Math.max(1, Math.round(bitmap.height * scale)) : size;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);
      const mean = guided ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5];
      const std = guided ? [0.229, 0.224, 0.225] : [1, 1, 1];
      const input = new Float32Array(3 * size * size);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pixel = (y * width + x) * 4;
          for (let c = 0; c < 3; c++) {
            const rgb = guided ? data[pixel + c] / 255 : data[pixel + c] / 256;
            input[c * size * size + y * size + x] = (rgb - mean[c]) / std[c];
          }
        }
      }
      const { Tensor } = await runtime;
      return { width, height, tensor: new Tensor('float32', input, [1, 3, size, size]) };
    } finally {
      bitmap.close();
    }
  }

  async function autoMask(file, notify) {
    automatic ??= await session(isnet, notify);
    notify('Separando objeto e fundo…');
    const { tensor } = await imageTensor(file, false);
    const { output } = await automatic.run({ input: tensor }, ['output']);
    const [height, width] = output.dims.slice(-2);
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = output.data[i] * 255;
    return { alpha, width, height };
  }

  function outlineCoverage(trace, width, height, drawWidth = width, drawHeight = height) {
    const ctx = new OffscreenCanvas(width, height).getContext('2d');
    ctx.beginPath();
    ctx.moveTo(trace[0][0] * drawWidth, trace[0][1] * drawHeight);
    for (const [x, y] of trace.slice(1)) ctx.lineTo(x * drawWidth, y * drawHeight);
    ctx.closePath();
    ctx.fill('evenodd');
    return ctx.getImageData(0, 0, width, height).data;
  }

  function outlineSamples(trace, box) {
    const resolution = 48;
    const coverage = outlineCoverage(trace, resolution, resolution);
    const [left, top, right, bottom] = box;
    const middle = (left + right) / 2;
    const samples = [];
    const rows = Array.from({ length: resolution }, () => []);
    let insideCount = 0;
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const nx = (x + 0.5) / resolution;
        const ny = (y + 0.5) / resolution;
        const inside = coverage[(y * resolution + x) * 4 + 3] >= 128;
        samples.push([nx, ny, inside]);
        if (inside) {
          insideCount++;
          rows[y].push(nx);
        }
      }
    }
    const seeds = [0.23, 0.50, 0.78].map(position => {
      const y = top + (bottom - top) * position;
      const row = rows[Math.min(resolution - 1, Math.floor(y * resolution))];
      const x = row.reduce((nearest, next) =>
        Math.abs(next - middle) < Math.abs(nearest - middle) ? next : nearest, Infinity);
      return [Number.isFinite(x) ? x : middle, y, 1];
    });
    return { samples, insideCount, seeds };
  }

  async function guidedMask({ file, imageId, box, points, trace }, notify) {
    encoder ??= await session(slimsam + 'vision_encoder_quantized.onnx', notify);
    decoder ??= await session(slimsam + 'prompt_encoder_mask_decoder_quantized.onnx', notify);
    if (encoded?.imageId !== imageId) {
      encoded = null;
      notify('Analisando a imagem…');
      const { width, height, tensor } = await imageTensor(file, true);
      const embeddings = await encoder.run({ pixel_values: tensor });
      encoded = { imageId, width, height, embeddings };
    }
    notify('Ajustando o contorno…');
    const { width, height, embeddings } = encoded;
    const { samples, insideCount, seeds } = outlineSamples(trace, box);
    const { Tensor } = await runtime;
    // Compare an upper seed, a central seed, and a prompt spanning the subject.
    const candidates = points.some(([, , label]) => label === 1)
      ? [points, [...seeds, ...points]]
      : [[seeds[1], ...points], [seeds[0], ...points], [...seeds, ...points]];
    const promptCount = Math.max(...candidates.map(candidate => candidate.length));
    const prompts = candidates.flatMap(candidate =>
      [...candidate, ...Array.from({ length: promptCount - candidate.length }, () => [0, 0, -10])]);
    const coords = Float32Array.from(prompts.flatMap(([x, y]) => [x * width, y * height]));
    const labels = BigInt64Array.from(prompts.map(([, , label]) => BigInt(label)));
    const { pred_masks: masks, iou_scores: scores } = await decoder.run({
      ...embeddings,
      input_points: new Tensor('float32', coords, [1, candidates.length, promptCount, 2]),
      input_labels: new Tensor('int64', labels, [1, candidates.length, promptCount]),
    });
    const [maskH, maskW] = masks.dims.slice(-2);
    const plane = maskW * maskH;
    const pixelAt = (x, y) => Math.min(maskH - 1, Math.floor(y * height / size * maskH)) * maskW
      + Math.min(maskW - 1, Math.floor(x * width / size * maskW));
    let best = 0;
    let bestScore = -Infinity;
    scores.data.forEach((quality, index) => {
      // Prefer masks that agree with explicit corrections when SAM offers several candidates.
      const matches = points.filter(([x, y, label]) =>
        Number(masks.data[index * plane + pixelAt(x, y)] > 0) === label).length;
      let inside = 0;
      let outside = 0;
      for (const [x, y, inOutline] of samples) {
        if (masks.data[index * plane + pixelAt(x, y)] <= 0) continue;
        if (inOutline) inside++;
        else outside++;
      }
      const overlap = inside / Math.max(1, insideCount + outside);
      const leakage = outside / Math.max(1, inside + outside);
      const score = quality * 0.65 + overlap * 1.35 - leakage * 1.55 + matches * 4;
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    const outlined = outlineCoverage(trace, maskW, maskH, maskW * width / size, maskH * height / size);
    // An explicit keep point can extend the cut beyond the drawn guide.
    const extendsOutline = points.some(([x, y, label]) => label === 1 && outlined[pixelAt(x, y) * 4 + 3] < 128);
    const alpha = new Uint8ClampedArray(plane);
    for (let i = 0; i < plane; i++) {
      // SAM logits classify pixels. Convert to coverage before resizing so low confidence
      // cannot fade the object's interior; the resizer antialiases the contour.
      alpha[i] = masks.data[best * plane + i] > 0 && (extendsOutline || outlined[i * 4 + 3] >= 128) ? 255 : 0;
    }
    return { alpha, width: maskW, height: maskH, cropWidth: width / size, cropHeight: height / size };
  }

  self.onmessage = async ({ data }) => {
    if (data.mode === 'release') {
      if (encoded?.imageId === data.imageId) encoded = null;
      return;
    }
    const { id, mode, file } = data;
    const notify = status => self.postMessage({ id, status });
    try {
      const mask = mode === 'guided' ? await guidedMask(data, notify) : await autoMask(file, notify);
      self.postMessage({ id, mask }, [mask.alpha.buffer]);
    } catch (error) {
      console.error('Recorte local:', error);
      self.postMessage({ id, error: 'A IA não conseguiu processar a imagem. Tente novamente ou use as ferramentas manuais.' });
    }
  };
}

if (typeof document === 'undefined') startMaskWorker();
