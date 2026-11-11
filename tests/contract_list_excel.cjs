/** 合同列表与检索：关键词/PIC/EIC/FIC 列，云盘总表「上传者ID」列，Excel 导出 → 导入 → 上传到云端总表，总表中他人合同只读检索；真实本机服务，仅用合成数据。 */
const assert=require('assert'),{spawn,execFileSync}=require('child_process'),{chromium}=require('playwright'),fs=require('fs'),os=require('os'),path=require('path');
const repo=path.resolve(__dirname,'..'),py=process.env.PYTHON||'python';
const pyRun=code=>execFileSync(py,['-c','import sys,json;sys.path.insert(0,'+JSON.stringify(path.join(repo,'native'))+');import excel_table as e\n'+code]).toString('utf8');
(async()=>{const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'x-')),cloud=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-')),work=fs.mkdtempSync(path.join(os.tmpdir(),'xl-')),port=25000+Math.floor(Math.random()*5000),origin='http://127.0.0.1:'+port;
const executable=process.argv[2],command=executable?path.resolve(executable):py,args=executable?['--no-browser']:['native/desktop.py','--no-browser'];
const s=spawn(command,args,{cwd:repo,env:{...process.env,CONTRACT_OCR_DATA_DIR:tmp,CONTRACT_OCR_PORT:String(port),CONTRACT_OCR_CLOUD_DEFAULT:'',CONTRACT_OCR_DIAGNOSTICS:'1'}});let logs='';s.stderr.on('data',d=>logs+=d);s.stdout.on('data',d=>logs+=d);
const options={headless:true};if(process.env.OCR_TEST_CHROMIUM){options.executablePath=process.env.OCR_TEST_CHROMIUM;options.args=['--no-sandbox'];}
const b=await chromium.launch(options);
const toast=(page,text)=>page.waitForFunction(t=>[...document.querySelectorAll('.toast')].some(x=>x.textContent.includes(t)),text,{timeout:15000});
try{for(let i=0;;i++){try{if((await fetch(origin+'/api/health')).ok)break;}catch{}if(i>300||s.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,100));}
const ctx=await b.newContext({acceptDownloads:true,viewport:{width:1600,height:900}});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto(origin);await p.waitForFunction(()=>window.__CONTRACT_OCR_READY,null,{timeout:30000});
await p.evaluate(async()=>{await Storage.addContract({id:'a1',projectName:'广州视睿电子科技有限公司之SOC2类型二报告',partyA:'广州视睿电子科技有限公司',partyB:'安永华明会计师事务所',signDate:'2026-10-30',amount:273000,deliverables:'一份SOC2 报告',rawText:'服务内容：SOC2类型二鉴证，出具SOC2报告，评价内部控制。EIC：王五 PIC：赵六',createdAt:Date.now()});});
await p.reload();await p.waitForFunction(()=>window.__CONTRACT_OCR_READY);await p.locator('[data-view="upload"]').click();
const heads=await p.locator('#myContracts .contract-table thead th').allTextContents();assert.deepEqual(heads.map(x=>x.trim()),['项目名称','甲方','乙方','签约时间','原始关键词','PIC','EIC','FIC','操作']);
const me=(await p.evaluate(()=>NativeDocuments.request('/api/config'))).uploaderDefault;assert(me,'default uploader from this computer account');
assert.equal(await p.locator('tr[data-id="a1"] [data-uploader]').count(),0,'list has no uploader column');
await p.waitForTimeout(500);const row=p.locator('tr[data-id="a1"]');const cells=await row.locator('td').allTextContents();console.log('row',cells.map(x=>x.trim().replace(/\s+/g,' ')));
assert(!cells.join('').includes('27.30'));
// export
const [dl]=await Promise.all([p.waitForEvent('download'),p.locator('#exportExcelBtn').click()]);const xfile=path.join(work,'export.xlsx'),ifile=path.join(work,'import.xlsx');await dl.saveAs(xfile);console.log('download',dl.suggestedFilename());
const parsed=JSON.parse(pyRun('h,r=e.read_xlsx(open('+JSON.stringify(xfile)+',"rb").read());sys.stdout.buffer.write(json.dumps({"h":h,"r":r}).encode())'));console.log(parsed);
assert.equal(parsed.r[0]['合同ID'],'a1');assert(parsed.h.includes('上传者ID'));assert.equal(parsed.r[0]['上传者ID'],me,'上传者ID is filled by the local service');
// modify: FIC on a1, keywords, plus a new row
pyRun('h,r=e.read_xlsx(open('+JSON.stringify(xfile)+',"rb").read());r[0]["FIC"]="\\u94b1\\u4e03";r[0]["Engagement Code"]="E-0001";r[0]["Engagement Name"]="Guangzhou engagement";r[0]["\\u4e59\\u65b9"]="";r.append({"\\u9879\\u76ee\\u540d\\u79f0":"\\u65b0\\u5bfc\\u5165\\u9879\\u76ee","\\u7532\\u65b9":"\\u7532\\u516c\\u53f8","\\u7b7e\\u7ea6\\u65f6\\u95f4":"2026-01-02","\\u539f\\u59cb\\u5173\\u952e\\u8bcd":"ITGC\\uff1b\\u6e17\\u900f\\u6d4b\\u8bd5","PIC":"\\u5b59\\u516b"});open('+JSON.stringify(ifile)+',"wb").write(e.write_xlsx(e.COLUMNS,r))');
await p.locator('#importExcelFile').setInputFiles(ifile);await toast(p,'新增 1 份，更新 1 份');
await p.waitForFunction(()=>document.querySelectorAll('#contractTableBody tr[data-id]').length===2);
const a1=(await p.locator('tr[data-id="a1"] td').allTextContents()).map(x=>x.trim());console.log('a1 after',a1);assert(a1.includes('钱七'));const a1Saved=await p.evaluate(async()=>(await Storage.getAllContracts()).find(c=>c.id==='a1'));assert.equal(a1Saved.engagementCode,'E-0001');assert.equal(a1Saved.engagementName,'Guangzhou engagement');assert(a1.includes('安永华明会计师事务所'),'blank cell must not erase');
const newRow=p.locator('#contractTableBody tr[data-id]').filter({hasText:'新导入项目'});const nr=(await newRow.locator('td').allTextContents()).map(x=>x.trim().replace(/\s+/g,' '));console.log('new',nr);assert(nr.includes('孙八'));assert(nr.join(' ').includes('ITGC'));
// reimport same file: no changes
await p.locator('#importExcelFile').setInputFiles(ifile);await toast(p,'无变化 2');
// 上传到云端总表 lives on the upload page; without a configured path it sends you to 系统设置
const cloudUpload=async()=>{await p.locator('[data-ok]').click();};
await p.locator('#cloudMergeBtn').click();await cloudUpload();await toast(p,'设置');
await p.locator('#cfgCloudExcel').fill(cloud);await p.locator('#saveCloudExcelBtn').click();await p.waitForFunction(()=>document.getElementById('cloudExcelState').textContent.includes('已保存'));
await p.reload();await p.waitForFunction(()=>window.__CONTRACT_OCR_READY);await p.locator('[data-view="settings"]').click();await p.waitForFunction(v=>document.getElementById('cfgCloudExcel').value===v,cloud);
await p.locator('[data-view="upload"]').click();await p.locator('#cloudMergeBtn').click();await cloudUpload();await toast(p,'新增 2 行');
// hand-add a column + row in master, then merge again
const master=path.join(cloud,'合同识别总表.xlsx');
pyRun('h,r=e.read_xlsx(open('+JSON.stringify(master)+',"rb").read());h.append("\\u5907\\u6ce8");r[0]["\\u5907\\u6ce8"]="\\u624b\\u586b";r.append({"\\u9879\\u76ee\\u540d\\u79f0":"other","\\u7532\\u65b9":"X"});open('+JSON.stringify(master)+',"wb").write(e.write_xlsx(h,r))');
await p.locator('#cloudMergeBtn').click();await cloudUpload();await toast(p,'更新 2 行');
const m=JSON.parse(pyRun('h,r=e.read_xlsx(open('+JSON.stringify(master)+',"rb").read());sys.stdout.buffer.write(json.dumps({"h":h,"r":r}).encode())'));console.log(m.h,m.r.map(r=>[r['项目名称'],r['FIC'],r['备注']]));
assert.equal(m.r.length,3);assert(m.r.filter(r=>r['合同ID']).every(r=>r['上传者ID']===me));assert.equal(m.r.find(r=>r['合同ID']==='a1')['Engagement Code'],'E-0001');assert(m.h.indexOf('Engagement Code')===2&&m.h.indexOf('Engagement Name')===4);assert(['服务领域','具体服务','系统'].every(h=>m.h.includes(h)));assert(m.h.includes('备注'));assert(m.r.some(r=>r['备注']==='手填'));assert(fs.readdirSync(cloud).some(f=>f.includes('备份')));
// 合同检索：本机合同 + 云盘总表中不在本机的合同（他人上传，只读），表格与我的合同相同，并跟随保存的路径变化。
await p.locator('[data-view="vault-search"]').click();
assert(!(await p.locator('#demo-searchResults').isVisible()));
await p.locator('#demo-searchPage .search-advanced > summary').click();
assert(await p.locator('#demo-engagementCode').isVisible());
assert(await p.locator('#demo-filter-specificTags').isVisible());
await p.locator('#demo-person').fill('钱七');
await p.locator('#demo-resultBody tr[data-id="a1"]').waitFor();
assert.equal(await p.locator('#demo-searchResults').getByText('我上传').count(),0,'no 我上传 label in the UI');
assert.deepEqual((await p.locator('#demo-searchResults thead th').allTextContents()).map(x=>x.trim()),['项目名称','甲方','乙方','签约时间','原始关键词','PIC','EIC','FIC','操作']);
await p.locator('#demo-reset').click();
assert(!(await p.locator('#demo-searchResults').isVisible()));
await p.locator('#demo-keyword').fill('other');
const cloudCard=p.locator('#demo-resultBody tr.row-remote').filter({hasText:'other'});
await cloudCard.waitFor();
assert((await cloudCard.innerText()).includes('只读'));assert.equal(await cloudCard.locator('[data-edit]').count(),0);assert.equal(await cloudCard.locator('[data-delete]').count(),0);
await cloudCard.locator('[data-row]').click();
assert.deepEqual(await p.locator('#demo-vaultDetailBody .facts span').allTextContents(),
 ['上传者ID','Engagement Code','Engagement Code Description','Engagement Name','甲方','乙方','签约时间','原始关键词','服务领域','具体服务','系统','PIC','EIC','FIC','来源文件','合同ID']);
