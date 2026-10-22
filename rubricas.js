'use strict';
// MiAula 2.8.0 · Rúbricas y listas de cotejo de un clic + calificación por equipos.
// Lógica pura (sin DOM ni IndexedDB) para poder probarla con Node: node --test tests/
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MiAulaRubricas=api;
})(typeof self!=='undefined'?self:this,function(){

  const FORMAT='rubrica-v2';
  const SHARE_FORMAT='MiAulaRubricas';
  const SHARE_VERSION=1;
  const CHECKLIST_LEVELS=[{n:'Sí',p:1},{n:'No',p:0}];
  const LIMITS={minLevels:2,maxLevels:6,minCriteria:1,maxCriteria:30,minWeight:.1,maxWeight:100,maxPoints:100};

  const clone=v=>JSON.parse(JSON.stringify(v));
  const str=v=>String(v??'').replace(/\s+/g,' ').trim();
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN;};
  let idCounter=0;
  function newId(prefix='c'){
    idCounter=(idCounter+1)%1e6;
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}${idCounter.toString(36)}`;
  }

  // ---------- Normalización y validación ----------
  // Devuelve {ok, rubric, error}. Nunca lanza: una rúbrica dañada solo invalida su actividad.
  function normalizeRubric(raw){
    try{
      if(!raw||typeof raw!=='object')return {ok:false,rubric:null,error:'La rúbrica está vacía o dañada.'};
      const kind=raw.kind==='cotejo'?'cotejo':raw.kind==='rubrica'?'rubrica':null;
      if(!kind)return {ok:false,rubric:null,error:'Tipo de instrumento desconocido.'};
      const name=str(raw.name);
      let levels=kind==='cotejo'?clone(CHECKLIST_LEVELS):(Array.isArray(raw.levels)?raw.levels:[]).map(l=>({n:str(l?.n),p:num(l?.p)}));
      if(levels.length<LIMITS.minLevels||levels.length>LIMITS.maxLevels)return {ok:false,rubric:null,error:'Número de niveles fuera de rango.'};
      if(levels.some(l=>!l.n||!Number.isFinite(l.p)||l.p<0||l.p>LIMITS.maxPoints))return {ok:false,rubric:null,error:'Hay niveles sin nombre o con puntos fuera de 0 a 100.'};
      if(!levels.some(l=>l.p>0))return {ok:false,rubric:null,error:'Al menos un nivel debe tener puntos mayores a cero.'};
      const rawCriteria=Array.isArray(raw.criteria)?raw.criteria:[];
      if(rawCriteria.length<LIMITS.minCriteria||rawCriteria.length>LIMITS.maxCriteria)return {ok:false,rubric:null,error:'Número de criterios fuera de rango.'};
      const seen=new Set();
      const criteria=rawCriteria.map(c=>{
        let id=str(c?.id)||newId();if(seen.has(id))id=newId();seen.add(id);
        const d=kind==='cotejo'?[]:levels.map((_,i)=>str(Array.isArray(c?.d)?c.d[i]:''));
        return {id,n:str(c?.n),w:num(kind==='cotejo'&&(c?.w==null||c?.w==='')?1:c?.w),d};
      });
      if(criteria.some(c=>!c.n))return {ok:false,rubric:null,error:'Hay criterios sin texto.'};
      if(criteria.some(c=>!Number.isFinite(c.w)||c.w<LIMITS.minWeight||c.w>LIMITS.maxWeight))return {ok:false,rubric:null,error:'Hay pesos fuera del rango 0.1 a 100.'};
      const out={format:FORMAT,name,kind,levels,criteria};
      if(raw.source)out.source=str(raw.source);
      return {ok:true,rubric:out,error:null};
    }catch(e){return {ok:false,rubric:null,error:'La rúbrica está dañada.'};}
  }

  // Validación del editor (mensajes para el docente).
  function validateRubric(r){
    const errors=[];
    if(!str(r?.name))errors.push('Escribe el nombre de la rúbrica.');
    const kind=r?.kind==='cotejo'?'cotejo':'rubrica';
    const levels=kind==='cotejo'?CHECKLIST_LEVELS:(r?.levels||[]);
    if(levels.length<LIMITS.minLevels||levels.length>LIMITS.maxLevels)errors.push(`Debe tener de ${LIMITS.minLevels} a ${LIMITS.maxLevels} niveles.`);
    levels.forEach((l,i)=>{
      if(!str(l.n))errors.push(`El nivel ${i+1} no tiene nombre.`);
      const p=num(l.p);if(!Number.isFinite(p)||p<0||p>LIMITS.maxPoints)errors.push(`Los puntos del nivel ${i+1} deben estar entre 0 y 100.`);
    });
    if(!levels.some(l=>num(l.p)>0))errors.push('Al menos un nivel debe tener puntos mayores a cero.');
    const criteria=r?.criteria||[];
    if(criteria.length<LIMITS.minCriteria)errors.push('Agrega al menos un criterio.');
    if(criteria.length>LIMITS.maxCriteria)errors.push(`Máximo ${LIMITS.maxCriteria} criterios.`);
    criteria.forEach((c,i)=>{
      if(!str(c.n))errors.push(`El criterio ${i+1} no tiene texto.`);
      const w=num(c.w);if(!Number.isFinite(w)||w<LIMITS.minWeight||w>LIMITS.maxWeight)errors.push(`El peso del criterio ${i+1} debe estar entre 0.1 y 100.`);
    });
    return errors;
  }

  function weightPercents(criteria){
    const total=criteria.reduce((s,c)=>s+(Number.isFinite(num(c.w))&&num(c.w)>0?num(c.w):0),0);
    return criteria.map(c=>total>0&&num(c.w)>0?Math.round(num(c.w)*1000/total)/10:0);
  }

  // ---------- Cálculo (exacto) ----------
  // Nota = Σ(peso × puntos del nivel) ÷ (Σ pesos × puntos del mejor nivel) × puntaje máximo.
  // Solo cuenta cuando todos los criterios están marcados.
  function rubricScore(rubric,selection,maxScore=10){
    const norm=normalizeRubric(rubric);
    if(!norm.ok)return {valid:false,complete:false,done:0,total:0,score:null};
    const r=norm.rubric,sel=selection&&typeof selection==='object'?selection:{};
    const total=r.criteria.length;let done=0,sum=0,wsum=0;
    const best=r.levels[0].p;
    for(const c of r.criteria){
      wsum+=c.w;
      const idx=sel[c.id];
      if(Number.isInteger(idx)&&idx>=0&&idx<r.levels.length){done++;sum+=c.w*r.levels[idx].p;}
    }
    const max=Number.isFinite(num(maxScore))&&num(maxScore)>0?num(maxScore):10;
    if(done<total||wsum<=0||best<=0)return {valid:true,complete:false,done,total,score:null};
    const score=Math.round(sum/(wsum*best)*max*100)/100;
    return {valid:true,complete:true,done,total,score};
  }

  // Limpia una selección: solo criterios e índices válidos.
  function cleanSelection(rubric,selection){
    const out={};if(!rubric||!selection)return out;
    const ids=new Set((rubric.criteria||[]).map(c=>c.id)),n=(rubric.levels||[]).length;
    for(const [k,v] of Object.entries(selection))if(ids.has(k)&&Number.isInteger(v)&&v>=0&&v<n)out[k]=v;
    return out;
  }

  // ---------- Reglas de edición ----------
  function structureKey(r){
    return JSON.stringify({kind:r?.kind,levels:(r?.levels||[]).length,criteria:(r?.criteria||[]).map(c=>c.id)});
  }
  // Con alumnos evaluados: se pueden cambiar textos, pesos y puntos, pero no agregar/quitar criterios o niveles.
  function canApplyActivityEdit(oldRubric,newRubric,hasEvaluations){
    if(!hasEvaluations)return {ok:true};
    if(structureKey(oldRubric)!==structureKey(newRubric))return {ok:false,error:'Esta actividad ya tiene alumnos evaluados: puedes cambiar textos, pesos y puntos, pero no agregar ni quitar criterios o niveles.'};
    return {ok:true};
  }
  function canChangeGradingMode(hasGrades){
    return hasGrades?{ok:false,error:'Esta actividad ya tiene calificaciones. Para calificar de otra forma, crea una actividad nueva.'}:{ok:true};
  }

  // Copia independiente para guardar dentro de la actividad.
  function snapshotForActivity(template,source){
    const n=normalizeRubric(template);if(!n.ok)return null;
    const copy=clone(n.rubric);if(source)copy.source=source;copy.copied_at=new Date().toISOString();
    return copy;
  }

  // Convierte un instrumento de la versión anterior (Proyecto) a una copia de un clic.
  function fromLegacyInstrument(inst){
    if(!inst||!Array.isArray(inst.criteria))return null;
    if(inst.instrument_type==='checklist'){
      return normalizeRubric({name:`${str(inst.name)} (un clic)`,kind:'cotejo',criteria:inst.criteria.map(c=>({n:c.name,w:1}))}).rubric;
    }
    const max=Math.max(2,Math.min(6,...inst.criteria.map(c=>Math.round(+c.max)||4)));
    const levels=Array.from({length:max},(_,i)=>({n:`Nivel ${max-i}`,p:Math.round((max-i)/max*100)}));
    return normalizeRubric({name:`${str(inst.name)} (un clic)`,kind:'rubrica',levels,criteria:inst.criteria.map(c=>({n:c.name,w:1,d:levels.map(()=> '')}))}).rubric;
  }

  function uniqueName(name,existing){
    const base=str(name)||'Rúbrica sin nombre',taken=new Set((existing||[]).map(x=>str(x).toLowerCase()));
    if(!taken.has(base.toLowerCase()))return base;
    let k=2;while(taken.has(`${base} (${k})`.toLowerCase()))k++;
    return `${base} (${k})`;
  }

  // ---------- Archivo para compartir (con SHA-256) ----------
  function canonical(v){
    if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
    if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
    return JSON.stringify(v);
  }
  function sha256(text){
    const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const bytes=[];const s=unescape(encodeURIComponent(String(text)));for(let i=0;i<s.length;i++)bytes.push(s.charCodeAt(i));
    const bitLen=bytes.length*8;bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);
    for(let i=7;i>=0;i--)bytes.push(Math.floor(bitLen/Math.pow(2,i*8))&0xff);
    let h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let o=0;o<bytes.length;o+=64){
      const w=new Array(64);
      for(let i=0;i<16;i++)w[i]=(bytes[o+i*4]<<24)|(bytes[o+i*4+1]<<16)|(bytes[o+i*4+2]<<8)|bytes[o+i*4+3];
      for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3),s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0;}
      let [a,b,c,d,e,f,g,hh]=h;
      for(let i=0;i<64;i++){
        const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g),t1=(hh+S1+ch+K[i]+w[i])|0;
        const S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c),t2=(S0+maj)|0;
        hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      h=[(h[0]+a)|0,(h[1]+b)|0,(h[2]+c)|0,(h[3]+d)|0,(h[4]+e)|0,(h[5]+f)|0,(h[6]+g)|0,(h[7]+hh)|0];
    }
    return h.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');
  }
  // Solo plantillas: nombre, tipo, niveles y criterios. Nunca datos de alumnos.
  function shareablePart(r){
    const n=normalizeRubric(r);if(!n.ok)return null;
    return {name:n.rubric.name,kind:n.rubric.kind,levels:n.rubric.levels,criteria:n.rubric.criteria.map(c=>({n:c.n,w:c.w,d:c.d}))};
  }
  function buildShareFile(rubrics,meta={}){
    const list=(rubrics||[]).map(shareablePart).filter(Boolean);
    const body={format:SHARE_FORMAT,version:SHARE_VERSION,rubrics:list};
    return {...body,app:'MiAula Slate',exported_at:meta.exported_at||new Date().toISOString(),count:list.length,sha256:sha256(canonical(body))};
  }
  function parseShareFile(text){
    let data;
    try{data=typeof text==='string'?JSON.parse(text):text;}catch{return {ok:false,error:'El archivo no es válido (no se pudo leer).'};}
    if(!data||typeof data!=='object')return {ok:false,error:'El archivo no es válido.'};
    if(data.format==='MiAulaMobileBackup')return {ok:false,backup:true,error:'Este archivo es una COPIA DE SEGURIDAD completa de MiAula (con alumnos y calificaciones), no un archivo de rúbricas. No se agregó nada. Para restaurarla usa Administración → Restaurar respaldo.'};
    if(data.format!==SHARE_FORMAT||!Array.isArray(data.rubrics))return {ok:false,error:'Este archivo no es un archivo de rúbricas de MiAula.'};
    const body={format:data.format,version:data.version,rubrics:data.rubrics};
    if(typeof data.sha256!=='string'||sha256(canonical(body))!==data.sha256)return {ok:false,tampered:true,error:'El código de verificación no coincide: el archivo fue modificado o está dañado. No se agregó nada.'};
    const items=data.rubrics.map((r,i)=>{const n=normalizeRubric(r);return {index:i,ok:n.ok,rubric:n.ok?n.rubric:null,name:str(r?.name)||`Rúbrica ${i+1}`,error:n.error};});
    return {ok:true,items};
  }
  // Prepara rúbricas importadas: ids nuevos y nombres sin pisar.
  function prepareImport(items,existingNames){
    const names=[...(existingNames||[])],out=[];
    for(const r of items){
      const copy=clone(r);delete copy.id;
      copy.criteria=copy.criteria.map(c=>({...c,id:newId()}));
      copy.name=uniqueName(copy.name,names);names.push(copy.name);
      copy.format=FORMAT;out.push(copy);
    }
    return out;
  }

  // ---------- Calificar por equipos ----------
  // teams: [{name, member_ids}] · students: Map id→{active, secretary_pending} · existing: Map id→{score,status}
  // values: {teamIndex: 'texto escrito'} · parse(text)→{score,status,invalid}
  function planTeamGrades({teams,students,existing,values,replace,parse}){
    const changes=[],errors=[];let kept=0,filledTeams=0,skippedInactive=0;
    teams.forEach((t,i)=>{
      const raw=str(values?.[i]);if(!raw)return;
      const parsed=parse(raw);
      if(parsed.invalid){errors.push(`${t.name}: “${raw}” no es válida.`);return;}
      const ids=(t.member_ids||[]).map(Number);
      let applied=0;
      for(const id of ids){
        const st=students.get(id);
        if(!st||st.active===0||st.secretary_pending){skippedInactive++;continue;}
        const old=existing.get(id)||null;
        const has=!!old&&(old.score!=null||String(old.status||'').toUpperCase()==='NP');
        if(has&&!replace){kept++;continue;}
        changes.push({student_id:id,team:t.name,old,score:parsed.score,status:parsed.status||''});applied++;
      }
      if(ids.length)filledTeams++;
    });
    return {changes,errors,kept,filledTeams,skippedInactive};
  }

  // Estado de un criterio para un equipo: el índice común o 'mixed' / null.
  function teamCriterionState(selections,critId){
    const vals=selections.map(s=>s?.[critId]);
    const first=vals[0];
    if(vals.every(v=>v===first))return Number.isInteger(first)?first:null;
    return 'mixed';
  }
  // Un toque en modo equipo: si todos ya tienen ese nivel, se quita a todos; si no, se pone a todos.
  function applyTeamTap(selections,critId,levelIndex){
    const state=teamCriterionState(selections,critId);
    const remove=state===levelIndex;
    return selections.map(s=>{const n={...(s||{})};if(remove)delete n[critId];else n[critId]=levelIndex;return n;});
  }
  function selectionsDiffer(selections){
    const keys=new Set();selections.forEach(s=>Object.keys(s||{}).forEach(k=>keys.add(k)));
    for(const k of keys)if(teamCriterionState(selections,k)==='mixed')return true;
    return false;
  }

  // ---------- Banco inicial ----------
  const L4=[{n:'Destacado',p:10},{n:'Satisfactorio',p:8},{n:'Suficiente',p:6},{n:'Requiere apoyo',p:5}];
  const R=(id,name,crit)=>({id,name,kind:'rubrica',levels:clone(L4),criteria:crit.map((c,i)=>({id:`${id}-c${i+1}`,n:c[0],w:c[1],d:c[2]}))});
  const C=(id,name,items)=>({id,name,kind:'cotejo',levels:clone(CHECKLIST_LEVELS),criteria:items.map((n,i)=>({id:`${id}-c${i+1}`,n,w:1,d:[]}))});
  const BANK=[
    R('bank-exposicion','Exposición oral',[
      ['Dominio del tema',30,['Explica con seguridad y responde preguntas sin leer.','Explica bien; duda en alguna pregunta.','Explica lo básico y se apoya mucho en notas.','Lee la mayor parte y no responde preguntas.']],
      ['Organización de la información',20,['Introducción, desarrollo y cierre claros y en orden lógico.','Orden lógico con una parte poco clara.','Las ideas se entienden pero saltan de un tema a otro.','No hay orden; es difícil seguir la exposición.']],
      ['Voz y claridad',20,['Volumen y ritmo adecuados; mira al grupo.','Se escucha bien casi todo el tiempo.','A veces no se escucha o habla muy rápido.','No se escucha o no se entiende.']],
      ['Material de apoyo',15,['Material claro, legible y que aporta a la explicación.','Material claro con detalles por mejorar.','Material con mucho texto o poco legible.','Sin material o no sirve para explicar.']],
      ['Manejo del tiempo',15,['Termina dentro del tiempo acordado.','Se pasa o le falta poco tiempo.','Se pasa o le falta bastante tiempo.','No respeta el tiempo o no termina.']]]),
    R('bank-proyecto-equipo','Proyecto en equipo',[
      ['Planeación',20,['Plan con tareas, responsables y fechas, y lo siguieron.','Plan con tareas y fechas; lo siguieron casi todo.','Plan incompleto o poco seguido.','Sin plan; trabajaron al último momento.']],
      ['Investigación y contenido',30,['Información correcta, completa y de fuentes confiables.','Información correcta con algún hueco.','Información básica o con errores.','Información escasa o incorrecta.']],
      ['Producto final',30,['Producto completo, funcional y bien presentado.','Producto completo con detalles menores.','Producto incompleto o con fallas.','No entregaron producto o no funciona.']],
      ['Colaboración',20,['Todos participan y se reparten el trabajo.','Casi todos participan.','Pocos integrantes hacen la mayor parte.','Una sola persona hizo el trabajo.']]]),
    R('bank-escrito','Producción escrita / reporte',[
      ['Propósito y contenido',30,['Cumple el propósito con ideas propias y bien sustentadas.','Cumple el propósito con ideas claras.','Cumple en parte; ideas poco desarrolladas.','No cumple el propósito.']],
      ['Organización',25,['Párrafos ordenados con introducción, desarrollo y conclusión.','Orden adecuado con alguna parte débil.','Ideas sueltas, poco conectadas.','Sin orden ni estructura.']],
      ['Ortografía y puntuación',25,['Sin errores o casi ninguno.','Pocos errores que no afectan la lectura.','Varios errores que distraen.','Muchos errores que impiden entender.']],
      ['Presentación',20,['Limpio, con datos de identificación y formato pedido.','Limpio con algún detalle de formato.','Falta formato o datos de identificación.','Desordenado o sin formato.']]]),
    R('bank-prototipo','Prototipo o maqueta',[
      ['Funcionamiento',30,['Funciona completo y cumple lo pedido.','Funciona con fallas menores.','Funciona en parte.','No funciona.']],
      ['Uso de materiales',20,['Materiales adecuados, bien aprovechados y seguros.','Materiales adecuados con algún desperdicio.','Materiales poco adecuados.','Materiales inadecuados o inseguros.']],
      ['Creatividad',20,['Solución original con mejoras propias.','Solución con algún toque propio.','Copia un modelo sin cambios.','Sin propuesta propia.']],
      ['Explicación del proceso',30,['Explica cómo lo hizo, problemas y soluciones.','Explica el proceso con algún hueco.','Explica solo partes del proceso.','No puede explicar cómo lo hizo.']]]),
    R('bank-investigacion','Investigación',[
      ['Fuentes',25,['Tres o más fuentes confiables y variadas.','Dos fuentes confiables.','Una fuente o fuentes poco confiables.','Sin fuentes identificables.']],
      ['Contenido',35,['Responde la pregunta con información completa y correcta.','Información correcta con algún hueco.','Información básica o con errores.','Información copiada o fuera del tema.']],
      ['Conclusión propia',25,['Conclusión con opinión argumentada.','Conclusión clara pero breve.','Conclusión que repite el contenido.','Sin conclusión.']],
      ['Referencias',15,['Todas las fuentes citadas con formato correcto.','Fuentes citadas con detalles de formato.','Citas incompletas.','Sin referencias.']]]),
    R('bank-programa','Programa / código fuente',[
      ['Funciona correctamente',35,['Hace todo lo pedido sin errores.','Hace lo pedido con errores menores.','Hace parte de lo pedido.','No compila o no hace lo pedido.']],
      ['Lógica y estructura',25,['Lógica clara, sin código repetido; usa funciones.','Lógica correcta con algo de repetición.','Lógica confusa o muy repetida.','Sin lógica identificable.']],
      ['Legibilidad (nombres, sangría, comentarios)',20,['Nombres claros, sangría correcta y comentarios útiles.','Legible con algunos nombres poco claros.','Difícil de leer; sin comentarios.','Ilegible.']],
      ['Pruebas y manejo de errores',20,['Probó varios casos y controla entradas inválidas.','Probó casos básicos y controla algunos errores.','Probó solo un caso.','No probó ni controla errores.']]]),
    R('bank-reporte-practica','Reporte de práctica de taller o laboratorio',[
      ['Objetivo y procedimiento',25,['Objetivo claro y pasos completos en orden.','Objetivo y pasos con algún detalle faltante.','Objetivo o pasos incompletos.','Sin objetivo ni procedimiento.']],
      ['Resultados y evidencias',30,['Resultados completos con fotos, tablas o mediciones.','Resultados con evidencia suficiente.','Resultados con poca evidencia.','Sin resultados ni evidencia.']],
      ['Análisis y conclusiones',30,['Explica los resultados y los relaciona con la teoría.','Explica los resultados con claridad.','Describe sin analizar.','Sin análisis ni conclusiones.']],
      ['Presentación',15,['Ordenado, limpio y con formato pedido.','Ordenado con detalles de formato.','Poco ordenado.','Desordenado o incompleto.']]]),
    C('bank-cotejo-tarea','Entrega de tarea',['Entregó en la fecha acordada','Tiene nombre y fecha','Está completa','Es legible y ordenada','Corrigió lo que se le señaló']),
    C('bank-cotejo-colaborativo','Trabajo colaborativo',['Cumplió con su parte','Aportó ideas','Escuchó a sus compañeros','Respetó los acuerdos','Terminó a tiempo']),
    C('bank-cotejo-taller','Práctica de taller o laboratorio',['Trajo su material','Siguió las normas de seguridad','Siguió los pasos indicados','Registró sus resultados','Dejó limpio su lugar']),
    C('bank-cotejo-programacion','Entrega de proyecto de programación',['Subió/entregó el archivo correcto','El programa compila o abre','Cumple los requisitos pedidos','Incluye comentarios o documentación','Entregó a tiempo'])
  ];

  return {FORMAT,SHARE_FORMAT,SHARE_VERSION,CHECKLIST_LEVELS,LIMITS,BANK,
    normalizeRubric,validateRubric,weightPercents,rubricScore,cleanSelection,structureKey,canApplyActivityEdit,canChangeGradingMode,
    snapshotForActivity,fromLegacyInstrument,uniqueName,canonical,sha256,buildShareFile,parseShareFile,prepareImport,
    planTeamGrades,teamCriterionState,applyTeamTap,selectionsDiffer,newId,clone};
});
