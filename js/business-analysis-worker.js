/* Independent local business analysis; no network, upload, DOM or OCR calls. */
importScripts('document-view.js?v=2.14.9','contract-scope.js?v=2.14.9','service-content.js?v=2.14.9','contract-facts.js?v=2.14.9','business-intent.js?v=2.14.9','audit-review.js?v=2.14.9','extractor.js?v=2.14.9');
self.onmessage=async event=>{
 const {contract,config,catalog}=event.data;
 try{
  for(const entry of catalog?.entries||[])ServiceContent.registerDomain(entry.name,entry.aliases||[]);
  const c={...contract,managedBusinessAnalysis:false,serviceSummary:'',auditPurpose:''},scope=ContractScope.resolve(c),text=scope.text;
  const content=ServiceContent.analyze(text),facts=ContractFacts.analyze(text),metadata=ContractFacts.analyze(c.rawText||'');
  content.commercial=[]; // 商务／一般条款不做业务分析
  const fields=await Extractor.extract(c.rawText||'',config,{preferSubject:c.uploadCategory==='ey-template',scopeText:scope.status==='found'?text:''});delete fields.confidence;
  const snapshot={schema:1,request:c.analysisRequest,revision:c.ocrRevision,content,facts,metadata,businessTags:BusinessIntent.forContract(c),auditFields:AuditReview.forContract(c),summary:AuditReview.summaryFor(c)};
  self.postMessage({snapshot,fields});
 }catch(error){self.postMessage({error:error.message||String(error)});}
};
