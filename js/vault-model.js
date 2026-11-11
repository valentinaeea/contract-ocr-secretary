/** Local knowledge projection. Never substitutes sample facts for missing contract data. */
const VaultModel=(()=>{
 const unique=a=>[...new Set(a.filter(Boolean))];
 const labels=a=>unique((a||[]).map(x=>x.label));
 function fingerprint(text){let value=2166136261;for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);return text.length+':'+(value>>>0);}
 const split=t=>unique(String(t||'').split(/[、,，;；\n]+/).map(x=>x.trim()));
 function project(c){
  const whole=c.rawText||'',scope=typeof ContractScope!=='undefined'?ContractScope.resolve(c):{text:whole,status:'full',start:0,end:whole.length,label:'全文分析'},text=scope.text;
  const read=(key,fn)=>typeof AnalysisResults!=='undefined'?AnalysisResults.get(c,key,fn):fn();
  const facts=read('facts',()=>ContractFacts.analyze(text)),metadata=read('metadata',()=>ContractFacts.analyze(whole)),a=read('content',()=>ServiceContent.analyze(text,facts)),scopeKey='kw2:'+(c.uploadCategory==='ey-template'?'ey-template:':'')+fingerprint(text);
  const p={name:c.projectName||c.sourceFile||'未命名合同',amount:c.amount==null?'':Number(c.amount)/10000,industry:facts.industry,region:metadata.region,enterpriseSize:facts.enterpriseSize,businessModel:facts.businessModel,serviceTerm:metadata.serviceTerm,systems:labels(a.systems),eic:metadata.eic,pic:metadata.pic,fic:'',services:labels(a.serviceDomains),specificTags:labels(a.services),keywords:labels(a.keywords),customTags:[],need:unique([...facts.needs,...labels(a.goals)]).join('；'),needTags:facts.needs,scope:labels(a.services).join('；'),originalDescription:unique(a.services.map(x=>x.evidence)).join('\n'),deliverables:labels(a.deliverables),notes:''};
  const profile={...c.knowledgeProfile};if(profile.industry?.length===1)profile.industry=ContractFacts.industryPath(profile.industry[0]);
  if(typeof AnalysisResults!=='undefined'&&AnalysisResults.managed(c)&&!AnalysisResults.ready(c)){if(!profile.domainSelectionManual)profile.services=[];if(!profile.specificSelectionManual)profile.specificTags=[];if(!profile.keywordsSelectionManual)profile.keywords=[];}
  const legacy=profile.tagSchemaVersion!==3,sourceChanged=profile.tagSourceFingerprint!==scopeKey;
  if(sourceChanged&&!profile.domainSelectionManual)profile.services=p.services;
  if(c.uploadCategory==='ey-template'&&sourceChanged){if(!c.manualFieldsEditedAt)for(const field of ['industry','enterpriseSize','businessModel','systems','need','scope','originalDescription','deliverables'])delete profile[field];}
  if(legacy){
   // Keep the old snapshot on disk until the user saves; retain it as history on conversion.
   profile.services=profile.domainSelectionManual?unique((profile.services||[]).map(ServiceContent.canonicalDomain).filter(ServiceContent.isDomain)):p.services;
   profile.specificTags=p.specificTags;
   profile.keywords=p.keywords;
  }else{
   profile.services=unique([...(profile.domainSelectionManual?[]:p.services),...(profile.services||[])].map(ServiceContent.canonicalDomain).filter(ServiceContent.isDomain));
   if(sourceChanged&&!profile.keywordsSelectionManual)profile.keywords=p.keywords;
   profile.specificTags=unique((sourceChanged&&!profile.specificSelectionManual?p.specificTags:profile.specificTags||p.specificTags).map(ServiceContent.cleanTag).filter(Boolean));
  }
  // 关键词、服务领域、具体服务不允许手动修改：有合同正文时一律使用自动识别结果（旧版手动修改的值不再生效）。
  // 只有从 Excel 导入、没有正文的记录保留表格中的关键词。
  if(text.trim()){profile.keywords=p.keywords;profile.services=p.services;profile.specificTags=p.specificTags;}
  else if(c.knowledgeProfile?.keywords)profile.keywords=c.knowledgeProfile.keywords;
  delete profile.keywordsSelectionManual;delete profile.domainSelectionManual;delete profile.specificSelectionManual;
  // 规则更新后补入新识别的系统名称（手动添加的系统保留）
  profile.systems=unique([...(profile.systems||p.systems),...(sourceChanged&&!legacy?p.systems:[])].map(ServiceContent.normalizeSystem));
  const needText=profile.need||p.need, normalizedNeeds=typeof AnalysisResults!=='undefined'&&AnalysisResults.managed(c)&&needText===p.need?facts.needs:ContractFacts.analyze('客户诉求：'+needText).needs;
  return {...p,...profile,name:p.name,amount:p.amount,needTags:normalizedNeeds.length?normalizedNeeds:split(needText).filter(v=>v.length<=80),id:c.id,rawText:whole,uploadCategory:c.uploadCategory||'other',analysisScope:scope,analysis:a,factEvidence:facts.evidence,tagSchemaVersion:3,tagSourceFingerprint:scopeKey};
 }
 const links=[['IPO','上市支持|首次公开发行|上市审计|招股'],['SOC1','财务报告控制鉴证|ISAE\\s*3402'],['SOC2','可信服务控制鉴证|信任服务准则'],['数据核查','业财一致性|数据核验|跨系统|对账'],['ITGC','信息系统一般控制|系统控制评估|变更管理|逻辑访问'],['ISO认证','ISO认证准备|信息安全合规|隐私合规|管理体系|认证范围|迎审'],['SOX','财务报告内控|COSO'],['隐私','PIA|DPIA|RoPA|隐私合规|个人信息'],['风险评估','风险咨询|风险处置|差距分析']];
 function normalizeSearch(value){return String(value??'').normalize('NFKC').toLowerCase().replace(/\btype\s*(ii|i)\b/g,(_,v)=>'type'+(v==='ii'?'2':'1')).replace(/[\s_\-/]+/g,'');}
 function matchContract(p,query,extraLinks=[]){
  const q=normalizeSearch(query);if(!q)return{kind:'direct',reasons:[]};
  const corpus=[p.name,p.uploadCategory==='ey-template'&&typeof ContractScope!=='undefined'?ContractScope.textFor(p):p.rawText,p.originalDescription,p.scope,p.need,p.eic,p.pic,p.fic,p.enterpriseSize,p.businessModel,p.serviceTerm,...(p.industry||[]),...(p.region||[]),...(p.deliverables||[]),...(p.services||[]),...(p.systems||[]),...(p.keywords||[]),...(p.specificTags||[]),...(p.customTags||[])];
  if(corpus.some(v=>normalizeSearch(v).includes(q)))return{kind:'direct',reasons:[]};
  const business=[p.scope,...(p.services||[]),...(p.specificTags||[])].join(' '),reasons=[];
  for(const[key,re]of links){const k=normalizeSearch(key);if((q===k||q==='soc'&&/^soc[12]$/.test(k))&&new RegExp(re,'i').test(business))reasons.push('业务关联：'+key);}
  if(q==='soc'||q==='soc1'||q==='soc2'){
   const families=[['soc1',/财务报告.*(?:控制|鉴证)|ISAE\s*3402/i],['soc2',/可信服务|信任服务|信赖服务/i]];
   for(const[key,re]of families)if((q==='soc'||q===key)&&re.test(business))reasons.push('业务关联：'+key.toUpperCase());
  }
  for(const rule of extraLinks){const trigger=rule.from.find(x=>q.includes(normalizeSearch(x)));if(!trigger)continue;const found=rule.to.filter(x=>normalizeSearch(business).includes(normalizeSearch(x)));if(found.length)reasons.push('业务关联：'+trigger+' → '+found.join('、'));}
  return{kind:reasons.length?'related':'none',reasons:[...new Set(reasons)]};
 }
 function matchesDimension(values,query,dimension){
  const q=normalizeSearch(query);if(!q)return true;
  const list=Array.isArray(values)?values:split(values);
  if(list.some(v=>normalizeSearch(v).includes(q)))return true;
  if(dimension==='services')return list.some(v=>normalizeSearch(ServiceContent.canonicalDomain(v))===normalizeSearch(ServiceContent.canonicalDomain(query)));
  if(dimension==='specificTags'){
   const canonical=ServiceContent.analyze('服务内容：提供'+query+'服务。').services.map(x=>normalizeSearch(x.label));
   return list.some(v=>canonical.includes(normalizeSearch(v)));
  }
  if(dimension==='systems')return list.some(v=>normalizeSearch(ServiceContent.normalizeSystem(v))===normalizeSearch(ServiceContent.normalizeSystem(query)));
  return false;
 }
 function search(records,f={}){
  const q=String(f.q||'').trim().toLowerCase(),direct=[],related=[];
  for(const p of records){
   if(['industry','region'].some(key=>(f[key]||[]).some((v,i)=>v&&p[key][i]!==v)))continue;
   if(['services','specificTags','systems','need','enterpriseSize','businessModel','serviceTerm','deliverables'].some(key=>split(f[key]).length&&!split(f[key]).some(v=>matchesDimension(p[key],v,key))))continue;
   if(['eic','pic'].some(key=>f[key]&&!String(p[key]).toLowerCase().includes(f[key].toLowerCase())))continue;
   if(f.person&&!(p.eic+' '+p.pic+' '+(p.fic||'')).toLowerCase().includes(f.person.toLowerCase()))continue;
   if((f.min!==''&&f.min!=null&&(p.amount===''||p.amount<Number(f.min)))||(f.max!==''&&f.max!=null&&(p.amount===''||p.amount>Number(f.max))))continue;
   const match=matchContract(p,q);if(match.kind==='direct')direct.push(p);else if(match.kind==='related')related.push({...p,reason:match.reasons.join('；')});
  }
  if(f.sort)for(const rows of[direct,related])rows.sort((a,b)=>a.amount===''?1:b.amount===''?-1:(a.amount-b.amount)*(f.sort==='desc'?-1:1));
  return{direct,related};
 }
 function recordChanges(before,after){
  const fields=['projectName','partyA','partyB','signDate','amount','content','deliverables','auditPurpose','engagementCode','engagementCodeDescription','engagementName','knowledgeProfile'];
  const changes=fields.filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k])).map(field=>({field,before:before[field]??null,after:after[field]??null}));
  if(!changes.length)return after;
  return {...after,manualEditHistory:[...(before.manualEditHistory||[]),{at:new Date().toISOString(),changes}]};
 }
 function synchronizeEdit(before,after){
  const profile={...after.knowledgeProfile};
  profile.name=after.projectName;profile.amount=after.amount==null?'':Number(after.amount)/10000;
  if(after.content!==before.content)profile.scope=after.content||'';
  if(after.deliverables!==before.deliverables)profile.deliverables=split(after.deliverables);
  return recordChanges(before,{...after,knowledgeProfile:profile,...(after.amount!==before.amount?{amountManuallyEdited:true}:{})});
 }
 function update(c,p){
  if(p.amount!==undefined&&p.amount!==''&&(!Number.isFinite(Number(p.amount))||Number(p.amount)<0))throw Error('请输入有效金额');
  const auto=project(c);
  // 保存时关键词 / 服务领域 / 具体服务始终取自动识别结果，不接受手动值
  if(auto.analysisScope?.text?.trim()||(!auto.analysisScope&&c.rawText))p={...p,keywords:auto.keywords,services:auto.services,specificTags:auto.specificTags};
  if((p.services||[]).some(v=>!ServiceContent.isDomain(v)))throw Error('请输入明确的业务领域名称；ITGC 等具体服务及客户行业请填入相应分类');
  if(!(auto.analysisScope?.text?.trim())&&(p.specificTags||[]).some(v=>!ServiceContent.cleanTag(v)))throw Error('具体服务需为明确业务名称，不能是本协议服务等泛化片段');
  const profile={...p,tagSchemaVersion:3,tagSourceFingerprint:auto.tagSourceFingerprint};
  delete profile.keywordsSelectionManual;delete profile.domainSelectionManual;delete profile.specificSelectionManual;
  if(c.knowledgeProfile&&c.knowledgeProfile.tagSchemaVersion!==3)profile.previousTagClassification={version:c.knowledgeProfile.tagSchemaVersion||1,previous:c.knowledgeProfile.previousTagClassification||null,services:c.knowledgeProfile.services||[],specificTags:c.knowledgeProfile.specificTags||[],keywords:c.knowledgeProfile.keywords||[]};delete profile.id;delete profile.rawText;delete profile.analysis;delete profile.factEvidence;delete profile.analysisScope;
  // 编辑弹窗不再显示金额：未提供 amount 时保留原值。甲乙方、签约时间、服务目的随同一次保存写回原字段。
  const identity={};for(const key of ['partyA','partyB','signDate','auditPurpose','engagementCode','engagementCodeDescription','engagementName'])if(typeof p[key]==='string'){identity[key]=p[key];delete profile[key];}
  if(identity.auditPurpose!==undefined&&identity.auditPurpose!==(c.auditPurpose||'')){identity.auditPurposeNeedsReview=false;identity.auditPurposeEditedAt=Date.now();}
  const amount=p.amount===undefined?c.amount:p.amount===''?null:Math.round(Number(p.amount)*1000000)/100;if(p.amount===undefined)delete profile.amount;
  const prior=project(c);return synchronizeEdit(c,{...c,...identity,projectName:p.name,amount,content:p.scope!==prior.scope?p.scope:c.content,deliverables:JSON.stringify(p.deliverables)!==JSON.stringify(prior.deliverables)?(p.deliverables||[]).join('；'):c.deliverables,knowledgeProfile:profile,manualFieldsEditedAt:new Date().toISOString()});
 }
 return{project,search,update,split,synchronizeEdit,matchContract,normalizeSearch,matchesDimension};
})();
