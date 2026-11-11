/**
 * PaddleOCR (PP-OCRv4) 浏览器端推理引擎 —— 完全离线
 *
 * - 推理：onnxruntime-web (WASM, 单线程)
 * - 模型：ch_PP-OCRv4_det (文本检测) + ch_PP-OCRv4_rec (文本识别，6623 字中英文字典)
 * - 所有模型 / WASM 都以 <script> 形式内嵌（lib/paddleocr/asset-*.js），
 *   因此双击 index.html（file:// 协议）也能运行，不需要本地服务器、不需要联网。
 */
const PaddleOCR = (() => {
  const BASE = 'lib/paddleocr/';
  const ASSETS = (window.__OCR_ASSETS = window.__OCR_ASSETS || {});

  // ---- 参数（与 PaddleOCR / RapidOCR 默认值保持一致） ----
  const DET = {
    maxSide: 2560,     // 检测输入最长边（越大越能检出小字，越慢）
    minSide: 64,
    thresh: 0.3,       // 像素二值化阈值
    boxThresh: 0.5,    // 文本框平均得分阈值
    unclipRatio: 1.6,  // 文本框外扩比例
    minSize: 3,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  };
  const REC = { height: 48, minWidth: 320, maxWidth: 3200, scoreThresh: 0.15 }; // keep faint handwriting, flagged as low score

  let _init = null;
  let det = null, rec = null, chars = null;

  // ---------------------------------------------------------------- 资源加载
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('无法加载 ' + src + '（文件缺失？请确认解压完整）'));
      document.head.appendChild(s);
    });
  }

  async function asset(key, file) {
    if (ASSETS[key] === undefined) await loadScript(BASE + file);
    const v = ASSETS[key];
    if (v === undefined) throw new Error('资源 ' + file + ' 加载后为空');
    delete ASSETS[key]; // 释放巨大的 base64 字符串
    return v;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const n = bin.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * 初始化引擎（幂等，可重复调用）
   * @param {(ratio:number, text:string)=>void} onProgress
   */
  function init(onProgress) {
    if (_init) return _init;
    const report = (r, t) => { try { onProgress && onProgress(r, t); } catch (e) {} };
    _init = (async () => {
      const t0 = performance.now();
      if (typeof WebAssembly !== 'object') {
        throw new Error('当前浏览器不支持 WebAssembly，请使用新版 Chrome / Edge / Firefox');
      }
      report(0.05, '加载 OCR 运行时...');
      if (typeof ort === 'undefined') await loadScript(BASE + 'ort.wasm.min.js');
      if (typeof ort === 'undefined') throw new Error('onnxruntime 加载失败');

      const glue = await asset('ortGlue', 'asset-ort-glue.js');
      report(0.15, '加载 OCR 内核 (WASM)...');
      const wasmBytes = b64ToBytes(await asset('ortWasm', 'asset-ort-wasm.js'));

      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = {
        mjs: URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }))
      };
      ort.env.wasm.wasmBinary = wasmBytes;
      ort.env.logLevel = 'error';

      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };

      report(0.35, '加载文字检测模型...');
      const detBytes = b64ToBytes(await asset('det', 'asset-det.js'));
      det = await ort.InferenceSession.create(detBytes, opts);

      report(0.6, '加载文字识别模型...');
      const recBytes = b64ToBytes(await asset('rec', 'asset-rec.js'));
      rec = await ort.InferenceSession.create(recBytes, opts);

      const dictText = await asset('dict', 'asset-dict.js');
      const keys = dictText.split(/\r?\n/);
      if (keys.length && keys[keys.length - 1] === '') keys.pop();
      chars = ['<blank>', ...keys, ' '];

      report(1, 'OCR 引擎就绪');
      console.log(`[PaddleOCR] 初始化完成，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      return true;
    })();
    _init.catch(() => { _init = null; }); // 失败后允许重试
    return _init;
  }

  // ---------------------------------------------------------------- 工具
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // 单调链凸包
  function convexHull(pts) {
    if (pts.length <= 3) return pts.slice();
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // 最小外接矩形（旋转卡壳）→ { cx, cy, ux, uy, w, h }  (u 为 w 方向单位向量)
  function minAreaRect(hull) {
    if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], ux: 1, uy: 0, w: 0, h: 0 };
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length];
      let ux = q[0] - p[0], uy = q[1] - p[1];
      const len = Math.hypot(ux, uy);
      if (len < 1e-9) continue;
      ux /= len; uy /= len;
      const vx = -uy, vy = ux;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const r of hull) {
        const a = r[0] * ux + r[1] * uy, b = r[0] * vx + r[1] * vy;
        if (a < minU) minU = a; if (a > maxU) maxU = a;
        if (b < minV) minV = b; if (b > maxV) maxV = b;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
        best = { area, cx: cu * ux + cv * vx, cy: cu * uy + cv * vy, ux, uy, w: maxU - minU, h: maxV - minV };
      }
    }
    return best;
  }

  // 把矩形规范化为：u 方向接近水平且朝右，v 朝下；返回四角 (tl,tr,br,bl)
  function normalizeRect(r) {
    let { cx, cy, ux, uy, w, h } = r;
    if (Math.abs(ux) < Math.abs(uy)) { // u 偏竖直 → 交换
      const nux = -uy, nuy = ux; ux = nux; uy = nuy; const t = w; w = h; h = t;
    }
    if (ux < 0) { ux = -ux; uy = -uy; }
    let vx = -uy, vy = ux;
    if (vy < 0) { vx = -vx; vy = -vy; }
    const tl = [cx - ux * w / 2 - vx * h / 2, cy - uy * w / 2 - vy * h / 2];
    return { cx, cy, ux, uy, vx, vy, w, h, tl };
  }

  // ---------------------------------------------------------------- 文本检测
  async function detect(src) {
    const W = src.width, H = src.height;
    let ratio = Math.min(1, DET.maxSide / Math.max(W, H));
    if (Math.min(W, H) * ratio < DET.minSide) ratio = Math.min(DET.maxSide / Math.max(W, H), DET.minSide / Math.min(W, H));
    const rw = Math.max(32, Math.round((W * ratio) / 32) * 32);
    const rh = Math.max(32, Math.round((H * ratio) / 32) * 32);
    const sx = rw / W, sy = rh / H;

    const c = makeCanvas(rw, rh);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, rw, rh);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, rw, rh);
    const px = ctx.getImageData(0, 0, rw, rh).data;

    const N = rw * rh;
    const input = new Float32Array(3 * N);
    // BGR 通道顺序（与 PaddleOCR 训练一致）
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      input[i] = (px[j + 2] / 255 - DET.mean[0]) / DET.std[0];
      input[N + i] = (px[j + 1] / 255 - DET.mean[1]) / DET.std[1];
      input[2 * N + i] = (px[j] / 255 - DET.mean[2]) / DET.std[2];
    }
    const tensor = new ort.Tensor('float32', input, [1, 3, rh, rw]);
    let prob, outputs;
    try {
      outputs = await det.run({ [det.inputNames[0]]: tensor });
      prob = Float32Array.from(outputs[det.outputNames[0]].data);
    } finally {
      tensor.dispose?.();
      if (outputs) Object.values(outputs).forEach(t => t.dispose?.());
      c.width = c.height = 0;
    }

    // 二值化 + 2x2 膨胀
    const bin = new Uint8Array(N);
    for (let i = 0; i < N; i++) bin[i] = prob[i] > DET.thresh ? 1 : 0;
    const mask = new Uint8Array(N);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        mask[i] = bin[i] | (x > 0 ? bin[i - 1] : 0) | (y > 0 ? bin[i - rw] : 0) | (x > 0 && y > 0 ? bin[i - rw - 1] : 0);
      }
    }

    // 连通域（8 邻域）
    const label = new Int32Array(N);
    const stack = new Int32Array(N);
    const boxes = [];
    let cur = 0;
    for (let s = 0; s < N; s++) {
      if (!mask[s] || label[s]) continue;
      cur++;
      let sp = 0; stack[sp++] = s; label[s] = cur;
      const rowMin = new Map(), rowMax = new Map();
      let count = 0, scoreSum = 0;
      while (sp) {
        const i = stack[--sp];
        const y = (i / rw) | 0, x = i - y * rw;
        count++; scoreSum += prob[i];
        const mn = rowMin.get(y); if (mn === undefined || x < mn) rowMin.set(y, x);
        const mx = rowMax.get(y); if (mx === undefined || x > mx) rowMax.set(y, x);
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= rh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= rw) continue;
            const j = ny * rw + nx;
            if (mask[j] && !label[j]) { label[j] = cur; stack[sp++] = j; }
          }
        }
      }
      if (count < 6) continue;
      if (scoreSum / count < DET.boxThresh) continue;
      const pts = [];
      rowMin.forEach((x, y) => { pts.push([x, y]); const m = rowMax.get(y); if (m !== x) pts.push([m, y]); });
      const r = minAreaRect(convexHull(pts));
      if (!r || Math.min(r.w, r.h) < DET.minSize) continue;
      // unclip：按 DB 论文公式外扩
      const d = (r.w * r.h * DET.unclipRatio) / (2 * (r.w + r.h));
      r.w += 2 * d; r.h += 2 * d;
      if (Math.min(r.w, r.h) < DET.minSize + 2) continue;
      // 映射回原图坐标
      const ux = r.ux / sx, uy = r.uy / sy;
      const ul = Math.hypot(ux, uy);
      const box = {
        cx: r.cx / sx, cy: r.cy / sy,
        ux: ux / ul, uy: uy / ul,
        // 各向同性缩放（sx≈sy）
        w: r.w / ((sx + sy) / 2), h: r.h / ((sx + sy) / 2)
      };
      boxes.push(normalizeRect(box));
    }
    return boxes;
  }

  // ---------------------------------------------------------------- 文本识别
  function cropForRec(src, b) {
    // 竖排长条 → 逆时针旋转 90°（与 PaddleOCR 一致）
    let ux = b.ux, uy = b.uy, vx = b.vx, vy = b.vy, w = b.w, h = b.h, tl = b.tl;
    if (h / Math.max(1, w) >= 1.5) {
      tl = [tl[0] + ux * w, tl[1] + uy * w];
      const nux = vx, nuy = vy, nvx = -ux, nvy = -uy;
      ux = nux; uy = nuy; vx = nvx; vy = nvy; const t = w; w = h; h = t;
    }
    const s = REC.height / Math.max(1, h);
    const cw = Math.min(REC.maxWidth, Math.max(8, Math.ceil(w * s)));
    const c = makeCanvas(cw, REC.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, REC.height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    // 坐标映射：dest = s * [ (p-tl)·u , (p-tl)·v ]
    const e = -(tl[0] * ux + tl[1] * uy) * s;
    const f = -(tl[0] * vx + tl[1] * vy) * s;
    ctx.setTransform(ux * s, vx * s, uy * s, vy * s, e, f);
    ctx.drawImage(src, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  async function recognizeCrop(crop) {
    const H = REC.height, cw = crop.width;
    const W = Math.max(REC.minWidth, cw);
    const px = crop.getContext('2d').getImageData(0, 0, cw, H).data;
    const plane = H * W;
    const input = new Float32Array(3 * plane); // 右侧补 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < cw; x++) {
        const j = (y * cw + x) * 4, i = y * W + x;
        input[i] = px[j + 2] / 127.5 - 1;
        input[plane + i] = px[j + 1] / 127.5 - 1;
        input[2 * plane + i] = px[j] / 127.5 - 1;
      }
    }
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) });
    const t = out[rec.outputNames[0]];
    const [, T, C] = t.dims;
    const data = t.data;
    let text = '', sum = 0, n = 0, prev = -1;
    for (let k = 0; k < T; k++) {
      let best = 0, bv = -Infinity;
      const off = k * C;
      for (let c = 0; c < C; c++) { const v = data[off + c]; if (v > bv) { bv = v; best = c; } }
      if (best !== 0 && best !== prev) {
        text += chars[best] !== undefined ? chars[best] : '';
        sum += bv; n++;
      }
      prev = best;
    }
    return { text, score: n ? sum / n : 0 };
  }

  // ---------------------------------------------------------------- 版面整理
  function linesToText(items) {
    const sorted = items.slice().sort((a, b) => a.cy - b.cy);
    const lines = [];
    for (const it of sorted) {
      const line = lines.find(l => Math.abs(l.cy - it.cy) < Math.min(l.h, it.h) * 0.5);
      if (line) {
        line.items.push(it);
        line.cy = (line.cy * (line.items.length - 1) + it.cy) / line.items.length;
        line.h = Math.max(line.h, it.h);
      } else {
        lines.push({ cy: it.cy, h: it.h, items: [it] });
      }
    }
    lines.sort((a, b) => a.cy - b.cy);
    return lines.map(l => {
      l.items.sort((a, b) => a.x0 - b.x0);
      let s = '';
      let lastX = null;
      for (const it of l.items) {
        if (lastX !== null) {
          const gap = it.x0 - lastX;
          if (gap > l.h * 2) s += '    ';
          else if (gap > l.h * 0.6) s += ' ';
        }
        s += it.text;
        lastX = it.x1;
      }
      const x0 = Math.min(...l.items.map(i => i.x0)), x1 = Math.max(...l.items.map(i => i.x1));
      const y0 = Math.min(...l.items.map(i => i.y0)), y1 = Math.max(...l.items.map(i => i.y1));
      return { text: s, x0, y0, x1, y1, cy: l.cy, h: l.h };
    });
  }

  /**
   * 识别一张图片（canvas / image / ImageBitmap）
   * @returns {Promise<{text:string, lines:Array<{text,x0,y0,x1,y1}>, items:Array}>}
   */
  async function recognizeOne(src, onProgress, options = {}) {
    options.signal?.throwIfAborted();
    await init();
    options.signal?.throwIfAborted();
    DET.maxSide = ({ fast: 1280, balanced: 1920, fine: 2560 })[options.mode] || 1920;
    await new Promise(resolve => setTimeout(resolve, 0));
    const boxes = await detect(src);
    options.signal?.throwIfAborted();
    const items = [];
    for (let i = 0; i < boxes.length; i++) {
      options.signal?.throwIfAborted();
      const b = boxes[i];
      const crop = cropForRec(src, b);
      const r = await recognizeCrop(crop);
      options.signal?.throwIfAborted();
      crop.width = crop.height = 0;
      if (i % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      if (r.text.trim() && r.score >= REC.scoreThresh) {
        const xs = [b.tl[0], b.tl[0] + b.ux * b.w, b.tl[0] + b.vx * b.h, b.tl[0] + b.ux * b.w + b.vx * b.h];
        const ys = [b.tl[1], b.tl[1] + b.uy * b.w, b.tl[1] + b.vy * b.h, b.tl[1] + b.uy * b.w + b.vy * b.h];
        items.push({
          text: r.text.trim().replace(/(\d)\s*[，,]\s*(?=\d{3})/g, '$1,'), score: r.score,
          cy: b.cy, h: Math.min(b.h, b.w),
          x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys)
        });
      }
      if (onProgress && (i % 3 === 0 || i === boxes.length - 1)) onProgress((i + 1) / boxes.length);
    }
    const lines = linesToText(items);
    return { text: lines.map(l => l.text).join('\n'), lines, items };
  }

  // InferenceSession and DET settings are shared: never run them concurrently.
  let inferenceTail = Promise.resolve();
  function recognize(src, onProgress, options = {}) {
    if (onProgress) onProgress(0);
    const task = inferenceTail.then(() => recognizeOne(src, onProgress, options));
    inferenceTail = task.catch(() => {});
    return task;
  }

  return {
    init,
    recognize,
    isReady: () => !!(det && rec && chars),
    _params: { DET, REC }
  };
})();
