/** Local page geometry and reading layout. Original bytes remain local. */
const DocumentView = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const files = new Map();
  const urls = new Set();
  function release() { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
  function remember(id, file) { if(file instanceof Blob) files.set(id, file); }
  // Records without coordinates: rebuild paragraphs from OCR rows. A row that stops well short
  // of the document's typical full line ended its paragraph; "标签：" rows (委托人（甲方）：,
  // 统一社会信用代码：…), numbered items and page markers always start a new paragraph.
  const PAGE_MARK = /^(?:第\s*\S{1,4}\s*页.{0,8}$|page\s*\S{1,4}\s*of\s*\S{1,4}$|[-—]\s*\d+\s*[-—]$)/i;
  function readable(text = '') {
    const rows = String(text).replace(/\r/g, '').split('\n').map(row => row.trim());
    const lengths = rows.filter(row => row.length >= 8).map(row => row.length).sort((a, b) => a - b);
    const full = lengths.length >= 5 ? lengths[Math.floor(lengths.length * .8)] : 40;
    const paragraphs = [];
    let current = '', previous = '';
    const close = () => { if (current) paragraphs.push(current); current = ''; };
    for (const line of rows) {
      if (!line) { close(); previous = ''; continue; }
      if (PAGE_MARK.test(line)) { close(); paragraphs.push(line); previous = ''; continue; }
      const heading = /^(?:[一二三四五六七八九十]+[、．.]|[（(][一二三四五六七八九十\d]+[）)]|\d+[、．.]\s*|[a-zA-Z][)）.．]\s*|[•●·]|第[一二三四五六七八九十\d]+[条章节])/.test(line);
      const label = /^[^，。；：:\s]{1,14}[：:]/.test(line);
      // A tiny trailing fragment of a longer paragraph (OCR split "要求立") does not end it.
      const fragment = previous.length <= 6 && current.length > previous.length;
      const ended = /[。！？；：:]$/.test(previous) || (previous.length < Math.max(12, full * .85) && !fragment);
      if (current && (heading || label || ended)) close();
      current += current && /[a-zA-Z0-9]$/.test(current) && /^[a-zA-Z0-9]/.test(line) ? ' ' + line : line;
      previous = line;
    }
    close();
    return paragraphs.join('\n');
  }
  function paragraphs(text) {
    return readable(text).split('\n').filter(Boolean).map(line => `<p>${escape(line)}</p>`).join('');
  }
  function fingerprint(text){let hash=2166136261;for(const char of String(text))hash=Math.imul(hash^char.charCodeAt(0),16777619);return String(text).length+':'+(hash>>>0);}
  // Character alignment old -> new (common prefix/suffix, LCS in the edited middle).
  // Returns, for each character of `after`, the index of the matching `before` character or -1.
  function alignChars(before,after){
    const map=new Int32Array(after.length).fill(-1);
    let prefix=0;while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix]){map[prefix]=prefix;prefix++;}
    let suffix=0;while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix]){map[after.length-1-suffix]=before.length-1-suffix;suffix++;}
    const a=before.slice(prefix,before.length-suffix),b=after.slice(prefix,after.length-suffix),n=a.length,m=b.length;
    if(!n||!m)return map;
    if(n*m>4e6)return null; // very large rewrite: keep the edited text as typed instead
    const width=m+1,table=new Uint16Array((n+1)*width);
    for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)table[i*width+j]=a[i]===b[j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
    let i=0,j=0;
    while(i<n&&j<m){if(a[i]===b[j]){map[prefix+j]=prefix+i;i++;j++;}else if(table[(i+1)*width+j]>=table[i*width+j+1])i++;else j++;}
    return map;
  }
  // Carry a full-text edit onto the recognized line boxes. Every changed character stays in the
  // box of the text it replaced; typed new lines grow that box downwards (see render), so the
  // page keeps the original layout instead of switching to plain text after saving.
  function alignLayout(pages,before,after){
    if(!pages?.length)return null;
    before=String(before||'').replace(/\r\n?/g,'\n');after=String(after||'').replace(/\r\n?/g,'\n');
    const units=[];let cursor=0;
    for(const [pageIndex,page] of pages.entries())for(const [lineIndex,line] of (page.lines||[]).entries()){
      const value=String(line.text||'');if(!value)continue;
      const start=before.indexOf(value,cursor);if(start<0)return null;
      units.push({pageIndex,lineIndex,start,end:start+value.length,text:''});cursor=start+value.length;
    }
    if(!units.length)return null;
    const owner=new Int32Array(before.length).fill(-1);units.forEach((unit,k)=>owner.fill(k,unit.start,unit.end));
    const map=alignChars(before,after);if(!map)return null;
    let lastUnit=-1,lastWasUnit=false,pending='';
    for(let j=0;j<after.length;j++){
      const source=map[j];
      if(source<0){
        // Typed text: after a box's character it extends that box, otherwise it opens the next box.
        if(lastWasUnit)units[lastUnit].text+=after[j];else pending+=after[j];
        continue;
      }
      const k=owner[source];
      if(k>=0){units[k].text+=pending+after[j];pending='';lastUnit=k;lastWasUnit=true;}
      else{if(pending&&lastUnit>=0){units[lastUnit].text+=pending;pending='';}lastWasUnit=false;}
    }
    if(pending)units[Math.max(0,lastUnit)].text+=pending;
    const result=pages.map(page=>({...page,lines:(page.lines||[]).map(line=>({...line}))}));
    for(const unit of units){
      const line=result[unit.pageIndex].lines[unit.lineIndex];
      if(unit.text!==line.text){
        // Keep the original single-row height so multi-row edits grow instead of shrinking.
        if(line.rowHeight==null)line.rowHeight=Math.max(1,(Number(line.y1)-Number(line.y0))/Math.max(1,String(line.text||'').split('\n').length)||14);
        line.text=unit.text;
      }
    }
    return result;
  }
  function layoutFor(contract){
    if(!contract.rawTextEditedAt)return contract.layoutPages||[];
    if(contract.editedLayoutPages?.length&&contract.editedLayoutFingerprint===fingerprint(contract.rawText||''))return contract.editedLayoutPages;
    return alignLayout(contract.layoutPages,contract.originalRawText,contract.rawText)||[];
  }
  function prepareEdit(contract,text){
    const pages=layoutFor(contract);const before=pages.length?contract.rawText:contract.originalRawText;
    const edited=alignLayout(pages.length?pages:contract.layoutPages,before,text);
    return{editedLayoutPages:edited,editedLayoutFingerprint:fingerprint(text),editedLayoutMode:edited?'coordinates':'text'};
  }
  function render(contract) {
    const pages=layoutFor(contract);
    if(!pages.length){
      // No coordinates (older or browser-recognized records): the same paragraph layout before and
      // after editing, so saving a correction does not change how the contract looks.
      return `<div class="reading-paper"><div class="reading-caption">${contract.rawTextEditedAt?'修正后的全文':'阅读文本'}</div>${paragraphs(contract.rawText||'此记录未保存识别全文。')}</div>`;
    }
    return pages.map((page, index) => {
      const width = Number(page.width), height = Number(page.height);
      if (!(width > 0 && height > 0)) return '';
      const boxes = (page.lines || []).map(line => {
        const x = Math.max(0, Math.min(width, Number(line.x0) || 0)), y = Math.max(0, Math.min(height, Number(line.y0) || 0));
        const boxWidth = Math.max(1, Math.min(width - x, Number(line.x1) - x || width - x));
        const boxHeight = Math.max(1, Number(line.y1) - y || 14);
        const count = String(line.text || '').split('\n').length;
        // Edited boxes keep their row height and grow; untouched boxes render exactly as before.
        const row = line.rowHeight ? Number(line.rowHeight) : boxHeight / count;
        const grow = line.rowHeight ? Math.max(0, row * count - boxHeight) : 0;
        return { line, x, y, boxWidth, row, count, grow, bottom: y + boxHeight };
      });
      // OCR box heights vary with ascenders/descenders and box padding, which made body text
      // jump between sizes. Body lines use the page's typical size (±20%); short lines that are
      // clearly taller (titles) keep up to 1.8x.
      const rows = boxes.map(box => box.row).filter(v => v > 0).sort((a, b) => a - b);
      const typical = rows.length ? rows[Math.floor(rows.length / 2)] : 0;
      if (typical) boxes.forEach(box => {
        const title = box.row > typical * 1.4 && String(box.line.text || '').replace(/\s/g, '').length <= 20;
        box.font = Math.min(Math.max(box.row, typical * .8), typical * (title ? 1.8 : 1.2));
      });
      const shift = box => boxes.reduce((sum, other) => other !== box && other.grow && box.y >= other.bottom - 1 ? sum + other.grow : sum, 0);
      const total = height + boxes.reduce((sum, box) => sum + box.grow, 0);
      const lines = boxes.map(box => {
        const { line, x, boxWidth, row, count } = box, y = box.y + shift(box), fontSize = (box.font || row) * .88;
        return `<div title="${escape((line.region||'')+(line.alternatives?.length ? '；其他识别：'+line.alternatives.join(' / ') : ''))}" class="page-text-line ${line.alternatives?.length ? 'ocr-alternative' : ''}" style="left:${100*x/width}%;top:${100*y/total}%;width:${100*boxWidth/width}%;font-size:${100*fontSize/width}cqw;line-height:${row/fontSize}" data-box-width="${boxWidth}" data-font-ratio="${100*fontSize/width}">${escape(line.text)}</div>`;
      }).join('');
      return `<section class="recognized-page" id="ocr-page-${index+1}"><div class="reading-caption">第 ${index + 1} 页</div><div class="page-paper" style="aspect-ratio:${width}/${total}">${lines}</div></section>`;
    }).join('');
  }
  function fit(container) {
    // Match text to its measured box; coordinates are always preserved.
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    if (!context) return;
    container.querySelectorAll('.page-text-line').forEach(line => {
      line.style.fontSize = line.dataset.fontRatio + 'cqw';
      const style = getComputedStyle(line), size = parseFloat(style.fontSize);
      context.font = `${size}px ${style.fontFamily}`;
      const longest = Math.max(...line.textContent.split('\n').map(text => context.measureText(text).width), 1);
      if (longest > line.clientWidth) line.style.fontSize = `${size * line.clientWidth / longest}px`;
    });
  }
  async function source(contract, selectedFile) {
    let blob = selectedFile || files.get(contract.id);
    if (selectedFile && selectedFile.name !== contract.sourceFile) throw Error('请选择文件名为“' + contract.sourceFile + '”的原文件');
    if (selectedFile && NativeDocuments.available()) {
      await NativeDocuments.request('/api/source/' + encodeURIComponent(contract.id), { method:'POST', headers:{...NativeDocuments.headers(), 'Content-Type':'application/octet-stream', 'X-Filename':encodeURIComponent(selectedFile.name)}, body:selectedFile });
    }
    if (!blob && NativeDocuments.available()) {
      const response = await fetch('/api/source/' + encodeURIComponent(contract.id), { headers: NativeDocuments.headers() });
      if (!response.ok) throw Error('此记录未保存原件，请点击“选择原文件”。');
      blob = await response.blob();
    }
    if (!blob) throw Error('请点击“选择原文件”打开原件。');
    const url = URL.createObjectURL(blob); urls.add(url);
    return {url, image:/\.(png|jpe?g)$/i.test(contract.sourceFile || '')};
  }
  if(typeof window!=='undefined')window.addEventListener('resize', () => { const box = document.getElementById('rawTextPreview'); if (box && !box.hidden) fit(box); });
  return { readable, paragraphs, render, fit, source, release, remember, prepareEdit, layoutFor };
})();
