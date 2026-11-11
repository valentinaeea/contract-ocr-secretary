/**
 * 主应用逻辑
 * 处理 UI 交互、上传、列表展示、设置等
 */

const App = (() => {
  let contracts = []; // 内存中的合同数据
  let currentEditingId = null;
  let fullTextDraft = null;
  let reviewDraft = null;
  let analysisTimer=null;
  const analysisLabel=c=>c.managedBusinessAnalysis&&c.analysisStatus==='done'&&c.ruleAnalysisStatus!=='done'?(c.ruleAnalysisStatus==='error'?'规则分析失败，可重新分析':'关键词与分类分析中'):({queued:"业务分析中",running:"业务分析中",done:"业务分析完成",error:"业务分析失败，可重新分析"}[c.analysisStatus]||"业务分析就绪");
  // Cards show OCR and analysis durations separately; analysis runs after OCR has been saved.
  const ANALYSIS_LABEL_PATTERN=/(?:关键词与分类分析中|规则分析失败，可重新分析|业务分析中|业务分析完成|业务分析失败，可重新分析|业务分析就绪)(?:（[^）]*）)?/g;
  const cardAnalysisLabel=c=>{
    const label=analysisLabel(c);
    if(!(c.managedBusinessAnalysis&&c.analysisStatus==='done'&&c.ruleAnalysisStatus==='done'))return label;
    const parts=[];
    if(c.ruleAnalysisSeconds!=null)parts.push('规则 '+Number(c.ruleAnalysisSeconds).toFixed(1)+' 秒');
    if(c.analysisSeconds!=null)parts.push('语义 '+Number(c.analysisSeconds).toFixed(1)+' 秒');
    return parts.length?label+'（'+parts.join(' · ')+'）':label;
  };
  const ocrTimingLabel=c=>{
    if(c.ocrCacheHit)return '复用识别结果（原识别 '+Number(c.originalRecognitionSeconds||0).toFixed(1)+' 秒）';
    const ocr=Number(c.processingSeconds??c.elapsedSeconds??0),total=Number(c.elapsedSeconds??ocr),wait=total-ocr;
    // Browser fallback is single-threaded WASM and keeps none of the native speed-ups; say so.
    // Diagnostics for slow machines: pages, average per page, processes actually used, threads.
    const pages=Number(c.pageCount)||0,used=new Set(c.workerPids||[]).size;
    const detail=c.engine==='native'&&pages>1?' · '+pages+' 页 · 平均 '+(ocr/pages).toFixed(1)+' 秒/页'+(used?' · '+used+(c.ocrWorkers?'/'+c.ocrWorkers:'')+' 个进程':'')+(c.ocrThreads?' × '+c.ocrThreads+' 线程':''):'';
    // Where page time went (summed over pages, across processes): main OCR / re-reads / dates.
    const st=c.stageSeconds||{},sum=Object.values(st).reduce((a,b)=>a+Number(b||0),0);
    const share=k=>Math.round(100*Number(st[k]||0)/sum);
    const stages=c.engine==='native'&&sum>0?'（主识别 '+share('ocr')+'% · 局部补识别 '+share('patches')+'% · 日期复核 '+share('dates')+'%'+(st.keyLines?' · 关键行 '+share('keyLines')+'%':'')+'）':'';
    return (c.engine==='native'?'OCR ':'浏览器备用版 OCR（较慢，请用 ContractOCR.exe）')+ocr.toFixed(1)+' 秒'+detail+stages+(c.engine==='native'&&wait>=1?' · 排队 '+wait.toFixed(1)+' 秒':'');
  };
  function watchAnalysis(){
    clearTimeout(analysisTimer);
    if(!NativeDocuments.available()||!contracts.some(c=>["queued","running"].includes(c.analysisStatus)||(c.managedBusinessAnalysis&&["queued","running"].includes(c.ruleAnalysisStatus))))return;
    analysisTimer=setTimeout(async()=>{try{
      const states=await NativeDocuments.request('/api/analysis');
      if(!states.some(c=>{const old=contracts.find(x=>x.id===c.id);return old&&(c.analysisStatus!==old.analysisStatus||c.analysisRequest!==old.analysisRequest||c.ruleAnalysisStatus!==old.ruleAnalysisStatus);}))return;
      const latest=await Storage.getAllContracts();
      const changed=latest.some(c=>{const old=contracts.find(x=>x.id===c.id);return old&&(c.analysisStatus!==old.analysisStatus||c.analysisRequest!==old.analysisRequest||c.ruleAnalysisStatus!==old.ruleAnalysisStatus);});
      contracts=latest;
      BusinessAnalysis.ensure(latest);
      for(const card of document.querySelectorAll(".parse-result-card[data-contract-id]")){const c=latest.find(x=>x.id===card.dataset.contractId);const meta=card.querySelector(".parse-result-meta");if(c&&meta)meta.textContent=meta.textContent.replace(ANALYSIS_LABEL_PATTERN,cardAnalysisLabel(c));}
      if(changed){renderTable();refreshVisibleVault();
        const badge=document.getElementById("analysisState");
        if(badge&&!document.getElementById("detailModal").hidden){const current=contracts.find(c=>c.id===badge.dataset.contractId);if(current){badge.textContent=analysisLabel(current);if(!reviewDraft?.dirty()&&!fullTextDraft){const top=document.getElementById('detailBody').scrollTop;openDetailModal(current.id);requestAnimationFrame(()=>{document.getElementById('detailBody').scrollTop=top;});}}}
      }
    }catch(e){console.warn("业务分析状态同步稍后重试",e.message);}finally{watchAnalysis();}},1500);
  }

  // ============== 初始化 ==============
  async function init() {
    try {
      // Startup stage markers: shown in diagnostics if the page ever fails to become ready.
      const stage=name=>{window.__CONTRACT_OCR_STAGE=name;};
      stage('openDB');await Storage.openDB();
      stage('domainCatalog');await DomainCatalog.init();
      stage('loadContracts');await loadContracts();
      stage('bindEvents');bindEvents();
      window.addEventListener('business-analysis-updated',async()=>{try{await loadContracts();watchAnalysis();const badge=document.getElementById('analysisState');if(badge&&!document.getElementById('detailModal').hidden&&!fullTextDraft&&!reviewDraft?.dirty()){const top=document.getElementById('detailBody').scrollTop;openDetailModal(badge.dataset.contractId);document.getElementById('detailBody').scrollTop=top;}}catch(e){console.warn(e.message);}});
      Vault.init({searchCloud: searchCloudExcel, saved: loadContracts, toast: showToast, openDetail: id => openDetailModal(id), deleteContract});
      refreshVisibleVault();renderTable();
      stage('loadConfig');await loadCloudConfig();
      stage('recoverJobs');await recoverNativeJobs();
      stage('ready');
      updateStorageInfo();
      // 后台静默预热 OCR 引擎：首次上传扫描型 PDF 时不会卡住
      document.getElementById('fileInput').disabled = false;
      window.__CONTRACT_OCR_READY = true;
      setTimeout(warmupOCR, 1500);
      watchAnalysis();
    } catch (e) {
      showToast('初始化失败: ' + e.message, 'error');
      console.error(e);
    }
  }

  // 后台预热 OCR 引擎（懒加载、不阻塞 UI）
  let _ocrWarmupNotified = false;
  function warmupOCR() {
    if (typeof PDFParser === 'undefined') return;
    // 触发（不等待）。Promise 链中通过微任务不阻塞主线程。
    PDFParser.getOCRWorker((phase, ratio, text) => {
      // 仅在第一次时温和提示用户
      if (phase === 'init' && ratio > 0.05 && !_ocrWarmupNotified) {
        _ocrWarmupNotified = true;
        showToast('正在后台加载本地 OCR 引擎...', 'info');
      }
    }).then(() => {
      if (!_ocrWarmupNotified) {
        _ocrWarmupNotified = true;
        // 引擎已就绪——静默即可，不再打扰
      }
      console.log('[App] OCR 引擎预热完成');
    }).catch(err => {
      console.warn('[App] OCR 引擎预热失败:', err && err.message);
      // 不打断 UI；若失败，用户实际触发 OCR 时会再次重试
    });
  }

  // ============== 数据加载 ==============
  async function loadContracts() {
    contracts = await Storage.getAllContracts();
    BusinessAnalysis.ensure(contracts);
    for(let i=0;i<contracts.length;i++){
      if(contracts[i].managedBusinessAnalysis&&contracts[i].needsExtraction)continue;
      const repaired=Extractor.repairIdentity(Extractor.repairAmount(contracts[i]));
      if(repaired!==contracts[i]){await Storage.updateContract(repaired);contracts[i]=repaired;}
    }
    try{await DomainCatalog.learn(contracts);}catch(e){showToast("合同已保留，服务领域库同步失败："+e.message,"warning");}
    updateContractCount();
    refreshVisibleVault();
    renderTable();
    for(const card of document.querySelectorAll('.parse-result-card[data-contract-id]')){const c=contracts.find(x=>x.id===card.dataset.contractId);if(!c)continue;const edit=card.querySelector('[data-action="edit"]');if(edit)edit.disabled=AnalysisResults.managed(c)&&!AnalysisResults.ready(c);const meta=card.querySelector('.parse-result-meta');if(meta)meta.textContent=meta.textContent.replace(ANALYSIS_LABEL_PATTERN,cardAnalysisLabel(c));}
    return contracts;
  }

  // 检索已并入合同列表：每次合同数据变化都同步给检索与编辑弹窗。
  function refreshVisibleVault() {
    if(typeof Vault!=='undefined') Vault.refresh(contracts);
  }

  function updateContractCount() {
    document.getElementById('contractCount').textContent = contracts.length;
  }

  async function updateStorageInfo() {
    try {
      const { usage, directory } = await Storage.getStorageEstimate();
      const storagePath = document.getElementById('storagePath');
      if (storagePath) { storagePath.textContent = directory || '浏览器数据目录（非程序文件夹）'; storagePath.title = directory || '浏览器 IndexedDB，通常随浏览器用户目录保存在系统盘'; }
      const el = document.getElementById('storageUsage');
      if (usage > 0) {
        el.textContent = formatSize(usage);
      } else {
        // 估算 localStorage 大小
        el.textContent = formatSize(JSON.stringify(contracts).length);
      }
    } catch (e) {
      document.getElementById('storageUsage').textContent = '0 KB';
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  // ============== 事件绑定 ==============
  function bindEvents() {
    window.addEventListener('beforeunload',event=>{if((fullTextDraft && fullTextDraft.editor.value!==fullTextDraft.original)||reviewDraft?.dirty()){event.preventDefault();event.returnValue='';}});
    // 侧边栏导航
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => switchView(item.dataset.view));
    });

    // 单一「合同上传口」：全文分析。已有安永模板类记录仍按原口径展示与分析。
    for(const [zoneId,inputId,category] of [['uploadZone','fileInput','other']]){
      const zone=document.getElementById(zoneId),input=document.getElementById(inputId);
      zone.addEventListener('click',e=>{if(e.target!==input)input.click();});
      zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragover');});
      zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
      zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragover');handleFiles(Array.from(e.dataTransfer.files),category);});
      input.addEventListener('change',e=>{handleFiles(Array.from(e.target.files),category);e.target.value='';});
    }
    document.getElementById('cancelPendingBtn').addEventListener('click', cancelPendingJobs);

    // 合同列表筛选（他人上传的合同在「合同检索」中查找）
    document.getElementById('searchInput').addEventListener('input', () => renderTable());
    // 上传到云端总表

    // 清空全部
    document.getElementById('clearAllBtn').addEventListener('click', () => {
      if (contracts.length === 0) {
        showToast('暂无数据可清空', 'warning');
        return;
      }
      showConfirm('确定要清空所有合同数据吗？此操作不可恢复。', async () => {
        await Storage.clearAll();
        await loadContracts();
        dropDeletedJobCards(true);
        updateStorageInfo();
        showToast('已清空全部数据', 'success');
      });
    });

    // 导出/导入
    document.getElementById('exportBtn').addEventListener('click', exportJSON);
    document.getElementById('exportSampleBtn').addEventListener('click', downloadSample);
    document.getElementById('importBtn').addEventListener('click', () => {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', importData);
    document.getElementById('exportExcelBtn').addEventListener('click', exportExcel);
    document.getElementById('cloudMergeBtn').addEventListener('click', cloudMerge);
    document.getElementById('importExcelBtn').addEventListener('click', () => { if(!needDesktop())document.getElementById('importExcelFile').click(); });
    document.getElementById('importExcelFile').addEventListener('change', async e => {
      const file=e.target.files[0];e.target.value='';if(!file)return;
      const button=document.getElementById('importExcelBtn');button.disabled=true;
      try{const r=await importExcel(file);showToast(`Excel 已整合：新增 ${r.added} 份，更新 ${r.updated} 份，无变化 ${r.unchanged} 份`,'success');}
      catch(error){showToast('导入失败：'+error.message,'error');}
      finally{button.disabled=false;}
    });

    // Initial configuration is awaited by init().

    // 编辑模态框
    document.querySelectorAll('[data-close]').forEach(el => {
      el.addEventListener('click', closeModals);
    });
  }

  // ============== 视图切换 ==============
  function switchView(viewName) {
    if (viewName === 'vault-manage') viewName = 'list'; // 合同整理已并入「编辑」弹窗
    if (viewName === 'dashboard' || viewName === 'keywords') viewName = 'list'; // 已移除的分析页
    // 我的合同（原合同列表）与上传识别在同一页
    const toMine = viewName === 'list'; if (toMine || viewName === 'cloud-share') viewName = 'upload';
    const targetNav=document.querySelector(`.nav-item[data-view="${viewName}"]`),targetView=document.getElementById(`view-${viewName}`);
    if(!targetNav||!targetView)return false;
    if (!Vault.canLeave()) return false;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-view="${viewName}"]`).classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewName}`).classList.add('active');

    if (viewName === 'upload') {
      if (toMine) requestAnimationFrame(() => document.getElementById('myContracts').scrollIntoView({ block: 'start' }));
    } else if (viewName === 'vault-search') {
      Vault.refresh(contracts);

    }
    return true;
  }

  // ============== 文件处理 ==============
  // Two document jobs; shared OCR inference is serialized in PaddleOCR.
  const jobs = [];
  let activeJobs = 0;
  const MAX_JOBS = 2;
  function handleFiles(files, uploadCategory='other') {
    const mode = document.getElementById('ocrMode').value;
    if (typeof NativeDocuments === 'undefined' || !NativeDocuments.available()) showToast('当前是浏览器备用版：单线程识别、较慢，且不使用多进程提速和 PP-OCRv5 手写模型。请双击 ContractOCR.exe 使用原生版。', 'warning');
    for (const file of files) {
      if (!(/\.pdf$/i.test(file.name) || /^image\//.test(file.type))) continue;
      const card = createResultCard(file, jobs.length, jobs.length + 1, uploadCategory);
      card.setStatus('processing', '排队等待识别');
      document.getElementById('parseResults').appendChild(card.element);
      const job = { file, card, mode, uploadCategory, progress: 0, state: 'waiting', controller: new AbortController() };
      card.setCancelAction(() => cancelOrRemove(job));
      if (typeof NativeDocuments !== 'undefined' && NativeDocuments.available()) {
        // Submit every selected file immediately, including those awaiting a UI slot.
        job.submission = NativeDocuments.submit(file, mode, uploadCategory).then(remote => {
          job.remoteId = remote.id;
          if (job.state === 'waiting') card.setStatus('processing', '已提交本机后台队列，可切屏；请保持程序窗口开启');
          return { id: remote.id };
        }, error => ({ error }));
      }
      jobs.push(job);
    }
    renderQueueProgress();
    pumpQueue();
  }
  async function recoverNativeJobs() {
    if (typeof NativeDocuments === 'undefined' || !NativeDocuments.available()) return;
    const pending = (await NativeDocuments.list()).filter(j => ['queued','running','interrupted'].includes(j.status) || j.retryAvailable);
    const results = document.getElementById('parseResults');
    for (const remote of pending) {
      const file = { name: remote.filename, size: remote.fileSize };
      const card = createResultCard(file, jobs.length, jobs.length + 1, remote.uploadCategory||'other');
      card.setStatus('processing', '正在恢复本机后台任务');
      results.appendChild(card.element);
      const job = { file, card, mode: remote.mode, uploadCategory:remote.uploadCategory||'other', remoteId: remote.id, progress: 0, state: 'waiting', controller: new AbortController() };
      card.setCancelAction(() => cancelOrRemove(job));
      if(remote.status==='error' || (remote.status==='done' && remote.retryAvailable)){job.state='error';job.progress=1;card.setStatus('error',remote.error || '存在失败页，可仅重试失败页');card.setRetryAction(()=>retryRemoteJob(job));}
      jobs.push(job);
    }
    if (pending.length) pumpQueue();
  }
  async function retryRemoteJob(job) {
    if(job.state==='waiting'||job.state==='running'||job.state==='retrying')return;
    job.state='retrying';job.card.setStatus('processing','正在恢复任务…');
    try {
      await NativeDocuments.retry(job.remoteId);
      job.controller=new AbortController();job.cancelRequested=false;job.cancelPromise=null;job.submission=null;
      job.progress=0;job.state='waiting';job.card.setRetryAction(null);pumpQueue();
    } catch(error){job.state='error';job.card.setStatus('error','重试启动失败：'+error.message);job.card.setRetryAction(()=>retryRemoteJob(job));}
  }
  function removeJobCard(job) {
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    job.card.element.remove();
    renderQueueProgress();
  }
  // 合同删除后，上传页对应的识别记录卡片一并移除；clearAll 时移除全部已结束的卡片。
  function dropDeletedJobCards(all=false) {
    const ids=new Set(contracts.map(c=>c.id));
    for(const job of jobs.slice()){
      if(!['done','error','cancelled'].includes(job.state))continue;
      const id=job.card.element.dataset.contractId;
      if(all||(id&&!ids.has(id)))removeJobCard(job);
    }
    for(const card of document.querySelectorAll('.parse-result-card[data-contract-id]')){
      const id=card.dataset.contractId;
      if(id&&!ids.has(id)&&!jobs.some(j=>j.card.element===card))card.remove();
    }
    renderQueueProgress();
  }
  function cancelOrRemove(job) {
    if (['done', 'error', 'cancelled'].includes(job.state)) {
      if(job.state==='error' && job.remoteId && NativeDocuments.available()) return NativeDocuments.discard(job.remoteId).then(()=>removeJobCard(job)).catch(error=>showToast('移除失败：'+error.message,'error'));
      return removeJobCard(job);
    }
    return cancelJob(job).then(() => { if (job.state === 'cancelled') removeJobCard(job); });
  }
  function cancelJob(job) {
    if (job.cancelPromise) return job.cancelPromise;
    if (!['waiting', 'running'].includes(job.state)) return Promise.resolve();
    const previous = job.state;
    job.cancelRequested = true;
    job.state = 'cancelling';
    job.card.setStatus('cancelling', '正在取消，当前计算结束后停止；不会影响其他任务');
    job.cancelPromise = (async () => {
      try {
        if (job.submission) {
          const submission = await job.submission;
          if (submission.error) throw submission.error;
        }
        if (job.remoteId) {
          const result = await NativeDocuments.cancel(job.remoteId);
          if (result.alreadyFinished) {
            job.cancelRequested = false;
            job.state = previous;
            job.cancelPromise = null;
            showToast('该任务已识别完成，结果已保留', 'info');
            if (previous === 'waiting') pumpQueue();
            return;
          }
        }
        job.controller.abort();
        job.state = 'cancelled';
        job.progress = 1;
        job.card.setStatus('cancelled', '已取消，未生成新的合同结果');
      } catch (error) {
        job.cancelRequested = false;
        job.state = previous;
        job.cancelPromise = null;
        job.card.setStatus('processing', '取消未成功：' + error.message + '；任务继续，可重试');
        showToast('取消失败：' + error.message, 'error');
      } finally {
        renderQueueProgress();
        if (previous === 'waiting') pumpQueue();
      }
    })();
    renderQueueProgress();
    return job.cancelPromise;
  }
  async function cancelPendingJobs() {
    const pending = jobs.filter(job => ['waiting', 'running'].includes(job.state));
    await Promise.allSettled(pending.map(cancelOrRemove));
    renderQueueProgress();
  }
  function renderQueueProgress() {
    const done = jobs.filter(j => ['done', 'error', 'cancelled'].includes(j.state)).length;
    const cancelled = jobs.filter(j => j.state === 'cancelled').length;
    const cancelButton = document.getElementById('cancelPendingBtn');
    if (cancelButton) cancelButton.disabled = !jobs.some(j => ['waiting', 'running'].includes(j.state));
    const failed = jobs.filter(j => j.state === 'error').length;
    document.getElementById('parseProgress').style.display = jobs.length ? 'block' : 'none';
    const percent = jobs.length ? jobs.reduce((sum, j) => sum + j.progress, 0) / jobs.length * 100 : 0;
    updateProgress(percent, `已结束 ${done}/${jobs.length} · 处理中 ${activeJobs} · 等待 ${jobs.filter(j => j.state === 'waiting').length} · 失败 ${failed} · 已取消 ${cancelled}`, done, jobs.length);
  }
  function pumpQueue() {
    while (activeJobs < MAX_JOBS) {
      const job = jobs.find(j => j.state === 'waiting');
      if (!job) break;
      job.state = 'running';
      activeJobs++;
      runJob(job).finally(() => {
        activeJobs--;
        renderQueueProgress();
        pumpQueue();
      });
    }
    renderQueueProgress();
  }
  async function runJob(job) {
    const { file, card } = job;
    const started = performance.now();
    try {
      card.setStatus('processing', '正在解析…');
      if (job.submission) { const submission = await job.submission; if (submission.error) throw submission.error; }
      if (job.cancelPromise) await job.cancelPromise;
      job.controller.signal.throwIfAborted();
      const progressCallback = (current, total, phase) => {
        if (job.cancelRequested) return;
        job.progress = Math.max(0, Math.min(1, current / Math.max(1, total)));
        card.setStatus('processing', phase || `解析 ${current}/${total} 页`);
        renderQueueProgress();
      };
      const result = job.remoteId
        ? await NativeDocuments.waitAndExtract(job.remoteId, progressCallback, { signal: job.controller.signal })
        : await PDFParser.parseAndExtract(file, progressCallback, { mode: job.mode, uploadCategory:job.uploadCategory, signal: job.controller.signal });
      if (job.cancelPromise) await job.cancelPromise;
      job.controller.signal.throwIfAborted();
      let contract = {
        id: result.id || Storage.generateId(), ...result.extracted,
        uploadCategory:job.uploadCategory||result.uploadCategory||'other',
        sourceFile: file.name, fileSize: file.size, pageCount: result.pageCount,
        ocrUsed: result.ocrUsed || false, rawText: result.rawText || '',
        pageAudit: result.pageAudit || [], layoutPages: result.layoutPages || [], sourceAvailable: result.sourceAvailable || false,
        analysisStatus:result.analysisStatus||(NativeDocuments.available()?'queued':'done'),ocrCacheHit:!!result.ocrCacheHit,originalRecognitionSeconds:result.originalRecognitionSeconds,
        semanticTags: result.semanticTags || [], semanticModel: result.semanticModel || null, semanticNote: result.semanticNote || '',
        engine: result.engine || 'browser', reviewNotes: result.reviewNotes || [], needsExtraction:NativeDocuments.available(),managedBusinessAnalysis:NativeDocuments.available(),ruleAnalysisStatus:NativeDocuments.available()?'queued':'done',
        failedPages:result.failedPages || [],resumedPages:result.resumedPages || 0,processingSeconds:result.seconds,ocrModel:result.ocrModel||null,workerPids:result.workerPids||[],stageSeconds:result.stageSeconds||null,ocrThreads:result.ocrThreads||null,ocrWorkers:result.ocrWorkers||null,peakWorkerMemoryMB:result.peakWorkerMemoryMB,
        ocrMode: job.mode, elapsedSeconds: (performance.now() - started) / 1000,
        createdAt: Date.now()
      };
      delete contract.confidence;
      job.state = 'saving';
      card.setStatus('saving', '识别完成，正在保存');
      contract=await Storage.addContract(contract);
      const priorIndex=contracts.findIndex(item=>item.id===contract.id);
      if(priorIndex>=0)contracts[priorIndex]=contract;else contracts.unshift(contract);
      try{await DomainCatalog.learn(contracts);}catch(e){showToast("合同已保存，服务领域库同步失败："+e.message,"warning");}
      DocumentView.remember(contract.id, file);
      job.state = 'done';
      card.setStatus('success', `识别完成 · ${ocrTimingLabel(contract)} · ${cardAnalysisLabel(contract)}${result.ocrUsed ? ' · OCR' : ' · 文本提取'}${result.failedPages?.length ? ' · 失败页：'+result.failedPages.join('、') : ''}${result.resumedPages ? ' · 复用 '+result.resumedPages+' 页' : ''}`, result.extracted, contract.id);
      BusinessAnalysis.ensure(contracts);
      watchAnalysis();
      if(result.failedPages?.length && job.remoteId)card.setRetryAction(()=>retryRemoteJob(job));
      if (result.ocrError) showToast(file.name + '：部分页面 OCR 失败，请复核全文', 'warning');
      updateContractCount();
      renderTable();
      refreshVisibleVault();
      updateStorageInfo();
    } catch (e) {
      if (job.cancelRequested || e.name === 'AbortError') {
        if (job.cancelPromise) await job.cancelPromise;
        if (job.cancelRequested) { job.state = 'cancelled'; card.setStatus('cancelled', '已取消，未生成新的合同结果'); return; }
      }
      console.error(e);
      job.state = 'error';
      card.setStatus('error', '解析失败: ' + (e.message || '未知错误'));
      if(job.remoteId && NativeDocuments.available()) { const remote=await NativeDocuments.list().then(items=>items.find(item=>item.id===job.remoteId)).catch(()=>null);if(remote?.retryAvailable)card.setRetryAction(()=>retryRemoteJob(job)); }
    } finally {
      job.progress = 1;
    }
  }

  function updateProgress(percent, text, current, total) {
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressText').textContent = text;
    document.getElementById('progressCount').textContent = `${current}/${total}`;
  }

  function createResultCard(file, idx, total,uploadCategory='other') {
    const card = document.createElement('div');
    card.className = 'parse-result-card';
    card.innerHTML = `
      <div class="parse-result-icon processing">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      </div>
      <div class="parse-result-info">
        <div class="parse-result-name">${escapeHtml(file.name)}</div><div class="upload-category-label">${uploadCategory==='ey-template'?'安永模板类 · 仅分析附录一／工作说明书':'合同上传口 · 全文分析'}</div>
        <div class="parse-result-meta">${formatSize(file.size)} · 等待解析</div>
      </div>
      <div class="parse-result-actions">
        <button class="btn btn-primary btn-sm" data-action="retry" type="button" hidden>重试失败内容</button>
        <button class="btn btn-ghost btn-sm" data-action="cancel" type="button">取消并移除</button>
        <button class="row-action-btn" data-action="text" title="查看识别全文" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>
        </button>
        <button class="row-action-btn" data-action="edit" title="编辑" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
    `;
    return {
      element: card,
      pageCount: 1,
      setRetryAction(callback){const button=card.querySelector('[data-action=retry]');button.hidden=!callback;button.onclick=callback;},
      setCancelAction(callback) { card.querySelector('[data-action="cancel"]').onclick = callback; },
      setStatus(status, text, extracted, contractId) {
        card.querySelector('[data-action=retry]').hidden=true;
        const icon = card.querySelector('.parse-result-icon');
        const meta = card.querySelector('.parse-result-meta');
        const actions = card.querySelector('.parse-result-actions');
        icon.className = 'parse-result-icon ' + status;
        const cancel = actions.querySelector('[data-action="cancel"]');
        cancel.disabled = status === 'cancelling' || status === 'saving';
        cancel.style.display = status === 'success' ? 'none' : '';
        cancel.textContent = status === 'cancelled' || status === 'error' ? '移除' : (status === 'cancelling' ? '取消中…' : '取消并移除');
        if (status === 'success') {
          card.dataset.contractId=contractId||'';
          icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
          meta.textContent = text;
          const editBtn = actions.querySelector('[data-action="edit"]');
          const newContract=contracts.find(c=>c.id===contractId);
          if(newContract){
            if(editBtn){editBtn.style.display='block';editBtn.disabled=AnalysisResults.managed(newContract)&&!AnalysisResults.ready(newContract);editBtn.onclick=()=>Vault.openEditor(newContract.id);}
            const textBtn=actions.querySelector('[data-action="text"]');
            if(textBtn){textBtn.style.display='block';textBtn.onclick=()=>openDetailModal(newContract.id,true);}
          }
        } else if (status === 'error') {
          icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
          meta.textContent = text;
        } else {
          icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
          meta.textContent = `${formatSize(file.size)} · ${text}`;
        }
      }
    };
  }

  // ============== 表格渲染 ==============
  // 合同列表：原始关键词与 PIC / EIC / FIC 来自整理页同一份资料（VaultModel），按合同对象缓存。
  const listProfiles=new WeakMap();
  function listProfile(c){
    let p=listProfiles.get(c);
    if(!p){try{p=VaultModel.project(c);}catch{p={keywords:[],pic:'',eic:'',fic:''};}listProfiles.set(c,p);}
    return p;
  }
  // 合同列表：本机合同；云盘总表中他人上传的合同在「合同检索」中出现。
  let uploaderSelf='';
  const myUploader=()=>uploaderSelf||'本机';
  function listFiltered(){
    const filter=(document.getElementById('searchInput')?.value||'').trim().toLowerCase();
    if(!filter)return contracts;
    return contracts.filter(c=>{const p=listProfile(c);return [c.projectName,c.partyA,c.partyB,c.content,c.deliverables,c.sourceFile,c.rawText,c.uploadedByName,c.engagementCode,c.engagementCodeDescription,c.engagementName,...(p.keywords||[]),...(p.systems||[]),p.pic,p.eic,p.fic].filter(Boolean).join(' ').toLowerCase().includes(filter);});
  }
  function listColumns(c){
    const p=listProfile(c),keywords=p.keywords||[],shown=keywords.slice(0,6);
    const chips=shown.length?shown.map(k=>`<span class="list-kw">${escapeHtml(k)}</span>`).join('')+(keywords.length>shown.length?`<span class="list-kw more">+${keywords.length-shown.length}</span>`:''):'<span class="list-kw-empty">-</span>';
    return `<td class="kw-cell" title="${escapeHtml(keywords.join('；'))}"><div class="list-kws">${chips}</div></td>`+['pic','eic','fic'].map(k=>`<td class="person-cell">${escapeHtml(p[k]||'-')}</td>`).join('');
  }
  function excelRows(list){
    return list.map(c=>{const p=listProfile(c);return {'项目名称':c.projectName||'','上传者ID':c.uploadedByName||myUploader(),'Engagement Code':c.engagementCode||'','Engagement Code Description':c.engagementCodeDescription||'','Engagement Name':c.engagementName||'','甲方':c.partyA||'','乙方':c.partyB||'','签约时间':c.signDate||'','原始关键词':(p.keywords||[]).join('；'),'服务领域':(p.services||[]).join('；'),'具体服务':(p.specificTags||[]).join('；'),'系统':(p.systems||[]).join('；'),'PIC':p.pic||'','EIC':p.eic||'','FIC':p.fic||'','来源文件':c.sourceFile||'','合同ID':c.id};});
  }
  function needDesktop(){if(NativeDocuments.available())return false;showToast('Excel 导出、导入和云盘合并需要在桌面版（ContractOCR.exe）中使用','warning');return true;}
  async function excelPost(path,body,json=true){
    const response=await fetch(path,{method:'POST',headers:{...NativeDocuments.headers(),'Content-Type':json?'application/json':'application/octet-stream'},body:json?JSON.stringify(body):body});
    if(!response.ok){let message='本机服务请求失败';try{message=(await response.json()).error||message;}catch{}throw new Error(message);}
    return response;
  }
  async function searchCloudExcel(criteria){
    if(!NativeDocuments.available())throw Error('请使用桌面版查询云盘总表。');
    return (await excelPost('/api/excel/cloud-search',criteria)).json();
  }

  async function exportExcel(){
    if(needDesktop())return;
    const list=listFiltered();
    if(!list.length){showToast('暂无合同可导出','warning');return;}
    const button=document.getElementById('exportExcelBtn');button.disabled=true;
    try{const blob=await (await excelPost('/api/excel/export',{rows:excelRows(list)})).blob();downloadFile(blob,`合同列表_${getDateStr()}.xlsx`);showToast(`已导出 ${list.length} 份合同到 Excel`,'success');}
    catch(error){showToast('导出失败：'+error.message,'error');}
    finally{button.disabled=false;}
  }
  const splitKeywords=text=>[...new Set(String(text||'').split(/[；;，,、\n]+/).map(x=>x.trim()).filter(Boolean))];
  const sameKey=(c,row)=>[c.projectName,c.partyA,c.signDate].map(x=>String(x||'').trim().toLowerCase()).join('|')===[row['项目名称'],row['甲方'],row['签约时间']].map(x=>String(x||'').trim().toLowerCase()).join('|');
  // 导入同格式表：按合同ID（没有ID时按项目名称+甲方+签约时间）更新已有合同；表里留空的单元格不覆盖已有内容；找不到的行新增为「表格导入」合同。
  const ENGAGEMENT_COLUMNS=[['Engagement Code','engagementCode'],['Engagement Code Description','engagementCodeDescription'],['Engagement Name','engagementName']];
  async function importExcel(file){
    const {rows}=await (await excelPost('/api/excel/parse',file,false)).json();
    let added=0,updated=0,unchanged=0;
    for(const row of rows){
      if(!String(row['项目名称']||'').trim()&&!String(row['合同ID']||'').trim())continue;
      const current=contracts.find(c=>row['合同ID']&&c.id===row['合同ID'])||contracts.find(c=>sameKey(c,row));
      if(current){
        const p=VaultModel.project(current),next={...p},keywords=splitKeywords(row['原始关键词']);let changed=false;
        if(row['项目名称']&&row['项目名称']!==p.name){next.name=row['项目名称'];changed=true;}
        for(const [column,key] of [['PIC','pic'],['EIC','eic'],['FIC','fic']])if(row[column]&&row[column]!==(p[key]||'')){next[key]=row[column];changed=true;}
        // 已有合同的关键词只由自动识别产生，导入 Excel 不覆盖；没有正文的记录才使用表格中的关键词
        if(!String(current.rawText||'').trim()&&keywords.length&&keywords.join('；')!==(p.keywords||[]).join('；')){next.keywords=keywords;changed=true;}
        let record=changed?VaultModel.update(current,next):{...current};
        for(const [column,key] of [['甲方','partyA'],['乙方','partyB'],['签约时间','signDate']])if(row[column]&&row[column]!==(current[key]||'')){record[key]=row[column];record.manualFieldsEditedAt=new Date().toISOString();changed=true;}
        for(const [column,key] of ENGAGEMENT_COLUMNS)if(row[column]&&row[column]!==(current[key]||'')){record[key]=row[column];changed=true;}
        if(changed){await Storage.updateContract(record);updated++;}else unchanged++;
      }else{
        const keywords=splitKeywords(row['原始关键词']);
        await Storage.addContract({id:row['合同ID']||Storage.generateId(),projectName:row['项目名称']||'',partyA:row['甲方']||'',partyB:row['乙方']||'',signDate:row['签约时间']||'',...Object.fromEntries(ENGAGEMENT_COLUMNS.map(([column,key])=>[key,row[column]||''])),amount:null,content:'',deliverables:'',sourceFile:row['来源文件']||'',rawText:'',uploadCategory:'other',importedFromExcel:true,manualFieldsEditedAt:new Date().toISOString(),createdAt:Date.now(),
          knowledgeProfile:{name:row['项目名称']||'',pic:row['PIC']||'',eic:row['EIC']||'',fic:row['FIC']||'',keywords,tagSchemaVersion:3}});
        added++;
      }
    }
    await loadContracts();updateStorageInfo();
    return {added,updated,unchanged};
  }
  // 合并到云盘总表：当前「我的合同」列表（含筛选）直接合并到系统设置中的总表，「上传者ID」由本机服务填写。
  function cloudMerge(){
    if(needDesktop())return;
    const list=listFiltered();
    if(!list.length){showToast('暂无合同可合并','warning');return;}
    showConfirm(`将 ${list.length} 份合同合并到云盘总表（按合同ID更新或追加，合并前自动备份）？`, async()=>{
      const button=document.getElementById('cloudMergeBtn');button.disabled=true;const label=button.textContent;button.textContent='正在合并…';
      try{const result=await (await excelPost('/api/excel/cloud-merge',{rows:excelRows(list)})).json();showToast(`已合并到云盘总表：新增 ${result.added} 行，更新 ${result.updated} 行，总表共 ${result.total} 行（${result.path}）`,'success');}
      catch(error){showToast('合并失败：'+error.message,'error');}
      finally{button.disabled=false;button.textContent=label;}
    });
  }
  async function loadUploader(){
    if(!NativeDocuments.available())return;
    const cfg=await NativeDocuments.request('/api/config');
    uploaderSelf=((cfg.uploader||{}).name||'').trim()||cfg.uploaderDefault||'';
    renderTable();
  }

  const ICON_VIEW='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_EDIT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const ICON_DELETE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  function deleteContract(id){
    showConfirm('确定删除该合同记录？', async () => {
      await Storage.deleteContract(id);
      await loadContracts();
      dropDeletedJobCards();
      updateStorageInfo();
      showToast('已删除', 'success');
    });
  }
  function renderTable() {
    const tbody = document.getElementById('contractTableBody');
    if (contracts.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="9">暂无合同数据，请先上传PDF文件</td></tr>`;
      return;
    }
    const filtered = listFiltered();
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="9">没有匹配的合同</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.map(c => `
      <tr data-id="${escapeHtml(c.id)}">
        <td>
          <div class="project-name" title="${escapeHtml(c.projectName || '未识别')}">${escapeHtml(c.projectName || '未识别项目')}</div>
        </td>
        <td>${escapeHtml(c.partyA || '-')}</td>
        <td>${escapeHtml(c.partyB || '-')}</td>
        <td>${escapeHtml(c.signDate || '-')}</td>
        ${listColumns(c)}
        <td>
          <div class="row-actions">
            <button class="row-action-btn" data-action="view" title="查看详情">${ICON_VIEW}</button>
            <button class="row-action-btn" data-action="edit" title="编辑合同信息、关键词、系统与标签">${ICON_EDIT}</button>
            <button class="row-action-btn danger" data-action="delete" title="删除">${ICON_DELETE}</button>
          </div>
        </td>
      </tr>`).join('');

    // 绑定行操作
    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.closest('tr').dataset.id, action = btn.dataset.action;
        if (action === 'view') openDetailModal(id);
        else if (action === 'edit') Vault.openEditor(id);
        else if (action === 'delete') deleteContract(id);
      });
    });

    // 双击行查看详情
    tbody.querySelectorAll('tr').forEach(row => {
      row.addEventListener('dblclick', () => {
        const id = row.dataset.id;
        if (id) openDetailModal(id);
      });
    });
  }

  // Short, traceable excerpts; retain the original OCR text for corrections.
  const businessClues = {
    ITGC: /ITGC|信息(?:系统|技术)一般控制|变更管理|逻辑访问管理|访问管理|运维管理/gi,
    ITAC: /ITAC|应用控制|自动化控制/gi,
    DATA_REVIEW: /数据核查|数据核验|业财一致性|准确性|完整性|金额差异|数据质量|核对/gi,
    IPO_RELATED: /IPO|首次公开发行|上市申报|首次上市|赴港上市/gi,
    SOC: /S[O0]C\s*[12]|Type\s*(?:II|I|2|1)|财务报告|运行有效性|鉴证/gi,
    ISO_PREPARATION: /ISO|认证准备|差距分析|辅导|培训/gi
  };
  function evidenceHtml(text, code) {
    const key = code.replace(/^SEM_/, '');
    const pattern = businessClues[key] || (key.includes('SOC') ? businessClues.SOC : null);
    if (!pattern) return escapeHtml(text);
    pattern.lastIndex = 0;
    let out = '', end = 0;
    for (const match of text.matchAll(pattern)) {
      out += escapeHtml(text.slice(end, match.index)) + '<mark>' + escapeHtml(match[0]) + '</mark>';
      end = match.index + match[0].length;
    }
    return out + escapeHtml(text.slice(end));
  }
  function cleanBusinessLabel(text) { return String(text).replace(/（[^）]*候选[^）]*）/g, '').replace(/候选/g, '').trim(); }
  function businessTagsHtml(contract, editable = false) {
    if(AnalysisResults.managed(contract)&&!AnalysisResults.ready(contract))return '<p>业务分析中，识别全文已可查看。</p>';
    const tags = BusinessIntent.forContract(contract);
    const reviews = contract.businessReview || {};
    return tags.length ? tags.map((tag, index) => {
      const review = reviews[tag.code] || {};
      const evidence = (tag.evidence || []).map((text, evidenceIndex) => {
        const sourceOffset = ContractScope.offsetOf(contract,text);
        const key = tag.code.replace(/^SEM_/, '');
        const pattern = businessClues[key] || (key.includes('SOC') ? businessClues.SOC : null);
        if (pattern) pattern.lastIndex = 0;
        const first = pattern ? pattern.exec(text) : null;
        const start = Math.max(0, (first?.index || 0) - 90);
        const excerpt = text.slice(start, start + 420);
        return `<div class="business-evidence"><p>依据 ${evidenceIndex + 1} · ${sourceOffset >= 0 ? '识别全文第 ' + (sourceOffset + start + 1) + ' 字起' : '业务描述片段'}</p><blockquote>${start ? '…' : ''}${evidenceHtml(DocumentView.readable(excerpt), tag.code)}${start + 420 < text.length ? '…' : ''}</blockquote>${sourceOffset >= 0 ? `<button class="btn btn-ghost btn-sm" type="button" data-evidence-contract="${escapeHtml(contract.id)}" data-offset="${sourceOffset + start}" data-length="${excerpt.length}">定位到识别全文</button>` : ''}</div>`;
      }).join('');
      return `<article class="business-card"><div class="business-card-title"><h4>${escapeHtml(cleanBusinessLabel(review.label || tag.label))}</h4><span class="review-status">${escapeHtml(review.status === '待复核' ? '已识别' : review.status || '已识别')}</span></div><p class="business-reason"><strong>为什么这样分类：</strong>${escapeHtml((tag.reason || '根据业务描述与分类主题匹配。').split('；')[0].replace(/；?不据此.*|；?不等于.*/, ''))}</p><p class="business-method">匹配方式：${tag.code.startsWith("SEM_") ? "业务描述语义匹配" : "合同名称或服务内容匹配"}</p><details class="business-evidence-list"><summary>查看原文依据（${(tag.evidence || []).length} 条）</summary>${evidence || '<p>暂无可定位依据，请人工查阅合同。</p>'}</details>${editable ? `<div class="business-review-editor" data-review-code="${escapeHtml(tag.code)}"><label>人工分类名称<input class="review-label" value="${escapeHtml(cleanBusinessLabel(review.label || tag.label))}"></label><label>复核结论<select class="review-status-input">${['已识别', '已确认', '不适用'].map(status => `<option ${review.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label><label class="review-note-label">分类复核笔记<textarea class="review-note" rows="3" placeholder="例如：本次范围包含 SAP 的访问、变更及运维管理。">${escapeHtml(review.note || '')}</textarea></label></div>` : `<p>${review.note ? '复核笔记：' + escapeHtml(review.note) : ''}</p><button class="btn btn-ghost btn-sm" type="button" data-review-contract="${escapeHtml(contract.id)}">编辑分类 / 添加笔记</button>`}</article>`;
    }).join('') : '<p>未发现足够业务线索，请查阅服务范围；可在合同详情的复核笔记中记录人工判断。</p>';
  }
  function bindBusinessActions(container) {
    container.querySelectorAll('[data-review-contract]').forEach(button => button.onclick = () => {
      openDetailModal(button.dataset.reviewContract);
      document.getElementById('classificationReviewSection')?.scrollIntoView({ block: 'start' });
    });
    container.querySelectorAll('[data-evidence-contract]').forEach(button => button.onclick = () => {
      if (container.id !== 'detailBody') openDetailModal(button.dataset.evidenceContract);
      const preview = document.getElementById('rawTextPreview');
      if (!preview || document.getElementById('rawTextEditorPanel').hidden === false) return;
      const contract = contracts.find(c => c.id === button.dataset.evidenceContract);
      const start = Number(button.dataset.offset), end = start + Number(button.dataset.length);
      const raw = contract.rawText || '';
      preview.hidden = false; document.getElementById('originalPreviewPanel').hidden = true;
      document.getElementById('documentViewStatus').textContent = '原文定位';
      document.getElementById('documentCompare').classList.remove('document-comparison');
      preview.innerHTML = '<div class="source-location-text">' + escapeHtml(raw.slice(0, start)) + '<mark id="locatedEvidence">' + escapeHtml(raw.slice(start, end)) + '</mark>' + escapeHtml(raw.slice(end)) + '</div>';
      document.getElementById('locatedEvidence').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
  function pageAuditRows(contract) {
    if (contract.pageAudit?.length) return contract.pageAudit;
    return (contract.layoutPages || []).map((page, index) => ({page:index+1, characters:(page.lines || []).reduce((n,l)=>n+String(l.text || '').replace(/\s/g,'').length,0), lines:(page.lines || []).length, lowScoreLines:null, state:'原页图像未检查', retried:false}));
  }
  function renderPageAudit(contract) {
    const rows = pageAuditRows(contract), checks = contract.pageChecks || {};
    if (!rows.length) return '<div class="detail-section"><h4>逐页完整性检查</h4><p>此记录没有逐页数据，重新识别后可生成。</p></div>';
    return `<div class="detail-section page-audit"><h4>逐页完整性检查 <button class="btn btn-ghost btn-sm" type="button" id="exportPageAudit">导出检查表</button></h4><p>文件 ${Number(contract.pageCount || rows.length)} 页 · 已记录 ${rows.length} 页。${contract.processingSeconds!=null?' 本次处理 '+Number(contract.processingSeconds).toFixed(1)+' 秒；复用 '+Number(contract.resumedPages||0)+' 页；进程峰值 '+(contract.peakWorkerMemoryMB??'—')+' MB。':''}${contract.rawTextEditedAt ? '下表保留原始识别页数据。' : ''}未覆盖图文可能包括印章、图片或文字；检查表用于定位页面，不代表准确率。</p><div class="page-audit-table"><table><thead><tr><th>页</th><th>字数 / 行数</th><th>页面情况</th><th>低分行 / 秒</th><th>对照记录</th><th>操作</th></tr></thead><tbody>${rows.map(row=>`<tr data-page-check="${row.page}"><td>${row.page}</td><td>${row.characters} / ${row.lines}</td><td>${escapeHtml(row.state)}${row.smallTextCrops ? ' · 局部补识别 '+row.smallTextCrops+' 处 / 新增 '+row.supplementedLines+' 行' : ''}${row.alternativeLines ? ' · 有不同识别结果 '+row.alternativeLines+' 处' : ''}${row.cropLimitReached ? ' · 部分小字区域未补识别' : ''}${row.readingOrder ? ' · '+row.readingOrder : ''}${row.alignedRows ? ' · 对齐行 '+row.alignedRows : ''}${row.retried ? ' · 已精细重试' : ''}</td><td>${row.lowScoreLines ?? '—'} / ${row.seconds??'—'}${row.fromCheckpoint?' · 复用':''}</td><td><select class="page-check-status">${['未记录','正常','发现遗漏','已修正'].map(status=>`<option ${checks[row.page]?.status===status?'selected':''}>${status}</option>`).join('')}</select><input class="page-check-note" placeholder="遗漏位置或检查笔记" value="${escapeHtml(checks[row.page]?.note || '')}"></td><td><button class="btn btn-ghost btn-sm" type="button" data-audit-page="${row.page}">对照原页</button></td></tr>`).join('')}</tbody></table></div><button class="btn btn-primary btn-sm" id="savePageChecks" type="button">保存逐页记录</button><span id="pageAuditSaveState" role="status"></span>${(contract.layoutPages||[]).filter(page=>(page.lines||[]).some(line=>line.alternatives?.length)).map(page=>`<details><summary>第 ${page.page} 页：不同识别结果</summary>${page.lines.filter(line=>line.alternatives?.length).map(line=>`<p>保留原文：${escapeHtml(line.text)}<br>局部识别：${line.alternatives.map(escapeHtml).join(" / ")}</p>`).join("")}<button class="btn btn-ghost btn-sm" type="button" data-audit-page="${page.page}">对照原页</button></details>`).join("")}</div>`;
  }
  function renderCriticalReview(contract){
    const items=CriticalReview.extract(contract),checks=contract.criticalChecks||{};
    return `<div class="detail-section page-audit"><h4>关键内容检查 <button class="btn btn-ghost btn-sm" id="exportCriticalReview" type="button">导出关键内容</button></h4><p>保留原文中的金额、日期、SOC类型、业务名称和否定表达。点击原文定位核对；人工记录不会改写合同。</p><details><summary>查看 ${items.length} 处关键内容</summary><div class="page-audit-table"><table><thead><tr><th>类别 / 页</th><th>识别原文</th><th>对照记录</th><th>操作</th></tr></thead><tbody>${items.map(item=>`<tr data-critical-id="${escapeHtml(item.id)}"><td>${escapeHtml(item.kind)} / ${item.page||'文字定位'}</td><td>${escapeHtml(item.value)}${item.issues?.length?'<p class="critical-issue">'+escapeHtml(item.issues.join('；'))+'</p>':''}<p>${escapeHtml(DocumentView.readable(item.evidence))}</p></td><td><select class="critical-status">${['未记录','一致','存在错误','已修正'].map(status=>`<option ${checks[item.id]?.status===status?'selected':''}>${status}</option>`).join('')}</select><input class="critical-note page-check-note" value="${escapeHtml(checks[item.id]?.note||'')}" placeholder="记录原件正确内容"></td><td><button class="btn btn-ghost btn-sm" type="button" data-evidence-contract="${escapeHtml(contract.id)}" data-offset="${item.offset}" data-length="${item.value.length}">原文定位</button>${item.page?`<button class="btn btn-ghost btn-sm" type="button" data-audit-page="${item.page}">对照原页</button>`:''}</td></tr>`).join('')}</tbody></table></div></details><button class="btn btn-primary btn-sm" id="saveCriticalReview" type="button">保存关键内容记录</button><span id="criticalSaveState" role="status"></span>${contract.criticalReviewHistory?.length?`<details><summary>全文修改前的核对记录</summary>${contract.criticalReviewHistory.map(entry=>entry.items.filter(item=>item.check.note||item.check.status!=="未记录").map(item=>`<p>${escapeHtml(item.kind)}：${escapeHtml(item.value)} · ${escapeHtml(item.check.status)}<br>${escapeHtml(item.check.note||"")}</p>`).join("")).join("")}</details>`:""}</div>`;
  }
  function renderServiceProfile(contract){
    if(AnalysisResults.managed(contract)&&!AnalysisResults.ready(contract))return '';
    const content=AnalysisResults.get(contract,'content',()=>ServiceContent.analyze(ContractScope.textFor(contract)));
    const labels=key=>[...new Set(content[key].map(item=>item.label))];
    const groups=[['goals','客户目标'],['services','实际服务活动'],['domains','服务领域'],['standards','标准与框架'],['training','培训内容'],['topics','相关控制与隐私主题'],['personnel','人员资质与经验'],['commercial','商务与数据使用约定'],['boundaries','服务边界'],['deliverables','交付成果']];
    return `<div class="service-profile"><h4>服务内容画像</h4><p>涉及系统：${escapeHtml(labels('systems').join('、')||'未提及')} · 客户行业：${escapeHtml(labels('industry').join('、')||'未提及')}</p>${groups.filter(([key])=>key!=='commercial').map(([key,label])=>{const values=labels(key);return key==='services'?`<p><strong>${label}：</strong>${values.length?values.map(value=>`<span class="service-topic">${escapeHtml(value)}</span>`).join(''):'未提取'}</p>`:values.length?`<details><summary>${label}（${values.length}）</summary><div class="profile-items">${content[key].filter((item,index,all)=>all.findIndex(x=>x.label===item.label)===index).map(item=>`<p><strong>${escapeHtml(item.label)}${item.status?' · '+escapeHtml(item.status):''}</strong></p>${String(item.label).replace(/\s/g,'')===String(item.evidence).replace(/\s/g,'')?'':`<p class="profile-evidence">${escapeHtml(DocumentView.readable(item.evidence))}</p>`}`).join('')}</div></details>`:'';}).join('')}</div>`;
  }
  function renderAuditReview(contract) {
    const fields = AuditReview.forContract(contract).filter(field => field.key !== 'purpose');
    return `<div class="detail-section audit-review" id="classificationReviewSection"><h4>业务内容归类</h4>${typeof NativeDocuments !== 'undefined' && NativeDocuments.available() ? '<button class="btn btn-ghost btn-sm" id="reanalyseBusiness" type="button">重新分析业务含义</button>' : ''}<div class="classification-tree">${businessTagsHtml(contract, true)}</div>
      <div class="contract-notes"><label for="contractReviewNotes">合同笔记</label><textarea id="contractReviewNotes" rows="4" placeholder="记录合同要点和工作笔记。">${escapeHtml(contract.reviewerNotes || '')}</textarea><p>笔记单独保存，不参与识别。</p><button class="btn btn-primary btn-sm" type="button" id="saveBusinessReview">保存摘要、分类与笔记</button><span id="businessReviewSaveState" role="status"></span></div>
      <h4>合同条款</h4><div class="clause-tree">${fields.map(field => `<details class="audit-review-item"><summary>${escapeHtml(field.label)}</summary><div class="clause-body"><p>${escapeHtml(field.question)}</p>${field.evidence.length ? field.evidence.map(e => `<blockquote>${DocumentView.paragraphs(e.text)}</blockquote><button class="btn btn-ghost btn-sm" type="button" data-evidence-contract="${escapeHtml(contract.id)}" data-offset="${e.start}" data-length="${e.end-e.start}">定位到识别全文</button>`).join('') : '<p>无对应条款</p>'}</div></details>`).join('')}</div>
    </div>`;
  }

  function renderBusinessKeywordTags(contract) {
    if(AnalysisResults.managed(contract)&&!AnalysisResults.ready(contract))return '<div id="businessKeywordTags" class="detail-section business-keyword-tags"><h4>业务关键词与标签</h4><p>业务分析中，识别全文已可查看。</p><button type="button" id="editContractTags" hidden>编辑合同信息</button></div>';
    const profile=VaultModel.project(contract),facts=AnalysisResults.get(contract,'facts',()=>ContractFacts.analyze(ContractScope.textFor(contract))),raw=contract.rawText||'';
    const evidence=(items,value)=>items.find(item=>item.label===value)?.evidence||'';
    const row=(key,label,values,find)=>({key,label,items:[...new Set(values.filter(Boolean))].map(value=>({value,evidence:find(value)}))});
    const groups=[
      row('domains','服务领域',profile.services,v=>evidence(profile.analysis.serviceDomains,v)),
      row('specific','具体服务',profile.specificTags,v=>evidence(profile.analysis.services,v)),
      row('industry','客户行业',[profile.industry.filter(Boolean).join(' › ')],()=>profile.industry.filter(Boolean).join('/')===facts.industry.join('/')?facts.evidence.industry||'':''),
      row('enterprise','企业特征',[profile.enterpriseSize&&'规模：'+profile.enterpriseSize,profile.businessModel&&'模式：'+profile.businessModel],v=>v==='规模：'+facts.enterpriseSize?facts.evidence.enterpriseSize||'':v==='模式：'+facts.businessModel?facts.evidence.businessModel||'':''),
      row('needs','客户诉求',profile.needTags||[],v=>facts.evidence['need:'+v]||''),
      row('systems','系统 / 技术',profile.systems,v=>evidence(profile.analysis.systems,v))
    ];
    if(profile.customTags.length)groups.push(row('custom','自定义标签',profile.customTags,()=>''));
    const count=groups.reduce((sum,g)=>sum+g.items.length,0);
    const scope=ContractScope.resolve(contract);return `<div class="analysis-scope-note ${scope.status==='missing'||scope.status==='empty'?'missing':''}">${escapeHtml((ContractScope.category(contract)==='ey-template'?'安永模板类 · ':'')+scope.label)}</div><div class="detail-section business-keyword-tags" id="businessKeywordTags"><h4 class="summary-heading">业务关键词与标签（${count} 个）<button class="btn btn-ghost btn-sm" type="button" id="editContractTags">编辑合同信息</button></h4><div class="business-tag-groups">${groups.map(g=>`<div class="business-tag-row tags-${g.key}" data-business-tag-group="${g.key}"><span class="business-tag-label">${g.label}</span><div class="list-kws">${g.items.length?g.items.map(item=>{const start=item.evidence?ContractScope.offsetOf(contract,item.evidence):-1;return start>=0?`<button type="button" class="kw-chip business-tag-chip" data-evidence-contract="${escapeHtml(contract.id)}" data-offset="${start}" data-length="${item.evidence.length}" title="${escapeHtml('定位到原文：'+item.evidence)}">${escapeHtml(item.value)}</button>`:`<span class="kw-chip business-tag-chip" title="人工补充，可在标签管理编辑">${escapeHtml(item.value)}</span>`;}).join(''):'<span class="list-kw-empty">—</span>'}</div></div>`).join('')}</div></div>`;
  }

  // ============== 详情模态框 ==============
  function openDetailModal(id, scrollToText) {
    const contract = contracts.find(c => c.id === id);
    if (!contract) return;

    if (reviewDraft?.saving) return;
    if (reviewDraft && reviewDraft.dirty() && !confirm('分类或笔记尚未保存，是否放弃修改？')) return;
    reviewDraft = null;
    DocumentView.release();
    const body = document.getElementById('detailBody');
    body.innerHTML = `
      <div class="detail-section">
        <div class="analysis-toolbar"><span id="analysisState" data-contract-id="${escapeHtml(contract.id)}">${escapeHtml(analysisLabel(contract))}</span><span class="analysis-timing">OCR${contract.ocrModel?'（'+escapeHtml(contract.ocrModel)+'）':''} ${Number(contract.processingSeconds??contract.elapsedSeconds??0).toFixed(1)} 秒 · 规则分析 ${contract.ruleAnalysisSeconds!=null?Number(contract.ruleAnalysisSeconds).toFixed(1)+' 秒':'—'} · 语义任务 ${contract.analysisSeconds!=null?Number(contract.analysisSeconds).toFixed(1)+' 秒':'—'}</span><button type="button" id="reanalyzeBusiness" class="btn btn-ghost btn-sm">重新分析（无需 OCR）</button></div>
        <h4>基本信息</h4>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">项目名称</div>
            <div class="detail-value">${escapeHtml(contract.projectName || '未识别')}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">签约金额</div>
            <div class="detail-value amount">${contract.amount > 0 ? formatMoney(contract.amount) : '未识别'}</div>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h4>签约主体</h4>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">甲方（委托方）</div>
            <div class="detail-value">${escapeHtml(contract.partyA || '未识别')}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">乙方（受托方）</div>
            <div class="detail-value">${escapeHtml(contract.partyB || '未识别')}</div>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h4>项目信息</h4>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">签约时间</div>
            <div class="detail-value">${escapeHtml(contract.signDate || '未识别')}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">源文件</div>
            <div class="detail-value">${escapeHtml(contract.sourceFile || '-')}</div>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h4 class="summary-heading">服务摘要 <button class="btn btn-ghost btn-sm" type="button" id="editServiceSummary">编辑摘要</button></h4>
        <div class="service-summary" id="serviceSummaryPreview">${DocumentView.paragraphs(AuditReview.summaryFor(contract).text)}</div>
        ${renderServiceProfile(contract)}
        <div id="serviceSummaryPanel" hidden><label for="serviceSummaryEditor">服务目标、工作内容与交付成果</label><textarea id="serviceSummaryEditor" rows="6">${escapeHtml(AuditReview.summaryFor(contract).text)}</textarea><p>编辑完成后点击“保存摘要、分类与笔记”。</p></div>
      </div>

      <div class="detail-section">
        <h4>交付物</h4>
        <div class="detail-text-block">${DocumentView.paragraphs(contract.deliverables || '未提取交付成果')}</div>
      </div>

      ${renderAuditReview(contract)}

      ${renderBusinessKeywordTags(contract)}

      <div class="detail-section" id="rawTextSection">
        <h4 style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span>识别全文${contract.rawTextEditedAt ? "（已修正）" : ""}</span>
          <span style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" id="editRawText" type="button">编辑全文</button>
            <button class="btn btn-ghost btn-sm" id="copyRawText" type="button">复制</button>
            <button class="btn btn-ghost btn-sm" id="downloadRawText" type="button">下载 TXT</button>
          </span>
        </h4>
        <div class="document-toolbar"><button class="btn btn-ghost btn-sm" id="showReadingLayout" type="button">按页排版</button><button class="btn btn-ghost btn-sm" id="showOriginal" type="button">原文件版式</button><button class="btn btn-ghost btn-sm" id="chooseOriginal" type="button">选择原文件</button><input id="originalFileInput" type="file" accept=".pdf,.png,.jpg,.jpeg" hidden><span id="documentViewStatus" role="status"></span></div>
        <div id="documentCompare"><div id="rawTextPreview" class="detail-text-block raw-text-block document-reading">${DocumentView.render(contract)}</div>
        <div id="originalPreviewPanel" hidden></div></div>
        <div id="rawTextEditorPanel" hidden>
          <label for="rawTextEditor">对照原件修正全文，保存后更新业务标签。文字修正保留原页位置，新增段落保留输入的换行与缩进。</label>
          <textarea id="rawTextEditor" class="raw-text-editor" spellcheck="false"></textarea>
          <p>仅修正识别文字，原始 PDF 不变；金额、甲乙方等结构化字段请使用合同“编辑”功能修改。</p>
          <button class="btn btn-primary btn-sm" id="saveRawText" type="button">保存并更新业务标签</button>
          <button class="btn btn-ghost btn-sm" id="cancelRawText" type="button">取消</button>
        </div>
      </div>
    `;

    bindBusinessActions(body);
    document.getElementById('reanalyzeBusiness').addEventListener('click',async e=>{
      if(fullTextDraft||reviewDraft?.dirty()){showToast('请先保存文字或笔记，再重新分析','warning');return;}
      const button=e.currentTarget;button.disabled=true;
      try{
        if(NativeDocuments.available()){
          await NativeDocuments.request('/api/analysis',{method:'POST',headers:{...NativeDocuments.headers(),'Content-Type':'application/json'},body:JSON.stringify({id:contract.id,force:true})});
          await loadContracts();const latest=contracts.find(c=>c.id===contract.id);document.getElementById('analysisState').textContent=analysisLabel(latest||contract);if(latest?.analysisStatus==='done')openDetailModal(latest.id);watchAnalysis();
        }else{openDetailModal(contract.id);showToast('已根据保存的文字更新业务分析','success');}
      }catch(error){showToast(error.message,'error');}finally{button.disabled=false;}
    });
    document.getElementById('editContractTags').onclick=()=>{if(!closeModals())return;Vault.openEditor(id);};
    const initialSummary = AuditReview.summaryFor(contract).text;
    const readReview = () => ({
      businessReview: { ...contract.businessReview, ...Object.fromEntries([...body.querySelectorAll('[data-review-code]')].map(row => [row.dataset.reviewCode, {
        label: row.querySelector('.review-label').value.trim(),
        status: row.querySelector('.review-status-input').value,
        note: row.querySelector('.review-note').value
      }])) },
      criticalChecks: {...contract.criticalChecks,...Object.fromEntries([...body.querySelectorAll('[data-critical-id]')].map(row=>[row.dataset.criticalId,{status:row.querySelector('.critical-status').value,note:row.querySelector('.critical-note').value}]))},
      pageChecks: {...contract.pageChecks, ...Object.fromEntries([...body.querySelectorAll('[data-page-check]')].map(row=>[row.dataset.pageCheck,{status:row.querySelector('.page-check-status').value,note:row.querySelector('.page-check-note').value}]))},
      reviewerNotes: document.getElementById('contractReviewNotes').value,
      serviceSummary: !contract.serviceSummary && document.getElementById('serviceSummaryEditor').value === initialSummary ? '' : document.getElementById('serviceSummaryEditor').value
    });
    document.getElementById('editServiceSummary').onclick = () => {
      document.getElementById('serviceSummaryPanel').hidden = false;
      document.getElementById('serviceSummaryPreview').hidden = true;
      document.getElementById('serviceSummaryEditor').focus();
    };
    let savedReview = JSON.stringify(readReview());
    reviewDraft = { dirty: () => JSON.stringify(readReview()) !== savedReview, saving: false };
    document.getElementById('saveBusinessReview').onclick = async () => {
      const button = document.getElementById('saveBusinessReview');
      const draft = reviewDraft;
      if (draft.saving) return;
      draft.saving = true; button.disabled = true;
      const value = readReview();
      try {
        const index = contracts.findIndex(c => c.id === id);
        const updated = { ...contracts[index], ...value, businessReviewEditedAt: Date.now(), businessReviewNeedsReview: false };
        await Storage.updateContract(updated);
        contracts[index] = updated;
        savedReview = JSON.stringify(value);
        document.getElementById('businessReviewSaveState').textContent = ' 已保存到本地';
        if(document.getElementById('criticalSaveState')) document.getElementById('criticalSaveState').textContent=' 已保存到本地';
        if(document.getElementById('pageAuditSaveState')) document.getElementById('pageAuditSaveState').textContent=' 已保存到本地';
        body.querySelectorAll('[data-review-code]').forEach(row => {
          const review = value.businessReview[row.dataset.reviewCode];
          const card = row.closest('.business-card');
          card.querySelector('h4').textContent = review.label;
          card.querySelector('.review-status').textContent = review.status;
        });
        document.getElementById('serviceSummaryPreview').innerHTML = DocumentView.paragraphs(AuditReview.summaryFor(updated).text);
        document.getElementById('serviceSummaryPreview').hidden = false;
        document.getElementById('serviceSummaryPanel').hidden = true;
        updateStorageInfo();
      } catch (error) { showToast('保存失败，笔记仍保留在编辑框：' + error.message, 'error'); }
      finally { draft.saving = false; button.disabled = false; }
    };
    body.querySelectorAll('.business-review-editor input, .business-review-editor textarea, .business-review-editor select, #contractReviewNotes, #serviceSummaryEditor, .critical-status, .critical-note, .page-check-status, .page-check-note').forEach(input => input.addEventListener('input', () => {
      document.getElementById('businessReviewSaveState').textContent = ' 有未保存修改';
    }));
    fullTextDraft = null;
    const raw = contract.rawText || '';
    const preview = document.getElementById('rawTextPreview');
    const originalPanel = document.getElementById('originalPreviewPanel');
    const viewStatus = document.getElementById('documentViewStatus');
    document.getElementById('showReadingLayout').onclick = () => {
      document.getElementById('documentCompare').classList.remove('document-comparison');
      preview.innerHTML = DocumentView.render(contract); preview.hidden = false; originalPanel.hidden = true;
      DocumentView.fit(preview); viewStatus.textContent = DocumentView.layoutFor(contract).length ? '按文字坐标排版' : '阅读排版（此记录无文字坐标，重新识别后可按页排版）';
    };
    let originalSource = null;
    const showOriginal = async (selectedFile, pageNumber=1, compare=false) => {
      const button = document.getElementById('showOriginal'); button.disabled = true; viewStatus.textContent = '正在打开原文件…';
      try {
        const source = selectedFile ? await DocumentView.source(contract, selectedFile) : originalSource || await DocumentView.source(contract);
        originalSource = source;
        if (selectedFile) DocumentView.remember(id, selectedFile);
        originalPanel.innerHTML = source.image ? `<img alt="合同原件" src="${source.url}">` : `<iframe title="合同原件" src="${source.url}#page=${pageNumber}"></iframe>`;
        originalPanel.hidden = false; preview.hidden = !compare;
        document.getElementById('documentCompare').classList.toggle('document-comparison',compare);
        if(compare) { preview.innerHTML=DocumentView.render(contract); DocumentView.fit(preview); document.getElementById('ocr-page-'+pageNumber)?.scrollIntoView({block:'nearest'}); }
        viewStatus.textContent = compare ? '第 '+pageNumber+' 页原件对照' : '原文件版式';
      } catch (error) { viewStatus.textContent = error.message; }
      finally { button.disabled = false; }
    };
    body.querySelectorAll('[data-audit-page]').forEach(button=>button.onclick=()=>{if(fullTextDraft){showToast('请先保存或取消全文编辑，再对照原页','warning');return;}showOriginal(undefined,Number(button.dataset.auditPage),true);});
    const criticalSave=document.getElementById('saveCriticalReview');
    if(criticalSave) criticalSave.onclick=()=>document.getElementById('saveBusinessReview').click();
    const criticalExport=document.getElementById('exportCriticalReview');
    if(criticalExport) criticalExport.onclick=()=>{
      const checks=readReview().criticalChecks;
      const q=value=>'"'+String(value??'').replace(/"/g,'""').replace(/^([\s]*[=+@-])/ ,"'$1")+'"';
      const rows=[['文件','类别','页码','原文值','依据','对照记录','笔记'],...CriticalReview.extract(contract).map(item=>[contract.sourceFile,item.kind,item.page,item.value,item.evidence,checks[item.id]?.status,checks[item.id]?.note])];
      downloadFile('\ufeff'+rows.map(row=>row.map(q).join(',')).join('\r\n'),'关键内容检查.csv','text/csv;charset=utf-8');
    };
    const pageSave = document.getElementById('savePageChecks');
    if(pageSave) pageSave.onclick=()=>document.getElementById('saveBusinessReview').click();
    const exportAudit = document.getElementById('exportPageAudit');
    if(exportAudit) exportAudit.onclick=()=>{
      const checks=readReview().pageChecks;
      const cell=value=>'"'+String(value??'').replace(/"/g,'""').replace(/^([\s]*[=+@-])/ ,"'$1")+'"';
      const rows=[['来源文件','页码','字符数','行数','页面情况','低分行','精细重试','对照记录','笔记','处理秒数','复用断点','进程峰值MB'],...pageAuditRows(contract).map(row=>[contract.sourceFile,row.page,row.characters,row.lines,row.state,row.lowScoreLines,row.retried?'是':'否',checks[row.page]?.status,checks[row.page]?.note,row.seconds,row.fromCheckpoint?'是':'否',contract.peakWorkerMemoryMB])];
      downloadFile('\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n'),'逐页完整性检查.csv','text/csv;charset=utf-8');
    };
    document.getElementById('showOriginal').onclick = () => showOriginal();
    document.getElementById('chooseOriginal').onclick = () => document.getElementById('originalFileInput').click();
    document.getElementById('originalFileInput').onchange = event => { if (event.target.files[0]) showOriginal(event.target.files[0]); };
    requestAnimationFrame(() => DocumentView.fit(preview));
    const editor = document.getElementById('rawTextEditor');
    const setEditing = editing => {
      document.getElementById('rawTextEditorPanel').hidden = !editing;
      document.getElementById('rawTextPreview').hidden = editing;
      originalPanel.hidden = true;
      document.getElementById('documentCompare').classList.remove('document-comparison');
      document.querySelector('.document-toolbar').hidden = editing;
      for (const buttonId of ['editRawText', 'copyRawText', 'downloadRawText']) {
        document.getElementById(buttonId).hidden = editing;
      }
    };
    document.getElementById('editRawText').onclick = () => {
      if (reviewDraft?.dirty() || reviewDraft?.saving) { showToast('请先保存分类与笔记，再修正全文', 'warning'); return; }
      editor.value = contract.rawText || '';
      fullTextDraft = { id, original: editor.value, editor, saving: false };
      setEditing(true);
      editor.focus();
    };
    document.getElementById('cancelRawText').onclick = () => {
      if (fullTextDraft && fullTextDraft.saving) return;
      fullTextDraft = null;
      setEditing(false);
    };
    document.getElementById('saveRawText').onclick = async () => {
      if (reviewDraft?.dirty() || reviewDraft?.saving) { showToast('请先保存分类与笔记，再保存全文修正', 'warning'); return; }
      if (!fullTextDraft || fullTextDraft.saving) return;
      if (!editor.value.trim()) { showToast('全文不能为空，请保留需分析的合同文字', 'warning'); return; }
      const draft = fullTextDraft;
      draft.saving = true;
      document.getElementById('saveRawText').disabled = true;
      document.getElementById('cancelRawText').disabled = true;
      try {
        await persistFullText(id, editor.value);
      } catch (error) {
        draft.saving = false;
        document.getElementById('saveRawText').disabled = false;
        document.getElementById('cancelRawText').disabled = false;
        showToast('保存失败，修改仍保留在编辑框中：' + error.message, 'error');
        return;
      }
      fullTextDraft = null;
      openDetailModal(id, true);
      refreshVisibleVault();renderTable();
      updateStorageInfo();
      showToast('全文已保存，业务关键词与标签已更新', 'success');
    };
    const copyBtn = document.getElementById('copyRawText');
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(raw);
      } catch (e) {
        const ta = document.createElement('textarea'); ta.value = raw; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); ta.remove();
      }
      showToast('已复制全文', 'success');
    };
    document.getElementById('downloadRawText').onclick = () => {
      const base = (contract.sourceFile || 'contract').replace(/\.[^.]+$/, '');
      downloadFile('\ufeff' + raw, base + '_识别全文.txt', 'text/plain;charset=utf-8');
    };
    if (scrollToText) setTimeout(() => document.getElementById('rawTextSection').scrollIntoView({ block: 'start' }), 50);

    const reanalyse=document.getElementById('reanalyseBusiness');
    if(reanalyse)reanalyse.onclick=()=>document.getElementById('reanalyzeBusiness').click();
    document.getElementById('detailModal').hidden = false;
  }

  // Persist first: a failed IndexedDB write must not change the analysis source.
  async function persistFullText(id, text) {
    if (!text.trim()) throw new Error('全文不能为空');
    const index = contracts.findIndex(c => c.id === id);
    if (index < 0) throw new Error('合同已不存在，请刷新列表');
    const existing = contracts[index];
    if(text===existing.rawText)return existing;
    const updated = {
      ...existing,
      ...DocumentView.prepareEdit(existing,text),
      originalRawText: existing.originalRawText ?? existing.rawText ?? '',
      rawText: text,
      rawTextEditedAt: Date.now(),
      criticalReviewHistory: [...(existing.criticalReviewHistory||[]), ...(Object.keys(existing.criticalChecks||{}).length ? [{at:Date.now(),items:CriticalReview.extract(existing).filter(item=>existing.criticalChecks[item.id]).map(item=>({...item,check:existing.criticalChecks[item.id]}))}] : [])],
      criticalChecks: {},
      pageChecks: Object.fromEntries(Object.entries(existing.pageChecks || {}).map(([page,check])=>[page,{...check,status:'未记录'}])),
      businessReviewNeedsReview: !!existing.businessReviewEditedAt,
      businessReview: Object.fromEntries(Object.entries(existing.businessReview || {}).map(([code, review]) => [code, { ...review, status: '已识别' }])),
      auditPurposeNeedsReview: !!existing.auditPurpose
    };
    updated.semanticTags=[];updated.analysisStatus=NativeDocuments.available()?'queued':'done';
    const saved=await Storage.updateContract(updated);
    contracts[index] = saved;
    watchAnalysis();
    return saved;
  }

  // ============== 模态框控制 ==============
  function closeModals() {
    if (reviewDraft?.saving) return false;
    if (reviewDraft?.dirty() && !confirm('分类或笔记尚未保存，是否放弃修改并关闭？')) return false;
    if (fullTextDraft) {
      if (fullTextDraft.saving) return false;
      if (fullTextDraft.editor.value !== fullTextDraft.original && !confirm('全文修改尚未保存，是否放弃修改并关闭？')) return false;
      fullTextDraft = null;
    }
    reviewDraft = null;
    DocumentView.release();
    document.getElementById('detailModal').hidden = true;
    currentEditingId = null;
    return true;
  }

  // ============== 数据导出/导入 ==============
  async function exportCompleteBackup(){
    const button=document.getElementById('exportBackupBtn');button.disabled=true;
    try {
      const response=await fetch('/api/backup',{method:'POST',headers:NativeDocuments.headers()});
      if(!response.ok)throw Error('备份生成失败');
      downloadFile(await response.blob(),'ContractOCR_完整备份_'+getDateStr()+'.zip','application/zip');
      showToast('已导出已保存记录、笔记和可用原件；备份清单列出缺失原件','success');
    }catch(error){showToast(error.message,'error');}finally{button.disabled=false;}
  }
  async function exportJSON() {
    if (contracts.length === 0) {
      showToast('暂无数据可导出', 'warning');
      return;
    }
    const json = await Storage.exportToJSON();
    downloadFile(json, `contracts_${getDateStr()}.json`, 'application/json');
    showToast(`已导出 ${contracts.length} 条数据`, 'success');
  }

  async function exportCSV() {
    if (contracts.length === 0) {
      showToast('暂无数据可导出', 'warning');
      return;
    }
    const csv = await Storage.exportToCSV();
    // 添加 UTF-8 BOM，让 Excel 正确识别中文
    const bom = '\uFEFF';
    downloadFile(bom + csv, `contracts_${getDateStr()}.csv`, 'text/csv;charset=utf-8');
    showToast(`已导出 ${contracts.length} 条数据`, 'success');
  }

  async function exportAuditCSV() {
    if (!contracts.length) { showToast('暂无合同可导出', 'warning'); return; }
    downloadFile('\ufeff' + AuditReview.toCSV(contracts), `audit_contracts_${getDateStr()}.csv`, 'text/csv;charset=utf-8');
    showToast('已导出摘要、合同条款与笔记，可用 Excel 打开', 'success');
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const count = await Storage.importFromJSON(text);
      await loadContracts();
      updateStorageInfo();
      showToast(`成功导入 ${count} 条数据`, 'success');
    } catch (err) {
      showToast('导入失败: ' + err.message, 'error');
    }
    e.target.value = '';
  }

  function downloadSample() {
    // 创建一个示例 PDF（简单的文本内容）
    const sampleText = `技术开发合同

合同编号：HT-2024-001
项目名称：智慧园区管理系统开发项目
签订日期：2024年3月15日

甲方（委托方）：北京华盛科技有限公司
统一社会信用代码：91110108MA01ABCDXX
地址：北京市海淀区中关村大街1号

乙方（受托方）：上海智远软件股份有限公司
统一社会信用代码：91310000MA1FXXXXXX
地址：上海市浦东新区张江高科技园区

鉴于甲方希望委托乙方开发智慧园区管理系统软件，乙方愿意接受委托，
根据《中华人民共和国合同法》及相关法律法规的规定，双方经友好协商，
一致同意按下述条款签订本合同，共同遵守。

第一条 项目工作内容概述
乙方负责为甲方开发一套完整的智慧园区管理系统，包括但不限于：
1. 园区安防监控集成模块
2. 设备运维管理模块
3. 物业收费管理模块
4. 业主服务APP（iOS/Android）
5. 数据大屏可视化展示
6. 系统部署与运维培训

第二条 合同金额
本合同总金额为人民币壹佰贰拾万元整（¥1,200,000.00元），
包含软件开发费、部署调试费及一年期运维服务费。

第三条 项目交付物
1. 完整源代码及技术文档
2. 系统部署手册与运维指南
3. 用户操作手册
4. 系统原型设计稿
5. 测试报告与验收文档
6. 一年期免费运维服务

第四条 履行期限
本合同自签订之日起生效，项目开发周期为6个月，2024年9月15日前完成交付。

甲方（盖章）：北京华盛科技有限公司
乙方（盖章）：上海智远软件股份有限公司

签订日期：2024年3月15日
`;

    // 直接下载为 txt 演示，实际下载示例合同PDF会更复杂
    const blob = new Blob([sampleText], { type: 'text/plain;charset=utf-8' });
    downloadFile(blob, '示例合同文本_可转换为PDF后上传.txt', 'text/plain');
    showToast('已下载示例文本，转PDF后可上传测试', 'success');
  }

  function downloadFile(content, filename, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getDateStr() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // Business path and uploader identity remain available without a system-settings page.
  async function loadCloudConfig() {
    try {
      if(NativeDocuments.available()){
        await loadUploader();
      }
    }catch(error){showToast('云盘业务配置加载失败：'+error.message,'error');}
  }

  // ============== 工具函数 ==============
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  function formatMoney(num) {
    if (!num || num === 0) return '¥0';
    if (num >= 100000000) return '¥' + (num / 100000000).toFixed(2) + '亿';
    if (num >= 10000) return '¥' + (num / 10000).toFixed(2) + '万';
    return '¥' + num.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  // ============== Toast & Confirm ==============
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = {
      success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
      error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    toast.innerHTML = `${icons[type] || icons.info}<span class="toast-text">${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideIn 300ms reverse';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function showConfirm(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.5);backdrop-filter:blur(4px);z-index:3000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:white;border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);">
        <h3 style="margin:0 0 12px;font-size:16px;color:#0f172a">确认操作</h3>
        <p style="color:#475569;margin:0 0 20px;font-size:14px;line-height:1.5">${escapeHtml(message)}</p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn btn-ghost" data-cancel>取消</button>
          <button class="btn btn-danger" data-ok>确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-cancel]').onclick = () => overlay.remove();
    overlay.querySelector('[data-ok]').onclick = () => {
      overlay.remove();
      onConfirm();
    };
  }

  return { init };
})();

// ============== 启动应用 ==============
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
