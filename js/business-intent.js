/** Project content tags from synonyms and combined evidence; never pretend a rule is an LLM. */
const BusinessIntent = (() => {
  function segments(source) {
    const out = [];
    const re = /(?:[^\n。！？；]|\n(?!\s*\n))+[。！？；]?/g;
    let m;
    while ((m = re.exec(source))) {
      const value = m[0].trim();
      if (value.length > 4) out.push(value);
    }
    return out;
  }
  const normalize = text => text.replace(/\s+/g, '').toLowerCase();
  const negative = text => /不涉及|不包括|不包含|不提供|不属于|非本次|未受托|并非|不构成|不以|不会提供|不保证|doesnotinclude|notinscope/.test(text);
  const type2 = /type(?:ii|2)(?![a-z0-9])|类型(?:二|2)|類型(?:二|2)|第二类|第二類|二型/;
  const type1 = /type(?:i|1)(?![a-z0-9])|类型(?:一|1)|類型(?:一|1)|第一类|第一類|一型/;
  function classify(source = '') {
    const tags = new Map();
    function add(code, label, evidence, status, reason) {
      if (!tags.has(code)) tags.set(code, { code, label, status, reason, evidence: [] });
      const item = tags.get(code);
      if (item.evidence.length < 3 && !item.evidence.includes(evidence)) item.evidence.push(evidence);
    }
    for (const evidence of (typeof ServiceContent!=='undefined' ? ServiceContent.evidenceUnits(String(source)).map(u=>u.text) : segments(String(source)))) {
      const t = normalize(evidence);
      if (negative(t)) continue;
      if (/(?:\bipo\b|首次公[开開][发發]行|首[发發]上市|首次上市|赴港上市|上市申[报報]|拟在.{0,35}(?:交[易]?所|香港).{0,25}上市|擬在.{0,35}上市|香港[发發]行上市)/.test(t)) {
        add('IPO_RELATED', 'IPO相关背景 / 上市支持', evidence, '同义或背景命中，需复核服务范围', '识别首次发行、上市申报等业务表达；不据此认定为财务报表审计。');
      }
      const families = [...t.matchAll(/s[o0]c([12])/g)];
      for (let i = 0; i < families.length; i++) {
        const match = families[i], family = match[1];
        const scope = t.slice(match.index + match[0].length, Math.min(t.length, match.index + 180, families[i + 1]?.index ?? Infinity));
        const types = [];
        if (type1.test(scope)) types.push(1);
        if (type2.test(scope)) types.push(2);
        if (types.length) for (const type of types) add(`SOC${family}_TYPE${type}`, `SOC ${family} Type ${type}`, evidence, '原文有明确名称，需核对是否为委托范围', 'SOC家族和报告类型分别识别；SOC 1与SOC 2不合并。');
        else add(`SOC${family}_UNSPECIFIED`, `SOC ${family}（本条未明确类型）`, evidence, '类型待确认', '仅发现SOC家族名，不能自行补成Type 2。');
      }
      if (!families.some(m => m[1] === '1') && /服务机构|服務機構|serviceorganization/.test(t) && /财务报告|財務報告|icfr/.test(t) && /控制|control/.test(t) && /鉴证|鑒證|审验|審驗|examination|assurance/.test(t)) {
        const operating = /运行有效性|運行有效性|执行有效性|執行有效性|operatingeffectiveness/.test(t);
        add(operating ? 'SOC1_RELATED_TYPE2_CANDIDATE' : 'SOC1_RELATED_CANDIDATE', operating ? 'SOC 1相关鉴证（Type 2候选）' : 'SOC 1相关财务报告控制鉴证候选', evidence, '按业务含义推断，必须人工确认', '服务机构、财务报告控制及鉴证目标组合命中；不等于原文明确承诺SOC 1报告。');
      }
      if (/isae3402/.test(t) && !families.some(m => m[1] === '1')) {
        add('SOC1_RELATED_CANDIDATE', 'SOC 1相关财务报告控制鉴证候选', evidence, '相关准则线索，必须核对报告名称', 'ISAE 3402不能直接改写成合同明确约定SOC 1报告。');
      }
      const dataName = /数据核查|數據核查|数据核验|數據核驗|数据验证|数据评估|业财一致性|業財一致性|账实核对|数据质量|数据真实性/.test(t);
      const dataMeaning = /数据|數據|订单|訂單|账单|賬單/.test(t) && /核对|核對|检查|檢查|校验|比对|比對|评估/.test(t) && /一致性|完整性|准确性|準確性|金额差异|金額差異/.test(t);
      if ((dataName || dataMeaning) && !/仅.*数据安全|只.*数据安全/.test(t)) add('DATA_REVIEW', '数据核查 / 数据质量与业财核对', evidence, dataName ? '名称或同义表达命中，需复核范围' : '按检查内容归类，需人工确认', '识别数据核验、业财一致性、跨系统准确完整性检查；与单纯数据保密条款区分。');
      if (/itgc|信息(?:系统|技术)一般控制/.test(t) || (/变更管理/.test(t) && /访问管理|运维管理/.test(t))) add('ITGC', 'ITGC / 信息系统一般控制', evidence, '候选业务范围，需复核', '访问、变更、运维控制组合或一般控制名称命中。');
      if (/itac|应用控制|應用控制|自动化控制/.test(t)) add('ITAC', 'ITAC / 应用控制', evidence, '候选业务范围，需复核', '识别应用控制及自动化控制表述。');
      if (/iso(?:\/iec)?(?:27001|27701)/.test(t) && /认证准备|认证评估|培训|辅导|差距分析/.test(t)) add('ISO_PREPARATION', 'ISO管理体系评估 / 认证准备', evidence, '候选服务范围，需复核', '识别评估、培训及认证准备；不代表保证获得认证。');
    }
    // Prefer a specific type when the same document also has untyped references.
    for (const family of [1, 2]) if (tags.has(`SOC${family}_TYPE1`) || tags.has(`SOC${family}_TYPE2`)) tags.delete(`SOC${family}_UNSPECIFIED`);
    return [...tags.values()];
  }
  function forContract(contract) {
    if(typeof AnalysisResults!=='undefined'&&AnalysisResults.managed(contract))return AnalysisResults.get(contract,'businessTags',()=>[]);
    const source=typeof ContractScope!=='undefined'?ContractScope.textFor(contract):(contract.rawText||'');
    const rules = classify(source);
    const semantics = (contract.semanticTags || []).filter(tag => {
      if(typeof ServiceContent!=='undefined' && !(tag.evidence||[]).some(text=>ServiceContent.supportsEvidence(source,text)))return false;
      if(typeof ServiceContent!=='undefined'){
        const context=normalize(ServiceContent.evidenceUnits(source).map(u=>u.text).join('；'));
        if(tag.code==='SEM_SOC1_RELATED'&&!/s[o0]c1|isae3402|服务机构.{0,100}财务报告|财务报告.{0,100}服务机构/.test(context))return false;
        if(tag.code==='SEM_SOC2_RELATED'&&!/s[o0]c2|可信服务|信任服务|trustservices|\btsc\b/.test(context))return false;
        if(tag.code==='SEM_DATA_REVIEW'&&(!/数据|账单|订单|交易/.test(context)||!/核对|核验|验证|勾稽|对账|比对/.test(context)))return false;
        if(tag.code==='SEM_ISO_PREPARATION'&&!/iso|认证准备|认证辅导|管理体系/.test(context))return false;
      }
      if (tag.code === 'SEM_IPO_RELATED') return !rules.some(r => r.code === 'IPO_RELATED');
      if (tag.code === 'SEM_DATA_REVIEW') return !rules.some(r => r.code === 'DATA_REVIEW');
      if (tag.code === 'SEM_ISO_PREPARATION') return !rules.some(r => r.code === 'ISO_PREPARATION');
      if (tag.code === 'SEM_SOC1_RELATED') return !rules.some(r => r.code.startsWith('SOC1'));
      if (tag.code === 'SEM_SOC2_RELATED') return !rules.some(r => r.code.startsWith('SOC2'));
      return true;
    });
    return [...rules, ...semantics];
  }
  return { classify, forContract };
})();
