/** Exact excerpts only: never silently normalize money, dates, SOC types or negation. */
const CriticalReview=(()=>{
 const definitions=[
  ['金额',/(?:人民币|港币|美元|RMB|HKD|USD|CNY|[¥￥$€£]|(?:服务费|合同总价|价款)\s*[:：]?)\s*[-−]?\s*(?:[\d,，]+(?:\.\d{1,2})?|[壹贰叁肆伍陆柒捌玖拾佰仟万亿零整]+)(?:\s*[万亿]?元)?|\d[\d,，]*(?:\.\d{1,2})?\s*(?:万元|亿元|元整|元)/gi],
  ['数字混淆线索',/(?:人民币|港币|美元|RMB|HKD|USD|CNY|[¥￥$])\s*[\d,，.]*[OoIl][\dOoIl,，.]*/g],
  ['日期',/\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?/g],
  ['英文日期',/\b(?:\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/gi],
  ['SOC名称与类型',/S[O0]\s*C\s*[12](?:\s*[-—:]?\s*(?:Type\s*(?:II|I|[12])\b|类型[一二12]|第二类|第一类))?/gi],
  ['范围限制与否定',/不\s*包\s*括|不\s*包\s*含|不\s*涉\s*及|不\s*提\s*供|不\s*适\s*用|不\s*构\s*成|不\s*得|仅\s*限\s*于|仅\s*用\s*于|除外|排除|does\s+not\s+include|not\s+in\s+scope/gi],
  ['业务名称',/ITGC|ITAC|IPO|数据核查|业财一致性|信息系统一般控制|应用控制|ISAE\s*3402|SSAE\s*18|ISO\s*(?:27001|27701)/gi]
 ];
 function extract(contract){
  const source=contract.rawText||'',items=[];
  const starts=[];let cursor=0;
  if(!contract.rawTextEditedAt) for(const p of contract.layoutPages||[]){if(Number.isInteger(p.rawStart)&&Number.isInteger(p.rawEnd)){starts.push({start:p.rawStart,end:p.rawEnd,page:p.page});continue;}const text=(p.lines||[]).map(l=>l.text).join('\n');const at=source.indexOf(text,cursor);if(at>=0){starts.push({start:at,end:at+text.length,page:p.page});cursor=at+text.length;}}
  for(const[kind,re]of definitions){re.lastIndex=0;for(const m of source.matchAll(re)){
   const start=Math.max(0,m.index-60),end=Math.min(source.length,m.index+m[0].length+100);
   const page=starts.find(p=>m.index>=p.start&&m.index<p.end)?.page;
   const issues=[];if(kind==='数字混淆线索'||(kind==='SOC名称与类型'&&/S0/i.test(m[0])))issues.push('含易混淆字母或数字');
   if(kind==='日期'){const n=m[0].match(/\d+/g).map(Number),d=new Date(Date.UTC(n[0],n[1]-1,n[2]));if(d.getUTCFullYear()!==n[0]||d.getUTCMonth()!==n[1]-1||d.getUTCDate()!==n[2])issues.push('日期超出日历范围');}
   items.push({issues,id:kind+':'+m.index,kind,value:m[0],offset:m.index,start,end,evidence:source.slice(start,end),page:page||null});
  }}return items.sort((a,b)=>a.offset-b.offset);
 }
 return{extract};
})();
