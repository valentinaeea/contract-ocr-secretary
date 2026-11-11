// 关键词精确化回归（2.15.0）。文本均为虚构改写，客户名称为占位符，不含任何真实合同内容。
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const ctx=vm.createContext({console});
for(const f of ['service-content','contract-facts','contract-scope','vault-model'])vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/'+f+'.js'),'utf8'),ctx);
const S=vm.runInContext('ServiceContent',ctx),M=vm.runInContext('VaultModel',ctx);
const kw=text=>Array.from(S.analyze(text).keywords,x=>x.label);

// 1. 管理体系咨询：服务内容分项标题优先；标准补体系名称；去掉句子片段和「进行系统培训」误识别
const iso=[
 '第一条 定义',
 '3. 咨询服务：指乙方向甲方提供的培训、辅导、差距分析等工作。',
 '第三条 服务内容',
 '乙方为甲方提供ISO 27001及ISO 27701认证评估服务，具体包括：',
 'a) 标准解读培训：就标准条款和认证审核关注点进行系统培训。',
 'b) 差距分析服务：对照标准识别甲方现有管理与要求之间的差距。',
 'c) 体系文件建设辅导：协助甲方编写手册、程序和记录模板。',
 'd) 内部审核及管理评审辅导：指导甲方完成一次内部审核。',
 '第四条 甲方义务',
 '1. 配合人员：甲方应安排联系人。'].join('\n');
const a=kw(iso);
for(const k of ['标准解读培训','差距分析','体系文件建设辅导','内部审核及管理评审辅导','ISO 27001','信息安全管理体系','ISO 27701','隐私信息管理体系','认证评估'])assert(a.includes(k),k+' missing: '+a);
for(const k of ['的培训','系统培训','配合人员','ISO 27001及ISO 27701认证评估'])assert(!a.includes(k),k+' should not be a keyword');
assert(a.indexOf('标准解读培训')<a.indexOf('ISO 27001'),'item titles come first');
assert(!S.analyze(iso).services.some(x=>x.label==='系统培训'));

// 2. 鉴证服务：SOC 写法统一，补标准名称；句子不做关键词；表格行描述的客户系统用途不算服务
const soc=[
 '服务范围',
 '我们将依据AICPA的SSAE 18及可信服务标准（TSP Section 100），对贵公司控制设计的恰当性实施类型一检查，并出具SOC2类型一及类型二报告。',
 '本次SOC 2鉴证覆盖以下系统：',
 '1. 示例公司的跨境物流业务系统，包括：订单系统、运输系统、仓储系统；',
 '2. 客户通过“自助平台”提交申请；',
 '序号 数量 用途',
 '1 2，境内境外各一套 提供统一登录服务',
 '服务范围的限制',
 '本次检查不包括财务核算系统及操作系统。'].join('\n');
const r=S.analyze(soc),b=Array.from(r.keywords,x=>x.label),sys=Array.from(r.systems,x=>x.label);
for(const k of ['SOC 2鉴证','SOC 2报告','SOC 2 类型一','SOC 2 类型二','SSAE 18','可信服务标准','AICPA'])assert(b.includes(k),k+' missing: '+b);
assert(!b.some(k=>/^SOC2|检查$/.test(k)),'no raw SOC2 variants or sentences: '+b);
assert(!r.services.some(x=>x.label==='统一登录服务'),'table row is not our service');
for(const k of ['跨境物流业务系统','订单系统','运输系统','仓储系统','自助平台'])assert(sys.includes(k),k+' missing: '+sys);
for(const k of ['财务核算系统','操作系统','以下系统'])assert(!sys.includes(k),k+' should not be a system: '+sys);

// 3. 旧合同：规则更新后关键词刷新；关键词不允许手动修改，旧版手动值也改为自动识别结果
const old={id:'x',rawText:iso,knowledgeProfile:{tagSchemaVersion:3,tagSourceFingerprint:'old',keywords:['的培训'],services:[],specificTags:[],systems:['手动系统']}};
assert(!M.project(old).keywords.includes('的培训'));
assert(M.project(old).systems.includes('手动系统'));
const manual={...old,knowledgeProfile:{...old.knowledgeProfile,keywordsSelectionManual:true,keywords:['自定义词']}};
assert(!M.project(manual).keywords.includes('自定义词'),'manual keywords are no longer kept');assert(M.project(manual).keywords.includes('差距分析'));
console.log('PASS keyword precision: item titles, standards, SOC labels, systems and refresh');
