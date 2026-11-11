/** Route OCR to the packaged local CPU service; otherwise use the offline browser engine. */
const OCRService = (() => {
  let native = false;
  let ready = null;
  async function init(onProgress) {
    if (ready) return ready;
    ready = (async () => {
      if (location.protocol === 'http:' && location.hostname === '127.0.0.1' && window.__LOCAL_OCR_TOKEN) {
        const response = await fetch('/api/health', { cache: 'no-store' });
        const health = await response.json();
        if (!response.ok || health.application !== 'ContractOCR' || health.engine !== 'native') throw new Error('本机OCR服务不可用，请重新打开ContractOCR.exe');
        native = true;
        onProgress?.(1, '本机原生OCR服务就绪');
        const label = document.getElementById('engineStatus');
        if (label) label.textContent = '本机原生 OCR · 支持两份文档同时处理';
        return true;
      }
      native = false;
      return PaddleOCR.init(onProgress);
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }
  async function recognize(canvas, onProgress, options = {}) {
    await init();
    if (!native) return PaddleOCR.recognize(canvas, onProgress, options);
    onProgress?.(0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片转换失败')), 'image/png'));
    const response = await fetch('/api/ocr?mode=' + encodeURIComponent(options.mode || 'balanced'), {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'X-OCR-Token': window.__LOCAL_OCR_TOKEN }, body: blob
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '本机OCR识别失败');
    onProgress?.(1);
    return result;
  }
  return { init, recognize, isReady: () => native || PaddleOCR.isReady(), engine: () => native ? 'native' : 'browser' };
})();
