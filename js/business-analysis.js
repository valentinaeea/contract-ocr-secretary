/** Resume persisted business analysis after OCR, outside the UI thread. */
const BusinessAnalysis=(()=>{
 const pending=new Set();let chain=Promise.resolve();
 const event=contract=>window.dispatchEvent(new CustomEvent('business-analysis-updated',{detail:contract}));
 function ensure(contracts){
  if(!NativeDocuments.available())return;
  for(const c of contracts){
   if(!c.managedBusinessAnalysis||!['done','error'].includes(c.analysisStatus)||c.ruleAnalysisStatus==='done'||c.ruleAnalysisStatus==='error')continue;
   const key=c.id+':'+c.analysisRequest;if(pending.has(key))continue;pending.add(key);
   chain=chain.then(()=>run(c)).catch(error=>console.warn('业务规则分析',error.message)).finally(()=>pending.delete(key));
  }
 }
 async function run(contract){
  let worker;
  try{
   const [config,catalog]=await Promise.all([Storage.getConfig(),Storage.getServiceDomainCatalog()]);
   const started=performance.now();
   const result=await new Promise((resolve,reject)=>{
    worker=new Worker('js/business-analysis-worker.js?v=2.14.9');
    worker.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data);
    worker.onerror=e=>reject(Error(e.message||'工作线程启动失败'));
    worker.postMessage({contract,config,catalog});
   });
   const saved=await NativeDocuments.request('/api/business-analysis',{method:'POST',headers:{...NativeDocuments.headers(),'Content-Type':'application/json'},body:JSON.stringify({id:contract.id,request:contract.analysisRequest,revision:contract.ocrRevision,...result,seconds:(performance.now()-started)/1000})});
   event(saved.contract);
  }catch(error){
   await NativeDocuments.request('/api/business-analysis',{method:'POST',headers:{...NativeDocuments.headers(),'Content-Type':'application/json'},body:JSON.stringify({id:contract.id,request:contract.analysisRequest,revision:contract.ocrRevision,error:error.message})}).then(r=>event(r.contract)).catch(()=>{});
  }finally{worker?.terminate();}
 }
 return{ensure};
})();
