const fs=require('fs'),vm=require('vm'),assert=require('assert'),ctx=vm.createContext({});vm.runInContext(fs.readFileSync('js/extractor.js','utf8'),ctx);const E=vm.runInContext('Extractor',ctx);
for(const [text,want]of[
 ['Synthetic ITGC Assurance Service Agreement\nScope of services:\nWe will perform ITGC testing.','Synthetic ITGC Assurance Service Agreement'],
 ['评估服务合同 深圳 项目名称：ISO 27001:2022评估服务','ISO 27001:2022评估服务'],
 ['项目名称：ISO 27001:2022 & ISO 27701:2025评估服务\n甲方：示例科技有限公司','ISO 27001:2022 & ISO 27701:2025评估服务'],
 ['项目名称：\n信息系统及数据\n评估服务\n甲方：示例科技有限公司','信息系统及数据评估服务'],
 ['项 目 名 称：\nSOC 1 Type 2鉴证服务\n合同金额：18万元','SOC 1 Type 2鉴证服务'],
 ['关于：信息系统及数据评估服务之业务协议\n敬启者：','信息系统及数据评估服务之业务协议'],
 ['关于：信息系统及数据评估\n服务之业务协议\n我们将提供服务。','信息系统及数据评估服务之业务协议'],
 ['示例科技有限公司\nSOC 2 Type II\n鉴证服务合同\n2026年7月','SOC 2 Type II鉴证服务合同'],
 ['ISO 27001:2022 & ISO 27701:2025\n评估服务合同\n甲方：示例科技有限公司','ISO 27001:2022 & ISO 27701:2025评估服务合同'],
 ['合同名称：数据迁移核查服务合同\n合同编号：A001','数据迁移核查服务合同'],
 ['服务范围：开展ITGC测试。\n本合同由双方签订。',''],
 ['项目名称：\n甲方：示例科技有限公司\n合同金额：180000元',''],
 ['我们按照合同要求提供信息系统评估服务。',''],
 ['第一条 数据核查服务\n双方应当履行合同义务。',''],
 ['项目名称：待定\n合同编号：X1','']
])assert.equal(E.extractProjectName(text),want,text);
for(const [text,want]of[
 ['甲方：示例科技有限公司','示例科技有限公司'],
 ['示例咨询有限公司十分感谢示例科技有限公司（以下简称“贵公司”）选用我们的服务。','示例科技有限公司'],
 ['甲方：示例电子科技有限\n公司\n乙方：示例咨询有限公司','示例电子科技有限公司'],
 ['甲方：安永已提供的服务所应支付费用的义务\n甲方：示例科技有限公司','示例科技有限公司'],
 ['（甲方）安永已提供的服务所应支付费用的义务',''],
 ['甲方：示例研发与技术有限公司','示例研发与技术有限公司'],
 ['甲方：张三','张三']
])assert.equal(E.extractPartyA(text),want,text);
assert.equal(E.extractPartyB('受托方（乙方）：示例（中国）企业咨询有限公司深圳分公司'),'示例（中国）企业咨询有限公司深圳分公司');
const record={id:'synthetic',projectName:'未识别项目',partyA:'安永已提供的服务所应支付费用的义务',rawText:'关于：信息系统评估服务之业务协议\n甲方：示例科技有限公司',amount:180000,reviewerNotes:'keep'};const repaired=E.repairIdentity(record);assert.equal(repaired.projectName,'信息系统评估服务之业务协议');assert.equal(repaired.partyA,'示例科技有限公司');assert.equal(repaired.previousAutomaticIdentity.projectName,'未识别项目');assert.equal(repaired.rawText,record.rawText);assert.equal(repaired.reviewerNotes,'keep');assert.strictEqual(E.repairIdentity({...record,manualFieldsEditedAt:1}).projectName,'未识别项目');console.log('PASS project name fields, wrapped cover/subject headings, blank boundaries, party clause rejection and safe automatic repairs');

