'use strict';

const XLSXLite = (() => {
  const te=new TextEncoder(), td=new TextDecoder('utf-8');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  function u16(v,o){return v[o]|(v[o+1]<<8)} function u32(v,o){return (v[o]|(v[o+1]<<8)|(v[o+2]<<16)|(v[o+3]<<24))>>>0}
  function p16(a,v){a.push(v&255,(v>>>8)&255)} function p32(a,v){a.push(v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255)}
  function concat(parts){let n=parts.reduce((a,b)=>a+b.length,0),out=new Uint8Array(n),o=0;for(const p of parts){out.set(p,o);o+=p.length}return out}
  let crcTable=null; function crc32(bytes){if(!crcTable){crcTable=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0}}let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0}

  async function unzip(buffer){
    const v=new Uint8Array(buffer); let eocd=-1;
    for(let i=v.length-22;i>=Math.max(0,v.length-65557);i--){if(u32(v,i)===0x06054b50){eocd=i;break}}
    if(eocd<0) throw new Error('El archivo no parece ser un .xlsx válido.');
    const count=u16(v,eocd+10), cdOffset=u32(v,eocd+16); let p=cdOffset; const entries={};
    for(let i=0;i<count;i++){
      if(u32(v,p)!==0x02014b50) throw new Error('Directorio ZIP inválido.');
      const flags=u16(v,p+8), method=u16(v,p+10), comp=u32(v,p+20), uncomp=u32(v,p+24), fnl=u16(v,p+28), exl=u16(v,p+30), col=u16(v,p+32), lo=u32(v,p+42);
      const name=td.decode(v.slice(p+46,p+46+fnl));
      if(u32(v,lo)!==0x04034b50) throw new Error('Entrada ZIP inválida.');
      const lfn=u16(v,lo+26), lex=u16(v,lo+28), start=lo+30+lfn+lex, packed=v.slice(start,start+comp);
      let data;
      if(method===0) data=packed;
      else if(method===8){
        if(typeof DecompressionStream==='undefined') throw new Error('Este navegador no puede descomprimir archivos Excel. Actualiza Chrome/Android System WebView.');
        let ds; try{ds=new DecompressionStream('deflate-raw')}catch{throw new Error('La versión de Chrome/WebView no admite la descompresión necesaria para Excel. Actualízala.')}
        const ab=await new Response(new Blob([packed]).stream().pipeThrough(ds)).arrayBuffer(); data=new Uint8Array(ab);
      } else throw new Error('El Excel usa un método de compresión no compatible.');
      if(uncomp && data.length!==uncomp){ /* ZIP descriptors can vary; central directory remains authoritative */ }
      entries[name.replace(/^\//,'')]=data;
      p+=46+fnl+exl+col;
    }
    return entries;
  }

  function xmlDecode(s){return String(s??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))}
  function attr(attrs,name){const m=String(attrs).match(new RegExp('(?:^|\\s)'+name.replace(':','\\:')+'="([^"]*)"','i'));return m?xmlDecode(m[1]):''}
  function stripTags(s){return xmlDecode(String(s??'').replace(/<[^>]*>/g,''))}
  function colIndex(ref){let n=0;for(const ch of String(ref).match(/^[A-Z]+/i)?.[0]||'A')n=n*26+(ch.toUpperCase().charCodeAt(0)-64);return n-1}
  function resolvePath(base,target){
    if(target.startsWith('/')) return target.slice(1);
    const parts=base.split('/');parts.pop();for(const x of target.split('/')){if(x==='..')parts.pop();else if(x!=='.')parts.push(x)}return parts.join('/');
  }

  async function read(buffer){
    const z=await unzip(buffer);
    const wbPath='xl/workbook.xml'; if(!z[wbPath]) throw new Error('No encuentro el libro dentro del archivo Excel.');
    const wbText=td.decode(z[wbPath]), relPath='xl/_rels/workbook.xml.rels', relText=z[relPath]?td.decode(z[relPath]):'';
    const relMap={}; for(const m of relText.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)){const a=m[1],id=attr(a,'Id'),target=attr(a,'Target');if(id&&target)relMap[id]=resolvePath(wbPath,target)}
    const shared=[]; if(z['xl/sharedStrings.xml']){const st=td.decode(z['xl/sharedStrings.xml']);for(const m of st.matchAll(/<(?:[A-Za-z0-9_]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?si>/gi)){let out='';for(const t of m[1].matchAll(/<(?:[A-Za-z0-9_]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?t>/gi))out+=stripTags(t[1]);shared.push(out)}}
    const sheets=[];
    for(const m of wbText.matchAll(/<(?:[A-Za-z0-9_]+:)?sheet\b([^>]*)\/?\s*>/gi)){
      const a=m[1],name=attr(a,'name')||'Hoja',rid=attr(a,'r:id'); let path=relMap[rid]; if(!path) continue; path=path.replace(/^xl\/xl\//,'xl/'); const bytes=z[path]; if(!bytes) continue;
      const st=td.decode(bytes),matrix=[];
      for(const rm of st.matchAll(/<(?:[A-Za-z0-9_]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?row>/gi)){
        const arr=[];
        for(const cm of rm[1].matchAll(/<(?:[A-Za-z0-9_]+:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?c>/gi)){
          const ca=cm[1],inner=cm[2],idx=colIndex(attr(ca,'r')||'A1'),type=attr(ca,'t')||'',vm=inner.match(/<(?:[A-Za-z0-9_]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?v>/i),v=vm?stripTags(vm[1]):'';let val='';
          if(type==='s') val=shared[Number(v)]??'';
          else if(type==='inlineStr'){let out='';for(const tm of inner.matchAll(/<(?:[A-Za-z0-9_]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?t>/gi))out+=stripTags(tm[1]);val=out}
          else if(type==='b') val=v==='1';
          else if(type==='str') val=v;
          else if(v!=='') val=Number.isNaN(Number(v))?v:Number(v);
          arr[idx]=val;
        }
        matrix.push(arr);
      }
      sheets.push({name,rows:matrix});
    }
    return {sheets};
  }

  function detectTable(sheet){
    const rows=sheet.rows||[]; let headerRow=0,headers=[];
    for(let i=0;i<Math.min(rows.length,25);i++){const row=rows[i]||[];const non=row.filter(v=>v!==''&&v!=null);if(non.length>=2){headerRow=i;headers=row.map(v=>String(v??'').trim());break}}
    const aliases={name:['nombre del alumno','nombre alumno','alumno','nombre completo','nombre'],list_number:['no','n','numero','num','numero de lista','no lista','num lista'],grade:['grado','grado escolar'],group:['grupo']};
    const nh=headers.map(norm),mapping={};
    for(const [key,cands] of Object.entries(aliases)){const nc=cands.map(norm);for(let i=0;i<nh.length;i++){if(nc.includes(nh[i])||nc.some(x=>x.length>3&&nh[i].includes(x))){mapping[key]=i;break}}}
    return {headerRow,headers,mapping,preview:rows.slice(headerRow+1,headerRow+6)};
  }

  function colName(n){let s='';n++;while(n){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26)}return s}
  function cellXml(value,r,c,header=false){if(value===null||value===undefined||value==='')return '';const ref=colName(c)+(r+1),style=header?' s="1"':'';if(typeof value==='number'&&Number.isFinite(value))return `<c r="${ref}"${style}><v>${value}</v></c>`;if(typeof value==='boolean')return `<c r="${ref}" t="b"${style}><v>${value?1:0}</v></c>`;return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(value)}</t></is></c>`}
  function sheetXml(rows){let body='';for(let r=0;r<rows.length;r++){const row=rows[r]||[];let cells='';for(let c=0;c<row.length;c++)cells+=cellXml(row[c],r,c,r===0);body+=`<row r="${r+1}">${cells}</row>`}return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData></worksheet>`}
  function safeSheetName(name,used){let s=String(name||'Hoja').replace(/[\\\/?*\[\]:]/g,' ').trim().slice(0,31)||'Hoja';let base=s,n=2;while(used.has(s))s=(base.slice(0,27)+' '+n++).slice(0,31);used.add(s);return s}
  function zipStore(files){const locals=[],centrals=[];let offset=0;for(const [name,content] of files){const nb=te.encode(name),data=typeof content==='string'?te.encode(content):content,crc=crc32(data),lh=[];p32(lh,0x04034b50);p16(lh,20);p16(lh,0x0800);p16(lh,0);p16(lh,0);p16(lh,0);p32(lh,crc);p32(lh,data.length);p32(lh,data.length);p16(lh,nb.length);p16(lh,0);const local=concat([new Uint8Array(lh),nb,data]);locals.push(local);const ch=[];p32(ch,0x02014b50);p16(ch,20);p16(ch,20);p16(ch,0x0800);p16(ch,0);p16(ch,0);p16(ch,0);p32(ch,crc);p32(ch,data.length);p32(ch,data.length);p16(ch,nb.length);p16(ch,0);p16(ch,0);p16(ch,0);p16(ch,0);p32(ch,0);p32(ch,offset);centrals.push(concat([new Uint8Array(ch),nb]));offset+=local.length}const central=concat(centrals),localAll=concat(locals),e=[];p32(e,0x06054b50);p16(e,0);p16(e,0);p16(e,files.length);p16(e,files.length);p32(e,central.length);p32(e,localAll.length);p16(e,0);return concat([localAll,central,new Uint8Array(e)])}
  function write(workbook){
    const used=new Set(),sheets=(workbook.sheets||[]).map(s=>({name:safeSheetName(s.name,used),rows:s.rows||[]}));if(!sheets.length)sheets.push({name:'Hoja1',rows:[]});
    const files=[];let sheetOverrides='',sheetTags='',rels='';
    sheets.forEach((s,i)=>{const n=i+1;files.push([`xl/worksheets/sheet${n}.xml`,sheetXml(s.rows)]);sheetOverrides+=`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;sheetTags+=`<sheet name="${esc(s.name)}" sheetId="${n}" r:id="rId${n}"/>`;rels+=`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`});
    const stylesRid=sheets.length+1;rels+=`<Relationship Id="rId${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
    files.push(['[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`]);
    files.push(['_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
    files.push(['xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`]);
    files.push(['xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`]);
    files.push(['xl/styles.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF082A67"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`]);
    return new Blob([zipStore(files)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  return {read,write,detectTable};
})();
