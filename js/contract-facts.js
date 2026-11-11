/** Configurable internal industry taxonomy and explicit project facts; no client examples. */
const ContractFacts=(()=>{
 const industryTree={
  '金融服务':{'银行':['商业银行','投资银行'],'保险':['人寿保险','财产保险'],'证券与基金':['证券','基金'],'其他金融':['信托','融资租赁','支付服务']},
  '先进制造':{'汽车制造':['新能源汽车','汽车零部件'],'装备制造':['工业装备','电子设备'],'其他制造':['化工制造','医药制造']},
  '消费与零售':{'零售':['电子商务','连锁零售'],'消费品':['食品饮料','日用消费品']},
  '科技与通信':{'科技':['软件服务','半导体','互联网平台'],'通信':['通信运营','通信设备']},
  '能源与资源':{'能源':['新能源','传统能源'],'资源':['矿业','金属材料']},
  '医疗与健康':{'医疗服务':['医院','健康服务'],'生命科学':['生物技术','医疗器械']},
  '其他行业':{'教育':['高等教育','职业教育'],'公共服务':['公共事业','社会组织'],'专业服务':['企业咨询','法律服务'],'物流与运输':['物流','交通运输'],'房地产与建筑':['房地产','建筑工程']}
 };
 const aliases={'电子商务':['电商'],'软件服务':['软件开发','企业软件','软件和信息技术服务'],'商业银行':['银行业'],'证券':['证券业'],'新能源汽车':['新能源整车'],'半导体':['集成电路'],'医疗器械':['医疗设备'],'高等教育':['高等院校','大学教育']};
 const paths=()=>Object.entries(industryTree).flatMap(([a,b])=>Object.entries(b).flatMap(([c,d])=>d.map(e=>[a,c,e])));
 function industryPath(value){
  const text=String(value||'').trim(),explicit=text.split(/\s*(?:\/|>|／|、)\s*/).filter(Boolean);if(explicit.length>1)return explicit.slice(0,3);
  const hits=paths().filter(p=>[p[2],...(aliases[p[2]]||[])].some(v=>text.includes(v)));
  if(hits.length===1)return hits[0];
  for(const[a,b]of Object.entries(industryTree)){if(text===a)return[a];for(const c of Object.keys(b))if(text===c)return[a,c];}
  return text?[text]:[];
 }
 const regions=[['华南','广东','广州 深圳 珠海 佛山 东莞 中山 惠州 江门 肇庆 汕头 湛江'],['华南','广西','南宁 桂林 柳州'],['华南','海南','海口 三亚'],['华东','上海','上海'],['华东','江苏','南京 苏州 无锡 常州 南通'],['华东','浙江','杭州 宁波 温州'],['华东','安徽','合肥'],['华东','福建','福州 厦门 泉州'],['华东','江西','南昌'],['华东','山东','济南 青岛 烟台'],['华北','北京','北京'],['华北','天津','天津'],['华北','河北','石家庄'],['华北','山西','太原'],['华北','内蒙古','呼和浩特'],['华中','湖北','武汉'],['华中','湖南','长沙'],['华中','河南','郑州'],['西南','四川','成都'],['西南','重庆','重庆'],['西南','贵州','贵阳'],['西南','云南','昆明'],['西南','西藏','拉萨'],['西北','陕西','西安'],['西北','甘肃','兰州'],['西北','宁夏','银川'],['西北','新疆','乌鲁木齐'],['西北','青海','西宁'],['东北','辽宁','沈阳 大连'],['东北','吉林','长春'],['东北','黑龙江','哈尔滨']];
 function regionPath(value){const text=String(value||'');const explicit=text.split(/\s*(?:\/|>|／|、)\s*/).filter(Boolean);if(explicit.length>1)return explicit.slice(0,3);for(const[a,p,c]of regions){const city=c.split(' ').find(x=>text.includes(x));if(city)return[a,p,city];}for(const[a,p]of regions)if(text.includes(p))return[a,p];const area=regions.find(x=>text.includes(x[0]));return area?[area[0]]:text?[text.trim()]:[];}
 function analyze(text){
  const out={industry:[],region:[],enterpriseSize:'',businessModel:'',serviceTerm:'',eic:'',pic:'',needs:[],evidence:{}};
  const put=(key,value,line)=>{if(value&&!out.evidence[key]){out[key]=value;out.evidence[key]=line;}};
  for(const key of ['eic','pic']){
   const pattern='(?:^|[\\n；;，,])[ \\t]*(?:\\b'+key+'\\b(?:[（(][^\\n）)]{1,16}[）)])?(?:姓名|负责人)?|(?:项目负责人|项目合伙人|项目经理|项目主管)\\s*[（(]'+key+'[）)])(?:\\s*[:：]\\s*|[ \\t]+|\\s*\\n\\s*)([^\\n，,；;:：]{1,40}?)(?=\\s+(?:EIC|PIC)\\b|[,，\\n]|$)';
   const match=String(text||'').match(new RegExp(pattern,'im'));
   if(match&&!/未提及|未明确|待定|另行|不适用|由双方|N\/A|TBD/i.test(match[1]))put(key,match[1].trim().replace(/[。．]+$/,''),match[0].trim());
  }
  let factSection='';
  for(const line of String(text||'').split(/[\n。；]/).map(x=>x.trim()).filter(Boolean)){
   const field=(pattern)=>{const m=line.match(new RegExp('(?:'+pattern+')\\s*[:：]\\s*(.{1,100})','i'));return m?m[1].trim():'';};
   if(/^(?:人员要求|人员资质|项目经验|人员经验|项目团队|团队简历|培训内容|培训主题|课程内容|乙方简介|乙方基本信息|供应商简介)/.test(line))factSection='other';
   else if(/^(?:客户基本信息|客户简介|甲方基本信息|甲方基本情况|本项目客户|项目基本信息|服务内容|工作内容|服务范围)/.test(line))factSection='client';
   const clientLine=factSection!=='other'||/^甲方(?:企业规模|属于|从事|主营业务|采用|采取|现有|是一家|是一所|为一家)/.test(line);
   // Qualifications, supplier staffing and vendor profiles are not client facts.
   if(clientLine&&!/甲方要求乙方|乙方配备|服务团队|项目团队|人员要求|人员资质|参与过|项目经验|培训内容|课程内容|案例介绍|例如/.test(line)){
    let value=field('客户行业(?:分类)?|甲方行业|所属行业');if(!value){const m=line.match(/(?:甲方|客户|贵公司)(?:属于|从事|主要业务为|主营业务为)([^，,]{2,50})/);value=m?.[1]||'';}if(value)put('industry',industryPath(value),line);else{const predicate=line.match(/^(?:甲方|客户|贵公司)(?:是一家|是一所|为一家|系一家|是|为)([^，,]{2,50})/);if(predicate){const path=industryPath(predicate[1]);if(path.length>1)put('industry',path,line);}}
    value=field('企业规模|客户规模');if(!value&&/(?:甲方|客户|贵公司)/.test(line)&&/(?:员工|雇员|职工).{0,8}\d+\s*(?:人|名)|营业收入|资产总额/.test(line))value=line;put('enterpriseSize',value,line);
    value=field('业务模式|商业模式|客户经营模式');if(!value&&/(?:甲方|客户|贵公司)/.test(line)){const m=line.match(/(?:采用|采取|主营)([^，,]{0,20}(?:B2B2C|B2B|B2C|C2C|D2C|SaaS|平台运营|直营|加盟)[^，,]{0,20})/i);value=m?.[1]||'';}put('businessModel',value,line);
   }
   put('region',field('项目所属区域|项目区域|项目地区|项目地点|服务地点|实施地点')?regionPath(field('项目所属区域|项目区域|项目地区|项目地点|服务地点|实施地点')):null,line);
   let term=field('服务期限|服务期间|服务周期|项目周期|项目实施期|实施周期|履约期限');
   if(!term&&!/保密|付款|验收|培训|人员/.test(line)){const m=line.match(/(?:本项目|本次服务|服务实施|项目实施)(?:预计|计划|将)?(?:持续|为期|历时|周期为|期限为)([^，,]{1,50})/);term=m?.[1]||'';}put('serviceTerm',term,line);
  }
  const needRules=[['合规整改',/合规整改|合规性整改|整改合规问题|满足.{0,10}合规要求/],['风险识别',/风险识别|识别.{0,12}风险|发现.{0,8}风险/],['降本增效',/降本增效|降低.{0,10}成本|提高.{0,10}效率|提升.{0,10}效率/],['数字化转型',/数字化转型|数字转型/],['认证取证',/取得.{0,15}认证证书|通过.{0,15}认证|认证准备/],['上市支持',/支持.{0,10}上市|上市准备|上市申报/],['数据质量提升',/提升.{0,10}数据质量|提高.{0,10}数据质量/],['内控完善',/完善.{0,12}内控|完善.{0,12}内部控制/]];
  for(const u of ServiceContent.units(text)){if(!['scope','context','goal'].includes(u.role)||!/客户诉求|客户需求|项目目标|旨在|甲方希望|客户希望|贵公司希望|为了|以实现/.test(u.text))continue;for(const[label,re]of needRules)if(re.test(u.text)&&!/(?:不包括|不涉及|不提供|非本项目)/.test(u.text)){if(!out.needs.includes(label))out.needs.push(label);out.evidence['need:'+label]=u.text;}}
  return out;
 }
 return{industryTree,industryPath,regionPath,paths,analyze};
})();
