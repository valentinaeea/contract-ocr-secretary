/**
 * 可视化仪表盘模块
 * 使用 ECharts 绘制多维度统计图表
 */

const Dashboard = (() => {
  const charts = {}; // 缓存图表实例
  const COLORS = [
    '#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#84cc16', '#f97316', '#ec4899', '#6366f1',
    '#14b8a6', '#a855f7', '#eab308', '#22c55e', '#3b82f6'
  ];

  // 通用初始化
  function initChart(elementId, option) {
    const el = document.getElementById(elementId);
    if (!el) return null;

    if (charts[elementId]) {
      charts[elementId].dispose();
    }
    charts[elementId] = echarts.init(el, null, { renderer: 'canvas' });
    charts[elementId].setOption(option);
    return charts[elementId];
  }

  // 响应式
  function resizeAll() {
    Object.values(charts).forEach(chart => chart && chart.resize());
  }
  window.addEventListener('resize', resizeAll);

  // ============== KPI 卡片 ==============
  function updateKPI(contracts) {
    const total = contracts.length;
    const totalAmount = contracts.reduce((sum, c) => sum + (c.amount || 0), 0);
    const avgAmount = total > 0 ? totalAmount / total : 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthCount = contracts.filter(c => (c.createdAt || 0) >= monthStart).length;

    document.getElementById('kpiTotalCount').textContent = total;
    document.getElementById('kpiTotalAmount').textContent = formatMoney(totalAmount);
    document.getElementById('kpiAvgAmount').textContent = formatMoney(avgAmount);
    document.getElementById('kpiMonthCount').textContent = monthCount;

    // 显示金额单位
    const amountEl = document.getElementById('kpiAmountTrend');
    if (totalAmount >= 100000000) {
      amountEl.textContent = `≈ ${(totalAmount / 100000000).toFixed(2)} 亿元`;
    } else if (totalAmount >= 10000) {
      amountEl.textContent = `≈ ${(totalAmount / 10000).toFixed(2)} 万元`;
    } else {
      amountEl.textContent = '元';
    }
  }

  function formatMoney(num) {
    if (!num || num === 0) return '¥0';
    if (num >= 100000000) return '¥' + (num / 100000000).toFixed(2) + '亿';
    if (num >= 10000) return '¥' + (num / 10000).toFixed(2) + '万';
    return '¥' + num.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  // ============== 月度签约趋势 ==============
  function renderTrendChart(contracts) {
    // 按月聚合
    const monthMap = new Map();
    contracts.forEach(c => {
      const dateStr = c.signDate || (c.createdAt ? new Date(c.createdAt).toISOString().slice(0,10) : '');
      if (!dateStr) return;
      const ym = dateStr.substring(0, 7); // YYYY-MM
      if (!monthMap.has(ym)) {
        monthMap.set(ym, { count: 0, amount: 0 });
      }
      const entry = monthMap.get(ym);
      entry.count += 1;
      entry.amount += (c.amount || 0);
    });

    // 排序并取最近12个月
    const sortedKeys = Array.from(monthMap.keys()).sort();
    const recentKeys = sortedKeys.slice(-12);

    const countData = recentKeys.map(k => monthMap.get(k).count);
    const amountData = recentKeys.map(k => Math.round(monthMap.get(k).amount / 10000)); // 转为万元

    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(255,255,255,0.95)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a' },
        formatter: function(params) {
          let html = `<div style="font-weight:600;margin-bottom:4px">${params[0].name}</div>`;
          params.forEach(p => {
            const unit = p.seriesName === '签约金额' ? '万元' : '份';
            html += `<div style="display:flex;justify-content:space-between;gap:16px;font-size:12px">
              <span>${p.marker}${p.seriesName}</span>
              <span style="font-weight:600">${p.value} ${unit}</span>
            </div>`;
          });
          return html;
        }
      },
      legend: {
        data: ['合同数量', '签约金额'],
        textStyle: { color: '#475569' },
        top: 0
      },
      grid: { left: 50, right: 50, top: 40, bottom: 30 },
      xAxis: {
        type: 'category',
        data: recentKeys,
        axisLine: { lineStyle: { color: '#e2e8f0' } },
        axisLabel: { color: '#64748b', fontSize: 11 }
      },
      yAxis: [
        {
          type: 'value',
          name: '合同数',
          nameTextStyle: { color: '#64748b', fontSize: 11 },
          axisLabel: { color: '#64748b' },
          splitLine: { lineStyle: { color: '#f1f5f9' } }
        },
        {
          type: 'value',
          name: '金额(万元)',
          nameTextStyle: { color: '#64748b', fontSize: 11 },
          axisLabel: { color: '#64748b' },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: '合同数量',
          type: 'bar',
          data: countData,
          itemStyle: { color: '#2563eb', borderRadius: [4, 4, 0, 0] },
          barWidth: '40%'
        },
        {
          name: '签约金额',
          type: 'line',
          yAxisIndex: 1,
          data: amountData,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: '#10b981' },
          lineStyle: { width: 3 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(16,185,129,0.3)' },
              { offset: 1, color: 'rgba(16,185,129,0)' }
            ])
          }
        }
      ]
    };

    initChart('chartTrend', option);
  }

  // ============== 甲方 TOP10 ==============
  function renderPartyAChart(contracts) {
    renderTopBarChart('chartPartyA', contracts, 'partyA', '签约主体甲方');
  }

  // ============== 乙方 TOP10 ==============
  function renderPartyBChart(contracts) {
    renderTopBarChart('chartPartyB', contracts, 'partyB', '签约主体乙方');
  }

  // 通用 TOP10 条形图
  function renderTopBarChart(elementId, contracts, field, title) {
    const counter = new Map();
    contracts.forEach(c => {
      const key = c[field];
      if (!key) return;
      counter.set(key, (counter.get(key) || 0) + 1);
    });

    const sorted = Array.from(counter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sorted.length === 0) {
      renderEmptyChart(elementId, `暂无${title}数据`);
      return;
    }

    const names = sorted.map(s => truncate(s[0], 18));
    const counts = sorted.map(s => s[1]);

    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: function(params) {
          const p = params[0];
          return `<div style="font-weight:600;margin-bottom:4px">${p.name}</div>
                  <div>合同数：<span style="font-weight:600">${p.value} 份</span></div>`;
        }
      },
      grid: { left: 100, right: 30, top: 10, bottom: 25 },
      xAxis: {
        type: 'value',
        axisLabel: { color: '#64748b', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f1f5f9' } }
      },
      yAxis: {
        type: 'category',
        data: names.reverse(),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#475569', fontSize: 12 }
      },
      series: [{
        type: 'bar',
        data: counts.reverse().map((v, i) => ({
          value: v,
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: COLORS[i % COLORS.length] + '99' },
              { offset: 1, color: COLORS[i % COLORS.length] }
            ]),
            borderRadius: [0, 4, 4, 0]
          }
        })),
        label: {
          show: true,
          position: 'right',
          color: '#0f172a',
          fontWeight: 600
        },
        barWidth: '60%'
      }]
    };

    initChart(elementId, option);
  }

  // ============== 项目类型分布（基于交付物） ==============
  function renderCategoryChart(contracts) {
    // 基于交付物关键词分类
    const categories = {
      '软件开发': ['软件', '系统', '平台', 'APP', '小程序', '网站', '代码', '程序', '开发'],
      '咨询服务': ['咨询', '顾问', '调研', '报告', '规划', '分析', '评估'],
      '设计服务': ['设计', 'UI', 'UX', 'VI', 'LOGO', '视觉', '方案', '图纸'],
      '工程施工': ['工程', '施工', '建设', '安装', '装修', '改造', '维护'],
      '设备采购': ['设备', '硬件', '机器', '采购', '供货', '器材'],
      '运营推广': ['推广', '运营', '营销', '广告', '宣传', '媒体'],
      '培训教育': ['培训', '教学', '课程', '讲座', '辅导'],
      '其他': []
    };

    const counter = new Map();
    contracts.forEach(c => {
      const text = (typeof ContractScope!=='undefined'&&ContractScope.category(c)==='ey-template'?ContractScope.textFor(c):(c.deliverables||'')+(c.content||'')+(c.projectName||'')).toLowerCase();
      let matched = false;
      for (const [cat, keywords] of Object.entries(categories)) {
        if (cat === '其他') continue;
        if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
          counter.set(cat, (counter.get(cat) || 0) + 1);
          matched = true;
          break;
        }
      }
      if (!matched) {
        counter.set('其他', (counter.get('其他') || 0) + 1);
      }
    });

    const data = Array.from(counter.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .filter(d => d.value > 0);

    if (data.length === 0) {
      renderEmptyChart('chartCategory', '暂无项目类型数据');
      return;
    }

    const option = {
      tooltip: {
        trigger: 'item',
        formatter: '{b}<br/>合同数：{c} 份<br/>占比：{d}%'
      },
      legend: {
        orient: 'vertical',
        right: 0,
        top: 'middle',
        textStyle: { color: '#475569', fontSize: 11 },
        itemWidth: 10,
        itemHeight: 10
      },
      color: COLORS,
      series: [{
        type: 'pie',
        radius: ['45%', '75%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: {
          borderRadius: 6,
          borderColor: '#fff',
          borderWidth: 2
        },
        label: {
          show: true,
          formatter: '{b}\n{d}%',
          fontSize: 11,
          color: '#475569'
        },
        labelLine: { length: 8, length2: 8 },
        data: data
      }]
    };

    initChart('chartCategory', option);
  }

  // ============== 金额区间分布 ==============
  function renderAmountRangeChart(contracts) {
    const ranges = [
      { name: '10万以下', min: 0, max: 100000 },
      { name: '10-50万', min: 100000, max: 500000 },
      { name: '50-100万', min: 500000, max: 1000000 },
      { name: '100-500万', min: 1000000, max: 5000000 },
      { name: '500-1000万', min: 5000000, max: 10000000 },
      { name: '1000万以上', min: 10000000, max: Infinity }
    ];

    const counter = ranges.map(r => ({
      name: r.name,
      count: contracts.filter(c => c.amount >= r.min && c.amount < r.max).length
    }));

    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: function(params) {
          const p = params[0];
          return `<div style="font-weight:600;margin-bottom:4px">${p.name}</div>
                  <div>合同数：<span style="font-weight:600">${p.value} 份</span></div>`;
        }
      },
      grid: { left: 50, right: 30, top: 20, bottom: 30 },
      xAxis: {
        type: 'category',
        data: counter.map(c => c.name),
        axisLine: { lineStyle: { color: '#e2e8f0' } },
        axisLabel: { color: '#64748b', fontSize: 11, rotate: 20 }
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#64748b' },
        splitLine: { lineStyle: { color: '#f1f5f9' } }
      },
      series: [{
        type: 'bar',
        data: counter.map((c, i) => ({
          value: c.count,
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: COLORS[i % COLORS.length] },
              { offset: 1, color: COLORS[i % COLORS.length] + '80' }
            ]),
            borderRadius: [6, 6, 0, 0]
          }
        })),
        label: {
          show: true,
          position: 'top',
          color: '#0f172a',
          fontWeight: 600
        },
        barWidth: '50%'
      }]
    };

    initChart('chartAmountRange', option);
  }

  // ============== 签约金额 TOP10 ==============
  function renderTopAmountChart(contracts) {
    const sorted = [...contracts]
      .filter(c => c.amount > 0)
      .sort((a, b) => (b.amount || 0) - (a.amount || 0))
      .slice(0, 10);

    if (sorted.length === 0) {
      renderEmptyChart('chartTopAmount', '暂无金额数据');
      return;
    }

    const names = sorted.map(c => truncate(c.projectName || '未命名项目', 24));
    const amounts = sorted.map(c => Math.round(c.amount / 10000)); // 万元
    const labels = sorted.map(c => formatMoney(c.amount));

    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: function(params) {
          const i = params[0].dataIndex;
          const c = sorted[i];
          return `<div style="font-weight:600;margin-bottom:4px">${c.projectName}</div>
                  <div>签约金额：<span style="font-weight:600;color:#2563eb">${formatMoney(c.amount)}</span></div>
                  <div>甲方：${c.partyA || '未识别'}</div>
                  <div>签约时间：${c.signDate || '未识别'}</div>`;
        }
      },
      grid: { left: 60, right: 100, top: 10, bottom: 25 },
      xAxis: {
        type: 'value',
        axisLabel: { color: '#64748b', fontSize: 11, formatter: '{value} 万' },
        splitLine: { lineStyle: { color: '#f1f5f9' } }
      },
      yAxis: {
        type: 'category',
        data: names.reverse(),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#475569', fontSize: 12 }
      },
      series: [{
        type: 'bar',
        data: amounts.reverse().map((v, i) => ({
          value: v,
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: '#2563eb80' },
              { offset: 1, color: '#2563eb' }
            ]),
            borderRadius: [0, 6, 6, 0]
          }
        })),
        label: {
          show: true,
          position: 'right',
          formatter: function(params) {
            const i = params.dataIndex;
            return labels[names.length - 1 - i];
          },
          color: '#0f172a',
          fontWeight: 600,
          fontSize: 11
        },
        barWidth: '60%'
      }]
    };

    initChart('chartTopAmount', option);
  }

  // ============== 空状态 ==============
  function renderEmptyChart(elementId, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (charts[elementId]) {
      charts[elementId].dispose();
    }
    charts[elementId] = echarts.init(el);
    charts[elementId].setOption({
      graphic: [{
        type: 'text',
        left: 'center',
        top: 'middle',
        style: {
          text: message || '暂无数据',
          fontSize: 14,
          fill: '#94a3b8'
        }
      }]
    });
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  // ============== 渲染入口 ==============
  function render(contracts) {
    updateKPI(contracts);
    renderTrendChart(contracts);
    renderPartyAChart(contracts);
    renderPartyBChart(contracts);
    renderCategoryChart(contracts);
    renderAmountRangeChart(contracts);
    renderTopAmountChart(contracts);
  }

  return {
    render,
    resizeAll
  };
})();