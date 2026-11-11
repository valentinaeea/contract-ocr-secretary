/**
 * 关键字分析池
 * - 维护一个分组的关键字池（本地 IndexedDB 保存）
 * - 在每份合同的「识别全文」中查找关键字（容忍 OCR 产生的空格），统计命中合同数 / 出现次数
 * - 「按关键字」「按合同」两种视图，命中处显示上下文并高亮
 */
const KeywordPool = (() => {

  const DEFAULT_POOL = [
  {
    "group": "收入确认与履约",
    "words": [
      "履约义务",
      "收入确认",
      "控制权转移",
      "履约进度",
      "交付",
      "验收",
      "退货",
      "退款",
      "可变对价",
      "质保"
    ]
  },
  {
    "group": "采购付款与结算",
    "words": [
      "预付款",
      "进度款",
      "尾款",
      "付款条件",
      "结算",
      "发票",
      "含税",
      "不含税",
      "税率",
      "质保金",
      "保证金",
      "对账"
    ]
  },
  {
    "group": "期间与截止性",
    "words": [
      "签订日期",
      "生效日期",
      "交付日期",
      "验收日期",
      "服务期限",
      "付款期限",
      "自动续期",
      "补充协议"
    ]
  },
  {
    "group": "关联方与授权审批",
    "words": [
      "关联方",
      "关联交易",
      "实际控制人",
      "授权",
      "审批",
      "签字",
      "盖章",
      "法定代表人",
      "授权委托书"
    ]
  },
  {
    "group": "资产与租赁",
    "words": [
      "租赁",
      "使用权",
      "租赁期限",
      "租金",
      "所有权",
      "固定资产",
      "无形资产",
      "知识产权",
      "资本化"
    ]
  },
  {
    "group": "或有事项与承诺",
    "words": [
      "担保",
      "抵押",
      "质押",
      "赔偿",
      "违约金",
      "滞纳金",
      "诉讼",
      "仲裁",
      "承诺",
      "不可撤销",
      "单方解除"
    ]
  },
  {
    "group": "IT访问权限与职责分离",
    "words": [
      "账号",
      "权限",
      "特权账号",
      "离职",
      "权限审批",
      "职责分离",
      "身份认证",
      "访问控制",
      "定期审阅"
    ]
  },
  {
    "group": "IT变更与运行管理",
    "words": [
      "变更申请",
      "测试",
      "上线审批",
      "开发",
      "生产环境",
      "批处理",
      "接口",
      "对账",
      "异常处理",
      "备份",
      "恢复",
      "灾备"
    ]
  },
  {
    "group": "外包服务与数据安全",
    "words": [
      "服务等级",
      "SLA",
      "可用性",
      "服务中断",
      "保密",
      "个人信息",
      "数据安全",
      "数据泄露",
      "分包",
      "审计权",
      "SOC报告"
    ]
  }
];

  let pool = null;            // [{group, words:[]}]
  let contractsRef = [];
  let onOpenContract = null;
  let selectedWord = null;
  let mode = 'word';          // 'word' | 'contract'
  let chart = null;

  // ------------------------------------------------------------------ 存储
  async function load() {
    if (pool) return pool;
    const saved = await Storage.getKeywordPool();
    pool = (saved && Array.isArray(saved) && saved.length) ? saved : JSON.parse(JSON.stringify(DEFAULT_POOL));
    // One-time additive migration; retain the user's existing words and groups.
    const cfg = await Storage.getConfig();
    if (cfg.auditKeywordVersion !== 1) {
      for (const preset of DEFAULT_POOL) {
        let group = pool.find(g => g.group === preset.group);
        if (!group) { group = { group: preset.group, words: [] }; pool.push(group); }
        for (const word of preset.words) if (!group.words.includes(word)) group.words.push(word);
      }
      await persist();
      await Storage.saveConfig({ ...cfg, auditKeywordVersion: 1 });
    }
    return pool;
  }
  async function persist() { await Storage.saveKeywordPool(pool); }

  function allWords() {
    const out = [];
    (pool || []).forEach(g => g.words.forEach(w => out.push({ word: w, group: g.group })));
    return out;
  }

  // ------------------------------------------------------------------ 匹配
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // 允许字与字之间有空白（OCR 常插入空格）
  function buildRegex(word) {
    const chars = [...word.trim()].filter(c => c.trim());
    return new RegExp(chars.map(esc).join('\\s*'), 'gi');
  }

  function textOf(c) {
    if(typeof ContractScope!=='undefined'&&ContractScope.category(c)==='ey-template')return ContractScope.textFor(c);
    if (c.rawText) return c.rawText;
    return [c.projectName, c.partyA, c.partyB, c.content, c.deliverables].filter(Boolean).join('\n');
  }

  function snippetsOf(text, re, max = 3) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null && out.length < max) {
      const s = Math.max(0, m.index - 24), e = Math.min(text.length, m.index + m[0].length + 24);
      out.push({
        before: (s > 0 ? '…' : '') + text.slice(s, m.index).replace(/\s+/g, ' '),
        hit: m[0],
        after: text.slice(m.index + m[0].length, e).replace(/\s+/g, ' ') + (e < text.length ? '…' : '')
      });
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  }

  function analyze(contracts) {
    const words = allWords();
    const texts = contracts.map(c => ({ c, text: textOf(c) }));
    const byWord = words.map(({ word, group }) => {
      const re = buildRegex(word);
      const docs = [];
      let total = 0;
      for (const { c, text } of texts) {
        const n = (text.match(re) || []).length;
        if (n) { docs.push({ c, count: n }); total += n; }
      }
      docs.sort((a, b) => b.count - a.count);
      return { word, group, docs, total, re };
    });
    const byContract = texts.map(({ c, text }) => {
      const hits = [];
      byWord.forEach(w => { const d = w.docs.find(x => x.c === c); if (d) hits.push({ word: w.word, group: w.group, count: d.count }); });
      const hitGroups = new Set(hits.map(h => h.group));
      const missingGroups = (pool || []).map(g => g.group).filter(g => !hitGroups.has(g));
      return { c, hits, missingGroups, hasFull: !!c.rawText };
    });
    return { byWord, byContract };
  }

  /** 给某份合同算命中（详情弹窗用） */
  function hitsForContract(c) {
    if (!pool) return [];
    const text = textOf(c);
    return allWords().map(w => ({ ...w, count: (text.match(buildRegex(w.word)) || []).length })).filter(w => w.count);
  }

  /** 在已转义的 HTML 文本中高亮关键字 */
  function highlightHtml(escapedHtml) {
    if (!pool) return escapedHtml;
    const words = allWords().map(w => w.word).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!words.length) return escapedHtml;
    const htmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const re = new RegExp(words.map(w => [...htmlEsc(w)].filter(c => c.trim()).map(esc).join('\\s*')).join('|'), 'gi');
    return escapedHtml.replace(re, m => `<mark class="kw-mark">${m}</mark>`);
  }

  // ------------------------------------------------------------------ 视图
  const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function render(contracts, openContract) {
    contractsRef = contracts;
    onOpenContract = openContract;
    await load();
    renderPool();
    renderAnalysis();
  }

  function renderPool() {
    const box = document.getElementById('kwPoolGroups');
    if (!box) return;
    box.innerHTML = pool.map((g, gi) => `
      <div class="kw-group">
        <div class="kw-group-head">
          <span class="kw-group-name">${h(g.group)}</span>
          <button class="kw-group-del" data-gdel="${gi}" title="删除整个分类">删除分类</button>
        </div>
        <div class="kw-chips">
          ${g.words.map((w, wi) => `<span class="kw-chip">${h(w)}<button data-gi="${gi}" data-wi="${wi}" title="移除">×</button></span>`).join('')
            || '<span class="kw-empty">（空）</span>'}
        </div>
      </div>`).join('');

    const sel = document.getElementById('kwGroupSelect');
    const cur = sel.value;
    sel.innerHTML = pool.map(g => `<option value="${h(g.group)}">${h(g.group)}</option>`).join('') + '<option value="__new__">＋ 新建分类…</option>';
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    document.getElementById('kwNewGroup').style.display = sel.value === '__new__' ? '' : 'none';

    box.querySelectorAll('button[data-wi]').forEach(b => b.onclick = async () => {
      pool[+b.dataset.gi].words.splice(+b.dataset.wi, 1);
      await persist(); renderPool(); renderAnalysis();
    });
    box.querySelectorAll('button[data-gdel]').forEach(b => b.onclick = async () => {
      const g = pool[+b.dataset.gdel];
      if (!confirm(`删除分类「${g.group}」及其中 ${g.words.length} 个关键字？`)) return;
      pool.splice(+b.dataset.gdel, 1);
      await persist(); renderPool(); renderAnalysis();
    });
  }

  async function addFromInput() {
    const input = document.getElementById('kwInput');
    const sel = document.getElementById('kwGroupSelect');
    let group = sel.value;
    if (group === '__new__') {
      group = document.getElementById('kwNewGroup').value.trim();
      if (!group) { document.getElementById('kwNewGroup').focus(); return; }
    }
    const words = input.value.split(/[,，;；、\s]+/).map(s => s.trim()).filter(Boolean);
    if (!words.length) { input.focus(); return; }
    let g = pool.find(x => x.group === group);
    if (!g) { g = { group, words: [] }; pool.push(g); }
    const existing = new Set(allWords().map(w => w.word));
    let added = 0;
    for (const w of words) if (!existing.has(w)) { g.words.push(w); existing.add(w); added++; }
    input.value = '';
    document.getElementById('kwNewGroup').value = '';
    await persist();
    renderPool();
    sel.value = group;
    document.getElementById('kwNewGroup').style.display = 'none';
    renderAnalysis();
    return added;
  }

  async function resetDefault() {
    if (!confirm('恢复默认关键字池？你自己添加的关键字会被清除。')) return;
    pool = JSON.parse(JSON.stringify(DEFAULT_POOL));
    await persist(); renderPool(); renderAnalysis();
  }

  function renderAnalysis() {
    const { byWord, byContract } = analyze(contractsRef);
    const total = contractsRef.length;
    const withFull = contractsRef.filter(c => c.rawText).length;
    const hitAny = byContract.filter(x => x.hits.length).length;

    const businessRows = contractsRef.map(c => ({ c, tags: BusinessIntent.forContract(c).filter(t => c.businessReview?.[t.code]?.status !== '不适用') }));
    const businessCodes = new Set(businessRows.flatMap(row => row.tags.map(t => t.code.replace(/^SEM_/, ''))));
    document.getElementById('kwKpiWords').textContent = businessCodes.size;
    document.getElementById('kwKpiContracts').textContent = total;
    document.getElementById('kwKpiHit').textContent = businessRows.filter(row => row.tags.length).length;
    document.getElementById('kwKpiNone').textContent = businessRows.filter(row => row.tags.length && row.tags.every(t => row.c.businessReview?.[t.code]?.status === '已确认')).length;
    const note = document.getElementById('kwNote');
    note.textContent = total - withFull > 0
      ? `有 ${total - withFull} 份合同是旧版本识别的，没有保存全文，只能按已提取的字段分析；重新上传即可完整分析。`
      : '';
    note.style.display = note.textContent ? '' : 'none';

    document.querySelectorAll('.kw-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    renderChart(byWord, total);
    if (mode === 'word') renderByWord(byWord, total);
    else renderByContract(byContract);
  }

  function renderChart(byWord, total) {
    const el = document.getElementById('kwChart');
    if (!el || typeof echarts === 'undefined') return;
    if (!chart || chart.getDom() !== el) chart = echarts.init(el);
    const groups = new Map();
    for (const contract of contractsRef) {
      const seen = new Set();
      for (const tag of BusinessIntent.forContract(contract)) {
        const review = contract.businessReview?.[tag.code];
        if (review?.status === '不适用') continue;
        const code = tag.code.replace(/^SEM_/, '');
        const family = code.startsWith('SOC1') ? 'SOC 1' : code.startsWith('SOC2') ? 'SOC 2' : null;
        const defaults = { IPO_RELATED: 'IPO / 上市支持', DATA_REVIEW: '数据核查 / 业财核对', ITGC: 'ITGC / 一般控制', ITAC: 'ITAC / 应用控制', ISO_PREPARATION: 'ISO / 认证准备' };
        const label = review?.label && review.label !== tag.label ? review.label : (defaults[code] || (family ? family + (code.includes('TYPE2') && !code.includes('CANDIDATE') ? ' Type 2' : code.includes('TYPE1') ? ' Type 1' : '（类型待确认）') : tag.label));
        if (!groups.has(label)) groups.set(label, { word: label, docs: [], confirmed: 0 });
        if (seen.has(label)) continue;
        seen.add(label);
        const item = groups.get(label);
        item.docs.push(contract);
        if (review?.status === '已确认') item.confirmed++;
      }
    }
    const data = [...groups.values()].sort((a, b) => a.docs.length - b.docs.length || a.word.localeCompare(b.word));
    document.getElementById('kwBusinessMatches').innerHTML = '';
    el.style.height = Math.max(220, data.length * 42 + 55) + 'px';
    if (!data.length) {
      chart.clear();
      chart.setOption({ title: { text: total ? '暂无业务分类线索，请查看合同并填写复核笔记' : '暂无合同数据', left: 'center', top: 'middle', textStyle: { color: '#94a3b8', fontSize: 13, fontWeight: 'normal' } } });
      return;
    }
    chart.setOption({
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: p => { const w = data[p[0].dataIndex]; return `${h(w.word)}<br>涉及 ${w.docs.length}/${total} 份合同<br>人工确认 ${w.confirmed} 份 · 已识别 ${w.docs.length - w.confirmed} 份`; } },
      xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#f1f5f9' } } },
      yAxis: { type: 'category', data: data.map(w => w.word), axisLabel: { interval: 0, width: 180, overflow: 'break' }, axisTick: { show: false }, axisLine: { show: false } },
      series: [{
        type: 'bar', data: data.map(w => ({ value: w.docs.length, itemStyle: { color: w.word === selectedWord ? '#1d4ed8' : '#60a5fa', borderRadius: [0, 4, 4, 0] } })),
        barMaxWidth: 18, label: { show: true, position: 'right', color: '#475569', formatter: p => `${p.value} 份` }
      }]
    }, true);
    chart.off('click');
    chart.on('click', p => {
      const item = data[p.dataIndex];
      const box = document.getElementById('kwBusinessMatches');
      box.innerHTML = `<p><strong>${h(item.word)}</strong> · ${item.docs.length} 份合同</p>` + item.docs.map(c => `<button class="btn btn-ghost btn-sm" type="button" data-business-id="${h(c.id)}">${h(c.projectName || c.sourceFile || '合同')} · 查看依据与笔记</button>`).join('');
      box.querySelectorAll('[data-business-id]').forEach(button => button.onclick = () => onOpenContract?.(button.dataset.businessId));
    });
    setTimeout(() => chart && chart.resize(), 30);
  }

  function renderByWord(byWord, total) {
    const box = document.getElementById('kwResult');
    const rows = byWord.slice().sort((a, b) => b.docs.length - a.docs.length || b.total - a.total);
    if (!total) { box.innerHTML = '<div class="kw-placeholder">还没有合同数据，请先在「上传识别」中上传文件。</div>'; return; }
    if (!selectedWord || !rows.some(r => r.word === selectedWord)) selectedWord = (rows.find(r => r.docs.length) || rows[0] || {}).word;
    const sel = rows.find(r => r.word === selectedWord);

    box.innerHTML = `
      <div class="kw-split">
        <div class="kw-table-wrap">
          <table class="kw-table">
            <thead><tr><th>关键字</th><th>分类</th><th>命中合同</th><th>出现次数</th></tr></thead>
            <tbody>${rows.map(r => `
              <tr data-word="${h(r.word)}" class="${r.word === selectedWord ? 'active' : ''} ${r.docs.length ? '' : 'zero'}">
                <td><strong>${h(r.word)}</strong></td>
                <td><span class="kw-tag">${h(r.group)}</span></td>
                <td><div class="kw-bar"><span style="width:${total ? (r.docs.length / total * 100) : 0}%"></span></div>${r.docs.length}/${total}</td>
                <td>${r.total}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="kw-detail">
          ${sel ? `
            <div class="kw-detail-head">「${h(sel.word)}」出现在 ${sel.docs.length} 份合同中</div>
            ${sel.docs.length ? sel.docs.map(d => `
              <div class="kw-doc" data-id="${h(d.c.id)}">
                <div class="kw-doc-title">${h(d.c.projectName || d.c.sourceFile || '未命名合同')}<span>${d.count} 次</span></div>
                ${snippetsOf(textOf(d.c), sel.re).map(s => `<div class="kw-snippet">${h(s.before)}<mark class="kw-mark">${h(s.hit)}</mark>${h(s.after)}</div>`).join('')}
              </div>`).join('')
            : '<div class="kw-placeholder">没有合同包含这个关键字。</div>'}
          ` : ''}
        </div>
      </div>`;
    box.querySelectorAll('tr[data-word]').forEach(tr => tr.onclick = () => { selectedWord = tr.dataset.word; renderAnalysis(); });
    box.querySelectorAll('.kw-doc').forEach(d => d.onclick = () => onOpenContract && onOpenContract(d.dataset.id));
  }

  function renderByContract(byContract) {
    const box = document.getElementById('kwResult');
    if (!byContract.length) { box.innerHTML = '<div class="kw-placeholder">还没有合同数据，请先在「上传识别」中上传文件。</div>'; return; }
    box.innerHTML = `
      <div class="kw-table-wrap">
        <table class="kw-table kw-table-contracts">
          <thead><tr><th>合同</th><th>命中关键字</th><th>未出现的分类</th></tr></thead>
          <tbody>${byContract.map(x => `
            <tr data-id="${h(x.c.id)}">
              <td><strong>${h(x.c.projectName || '未识别项目')}</strong><div class="kw-sub">${h(x.c.sourceFile || '')}${x.hasFull ? '' : ' · 无全文'}</div></td>
              <td>${x.hits.length ? x.hits.map(k => `<span class="kw-chip kw-chip-hit" title="${h(k.group)}">${h(k.word)}<em>${k.count}</em></span>`).join('') : '<span class="kw-empty">无</span>'}</td>
              <td>${x.missingGroups.length ? x.missingGroups.map(g => `<span class="kw-chip kw-chip-miss">${h(g)}</span>`).join('') : '<span class="kw-ok">全部覆盖</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    box.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => onOpenContract && onOpenContract(tr.dataset.id));
  }

  function exportCSV() {
    const blob = new Blob(['\ufeff' + AuditReview.toCSV(contractsRef)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    a.download = `业务分类与复核_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function bind() {
    document.getElementById('kwAddBtn').onclick = addFromInput;
    document.getElementById('kwInput').addEventListener('keydown', e => { if (e.key === 'Enter') addFromInput(); });
    document.getElementById('kwNewGroup').addEventListener('keydown', e => { if (e.key === 'Enter') addFromInput(); });
    document.getElementById('kwGroupSelect').onchange = e => {
      document.getElementById('kwNewGroup').style.display = e.target.value === '__new__' ? '' : 'none';
      if (e.target.value === '__new__') document.getElementById('kwNewGroup').focus();
    };
    document.getElementById('kwResetBtn').onclick = resetDefault;
    document.getElementById('kwExportBtn').onclick = exportCSV;
    document.querySelectorAll('.kw-tab').forEach(t => t.onclick = () => { mode = t.dataset.mode; renderAnalysis(); });
    window.addEventListener('resize', () => chart && chart.resize());
  }

  return { load, render, bind, hitsForContract, highlightHtml, analyze, refresh: renderAnalysis };
})();
