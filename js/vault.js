/**
 * 合同检索页与合同编辑弹窗（原「合同整理与标签管理」）。
 * - 合同检索页：本机合同即时过滤；输入关键词后同时查询设置中的云盘 Excel 总表，
 *   总表里不在本机的合同即他人上传，只读。结果表格与「我的合同」相同。
 * - 编辑：上传识别结果卡片和合同列表的「编辑」打开同一弹窗；只编辑本机合同。
 */
const Vault=(()=>{let api=null;
function init(hooks){api=mount(hooks);}
function mount(hooks){
let industry=JSON.parse(JSON.stringify(ContractFacts.industryTree));
let contracts=[],originals=[],saving=false,discarded=false;
const $=id=>document.getElementById('demo-'+id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const serviceOptions=ServiceContent.domainNames;
function extendIndustry(path){const[a,b,c]=path;if(!a)return;industry[a]??={};if(b){industry[a][b]??=[];if(c&&!industry[a][b].includes(c))industry[a][b].push(c);}}
function options(el,items,label){el.replaceChildren(new Option(label,''),...items.map(x=>new Option(x,x)));}

// ===================== 检索筛选 =====================
// 多选筛选：组内任一命中，组间同时满足；空数组表示不限。
const filterState={services:[],specificTags:[],systems:[]};
// Engagement 筛选：按合同上保存的 Engagement 字段匹配。
const ENGAGEMENT_FILTERS={engagementCode:['engagementCode'],engagementName:['engagementName','engagementCodeDescription']};
const FILTER_INPUTS=['person','eic','pic',...Object.keys(ENGAGEMENT_FILTERS)];
// 有方向的参考关系：业务相关，绝不代表服务相同。
const businessLinks=[
 {from:['数据咨询','数据核查','数据治理'],to:['数据治理','数据安全','经营分析','数据','对账'],why:'数据质量与管理相关，可参考数据口径、核对或安全管理经验'},
 {from:['SAP 权限风险','权限风险','权限管理','ITGC'],to:['IT 权限','ITGC','IT 一般控制','职责分离','授权审批'],why:'权限与控制相关，可参考授权、职责分离或 IT 控制方法'},
 {from:['SOX','上市合规'],to:['内控','财务报告','控制测试'],why:'财务报告合规与内控有关，但不代表已提供 SOX 服务'},
 {from:['财务转型','业财融合','业财'],to:['预算','成本','收入','经营分析'],why:'业财协同涉及预算、成本或收入流程，可参考相关交付经验'},
 {from:['风险评估','风险咨询'],to:['内控','供应链','投资','合规'],why:'风险识别与控制设计存在业务关联，具体风险范围仍需核对'},
 {from:['流程优化'],to:['预算','对账','内控','采购','业财'],why:'涉及业务流程改进，可参考方法，服务范围并不等同'}
];
function pickerOptions(key){if(key==='services')return serviceOptions;if(key==='specificTags')return [...new Set(contracts.flatMap(c=>c.specificTags))];if(key==='systems')return [...new Set(contracts.flatMap(c=>c.systems))];return [...new Set(['合规','财务转型','流程优化','风险管理','成本管理','数据安全','收入管理',...contracts.flatMap(c=>c.need.split(/[，。；;\n]+/).map(x=>x.trim()).filter(Boolean))])];}
function pickerSuggestions(key){const q=$('filter-'+key).value.trim().toLowerCase();return pickerOptions(key).filter(v=>!filterState[key].some(x=>x.toLowerCase()===v.toLowerCase())&&v.toLowerCase().includes(q));}
function drawPicker(key){const root=$('picker-'+key);root.querySelector('.selected-tags').innerHTML=filterState[key].map((v,i)=>`<span class="select-chip">${esc(v)}<button type="button" data-remove="${i}" aria-label="移除${esc(v)}">×</button></span>`).join('');drawPickerMenu(key);}
function drawPickerMenu(key){const query=$('filter-'+key).value.trim(),values=pickerSuggestions(key);$('menu-'+key).innerHTML=values.map(v=>`<button type="button" role="option" aria-selected="false" data-value="${esc(v)}">${esc(v)}</button>`).join('')+(query&&!pickerOptions(key).some(v=>v.toLowerCase()===query.toLowerCase())?`<button type="button" role="option" aria-selected="false" data-value="${esc(query)}">＋ 添加“${esc(query)}”</button>`:'')+(!values.length&&!query?'<span class="hint">暂无其他选项，可输入新名称</span>':'');}
function addFilter(key,value){value=value.trim();if(!value)return;if(key==='services'){const known=pickerOptions('services').find(v=>VaultModel.normalizeSearch(ServiceContent.canonicalDomain(v))===VaultModel.normalizeSearch(ServiceContent.canonicalDomain(value)));if(!known){$('filter-'+key).setCustomValidity('请选择领域库中的名称；新业务领域可在本地领域库中添加，ITGC 等活动使用具体服务筛选。');$('filter-'+key).reportValidity();return;}value=known;}$('filter-'+key).setCustomValidity('');if(!filterState[key].some(x=>x.toLowerCase()===value.toLowerCase()))filterState[key].push(value);$('filter-'+key).value='';drawPicker(key);changed();}
function initPickers(){for(const [key,label] of Object.entries({services:'服务领域',specificTags:'具体服务',systems:'涉及系统'})){const root=$('picker-'+key);root.innerHTML=`<div class="selected-tags"></div><div class="picker-entry"><input id="demo-filter-${key}" maxlength="120" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="demo-menu-${key}" aria-label="${label}：输入或多选" placeholder="输入或选择，可多选"><button type="button" class="picker-add" aria-label="添加${label}">＋</button></div><div class="picker-menu" id="demo-menu-${key}" role="listbox" aria-label="${label}可选项" hidden></div>`;const input=$('filter-'+key),menu=$('menu-'+key);const show=()=>{input.setCustomValidity('');drawPickerMenu(key);menu.hidden=false;input.setAttribute('aria-expanded','true');};input.addEventListener('focus',show);input.addEventListener('input',show);input.addEventListener('keydown',e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();addFilter(key,input.value);show();}if(e.key==='ArrowDown'){e.preventDefault();show();menu.querySelector('button')?.focus();}if(e.key==='Escape'){menu.hidden=true;input.setAttribute('aria-expanded','false');}});root.addEventListener('click',e=>{const remove=e.target.closest('[data-remove]'),item=e.target.closest('[data-value]');if(remove){filterState[key].splice(Number(remove.dataset.remove),1);drawPicker(key);changed();}else if(item){addFilter(key,item.dataset.value);input.focus();}else if(e.target.closest('.picker-add')){addFilter(key,input.value);input.focus();}});menu.addEventListener('keydown',e=>{const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Escape'){input.focus();menu.hidden=true;input.setAttribute('aria-expanded','false');}});drawPicker(key);}document.addEventListener('click',e=>{if(discarded)return;for(const key of Object.keys(filterState))if(!$('picker-'+key).contains(e.target)){$('menu-'+key).hidden=true;$('filter-'+key).setAttribute('aria-expanded','false');}});}

const plain=v=>VaultModel.normalizeSearch(v);
function advancedActive(){return FILTER_INPUTS.some(k=>$(k).value.trim())||Object.values(filterState).some(v=>v.length);}
function people(){return Object.fromEntries(['person','eic','pic'].map(key=>[key,$(key).value.trim()]));}
// 列表文字搜索同时覆盖原列表字段（甲乙方、来源文件、上传者ID）与检索字段（关键词、Tag、行业等）。
// 多个关键词：用空格、逗号、分号或顿号分隔；「全部包含」需每个词都命中，「包含任一」命中一个即可。
const splitTerms=q=>String(q||'').split(/[\s,，;；、]+/).map(x=>x.trim()).filter(Boolean);
const matchAny=()=>$('matchMode').value==='any';
function matchTerm(p,q){
 const m=VaultModel.matchContract(p,q,businessLinks);if(m.kind!=='none')return m;
 const o=originals.find(c=>c.id===p.id)||{};
 return [o.partyA,o.partyB,o.sourceFile,o.signDate,o.uploadedByName,o.engagementCode,o.engagementCodeDescription,o.engagementName].some(v=>v&&plain(v).includes(plain(q)))?{kind:'direct',reasons:[]}:m;
}
function matchLocal(p,q){
 const terms=splitTerms(q);if(terms.length<=1)return matchTerm(p,terms[0]||q);
 const results=terms.map(t=>matchTerm(p,t)),hit=results.filter(r=>r.kind!=='none');
 if(matchAny()?!hit.length:hit.length<terms.length)return {kind:'none',reasons:[]};
 return {kind:hit.some(r=>r.kind==='direct')&&(matchAny()||hit.every(r=>r.kind==='direct'))?'direct':'related',reasons:[...new Set(hit.flatMap(r=>r.reasons||[]))]};
}
function filterLocal(query){
 const who=people(),matches=new Map(),engagement=Object.fromEntries(Object.keys(ENGAGEMENT_FILTERS).map(k=>[k,$(k).value.trim().toLowerCase()]));
 for(const c of contracts){
  const o=originals.find(x=>x.id===c.id)||{};
  if(Object.entries(ENGAGEMENT_FILTERS).some(([k,fields])=>engagement[k]&&!fields.some(f=>String(o[f]||'').toLowerCase().includes(engagement[k]))))continue;
  if(filterState.services.length&&!filterState.services.some(t=>VaultModel.matchesDimension(c.services,t,'services')))continue;
  if(filterState.specificTags.length&&!filterState.specificTags.some(t=>VaultModel.matchesDimension(c.specificTags,t,'specificTags')))continue;
  if(filterState.systems.length&&!filterState.systems.some(t=>VaultModel.matchesDimension(c.systems,t,'systems')))continue;
  if(['eic','pic'].some(k=>who[k]&&!String(c[k]||'').toLowerCase().includes(who[k].toLowerCase())))continue;
  if(who.person&&!(c.eic+' '+c.pic+' '+(c.fic||'')).toLowerCase().includes(who.person.toLowerCase()))continue;
  const match=query?matchLocal(c,query):{kind:'direct',reasons:[]};
  if(match.kind!=='none')matches.set(c.id,match);
 }
 return matches;
}
// 检索结果：本机合同（我上传，可编辑）+ 云盘 Excel 总表里不在本机的合同（他人上传，只读），以卡片展示。
// 本机部分即时过滤；云盘总表在输入后自动查询（防抖），条件变化即失效。
let remote={key:null,rows:[],total:0,loading:false,error:''},requestId=0,timer=null,remoteTimer=null,shown=[];
function criteriaKey(){return JSON.stringify({q:$('keyword').value.trim(),any:matchAny(),p:people(),f:filterState,t:FILTER_INPUTS.map(k=>$(k).value)});}
function changed(){if(discarded)return;clearTimeout(timer);timer=setTimeout(render,120);clearTimeout(remoteTimer);if($('keyword').value.trim())remoteTimer=setTimeout(searchTeam,450);}
async function searchTeam(){
 if(discarded)return;clearTimeout(remoteTimer);
 const query=$('keyword').value.trim(),key=criteriaKey(),id=++requestId;
 if(!query){remote={key,rows:[],total:0,loading:false,error:''};render();return;}
 remote={key,rows:[],total:0,loading:true,error:''};render();
 const local=filterLocal(query.toLowerCase()),advanced=advancedActive();
 try{
  const {rows,total}=await hooks.searchCloud({query,people:people(),eligibleIds:advanced?[...filterLocal('').keys()]:null,
   directIds:[...local].filter(([,m])=>m.kind==='direct').map(([id])=>id),relatedIds:[...local].filter(([,m])=>m.kind==='related').map(([id])=>id),matchAny:matchAny()});
  if(id!==requestId||discarded)return;
  remote={key,rows,total,loading:false,error:''};
 }catch(error){if(id!==requestId||discarded)return;remote={key,rows:[],total:0,loading:false,error:error.message};}
 render();
}
function words(text){return [...new Set(String(text||'').split(/[；;、]/).map(x=>x.trim()).filter(Boolean))];}
// 结果表格与「我的合同」相同的列；本机合同可查看 / 编辑 / 删除，他人上传（云盘总表）只读。
const ICON_VIEW='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EDIT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const ICON_DELETE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
// 命中的关键词排在前面，避免被「+N」折叠看不到。
// fromText：搜索词不在已提取的关键词里、但出现在合同全文中时，在结果中补进关键词列（仅显示，不保存）。
function keywordCell(list,fromText=[]){const terms=highlightTerms().map(t=>t.toLowerCase());const hit=k=>terms.some(t=>String(k).toLowerCase().includes(t));list=[...list.filter(hit),...list.filter(k=>!hit(k))];const extra=fromText.map(k=>`<span class="list-kw from-text" title="合同全文中出现；未保存为关键词，如需保存请点「编辑」添加">${highlight(k)}</span>`).join('');const shownWords=list.slice(0,Math.max(0,6-fromText.length));return `<td class="kw-cell" title="${esc([...fromText,...list].join('；'))}"><div class="list-kws">${extra}${shownWords.length||fromText.length?shownWords.map(k=>`<span class="list-kw">${highlight(k)}</span>`).join('')+(list.length>shownWords.length?`<span class="list-kw more">+${list.length-shownWords.length}</span>`:''):'<span class="list-kw-empty">-</span>'}</div></td>`;}
// 合同全文里出现、但已提取的关键词中没有的搜索词（OCR 可能在字间插入空格或换行）。
function textOnlyTerms(keywords,text){
 const body=String(text||''),have=keywords.map(k=>String(k).toLowerCase());
 return highlightTerms().filter(term=>!have.some(k=>k.includes(term.toLowerCase()))&&new RegExp([...term].map(ch=>ch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*'),'i').test(body));
}
function resultRow(item,index){
 const related=item.kind==='related'?`<span class="match-kind" title="${esc((item.reasons||[]).join('；'))}">相关</span>`:'';
 if(item.type==='local'){
  const c=item.contract,o=originals.find(x=>x.id===c.id)||{};
  return `<tr data-index="${index}" data-id="${esc(c.id)}"><td><div class="project-name" title="${esc(o.projectName||c.name||'')}">${highlight(o.projectName||c.name||'未识别项目')}${related}</div></td><td>${highlight(o.partyA||'-')}</td><td>${highlight(o.partyB||'-')}</td><td>${esc(o.signDate||'-')}</td>${keywordCell(c.keywords||[],textOnlyTerms(c.keywords||[],c.uploadCategory==='ey-template'&&typeof ContractScope!=='undefined'?ContractScope.textFor(c):(o.rawText||c.rawText)))}${['pic','eic','fic'].map(k=>`<td class="person-cell">${highlight(c[k]||'-')}</td>`).join('')}<td><div class="row-actions"><button class="row-action-btn" type="button" data-open="${index}" title="查看详情">${ICON_VIEW}</button><button class="row-action-btn" type="button" data-edit="${index}" title="编辑">${ICON_EDIT}</button><button class="row-action-btn danger" type="button" data-delete="${index}" title="删除">${ICON_DELETE}</button></div></td></tr>`;
 }
 const row=item.row;
 return `<tr data-index="${index}" class="row-remote"><td><div class="project-name" title="${esc(row['项目名称']||'')}">${highlight(row['项目名称']||'未识别项目')}${related}</div></td><td>${highlight(row['甲方']||'-')}</td><td>${highlight(row['乙方']||'-')}</td><td>${esc(row['签约时间']||'-')}</td>${keywordCell(words(row['原始关键词']),textOnlyTerms(words(row['原始关键词']),[row['服务领域'],row['具体服务'],row['系统']].join(' ')))}${['PIC','EIC','FIC'].map(k=>`<td class="person-cell">${highlight(row[k]||'-')}</td>`).join('')}<td><div class="row-actions"><button class="row-action-btn" type="button" data-row="${index}" title="查看（他人上传，只读）">${ICON_VIEW}</button><span class="readonly-note">只读</span></div></td></tr>`;
}
function render(){
 if(discarded)return;
 const query=$('keyword').value.trim(),active=!!query||advancedActive();
 $('searchPage').classList.toggle('has-results',active);$('searchResults').hidden=!active;
 for(const key of ['summary','count'])$(key).textContent='';$('resultBody').innerHTML='';
 shown=[];if(!active)return;
 const matches=filterLocal(query),current=remote.key===criteriaKey()?remote:null,known=new Set(contracts.map(c=>c.id));
 const serverLocal=new Set((current?.rows||[]).map(x=>x.row['合同ID']).filter(id=>id&&known.has(id)));
 const local=contracts.filter(c=>matches.has(c.id)||serverLocal.has(c.id)).map(c=>({type:'local',contract:c,kind:matches.get(c.id)?.kind||'direct',reasons:matches.get(c.id)?.reasons||[],date:(originals.find(o=>o.id===c.id)||{}).signDate||''}));
 const others=(current?.rows||[]).filter(x=>!x.row['合同ID']||!known.has(x.row['合同ID'])).map(x=>({type:'remote',row:x.row,kind:x.kind,date:x.row['签约时间']||''}));
 shown=[...local,...others];
 const sort=$('sort').value,rank=x=>x.kind==='related'?1:0;
 shown.sort((a,b)=>sort==='default'?rank(a)-rank(b):(!a.date||!b.date)?Number(!a.date)-Number(!b.date):a.date.localeCompare(b.date)*(sort==='asc'?1:-1));
 $('count').textContent=`${shown.length} 条结果`;
 $('resultBody').innerHTML=shown.length?shown.map(resultRow).join(''):'<tr class="empty-row"><td colspan="9">没有找到匹配结果，请尝试其他关键词。</td></tr>';
 const parts=[`本机合同 ${local.length} 份`];
 if(!query)parts.push('输入关键词可同时检索云盘总表');
 else if(current?.loading)parts.push('正在检索云盘总表…');
 else if(current?.error)parts.push(`<span class="error">云盘总表：${esc(current.error)}</span>`);
 else if(current)parts.push(`他人上传 ${others.length} 份${current.total>current.rows.length?`（共 ${current.total} 份，显示前 ${current.rows.length} 份）`:''}`);
 $('summary').innerHTML=parts.join(' · ');
}
function reset(){FILTER_INPUTS.concat('keyword').forEach(id=>$(id).value='');for(const key of Object.keys(filterState)){filterState[key]=[];$('filter-'+key).value='';drawPicker(key);$('menu-'+key).hidden=true;$('filter-'+key).setAttribute('aria-expanded','false');}$('sort').value='default';remote={key:null,rows:[],total:0,loading:false,error:''};render();}
$('matchMode').addEventListener('change',changed);$('sort').addEventListener('change',render);
['keyword',...FILTER_INPUTS].forEach(id=>$(id).addEventListener('input',changed));
$('reset').onclick=reset;
$('searchForm').onsubmit=e=>{e.preventDefault();for(const key of Object.keys(filterState))if($('filter-'+key).value.trim())addFilter(key,$('filter-'+key).value);render();searchTeam();};
$('searchPage').querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>{$('keyword').value=b.dataset.key;render();searchTeam();});
function highlightTerms(){return splitTerms($('keyword').value).sort((a,b)=>b.length-a.length);}
function highlight(value){const terms=highlightTerms();let text=esc(value);if(!terms.length)return text;const pattern=terms.map(v=>esc(v).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');return text.replace(new RegExp(pattern,'gi'),v=>`<mark>${v}</mark>`);}
// 他人合同只读详情：展示云盘总表这一行的全部列。
function showRow(row){
 $('detailTitle').textContent=row['项目名称']||'未识别项目';
 $('vaultDetailBody').innerHTML=`<p class="hint">他人上传的合同（来自云盘 Excel 总表），仅可查看。</p><div class="facts">${Object.entries(row).filter(([label])=>label!=='项目名称').map(([label,value])=>`<div><span>${esc(label)}</span><strong>${value?highlight(value):'—'}</strong></div>`).join('')}</div>`;
 $('detail').showModal();
}
$('resultBody').addEventListener('click',e=>{
 const open=e.target.closest('[data-open]'),edit=e.target.closest('[data-edit]'),del=e.target.closest('[data-delete]'),row=e.target.closest('[data-row]');
 if(open)hooks.openDetail(shown[Number(open.dataset.open)].contract.id);
 else if(edit)openEditor(shown[Number(edit.dataset.edit)].contract.id);
 else if(del)hooks.deleteContract(shown[Number(del.dataset.delete)].contract.id);
 else if(row)showRow(shown[Number(row.dataset.row)].row);
});
$('resultBody').addEventListener('dblclick',e=>{const tr=e.target.closest('tr[data-index]');if(!tr)return;const item=shown[Number(tr.dataset.index)];if(item.type==='local')hooks.openDetail(item.contract.id);else showRow(item.row);});
$('close').onclick=()=>$('detail').close();
$('detail').addEventListener('click',e=>{if(e.target===$('detail')){const r=$('detail').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('detail').close();}});

// ===================== 编辑弹窗（原合同整理与标签管理） =====================
// 使用独立草稿；只有成功保存才写回合同库。
let draft=null,dirty=false,editingTag=null,draftRevision=null;
const editorGroups={keywords:'关键词',systems:'系统',services:'服务领域',specificTags:'具体服务'};
const TEXT_FIELDS={editName:'name',editPartyA:'partyA',editEngagementCode:'engagementCode',editEngagementCodeDescription:'engagementCodeDescription',editEngagementName:'engagementName',editPartyB:'partyB',editSignDate:'signDate',editEic:'eic',editPic:'pic',editFic:'fic'};
const copy=x=>JSON.parse(JSON.stringify(x));
function status(message,error=false){$('saveStatus').textContent=message;$('saveStatus').classList.toggle('error',error);}
function markDirty(){if(!draft)return;dirty=true;$('draftState').textContent='● 有未保存修改';status('修改尚未保存。');}
function loadDraft(id){
 const original=originals.find(c=>c.id===id),projected=contracts.find(c=>c.id===id);if(!original||!projected)return false;
 draftRevision=original.ocrRevision;
 draft={...copy(projected),partyA:original.partyA||'',partyB:original.partyB||'',signDate:original.signDate||'',engagementCode:original.engagementCode||'',engagementCodeDescription:original.engagementCodeDescription||'',engagementName:original.engagementName||''};
 dirty=false;editingTag=null;
 for(const [field,key] of Object.entries(TEXT_FIELDS))$(field).value=draft[key]??'';
 renderEditors();
 $('editorTitle').textContent='编辑合同 · '+(draft.name||'未命名合同');
 $('draftState').textContent=ContractScope.resolve(draft).label+' · '+draft.id;
 status('修改仅在保存后写入合同库，可合并到云盘总表。');
 return true;
}
// 关键词、服务领域、具体服务只读（自动识别，保证云盘总表口径一致）；只有「系统」可手动添加和修改。
const READONLY_GROUPS=['keywords','services','specificTags'];
function renderEditors(){Object.entries(editorGroups).forEach(([key,label])=>{const values=draft[key]||[],container=$(key+'Editor');if(READONLY_GROUPS.includes(key)){container.innerHTML=(key==='keywords'?'':`<h3>${label}</h3>`)+`<div class="tag-list readonly">${values.length?values.map(v=>`<span class="edit-tag readonly">${esc(v)}</span>`).join(''):`<span class="tag-empty">暂无${label}（自动识别）</span>`}</div>`;return;}container.innerHTML=(['keywords','systems'].includes(key)?'':`<h3>${label}</h3>`)+`<div class="tag-list">${values.length?values.map((v,i)=>editingTag?.key===key&&editingTag.index===i?`<div class="edit-tag editing"><div class="edit-inline"><input id="demo-tagEditValue" aria-label="修改${label}" maxlength="120" value="${esc(v)}"><button type="button" data-action="confirm" data-group="${key}" data-index="${i}">确认</button><button type="button" data-action="cancel">取消</button></div></div>`:`<span class="edit-tag"><button type="button" title="点击修改" data-action="edit" data-group="${key}" data-index="${i}">${esc(v)}</button><button type="button" aria-label="删除${esc(v)}" data-action="remove" data-group="${key}" data-index="${i}">×</button></span>`).join(''):`<span class="tag-empty">暂无${label}</span>`}</div><div class="tag-add"><input id="demo-add-${key}" ${key==='services'?'list="demo-serviceTagOptions"':''} aria-label="新增${label}" maxlength="120" placeholder="${key==='keywords'?'输入自定义关键词，回车添加':key==='systems'?'输入系统名称，如 SAP、自研系统，回车添加':'添加'+label}"><button type="button" class="secondary" data-action="add" data-group="${key}">＋ 添加</button></div>`;});}
function changeTag(action,key,index){
 if(READONLY_GROUPS.includes(key))return;
 if(action==='cancel'){editingTag=null;renderEditors();return;}
 if(action==='edit'){editingTag={key,index};renderEditors();$('tagEditValue').focus();return;}
 const manual=()=>{if(key==='services')draft.domainSelectionManual=true;if(key==='specificTags')draft.specificSelectionManual=true;if(key==='keywords')draft.keywordsSelectionManual=true;};
 if(action==='remove'){manual();draft[key].splice(index,1);editingTag=null;markDirty();renderEditors();return;}
 const input=$(action==='add'?'add-'+key:'tagEditValue'),value=input.value.trim();
 if(!value){status('请输入内容。',true);input.focus();return;}
 if(draft[key].some((v,i)=>v.toLowerCase()===value.toLowerCase()&&(action==='add'||i!==index))){status('该分类中已存在相同内容，请勿重复添加。',true);return;}
 if(key==='services'&&!ServiceContent.isDomain(value)){status('请输入业务领域名称，ITGC 等活动请填写到具体服务。',true);return;}
 if(key==='specificTags'&&!ServiceContent.cleanTag(value)){status('请输入明确的业务名称，例如 ITGC、权限管理、数据迁移。',true);return;}
 manual();
 const cleaned=key==='specificTags'?ServiceContent.cleanTag(value):key==='services'?ServiceContent.canonicalDomain(value):key==='systems'?ServiceContent.normalizeSystem(value):value;
 if(action==='add')draft[key].push(cleaned);else draft[key][index]=cleaned;
 editingTag=null;markDirty();renderEditors();
 if(action==='add')$('add-'+key)?.focus();
}
$('editorForm').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)changeTag(b.dataset.action,b.dataset.group,Number(b.dataset.index));});
$('editorForm').addEventListener('keydown',e=>{if(e.isComposing)return;if(e.key==='Enter'&&e.target.matches('.tag-add input,.edit-inline input')){e.preventDefault();const b=e.target.parentElement.querySelector('[data-action]');changeTag(b.dataset.action,b.dataset.group,Number(b.dataset.index));}});
$('editorForm').addEventListener('input',e=>{if(!e.target.closest('.tag-add,.edit-inline'))markDirty();});
$('editorForm').addEventListener('change',e=>{if(!e.target.closest('.tag-add,.edit-inline'))markDirty();});
function pendingInput(){if(!draft)return false;return !!editingTag||Object.keys(editorGroups).some(key=>$('add-'+key)?.value.trim());}
$('discardDraft').onclick=()=>{if(!draft)return;if((dirty||pendingInput())&&!confirm('撤销当前合同所有未保存修改？'))return;loadDraft(draft.id);};
function setBusy(on){$('editorForm').querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=on);}
$('editorForm').onsubmit=async e=>{
 e.preventDefault();if(!draft||saving)return;
 if(pendingInput()){status('请先确认或添加正在编辑的关键词 / 系统 / 标签。',true);return;}
 const next=copy(draft);
 for(const [field,key] of Object.entries(TEXT_FIELDS))next[key]=$(field).value.trim();
 delete next.amount;delete next.enterpriseSize;
 if(!next.name){status('请填写合同名称。',true);$('editName').focus();return;}
 saving=true;setBusy(true);
 try{
  const all=await Storage.getAllContracts(),latest=all.find(c=>c.id===next.id);
  if(!latest)throw Error('合同已被删除');
  if(latest.ocrRevision!==draftRevision)throw Error('识别结果已更新，请关闭后重新打开编辑');
  const record=VaultModel.update(latest,next);
  await Storage.updateContract(record);
  dirty=false;editingTag=null;saving=false;setBusy(false);
  closeEditor(true);
  await hooks.saved();
  hooks.toast('已保存：'+next.name,'success');
 }catch(err){status('保存失败：'+err.message+'；输入已保留。',true);}
 finally{saving=false;setBusy(false);}
};
function openEditor(id){
 if(discarded)return false;
 const original=originals.find(c=>c.id===id);
 if(!original){hooks.toast('合同尚未保存完成，请稍后再编辑','warning');return false;}
 if($('editorDialog').open&&draft?.id!==id&&!closeEditor())return false;
 if(!loadDraft(id))return false;
 if(!$('editorDialog').open)$('editorDialog').showModal();
 $('editName').focus();
 return true;
}
function closeEditor(force=false){
 if(saving)return false;
 if(!force&&(dirty||pendingInput())&&!confirm('当前编辑尚未保存，是否放弃修改并关闭？'))return false;
 dirty=false;editingTag=null;draft=null;
 if($('editorDialog').open)$('editorDialog').close();
 return true;
}
$('editorClose').onclick=()=>closeEditor();
$('editorCancel').onclick=()=>closeEditor();
$('editorDialog').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});

// ===================== 领域库 =====================
function renderDomainCatalog(){const rows=DomainCatalog.list();$('domainList').innerHTML=rows.map(x=>`<div class="domain-entry"><strong>${esc(x.name)}</strong><span>${x.contractIds.length} 份合同${x.aliases.length?' · 别名：'+x.aliases.map(esc).join('、'):''}</span></div>`).join('');}
$('saveDomain').onclick=async()=>{const button=$('saveDomain');button.disabled=true;try{await DomainCatalog.define($('domainName').value.trim(),$('domainAliases').value.split(/[、,，;；]/).map(x=>x.trim()).filter(Boolean));$('domainStatus').textContent='已保存，今后合同会使用此领域及别名匹配';$('domainName').value='';$('domainAliases').value='';await hooks.saved();updateSystemOptions();changed();}catch(error){$('domainStatus').textContent='保存失败：'+error.message;}finally{button.disabled=false;}};
function updateSystemOptions(){renderDomainCatalog();Object.keys(filterState).forEach(drawPicker);$('serviceTagOptions').innerHTML=pickerOptions('services').map(s=>`<option value="${esc(s)}"></option>`).join('');}

function project(c){const p=VaultModel.project(c);p.industry=[0,1,2].map(i=>p.industry[i]||'');p.region=[0,1,2].map(i=>p.region[i]||'');p.content=c.content||p.scope;return p;}
function sync(data){
 if(discarded)return;
 originals=data;contracts=data.map(project);contracts.forEach(c=>extendIndustry(c.industry));
 updateSystemOptions();render();
 if(draft&&!originals.some(c=>c.id===draft.id)){closeEditor(true);hooks.toast('正在编辑的合同已被删除','warning');}
}
initPickers();updateSystemOptions();
window.addEventListener('beforeunload',e=>{if(dirty||pendingInput()){e.preventDefault();e.returnValue='';}});
return {
 discard(){discarded=true;clearTimeout(timer);clearTimeout(remoteTimer);requestId++;contracts=[];originals=[];draft=null;dirty=false;remote={key:null,rows:[],total:0,loading:false,error:''};if($('editorDialog').open)$('editorDialog').close();if($('detail').open)$('detail').close();},
 refresh:sync,openEditor,closeEditor,showRow,
 canLeave:()=>!$('editorDialog').open||closeEditor(),
};
}
return {
 init,
 discard:()=>api?.discard(),
 refresh:data=>api?.refresh(data),
 render:data=>api?.refresh(data),
 openEditor:id=>api?api.openEditor(id):false,
 selectContract:id=>api?api.openEditor(id):false,
 closeEditor:force=>api?api.closeEditor(force):true,
 showRow:row=>api?.showRow(row),
 canLeave:()=>api?api.canLeave():true,
};
})();
