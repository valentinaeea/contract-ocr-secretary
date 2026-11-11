/**
 * 本地存储管理模块
 * 使用 IndexedDB 存储合同数据，支持大量数据持久化
 * 同时通过 localStorage 存储配置信息
 */

const Storage = (() => {
  const DB_NAME = 'ContractDB';
  const DB_VERSION = 1;
  const STORE_CONTRACTS = 'contracts';
  const STORE_CONFIG = 'config';

  let dbInstance = null;
  const native = () => typeof NativeDocuments !== 'undefined' && NativeDocuments.available();
  const localGet = path => NativeDocuments.request(path);
  const localPost = (path, payload) => NativeDocuments.request(path, { method: 'POST', headers: { ...NativeDocuments.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });


  // 初始化数据库
  function openDB() {
    if (native()) return Promise.resolve(null);
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(new Error('数据库打开失败'));
      request.onsuccess = (e) => {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_CONTRACTS)) {
          const store = db.createObjectStore(STORE_CONTRACTS, { keyPath: 'id' });
          store.createIndex('signDate', 'signDate', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_CONFIG)) {
          db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
        }
      };
    });
  }

  // 通用事务
  async function tx(storeName, mode = 'readonly') {
    const db = await openDB();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  // ================== 合同数据 CRUD ==================

  // 获取所有合同
  async function getAllContracts() {
    if (native()) {
      const items = await localGet('/api/contracts');
      for (const item of items) {
        if (!item.needsExtraction || item.managedBusinessAnalysis) continue;
        Object.assign(item, await Extractor.extract(item.rawText || '', await getConfig()));
        delete item.confidence;
        item.needsExtraction = false;
        await localPost('/api/contracts', { action: 'update', contract: item });
      }
      return items.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    const store = await tx(STORE_CONTRACTS);
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const items = request.result || [];
        // 按创建时间倒序
        items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(items);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // 添加合同
  async function addContract(contract) {
    if (native()) { const result=await localPost('/api/contracts', { action: 'add', contract }); return result.contracts?.[0] || contract; }
    const store = await tx(STORE_CONTRACTS, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.add(contract);
      request.onsuccess = () => resolve(contract);
      request.onerror = () => reject(request.error);
    });
  }

  // 更新合同
  async function updateContract(contract) {
    if (native()) { const result=await localPost('/api/contracts', { action: 'update', contract }); return result.contracts?.[0] || contract; }
    const store = await tx(STORE_CONTRACTS, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(contract);
      request.onsuccess = () => resolve(contract);
      request.onerror = () => reject(request.error);
    });
  }

  // 删除合同
  async function deleteContract(id) {
    if (native()) { await localPost('/api/contracts', { action: 'delete', id }); return true; }
    const store = await tx(STORE_CONTRACTS, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  // 批量添加
  async function batchAdd(contracts) {
    if (native()) { await localPost('/api/contracts', { action: 'batch', contracts }); return contracts.length; }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CONTRACTS, 'readwrite');
      const store = transaction.objectStore(STORE_CONTRACTS);
      let successCount = 0;

      transaction.oncomplete = () => resolve(successCount);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);

      contracts.forEach(c => {
        const request = store.add(c);
        request.onsuccess = () => successCount++;
      });
    });
  }

  // 清空所有合同
  async function clearAll() {
    if (native()) { await localPost('/api/contracts', { action: 'clear' }); return true; }
    const store = await tx(STORE_CONTRACTS, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  // 获取存储使用量
  async function getStorageEstimate() {
    if (native()) { const health = await localGet('/api/health'); return { usage: health.usage, quota: 0, directory: health.dataDirectory }; }
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage || 0,
        quota: estimate.quota || 0
      };
    }
    return { usage: 0, quota: 0 };
  }

  // ================== 配置管理 ==================

  const DEFAULT_CONFIG = {
    partyAKeys: '甲方|委托方|发包方|采购方|客户|定作方',
    partyBKeys: '乙方|受托方|承包方|供应商|服务方|承揽方|制作方',
    amountKeys: '合同金额|总金额|签约金额|合同总价|价款|服务费|报酬',
    projectKeys: '项目名称|工程名称|合同名称|项目名',
    dateKeys: '签订日期|签约时间|签订时间|合同签订日期',
    contentKeys: '工作内容|服务范围|项目内容|服务内容|合同内容',
    deliverableKeys: '交付物|成果|验收标准|交付内容|应交付'
  };

  async function getConfig() {
    if (native()) return { ...DEFAULT_CONFIG, ...(await localGet('/api/config')).main };
    const store = await tx(STORE_CONFIG);
    return new Promise((resolve) => {
      const request = store.get('main');
      request.onsuccess = () => {
        if (request.result) {
          resolve({ ...DEFAULT_CONFIG, ...request.result.value });
        } else {
          resolve({ ...DEFAULT_CONFIG });
        }
      };
      request.onerror = () => resolve({ ...DEFAULT_CONFIG });
    });
  }

  async function saveConfig(config) {
    if (native()) return localPost('/api/config', { key: 'main', value: config });
    const store = await tx(STORE_CONFIG, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put({ key: 'main', value: config });
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  // 关键字分析池（与识别配置分开保存）
  async function getKeywordPool() {
    if (native()) return (await localGet('/api/config')).keywordPool || null;
    const store = await tx(STORE_CONFIG);
    return new Promise((resolve) => {
      const request = store.get('keywordPool');
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => resolve(null);
    });
  }

  async function saveKeywordPool(pool) {
    if (native()) return localPost('/api/config', { key: 'keywordPool', value: pool });
    const store = await tx(STORE_CONFIG, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put({ key: 'keywordPool', value: pool });
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  async function getServiceDomainCatalog() {
    if(native())return (await localGet('/api/config')).serviceDomains||null;
    const store=await tx(STORE_CONFIG);
    return new Promise((resolve,reject)=>{const request=store.get('serviceDomains');request.onsuccess=()=>resolve(request.result?.value||null);request.onerror=()=>reject(request.error);});
  }
  async function saveServiceDomainCatalog(value) {
    if(native())return localPost('/api/config',{key:'serviceDomains',value});
    const store=await tx(STORE_CONFIG,'readwrite');
    return new Promise((resolve,reject)=>{const request=store.put({key:'serviceDomains',value});request.onsuccess=()=>resolve(true);request.onerror=()=>reject(request.error);});
  }

  function getDefaultConfig() {
    return { ...DEFAULT_CONFIG };
  }

  // ================== 导入导出 ==================

  async function exportToJSON() {
    const contracts = await getAllContracts();
    return JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      contracts
    }, null, 2);
  }

  async function exportToCSV() {
    const contracts = await getAllContracts();
    const headers = [
      '项目名称', 'Engagement Code', 'Engagement Code Description', 'Engagement Name', '上传者ID', '签约主体甲方', '签约主体乙方', '签约时间',
      '签约金额(元)', '项目工作内容概述', '交付物', '来源文件', '录入时间',
      '一级行业','二级行业','三级行业','企业规模','业务模式','客户诉求','服务领域','具体服务','涉及系统/技术','服务期限','交付成果整理','项目大区','项目省份','项目城市','EIC','PIC','FIC','原文关键词','自定义标签','项目笔记','上传类别','Tag分析范围','范围定位状态'
    ];
    const escapeCsv = (str) => {
      if (str == null) return '';
      let s = String(str);
      if (/^[\s]*[=+@-]/.test(s)) s="'"+s;
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const rows = contracts.map(c => {
      const p=VaultModel.project(c);
      return [
      c.projectName, c.engagementCode, c.engagementCodeDescription, c.engagementName, c.uploadedByName, c.partyA, c.partyB, c.signDate,
      c.amount, c.content, c.deliverables, c.sourceFile, c.createdAt,
      ...[0,1,2].map(i=>p.industry[i]||''),p.enterpriseSize,p.businessModel,p.need,p.services.join('；'),p.specificTags.join('；'),p.systems.join('；'),p.serviceTerm,p.deliverables.join('；'),...[0,1,2].map(i=>p.region[i]||''),p.eic,p.pic,p.fic||'',p.keywords.join('；'),p.customTags.join('；'),p.notes,c.uploadCategory==='ey-template'?'安永模板类':'其他类合同',p.analysisScope.label,p.analysisScope.status
    ].map(escapeCsv).join(',');});
    return [headers.join(','), ...rows].join('\n');
  }

  async function importFromJSON(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      if (!data.contracts || !Array.isArray(data.contracts)) {
        throw new Error('数据格式不正确');
      }
      const existing=new Set((await getAllContracts()).map(c=>c.id));
      const seen=new Set();
      const newContracts = data.contracts.map(c => ({
        ...c,
        id: c.id || generateId(),
        createdAt: c.createdAt || Date.now()
      }));
      const unique=newContracts.filter(c=>{if(existing.has(c.id)||seen.has(c.id))return false;seen.add(c.id);return true;});
      if(unique.length) await batchAdd(unique);
      return unique.length;
    } catch (e) {
      throw new Error('导入失败: ' + e.message);
    }
  }

  // 生成唯一ID
  function generateId() {
    return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  }

  return {
    openDB,
    getAllContracts,
    addContract,
    updateContract,
    deleteContract,
    batchAdd,
    clearAll,
    getStorageEstimate,
    getConfig,
    saveConfig,
    getKeywordPool,
    saveKeywordPool,
    getDefaultConfig,
    getServiceDomainCatalog,
    saveServiceDomainCatalog,
    exportToJSON,
    exportToCSV,
    importFromJSON,
    generateId
  };
})();