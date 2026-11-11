/** 编辑弹窗（原合同整理与标签管理）保存模型：不改金额、写回甲乙方/签约时间/服务目的、关键词与 Tag 只读（自动识别），保留自定义系统。 */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const ctx=vm.createContext({});for(const f of['service-content','contract-facts','vault-model'])vm.runInContext(fs.readFileSync('js/'+f+'.js','utf8'),ctx);
const M=vm.runInContext('VaultModel',ctx);
const c={id:'edit-merge',projectName:'旧名称',partyA:'旧甲方',partyB:'旧乙方',signDate:'2026-01-01',amount:123456.789,auditPurpose:'',rawText:'服务内容：提供SOX内控测试和ITGC评估，涉及SAP系统。',ocrRevision:'r1'};
const p=M.project(c);
const next={...p,name:'新名称',partyA:'新甲方',partyB:'新乙方',signDate:'2026-02-02',auditPurpose:'帮助客户满足上市内控要求',keywords:[...p.keywords,'自定义关键词'],keywordsSelectionManual:true,specificTags:['手动标签'],services:['SOX','内控','风险咨询'],systems:[...p.systems,'Workday']};
delete next.amount;delete next.enterpriseSize;
const saved=M.update(c,next);
assert.equal(saved.amount,c.amount,'amount untouched when the dialog has no amount field');
assert.equal(saved.amountManuallyEdited,undefined);
assert.equal(saved.projectName,'新名称');assert.equal(saved.partyA,'新甲方');assert.equal(saved.partyB,'新乙方');assert.equal(saved.signDate,'2026-02-02');
assert.equal(saved.auditPurpose,'帮助客户满足上市内控要求');assert.equal(saved.auditPurposeNeedsReview,false);
for(const k of['partyA','partyB','signDate','auditPurpose','enterpriseSize'])assert(!(k in saved.knowledgeProfile)||k==='enterpriseSize'&&saved.knowledgeProfile[k]===undefined,k+' must not be copied into knowledgeProfile');
const after=M.project(saved);
assert(!after.keywords.includes('自定义关键词'),'keywords cannot be edited manually');assert.deepEqual(Array.from(after.keywords),Array.from(p.keywords));assert.deepEqual(Array.from(after.specificTags),Array.from(p.specificTags));assert.deepEqual(Array.from(after.services),Array.from(p.services));assert(!saved.knowledgeProfile.keywordsSelectionManual);assert(after.systems.includes('Workday'));assert(after.systems.includes('SAP'));
const fields=saved.manualEditHistory.at(-1).changes.map(x=>x.field);for(const f of['projectName','partyA','partyB','signDate','auditPurpose','knowledgeProfile'])assert(fields.includes(f),f);assert(!fields.includes('amount'));
// 搜索可命中自定义关键词与系统
assert.equal(M.search([after],{q:'自定义关键词'}).direct.length,0);assert.equal(M.search([after],{q:'Workday'}).direct.length,1);
// 仍兼容带金额的旧调用
assert.equal(M.update(c,{...p,amount:'20'}).amount,200000);
console.log('PASS edit dialog keeps amount, saves identity fields, read-only keywords/tags, custom systems, records history');
