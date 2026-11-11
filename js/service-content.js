/** Content dimensions and contextual synonyms. No client-specific facts or training data. */
const ServiceContent=(()=>{
 const activities=[
 ['差距分析','差距分析|差距评估|gap\\s*analysis'],['风险评估','风险评估|风险评价|risk\\s*assessment'],['风险处置','风险处置|风险处理|整改闭环'],
 ['访谈与现状调研','尽职调查|访谈调研|调研访谈|现状调研'],['隐私影响评估辅导','隐私影响评估|个人信息保护影响评估|\\bDPIA\\b|\\bPIA\\b'],
 ['处理活动记录辅导','数据处理记录|处理活动记录|\\bRoPA\\b'],['认证范围界定','认证范围|认证边界'],
 ['管理体系文件建设','体系文件|文件模板|制度编制|制度建设'],['内部审核辅导','内部审核辅导|内部审计指导|内审辅导'],
 ['管理评审辅导','管理评审'],['模拟审核与迎审支持','模拟审核|预审核|迎审|答辩支持|认证审核支持'],
 ['整改建议与跟踪','整改建议|整改跟踪|整改计划|整改闭环|不符合项整改|问题整改辅导'],['流程梳理','流程梳理|流程矩阵'],
 ['培训服务','标准培训|标准解读培训|内审员培训|培训服务|方法论培训|提供.{0,20}培训|开展.{0,20}培训|组织.{0,20}培训|provide.{0,60}training|deliver.{0,60}training'],
 ['数据核查','数据核查|数据核验|业财一致性|(?:跨系统|系统间|系统之间).{0,35}(?:准确性|完整性|一致性|核对|核验)|业务数据.{0,20}财务数据.{0,20}(?:核对|核验|一致性)|data\\s*reconciliation'],
 ['ITGC','信息系统一般控制|信息技术一般控制|IT一般控制|\\bITGC\\b|information\\s*technology\\s*general\\s*controls?'],['ITAC','应用(?:自动)?控制|\\bITAC\\b|application\\s*controls?'],['权限管理','权限管理|访问权限管理|逻辑访问(?:管理|控制)|(?:离职|离岗)(?:员工)?(?:的)?(?:账号|账户).{0,12}(?:停用|注销|回收)|用户授权(?:审批|复核)|logical\\s*access\\s*reviews?|user\\s*access\\s*reviews?|账号权限|用户权限审阅|访问控制评估|权限评估|权限核查|职责分离检查'],['风险核查','风险核查|风险核验|风险检查'],['流程优化','流程优化|流程改进|业务流程再造'],['数据迁移','数据迁移|迁移核验|迁移验证|迁移核对|迁移前后.{0,24}(?:记录|条数|金额|一致)|data\\s*migration'],['信息系统及数据评估','信息系统及数据评估|信息系统与数据评估|信息系统评估|数据质量评估'],['ISO认证准备','(?:ISO(?:/IEC)?\\s*(?:27001|27701)|信息安全管理体系|隐私信息管理体系).{0,25}(?:认证准备|认证辅导|认证咨询)'],['SOC 1鉴证','SOC\\s*1(?:\\s*Type\\s*(?:II|I|[12]))?.{0,20}?(?:鉴证|报告)'],['SOC 2鉴证','SOC\\s*2(?:\\s*Type\\s*(?:II|I|[12]))?.{0,20}?(?:鉴证|报告)'],['系统开发与实施','软件开发|系统开发|系统实施|部署实施']
 ].map(([label,re])=>({label,re:new RegExp(re,'i')}));
 const standards=/ISO(?:\/IEC)?\s*(?:27001|27701)(?:\s*[:：]\s*\d{4})?|\bISMS\b|\bPIMS\b|\bSoA\b|适用性声明|PII控制者|PII控制方|PII处理者|\bSOC\s*[12](?:\s*Type\s*(?:II|I|[12]))?|\bSOX\b|\bCOSO\b|\bISAE\s*3402\b/gi;
 const topics=/访问控制|加密技术|业务连续性|资产管理|供应商安全|信息安全事件|数据最小化|告知同意|主体权利|个人信息跨境|隐私事件|个人信息保护/gi;
 const qualifications=/\bCISA\b|\bCISM\b|\bCISSP\b|\bCDPSE\b|\bCIPM\b|CIPP\/E|\bCIFT\b|IT审计资质/gi;
 const compact=t=>t.replace(/[ \t\r]/g,'');
 function role(text,section=''){
  const t=compact(text);
  if(/仅(?:作为|为)?(?:示例|举例)|示例服务|非本次服务/.test(t))return 'example';
  if(/\b(?:will\s+not\s+provide|do(?:es)?\s+not\s+include|out\s+of\s+scope|not\s+included|excluding)\b/i.test(text))return 'boundary';
  if(/(?:不得|禁止).*(?:训练|人工智能|AI|网盘|境外|客户数据|资料使用)|不得用于|不得使用|禁止使用/.test(t))return 'commercial';
  if(/不包括|不包含|不提供|不涉及|不纳入|不承担|不负责|不适用|无需提供|不在.{0,8}范围|排除|不保证|不得承诺/.test(t))return 'boundary';
  if(/人员资质|人员要求|资质要求|项目经验要求|人员经验/.test(t)||/参与过|须持有|应持有|不少于\d+年.*经验|具备.*资质|供应商.*(?:须|应|必须).*经验/.test(t)||section==='personnel')return 'personnel';
  if(section==='background'&&!/(?:本次委托|本项目将|本次服务).{0,14}(?:提供|开展|委托|负责)/.test(t))return 'background';
  if(section==='commercial'||/付款|发票|增值税|包干|保密义务|保密条款|保密期|保密协议|保密责任|数据处理协议|安全承诺|工时确认|人天|独立性|知识产权|验收标准|满意度|责任限制/.test(t)&&!/出具.*(?:培训记录|验收报告)/.test(t))return 'commercial';
  if(/培训内容|培训主题|课程内容|控制域培训|培训条目|仅.*培训|training\s+(?:topics|content)/i.test(text)||section==='training')return 'training';
  if(section==='goal'&&!/^(?:我们|乙方|本次服务|本项目)(?:将|负责|需|应)?(?:为.{0,20})?(?:提供|开展|执行|实施|出具|进行)/.test(t))return 'goal';
  if(/是指|系指|定义[:：]/.test(t))return 'definition';
  const offeredTraining=/(?:提供|开展|组织).{0,35}培训/.test(t)||/\b(?:provide|deliver|conduct).{0,80}training\b/i.test(text);
  const mixedTraining=/(?:实施|测试|审阅|核查).{0,8}(?:及|和|并|以及).{0,20}培训|培训.{0,8}(?:及|和|并|以及).{0,12}(?:实施|执行|测试|审阅|核查|辅导)/.test(t);
  if(offeredTraining&&!mixedTraining)return 'training_service';
  if(section==='scope'||/开展|提供|实施|辅导|出具|交付|编制|乙方负责|支持|进行|咨询/.test(t)||/\b(?:perform|provide|conduct|deliver|assess|review)\b/i.test(text))return 'scope';
  return 'context';
 }
 function units(source=''){
  let section='';const result=[];
  // Contrast and explicit exclusions are separate clauses; one negative item cannot swallow another service.
  const expression=/[^\n。；！？]+[。；！？]?/g;
  for(const whole of String(source).matchAll(expression)){
   const parts=whole[0].split(/(?<=[，,])(?=\s*(?:但|但是|而|而是|不包括|不包含|不提供|不涉及|不负责|不承担|but\b|however\b|excluding\b))|(?=但(?:不包括|不包含|不提供|不涉及|不负责|不承担|将提供|提供|将开展|仍提供))/i);
   let local=0;
   for(const raw of parts){const text=raw.trim();const start=whole.index+local+raw.indexOf(text);local+=raw.length;if(!text)continue;
    const t=compact(text).replace(/^[一二三四五六七八九十\d、.（）()第条章节]+/,'');
    if(/^(?:客户诉求|客户需求|项目目标|甲方希望|客户希望|贵公司希望|objectives?[:：])/i.test(t))section='goal';
    else if(/^(?:服务内容|工作内容|服务范围|项目内容|交付成果|交付物|项目实施|涉及系统|主要服务|服务领域|业务领域|咨询领域|Service(?:Line|Domain|Area)|BusinessDomain|Scope(?:of(?:work|services))?|Deliverables|Statementofwork)/i.test(t))section='scope';
    else if(/^(?:客户基本信息|项目信息|客户行业|甲方行业|所属行业|企业规模|业务模式|项目所属区域|项目区域|服务期限|EIC|PIC)/i.test(t))section='';
    else if(/^(?:人员要求|人员资质|资质要求|项目团队|人员经验|项目经验|供应商资质|personnel|qualifications)/i.test(t))section='personnel';
    else if(/^(?:培训内容|培训主题|课程内容|控制域培训|training(?:topics|content))/i.test(t))section='training';
    else if(/^(?:服务费|付款|保密|数据使用约定|知识产权|违约|验收|责任限制|责任条款|通用条款)/.test(t))section='commercial';
    else if(/^(?:背景介绍|项目背景|公司简介|乙方简介|供应商简介|过往项目|历史项目|background)/i.test(t))section='background';
    else if(/^第[一二三四五六七八九十\d]+条/.test(compact(text)))section='';
    result.push({text,start,role:role(text,section)});
   }
  }return result;
 }
 function activityMatches(activity,text){let target=text;let matches=[...target.matchAll(new RegExp(activity.re.source,'gi'))];if(!matches.length){target=compact(text);matches=[...target.matchAll(new RegExp(activity.re.source,'gi'))];}return matches.map(m=>({value:m[0],after:target.slice(m.index+m[0].length),target}));}
 function isTrainingMention(after){return /^\s*(?:[:：]\s*\d{4})?\s*(?:标准|相关|的)?\s*(?:培训|training)/i.test(after);}
 function businessMatches(re,text){return activityMatches({re},text).filter(m=>!isTrainingMention(m.after));}
 function serviceLabel(activity,match,unit){let label=activity.label;
  if(/^SOC [12]鉴证$/.test(label)){const m=match.value.replace(/Ⅱ/g,'II').replace(/Ⅰ/g,'I').match(/SOC\s*([12])\s*Type\s*(II|I|[12])(?=$|[^A-Za-z0-9])/i);if(m)label=`SOC ${m[1]} Type ${/^(II|2)$/i.test(m[2])?2:1}鉴证`;}
  if(['风险评估','隐私影响评估辅导','处理活动记录辅导'].includes(label)){const guided=/^(?:\s*(?:方法|记录|相关方法|的))*\s*辅导/.test(match.after)||/辅导[。；;]?\s*$/.test(unit)&&!/实施|执行/.test(unit);if(!guided)label=label.replace('辅导','');else if(!label.endsWith('辅导'))label+='辅导';}
  return label;
 }
 function openServices(text){
  const marker=text.match(/(?:提供|开展|进行|负责)|(?:服务内容|服务范围|工作内容)[:：]/);if(!marker)return [];
  const body=text.slice(marker.index+marker[0].length).replace(/[。；;]$/,'');
  const known=activities.flatMap(a=>activityMatches(a,text).map(m=>compact(m.value)));
  return body.split(/[、，,]|以及|并且|同时|(?:及|和|并)(?=(?:提供|开展|实施|执行|数据|系统|风险|流程|安全|隐私|信息|设备|软件|财务|权限))/).map(v=>v.trim().replace(/^(?:提供|开展|实施|执行)/,'')).filter(v=>{
   const core=compact(v).replace(/服务$/,'');return core&&!known.some(m=>m.includes(core));
  }).map(cleanTag).filter(Boolean);
 }
 function analyze(source='',facts){
  const out={goals:[],domains:[],serviceDomains:[],keywords:[],services:[],training:[],topics:[],standards:[],personnel:[],commercial:[],boundaries:[],deliverables:[],industry:[],systems:[]};
  function add(group,label,evidence){if(!out[group].some(x=>x.label===label&&x.evidence===evidence))out[group].push({label,evidence});}
  for(const u of units(source)){
   const t=compact(u.text);
   if(!['personnel','training','training_service','commercial','boundary','definition','background','example'].includes(u.role)&&/项目目标|客户诉求|客户需求|旨在|甲方希望|客户希望|贵公司希望/.test(t))add('goals',u.text.replace(/^(?:项目目标|客户诉求|客户需求)[:：]?/,''),u.text);
   if(u.role==='boundary')add('boundaries',u.text,u.text);
   if(u.role==='commercial')add('commercial',u.text,u.text);
   for(const match of t.matchAll(new RegExp(standards.source,'gi')))add('standards',match[0],u.text);
   for(const match of t.matchAll(new RegExp(qualifications.source,'gi')))add('personnel',match[0],u.text);
   if(u.role==='personnel')add('personnel',u.text,u.text);
   for(const activity of activities){for(const match of activityMatches(activity,u.text)){
    if(u.role==='scope'){const trainingOnly=activity.label!=='培训服务'&&isTrainingMention(match.after);if(trainingOnly)add('training',activity.label,u.text);else add('services',serviceLabel(activity,match,u.text),u.text);}
    else if(['training','training_service'].includes(u.role))add('training',activity.label,u.text);
   }}
   if(u.role==='training_service'){add('services','培训服务',u.text);for(const a of activities)for(const m of activityMatches(a,u.text))if(m.value.length<=32)add('keywords',m.value.replace(/^(?:提供|开展|组织)/,''),u.text);}
   for(const match of t.matchAll(new RegExp(topics.source,'gi')))add(['training','training_service'].includes(u.role)?'training':'topics',match[0],u.text);
   if(u.role==='scope'){
    // 「编号 系统数量 使用目的」这类表格行描述的是客户的系统，只作关键词，不算我们提供的服务。
    const tableRow=/^\s*\d{1,3}\s+\d{1,3}\s*[，,]/.test(u.text);
    for(const label of openServices(u.text)){if(!tableRow)add('services',label,u.text);add('keywords',label,u.text);}
    for(const activity of activities)for(const m of activityMatches(activity,u.text))if(m.value.length<=32)add('keywords',m.value,u.text);
    for(const m of t.matchAll(new RegExp(standards.source,'gi')))add('keywords',m[0],u.text);
    for(const match of u.text.matchAll(/(?:出具|交付|提交|提供)([^。；\n]{2,50}(?:报告|清单|计划|课件|模板|材料|记录))/g))add('deliverables',match[1].trim(),u.text);
    for(const match of u.text.matchAll(/\bSAP\b|\bOracle\b|\bERP\b|\bDMS\b|\bCRM\b|\bRPA\b/gi))add('systems',match[0].toLowerCase()==='oracle'?'Oracle':match[0].toUpperCase(),u.text);
   }
   if(!['personnel','training','definition'].includes(u.role)){
    const match=/(?:甲方|客户|贵公司)(?:属于|从事|主要业务为|主营业务为)([^。；\n]{2,45})/.exec(t)||/客户行业[:：]([^。；\n]{2,45})/.exec(t);if(match)add('industry',match[1],u.text);
   }
  }
  const domains=[['SOX','SOX|萨班斯'],['业财核查','业财一致性|数据核查|跨系统.*核对'],['财务报告内控','COSO|财务报告内部控制|企业内部控制基本规范'],['风险咨询','风险评估|风险处置|风险处理'],['信息安全合规','ISO(?:/IEC)?27001|信息安全管理体系'],['隐私合规','ISO(?:/IEC)?27701|隐私影响评估|数据处理记录|RoPA|DPIA|PIMS']];
  for(const[label,pattern]of domains){const re=new RegExp(pattern,'i');const hits=units(source).filter(u=>re.test(compact(u.text)));const positive=hits.filter(u=>u.role==='scope');const excluded=hits.filter(u=>new RegExp('(?:不包括|不提供|不涉及|不纳入|排除).{0,24}(?:'+pattern+')','i').test(compact(u.text)));out.domains.push({label,status:positive.length?(excluded.length?'涉及，含排除范围':'涉及'):excluded.length?'明确排除':hits.length?'仅有相关表述':'未提及',evidence:(positive[0]||excluded[0]||hits[0])?.text||''});}
  const domainRules=[['SOX',/SOX|萨班斯/i],['业财',/业财|财务转型|业务与财务|跨系统.{0,25}(?:核对|核查)|业务数据.{0,20}财务数据/i],['内控',/内控|内部控制|一般控制|应用控制|ITGC|ITAC|COSO/i],['风险咨询',/风险咨询|风险评估|风险核查|风险评价|风险处置|差距分析|隐私风险评估/i]];
  for(const[label,re]of domainRules){const evidence=units(source).find(u=>u.role==='scope'&&businessMatches(re,u.text).length),service=out.services.find(x=>re.test(x.label));if(evidence||service){add('serviceDomains',label,evidence?.text||service.evidence);const match=evidence?.text.match(re);if(match)add('keywords',match[0],evidence.text);}}
  const scoped=units(source).filter(u=>u.role==='scope'&&!/^(?:客户诉求|客户需求|项目目标|甲方希望|客户希望|贵公司希望|旨在)/.test(u.text));
  const extensionRules=[['信息安全合规',/ISO(?:\/IEC)?\s*27001|信息安全合规/i],['隐私与数据合规',/ISO(?:\/IEC)?\s*27701|隐私合规|数据合规|个人信息保护咨询/i],['数据治理',/数据治理/i],['数字化转型',/数字化转型(?:咨询|服务)|提供.{0,8}数字化转型/i],['ESG与可持续发展',/\bESG\b|可持续发展咨询/i],['第三方鉴证',/SOC\s*[12].*(?:鉴证|报告)|第三方鉴证/i]];
  for(const[label,re]of extensionRules){const evidence=scoped.find(u=>businessMatches(re,u.text).length);if(evidence)add('serviceDomains',label,evidence.text);}
  for(const u of scoped){
   const explicit=u.text.match(/^(?:服务领域|业务领域|咨询领域|项目所属领域|Service\s*(?:Line|Domain|Area)|Business\s*Domain)\s*[:：]\s*([^。；\n]{1,120})/i);
   if(explicit)for(const value of explicit[1].split(/[、，,]/)){const name=canonicalDomain(value);if(isDomain(name)){add('serviceDomains',name,u.text);add('keywords',value.trim(),u.text);}}
   // New broad consulting/compliance fields can be learned from an explicit service offering.
   for(const m of u.text.matchAll(/(?:提供|开展)([A-Za-z\u4e00-\u9fff]{2,22}?(?:咨询|治理|合规|转型))服务/g)){const name=canonicalDomain(m[1]);if(isDomain(name)){add('serviceDomains',name,u.text);add('keywords',m[1],u.text);}}
   for(const name of domainNames){const terms=[name,...(domainAliases.get(name)||[])];if(terms.some(term=>{const at=compact(u.text).toLowerCase().indexOf(compact(term).toLowerCase());return at>=0&&!isTrainingMention(compact(u.text).slice(at+compact(term).length));}))add('serviceDomains',name,u.text);}
  }
  if(out.services.some(x=>x.label==='培训服务'))add('serviceDomains','培训与能力建设',out.services.find(x=>x.label==='培训服务').evidence);
  out.services=out.services.filter(x=>!out.serviceDomains.some(d=>canonicalDomain(x.label)===d.label));
  if(typeof ContractFacts!=='undefined'){const client=facts||ContractFacts.analyze(source);out.industry=client.industry.length?[{label:client.industry.join(' / '),evidence:client.evidence.industry||''}]:[];}
  refineKeywords(out,source);
  for(const group of Object.keys(out)){
   const seen=new Set();out[group]=out[group].filter(x=>{const key=x.label+'|'+x.evidence;if(seen.has(key))return false;seen.add(key);return true;});
  }
  return out;
 }
 // ===== 关键词精确化（云盘总表检索只能看到关键词等列）=====
 // 1. 服务内容条款里的分项标题（如「a) 差距分析服务：…」）是最准确的服务关键词，排在最前；
 // 2. 标准名称统一写法，并补上体系名称（ISO 27001 → 信息安全管理体系）；
 // 3. SOC 1 / SOC 2 的多种写法合并为「SOC 2鉴证 / SOC 2报告 / SOC 2 类型一 / SOC 2 类型二」；
 // 4. 去掉句子片段（「的培训」「控制设计的恰当性实施类型一检查」）和「进行系统培训」中被误认的「系统培训」；
 // 5. 提取服务范围内的客户系统 / 平台名称（订单系统、仓储系统、“自助平台”）。
 const ITEM_TITLE=/^\s*(?:[a-zA-Z][)）.]|[（(][a-zA-Z一二三四五六七八九十\d]{1,2}[)）]|[一二三四五六七八九十\d]{1,2}[、.．)）])\s*([^：:，,。；;（(]{2,18})[：:]/;
 const SCOPE_HEADING=/^(?:第[一二三四五六七八九十百\d]{1,3}条\s*)?(?:服务内容|服务范围|工作内容|工作范围|项目内容|服务事项)\s*$/;
 const NEXT_HEADING=/^(?:第[一二三四五六七八九十百\d]{1,3}条|附录|附件|服务范围的限制|贵公司的具体责任|[一二三四五六七八九十]{1,3}[、.．])/;
 const STANDARD_TERMS=[[/ISO(?:\/IEC)?\s*27001/i,['ISO 27001','信息安全管理体系']],[/ISO(?:\/IEC)?\s*27701/i,['ISO 27701','隐私信息管理体系']],[/ISO(?:\/IEC)?\s*20000/i,['ISO 20000']],[/ISO(?:\/IEC)?\s*22301/i,['ISO 22301']],[/ISO\s*9001/i,['ISO 9001']],[/SSAE\s*-?\s*18/i,['SSAE 18']],[/ISAE\s*3402/i,['ISAE 3402']],[/ISAE\s*3000/i,['ISAE 3000']],[/TSP\s*Section\s*100|可信服务(?:标准|原则)/i,['可信服务标准']],[/\bAICPA\b|美国注册会计师协会/i,['AICPA']]];
 const GENERIC_SYSTEMS=/^(?:计算机|信息|业务|客户|操作|应用|相关|其他|其它|该|上述|下述|各|所有|任何|对应|现有|内部|外部|第三方|服务机构|子|管理|控制|IT)?(?:系统|平台)$/;
 function scopeLines(source){
  const lines=String(source||'').split('\n'),out=[];let active=false;
  for(const raw of lines){const line=raw.trim();if(!line)continue;
   if(SCOPE_HEADING.test(line.replace(/\s+/g,''))){active=true;continue;}
   if(active&&NEXT_HEADING.test(line)&&!ITEM_TITLE.test(line))active=false;
   if(active)out.push(line);
  }
  return out;
 }
 function socTerms(text){
  const t=String(text||'').replace(/Ⅱ/g,'II').replace(/Ⅰ/g,'I'),out=[];
  for(const n of ['1','2']){
   if(!new RegExp('SOC\\s*'+n+'(?![0-9])','i').test(t))continue;
   const near=t.split('\n').filter(line=>new RegExp('SOC\\s*'+n+'(?![0-9])','i').test(line)).join('\n');
   if(/鉴证|检查|examination|attestation/i.test(near))out.push(`SOC ${n}鉴证`);
   if(/报告|report/i.test(near))out.push(`SOC ${n}报告`);
   if(/类型一|类型1|Type\s*(?:I|1)(?![I\d])/i.test(near))out.push(`SOC ${n} 类型一`);
   if(/类型二|类型2|Type\s*(?:II|2)(?![I\d])/i.test(near))out.push(`SOC ${n} 类型二`);
   if(!out.some(x=>x.startsWith(`SOC ${n}`)))out.push(`SOC ${n}`);
  }
  return out;
 }
 function systemNames(source){
  const found=[];
  for(const line of String(source||'').split('\n')){
   if(/不包括|不纳入|不涉及|排除|不会|不对|并未/.test(line))continue;
   for(const m of line.matchAll(/(?:^|[\s，,、。；;：:（(“"「‘'对接包括的])([A-Za-z\u4e00-\u9fff]{2,12}?(?:系统|平台))(?=$|[\s，,、。；;：:）)”"」’'及和与对的A-Z])/g)){
    const name=m[1].split('的').pop().replace(/^(?:对接|接入|包括|旧的|新的|原有的|现有的|新|旧|接)/,'');
    if(name.length<3||GENERIC_SYSTEMS.test(name)||/^(?:进行|提供|开展|实施|对|在|为|没有|无|下列|以下|上述|如下|该)/.test(name)||/或|和|及|与|客户系统$/.test(name))continue;
    if(!found.includes(name))found.push(name);
   }
  }
  return found;
 }
 function refineKeywords(out,source){
  const text=String(source||''),evidenceFor=re=>{const line=text.split('\n').find(l=>re.test(l));return line?line.trim():'';};
  const adverbTraining=/(?:进行|开展|组织|提供)系统(?:性)?(?:地)?培训/;
  const sentenceLike=k=>/^[的和及与或等、]/.test(k)||k.length>20||(k.length>12&&/的|实施|进行|对于|关于|根据/.test(k));
  out.services=out.services.filter(x=>!(x.label==='系统培训'&&adverbTraining.test(x.evidence))).map(x=>{
   let k=x.label.trim().replace(/ISO(?:\/IEC)?\s*(\d{4,5})/gi,'ISO $1').replace(/SOC\s*([12])/gi,'SOC $1');
   if((k.match(/ISO \d{4,5}/g)||[]).length>=2)k=k.replace(/ISO \d{4,5}(?:[:：]\d{4})?/g,'').replace(/^[及和与、\s&]+|[及和与、\s&]+$/g,'');
   return {label:k,evidence:x.evidence};
  }).filter(x=>x.label.length>=2&&!sentenceLike(x.label));
  const isSoc=label=>/^SOC\s*[12]/i.test(label);
  let kept=out.keywords.filter(x=>{
   const k=x.label.trim();
   if(!k||isSoc(k))return false;
   if(k==='系统培训'&&adverbTraining.test(x.evidence))return false;
   return true;
  }).map(x=>{
   let k=x.label.trim().replace(/ISO(?:\/IEC)?\s*(\d{4,5})/gi,'ISO $1');
   // 「ISO 27001及ISO 27701认证评估」：标准单独成词，这里只留活动「认证评估」
   if((k.match(/ISO \d{4,5}/g)||[]).length>=2)k=k.replace(/ISO \d{4,5}(?:[:：]\d{4})?/g,'').replace(/^[及和与、\s&]+|[及和与、\s&]+$/g,'');
   return {label:k,evidence:x.evidence};
  }).filter(x=>x.label.length>=2&&!sentenceLike(x.label));
  const titles=[];
  for(const line of scopeLines(text)){const m=line.match(ITEM_TITLE);if(!m)continue;const title=m[1].trim().replace(/服务$/,'');if(title.length>=2&&!/乙方|甲方|本合同|本协议|定义|其他|其它|说明/.test(title))titles.push({label:title,evidence:line});}
  const standards=[];for(const[re,labels]of STANDARD_TERMS)if(re.test(text))for(const label of labels)standards.push({label,evidence:evidenceFor(re)});
  const soc=socTerms(text).map(label=>({label,evidence:evidenceFor(/SOC\s*[12]/i)}));
  const seen=new Set(),key=v=>v.label.replace(/\s+/g,'').toLowerCase();
  out.keywords=[...titles,...soc,...standards,...kept].filter(x=>{const k=key(x);if(seen.has(k))return false;seen.add(k);return true;});
  for(const name of systemNames(text))if(!out.systems.some(x=>x.label===name))out.systems.push({label:name,evidence:evidenceFor(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))});
 }
 const domainNames=['SOX','业财','内控','风险咨询'];
 const domainAliases=new Map();
 function canonicalDomain(value){const t=String(value||'').trim().replace(/[ \t]/g,'').replace(/咨询服务$/,'咨询').replace(/服务$/,'');const aliases={'萨班斯':'SOX','萨班斯法案':'SOX','业财核查':'业财','业财融合':'业财','财务报告内控':'内控','企业内部控制':'内控','内部控制':'内控','隐私合规':'隐私与数据合规','数据合规':'隐私与数据合规'};if(aliases[t])return aliases[t];for(const name of domainNames)if(name.toLowerCase()===t.toLowerCase()||(domainAliases.get(name)||[]).some(a=>a.toLowerCase()===t.toLowerCase()))return name;return t;}
 function isDomain(value){const raw=String(value||'').trim(),t=canonicalDomain(raw);if(domainNames.includes(t))return true;if(!t||t.length>28||/本协议|本合同|本项目|本服务|提供|开展|进行|负责|履行|承担|贵公司|我方|乙方|甲方|我们|任何|其他|如下|上述|下述|第.{0,8}条|未提及|待定|未确定|不包括|不提供|不涉及|例如|培训内容|人员要求|项目经验|[，,、。；;:：]/.test(raw))return false;if(['金融服务','软件服务','医疗服务','银行','商业银行','新能源汽车','金融','制造业','合规整改','降本增效','专业咨询','业务咨询','咨询'].includes(raw))return false;if(activities.some(a=>a.label===t||a.re.test(t)))return false;return /咨询|合规|治理|转型|可持续发展|鉴证|内控|管理|安全|审计|税务|财务|培训与能力建设|consulting|compliance|governance|assurance|transformation|sustainability|cybersecurity|audit|risk/i.test(t);}
 function registerDomain(value,aliases=[]){const name=canonicalDomain(value);if(!isDomain(name))throw Error('这不是服务领域名称，请将具体活动或客户行业填入相应维度');const current=[...(domainAliases.get(name)||[])];for(const alias of aliases){const a=String(alias).trim();if(!isDomain(a))throw Error('领域别名不能是具体服务、行业或合同泛称');const owner=domainNames.find(n=>n!==name&&(n===a||(domainAliases.get(n)||[]).includes(a)));if(owner)throw Error('别名已属于领域：'+owner);if(a&&a!==name&&!current.includes(a))current.push(a);}if(!domainNames.includes(name))domainNames.push(name);domainAliases.set(name,current);return name;}

 function cleanTag(value){
  let t=String(value||'').trim().replace(/^(?:一项新的|一项|新的|相关的|相关)/,'').replace(/[。；;]$/,'');
  t=t.replace(/(评估|核查|验证|检查|培训|辅导|咨询|建设|开发|测试|运维|审计|鉴证)服务$/,'$1');
  if(domainNames.includes(t)||/^(?:SOX|业财|内控|风险咨询)(?:咨询|服务|咨询服务)?$/i.test(t))return '';
  if(!t||t.length>28||/^[的、本，,、]|本协议|本合同|本项目|本服务|任何|其他服务|如下|下述|贵公司|我方|乙方|甲方|上述|第.{0,8}条|包括|仅要求|履行|承担|监督|[，,；;]|提供|开展|进行|负责/.test(t))return '';
  const soc=t.replace(/Ⅱ/g,'II').replace(/Ⅰ/g,'I').match(/^SOC\s*([12])\s*Type\s*(II|I|[12])(?:鉴证报告|鉴证|报告)?$/i);if(soc)return `SOC ${soc[1]} Type ${/^(II|2)$/i.test(soc[2])?2:1}鉴证`;
  if(['风险评估辅导','隐私影响评估','处理活动记录'].includes(t))return t;
  if(activities.some(activity=>activity.label===t))return t;
  for(const activity of activities)if(activity.re.test(compact(t))){let label=activity.label;if(['隐私影响评估辅导','处理活动记录辅导'].includes(label)&&!/辅导|方法/.test(t))label=label.replace('辅导','');if(label==='风险评估'&&/辅导|方法/.test(t))label+='辅导';return label;}
  if(/(?:数据|系统|审计|鉴证|风险|安全|隐私|合规|控制|认证|流程|财务|业财|设备|可靠性|权限|迁移|鉴权)/.test(t)&&/(?:咨询|评估|核查|验证|检查|培训|辅导|建设|开发|审计|鉴证|服务|迁移|治理|管理|优化|备份|恢复|测试|分析|建模|评审|设计|运维|鉴权|认证)$/.test(t))return t;
  return '';
 }
 function domainFor(value){const name=canonicalDomain(value);return isDomain(name)?name:'';}
 function normalizeSystem(value){const t=String(value||'').trim();if(/^oracle$/i.test(t))return 'Oracle';return /^(?:sap|erp|dms|crm|rpa)$/i.test(t)?t.toUpperCase():t;}
 function evidenceUnits(source){return units(source).filter(u=>!['personnel','training','training_service','commercial','definition','boundary','goal','background','example'].includes(u.role));}
 function supportsEvidence(source,evidence){const at=source.indexOf(evidence);if(at<0)return false;return evidenceUnits(source).some(u=>u.start<at+evidence.length&&u.start+u.text.length>at);}
 return {analyze,units,evidenceUnits,supportsEvidence,cleanTag,domainFor,domainNames,canonicalDomain,isDomain,registerDomain,normalizeSystem};
})();
