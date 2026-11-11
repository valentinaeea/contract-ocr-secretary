/** Per-contract analysis boundaries. Full OCR text is never truncated. */
const ContractScope=(()=>{
 const category=c=>c?.uploadCategory==='ey-template'?'ey-template':'other';
 const heading=s=>String(s||'').normalize('NFKC').replace(/[\s：:、.．（）()《》]/g,'').toLowerCase();
 const first=/^(?:附录|附件)(?:一|1|i)(?![\divx一二三四五六七八九十百])|^(?:appendix|annex|schedule)(?:1|i)(?![\divx])/i;
 const next=/^(?:附录|附件)(?:[二三四五六七八九十百]|[2-9]|1\d)|^(?:appendix|annex|schedule)(?:[2-9]|1\d|viii|vii|vi|iv|iii|ii|ix|v|x)/i;
 const sow=/工作说明书|服务说明书|statementofwork|sow/i;
 // 一般条款／通用条款／商务条款等通用商务内容不做业务分析：从该标题起到下一个附录、部分或工作说明书标题前，
 // 以空格代替文字（换行保留），位置不变，证据定位仍对应原文。
 const generalHeading=/^(?:(?:附录|附件|appendix|annex|schedule|exhibit)[一二三四五六七八九十百\da-z]{0,4}|第[一二三四五六七八九十百\d]{1,3}(?:部分|章|篇|节|条)|part[ivx\d]{1,4}|[一二三四五六七八九十\d]{1,3})?(?:(?:合同|协议|业务约定书|业务约定|服务)?(?:一般商务|通用商务|一般业务|一般合同|通用合同|标准合同|一般|通用|标准|商务|商业|商用)(?:条款|条件)(?:和条件|及条件|与条件)?|(?:general|standard)(?:business|commercial)?(?:terms|conditions)(?:andconditions|ofbusiness)?|termsofbusiness|commercialterms|termsandconditions)(?:续)?$/i;
 const sectionEnd=/^(?:(?:附录|附件|appendix|annex|schedule|exhibit)[一二三四五六七八九十百\da-z]{1,4}|第[一二三四五六七八九十百\d]{1,3}(?:部分|篇)|part[ivx\d]{1,4})|^(?:[一二三四五六七八九十\d]{1,3})?(?:工作说明书|服务说明书|statementofwork|专用条款|特别条款|特殊条款|专项条款|签字页|签署页)|^(?:[一二三四五六七八九十\d]{1,3})?(?:技术条款|技术要求|服务内容|服务范围|工作内容|工作范围|项目内容|项目范围|项目需求|交付物|交付成果)$/i;
 // 带编号的标题（如「二、商务条款」「第五条 一般条款」「3. 通用条款」）到下一个同级编号为止。
 const numbering=[/^\s*[一二三四五六七八九十百]+\s*[、.．]/,/^\s*第\s*[一二三四五六七八九十百\d]+\s*条/,/^\s*第\s*[一二三四五六七八九十百\d]+\s*章/,/^\s*\d+\s*[、.．](?!\s*\d)/,/^\s*[（(]\s*[一二三四五六七八九十]+\s*[)）]/];
 function generalSections(raw){
  const rows=[];let offset=0;for(const line of raw.split('\n')){rows.push({raw:line,start:offset,h:heading(line)});offset+=line.length+1;}
  const spans=[];for(let i=0;i<rows.length;i++){
   const row=rows[i];if(!row.h||row.h.length>40||!generalHeading.test(row.h)||/\.{2,}|…|[·•]{2,}/.test(row.raw))continue;
   const level=numbering.find(r=>r.test(row.raw));
   let end=raw.length;for(let j=i+1;j<rows.length;j++){const h=rows[j].h;if(!h||generalHeading.test(h))continue;if((level&&level.test(rows[j].raw))||(h.length<=40&&sectionEnd.test(h))){end=rows[j].start;break;}}
   spans.push({start:row.start,end});while(i+1<rows.length&&rows[i+1].start<end)i++;
  }
  return spans;
 }
 function skipGeneral(raw,scope){
  const spans=generalSections(raw).map(s=>({start:Math.max(s.start,scope.start),end:Math.min(s.end,scope.end)})).filter(s=>s.end>s.start);
  if(!spans.length||!scope.text)return scope;
  let text=scope.text;for(const s of spans){const a=s.start-scope.start,b=s.end-scope.start;text=text.slice(0,a)+text.slice(a,b).replace(/[^\n]/g,' ')+text.slice(b);}
  return{...scope,text,skippedGeneral:spans.length,label:scope.label+' · 已跳过一般条款'};
 }
 function resolve(c){const raw=String(c?.rawText||'');return skipGeneral(raw,locate(c,raw));}
 function locate(c,raw){
  if(category(c)!=='ey-template')return{status:'full',start:0,end:raw.length,text:raw,label:'全文分析'};
  const rows=[];let offset=0;for(const line of raw.split('\n')){rows.push({raw:line,start:offset,end:offset+line.length,h:heading(line)});offset+=line.length+1;}
  let empty=null;for(let i=0;i<rows.length;i++){
   const row=rows[i];if(!first.test(row.h)||row.h.length>150)continue;
   if(/\.{2,}|…{1,}|[·•]{2,}/.test(row.raw)||/(?:工作说明书|服务说明书|Statement\s*of\s*Work|SOW)\s*\d+\s*(?:页)?\s*$/i.test(row.raw))continue;
   const tail=row.h.replace(first,'');if(tail&&!/工作|说明|服务|statement|sow/i.test(tail))continue;let title=row.h;for(let j=i+1;j<Math.min(i+3,rows.length);j++){if(/^(?:附录|附件|appendix|annex|schedule)/i.test(rows[j].h))break;title+=rows[j].h;}if(!sow.test(title))continue;
   // A heading must identify the work statement, not merely reference another section.
   if(/详见|参见|请见|见附|目录/.test(row.h))continue;
   let end=raw.length;for(let j=i+1;j<rows.length;j++)if(rows[j].h.length<150&&next.test(rows[j].h)){end=rows[j].start;break;}
   const text=raw.slice(row.start,end),body=heading(text.slice(row.raw.length)).replace(/工作说明书|服务说明书|statementofwork|sow/g,'');if(!body||/^[\d第页ofpage/.-]*$/i.test(body)){empty={status:'empty',start:row.start,end,text:'',label:'工作说明书未识别到正文，未生成自动Tag'};continue;}return{status:'found',start:row.start,end,text,label:'仅分析附录一／工作说明书'};
  }
  return empty||{status:'missing',start:0,end:0,text:'',label:'未定位附录一／工作说明书，未生成自动Tag'};
 }
 const textFor=c=>resolve(c).text;
 function offsetOf(c,text){const scope=resolve(c),found=String(c.rawText||'').indexOf(text,scope.start);return found>=scope.start&&found+text.length<=scope.end?found:-1;}
 return{resolve,textFor,category,offsetOf,generalSections};
})();
