/* Secretary UI acceptance. Use only tests/secretary_browser_host.py's temporary service/data. */
const assert=require('assert'),path=require('path'),fs=require('fs'),{execFileSync}=require('child_process');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
(async()=>{
 const origin=process.env.TEST_ORIGIN,work=process.env.TEST_WORK;
 if(!origin||!work||!process.env.PYTHON)throw Error('Run with disposable browser host');
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined});const errors=[];
 try{
  const page=await browser.newPage({acceptDownloads:true,viewport:{width:1500,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(origin);await page.waitForFunction(()=>window.__CONTRACT_OCR_READY===true,null,{timeout:60000});
  assert.equal(await page.locator('#view-settings,[data-view="settings"]').count(),0);
  assert.equal(await page.locator('#cfgWorkers,#saveCfgBtn,#cfgUploader,#saveUploaderBtn,#clearStorageBtn').count(),0);
  assert.equal(await page.locator('#cfgCloudExcel,#saveCloudExcelBtn').count(),0);
  await page.locator('#ocrMode').selectOption('fast');
  const chooserPromise=page.waitForEvent('filechooser');await page.locator('#uploadZone').click();const chooser=await chooserPromise;
  await chooser.setFiles(['text.pdf','scan.pdf','image.png'].map(n=>path.join(work,n)));
  const api=(url,body)=>page.evaluate(async({url,body})=>{const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{...NativeDocuments.headers(),'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error(await response.text());return response.json();},{url,body});
  let records=[];
  for(let i=0;i<240;i++){records=await api('/api/contracts');if(records.length===3&&records.every(c=>c.businessSnapshot&&c.ruleAnalysisStatus==='done'))break;await page.waitForTimeout(500);}
  assert.equal(records.length,3);assert(records.every(c=>c.rawText.includes('ITGC')));assert(records.every(c=>c.businessSnapshot));
  assert.equal(records.find(c=>c.sourceFile==='text.pdf').pageCount,2);
  assert.equal(records.find(c=>c.sourceFile==='scan.pdf').ocrUsed,true);assert.equal(records.find(c=>c.sourceFile==='image.png').ocrUsed,true);
  const projected=await page.evaluate(()=>Storage.getAllContracts().then(cs=>cs.map(c=>({id:c.id,keywords:VaultModel.project(c).keywords,tags:VaultModel.project(c).specificTags}))));
  assert(projected.some(c=>c.keywords.length&&c.tags.length));
  const text=records.find(c=>c.sourceFile==='text.pdf');
  await page.locator(`#contractTableBody tr[data-id="${text.id}"] [data-action="edit"]`).click();await page.locator('#demo-editorDialog').waitFor({state:'visible'});
  await page.locator('#demo-editEngagementCode').fill('SECRETARY-TEST-001');
  await page.locator('#demo-add-systems').fill('测试系统');await page.locator('#demo-add-systems').press('Enter');
  await page.locator('#demo-editorForm button[type="submit"]').click();await page.locator('#demo-editorDialog').waitFor({state:'hidden'});
  const edited=(await api('/api/contracts')).find(c=>c.id===text.id);assert.equal(edited.engagementCode,'SECRETARY-TEST-001');assert(edited.knowledgeProfile.systems.includes('测试系统'));
  const cloud=path.join(work,'cloud');fs.mkdirSync(cloud,{recursive:true});
  await page.reload();await page.waitForFunction(()=>window.__CONTRACT_OCR_READY===true);assert.equal(await page.locator('#cfgCloudExcel').count(),0);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#exportExcelBtn').click()]);const exported=path.join(work,'export.xlsx');await download.saveAs(exported);
  const root=path.resolve(__dirname,'..'),imported=path.join(work,'import.xlsx');
  const parsed=JSON.parse(execFileSync(process.env.PYTHON,['-c',"import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import excel_table as e;h,r=e.read_xlsx(Path(sys.argv[2]).read_bytes());r[0]['PIC']='虚构测试PIC';Path(sys.argv[3]).write_bytes(e.write_xlsx(h,r));print(json.dumps({'columns':h,'rows':len(r)}))",path.join(root,'native'),exported,imported]).toString());
  assert.equal(parsed.columns.length,17);assert.equal(parsed.rows,3);
  await page.locator('#importExcelFile').setInputFiles(imported);
  for(let i=0;i<60;i++){if((await api('/api/contracts')).some(c=>c.knowledgeProfile?.pic==='虚构测试PIC'))break;await page.waitForTimeout(250);}
  assert((await api('/api/contracts')).some(c=>c.knowledgeProfile?.pic==='虚构测试PIC'));
  await page.locator('#cloudMergeBtn').click();await page.locator('[data-ok]').click();
  for(let i=0;i<60&&!fs.existsSync(path.join(cloud,'合同识别总表.xlsx'));i++)await page.waitForTimeout(250);
  assert(fs.existsSync(path.join(cloud,'合同识别总表.xlsx')));
  await page.locator('.nav-item[data-view="vault-search"]').click();await page.locator('#demo-keyword').fill('ITGC');await page.locator('#demo-searchForm').evaluate(f=>f.requestSubmit());await page.locator('#demo-resultBody tr[data-id]').first().waitFor();
  assert.equal(await page.locator('#demo-resultBody tr[data-id]').count(),3);
  // Existing workbook-share search: add a fictional remote row through the original merge writer.
  execFileSync(process.env.PYTHON,['-c',"import sys;sys.path.insert(0,sys.argv[1]);import excel_table as e;e.merge_into_master(sys.argv[2],[{'项目名称':'虚构共享业务项目','上传者ID':'虚构共享同事','合同ID':'external-fictional','原始关键词':'SHARE-ONLY-TEST','服务领域':'风险管理'}])",path.join(root,'native'),cloud]);
  await page.locator('#demo-keyword').fill('SHARE-ONLY-TEST');await page.locator('#demo-searchForm').evaluate(f=>f.requestSubmit());await page.locator('.row-remote').first().waitFor({timeout:20000});
  assert.equal(await page.locator('.row-remote [data-edit]').count(),0);await page.locator('.row-remote [data-row]').click();await page.locator('#demo-detail').waitFor({state:'visible'});
  const screenshot=path.join(root,'test-output');fs.mkdirSync(screenshot,{recursive:true});await page.screenshot({path:path.join(screenshot,'secretary-search.png'),fullPage:true});
  if(errors.length)throw Error(errors.join('\n'));
  console.log(JSON.stringify({host:process.platform+' '+process.arch+' Chromium',packagedExecutable:process.env.SECRETARY_TEST_PACKAGED==='1',settingsNavigationRemoved:true,settingsPageRemoved:true,settingsOnlyControlsRemoved:true,cloudPathEditorRemoved:true,fileChooserEvent:true,realTextPDF:true,realMultiPagePDF:true,realScannedPDFOCR:true,realImageOCR:true,fullTextSaved:true,fieldKeywordTagAnalysis:true,originalEditorAndSystemTag:true,excel17ColumnExport:true,excelImport:true,builtInCloudPathUsed:true,originalCloudMergeWritten:true,contractSearch:true,existingWorkbookShareReadOnlySearch:true,independentShareAuthorization:'not present in input source; not claimed tested',javascriptExceptions:0,realOneDriveSyncTested:false,windowsTested:process.platform==='win32'}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