await p.locator('#demo-close').click();
await p.locator('#demo-keyword').fill('手填');
await p.waitForFunction(()=>document.querySelector('#demo-resultBody .empty-row')&&!document.getElementById('demo-summary').textContent.includes('正在'));
const otherMaster=path.join(work,'other-master.xlsx');
pyRun('open('+JSON.stringify(otherMaster)+',"wb").write(e.write_xlsx(e.COLUMNS,[{"\\u9879\\u76ee\\u540d\\u79f0":"other from second master","\\u4e0a\\u4f20\\u8005ID":"\\u540c\\u4e8b\\u4e59","\\u5408\\u540cID":"remote-1"}]))');
await p.locator('[data-view="settings"]').click();
await p.waitForFunction(v=>document.getElementById('cfgCloudExcel').value===v&&!document.getElementById('saveCfgBtn').disabled,cloud);
await p.locator('#cfgCloudExcel').fill(otherMaster);
await p.locator('#saveCloudExcelBtn').click();
await p.waitForFunction(()=>document.getElementById('cloudExcelState').textContent.includes('已保存'));
await p.locator('[data-view="vault-search"]').click();
await p.locator('#demo-keyword').fill('other');
const second=p.locator('#demo-resultBody tr.row-remote').filter({hasText:'other from second master'});
await second.waitFor({timeout:5000}).catch(async error=>{console.error(await p.locator('#demo-summary').innerText(),await p.locator('#demo-resultBody').innerText());throw error;});
assert.equal(await p.locator('#demo-resultBody tr.row-remote').count(),1);await second.locator('[data-row]').click();assert((await p.locator('#demo-vaultDetailBody').innerText()).includes('同事乙'));await p.locator('#demo-close').click();
// 多个关键词：逗号 / 分号 / 空格分隔；全部包含 vs 包含任一
await p.locator('#demo-keyword').fill('other，second');
await p.waitForFunction(()=>document.querySelectorAll('#demo-resultBody tr.row-remote').length===1&&!document.getElementById('demo-summary').textContent.includes('正在'));
await p.locator('#demo-keyword').fill('second；广州视睿');
await p.waitForFunction(()=>document.querySelector('#demo-resultBody .empty-row')&&!document.getElementById('demo-summary').textContent.includes('正在'));
await p.locator('#demo-matchMode').selectOption('any');
await p.waitForFunction(()=>document.querySelector('#demo-resultBody tr[data-id="a1"]')&&document.querySelectorAll('#demo-resultBody tr.row-remote').length===1&&!document.getElementById('demo-summary').textContent.includes('正在'));
assert.equal(await p.locator('#demo-resultBody mark').filter({hasText:'second'}).count()>0,true);
await p.locator('#demo-matchMode').selectOption('all');
await p.locator('#demo-keyword').fill('广州视睿');
await p.waitForFunction(()=>document.querySelector('#demo-resultBody tr[data-id="a1"]')&&!document.querySelector('#demo-resultBody tr.row-remote')&&!document.getElementById('demo-summary').textContent.includes('正在'));
await p.locator('#demo-keyword').fill('');
await p.waitForFunction(()=>document.getElementById('demo-searchResults').hidden);
// 我的合同（上传识别页）只显示本机合同；筛选框仍可用
await p.locator('[data-view="upload"]').click();await p.locator('#searchInput').fill('新导入');await p.waitForFunction(()=>document.querySelectorAll('#contractTableBody tr[data-id]').length===1);await p.locator('#searchInput').fill('');
// 编辑弹窗（原合同整理与标签管理）：FIC 来自导入
await p.locator('[data-view="upload"]').click();await p.locator('tr[data-id="a1"] [data-action="edit"]').click();await p.locator('#demo-editorDialog').waitFor({state:'visible'});assert.equal(await p.locator('#demo-editFic').inputValue(),'钱七');
assert.equal(await p.locator('#demo-editAmount').count(),0);assert.equal(await p.locator('#demo-editEnterpriseSize').count(),0);
for(const id of ['#demo-add-keywords','#demo-add-services','#demo-add-specificTags','#demo-generateTags','#demo-extractKeywords','#demo-keywordsEditor button','#demo-specificTagsEditor button','#demo-servicesEditor button'])assert.equal(await p.locator(id).count(),0,id+' must be read-only');await p.locator('#demo-add-systems').fill('Workday');await p.locator('#demo-add-systems').press('Enter');
await p.locator('#demo-editorForm [type=submit]').click();await p.locator('#demo-editorDialog').waitFor({state:'hidden'});
const edited=await p.evaluate(async()=>(await Storage.getAllContracts()).find(c=>c.id==='a1'));assert(edited.knowledgeProfile.systems.includes('Workday'));assert.equal(edited.uploadedByName,me);

assert.deepEqual(errs,[]);console.log('ALL PASS');
}catch(error){console.error(logs.slice(-3000));throw error;}finally{await b.close();s.kill();}})().catch(e=>{console.error(e);process.exit(1)});
