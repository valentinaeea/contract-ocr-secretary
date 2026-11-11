/** Offline clause retrieval for audit review. No trained model or accounting conclusions. */
const AuditReview = (() => {
  const definitions = [
    { key: 'purpose', label: '合同服务目的', question: '签订合同希望实现什么目标？', words: ['服务目的', '项目目的', '合同目的', '旨在', '目的在于', '目的为', '目的：', '目的:', '为了', '以便', '以期', '从而', '拟开展', '为贵公司提供', '为甲方提供', '我们只是为贵公司'], hint: '核实服务目标与实际业务需求是否一致。' },
    { key: 'scope', label: '服务范围与内容', question: '谁向谁提供什么服务？', words: ['服务范围', '服务内容', '工作内容', '项目内容', '提供服务', '实施检查', '提供合理保证', '技术支持', '软件开发', '委托乙方', '乙方向甲方'], hint: '核对服务内容、承接方和实际交付记录。' },
    { key: 'exclusions', label: '范围限制与排除事项', question: '哪些系统、机构或事项不包含在服务中？', words: ['不纳入', '不包括', '不包含', '排除', '不在本', '不属于', '范围限制'], hint: '关注范围是否覆盖需要依赖的业务或控制。' },
    { key: 'period', label: '服务期间与截止', question: '覆盖哪一段期间，何时交付？', words: ['服务期限', '服务期间', '合同期限', '合同有效期', '项目周期', '交付日期', '交付时间', '止期间', '起至', '生效之日'], hint: '核对服务所属期间及跨期事项；日期需人工核对。' },
    { key: 'acceptance', label: '交付成果与验收', question: '交付什么，怎样证明完成？', words: ['交付物', '交付成果', '成果文件', '出具报告', '报告交付', '验收标准', '验收', '成果提交', '检查报告'], hint: '将约定成果与验收记录、报告或履约证据核对。' },
    { key: 'payment', label: '金额与付款条件', question: '如何计费，何时付款，是否以验收为条件？', words: ['合同金额', '合同总价', '服务费用', '服务费', '付款', '支付', '预付款', '结算', '税率', '发票'], hint: '核对计价、税额、付款条件及实际支付；不自动判断收入确认。' },
    { key: 'responsibility', label: '双方职责与配合', question: '各方分别承担什么责任？', words: ['甲方应', '乙方应', '贵公司负责', '双方责任', '甲方责任', '乙方责任', '管理层责任', '提供资料', '负责'], hint: '核对责任主体及客户配合义务。' },
    { key: 'security', label: '数据、保密与访问', question: '数据和访问权限如何受到保护？', words: ['保密', '个人信息', '数据安全', '数据泄露', '访问权限', '数据返还', '数据销毁', '源代码'], hint: '结合访问、保密、数据处理和退出安排复核。' },
    { key: 'ai_data_use', label: '数据用途与 AI 训练限制', question: '资料是否允许用于模型训练、知识库或项目之外？', words: ['训练人工智能模型', '人工智能训练', '模型训练', '非本项目', '建立乙方知识库', '公开AI工具', '资料或数据用于训练'], hint: '核对允许用途与禁止用途，不得把数据使用限制归纳成合同服务目的。' },
    { key: 'outsourcing', label: '外包、服务等级与审计权', question: '第三方服务是否可依赖、可检查？', words: ['分包', '子服务机构', '服务等级', '可用性', 'SLA', '审计权', 'SOC', 'ISAE', 'SSAE', '鉴证'], hint: '关注子服务机构、可用性约定及审计或鉴证范围。' },
    { key: 'liability', label: '违约、终止与承诺', question: '违约后果、终止及其他承诺是什么？', words: ['违约', '赔偿', '责任上限', '终止', '解除', '担保', '不可撤销', '自动续期'], hint: '核对赔偿、终止条件、重大承诺及潜在争议。' }
  ];
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = word => new RegExp([...word].map(escapeRegex).join('\\s*'), 'i');
  const rules = definitions.map(d => ({ ...d, patterns: d.words.map(pattern) }));
  function clauses(text) {
    // Preserve source offsets into corrected full text. Excerpts are exact substrings.
    const out = [];
    const re = /(?:[^\n。！？；]|\n(?!\s*\n))+[。！？；]?/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      // OCR wraps visual lines. Merge within a sentence, retaining exact source offsets.
      // Bound long unpunctuated tables to windows; do not drop content silently.
      for (let offset = 0; offset < match[0].length; offset += 1200) {
        const part = match[0].slice(offset, offset + 1200);
        const leading = part.length - part.trimStart().length;
        const value = part.trim();
        if (value.length >= 5) out.push({ text: value, start: match.index + offset + leading, end: match.index + offset + leading + value.length });
      }
    }
    return out;
  }
  function analyze(text = '') {
    const source = String(text);
    const lines = clauses(source);
    return rules.map(rule => {
      const candidates = lines.map((line, index) => {
        const compact = line.text.replace(/\s+/g, '');
        let count = rule.patterns.filter(re => re.test(line.text)).length;
        if (rule.key === 'purpose') {
          // Intent must describe the commissioned work, rather than data use or restrictions.
          const hasWork = /(?:检查|鉴证|评估|认证|分析|培训|辅导|开发|建设|实施|审计|审阅|咨询|服务|保证)/.test(compact);
          const restriction = /(?:不得|不以|并非|不构成|不会|并未|不适用于|无需)/.test(compact);
          const administrative = /(?:目的使用.*资料|用于.*(?:知识库|人工智能模型)|(?:信息|资料|交付物)不得|为履行本合同之目的|为了监控和管理这些风险|本服务是否满足贵公司目的)/.test(compact);
          const context = source.slice(0, line.start).replace(/[ \t\r]/g, '');
          const headings = [...context.matchAll(/(?:^|\n)(?:第[一二三四五六七八九十]+条)?(服务范围的限制|本服务的局限性|贵公司的具体责任|甲方的权利和义务|乙方的权利和义务|保密义务|服务范围|服务内容|鉴于|交付成果|时间表|服务费用|使用和披露我们的交付物|与联席保荐人沟通)(?=\n|$)/g)];
          const section = headings.length ? headings[headings.length - 1][1] : '';
          const wrongSection = /责任|权利和义务|保密|限制|局限/.test(section);
          const incidental = /(?:遗漏或误报|被视为重大事项|独立承包商|十分感谢|选用我们|选用安永)/.test(compact);
          if (!hasWork || restriction || administrative || wrongSection || incidental) count = 0;
          else {
            if (/(?:拟开展|旨在|服务目的|项目目的|目的在于|我们只是为贵公司)/.test(compact)) count += 5;
            if (/(?:从而|以便|以期)/.test(compact) && /(?:保证|实现|达到)/.test(compact)) count += 3;
            if (/(?:将为|愿意为|向甲方提供|为甲方提供|为贵公司提供).*(?:评估|鉴证|咨询|培训|开发|服务)/.test(compact)) count += 2;
          }
        }
        // A bare section heading carries too little evidence: include its next line.
        let evidence = line;
        if (rule.key === 'purpose' && count) {
          const anchor = /甲方\s*拟\s*开展|我们\s*只是\s*为贵公司|我们\s*将\s*为贵公司|(?:安永|乙方)(?:\s*将)?(?:\s*为|\s*向|\s*具备)|从而\s*为实现/.exec(line.text);
          if (anchor) {
            const lineStart = line.text.lastIndexOf('\n', anchor.index) + 1;
            const trim = line.text.slice(lineStart).length - line.text.slice(lineStart).trimStart().length;
            const start = line.start + lineStart + trim;
            evidence = { ...line, start, text: source.slice(start, line.end) };
          }
        }
        if (count && line.text.length < 22 && /[:：]$/.test(line.text) && lines[index + 1]) {
          evidence = { ...line, end: lines[index + 1].end, text: source.slice(line.start, lines[index + 1].end) };
        }
        return { ...evidence, score: count };
      }).filter(c => c.score > 0).sort((a,b) => b.score - a.score || a.start - b.start);
      const selected = [];
      for (const c of candidates) {
        if (!selected.some(x => c.start < x.end && x.start < c.end)) selected.push(c);
        if (selected.length === 3) break;
      }
      selected.sort((a,b) => a.start - b.start);
      return { key: rule.key, label: rule.label, question: rule.question, hint: rule.hint,
        status: selected.length ? '已提取' : '未提取',
        evidence: selected.map(({text,start,end}) => ({text,start,end})) };
    });
  }
  function forContract(contract){
    if(typeof AnalysisResults!=='undefined'&&AnalysisResults.managed(contract))return AnalysisResults.get(contract,'auditFields',()=>[]);
    const scope=typeof ContractScope!=='undefined'?ContractScope.resolve(contract):{text:contract.rawText||'',start:0};
    const serviceKeys=new Set(['purpose','scope','exclusions','period','acceptance']);
    return analyze(scope.text).filter(f=>contract.uploadCategory!=='ey-template'||(serviceKeys.has(f.key)&&f.evidence.length)).map(f=>({...f,evidence:f.evidence.map(e=>({...e,start:e.start+scope.start,end:e.end+scope.start}))}));
  }
  function summaryFor(contract) {
    if (contract.serviceSummary?.trim()) return { text: contract.serviceSummary.trim(), source: '人工编辑' };
    if (contract.auditPurpose?.trim()) return { text: DocumentView.readable(contract.auditPurpose), source: '人工编辑' };
    if(typeof AnalysisResults!=='undefined'&&AnalysisResults.managed(contract))return AnalysisResults.get(contract,'summary',()=>({text:'',source:''}));
    const source = typeof ContractScope!=='undefined'?ContractScope.textFor(contract):contract.rawText||'';
    const tags = BusinessIntent.classify(source);
    const codes = new Set(tags.map(tag => tag.code));
    const parts = [];
    const content=typeof ServiceContent!=='undefined'?ServiceContent.analyze(source):null;
    const scopes = [];
    if (codes.has('ITGC')) {
      const evidence = tags.find(t => t.code === 'ITGC').evidence.join('').replace(/\s+/g, '');
      const controls = [['变更管理', /变更管理/], ['逻辑访问管理', /逻辑访问|访问管理/], ['运维管理', /运维管理/]].filter(([,re]) => re.test(evidence)).map(([name]) => name);
      scopes.push('评估信息系统一般控制' + (controls.length ? '，覆盖' + controls.join('、') : ''));
    }
    if (codes.has('ITAC')) scopes.push('评估业务流程中的应用控制');
    if (codes.has('DATA_REVIEW')) scopes.push('检查业务数据质量及跨系统数据的一致性');
    for (const tag of tags.filter(t => /^SOC[12]_TYPE[12]$/.test(t.code))) scopes.push('开展 ' + tag.label + ' 控制鉴证');
    if (codes.has('ISO_PREPARATION')) scopes.push('开展管理体系评估和认证准备');
    if (codes.has('IPO_RELATED')) parts.push('项目背景：涉及首次发行或上市安排。');
    if(content?.services.length){const labels=[...new Set([...scopes.filter(text=>/一般控制|应用控制|跨系统|SOC/.test(text)),...content.services.map(x=>x.label)])];parts.push('工作内容：'+labels.join('；')+'。');}
    else if (scopes.length) parts.push('工作内容：' + scopes.join('；') + '。');
    if(content?.goals.length)parts.unshift('客户目标：'+[...new Set(content.goals.map(x=>x.label))].join('；'));
    if(content?.training.length)parts.push('培训主题：'+[...new Set(content.training.map(x=>x.label))].join('、')+'。');
    if(content?.deliverables.length)parts.push('交付成果：'+[...new Set(content.deliverables.map(x=>x.label))].join('；')+'。');
    const purpose = analyze(source).find(field => field.key === 'purpose');
    const purposeText = purpose.evidence.map(e => e.text.replace(/\s+/g, '')).join('');
    const targets = [];
    if (/内部(?:评估|使用|管理)/.test(purposeText)) targets.push('支持客户内部评估和管理');
    if (/信息系统.*内部控制|信息系统控制/.test(purposeText)) targets.push('评价信息系统控制');
    if (/运营数据质量|数据质量/.test(purposeText)) targets.push('评价运营数据质量');
    if (targets.length) parts.unshift('服务目标：' + targets.join('，') + '。');
    const report = /(?:出具|提交|交付)([^。；\n]{0,45}(?:评估报告|鉴证报告|检查报告|报告))/.exec(source.replace(/(?<![。；])\n(?!\n)/g, ''));
    if (report && !content?.deliverables.length) {
      const title = report[1].replace(/^.*(?:并|将|一份|相关)/, '').trim();
      if (title && title.length <= 45) parts.push('交付成果：' + title + '。');
    }
    if (!parts.length) {
      const name = (contract.projectName || '').trim();
      if (name && !/^[a-f\d]{20,}$/i.test(name) && !/\.pdf$/i.test(name)) parts.push('项目：' + name + '。');
    }
    return { text: parts.join('\n') || '暂无服务摘要，可点击“编辑摘要”填写。', source: '按合同内容整理' };
  }
  function purposeFor(contract) {
    if (contract.auditPurpose) return { text: DocumentView.readable(contract.auditPurpose), status: '人工编辑' };
    return { text: summaryFor(contract).text, status: '服务摘要' };
  }
  function toCSV(contracts) {
    const headers = ['来源文件', '项目名称', '甲方', '乙方', '合同服务摘要', '目的归纳状态', '审计要点', '审计问题', '原文依据', '条款识别状态', '复核关注', '业务内容归类', '业务归类依据', '人工分类与复核结论', '分类复核笔记', '合同复核笔记','实际服务活动','培训主题','人员要求','商务与数据使用约定','服务边界','涉及系统','客户行业','服务领域'];
    const cell = value => {
      let text = String(value ?? '');
      // Prevent spreadsheet formulas in untrusted contract text.
      if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const rows = [headers];
    for (const c of contracts) {
      const purpose = purposeFor(c);
      const content=typeof AnalysisResults!=='undefined'?AnalysisResults.get(c,'content',()=>ServiceContent.analyze(ContractScope.textFor(c))):typeof ServiceContent!=='undefined'?ServiceContent.analyze(typeof ContractScope!=='undefined'?ContractScope.textFor(c):c.rawText||''):null;
      const contentText=key=>content?[...new Set(content[key].map(item=>item.label))].join('；'):'';
      for (const f of forContract(c)) {
        rows.push([c.sourceFile, c.projectName, c.partyA, c.partyB, purpose.text, purpose.status, f.label, f.question, f.evidence.map(e => e.text).join('\n'), f.status, f.hint, BusinessIntent.forContract(c).map(tag => tag.label.replace(/（[^）]*候选[^）]*）/g, '')).join('\n'), BusinessIntent.forContract(c).map(tag => tag.label.replace(/（[^）]*候选[^）]*）/g, '') + '：' + tag.evidence.map(text => DocumentView.readable(text)).join('；')).join('\n'), Object.entries(c.businessReview || {}).map(([code, r]) => (r.label || code) + '：' + (r.status === '待复核' ? '已识别' : r.status)).join('\n'), Object.entries(c.businessReview || {}).map(([code, r]) => (r.label || code) + '：' + (r.note || '')).join('\n'), c.reviewerNotes || '',contentText('services'),contentText('training'),contentText('personnel'),contentText('commercial'),contentText('boundaries'),contentText('systems')||'未提及',contentText('industry')||'未提及',content?content.domains.map(item=>item.label+'：'+item.status).join('；'):'']);
      }
    }
    return rows.map(row => row.map(cell).join(',')).join('\r\n');
  }
  return { analyze, forContract, purposeFor, summaryFor, definitions, toCSV };
})();
