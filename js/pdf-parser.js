/**
 * PDF 解析模块（v2）
 *
 * 1) PDF.js 提取文本层
 * 2) 逐页分析：
 *    - 无文本层的页（扫描件 / 文字转曲线） → 整页 OCR
 *    - 有文本层但含有图片（截图、盖章表格、扫描附件） → 对每张图片区域做 OCR
 *    - OCR 结果与文本层按位置去重后合并，插入到原文对应位置
 * 3) OCR 引擎：PaddleOCR PP-OCRv4（js/paddle-ocr.js），完全离线
 *
 * 兼容 file:// 直接双击打开：pdf.js 走主线程模式，CMap 从内嵌数据读取。
 */
const PDFParser = (() => {

  const IS_FILE = location.protocol === 'file:';

  // file:// 下浏览器禁止创建 Worker → 让 pdf.js 在主线程运行（加载 pdf.worker.min.js 作为普通脚本）
  let _pdfWorkerReady = null;
  function ensurePdfJs() {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF.js 未加载，请确认 lib/pdfjs/pdf.min.js 存在');
    }
    if (_pdfWorkerReady) return _pdfWorkerReady;
    if (IS_FILE) {
      _pdfWorkerReady = new Promise((resolve) => {
        if (window.pdfjsWorker) return resolve();
        const s = document.createElement('script');
        s.src = 'lib/pdfjs/pdf.worker.min.js';
        s.onload = () => resolve();
        s.onerror = () => resolve(); // 仍可走 fake worker
        document.head.appendChild(s);
      });
    } else {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';
      _pdfWorkerReady = Promise.resolve();
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';
    return _pdfWorkerReady;
  }

  // 内嵌 CMap（中文字体映射）读取器 —— file:// 下无法 fetch cmaps 目录
  class EmbeddedCMapReaderFactory {
    constructor({ baseUrl = null, isCompressed = true } = {}) {
      this.baseUrl = baseUrl; this.isCompressed = isCompressed;
    }
    async fetch({ name }) {
      const table = window.__PDF_CMAPS || {};
      const b64 = table[name];
      if (!b64) throw new Error('CMap 缺失: ' + name);
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return { cMapData: u, compressionType: 1 /* BINARY */ };
    }
  }

  // 扫描页判定：每页有效字符数低于该值则整页 OCR
  const SCANNED_PAGE_MIN_CHARS = 10;
  // OCR 渲染分辨率（DPI），以及渲染上限
  const OCR_DPI = 300;
  const MAX_RENDER_SIDE = 4200;
  const MAX_RENDER_PIXELS = 16e6;
  // 图片区域最小尺寸（PDF pt，1pt = 1/72 英寸）
  const MIN_IMG_W = 24, MIN_IMG_H = 10, MIN_IMG_AREA = 900;
  const MAX_REGIONS_PER_PAGE = 40;

  // ------------------------------------------------------------------ OCR 引擎
  let _ocrLastError = null;

  /** 兼容旧接口：预热 OCR。onInitProgress(phase, ratio, text) */
  function getOCRWorker(onInitProgress) {
    if (typeof OCRService === 'undefined') {
      return Promise.reject(new Error('OCR 模块未加载（js/paddle-ocr.js 缺失）'));
    }
    return OCRService.init((r, t) => onInitProgress && onInitProgress(r >= 1 ? 'ready' : 'init', r, t))
      .then(() => { _ocrLastError = null; return PaddleOCR; })
      .catch(e => { _ocrLastError = e; throw e; });
  }

  async function terminateOCR() { /* 单例引擎常驻，无需销毁 */ }

  // ------------------------------------------------------------------ 工具
  const Util = () => pdfjsLib.Util;

  function meaningfulCount(text) {
    const cleaned = (text || '').replace(/\s/g, '');
    const cjk = (cleaned.match(/[一-鿿]/g) || []).length;
    const ascii = (cleaned.match(/[A-Za-z0-9]/g) || []).length;
    return cjk + ascii;
  }

  function norm(s) {
    return (s || '').toLowerCase().replace(/[\s　.,;:!?'"()\[\]{}<>\-_/\\|，。；：！？、“”‘’（）【】《》〈〉·…—~～`@#$%^&*+=￥¥]/g, '');
  }

  // OCR 文本在文本层中的覆盖率（字符多重集）
  function coverage(ocrNorm, refNorm) {
    if (!ocrNorm.length) return 1;
    const bag = new Map();
    for (const ch of refNorm) bag.set(ch, (bag.get(ch) || 0) + 1);
    let hit = 0;
    for (const ch of ocrNorm) {
      const n = bag.get(ch);
      if (n) { hit++; bag.set(ch, n - 1); }
    }
    return hit / ocrNorm.length;
  }

  function rectsOverlap(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  }

  // ------------------------------------------------------------------ 字符规范化
  // 很多 Word / WPS / Mac 导出的 PDF，文本层把常用汉字映射成了“康熙部首/部首补充”等兼容字符
  // （如 ⽅⼄⽬⻔ 实为 方乙目门），肉眼一样但无法被关键词匹配。这里统一还原成标准汉字。
  const RADICAL_FIX = {
    '⻔':'门','⻋':'车','⻅':'见','⻓':'长','⻛':'风','⻢':'马','⻜':'飞','⻝':'食','⻥':'鱼','⻦':'鸟',
    '⻩':'黄','⻰':'龙','⻆':'角','⻉':'贝','⻚':'页','⻘':'青','⻨':'麦','⻬':'齐','⻮':'齿','⻳':'龟',
    '⻊':'足','⻁':'虎','⻄':'西','⻤':'鬼','⻣':'骨','⺠':'民','⺟':'母','⺮':'竹','⺶':'羊','⻑':'長',
    '⻏':'阝','⻖':'阝','⺈':'⺈','⻈':'讠','⻐':'钅','⻗':'雨','⻙':'韦','⻞':'饣','⻧':'卤','⻪':'黾',
    '⻭':'齿','⻯':'龙','⺁':'厂','⺇':'几','⺌':'小','⺍':'小','⺒':'巳','⺓':'幺','⺔':'彐','⺗':'心',
    '⺝':'月','⺞':'歹','⺡':'氵','⺢':'水','⺣':'灬','⺤':'爫','⺥':'爫','⺦':'丬','⺧':'牛','⺨':'犭',
    '⺩':'王','⺪':'疋','⺫':'罒','⺬':'示','⺭':'礻','⺯':'糸','⺰':'纟','⺲':'罒','⺳':'网','⺴':'罒',
    '⺵':'罒','⺸':'羊','⺹':'耂','⺺':'聿','⺻':'聿','⺼':'肉','⺽':'臼','⺾':'艹','⺿':'艹','⻀':'艹',
    '⻁':'虎','⻂':'衤','⻃':'覀','⻆':'角','⻇':'角','⻊':'足','⻍':'辶','⻎':'辶','⻕':'镸',
    '⼾':'户','⾢':'邑','⾣':'酉','⿓':'龍','⿔':'龜'
  };
  function fixCJK(str) {
    if (!str || !/[⺀-⿟豈-﫿]/.test(str)) return str;
    let out = '';
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (RADICAL_FIX[ch]) out += RADICAL_FIX[ch];
      else if ((c >= 0x2F00 && c <= 0x2FDF) || (c >= 0xF900 && c <= 0xFAFF)) out += ch.normalize('NFKC');
      else out += ch;
    }
    return out;
  }

  // ------------------------------------------------------------------ 文本层
  async function extractTextLayer(page, vp) {
    const textContent = await page.getTextContent();
    const items = [];
    let lastY = null, lineText = '', lineY0 = Infinity, lineX0 = Infinity, lineY1 = -Infinity, lineX1 = -Infinity;
    const lines = [];
    const flush = () => {
      if (lineText.trim()) lines.push({ text: lineText.trim(), y0: lineY0, x0: lineX0, y1: lineY1, x1: lineX1 });
      lineText = ''; lineY0 = Infinity; lineX0 = Infinity; lineY1 = -Infinity; lineX1 = -Infinity;
    };
    for (const item of textContent.items) {
      if (!item.str) continue;
      item.str = fixCJK(item.str);
      const tx = Util().transform(vp.transform, item.transform);
      const fh = Math.hypot(tx[2], tx[3]) || item.height || 10;
      const rect = { x0: tx[4], y1: tx[5], x1: tx[4] + (item.width || 0) * vp.scale, y0: tx[5] - fh, str: item.str };
      if (rect.x1 < rect.x0) { const t = rect.x0; rect.x0 = rect.x1; rect.x1 = t; }
      if (item.str.trim()) items.push(rect);

      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 5) flush();
      lineText += item.str;
      if (item.str.trim()) { lineY0 = Math.min(lineY0, rect.y0); lineX0 = Math.min(lineX0, rect.x0); lineY1 = Math.max(lineY1, rect.y1); lineX1 = Math.max(lineX1, rect.x1); }
      lastY = y;
    }
    flush();
    return { items, lines };
  }

  // ------------------------------------------------------------------ 图片区域
  async function findImageRegions(page, vp) {
    const OPS = pdfjsLib.OPS;
    const IMG_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
      OPS.paintJpegXObject].filter(v => v !== undefined));
    let ops;
    try { ops = await page.getOperatorList(); } catch (e) { return []; }
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const regions = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = Util().transform(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = Util().transform(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (IMG_OPS.has(fn)) {
        const m = Util().transform(vp.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => Util().applyTransform(p, m));
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const r = {
          x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)),
          x1: Math.min(vp.width, Math.max(...xs)), y1: Math.min(vp.height, Math.max(...ys))
        };
        const w = r.x1 - r.x0, h = r.y1 - r.y0;
        if (w >= MIN_IMG_W && h >= MIN_IMG_H && w * h >= MIN_IMG_AREA) regions.push(r);
      }
    }
    // 合并重叠区域
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let a = 0; a < regions.length; a++) {
        for (let b = a + 1; b < regions.length; b++) {
          if (rectsOverlap(regions[a], regions[b])) {
            const A = regions[a], B = regions[b];
            regions[a] = { x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1) };
            regions.splice(b, 1); merged = true; break outer;
          }
        }
      }
    }
    regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    return regions.slice(0, MAX_REGIONS_PER_PAGE);
  }

  // ------------------------------------------------------------------ 渲染
  async function renderPage(page, vp1, options = {}) {
    let s = (({ fast: 160, balanced: 220, fine: OCR_DPI })[options.mode] || 220) / 72;
    s = Math.min(s, MAX_RENDER_SIDE / Math.max(vp1.width, vp1.height));
    s = Math.min(s, Math.sqrt(MAX_RENDER_PIXELS / (vp1.width * vp1.height)));
    const viewport = page.getViewport({ scale: s });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: 'rgba(255,255,255,1)' }).promise;
    return { canvas, scale: s };
  }

  function cropCanvas(src, x0, y0, x1, y1) {
    const pad = 12;
    const X0 = Math.max(0, Math.floor(x0) - pad), Y0 = Math.max(0, Math.floor(y0) - pad);
    const X1 = Math.min(src.width, Math.ceil(x1) + pad), Y1 = Math.min(src.height, Math.ceil(y1) + pad);
    const c = document.createElement('canvas');
    c.width = Math.max(1, X1 - X0); c.height = Math.max(1, Y1 - Y0);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, X0, Y0, c.width, c.height, 0, 0, c.width, c.height);
    return { canvas: c, ox: X0, oy: Y0 };
  }

  // ------------------------------------------------------------------ 单页处理
  async function processPage(page, pageNo, pageCount, onProgress, useOCR, options = {}) {
    const vp = page.getViewport({ scale: 1 });
    const { items, lines } = await extractTextLayer(page, vp);
    const layerText = lines.map(l => l.text).join('\n');

    // Page geometry (pt) for the "按页排版" view, same shape as the native engine's layoutPages.
    const layoutOf = list => ({ page: pageNo, width: vp.width, height: vp.height, lines: list.filter(l => isFinite(l.x0) && isFinite(l.y0)).map(l => ({ text: l.text, x0: l.x0, y0: l.y0, x1: isFinite(l.x1) ? l.x1 : l.x0 + 10, y1: isFinite(l.y1) ? l.y1 : l.y0 + 12, ...(l.score != null ? { score: l.score } : {}) })) });
    const result = { text: layerText, ocrUsed: false, ocrText: '', mode: 'text', layout: layoutOf(lines) };
    if (!useOCR) return result;

    const scanned = meaningfulCount(layerText) < SCANNED_PAGE_MIN_CHARS;
    let regions = scanned
      ? [{ x0: 0, y0: 0, x1: vp.width, y1: vp.height }]
      : await findImageRegions(page, vp);
    if (!regions.length) return result;

    const tag = scanned ? '整页' : `${regions.length} 张图片`;
    if (onProgress) onProgress(pageNo - 1 + 0.05, pageCount, `OCR 第 ${pageNo}/${pageCount} 页（${tag}）准备中...`);

    await getOCRWorker();
    const { canvas, scale } = await renderPage(page, vp, options);

    const blocks = [];
    for (let r = 0; r < regions.length; r++) {
      options.signal?.throwIfAborted();
      const reg = regions[r];
      const crop = cropCanvas(canvas, reg.x0 * scale, reg.y0 * scale, reg.x1 * scale, reg.y1 * scale);
      const res = await OCRService.recognize(crop.canvas, p => {
        if (onProgress) {
          const frac = (r + p) / regions.length;
          onProgress(pageNo - 1 + 0.1 + 0.9 * frac, pageCount,
            `OCR 第 ${pageNo}/${pageCount} 页（${tag}）${Math.round(frac * 100)}%`);
        }
      }, options);
      crop.canvas.width = crop.canvas.height = 0;
      // OCR 坐标 → 页面坐标(pt)，并与文本层去重
      const kept = [];
      for (const l of res.lines) {
        const box = {
          x0: (l.x0 + crop.ox) / scale, x1: (l.x1 + crop.ox) / scale,
          y0: (l.y0 + crop.oy) / scale, y1: (l.y1 + crop.oy) / scale
        };
        const h = box.y1 - box.y0;
        const probe = { x0: box.x0 - h * 0.5, x1: box.x1 + h * 0.5, y0: box.y0 - h * 0.4, y1: box.y1 + h * 0.4 };
        const under = items.filter(it => {
          const cx = (it.x0 + it.x1) / 2, cy = (it.y0 + it.y1) / 2;
          return cx >= probe.x0 && cx <= probe.x1 && cy >= probe.y0 && cy <= probe.y1;
        });
        if (under.length) {
          const ref = norm(under.sort((a, b) => a.x0 - b.x0).map(i => i.str).join(''));
          if (coverage(norm(l.text), ref) >= 0.6) continue; // 文本层已有，跳过
        }
        kept.push({ text: l.text, y0: box.y0, x0: box.x0, y1: box.y1, x1: box.x1, score: l.score });
      }
      if (kept.length) blocks.push({ y0: kept[0].y0, x0: reg.x0, lines: kept });
    }
    canvas.width = canvas.height = 0; // 释放内存

    const ocrText = blocks.map(b => b.lines.map(l => l.text).join('\n')).join('\n');
    if (!ocrText.trim()) return result;

    // 合并：OCR 块插到文本层中对应纵向位置
    const out = lines.map(l => ({ ...l }));
    for (const b of blocks.sort((a, c) => a.y0 - c.y0)) {
      let idx = out.findIndex(l => l.y0 > b.y0 + 2);
      if (idx < 0) idx = out.length;
      out.splice(idx, 0, ...b.lines.map(l => ({ ...l, ocr: true })));
    }
    return {
      layout: layoutOf(out),
      text: out.map(l => l.text).join('\n'),
      ocrUsed: true,
      ocrText,
      mode: scanned ? 'scanned' : 'images'
    };
  }

  // ------------------------------------------------------------------ 主入口
  /**
   * 从 PDF 提取全部文本（文本层 + 图片 OCR）
   * @param {File|Blob|ArrayBuffer} input
   * @param {Function} onProgress (current, total, phase)
   * @param {{ocr?: boolean}} options
   */
  async function parse(input, onProgress, options = {}) {
    options.signal?.throwIfAborted();
    const useOCR = options.ocr !== false;

    // 图片文件：直接 OCR
    if (input instanceof Blob && /^image\//.test(input.type)) {
      return parseImage(input, onProgress, options);
    }

    let arrayBuffer;
    if (input instanceof Blob) arrayBuffer = await input.arrayBuffer();
    else if (input instanceof ArrayBuffer) arrayBuffer = input;
    else if (ArrayBuffer.isView(input)) arrayBuffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    else throw new Error('不支持的文件类型');

    await ensurePdfJs();
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer.slice(0)),
      CMapReaderFactory: EmbeddedCMapReaderFactory,
      cMapUrl: 'lib/pdfjs/cmaps/',
      cMapPacked: true,
      useSystemFonts: true,
    }).promise;

    const pageCount = pdf.numPages;
    let metadata = {};
    try { metadata = (await pdf.getMetadata()).info || {}; } catch (e) {}

    const pageTexts = [], layoutPages = [];
    let ocrUsed = false, ocrError = null;
    const pageModes = [];
    let ocrAvailable = useOCR;

    for (let i = 1; i <= pageCount; i++) {
      if (options.signal?.aborted) { await pdf.destroy(); options.signal.throwIfAborted(); }
      if (onProgress) onProgress(i - 1, pageCount, `解析第 ${i}/${pageCount} 页...`);
      const page = await pdf.getPage(i);
      let r;
      try {
        r = await processPage(page, i, pageCount, onProgress, ocrAvailable, options);
      } catch (e) {
        if (e.name === 'AbortError') { await pdf.destroy(); throw e; }
        console.warn('[PDFParser] 第 ' + i + ' 页 OCR 失败：', e);
        ocrError = e;
        ocrAvailable = false; // 引擎坏了就不再反复尝试
        r = await processPage(page, i, pageCount, onProgress, false);
      }
      const offset = pageTexts.reduce((sum, text) => sum + text.length + 2, 0);
      layoutPages.push({ ...r.layout, rawStart: offset, rawEnd: offset + r.text.length });
      pageTexts.push(r.text);
      pageModes.push(r.mode);
      if (r.ocrUsed) ocrUsed = true;
      page.cleanup();
      if (onProgress) onProgress(i, pageCount, `已完成第 ${i}/${pageCount} 页`);
    }
    pdf.destroy();

    const fullText = pageTexts.join('\n\n');
    if (!fullText.trim()) {
      if (ocrError) throw new Error('PDF 没有文本层，且 OCR 失败：' + (ocrError.message || ocrError));
      throw new Error('未能从 PDF 中识别出任何文字');
    }
    return { text: fullText, layoutPages, pageCount, metadata, ocrUsed, pageModes, ocrError: ocrError ? String(ocrError.message || ocrError) : null };
  }

  async function parseImage(file, onProgress, options = {}) {
    if (onProgress) onProgress(0, 1, 'OCR 图片识别中...');
    await getOCRWorker();
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    // 小图放大，大图限制
    let s = Math.min(1, MAX_RENDER_SIDE / Math.max(bmp.width, bmp.height));
    if (Math.max(bmp.width, bmp.height) * s < 1200) s = 1200 / Math.max(bmp.width, bmp.height);
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const res = await OCRService.recognize(c, p => onProgress && onProgress(p, 1, `OCR 图片识别 ${Math.round(p * 100)}%`), options);
    bmp.close();
    const layout = { page: 1, width: c.width, height: c.height, rawStart: 0, rawEnd: res.text.length, lines: (res.lines || []).map(l => ({ text: l.text, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, ...(l.score != null ? { score: l.score } : {}) })) };
    c.width = c.height = 0;
    if (!res.text.trim()) throw new Error('图片中未识别到文字');
    return { text: res.text, layoutPages: [layout], pageCount: 1, metadata: {}, ocrUsed: true, pageModes: ['image'], ocrError: null };
  }

  async function parseAndExtract(file, onProgress, options = {}) {
    if (typeof NativeDocuments !== 'undefined' && NativeDocuments.available()) return NativeDocuments.parseAndExtract(file, onProgress, options);
    const started = performance.now();
    const { text, layoutPages, pageCount, ocrUsed, pageModes, ocrError } = await parse(file, onProgress, options);
    const seconds = (performance.now() - started) / 1000; // recognition only, not field extraction
    options.signal?.throwIfAborted();
    const config = await Storage.getConfig();
    const extracted = await Extractor.extract(text, config);
    return { extracted, rawText: text, layoutPages, pageCount, ocrUsed, pageModes, ocrError, engine: 'browser', seconds };
  }

  return {
    parse,
    parseAndExtract,
    terminateOCR,
    getOCRWorker,
    isOCRReady: () => typeof OCRService !== 'undefined' && OCRService.isReady(),
    lastOCRError: () => _ocrLastError
  };
})();
