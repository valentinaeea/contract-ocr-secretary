/** Persisted business results. Managed OCR records never trigger analysis while rendering. */
const AnalysisResults=(()=>{
 const emptyFacts=ContractFacts.analyze(''),emptyContent=ServiceContent.analyze('');
 const managed=c=>!!c.managedBusinessAnalysis;
 const ready=c=>managed(c)&&c.ruleAnalysisStatus==='done'&&c.businessSnapshot?.schema===1&&c.businessSnapshot.request===c.analysisRequest&&c.businessSnapshot.revision===c.ocrRevision;
 const get=(c,key,fallback)=>ready(c)?c.businessSnapshot[key]:managed(c)?({content:emptyContent,facts:emptyFacts,metadata:emptyFacts,businessTags:[],auditFields:[],summary:{text:'业务分析中，识别全文已可查看。',source:'分析状态'}}[key]):fallback();
 return{managed,ready,get};
})();
