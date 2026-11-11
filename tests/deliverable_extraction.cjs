const fs=require('fs'),vm=require('vm'),assert=require('assert');const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('js/extractor.js','utf8'),ctx);const E=vm.runInContext('Extractor',ctx);
// Synthetic clauses modelled on the reported failure: "成果" in a termination clause must not win.
const termination='第八条 合同解除\n有下列情形之一的，甲方有权解除合同并要求乙方返还已支付费用及工作成果\nd) 乙方被吊销营业执照、丧失履约能力、进入破产清算程序或出现重大信用风险\n';
assert.equal(E.extractDeliverables(termination),'');
assert.equal(E.extractDeliverables(termination+'第四条 交付成果\n乙方应向甲方交付《ISO 27001差距分析报告》及整改建议清单。'),'乙方应向甲方交付《ISO 27001差距分析报告》及整改建议清单');
assert.equal(E.extractDeliverables(termination+'交付物：差距评估报告、风险评估报告'),'差距评估报告、风险评估报告');
assert.equal(E.extractDeliverables('项目结束后，乙方出具信息安全管理体系评估报告。\n'+termination),'信息安全管理体系评估报告');
assert.equal(E.extractDeliverables('第九条 知识产权\n本项目工作成果的知识产权归甲方所有\n未经同意，任何一方不得向第三方披露。'),'');
assert.equal(E.extractDeliverables('保密条款：未经同意不得向第三方提供报告。'),'');
console.log('PASS deliverables ignore termination, IP and confidentiality clauses and prefer real outputs');
