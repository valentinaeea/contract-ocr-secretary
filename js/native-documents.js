/** Submit the entire original document to a local worker, not one page at a time. */
const NativeDocuments = (() => {
  const available = () => location.protocol === 'http:' && location.hostname === '127.0.0.1' && !!window.__LOCAL_OCR_TOKEN;
  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '本机服务请求失败');
    return result;
  }
  const headers = () => ({ 'X-OCR-Token': window.__LOCAL_OCR_TOKEN });
  async function waitAndExtract(id, onProgress, options = {}) {
    while (true) {
      options.signal?.throwIfAborted();
      const job = await request('/api/jobs/' + encodeURIComponent(id), { signal: options.signal });
      if (job.status === 'cancelled') throw new DOMException('任务已取消', 'AbortError');
      if (job.progress) onProgress?.(job.progress.current, job.progress.total, job.progress.phase);
      if (job.status === 'error') throw new Error(job.error || '识别失败');
      if (job.status === 'done') {
        const result = job.result;
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  async function submit(file, mode = 'balanced',uploadCategory='other') {
    return request('/api/jobs', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-OCR-Mode': mode,'X-Upload-Category':uploadCategory }, body: file });
  }
  async function parseAndExtract(file, onProgress, options = {}) {
    const job = await submit(file, options.mode || 'balanced',options.uploadCategory||'other');
    onProgress?.(0, 1, '整份文件已交给本机进程，切屏或关闭网页后仍会继续；请保持程序窗口开启');
    return waitAndExtract(job.id, onProgress, options);
  }

  async function cancel(id) {
    const result = await request('/api/jobs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{}' });
    if (result.alreadyFinished || ['done', 'error', 'cancelled'].includes(result.status)) return result;
    while (true) {
      const job = await request('/api/jobs/' + encodeURIComponent(id));
      if (['done', 'error', 'cancelled'].includes(job.status)) return { status: job.status, alreadyFinished: job.status === 'done' };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return { retry:id=>request('/api/jobs/'+encodeURIComponent(id)+'/retry',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:'{}'}), discard:id=>request('/api/jobs/'+encodeURIComponent(id)+'/discard',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:'{}'}), available, submit, cancel, parseAndExtract, waitAndExtract, list: () => request('/api/jobs'), request, headers };
})();
