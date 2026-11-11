/**
 * 合同字段智能提取模块
 * 通过正则表达式从PDF提取的纯文本中识别7个核心字段
 *
 * 提取字段：
 *   1. 签约主体甲方 (Party A)
 *   2. 签约主体乙方 (Party B)
 *   3. 项目名称 (Project Name)
 *   4. 签约时间 (Signing Date)
 *   5. 签约金额 (Signing Amount)
 *   6. 项目工作内容概述 (Work Content)
 *   7. 交付物 (Deliverables)
 */

const Extractor = (() => {

  // ============== 通用辅助函数 ==============

  // 清理文本 - 保留换行符作为段落边界（重要：用于合同字段定位）
  function cleanText(text) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\u00A0/g, ' ')      // 不间断空格
      .replace(/[ \t]+/g, ' ')      // 合并水平空白（保留换行）
      .replace(/[ \t]*\n[ \t]*/g, '\n') // 行首尾空格
      .replace(/\n{3,}/g, '\n\n')   // 多个换行合并
      .trim();
  }

  // 截断到指定标点
  function trimToBoundary(str, maxLen = 100) {
    if (!str) return '';
    str = str.trim();

    // 截断到下一个明显分隔符
    const stopChars = ['。', '；', '，', ',', '\n', '签订', '经', '双方', '（', '(', '【', '[', '为', '就', '之'];
    let endIdx = Math.min(str.length, maxLen);
    for (const ch of stopChars) {
      const idx = str.indexOf(ch, 5);
      if (idx > 0 && idx < endIdx) {
        endIdx = idx;
      }
    }
    return str.substring(0, endIdx).trim();
  }

  // 数字中文转换
  function parseChineseNumber(text) {
    if (!text) return null;
    const cnMap = { '零': 0, '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9, '拾': 10, '佰': 100, '仟': 1000, '万': 10000, '亿': 100000000 };

    // 简化处理：仅识别阿拉伯数字
    const match = text.match(/[¥￥]?\s*([\d,]+\.?\d*)/);
    if (match) {
      return parseFloat(match[1].replace(/,/g, ''));
    }
    return null;
  }

  // 标准化日期
  function normalizeDate(dateStr) {
    if (!dateStr) return '';
    dateStr = dateStr.trim();

    // 匹配各种日期格式
    let m;

    // 2024年01月15日 / 2024年1月15日
    m = dateStr.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (m) {
      return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }

    // 2024-01-15 / 2024/01/15 / 2024.01.15
    m = dateStr.match(/(\d{4})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})/);
    if (m) {
      return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }

    // 20240115
    m = dateStr.match(/(\d{4})(\d{2})(\d{2})/);
    if (m) {
      const y = parseInt(m[1]);
      if (y >= 1990 && y <= 2100) {
        return `${m[1]}-${m[2]}-${m[3]}`;
      }
    }

    return dateStr;
  }

  // ============== 字段提取函数 ==============

  function validParty(value,allowPerson=false){
    const v=String(value||'').trim();
    if(!v||v.length>100||/已提供|应支付|支付费用|履行|承担|应当|不得|义务|服务所|合同约定|签字|盖章|未提及|未识别/.test(v))return false;
    return /公司|银行|集团|大学|学院|医院|事务所|委员会|中心|研究院|工作室|合作社|基金会|政府|支行|分行|\b(?:Ltd|Limited|Inc|LLP|LLC|Corporation)\b/i.test(v)||(allowPerson&&/^[\u4e00-\u9fff·]{2,6}$/.test(v)&&!/[为应需将向的或与]/.test(v));
  }
  function partyValue(value,allowPerson=false){
    let v=cleanCompanyName(value).replace(/^[“”「」\s]+|[“”「」\s]+$/g,'');
    v=v.split(/(?:甲方|乙方|委托方|受托方|联系人|法定代表人|统一社会信用代码|通讯地址|通信地址)\s*[:：]/)[0].trim();
    if(/已提供|应支付|支付费用|履行|承担|义务/.test(v))return '';
    const company=v.match(/^.{2,90}?(?:有限责任公司|股份有限公司|有限公司|公司|事务所|大学|学院|银行|医院|委员会|研究院|中心|基金会|政府)(?:[\u4e00-\u9fff（）()]{0,14}(?:分公司|支行|分行))?/);
    if(company)v=company[0];
    return validParty(v,allowPerson)?v:'';
  }
  const ORG_END=/(?:公司|事务所|大学|学院|银行|医院|委员会|研究院|中心|基金会|政府|分行|支行)$/;
  // 单独出现时不像完整单位名称的开头：多为折行后的后半段。
  const ORG_FRAGMENT=/^(?:(?:技术|科技|控股|股份|集团|有限|实业|发展|投资|信息|生物|电子|网络|软件|咨询|管理|服务|贸易|工程|医药|企业|智能|数据|新材料|能源|物流|电器|制药)|[（(](?:集团|中国|香港|上海|深圳|北京|广州)[)）])/;
  function prefixFromPreviousLine(text,index,value){
    const lineStart=text.lastIndexOf('\n',index-1)+1;
    if(text.slice(lineStart,index).trim())return '';
    const before=text.slice(0,lineStart).split('\n').map(x=>x.trim()).filter(Boolean);
    const prev=before[before.length-1]||'';
    if(!prev||prev.length>30||/[:：,，。;；、]|合同|协议|约定|签订|以下|地址|电话|日期|项目|甲方|乙方|双方|附件|第.{1,3}[页条]/.test(prev))return '';
    if(!/^[\u4e00-\u9fffA-Za-z0-9（）()&·\s]+$/.test(prev)||ORG_END.test(prev))return '';
    const joined=partyValue(prev.replace(/\s+/g,'')+value,false);
    return joined&&joined.length>value.length?joined:'';
  }
  function extractParty(text,keys,side){
    const fixed=String(text||'').replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g,'$1');
    const patterns=[new RegExp('(?:'+keys+')(?:[（(][^\n）)]{0,20}[）)])?\\s*[:：]\\s*([^\n]{1,100})','g'),new RegExp('[（(](?:'+keys+')[）)]\\s*[:：]?\\s*([^\n]{1,100})','g'),new RegExp('(?:'+keys+')\\s*(?:为|系|是)\\s*([^\n]{1,100})','g')];
    for(const re of patterns)for(const m of fixed.matchAll(re)){
      const first=m[1].trim();let result=partyValue(first,true);
      // Join a wrapped legal name only, stopping before another labelled field.
      const next=fixed.slice(m.index+m[0].length).split('\n').filter(x=>x.trim()).slice(0,2);
      const joinNext=()=>{for(const line of next){if(/[:：]|项目|合同|日期|地址|电话|联系人/.test(line))break;const joined=partyValue(first+line.trim(),false);if(joined)return joined;}return '';};
      // 「甲方：广东丸美生物」+ 下一行「技术股份有限公司」：名称被折行时优先拼成完整的单位名称。
      if(result&&!ORG_END.test(result)){const joined=joinNext();if(joined&&ORG_END.test(joined))return joined;}
      // 名称前半段排在标签上一行（表格中标签与第二行对齐）：「广东丸美生物」/「甲方：技术股份有限公司」。
      if(result&&ORG_FRAGMENT.test(result)){const prefixed=prefixFromPreviousLine(fixed,m.index,result);if(prefixed)return prefixed;}
      if(result)return result;
      result=joinNext();if(result)return result;
    }
    const alias=side==='A'?'甲方|贵公司|客户':'乙方|我们|本所';
    const re=new RegExp('([^\n，。；:：]{2,95}(?:公司|事务所|银行|大学|学院|医院))\\s*[（(][^\n）)]{0,14}(?:'+alias+')[^\n）)]{0,14}[）)]','g');
    for(const m of fixed.matchAll(re)){const result=partyValue(m[1].split(/感谢|选用|委托|委任/).pop().trim(),false);if(result)return result;}
    return '';
  }
  function extractPartyA(text,keywords){return extractParty(text,keywords||'甲方|委托方|发包方|采购方|客户|定作方','A');}
  function extractPartyB(text,keywords){return extractParty(text,keywords||'乙方|受托方|承包方|供应商|服务方|承揽方|制作方','B');}

  // 清理公司名称
  function cleanCompanyName(name) {
    if (!name) return '';
    name = name.trim();

    // 去除引号
    name = name.replace(/['"`]/g, '');

    // 截断到常见结束词/字段
    const endWords = [
      '签订', '双方', '为本合同', '以下简称', '（以下',
      '统一社会信用代码', '注册地址', '地址：', '地址:',
      '法定代表人', '联系人', '电话：', '电话:', '邮编',
      '营业执照', '开户行', '银行账号'
    ];
    for (const word of endWords) {
      const idx = name.indexOf(word);
      if (idx > 0) {
        name = name.substring(0, idx);
      }
    }

    return name.trim();
  }

  function extractProjectNameDetailed(text,keywords,options={}){
    const rows=String(text||'').split(/\r?\n/).map(x=>({raw:x.trim(),text:x.trim().replace(/([\u4e00-\u9fff])[ \t\u3000\u00a0]+(?=[\u4e00-\u9fff])/g,'$1')})).filter(x=>x.text);
    const label=keywords||'项目名称|工程名称|合同名称|项目名|服务名称|业务名称';
    const field=new RegExp('^(?:(?:项目|工程|合同|服务|业务)名称|'+label+')(?:[（(][^）)]*[）)])?\\s*[:：]?\\s*(.*)$','i');
    const stop=/^(?:甲方|乙方|委托方|受托方|客户|合同编号|合同金额|签订日期|签约日期|地址|联系人|电话|附件|第[一二三四五六七八九十0-9]+条)\s*[:：]?/;
    const clean=v=>v.replace(/^[“”"「」]+|[“”"「」]+$/g,'').split(/(?:甲方|乙方|委托方|受托方|合同编号|签订日期|签署日期|签约日期)\s*[:：]/)[0].trim();
    const valid=v=>v.length>=4&&v.length<=120&&!/^(?:无|未填写|未提及|未识别项目|待定|N\/A)$/i.test(v)&&!stop.test(v)&&!/^(?:we |our |this agreement |the parties )/i.test(v)&&!/(?:本合同|本协议)(?:自|由|于|签订|生效|终止)|^(?:我们|我方|本所|本次服务|本服务|贵公司)|双方同意|应当|不得|违约金|支付费用|[。；;！？]/.test(v);
    const end=/(?:服务(?:合同|协议|之业务协议)?|业务协议|业务约定书|约定书|约定函|委托书|合同书|协议书|合同|协议|咨询|评估|鉴证|审计|核查|项目|agreement|contract|engagement letter|statement of work|services)$/i;
    // Subjects identify EY engagement letters, including a separate label and wrapped titles.
    function subjectTitle(){
      const finished=/(?:合同|协议|委托书|合同书|协议书|业务约定书|约定书|约定函|engagement letter)$/i;
      const body=/^(?:敬启者|尊敬|致[：:]|我们|我方|本所|本服务|本次服务|贵公司|以下简称|服务范围|服务内容|附录|附件)|十分感谢|感谢.*(?:选用|委托)|[。；;！？]/;
      for(let i=0;i<Math.min(rows.length,120);i++){
        const m=rows[i].text.match(/^(?:(?:关于|事由|主题)\s*[:：﹕︰;；]?\s*|(?:Subject|Re)(?:\s*[:：﹕︰;；]\s*|\s+|$))(.*)$/i);if(!m)continue;
        let name=clean(m[1]),evidence=rows[i].raw;
        for(let j=i+1;j<Math.min(i+7,rows.length)&&!finished.test(name);j++){
          const line=rows[j].text;
          if(stop.test(line)||body.test(line)||/^(?:关于|主题|Subject|Re)\s*[:：]/i.test(line))break;
          // A colon between numbers is part of a standard/version, not a new field.
          if(/[:：﹕︰]/.test(line.replace(/(\d)[:：](?=\d)/g,'$1')))break;
          const join=/[a-zA-Z0-9]$/.test(name)&&/^[a-zA-Z0-9]/.test(line)?' ':'';
          name=clean(name+join+line);evidence+='\n'+rows[j].raw;
          if(name.length>120)break;
        }
        if(valid(name)&&end.test(name))return{value:name,source:'subject',evidence};
      }
      return null;
    }
    const subject=subjectTitle();
    if(options.preferSubject&&subject)return subject;
    for(let i=0;i<rows.length;i++){
      const m=rows[i].text.match(field)||rows[i].text.match(new RegExp('(?:'+label+')\\s*[:：]\\s*(.+)','i'));if(!m)continue;let name=clean(m[1]),evidence=rows[i].raw;
      for(let j=i+1;j<Math.min(i+4,rows.length);j++){
        if(stop.test(rows[j].text)||/[:：]/.test(rows[j].text))break;
        if(name&&/(?:合同|协议|委托书|合同书|协议书)$/.test(name))break;
        if(name&&(!/^(?:[（(]|\d|Type\b|评估|鉴证|服务|项目|合同|协议|审计|核查|咨询|建设|支持|管理|数据|信息|与|及|和|\/)/i.test(rows[j].text)))break;
        name=clean(name+rows[j].text);evidence+='\n'+rows[j].raw;
      }
      if(valid(name))return{value:name,source:'explicit',evidence};
    }
    if(subject)return subject;
    // Cover headings only. Never manufacture a title from body clauses or tags.
    const head=rows.slice(0,45);
    for(let i=0;i<head.length;i++){
      const line=head[i].text;if(stop.test(line)||/[:：]|^第.{0,5}条|^[（(]?[一二三四五六七八九十0-9]+[、.．）)]|以下简称|我们将|贵公司|双方|人民币/.test(line.replace(/(\d)[:：](?=\d)/g,'$1')))continue;
      let name=line,evidence=head[i].raw;
      for(let j=i+1;j<Math.min(i+3,head.length)&&!/(?:合同|协议|委托书|合同书|协议书)$/.test(name);j++){
        if(stop.test(head[j].text)||/[:：]|以下简称|我们将|贵公司|双方|人民币/.test(head[j].text.replace(/(\d)[:：](?=\d)/g,'$1')))break;
        if(!/^(?:Type\b|[（(]|\d|评估|鉴证|服务|合同|协议|业务|审计|核查|咨询|项目|管理|数据|信息|与|及)/i.test(head[j].text.replace(/(\d)[:：](?=\d)/g,'$1')))break;
        name+=head[j].text;evidence+='\n'+head[j].raw;
      }
      name=clean(name);
      if(valid(name)&&end.test(name)&&/(?:ISO|SOC|ITGC|ITAC|信息|数据|风险|内控|安全|审计|鉴证|评估|咨询|核查|迁移|软件|系统|流程|认证|服务|assurance|audit|consulting|assessment|review|migration)/i.test(name)&&!validParty(name)&&!/^服务(?:合同|协议)?$/.test(name))return{value:name,source:'cover',evidence};
    }
    return{value:'',source:'unresolved',evidence:''};
  }
  function extractProjectName(text,keywords,options){return extractProjectNameDetailed(text,keywords,options).value;}
  // v4：折行的单位名称（「技术股份有限公司」只取到后半段）。只把旧值替换为包含它的完整名称，不改其他结果。
  function repairWrappedParties(contract){
    if(contract.identityExtractionVersion!==3||contract.manualFieldsEditedAt)return contract;
    const next={...contract,identityExtractionVersion:4};
    for(const[field,extract]of [['partyA',extractPartyA],['partyB',extractPartyB]]){
      const old=contract[field]||'',found=extract(contract.rawText||'');
      if(old&&found&&found!==old&&found.length>old.length&&found.includes(old))next[field]=found;
    }
    if(next.partyA!==contract.partyA||next.partyB!==contract.partyB)next.previousAutomaticIdentity={projectName:contract.projectName||'',partyA:contract.partyA||'',partyB:contract.partyB||''};
    return next;
  }
  function repairIdentity(contract){
    if(contract.identityExtractionVersion===3)return repairWrappedParties(contract);
    if(contract.identityExtractionVersion>=4||contract.manualFieldsEditedAt)return contract;
    const title=extractProjectNameDetailed(contract.rawText||'',undefined,{preferSubject:contract.uploadCategory==='ey-template'});const next={...contract};let changed=false;
    const filename=String(contract.sourceFile||'').replace(/\.[^.]+$/,'');
    if(title.value&&(!contract.projectName||contract.projectName==='未识别项目'||contract.projectName===filename||(contract.uploadCategory==='ey-template'&&title.source==='subject'&&['explicit','cover','subject','unresolved'].includes(contract.projectNameSource)))){next.projectName=title.value;next.projectNameSource=title.source;next.projectNameEvidence=title.evidence;changed=true;}
    for(const[field,extract]of [['partyA',extractPartyA],['partyB',extractPartyB]])if(!validParty(contract[field],true)){const found=extract(contract.rawText||'');if(found!==(contract[field]||'')){next[field]=found;changed=true;}}
    if(!changed)return contract;
    return{...next,identityExtractionVersion:4,previousAutomaticIdentity:{projectName:contract.projectName||'',partyA:contract.partyA||'',partyB:contract.partyB||''}};
  }

  // 提取签约时间
  function extractSignDate(text, keywords) {
    const keys = keywords || '签订日期|签约时间|签订时间|合同签订日期';
    const patterns = [
      // 签订日期：2024年1月15日
      new RegExp(`(?:${keys})[\\s]*[:：]?[\\s]*([^\\n,，;；。]{4,30})`, 'i'),
      // 仅匹配日期格式（不带关键词）
      /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?)/,
      /(\d{4}[\-\/\.]\d{1,2}[\-\/\.]\d{1,2})/,
    ];

    for (const pattern of patterns) {
      const m = text.match(pattern);
      if (m && m[1]) {
        return normalizeDate(m[1]);
      }
    }
    return '';
  }

  // 提取签约金额
  // 中文大写金额 → 数字（壹佰贰拾万元整 → 1200000）
  function parseChineseAmount(s) {
    const D = { 零: 0, 〇: 0, 壹: 1, 一: 1, 贰: 2, 貳: 2, 二: 2, 两: 2, 叁: 3, 參: 3, 三: 3, 肆: 4, 四: 4, 伍: 5, 五: 5,
      陆: 6, 陸: 6, 六: 6, 柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9 };
    const U = { 拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000 };
    const B = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };
    const m = s.match(/^([^元圆]*)[元圆]?(?:([^角]*)角)?(?:([^分]*)分)?/);
    if (!m) return null;
    const intPart = (str) => {
      let total = 0, section = 0, num = 0, any = false;
      for (const ch of str) {
        if (ch in D) { num = D[ch]; any = true; }
        else if (ch in U) { section += (num || 1) * U[ch]; num = 0; any = true; }
        else if (ch in B) { total = (total + section + num) * B[ch]; section = 0; num = 0; any = true; }
      }
      return any ? total + section + num : 0;
    };
    let v = intPart(m[1] || '');
    if (m[2]) v += (D[m[2].slice(-1)] || 0) * 0.1;
    if (m[3]) v += (D[m[3].slice(-1)] || 0) * 0.01;
    return v > 0 ? v : null;
  }

  // Rank each monetary mention by its own clause, never by the whole OCR line.
  function extractAmountDetailed(text, keywords) {
    const fixed=String(text||'').replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0)).replace(/(\d)\s*[，,]\s*(?=\d{3})/g,'$1,').replace(/(\d)\s*[．]\s*(?=\d)/g,'$1.');
    const labels=/合同(?:总金额|总价款|总价|总额|金额|价款)|签约金额|(?:含税|服务费用?|咨询费用?)(?:总价|总额|合计)|总金额|总价款|总价|总额|包干价|合计|总计|第[一二三四五六七八九十\d]+(?:期|笔)|首(?:期|笔)款?|尾款|进度款|分期|违约金|赔偿(?:金|额)?|保证金|押金|税额|单价|每人天|服务费(?:用)?|咨询费(?:用)?|报酬|价款/g;
    const total=/合同(?:总金额|总价款|总价|总额|金额|价款)|签约金额|(?:含税|服务费用?|咨询费用?)(?:总价|总额|合计)|总金额|总价款|总价|总额|包干价|合计|总计/;
    const excluded=/第[一二三四五六七八九十\d]+(?:期|笔)|首(?:期|笔)|尾款|进度款|分期|违约金|赔偿|保证金|押金|税额|单价|每人天/;
    const candidates=[];
    const mentions=/([¥￥]|人民币)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(亿元|万元|元|亿|万)?|([零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億]{2,}[元圆](?:[零壹贰叁肆伍陆柒捌玖]角)?(?:[零壹贰叁肆伍陆柒捌玖]分)?整?)/g;
    let m;
    while((m=mentions.exec(fixed))){
      const before=fixed.slice(Math.max(0,m.index-180),m.index),boundary=Math.max(before.lastIndexOf('。'),before.lastIndexOf('；'),before.lastIndexOf(';'));
      let context=before.slice(boundary+1);
      // Retain a preceding field heading across OCR line breaks, but not unrelated paragraphs.
      const lines=context.split('\n');if(lines.length>2)context=lines.slice(-2).join('\n');
      const roles=[...context.matchAll(labels)],last=roles[roles.length-1];
      const tail=last?context.slice(last.index+last[0].length):'';
      const reference=last&&total.test(last[0])&&/(?:的|百分之|%|％|比例|乘以)/.test(tail);
      let kind=last?(excluded.test(last[0])?'excluded':total.test(last[0])&&!reference?'total':'fee'):'unlabelled';
      if(reference||(kind==='fee'&&(excluded.test(context)||/%|％|百分之/.test(context))))kind='excluded';
      if(!m[1]&&!m[3]&&!m[4]&&!(kind==='total'&&tail.length<45&&!/%|％/.test(m[0]+fixed.slice(mentions.lastIndex,mentions.lastIndex+1))))continue;
      const value=m[4]?parseChineseAmount(m[4]):parseAmount(m[2]+(m[3]||''));
      if(!value||kind==='excluded')continue;
      candidates.push({value,kind,score:kind==='total'?100:kind==='fee'?40:10,evidence:context+m[0]});
    }
    candidates.sort((a,b)=>b.score-a.score);
    const best=candidates[0];
    // Bare monetary figures without a service/total label cannot establish a contract price.
    return best&&best.score>=40?{...best,version:2}:{value:0,kind:'unknown',evidence:'',version:2};
  }

  function extractAmount(text, keywords) { return extractAmountDetailed(text,keywords).value; }

  // Upgrade only automatic legacy values supported by an explicit total-price clause.
  function repairAmount(contract) {
    if(contract.amountExtractionVersion===2||contract.amountManuallyEdited||contract.manualFieldsEditedAt)return contract;
    const found=extractAmountDetailed(contract.rawText||'');
    if(found.kind!=='total')return contract;
    return {...contract,amount:found.value,...(contract.knowledgeProfile?{knowledgeProfile:{...contract.knowledgeProfile,amount:found.value/10000}}:{}),amountExtractionVersion:2,amountEvidence:found.evidence,previousAutomaticAmount:contract.amount};
  }

  // 解析金额数字
  function parseAmount(str) {
    if (!str) return null;
    str = String(str).trim();

    // 提取纯数字（贪婪匹配，包含千分位逗号）
    const m = str.match(/([\d,]+\.?\d*)\s*(元|万元|亿元|万|亿|元整|千元|仟|佰)?/);
    if (!m) return null;

    let num = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(num) || num <= 0) return null;

    const unit = (m[2] || '').replace(/整$/, '');
    if (unit === '万' || unit === '万元') num *= 10000;
    else if (unit === '亿' || unit === '亿元') num *= 100000000;
    else if (unit === '千' || unit === '千元' || unit === '仟') num *= 1000;
    else if (unit === '佰') num *= 100;

    return num;
  }

  // 提取工作内容
  function extractContent(text, keywords) {
    const keys = keywords || '工作内容|服务范围|项目内容|服务内容|合同内容';
    const patterns = [
      // "工作内容：" 后跟内容
      new RegExp(`(?:${keys})[\\s]*[:：][\\s]*([^\\n]{5,500})`, 'i'),
      // "第N条 ...工作内容..." 后跟内容（跨行）
      new RegExp(`(?:${keys})[^\\n]{0,30}\\n+([^\\n]{10,500})`, 'i'),
      // 括号形式
      new RegExp(`[（(](?:${keys})[）)][\\s]*[:：]?[\\s]*([^\\n]{5,500})`, 'i'),
      // "工作内容为"
      new RegExp(`(?:${keys})[\\s]*(?:为|是|包括)[\\s]*([^\\n]{10,500})`, 'i'),
    ];

    for (const pattern of patterns) {
      const m = text.match(pattern);
      if (m && m[1]) {
        return trimToBoundary(m[1], 400);
      }
    }
    return '';
  }

  // 提取交付物
  // Every occurrence is scored instead of taking the first "成果" in the contract: the word also
  // appears in termination, liability, IP-ownership and confidentiality clauses, whose next line
  // (e.g. "d) 乙方被吊销营业执照…") is not a deliverable. No credible candidate -> empty field.
  const DELIVERABLE_NOUN = /报告|清单|计划|方案|文件|文档|材料|记录|证书|制度|流程|模板|课件|手册|建议书|评估表|底稿|说明书|意见书|台账|矩阵|PPT|Report|deliverable/i;
  const LEGAL_CONTEXT = /违约|解除|终止|吊销|破产|清算|丧失|赔偿|损失|争议|仲裁|诉讼|保密|知识产权|著作权|所有权|归属|不可抗力|责任限|免责|税费|发票|付款|支付|罚|担保|披露|第三方/;
  function deliverableCandidates(text, keywords) {
    // Longer phrases first so "交付成果" is matched as a whole, not as the weak word "成果".
    const keys = '交付成果|项目成果|工作成果|服务成果|交付物|交付内容|' + (keywords || '交付物|成果|验收标准|交付内容|应交付');
    const strong = /交付物|交付成果|交付内容|应交付|项目成果|工作成果|服务成果|Deliverables?/i;
    const out = [];
    const add = (raw, index, keyword, kind) => {
      const value = trimToBoundary(String(raw || '').replace(/^[\s:：、.．\d一二三四五六七八九十()（）a-zA-Z]{0,4}[)）.．、]\s*/, ''), 200);
      if (!value || value.length < 2) return;
      // Context = the keyword's own line only, so a previous clause cannot taint the next heading.
      const before = text.slice(Math.max(text.lastIndexOf('\n', index - 1) + 1, index - 80), index);
      const around = before + keyword + String(raw).slice(0, 120);
      let score = 0;
      if (strong.test(keyword)) score += 3; else score += 1;
      if (DELIVERABLE_NOUN.test(value)) score += 3;
      if (kind === 'issue') score += 2;
      if (/^(?:第[一二三四五六七八九十\d]+条)?\s*(?:交付物|交付成果|项目成果|交付内容)/.test(text.slice(index - 12 < 0 ? 0 : text.lastIndexOf('\n', index) + 1, index + keyword.length))) score += 2;
      if (LEGAL_CONTEXT.test(around) || LEGAL_CONTEXT.test(value)) score -= 6;
      if (/^(?:甲方|乙方|双方|任何一方|一方)/.test(value) && !DELIVERABLE_NOUN.test(value)) score -= 3;
      if (score > 2) out.push({ value, score, index });
    };
    const pattern = (source) => new RegExp(source, 'gi');
    for (const m of text.matchAll(pattern(`(${keys})[\\s]*[:：][\\s]*([^\\n]{2,300})`))) add(m[2], m.index, m[1], 'label');
    for (const m of text.matchAll(pattern(`(${keys})[^\\n]{0,30}\\n+([^\\n]{5,500})`))) add(m[2], m.index, m[1], 'heading');
    for (const m of text.matchAll(pattern(`[（(](${keys})[）)][\\s]*[:：]?[\\s]*([^\\n]{2,300})`))) add(m[2], m.index, m[1], 'label');
    for (const m of text.matchAll(pattern(`(${keys})[\\s]*(?:为|是|包括|含)[\\s]*([^\\n]{5,500})`))) add(m[2], m.index, m[1], 'label');
    // "乙方向甲方出具/提交《…报告》" style deliverables even without a 交付物 heading.
    for (const m of text.matchAll(/(出具|提交|交付(?!物|成果|内容)|提供)\s*([^。；\n]{2,50}?(?:报告|清单|计划|方案|建议书|评估表|制度文件|课件|手册)》?)/g)) add(m[2], m.index, '交付物', 'issue');
    return out.sort((a, b) => b.score - a.score || a.index - b.index);
  }
  function extractDeliverables(text, keywords) {
    const best = deliverableCandidates(text, keywords)[0];
    return best ? best.value : '';
  }

  // ============== 主提取函数 ==============
  async function extract(text, config, options={}) {
    if (!text || text.length < 10) {
      return {
        partyA: '', partyB: '', projectName: '', signDate: '',
        amount: 0, content: '', deliverables: '',
        confidence: { total: 0, fields: {} }
      };
    }

    const cleanedText = cleanText(text);

    const projectIdentity=extractProjectNameDetailed(cleanedText,config.projectKeys,options);
    const result = {
      identityExtractionVersion:4,projectNameSource:projectIdentity.source,projectNameEvidence:projectIdentity.evidence,
      partyA: extractPartyA(cleanedText, config.partyAKeys),
      partyB: extractPartyB(cleanedText, config.partyBKeys),
      projectName: projectIdentity.value,
      signDate: extractSignDate(cleanedText, config.dateKeys),
      amount: extractAmount(cleanedText, config.amountKeys),
      content: extractContent(cleanedText, config.contentKeys),
      // EY uploads: the work statement (附录一) is the authoritative place for deliverables.
      deliverables: (options.scopeText && extractDeliverables(cleanText(options.scopeText), config.deliverableKeys)) || extractDeliverables(cleanedText, config.deliverableKeys)
    };

    // 计算置信度（已识别字段比例）
    const checks = [
      !!result.partyA,
      !!result.partyB,
      !!result.projectName,
      !!result.signDate,
      result.amount > 0,
      !!result.content,
      !!result.deliverables
    ];
    const hit = checks.filter(Boolean).length;
    result.confidence = {
      total: Math.round((hit / checks.length) * 100),
      fields: {
        partyA: result.partyA ? 100 : 0,
        partyB: result.partyB ? 100 : 0,
        projectName: result.projectName ? 100 : 0,
        signDate: result.signDate ? 100 : 0,
        amount: result.amount > 0 ? 100 : 0,
        content: result.content ? 100 : 0,
        deliverables: result.deliverables ? 100 : 0
      }
    };

    return result;
  }

  return {
    extract,
    // 暴露单字段函数用于测试
    parseAmount,
    parseChineseAmount,
    extractAmount,
    extractDeliverables,
    deliverableCandidates,
    extractProjectName,
    extractProjectNameDetailed,
    extractPartyA,
    extractPartyB,
    repairIdentity,
    extractAmountDetailed,
    repairAmount,
    normalizeDate,
    cleanText
  };
})();