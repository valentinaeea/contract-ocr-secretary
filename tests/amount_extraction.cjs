const fs=require('fs'),vm=require('vm'),assert=require('assert');const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('js/extractor.js','utf8'),ctx);const E=vm.runInContext('Extractor',ctx);
const cases=[
['第二期服务费为人民币5.4万元。',0],
['第二期支付合同金额的30%服务费人民币54000元。',0],
['合同总金额为人民币180,000元，分三期付款：第一期50%即90,000元，第二期30%即人民币54,000元，第三期20%即36,000元。',180000],
['合同总价：18万元。\n第二期支付人民币54,000元。',180000],
['合同总金额\n人民币180,000元（含税）。\n第二期合同总金额的30%，即人民币54,000元。',180000],
['第二期为合同总金额的30%，即人民币54,000元。',0],
['合同总价：人民币壹拾捌万元整。第二期：伍万肆仟元整。',180000],
['含税总价：180000\n第一期：90,000元\n第二期：54,000元',180000],
['服务费用合计18万元，第二期支付5.4万元。违约金为100万元。',180000],
['合同金额为１８０，０００元；赔偿金为人民币1,000,000元。',180000],
['违约金18万元，保证金5万元。',0],
['服务费人民币120,000.25元。',120000.25],
['合同总价：18万元。违约金为合同总金额的200%，即36万元。',180000],
['本合同服务费为18万元，按三期支付：50%为9万元，30%为5.4万元，20%为3.6万元。',180000]
];for(const[t,w]of cases)assert.equal(E.extractAmount(t),w,t);
const c={id:'synthetic',rawText:cases[2][0],amount:54000,reviewerNotes:'keep',knowledgeProfile:{notes:'keep'}};const repaired=E.repairAmount(c);assert.equal(repaired.amount,180000);assert.equal(repaired.previousAutomaticAmount,54000);assert.equal(repaired.reviewerNotes,'keep');assert.equal(repaired.knowledgeProfile.notes,'keep');assert.equal(repaired.knowledgeProfile.amount,18);assert.strictEqual(E.repairAmount({...c,manualFieldsEditedAt:1}).amount,54000);const partial={...c,rawText:'第二期服务费为人民币5.4万元。'};assert.strictEqual(E.repairAmount(partial),partial);console.log('PASS total vs installments, Chinese numerals, OCR wraps, liability exclusion and safe legacy repair');