const subject='示例云端科技（集团）有限公司之SOC2类型一及类型二报告鉴证服务业务约定书';
for(const raw of [
 '敬启者：\n关于：'+subject+'\n我们将提供服务。',
 '敬启者：\n关 于：\n示例云端科技（集团）有限\n公司之SOC2类型一及类型二报告鉴证服务\n业务约定书\n我们将提供服务。',
 '关　于﹕'+subject+'\n服务范围：其他说明。',
 '关于：示例云端科技（集团）有限公司之SOC2类型一及类型二报告鉴证服务\n业务约定书\n我们感谢贵公司。'
])assert.equal(E.extractProjectName(raw),subject,raw);
assert.equal(E.extractProjectName('Review service agreement\nScope of services:'),'Review service agreement');
assert.equal(E.extractProjectName('关于：\n我们将提供服务。\n服务范围：ITGC。'),'');
assert.equal(E.extractProjectName('关于：一般事项\n合同金额：180000元'),'');
const competing='项目名称：信息系统服务项目\n关于：'+subject+'\n我们将提供服务。';
assert.equal(E.extractProjectName(competing),'信息系统服务项目');
assert.equal(E.extractProjectName(competing,undefined,{preferSubject:true}),subject);
const oldEy={id:'legacy-ey',uploadCategory:'ey-template',identityExtractionVersion:2,projectName:'未识别项目',rawText:'关于：'+subject,reviewerNotes:'keep',knowledgeProfile:{customTags:['keep']}};
const fixedEy=E.repairIdentity(oldEy);assert.equal(fixedEy.projectName,subject);assert.equal(fixedEy.identityExtractionVersion,4);assert.equal(fixedEy.reviewerNotes,'keep');assert.deepEqual(fixedEy.knowledgeProfile,oldEy.knowledgeProfile);
assert.equal(E.repairIdentity({...oldEy,manualFieldsEditedAt:1}).projectName,'未识别项目');
console.log('PASS EY subject priority, business engagement-letter suffix, wrapped/standalone/spaced headings, body rejection and legacy automatic repair');

// 折行的单位名称：前半段在标签上一行，或标签后只有前半段。
for(const [text,a,b] of [
 ['广东丸美生物\n甲方：技术股份有限公司\n安永（中国）企业咨询\n乙方：有限公司','广东丸美生物技术股份有限公司','安永（中国）企业咨询有限公司'],
 ['甲方：广东丸美生物\n技术股份有限公司\n乙方：安永（中国）企业咨询有限公司','广东丸美生物技术股份有限公司','安永（中国）企业咨询有限公司'],
 ['深圳顺丰泰森\n甲方：控股（集团）有限公司\n乙方：安永（中国）企业咨询有限公司','深圳顺丰泰森控股（集团）有限公司','安永（中国）企业咨询有限公司'],
 ['信息系统评估服务协议\n甲方：科技有限公司','科技有限公司',''],
 ['甲方：张三\n乙方：安永（中国）企业咨询有限公司','张三','安永（中国）企业咨询有限公司'],
])assert.deepEqual([E.extractPartyA(text),E.extractPartyB(text)],[a,b],text);
// 已保存的旧结果：只替换为包含它的完整名称；手工编辑过的不动。
const wrapped={id:'w',identityExtractionVersion:3,partyA:'技术股份有限公司',partyB:'安永（中国）企业咨询有限公司',rawText:'广东丸美生物\n甲方：技术股份有限公司\n乙方：安永（中国）企业咨询有限公司'};
const wrappedFix=E.repairIdentity(wrapped);assert.equal(wrappedFix.partyA,'广东丸美生物技术股份有限公司');assert.equal(wrappedFix.partyB,wrapped.partyB);assert.equal(wrappedFix.identityExtractionVersion,4);assert.equal(wrappedFix.previousAutomaticIdentity.partyA,'技术股份有限公司');
assert.equal(E.repairIdentity({...wrapped,manualFieldsEditedAt:'x'}).partyA,'技术股份有限公司');
assert.equal(E.repairIdentity(wrappedFix),wrappedFix);
console.log('PASS wrapped company names across lines, one-time repair of saved fragments');
