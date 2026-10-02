'use strict';

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

let groups=[];
let instruments=[];
let attendanceData=[];
let gradeData=[];
let activeActivity=null;
let excelState=null;
let gradingData=null;
let currentView='dashboard';
let currentStudentGroup=null;

const dynamics={
  mode:'roulette',
  students:[],
  used:new Set(),
  rotation:0,
  spinning:false,
  teams:[]
};

function localDateISO(d=new Date()){
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
const today=localDateISO();

function escapeHtml(s){
  return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function normalizeText(s){
  return String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es-MX').trim().replace(/\s+/g,' ');
}
function fmtNum(v,d=2){
  return v==null||Number.isNaN(+v)?'—':Number(v).toFixed(d).replace(/\.00$/,'');
}
function toast(msg,error=false){
  const t=$('#toast');
  t.textContent=msg;
  t.className='toast show'+(error?' error':'');
  setTimeout(()=>t.className='toast',3000);
}
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3500);
}
function studentLabel(s){return MiAulaDB.displayName(s)||s.name||'';}
function activeOnly(rows){return rows.filter(s=>s.active!==0);}

function principalLabel(type){return type==='exam'?'Examen':'Proyecto';}
function totalPeriods(g){
  if(!g) return 3;
  const closed=Array.isArray(g.closed_periods)?g.closed_periods.map(x=>+x||0):[];
  const highest=Math.max(1,+g.current_period||1,...closed);
  return Math.max(highest,Number.isFinite(+g.total_periods)&&+g.total_periods>0?+g.total_periods:3);
}
function periodNumbers(g){return Array.from({length:totalPeriods(g)},(_,i)=>String(i+1));}
async function getGroupState(gid){
  const g=await MiAulaDB.get('groups',+gid);
  if(!g) return null;
  if(!Number.isFinite(+g.current_period)||+g.current_period<1) g.current_period=1;
  if(!Array.isArray(g.closed_periods)) g.closed_periods=[];
  const highest=Math.max(1,+g.current_period||1,...g.closed_periods.map(x=>+x||0));
  if(!Number.isFinite(+g.total_periods)||+g.total_periods<1) g.total_periods=Math.max(3,highest);
  if(+g.total_periods<highest) g.total_periods=highest;
  if(g.course_closed===undefined) g.course_closed=false;
  return g;
}
async function getActivePeriod(gid){
  const g=await getGroupState(gid);
  return g?String(g.current_period||1):'1';
}
function setEvaluationNavLabel(type){
  const label=$('#evaluationNavLabel');
  if(label) label.textContent=principalLabel(type);
  const btn=$('.nav-item[data-view="evaluation"]');
  if(btn) btn.title=principalLabel(type);
}
async function syncGroupPeriodIndicators(gid){
  if(!gid) return;
  const g=await getGroupState(gid); if(!g) return;
  const p=String(g.current_period||1);
  const s=await getScheme(+gid,p);
  setEvaluationNavLabel(s.principal_type||'project');
  const total=totalPeriods(g);
  const status=g.course_closed?`Parcial ${p} de ${total} cerrado · ciclo concluido`:`Parcial ${p} de ${total} · en curso`;
  ['#activityPeriodBadge','#gradingPeriodBadge','#evaluationPeriodBadge'].forEach(id=>{const el=$(id);if(el)el.textContent=status;});
  const closeBtn=$('#closePeriodBtn');
  if(closeBtn){closeBtn.disabled=!!g.course_closed;closeBtn.textContent=g.course_closed?`Parcial ${total} cerrado`:'Cerrar parcial e iniciar siguiente';}
}

function resetDynamicsSession(){
  dynamics.used.clear();
  dynamics.rotation=0;
  dynamics.spinning=false;
  dynamics.teams=[];
  const canvas=$('#rouletteCanvas');
  if(canvas){canvas.style.transition='none';canvas.style.transform='rotate(0deg)';setTimeout(()=>canvas.style.transition='',0);}
  if($('#rouletteNumber')) $('#rouletteNumber').textContent='—';
  if($('#rouletteName')) $('#rouletteName').textContent='Gira la ruleta';
  if($('#teamsResult')) $('#teamsResult').innerHTML='<div class="empty-state">Selecciona un grupo y crea los equipos.</div>';
  renderUsedStudents();
  drawWheel();
}

function goView(name){
  if(currentView==='dynamics' && name!=='dynamics'){ resetDynamicsSession(); exitRouletteFullscreen(); }
  currentView=name;
  $$('.view').forEach(v=>v.classList.remove('active'));
  $('#view-'+name)?.classList.add('active');
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  $('#viewTitle').textContent={
    dashboard:'Inicio',groups:'Mis grupos',attendance:'Asistencia',dynamics:'Ruleta y equipos',
    activities:'Calificaciones',grading:'Parcial',evaluation:'Proyecto',more:'Más'
  }[name]||name;
  if(name==='dashboard') loadSummary();
  if(name==='activities') loadActivities();
  if(name==='grading') loadGrading();
  if(name==='evaluation'){loadInstruments().then(()=>loadPrincipalWorkspace());}
  if(name==='dynamics') loadDynamicsStudents(true);
}
window.goView=goView;

function openDynamicsMode(mode){
  goView('dynamics');
  setDynamicsMode(mode);
}
window.openDynamicsMode=openDynamicsMode;

$$('.nav-item').forEach(b=>b.onclick=()=>goView(b.dataset.view));
$('#quickAttendance').onclick=()=>goView('attendance');

const fmtDate=new Intl.DateTimeFormat('es-MX',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
$('#todayLabel').textContent=fmtDate.format(new Date());
$('#attendanceDate').value=today;
$('#activityDate').value=today;
$('#evalDate').value=today;

if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  navigator.serviceWorker.register('sw.js?v=2.0.3').catch(()=>{});
}

async function init(){
  try{
    await MiAulaDB.open();
    await MiAulaDB.normalizeRecords();
    $('#systemStatus').textContent='Datos locales listos';
    await refreshGroups();
    await loadInstruments();
    await loadSummary();
    addCriterion();
  }catch(e){
    console.error(e);
    const b=$('#fatalBanner');
    b.textContent='No se pudo iniciar MiAula: '+e.message;
    b.classList.remove('hidden');
    toast(e.message,true);
  }
}

async function refreshGroups(){
  const oldValues={};
  ['#importGroup','#attendanceGroup','#dynamicsGroup','#activityGroup','#activityFilter','#gradingGroup','#evalGroup','#exportGroup'].forEach(id=>{
    if($(id)) oldValues[id]=$(id).value;
  });
  groups=(await MiAulaDB.all('groups')).filter(g=>g.active!==0).sort((a,b)=>
    String(a.grade||'').localeCompare(String(b.grade||''),'es',{numeric:true})||String(a.name||'').localeCompare(String(b.name||''),'es',{numeric:true})
  );
  const options='<option value="">Seleccionar…</option>'+groups.map(g=>`<option value="${g.id}">${escapeHtml(g.name)} — ${escapeHtml(g.discipline||'')}</option>`).join('');
  Object.keys(oldValues).forEach(id=>{
    if(!$(id)) return;
    $(id).innerHTML=options;
    if(groups.some(g=>String(g.id)===String(oldValues[id]))) $(id).value=oldValues[id];
  });
  await renderGroupsTable();
}

async function loadSummary(){
  const allStudents=await MiAulaDB.all('students');
  const attendance=await MiAulaDB.all('attendance');
  const grades=await MiAulaDB.all('grades');
  const activities=await MiAulaDB.all('activities');
  const activeGroupIds=new Set(groups.map(g=>g.id));
  const students=allStudents.filter(s=>activeGroupIds.has(s.group_id)&&s.active!==0);
  const studentIds=new Set(students.map(s=>s.id));
  const att=attendance.filter(a=>studentIds.has(a.student_id));
  const totalHours=att.reduce((n,a)=>n+(+a.class_hours||1),0);
  const attendedHours=att.reduce((n,a)=>n+(a.status==='F'?0:(+a.class_hours||1)),0);
  const attendancePct=totalHours?`${(attendedHours*100/totalHours).toFixed(1)}%`:'—';
  const classBlocks=new Map();
  for(const a of att){
    const k=`${a.group_id}:${a.attendance_date}`;
    classBlocks.set(k,Math.max(classBlocks.get(k)||0,+a.class_hours||1));
  }
  const registeredClassHours=[...classBlocks.values()].reduce((a,b)=>a+b,0);
  const actMap=new Map(activities.map(a=>[a.id,a]));
  const normalized=grades.filter(g=>studentIds.has(g.student_id)&&g.score!=null&&+actMap.get(g.activity_id)?.max_score>0)
    .map(g=>+g.score*10/+actMap.get(g.activity_id).max_score);
  const avg=normalized.length?(normalized.reduce((a,b)=>a+b,0)/normalized.length).toFixed(1):'—';
  $('#kpis').innerHTML=[
    ['Grupos activos',groups.length],['Alumnos activos',students.length],['Asistencia por hora',attendancePct],['Horas registradas',registeredClassHours||'—']
  ].map(x=>`<div class="kpi"><span>${x[0]}</span><strong>${x[1]}</strong></div>`).join('');

  const cards=[];
  for(const g of groups){
    const gs=students.filter(s=>s.group_id===g.id);
    const ids=new Set(gs.map(s=>s.id));
    const ga=att.filter(a=>ids.has(a.student_id));
    const th=ga.reduce((n,a)=>n+(+a.class_hours||1),0);
    const ah=ga.reduce((n,a)=>n+(a.status==='F'?0:(+a.class_hours||1)),0);
    const p=+g.current_period||1,total=totalPeriods(g),status=g.course_closed?'Ciclo cerrado':`Parcial ${p}/${total}`;
    cards.push(`<div class="group-card"><div class="grade">${escapeHtml(g.name)}</div><div class="disc">${escapeHtml(g.discipline||'')}</div><div class="group-stats"><span>${gs.length} alumnos</span><span>${th?(ah*100/th).toFixed(0)+'%':'—'} asistencia</span></div><div class="group-period-chip">${status}</div></div>`);
  }
  $('#dashboardGroups').innerHTML=cards.length?cards.join(''):'<div class="empty-state">Crea tu primer grupo o importa tu información anterior.</div>';
}

// -------------------- GRUPOS Y ALUMNOS --------------------
$('#groupForm').onsubmit=async e=>{
  e.preventDefault();
  const d=Object.fromEntries(new FormData(e.target));
  d.total_periods=Math.max(1,Math.min(6,+d.total_periods||3));
  d.active=1;d.current_period=1;d.closed_periods=[];d.course_closed=false;d.created_at=new Date().toISOString();
  try{
    await MiAulaDB.add('groups',d);
    e.target.reset();e.target.school_year.value='2026-2027';
    await refreshGroups();await loadSummary();toast('Grupo creado');
  }catch(er){toast(er.message,true);}
};

async function renderGroupsTable(){
  if(!groups.length){$('#groupsTable').innerHTML='<div class="empty-state">Todavía no hay grupos.</div>';return;}
  const rows=[];
  for(const g of groups){
    const all=await MiAulaDB.groupStudents(g.id,{includeInactive:true});
    const active=all.filter(s=>s.active!==0).length;
    const inactive=all.length-active;
    rows.push(`<tr><td><strong>${escapeHtml(g.name)}</strong></td><td>${escapeHtml(g.grade||'')}</td><td>${escapeHtml(g.discipline||'')}</td><td><span class="period-badge">${g.course_closed?'Cerrado':`P${+g.current_period||1}/${totalPeriods(g)}`}</span></td><td>${active}</td><td>${inactive}</td><td><div class="action-row"><button class="btn small primary" onclick="viewStudents(${g.id})">Alumnos</button><button class="btn small subtle" onclick="editGroup(${g.id})">Editar</button><button class="btn small danger" onclick="archiveGroup(${g.id})">Archivar</button></div></td></tr>`);
  }
  $('#groupsTable').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Grupo</th><th>Grado</th><th>Disciplina</th><th>Parcial</th><th>Activos</th><th>Bajas</th><th>Acciones</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

window.viewStudents=async gid=>{
  currentStudentGroup=gid;
  await MiAulaDB.reorganizeGroup(gid);
  const all=await MiAulaDB.groupStudents(gid,{includeInactive:true});
  const active=all.filter(s=>s.active!==0).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const inactive=all.filter(s=>s.active===0);
  const g=groups.find(x=>x.id===gid)||await MiAulaDB.get('groups',gid);
  $('#groupsTable').innerHTML=`
    <div class="panel-head"><div><h3>${escapeHtml(g.name)} · ${active.length} activos</h3><p>${escapeHtml(g.discipline||'')} · ${inactive.length} bajas conservadas</p></div><div class="action-row"><button class="btn subtle" onclick="reorganizeStudents(${gid})">A–Z y renumerar</button><button class="btn" onclick="renderGroupsTable()">Volver</button></div></div>
    <form id="manualStudentForm" class="form-grid">
      <input type="hidden" name="group_id" value="${gid}">
      <label>Apellido paterno<input name="paternal_last_name" required placeholder="Ej. García"></label>
      <label>Apellido materno<input name="maternal_last_name" placeholder="Ej. López"></label>
      <label class="span-2">Nombre(s)<input name="given_names" required placeholder="Ej. Juan Carlos"></label>
      <label class="span-2">Grado / semestre<input name="grade" value="${escapeHtml(g.grade||'')}"></label>
      <button class="btn primary span-2">Agregar alumno y ordenar lista</button>
    </form>
    <h4>Alumnos activos</h4>
    <div class="table-wrap"><table><thead><tr><th>No.</th><th>Apellido paterno</th><th>Apellido materno</th><th>Nombre(s)</th><th>Nombre en lista</th><th>Acciones</th></tr></thead><tbody>
      ${active.map(s=>`<tr><td><strong>${s.list_number??''}</strong></td><td>${escapeHtml(s.paternal_last_name||'—')}</td><td>${escapeHtml(s.maternal_last_name||'—')}</td><td>${escapeHtml(s.given_names||(!s.paternal_last_name&&!s.maternal_last_name?s.name:'—'))}</td><td>${escapeHtml(studentLabel(s))}</td><td><div class="action-row"><button class="btn small subtle" onclick="editStudent(${s.id})">Editar</button><button class="btn small danger" onclick="deactivateStudent(${s.id},${gid})">Dar de baja</button></div></td></tr>`).join('')||'<tr><td colspan="6">Sin alumnos activos.</td></tr>'}
    </tbody></table></div>
    <h4 style="margin-top:20px">Alumnos dados de baja</h4>
    <div class="table-wrap"><table><thead><tr><th>Último No.</th><th>Alumno</th><th>Fecha de baja</th><th>Acción</th></tr></thead><tbody>
      ${inactive.map(s=>`<tr><td>${s.former_list_number??s.list_number??''}</td><td>${escapeHtml(studentLabel(s))}</td><td>${s.withdrawn_at?new Date(s.withdrawn_at).toLocaleDateString('es-MX'):'—'}</td><td><button class="btn small primary" onclick="reactivateStudent(${s.id},${gid})">Reactivar</button></td></tr>`).join('')||'<tr><td colspan="4">No hay alumnos dados de baja.</td></tr>'}
    </tbody></table></div>`;

  $('#manualStudentForm').onsubmit=async e=>{
    e.preventDefault();
    const d=Object.fromEntries(new FormData(e.target));
    d.group_id=+d.group_id;d.active=1;d.student_code=await MiAulaDB.nextStudentCode();d.created_at=new Date().toISOString();
    d.name=[d.paternal_last_name,d.maternal_last_name,d.given_names].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    await MiAulaDB.add('students',d);
    await MiAulaDB.reorganizeGroup(gid);
    toast('Alumno agregado y lista reorganizada');
    await viewStudents(gid);await loadSummary();
  };
};

window.reorganizeStudents=async gid=>{
  const all=await MiAulaDB.groupStudents(gid,{includeInactive:false});
  const missing=all.filter(s=>!String(s.paternal_last_name||'').trim()).length;
  if(missing && !confirm(`${missing} alumno(s) no tienen Apellido paterno separado. MiAula usará su nombre heredado como referencia. ¿Continuar con el orden A–Z?`)) return;
  await MiAulaDB.reorganizeGroup(gid,{forceAlphabetical:true});
  toast('Lista ordenada A–Z por apellido paterno y renumerada');
  await viewStudents(gid);
};

function openModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').classList.remove('hidden');}
function closeModal(){$('#modal').classList.add('hidden');}
$('#modalClose').onclick=closeModal;
$('#modal').onclick=e=>{if(e.target===$('#modal'))closeModal();};

window.editGroup=async id=>{
  const g=await MiAulaDB.get('groups',id);
  const total=totalPeriods(g);
  openModal('Editar grupo',`<form id="editGroupForm"><label>Grupo<input name="name" value="${escapeHtml(g.name)}" required></label><label>Grado / semestre<input name="grade" value="${escapeHtml(g.grade||'')}"></label><label>Disciplina<input name="discipline" value="${escapeHtml(g.discipline||'')}" required></label><label>Ciclo escolar<input name="school_year" value="${escapeHtml(g.school_year||'')}"></label><label>Número de parciales<select name="total_periods">${[1,2,3,4,5,6].map(n=>`<option value="${n}" ${n===total?'selected':''}>${n}</option>`).join('')}</select></label><p class="muted-text">Puedes aumentar los parciales cuando quieras. MiAula no permite reducirlos por debajo del parcial más alto que ya tenga información.</p><button class="btn primary wide">Guardar cambios</button></form>`);
  $('#editGroupForm').onsubmit=async e=>{
    e.preventDefault();
    const d=Object.fromEntries(new FormData(e.target)),requested=Math.max(1,Math.min(6,+d.total_periods||3));
    const highest=Math.max(1,+g.current_period||1,...(g.closed_periods||[]).map(x=>+x||0));
    if(requested<highest){toast(`No puedes reducir a ${requested}: este grupo ya tiene información hasta el Parcial ${highest}.`,true);return;}
    d.total_periods=requested;
    Object.assign(g,d);
    if(g.course_closed && (+g.current_period||1)<requested) g.course_closed=false;
    await MiAulaDB.put('groups',g);
    closeModal();await refreshGroups();await loadSummary();toast('Grupo actualizado');
  };
};

window.archiveGroup=async id=>{
  if(!confirm('¿Archivar este grupo? Se conservarán alumnos, asistencias y calificaciones.'))return;
  await MiAulaDB.archiveGroup(id);await refreshGroups();await loadSummary();toast('Grupo archivado');
};

window.editStudent=async id=>{
  const s=await MiAulaDB.get('students',id);
  const legacy=!s.paternal_last_name&&!s.maternal_last_name&&!s.given_names;
  openModal('Editar alumno',`<form id="editStudentForm"><label>Apellido paterno<input name="paternal_last_name" value="${escapeHtml(s.paternal_last_name||'')}"></label><label>Apellido materno<input name="maternal_last_name" value="${escapeHtml(s.maternal_last_name||'')}"></label><label>Nombre(s)<input name="given_names" value="${escapeHtml(s.given_names||(legacy?s.name:''))}" required></label><label>Grado / semestre<input name="grade" value="${escapeHtml(s.grade||'')}"></label>${legacy?`<p class="muted-text">Este alumno proviene de una versión anterior. Se colocó el nombre completo en “Nombre(s)”; separa sus apellidos para que el orden A–Z sea exacto.</p>`:''}<button class="btn primary wide">Guardar y reorganizar</button></form>`);
  $('#editStudentForm').onsubmit=async e=>{
    e.preventDefault();
    Object.assign(s,Object.fromEntries(new FormData(e.target)));
    s.name=[s.paternal_last_name,s.maternal_last_name,s.given_names].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    await MiAulaDB.put('students',s);await MiAulaDB.reorganizeGroup(s.group_id);closeModal();toast('Alumno actualizado');
    if(currentStudentGroup) await viewStudents(currentStudentGroup);await loadSummary();
  };
};

window.deactivateStudent=async(id,gid)=>{
  const s=await MiAulaDB.get('students',id);
  if(!confirm(`¿Dar de baja a ${studentLabel(s)}?\n\nSus asistencias, calificaciones y evaluaciones se conservarán.`))return;
  await MiAulaDB.deactivateStudent(id);toast('Alumno dado de baja; historial conservado');await viewStudents(gid);await loadSummary();
};
window.reactivateStudent=async(id,gid)=>{await MiAulaDB.reactivateStudent(id);toast('Alumno reactivado y lista reorganizada');await viewStudents(gid);await loadSummary();};

// -------------------- IMPORTACIÓN EXCEL --------------------
$('#excelFile').onchange=async e=>{
  const f=e.target.files[0];if(!f)return;
  try{
    const wb=await XLSXLite.read(await f.arrayBuffer());
    excelState={workbook:wb,sheets:wb.sheets.map(s=>({...s,table:XLSXLite.detectTable(s)}))};
    renderExcelWizard(0);toast('Excel leído correctamente');
  }catch(er){console.error(er);toast(er.message,true);}
};

function selectOpts(headers,selected){
  return '<option value="-1">No usar</option>'+headers.map((h,i)=>`<option value="${i}" ${i===selected?'selected':''}>${escapeHtml(h||('Columna '+(i+1)))}</option>`).join('');
}
function renderExcelWizard(sheetIndex){
  const s=excelState.sheets[sheetIndex],t=s.table,h=t.headers,m=t.mapping||{};
  $('#excelWizard').classList.remove('hidden');
  $('#excelWizard').innerHTML=`
    <label>Hoja<select id="wizSheet">${excelState.sheets.map((x,i)=>`<option value="${i}" ${i===sheetIndex?'selected':''}>${escapeHtml(x.name)}</option>`).join('')}</select></label>
    <div class="form-grid">
      <label>Apellido paterno<select id="mapPaternal">${selectOpts(h,m.paternal_last_name)}</select></label>
      <label>Apellido materno<select id="mapMaternal">${selectOpts(h,m.maternal_last_name)}</select></label>
      <label>Nombre(s)<select id="mapGiven">${selectOpts(h,m.given_names)}</select></label>
      <label>Nombre completo (alternativa)<select id="mapFull">${selectOpts(h,m.full_name)}</select></label>
      <label>Número de lista<select id="mapNum">${selectOpts(h,m.list_number)}</select></label>
      <label>Grado<select id="mapGrade">${selectOpts(h,m.grade)}</select></label>
    </div>
    <p class="muted-text">Recomendado: usa las tres columnas separadas. Si tu archivo solo tiene “Nombre completo”, selecciona esa alternativa.</p>
    <div class="table-wrap"><table><thead><tr>${h.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${t.preview.map(r=>`<tr>${h.map((_,i)=>`<td>${escapeHtml(r[i]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <button class="btn primary wide" id="confirmImport">Importar, ordenar A–Z y renumerar</button>`;
  $('#wizSheet').onchange=e=>renderExcelWizard(+e.target.value);
  $('#confirmImport').onclick=importExcel;
}
async function importExcel(){
  const gid=+$('#importGroup').value;if(!gid){toast('Selecciona el grupo destino',true);return;}
  const si=+$('#wizSheet').value,s=excelState.sheets[si],t=s.table,rows=s.rows;
  const map={paternal:+$('#mapPaternal').value,maternal:+$('#mapMaternal').value,given:+$('#mapGiven').value,full:+$('#mapFull').value,num:+$('#mapNum').value,grade:+$('#mapGrade').value};
  const structured=map.paternal>=0&&map.given>=0;
  if(!structured&&map.full<0){toast('Selecciona Apellido paterno + Nombre(s), o una columna de Nombre completo.',true);return;}
  const existing=await MiAulaDB.groupStudents(gid,{includeInactive:true});
  const existingNames=new Set(existing.map(x=>normalizeText(studentLabel(x))));
  const group=await MiAulaDB.get('groups',gid);
  let imported=0,skipped=0;
  for(const row of rows.slice(t.headerRow+1)){
    const val=i=>i>=0&&i<row.length&&row[i]!=null?String(row[i]).trim():'';
    const paternal=structured?val(map.paternal):'';
    const maternal=structured?val(map.maternal):'';
    const given=structured?val(map.given):'';
    const full=structured?[paternal,maternal,given].filter(Boolean).join(' ').replace(/\s+/g,' ').trim():val(map.full);
    if(!full)continue;
    if(existingNames.has(normalizeText(full))){skipped++;continue;}
    let importedNum=null;if(map.num>=0){const n=Number(val(map.num));if(Number.isFinite(n))importedNum=n;}
    const rec={student_code:await MiAulaDB.nextStudentCode(),list_number:importedNum,name:full,paternal_last_name:paternal,maternal_last_name:maternal,given_names:given,grade:val(map.grade)||group.grade||'',group_id:gid,active:1,created_at:new Date().toISOString()};
    await MiAulaDB.add('students',rec);existingNames.add(normalizeText(full));imported++;
  }
  await MiAulaDB.reorganizeGroup(gid,{forceAlphabetical:true});
  $('#excelWizard').classList.add('hidden');$('#excelFile').value='';
  toast(`${imported} alumnos importados y ordenados${skipped?` · ${skipped} omitidos`:''}`);
  await loadSummary();await renderGroupsTable();
}

// -------------------- ASISTENCIA POR HORAS --------------------
$('#loadAttendance').onclick=loadAttendance;
$('#attendanceHours').onchange=updateAttendanceStats;
async function loadAttendance(){
  const gid=+$('#attendanceGroup').value,dt=$('#attendanceDate').value;
  if(!gid){toast('Selecciona un grupo',true);return;}
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const existing=await MiAulaDB.byIndex('attendance','group_date',[gid,dt]);
  const em=new Map(existing.map(a=>[a.student_id,a]));
  if(existing.length) $('#attendanceHours').value=String(existing[0].class_hours||1);
  attendanceData=students.map(s=>({student_id:s.id,list_number:s.list_number,name:studentLabel(s),status:em.get(s.id)?.status||'P',notes:em.get(s.id)?.notes||''}));
  renderAttendance();
}
function renderAttendance(){
  $('#attendanceList').className='student-list';
  $('#attendanceList').innerHTML=attendanceData.length?attendanceData.map((s,i)=>`<div class="student-row" data-index="${i}"><div class="num">${s.list_number??'—'}</div><div><strong>${escapeHtml(s.name)}</strong><div class="student-sub">${escapeHtml(groups.find(g=>g.id===+$('#attendanceGroup').value)?.name||'')}</div></div><div class="status-buttons">${['P','F','R','J'].map(st=>`<button class="status-btn ${s.status===st?'active':''}" data-status="${st}" onclick="setStatus(${i},'${st}',this)">${st}</button>`).join('')}</div></div>`).join(''):'<div class="empty-state">Este grupo no tiene alumnos activos.</div>';
  $('#saveAttendance').classList.toggle('hidden',!attendanceData.length);
  $('#attendanceStats').classList.toggle('hidden',!attendanceData.length);
  updateAttendanceStats();
}
window.setStatus=(i,st,el)=>{
  attendanceData[i].status=st;
  el.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  updateAttendanceStats();
};
function updateAttendanceStats(){
  if(!attendanceData.length)return;
  const hours=Math.max(1,+$('#attendanceHours').value||1),counts={P:0,F:0,R:0,J:0};
  attendanceData.forEach(s=>counts[s.status]=(counts[s.status]||0)+hours);
  $('#attendanceStats').innerHTML=[
    ['Alumnos',attendanceData.length],['Bloque de clase',hours+' h'],['Presentes',counts.P+' h'],['Faltas',counts.F+' h'],['Retardos',counts.R+' h'],['Justificadas',counts.J+' h']
  ].map(x=>`<div class="attendance-stat"><span>${x[0]}</span><strong>${x[1]}</strong></div>`).join('');
}
$('#saveAttendance').onclick=async()=>{
  const gid=+$('#attendanceGroup').value,dt=$('#attendanceDate').value,hours=Math.max(1,+$('#attendanceHours').value||1);
  try{
    for(const it of attendanceData){
      const old=await MiAulaDB.firstByIndex('attendance','unique_key',[gid,it.student_id,dt]);
      const rec={...(old||{}),group_id:gid,student_id:it.student_id,attendance_date:dt,status:it.status,notes:it.notes||'',class_hours:hours,updated_at:new Date().toISOString()};
      if(old) await MiAulaDB.put('attendance',rec); else await MiAulaDB.add('attendance',rec);
    }
    toast(`Asistencia guardada · ${hours} hora${hours===1?'':'s'} contabilizadas`);await loadSummary();
    if(currentView==='dynamics') await loadDynamicsStudents(true);
  }catch(e){toast(e.message,true);}
};

// -------------------- RULETA Y EQUIPOS --------------------
$$('#dynamicsTabs button').forEach(btn=>btn.onclick=()=>setDynamicsMode(btn.dataset.mode));
$('#dynamicsGroup').onchange=()=>loadDynamicsStudents(true);
$('#dynamicsPresentOnly').onchange=()=>loadDynamicsStudents(true);
$('#resetWheel').onclick=()=>{dynamics.used.clear();dynamics.rotation=0;$('#rouletteNumber').textContent='—';$('#rouletteName').textContent='Gira la ruleta';const c=$('#rouletteCanvas');c.style.transition='none';c.style.transform='rotate(0deg)';setTimeout(()=>c.style.transition='',0);drawWheel();renderUsedStudents();updateRouletteCounter();toast('Ruleta reiniciada');};
$('#spinWheel').onclick=spinWheel;
$('#fullscreenWheel').onclick=toggleRouletteFullscreen;
$('#generateTeams').onclick=generateTeams;
$('#copyTeams').onclick=copyTeams;

function setDynamicsMode(mode){
  dynamics.mode=mode;
  $$('#dynamicsTabs button').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  $('#rouletteMode').classList.toggle('hidden',mode!=='roulette');
  $('#teamsMode').classList.toggle('hidden',mode!=='teams');
  if(mode!=='roulette'){
    dynamics.used.clear();dynamics.rotation=0;renderUsedStudents();drawWheel();exitRouletteFullscreen();
  }
  if(mode!=='teams'){dynamics.teams=[];$('#teamsResult').innerHTML='<div class="empty-state">Selecciona un grupo y crea los equipos.</div>';}
}

async function loadDynamicsStudents(reset=true){
  const gid=+$('#dynamicsGroup').value;
  if(!gid){dynamics.students=[];$('#dynamicsSourceInfo').textContent='Selecciona un grupo.';drawWheel();updateRouletteCounter();return;}
  let students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  let note=`${students.length} alumnos activos`;
  if($('#dynamicsPresentOnly').checked){
    const attendance=await MiAulaDB.byIndex('attendance','group_date',[gid,today]);
    if(attendance.length){
      const presentIds=new Set(attendance.filter(a=>a.status!=='F').map(a=>a.student_id));
      students=students.filter(s=>presentIds.has(s.id));
      note=`${students.length} presentes hoy · se excluyen faltas`;
    }else{
      note=`No hay asistencia guardada hoy · se usarán los ${students.length} alumnos activos`;
    }
  }
  dynamics.students=students;
  $('#dynamicsSourceInfo').textContent=note;
  if(reset) resetDynamicsSession();
  drawWheel();updateRouletteCounter();
}

const WHEEL_PALETTE=[
  {fill:'#FF3B30',text:'#FFFFFF'},
  {fill:'#FF9500',text:'#172A46'},
  {fill:'#FFD60A',text:'#172A46'},
  {fill:'#30D158',text:'#12361F'},
  {fill:'#00C7BE',text:'#073B3A'},
  {fill:'#00A7FF',text:'#FFFFFF'},
  {fill:'#0A84FF',text:'#FFFFFF'},
  {fill:'#5E5CE6',text:'#FFFFFF'},
  {fill:'#BF5AF2',text:'#FFFFFF'},
  {fill:'#FF2D55',text:'#FFFFFF'},
  {fill:'#FF6B35',text:'#FFFFFF'},
  {fill:'#15B8A6',text:'#073B3A'}
];
function wheelStyle(i,used){
  if(used)return {fill:i%2?'#B7C0CD':'#D1D7E0',text:'#5D6878'};
  return WHEEL_PALETTE[i%WHEEL_PALETTE.length];
}

function updateFullscreenButton(){
  const btn=$('#fullscreenWheel');if(!btn)return;
  const active=document.body.classList.contains('roulette-focus')||!!document.fullscreenElement;
  btn.textContent=active?'✕ Salir de pantalla completa':'⛶ Pantalla completa';
  btn.classList.toggle('active',active);
}
async function toggleRouletteFullscreen(){
  const active=document.body.classList.contains('roulette-focus')||!!document.fullscreenElement;
  if(active){await exitRouletteFullscreen();return;}
  document.body.classList.add('roulette-focus');
  updateFullscreenButton();
  try{
    if(document.documentElement.requestFullscreen){
      await document.documentElement.requestFullscreen({navigationUI:'hide'});
    }
  }catch(e){
    // Si Android/Huawei no ofrece Fullscreen API, el modo presentación CSS sigue funcionando.
  }
  setTimeout(()=>{drawWheel();updateFullscreenButton();},120);
}
async function exitRouletteFullscreen(){
  document.body.classList.remove('roulette-focus');
  try{if(document.fullscreenElement&&document.exitFullscreen)await document.exitFullscreen();}catch(e){}
  updateFullscreenButton();
  setTimeout(()=>drawWheel(),80);
}
document.addEventListener('fullscreenchange',()=>{
  if(!document.fullscreenElement)document.body.classList.remove('roulette-focus');
  updateFullscreenButton();
  setTimeout(()=>drawWheel(),80);
});
function drawWheel(){
  const canvas=$('#rouletteCanvas');if(!canvas)return;
  const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,cx=w/2,cy=h/2,r=Math.min(w,h)/2-10;
  ctx.clearRect(0,0,w,h);
  const students=dynamics.students;
  if(!students.length){
    ctx.fillStyle='#edf3fb';ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.fillStyle='#6b7d94';ctx.font='700 28px Segoe UI,Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('Selecciona un grupo',cx,cy);return;
  }
  const step=Math.PI*2/students.length,start=-Math.PI/2-step/2;
  students.forEach((s,i)=>{
    const a1=start+i*step,a2=a1+step,used=dynamics.used.has(s.id);
    const style=wheelStyle(i,used);
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a1,a2);ctx.closePath();ctx.fillStyle=style.fill;ctx.fill();ctx.strokeStyle='rgba(255,255,255,.82)';ctx.lineWidth=2.5;ctx.stroke();
    const mid=a1+step/2,tx=cx+Math.cos(mid)*r*.72,ty=cy+Math.sin(mid)*r*.72;
    ctx.fillStyle=style.text;ctx.font=`950 ${students.length>42?17:students.length>30?20:students.length>20?24:30}px Segoe UI,Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(s.list_number??i+1),tx,ty);
  });
  ctx.beginPath();ctx.arc(cx,cy,r*.19,0,Math.PI*2);ctx.fillStyle='#ffffff';ctx.fill();
}
function updateRouletteCounter(){
  const available=dynamics.students.filter(s=>!dynamics.used.has(s.id)).length;
  $('#rouletteCounter').textContent=`${available} disponibles · ${dynamics.used.size} ya participaron`;
  $('#spinWheel').disabled=!available||dynamics.spinning;
}
function renderUsedStudents(){
  const el=$('#usedStudents');if(!el)return;
  const used=dynamics.students.filter(s=>dynamics.used.has(s.id));
  el.innerHTML=used.length?used.map(s=>`<span class="used-chip"><b>${s.list_number}</b>${escapeHtml(studentLabel(s))}</span>`).join(''):'<span class="muted-text">Nadie todavía.</span>';
  updateRouletteCounter();
}
function randomInt(max){
  if(max<=1)return 0;
  if(crypto?.getRandomValues){const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]%max;}
  return Math.floor(Math.random()*max);
}
async function spinWheel(){
  if(dynamics.spinning)return;
  const available=dynamics.students.filter(s=>!dynamics.used.has(s.id));
  if(!available.length){toast('Todos los alumnos disponibles ya participaron. Reinicia la ruleta.');return;}
  dynamics.spinning=true;updateRouletteCounter();
  const chosen=available[randomInt(available.length)];
  const index=dynamics.students.findIndex(s=>s.id===chosen.id),step=360/dynamics.students.length;
  const desired=((-(index*step))%360+360)%360,current=((dynamics.rotation%360)+360)%360,delta=(desired-current+360)%360;
  dynamics.rotation+=1440+delta;
  const canvas=$('#rouletteCanvas');canvas.style.transition='transform 4.3s cubic-bezier(.12,.68,.08,1)';canvas.style.transform=`rotate(${dynamics.rotation}deg)`;
  await new Promise(r=>setTimeout(r,4350));
  dynamics.used.add(chosen.id);
  $('#rouletteNumber').textContent=chosen.list_number??index+1;
  $('#rouletteName').textContent=studentLabel(chosen);
  const result=$('#rouletteResultPanel');
  if(result){result.classList.remove('winner-pop');void result.offsetWidth;result.classList.add('winner-pop');setTimeout(()=>result.classList.remove('winner-pop'),900);}
  renderUsedStudents();
  // Regresa visualmente la rueda a su orientación base manteniendo marcado al alumno que ya salió.
  canvas.style.transition='none';canvas.style.transform='rotate(0deg)';dynamics.rotation=0;drawWheel();
  requestAnimationFrame(()=>requestAnimationFrame(()=>canvas.style.transition=''));
  dynamics.spinning=false;updateRouletteCounter();
}
function shuffled(arr){
  const out=[...arr];
  for(let i=out.length-1;i>0;i--){const j=randomInt(i+1);[out[i],out[j]]=[out[j],out[i]];}
  return out;
}
function teamSizes(n,preferred){
  if(n<=0)return[];if(n===1)return[1];
  if(preferred===2){
    if(n%2===0)return Array(n/2).fill(2);
    if(n>=3)return [...Array((n-3)/2).fill(2),3];
  }
  const q=Math.floor(n/3),r=n%3;
  if(r===0)return Array(q).fill(3);
  if(r===1){if(q>=1)return [...Array(q-1).fill(3),2,2];return[1];}
  return [...Array(q).fill(3),2];
}
async function generateTeams(){
  await loadDynamicsStudents(false);
  const pool=shuffled(dynamics.students),preferred=+$('#teamSize').value;
  if(pool.length<2){toast('Se necesitan al menos 2 alumnos disponibles.',true);return;}
  const sizes=teamSizes(pool.length,preferred);let pos=0;
  dynamics.teams=sizes.map((size,i)=>({name:`Equipo ${i+1}`,members:pool.slice(pos,pos+=size)}));
  $('#teamsResult').innerHTML=dynamics.teams.map(t=>`<div class="team-card"><h3>${t.name} · ${t.members.length}</h3><ul>${t.members.map(s=>`<li><b>${s.list_number}</b><span>${escapeHtml(studentLabel(s))}</span></li>`).join('')}</ul></div>`).join('');
  toast(`${dynamics.teams.length} equipos creados`);
}
async function copyTeams(){
  if(!dynamics.teams.length){toast('Primero crea los equipos.',true);return;}
  const text=dynamics.teams.map(t=>`${t.name}\n${t.members.map(s=>`${s.list_number}. ${studentLabel(s)}`).join('\n')}`).join('\n\n');
  try{await navigator.clipboard.writeText(text);toast('Equipos copiados');}catch{toast('No se pudo copiar automáticamente.',true);}
}

// -------------------- ACTIVIDADES Y CALIFICACIONES --------------------
$('#activityForm').onsubmit=async e=>{
  e.preventDefault();
  const d=Object.fromEntries(new FormData(e.target));
  if(!d.group_id){toast('Selecciona un grupo',true);return;}
  d.group_id=+d.group_id;
  const g=await getGroupState(d.group_id);
  if(g.course_closed){toast(`Este grupo ya cerró sus ${totalPeriods(g)} parciales.`,true);return;}
  d.period=String(g.current_period||1);
  d.max_score=+d.max_score;d.weight=+d.weight;d.created_at=new Date().toISOString();
  await MiAulaDB.add('activities',d);
  e.target.title.value='';
  await loadActivities();
  toast(`Actividad creada en Parcial ${d.period}`);
};
$('#activityFilter').onchange=loadActivities;
$('#activityGroup').onchange=async()=>{const gid=+$('#activityGroup').value;if(gid){$('#activityFilter').value=String(gid);await loadActivities();}};
async function loadActivities(){
  const gid=+$('#activityFilter').value||+$('#activityGroup').value||groups[0]?.id;
  if(!gid){$('#activityCards').innerHTML='<div class="empty-state">Crea un grupo primero.</div>';return;}
  $('#activityFilter').value=String(gid);
  if(!$('#activityGroup').value)$('#activityGroup').value=String(gid);
  const g=await getGroupState(gid),p=String(g.current_period||1);
  if($('#activityPeriodBadge'))$('#activityPeriodBadge').textContent=g.course_closed?`Parcial ${p} de ${totalPeriods(g)} cerrado · ciclo concluido`:`Parcial ${p} de ${totalPeriods(g)} · en curso`;
  if(g.course_closed){$('#activityCards').innerHTML=`<div class="empty-state">Los ${totalPeriods(g)} parciales están cerrados. El historial permanece en la exportación de Excel.</div>`;return;}
  const arr=(await MiAulaDB.byIndex('activities','group_period',[gid,p])).sort((a,b)=>b.id-a.id);
  $('#activityCards').innerHTML=arr.length
    ?arr.map(a=>`<div class="activity-card"><div><strong>${escapeHtml(a.title)}</strong><br><small>${escapeHtml(a.activity_type)} · Parcial ${a.period} · Máx. ${a.max_score} · Peso ${a.weight}</small></div><div class="action-row"><button class="btn small primary" onclick="openGrades(${a.id})">Calificar</button><button class="btn small danger" onclick="deleteActivity(${a.id})">Eliminar</button></div></div>`).join('')
    :`<div class="empty-state">Parcial ${p} limpio. Crea la primera actividad.</div>`;
  await syncGroupPeriodIndicators(gid);
}
window.openGrades=async aid=>{
  const activity=await MiAulaDB.get('activities',aid);if(!activity)return;
  activeActivity=activity;
  const students=(await MiAulaDB.groupStudents(activity.group_id,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const existing=await MiAulaDB.byIndex('grades','activity_id',aid),gm=new Map(existing.map(g=>[g.student_id,g]));
  gradeData=students.map(s=>({student_id:s.id,list_number:s.list_number,name:studentLabel(s),score:gm.get(s.id)?.score??null,notes:gm.get(s.id)?.notes||''}));
  $('#gradePanel').classList.remove('hidden');$('#gradeTitle').textContent=`Calificar: ${activity.title}`;renderGrades();$('#gradePanel').scrollIntoView({behavior:'smooth'});
};
function renderGrades(){
  const max=+activeActivity.max_score,quick=[max,Math.max(max-1,0),Math.max(max-2,0),Math.max(max-3,0),'NP'];
  $('#gradeList').innerHTML=gradeData.map((s,i)=>`<div class="grade-row"><strong>${s.list_number??'—'}</strong><div>${escapeHtml(s.name)}</div><input type="number" min="0" max="${max}" step="0.1" value="${s.score??''}" data-gi="${i}" class="grade-input"><div class="quick-score">${quick.map(q=>`<button onclick="quickGrade(${i},'${q}')">${q}</button>`).join('')}</div></div>`).join('');
  $$('.grade-input').forEach(inp=>inp.oninput=e=>gradeData[+e.target.dataset.gi].score=e.target.value);
}
window.quickGrade=(i,v)=>{gradeData[i].score=v==='NP'?null:+v;renderGrades();};
$('#fillMax').onclick=()=>{gradeData.forEach(x=>x.score=+activeActivity.max_score);renderGrades();};
$('#saveGrades').onclick=async()=>{
  for(const it of gradeData){
    const old=await MiAulaDB.firstByIndex('grades','unique_key',[activeActivity.id,it.student_id]);
    const rec={...(old||{}),activity_id:activeActivity.id,student_id:it.student_id,score:it.score===''||it.score==null?null:+it.score,notes:it.notes||''};
    if(old)await MiAulaDB.put('grades',rec);else await MiAulaDB.add('grades',rec);
  }
  toast('Calificaciones guardadas');await loadSummary();
};
window.deleteActivity=async id=>{if(!confirm('¿Eliminar esta actividad y sus calificaciones?'))return;await MiAulaDB.deleteActivity(id);$('#gradePanel').classList.add('hidden');await loadActivities();await loadSummary();toast('Actividad eliminada');};

// -------------------- PARCIAL / ESQUEMA DE EVALUACIÓN --------------------
async function getScheme(gid,period){
  const key=`${gid}:${period}`;
  let s=await MiAulaDB.get('gradingSchemes',key);
  if(!s){
    s={
      key,group_id:+gid,period:String(period),
      work_pct:40,project_pct:40,values_pct:10,attitudes_pct:10,
      principal_type:'project',mode_locked:false,
      updated_at:new Date().toISOString()
    };
    await MiAulaDB.put('gradingSchemes',s);
  }else{
    let changed=false;
    if(!s.principal_type){s.principal_type='project';changed=true;}
    if(s.mode_locked===undefined){s.mode_locked=false;changed=true;}
    if(changed) await MiAulaDB.put('gradingSchemes',s);
  }
  if(!s.mode_locked){
    const [legacyEvals,legacyActs,legacyComps]=await Promise.all([
      MiAulaDB.byIndex('evaluations','group_period',[+gid,String(period)]),
      MiAulaDB.byIndex('activities','group_period',[+gid,String(period)]),
      MiAulaDB.byIndex('studentComponents','group_period',[+gid,String(period)])
    ]);
    const hasExam=legacyComps.some(c=>c.exam_score!=null)||legacyActs.some(a=>String(a.activity_type||'').toLowerCase()==='examen');
    const hasProject=legacyEvals.length>0||legacyActs.some(a=>String(a.activity_type||'').toLowerCase()==='proyecto');
    if(hasExam&&!hasProject){s.principal_type='exam';s.mode_locked=true;await MiAulaDB.put('gradingSchemes',s);}
    else if(hasProject){s.principal_type='project';s.mode_locked=true;await MiAulaDB.put('gradingSchemes',s);}
  }
  return s;
}

async function computeGroupGrading(gid,period){
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const activities=await MiAulaDB.byIndex('activities','group_period',[gid,String(period)]);
  const allGrades=await MiAulaDB.all('grades');
  const actIds=new Set(activities.map(a=>a.id));
  const grades=allGrades.filter(g=>actIds.has(g.activity_id));
  const evals=await MiAulaDB.byIndex('evaluations','group_period',[gid,String(period)]);
  const comps=await MiAulaDB.byIndex('studentComponents','group_period',[gid,String(period)]);
  const scheme=await getScheme(gid,period);
  const principalType=scheme.principal_type||'project';

  const gByStudent=new Map(),eByStudent=new Map(),cByStudent=new Map(comps.map(c=>[c.student_id,c]));
  for(const g of grades){
    if(!gByStudent.has(g.student_id))gByStudent.set(g.student_id,[]);
    gByStudent.get(g.student_id).push(g);
  }
  for(const e of evals){
    if(!eByStudent.has(e.student_id))eByStudent.set(e.student_id,[]);
    eByStudent.get(e.student_id).push(e);
  }

  const actMap=new Map(activities.map(a=>[a.id,a])),rows=[];
  for(const s of students){
    let workTotal=0,workW=0,projectTotal=0,projectW=0,examTotal=0,examW=0;
    for(const g of gByStudent.get(s.id)||[]){
      if(g.score==null)continue;
      const a=actMap.get(g.activity_id);
      if(!a||+a.max_score<=0||+a.weight<=0)continue;
      const normalized=+g.score*10/+a.max_score,w=+a.weight||1,type=String(a.activity_type||'').trim().toLowerCase();
      if(type==='proyecto'){projectTotal+=normalized*w;projectW+=w;}
      else if(type==='examen'){examTotal+=normalized*w;examW+=w;}
      else{workTotal+=normalized*w;workW+=w;}
    }

    if(principalType==='project'){
      for(const e of eByStudent.get(s.id)||[]){
        if(e.grade!=null){projectTotal+=+e.grade;projectW+=1;}
      }
    }

    const comp=cByStudent.get(s.id);
    const work=workW?workTotal/workW:null;
    let principal=null;
    if(principalType==='exam'){
      principal=comp?.exam_score??(examW?examTotal/examW:null);
    }else{
      principal=projectW?projectTotal/projectW:null;
    }
    const values=comp?.values_score??null,attitudes=comp?.attitudes_score??null;

    let complete=true,final=0;
    for(const [score,pct] of [[work,+scheme.work_pct],[principal,+scheme.project_pct],[values,+scheme.values_pct],[attitudes,+scheme.attitudes_pct]]){
      if(pct>0){
        if(score==null)complete=false;
        else final+=+score*pct/100;
      }
    }
    rows.push({
      ...s,name:studentLabel(s),
      work_avg:work==null?null:+work.toFixed(2),
      principal_avg:principal==null?null:+principal.toFixed(2),
      project_avg:principalType==='project'&&principal!=null?+principal.toFixed(2):null,
      exam_score:principalType==='exam'&&principal!=null?+principal.toFixed(2):(comp?.exam_score??null),
      values_score:values,attitudes_score:attitudes,
      final_grade:complete?+final.toFixed(2):null,complete,
      notes:comp?.notes||''
    });
  }
  const finals=rows.filter(r=>r.final_grade!=null).map(r=>r.final_grade);
  return {period:String(period),scheme,students:rows,group_average:finals.length?finals.reduce((a,b)=>a+b,0)/finals.length:null};
}

function schemeNumbers(){
  return {
    work:+$('#workPct').value||0,
    project:+$('#projectPct').value||0,
    values:+$('#valuesPct').value||0,
    attitudes:+$('#attitudesPct').value||0
  };
}
function selectedPrincipalType(){
  return $('#principalExamBtn')?.classList.contains('active')?'exam':'project';
}
function setPrincipalSelector(type,locked=false){
  const project=$('#principalProjectBtn'),exam=$('#principalExamBtn');
  if(project){project.classList.toggle('active',type!=='exam');project.disabled=locked;}
  if(exam){exam.classList.toggle('active',type==='exam');exam.disabled=locked;}
  const name=principalLabel(type);
  if($('#principalPctLabel')) $('#principalPctLabel').textContent=name;
  if($('#gradingPrincipalLabel')) $('#gradingPrincipalLabel').textContent=name;
  if($('#principalModeNote')) $('#principalModeNote').textContent=locked?`${name} quedó definido para este parcial. Podrás cambiarlo al iniciar el siguiente parcial.`:'Elige Proyecto o Examen antes de guardar el esquema del parcial.';
  setEvaluationNavLabel(type);
}
function updateSchemeUI(){
  const s=schemeNumbers(),total=s.work+s.project+s.values+s.attitudes;
  $('#schemeTotal').textContent=total+'%';
  $('#schemeTotal').parentElement.classList.toggle('bad',total!==100);
}
['#workPct','#projectPct','#valuesPct','#attitudesPct'].forEach(id=>$(id).oninput=updateSchemeUI);
$('#principalProjectBtn').onclick=()=>{if(!$('#principalProjectBtn').disabled)setPrincipalSelector('project',false);};
$('#principalExamBtn').onclick=()=>{if(!$('#principalExamBtn').disabled)setPrincipalSelector('exam',false);};

if($('#loadGrading'))$('#loadGrading').onclick=loadGrading;
$('#gradingGroup').onchange=async()=>{const gid=+$('#gradingGroup').value;if(gid&&$('#evalGroup'))$('#evalGroup').value=String(gid);await loadGrading();await syncGroupPeriodIndicators(gid);};

async function loadGrading(){
  const gid=+$('#gradingGroup').value;
  if(!gid){
    $('#gradingTable').innerHTML='<div class="empty-state">Selecciona un grupo.</div>';
    if($('#gradingPeriodBadge'))$('#gradingPeriodBadge').textContent='Selecciona un grupo';
    return;
  }
  const g=await getGroupState(gid),period=String(g.current_period||1);
  gradingData=await computeGroupGrading(gid,period);
  const s=gradingData.scheme;
  $('#workPct').value=s.work_pct;
  $('#projectPct').value=s.project_pct;
  $('#valuesPct').value=s.values_pct;
  $('#attitudesPct').value=s.attitudes_pct;
  setPrincipalSelector(s.principal_type||'project',!!s.mode_locked);
  updateSchemeUI();
  $('#gradingGroupAverage').textContent=gradingData.group_average==null?'—':gradingData.group_average.toFixed(2);
  if($('#gradingPeriodBadge'))$('#gradingPeriodBadge').textContent=g.course_closed?`Parcial ${period} de ${totalPeriods(g)} cerrado · ciclo concluido`:`Parcial ${period} de ${totalPeriods(g)} · en curso`;
  if($('#currentPartialNumber'))$('#currentPartialNumber').textContent=period;
  renderGradingTable();
  await syncGroupPeriodIndicators(gid);
}

function localFinal(row){
  const s=schemeNumbers();
  const pairs=[[row.work_avg,s.work],[row.principal_avg,s.project],[row.values_score,s.values],[row.attitudes_score,s.attitudes]];
  const total=s.work+s.project+s.values+s.attitudes;
  if(total!==100)return null;
  let out=0;
  for(const [v,p] of pairs){
    if(p>0&&v==null)return null;
    if(v!=null)out+=+v*p/100;
  }
  return +out.toFixed(2);
}

function renderGradingTable(){
  if(!gradingData)return;
  const principal=principalLabel(gradingData.scheme.principal_type||'project');
  $('#gradingTable').className='';
  $('#gradingTable').innerHTML=`<div class="table-wrap"><table><thead><tr><th>No.</th><th>Alumno</th><th>Trabajos</th><th>${principal}</th><th>Valores</th><th>Actitudes</th><th>Final</th></tr></thead><tbody>${gradingData.students.map((s,i)=>`<tr><td>${s.list_number??''}</td><td><strong>${escapeHtml(s.name)}</strong></td><td><span class="auto-score">${fmtNum(s.work_avg)}</span></td><td><span class="auto-score">${fmtNum(s.principal_avg)}</span></td><td><input data-comp="values" data-index="${i}" type="number" min="0" max="10" step="0.1" value="${s.values_score??''}"></td><td><input data-comp="attitudes" data-index="${i}" type="number" min="0" max="10" step="0.1" value="${s.attitudes_score??''}"></td><td id="final-${i}">${localFinal(s)==null?'<span class="pending-score">Pendiente</span>':`<span class="final-score">${localFinal(s).toFixed(2)}</span>`}</td></tr>`).join('')}</tbody></table></div>`;
  $$('#gradingTable input[data-comp]').forEach(inp=>inp.oninput=e=>{
    const i=+e.target.dataset.index,key=e.target.dataset.comp+'_score';
    gradingData.students[i][key]=e.target.value===''?null:+e.target.value;
    updateFinalCell(i);
  });
  $('#saveComponents').classList.remove('hidden');
}
function updateFinalCell(i){
  const v=localFinal(gradingData.students[i]);
  $(`#final-${i}`).innerHTML=v==null?'<span class="pending-score">Pendiente</span>':`<span class="final-score">${v.toFixed(2)}</span>`;
}
function updateAllFinalCells(){gradingData?.students.forEach((_,i)=>updateFinalCell(i));}

$('#schemeForm').onsubmit=async e=>{
  e.preventDefault();
  const gid=+$('#gradingGroup').value;
  if(!gid){toast('Selecciona un grupo',true);return;}
  const g=await getGroupState(gid);
  if(g.course_closed){toast(`Este grupo ya tiene sus ${totalPeriods(g)} parciales cerrados.`,true);return;}
  const p=String(g.current_period||1),nums=schemeNumbers(),total=nums.work+nums.project+nums.values+nums.attitudes;
  if(total!==100){toast('Los porcentajes deben sumar exactamente 100%.',true);return;}
  const old=await getScheme(gid,p),type=selectedPrincipalType();
  if(old.mode_locked && old.principal_type!==type){
    toast(`Este parcial ya fue definido como ${principalLabel(old.principal_type)}.`,true);return;
  }
  await MiAulaDB.put('gradingSchemes',{
    ...old,key:`${gid}:${p}`,group_id:gid,period:p,
    work_pct:nums.work,project_pct:nums.project,values_pct:nums.values,attitudes_pct:nums.attitudes,
    principal_type:type,mode_locked:true,updated_at:new Date().toISOString()
  });
  toast(`${principalLabel(type)} definido para el Parcial ${p}`);
  await loadGrading();
  if($('#evalGroup'))$('#evalGroup').value=String(gid);
  await loadPrincipalWorkspace();
};

$('#saveComponents').onclick=async()=>{
  const gid=+$('#gradingGroup').value;
  if(!gid||!gradingData)return;
  const p=gradingData.period;
  for(const s of gradingData.students){
    const key=`${gid}:${p}:${s.id}`;
    const old=await MiAulaDB.get('studentComponents',key);
    await MiAulaDB.put('studentComponents',{
      ...(old||{}),key,group_id:gid,period:String(p),student_id:s.id,
      values_score:s.values_score==null?null:+s.values_score,
      attitudes_score:s.attitudes_score==null?null:+s.attitudes_score,
      exam_score:old?.exam_score??s.exam_score??null,
      notes:s.notes||'',updated_at:new Date().toISOString()
    });
  }
  toast('Valores y actitudes guardados');
  await loadGrading();
};
$('#fillValues10').onclick=()=>{if(!gradingData)return;gradingData.students.forEach(s=>s.values_score=10);renderGradingTable();};
$('#fillAttitudes10').onclick=()=>{if(!gradingData)return;gradingData.students.forEach(s=>s.attitudes_score=10);renderGradingTable();};

$('#closePeriodBtn').onclick=async()=>{
  const gid=+$('#gradingGroup').value;
  if(!gid){toast('Selecciona un grupo',true);return;}
  const g=await getGroupState(gid),p=+g.current_period||1,total=totalPeriods(g);
  if(g.course_closed){toast(`Los ${total} parciales ya están cerrados.`,true);return;}
  const next=p<total?p+1:null;
  const msg=next
    ?`¿Cerrar el Parcial ${p} e iniciar el Parcial ${next}?\n\nLas actividades y el Proyecto/Examen del parcial actual dejarán de mostrarse en el área activa, pero NO se borrarán. Las rúbricas y listas de cotejo permanecerán disponibles.`
    :`¿Cerrar el Parcial ${p}?\n\nSe conservará todo el historial y el banco de rúbricas/listas de cotejo. El grupo quedará marcado como ciclo concluido.`;
  if(!confirm(msg))return;
  g.closed_periods=[...new Set([...(g.closed_periods||[]),p])].sort((a,b)=>a-b);
  if(next){g.current_period=next;g.course_closed=false;}else{g.course_closed=true;}
  g.last_period_closed_at=new Date().toISOString();
  await MiAulaDB.put('groups',g);
  $('#gradePanel').classList.add('hidden');
  toast(next?`Parcial ${p} cerrado · Parcial ${next} iniciado`:`Parcial ${p} cerrado`);
  await refreshGroups();
  $('#gradingGroup').value=String(gid);
  $('#activityGroup').value=String(gid);
  $('#activityFilter').value=String(gid);
  $('#evalGroup').value=String(gid);
  await loadGrading();
  await loadActivities();
  await loadPrincipalWorkspace();
  await loadSummary();
};


// -------------------- RÚBRICAS / EVALUACIONES --------------------
function addCriterion(name=''){
  const type=$('#instrumentType').value,d=document.createElement('div');d.className='criterion-row';
  d.innerHTML=`<input class="crit-name" placeholder="Ej. Investigación" value="${escapeHtml(name)}"><input class="crit-max" type="number" min="1" max="10" value="${type==='rubric'?4:1}" ${type==='checklist'?'disabled':''}><button type="button" class="icon-btn">×</button>`;
  d.querySelector('button').onclick=()=>d.remove();$('#criteriaRows').appendChild(d);
}
$('#addCriterion').onclick=()=>addCriterion();
$('#instrumentType').onchange=()=>{$$('.crit-max').forEach(x=>{x.value=$('#instrumentType').value==='rubric'?4:1;x.disabled=$('#instrumentType').value==='checklist';});};
$('#instrumentForm').onsubmit=async e=>{
  e.preventDefault();const criteria=$$('.criterion-row').map((r,i)=>({id:'c'+(i+1),name:r.querySelector('.crit-name').value.trim(),max:+r.querySelector('.crit-max').value||1})).filter(c=>c.name);
  if(!criteria.length){toast('Agrega al menos un criterio',true);return;}
  await MiAulaDB.add('instruments',{name:$('#instrumentName').value.trim(),instrument_type:$('#instrumentType').value,criteria,convert_to_grade:$('#convertGrade').checked,created_at:new Date().toISOString()});
  $('#instrumentName').value='';$('#criteriaRows').innerHTML='';addCriterion();await loadInstruments();toast('Instrumento guardado');
};
async function loadInstruments(){
  instruments=(await MiAulaDB.all('instruments')).sort((a,b)=>b.id-a.id);
  $('#instrumentCards').innerHTML=instruments.length?instruments.map(i=>`<div class="instrument-card"><div><strong>${escapeHtml(i.name)}</strong><br><small>${i.instrument_type==='rubric'?'Rúbrica':'Lista de cotejo'} · ${i.criteria.length} criterios · ${i.convert_to_grade?'0–10':'Evidencia'}</small></div><button class="btn small danger" onclick="deleteInstrument(${i.id})">Eliminar</button></div>`).join(''):'<div class="empty-state">Crea tu primera rúbrica o lista de cotejo.</div>';
  $('#evalInstrument').innerHTML='<option value="">Seleccionar…</option>'+instruments.map(i=>`<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
}
window.deleteInstrument=async id=>{
  const used=await MiAulaDB.byIndex('evaluations','instrument_id',id);
  if(used.length){toast('No puede eliminarse porque ya tiene evaluaciones guardadas.',true);return;}
  if(!confirm('¿Eliminar este instrumento del banco?'))return;
  await MiAulaDB.remove('instruments',id);await loadInstruments();toast('Instrumento eliminado');
};

$('#evalGroup').onchange=loadPrincipalWorkspace;
$('#evalInstrument').onchange=renderEvalCriteria;

async function loadPrincipalWorkspace(){
  const gid=+$('#evalGroup').value;
  if(!gid){
    setEvaluationNavLabel('project');
    $('#projectWorkspace')?.classList.remove('hidden');
    $('#examWorkspace')?.classList.add('hidden');
    if($('#evalStudents')){$('#evalStudents').className='student-picker empty-state';$('#evalStudents').textContent='Selecciona un grupo.';}
    if($('#examGradeList'))$('#examGradeList').innerHTML='<div class="empty-state">Selecciona un grupo.</div>';
    if($('#evaluationPeriodBadge'))$('#evaluationPeriodBadge').textContent='Selecciona un grupo';
    return;
  }
  const g=await getGroupState(gid),p=String(g.current_period||1),scheme=await getScheme(gid,p),type=scheme.principal_type||'project';
  setEvaluationNavLabel(type);
  if($('#evaluationTitle'))$('#evaluationTitle').textContent=principalLabel(type);
  if($('#evaluationPeriodBadge'))$('#evaluationPeriodBadge').textContent=g.course_closed?`Parcial ${p} de ${totalPeriods(g)} cerrado · ciclo concluido`:`Parcial ${p} de ${totalPeriods(g)} · en curso`;
  $('#projectWorkspace')?.classList.toggle('hidden',type==='exam');
  $('#examWorkspace')?.classList.toggle('hidden',type!=='exam');
  $('#projectHistoryPanel')?.classList.toggle('hidden',type==='exam');

  if(g.course_closed){
    if($('#projectWorkspace'))$('#projectWorkspace').classList.add('hidden');
    if($('#examWorkspace'))$('#examWorkspace').classList.add('hidden');
    $('#projectHistoryPanel')?.classList.add('hidden');
    if($('#closedPrincipalNotice')){$('#closedPrincipalNotice').classList.remove('hidden');$('#closedPrincipalNotice').textContent=`Los ${totalPeriods(g)} parciales están cerrados. El banco de rúbricas y listas de cotejo permanece disponible.`;}
    return;
  }
  $('#closedPrincipalNotice')?.classList.add('hidden');

  if(type==='exam'){
    await loadExamScores(gid,p);
  }else{
    await loadEvalStudents(gid);
    await loadEvalHistory(gid,p);
  }
  await syncGroupPeriodIndicators(gid);
}

async function loadEvalStudents(gid=+$('#evalGroup').value){
  if(!gid){
    $('#evalStudents').className='student-picker empty-state';
    $('#evalStudents').textContent='Selecciona un grupo.';
    return;
  }
  const s=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  $('#evalStudents').className='student-picker';
  $('#evalStudents').innerHTML=s.map(x=>`<label class="student-pick"><input type="checkbox" value="${x.id}"><span><strong>${x.list_number??'—'}</strong> · ${escapeHtml(studentLabel(x))}</span></label>`).join('');
}

function renderEvalCriteria(){
  const inst=instruments.find(i=>i.id===+$('#evalInstrument').value);
  if(!inst){$('#evalCriteria').className='empty-state';$('#evalCriteria').textContent='Selecciona un instrumento.';return;}
  $('#evalCriteria').className='';
  $('#evalCriteria').innerHTML=inst.criteria.map(c=>inst.instrument_type==='rubric'
    ?`<div class="criterion-eval" data-cid="${c.id}" data-type="rubric"><strong>${escapeHtml(c.name)}</strong><div class="level-buttons">${Array.from({length:c.max},(_,k)=>k+1).map(v=>`<button type="button" data-value="${v}" onclick="pickLevel(this)">${v}</button>`).join('')}</div></div>`
    :`<div class="criterion-eval" data-cid="${c.id}" data-type="checklist"><strong>${escapeHtml(c.name)}</strong><div class="level-buttons"><button type="button" data-value="0" onclick="pickLevel(this)">No</button><button type="button" data-value="1" onclick="pickLevel(this)">Sí</button></div></div>`
  ).join('');
}
window.pickLevel=el=>{
  el.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
};

$('#saveEvaluation').onclick=async()=>{
  const gid=+$('#evalGroup').value;
  if(!gid){toast('Selecciona un grupo',true);return;}
  const g=await getGroupState(gid),p=String(g.current_period||1),scheme=await getScheme(gid,p);
  if((scheme.principal_type||'project')!=='project'){toast('Este parcial está configurado como Examen.',true);return;}
  const iid=+$('#evalInstrument').value,title=$('#evalTitle').value.trim(),ids=$$('#evalStudents input:checked').map(x=>+x.value),inst=instruments.find(i=>i.id===iid);
  if(!iid||!title||!ids.length){toast('Selecciona instrumento, título y al menos un alumno',true);return;}
  if(!scheme.mode_locked){scheme.principal_type='project';scheme.mode_locked=true;scheme.updated_at=new Date().toISOString();await MiAulaDB.put('gradingSchemes',scheme);}
  const details={};let raw=0,max=0,incomplete=false;
  $$('#evalCriteria .criterion-eval').forEach(c=>{
    const b=c.querySelector('button.active');
    if(!b){incomplete=true;return;}
    const val=c.dataset.type==='checklist'?(b.dataset.value==='1'?1:0):+b.dataset.value;
    details[c.dataset.cid]=val;raw+=val;
    const crit=inst.criteria.find(x=>x.id===c.dataset.cid);
    max+=inst.instrument_type==='checklist'?1:+crit.max;
  });
  if(incomplete){toast('Evalúa todos los criterios',true);return;}
  const grade=inst.convert_to_grade&&max?Math.round(raw/max*1000)/100:null;
  for(const sid of ids){
    await MiAulaDB.add('evaluations',{
      group_id:gid,instrument_id:iid,title,student_id:sid,team_name:$('#evalTeam').value.trim(),
      raw_score:raw,grade,details,notes:$('#evalNotes').value.trim(),
      evaluation_date:$('#evalDate').value,period:p,created_at:new Date().toISOString()
    });
  }
  toast('Proyecto guardado'+(grade!=null?` · ${grade.toFixed(2)}`:''));
  $$('#evalStudents input').forEach(x=>x.checked=false);
  $('#evalNotes').value='';
  await loadEvalHistory(gid,p);
  await loadSummary();
  if(+$('#gradingGroup').value===gid)await loadGrading();
};

async function loadEvalHistory(gid=+$('#evalGroup').value,period=null){
  if(!gid){$('#evalHistory').innerHTML='<div class="empty-state">Selecciona un grupo.</div>';return;}
  const g=await getGroupState(gid),p=String(period||g.current_period||1);
  const evals=(await MiAulaDB.byIndex('evaluations','group_period',[gid,p])).sort((a,b)=>b.id-a.id);
  const students=await MiAulaDB.groupStudents(gid,{includeInactive:true}),sm=new Map(students.map(s=>[s.id,s])),im=new Map(instruments.map(i=>[i.id,i]));
  $('#evalHistory').innerHTML=evals.length
    ?`<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Alumno</th><th>Proyecto</th><th>Instrumento</th><th>Calif.</th><th></th></tr></thead><tbody>${evals.slice(0,100).map(e=>`<tr><td>${e.evaluation_date||''}</td><td>${escapeHtml(studentLabel(sm.get(e.student_id)||{}))}</td><td>${escapeHtml(e.title)}</td><td>${escapeHtml(im.get(e.instrument_id)?.name||'')}</td><td><strong>${e.grade??''}</strong></td><td><button class="btn small danger" onclick="deleteEvaluation(${e.id})">Eliminar</button></td></tr>`).join('')}</tbody></table></div>`
    :`<div class="empty-state">No hay proyectos evaluados en el Parcial ${p}.</div>`;
}
window.deleteEvaluation=async id=>{
  if(!confirm('¿Eliminar esta evaluación de proyecto?'))return;
  const e=await MiAulaDB.get('evaluations',id);
  await MiAulaDB.remove('evaluations',id);
  await loadEvalHistory(e?.group_id,e?.period);
  await loadSummary();
  toast('Evaluación eliminada');
};

let examData=[];
async function loadExamScores(gid,period){
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const comps=await MiAulaDB.byIndex('studentComponents','group_period',[gid,String(period)]);
  const cm=new Map(comps.map(c=>[c.student_id,c]));
  examData=students.map(s=>({
    student_id:s.id,list_number:s.list_number,name:studentLabel(s),
    score:cm.get(s.id)?.exam_score??null
  }));
  renderExamScores();
}
function renderExamScores(){
  if(!$('#examGradeList'))return;
  $('#examGradeList').innerHTML=examData.length
    ?examData.map((s,i)=>`<div class="grade-row"><strong>${s.list_number??'—'}</strong><div>${escapeHtml(s.name)}</div><input class="exam-score-input" data-index="${i}" type="number" min="0" max="10" step="0.1" value="${s.score??''}"><div class="quick-score">${[10,9,8,7,6,5].map(v=>`<button onclick="quickExam(${i},${v})">${v}</button>`).join('')}<button onclick="quickExam(${i},null)">NP</button></div></div>`).join('')
    :'<div class="empty-state">No hay alumnos activos.</div>';
  $$('.exam-score-input').forEach(inp=>inp.oninput=e=>{examData[+e.target.dataset.index].score=e.target.value===''?null:+e.target.value;});
}
window.quickExam=(i,v)=>{examData[i].score=v;renderExamScores();};
$('#fillExam10').onclick=()=>{examData.forEach(x=>x.score=10);renderExamScores();};
$('#saveExamScores').onclick=async()=>{
  const gid=+$('#evalGroup').value;
  if(!gid){toast('Selecciona un grupo',true);return;}
  const g=await getGroupState(gid),p=String(g.current_period||1),scheme=await getScheme(gid,p);
  if((scheme.principal_type||'project')!=='exam'){toast('Este parcial está configurado como Proyecto.',true);return;}
  if(!scheme.mode_locked){scheme.principal_type='exam';scheme.mode_locked=true;scheme.updated_at=new Date().toISOString();await MiAulaDB.put('gradingSchemes',scheme);}
  for(const s of examData){
    const key=`${gid}:${p}:${s.student_id}`,old=await MiAulaDB.get('studentComponents',key);
    await MiAulaDB.put('studentComponents',{
      ...(old||{}),key,group_id:gid,period:p,student_id:s.student_id,
      values_score:old?.values_score??null,attitudes_score:old?.attitudes_score??null,
      exam_score:s.score==null?null:+s.score,notes:old?.notes||'',updated_at:new Date().toISOString()
    });
  }
  toast(`Examen del Parcial ${p} guardado`);
  if(+$('#gradingGroup').value===gid)await loadGrading();
  await loadSummary();
};


// -------------------- EXCEL / RESPALDO --------------------
function attendanceTotals(records){
  const out={P:0,F:0,R:0,J:0,total:0,attended:0};
  for(const a of records){const h=+a.class_hours||1;out[a.status]=(out[a.status]||0)+h;out.total+=h;if(a.status!=='F')out.attended+=h;}
  out.pct=out.total?Math.round(out.attended*1000/out.total)/10:null;return out;
}
async function buildWorkbook(gid){
  const g=await MiAulaDB.get('groups',gid);if(!g)throw new Error('Grupo no encontrado');
  const allStudents=await MiAulaDB.groupStudents(gid,{includeInactive:true}),students=allStudents.filter(s=>s.active!==0).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999)),inactive=allStudents.filter(s=>s.active===0);
  const attendance=(await MiAulaDB.byIndex('attendance','group_id',gid)).sort((a,b)=>a.attendance_date.localeCompare(b.attendance_date)),activities=(await MiAulaDB.byIndex('activities','group_id',gid)).sort((a,b)=>String(a.period).localeCompare(String(b.period))||String(a.activity_date).localeCompare(String(b.activity_date)));
  const allGrades=await MiAulaDB.all('grades'),actIds=new Set(activities.map(a=>a.id)),grades=allGrades.filter(x=>actIds.has(x.activity_id)),evals=(await MiAulaDB.byIndex('evaluations','group_id',gid)).sort((a,b)=>String(a.period).localeCompare(String(b.period))||String(a.evaluation_date).localeCompare(String(b.evaluation_date))),insts=await MiAulaDB.all('instruments');
  const im=new Map(insts.map(i=>[i.id,i])),sm=new Map(allStudents.map(s=>[s.id,s])),am=new Map(activities.map(a=>[a.id,a])),gradeKey=new Map(grades.map(gr=>[`${gr.activity_id}:${gr.student_id}`,gr]));
  const dates=[...new Set(attendance.map(a=>a.attendance_date))].sort(),attKey=new Map(attendance.map(a=>[`${a.student_id}:${a.attendance_date}`,a]));
  const periods=periodNumbers(g);const grading={};for(const p of periods)grading[p]=await computeGroupGrading(gid,p);
  const avgFinal=p=>{const v=grading[p].students.filter(x=>x.final_grade!=null).map(x=>x.final_grade);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
  const groupAttendance=attendanceTotals(attendance.filter(a=>sm.get(a.student_id)?.active!==0));
  const classBlocks=new Map();for(const a of attendance){const k=a.attendance_date;classBlocks.set(k,Math.max(classBlocks.get(k)||0,+a.class_hours||1));}
  const classHours=[...classBlocks.values()].reduce((a,b)=>a+b,0);
  const resumen=[['Indicador','Valor'],['Grupo',g.name],['Grado / semestre',g.grade||''],['Disciplina',g.discipline||''],['Ciclo escolar',g.school_year||''],['Parciales configurados',totalPeriods(g)],['Alumnos activos',students.length],['Alumnos dados de baja',inactive.length],['Horas de clase registradas',classHours],['Horas-presente',groupAttendance.P],['Horas-falta',groupAttendance.F],['Horas-retardo',groupAttendance.R],['Horas-justificadas',groupAttendance.J],['Asistencia ponderada por hora %',groupAttendance.pct],['Parcial activo',g.current_period||1],['Parciales cerrados',(g.closed_periods||[]).join(', ')||'Ninguno'],...periods.map(p=>[`Promedio final Parcial ${p}`,avgFinal(p)]),['Generado',new Date().toLocaleString('es-MX')]];
  const esquema=[['Parcial','Componente principal','Trabajos %','Principal %','Valores %','Actitudes %','Total %','Estado']];for(const p of periods){const s=grading[p].scheme;esquema.push([p,principalLabel(s.principal_type||'project'),s.work_pct,s.project_pct,s.values_pct,s.attitudes_pct,+s.work_pct+ +s.project_pct+ +s.values_pct+ +s.attitudes_pct,(g.closed_periods||[]).includes(+p)?'Cerrado':(+g.current_period===+p&&!g.course_closed?'En curso':'Pendiente')]);}
  const trim=[['No.','Código','Alumno','Parcial','Trabajos','Trabajos %','Componente principal','Tipo principal','Principal %','Valores','Valores %','Actitudes','Actitudes %','Final','Estado','Observación']];for(const p of periods){const sc=grading[p].scheme;for(const s of grading[p].students)trim.push([s.list_number,s.student_code,s.name,p,s.work_avg,sc.work_pct,s.principal_avg,principalLabel(sc.principal_type||'project'),sc.project_pct,s.values_score,sc.values_pct,s.attitudes_score,sc.attitudes_pct,s.final_grade,s.complete?'Completo':'Pendiente',s.notes||'']);}
  const conc=[['No.','Código','Alumno','Grado','Asistencia %','Hrs P','Hrs F','Hrs R','Hrs J',...activities.map(a=>`${a.title} [P${a.period}]`),'Prom. actividades',...periods.map(p=>`P${p}`)]];
  for(const s of students){
    const sa=attendance.filter(a=>a.student_id===s.id),at=attendanceTotals(sa),normalized=[],row=[s.list_number,s.student_code,studentLabel(s),s.grade||'',at.pct,at.P,at.F,at.R,at.J];
    for(const a of activities){const gr=gradeKey.get(`${a.id}:${s.id}`),v=gr?.score??null;row.push(v);if(v!=null&&+a.max_score>0)normalized.push(+v*10/+a.max_score);}
    row.push(normalized.length?Math.round(100*normalized.reduce((x,y)=>x+y,0)/normalized.length)/100:null,...periods.map(p=>grading[p].students.find(x=>x.id===s.id)?.final_grade??null));conc.push(row);
  }
  const asist=[['No.','Alumno',...dates.map(d=>`${d} (registro)`),'Hrs P','Hrs F','Hrs R','Hrs J','Total hrs','Asistencia %']];
  for(const s of students){const sa=attendance.filter(a=>a.student_id===s.id),at=attendanceTotals(sa);asist.push([s.list_number,studentLabel(s),...dates.map(d=>{const a=attKey.get(`${s.id}:${d}`);return a?`${a.status} ×${a.class_hours||1}`:'';}),at.P,at.F,at.R,at.J,at.total,at.pct]);}
  const hourHeaders=['No.','Alumno'];for(const d of dates){const hrs=classBlocks.get(d)||1;for(let h=1;h<=hrs;h++)hourHeaders.push(`${d} H${h}`);}const asistHoras=[hourHeaders];
  for(const s of students){const row=[s.list_number,studentLabel(s)];for(const d of dates){const hrs=classBlocks.get(d)||1,a=attKey.get(`${s.id}:${d}`);for(let h=1;h<=hrs;h++)row.push(a?.status||'');}asistHoras.push(row);}
  const acts=[['Actividad','Tipo','Parcial','Fecha','Puntaje máximo','Peso','Capturadas','Pendientes']];for(const a of activities){const count=grades.filter(gr=>gr.activity_id===a.id&&gr.score!=null&&sm.get(gr.student_id)?.active!==0).length;acts.push([a.title,a.activity_type,a.period,a.activity_date,a.max_score,a.weight,count,Math.max(students.length-count,0)]);}
  const detail=[['No.','Alumno','Estatus','Actividad','Tipo','Parcial','Fecha','Calificación','Máximo','Equivalente 0-10','Observación']];for(const gr of grades){const a=am.get(gr.activity_id),s=sm.get(gr.student_id);if(!a||!s)continue;detail.push([s.list_number,studentLabel(s),s.active!==0?'Activo':'Baja',a.title,a.activity_type,a.period,a.activity_date,gr.score,a.max_score,gr.score==null?null:Math.round(+gr.score*1000/+a.max_score)/100,gr.notes||'']);}
  const evalSheet=[['Fecha','Parcial','Alumno','Estatus','Proyecto','Instrumento','Tipo','Equipo','Puntaje','Calificación','Observación']];for(const e of evals){const i=im.get(e.instrument_id),s=sm.get(e.student_id);evalSheet.push([e.evaluation_date,e.period,studentLabel(s||{}),s?.active!==0?'Activo':'Baja',e.title,i?.name||'',i?.instrument_type==='rubric'?'Rúbrica':'Lista de cotejo',e.team_name||'',e.raw_score,e.grade,e.notes||'']);}
  const obs=[['Alumno','Origen','Actividad/Evaluación','Observación']];for(const gr of grades){if(String(gr.notes||'').trim()){const a=am.get(gr.activity_id),s=sm.get(gr.student_id);obs.push([studentLabel(s||{}),'Actividad',a?.title||'',gr.notes]);}}for(const e of evals){if(String(e.notes||'').trim())obs.push([studentLabel(sm.get(e.student_id)||{}),'Evaluación',e.title,e.notes]);}for(const p of periods)for(const s of grading[p].students)if(String(s.notes||'').trim())obs.push([s.name,`Parcial ${p}`,'Valores y Actitudes',s.notes]);
  const bajas=[['Último No.','Código','Apellido paterno','Apellido materno','Nombre(s)','Nombre completo','Fecha de baja','Hrs P','Hrs F','Hrs R','Hrs J','Asistencia %']];for(const s of inactive){const at=attendanceTotals(attendance.filter(a=>a.student_id===s.id));bajas.push([s.former_list_number??s.list_number,s.student_code,s.paternal_last_name||'',s.maternal_last_name||'',s.given_names||'',studentLabel(s),s.withdrawn_at?new Date(s.withdrawn_at).toLocaleDateString('es-MX'):'',at.P,at.F,at.R,at.J,at.pct]);}
  const instrumentBank=[['Instrumento','Tipo','Convierte a 0-10','Criterios']];for(const i of insts){instrumentBank.push([i.name,i.instrument_type==='rubric'?'Rúbrica':'Lista de cotejo',i.convert_to_grade?'Sí':'No',(i.criteria||[]).map(c=>c.name).join(' · ')]);}
  return {sheets:[{name:'Resumen',rows:resumen},{name:'Esquemas',rows:esquema},{name:'Calificación parcial',rows:trim},{name:'Concentrado',rows:conc},{name:'Asistencia',rows:asist},{name:'Asistencia por horas',rows:asistHoras},{name:'Actividades',rows:acts},{name:'Detalle calificaciones',rows:detail},{name:'Proyectos',rows:evalSheet},{name:'Banco instrumentos',rows:instrumentBank},{name:'Observaciones',rows:obs},{name:'Bajas',rows:bajas}]};
}
$('#exportBtn').onclick=async()=>{
  const gid=+$('#exportGroup').value;if(!gid){toast('Selecciona un grupo',true);return;}
  try{toast('Generando Excel…');const g=await MiAulaDB.get('groups',gid),book=await buildWorkbook(gid),blob=XLSXLite.write(book),safe=String(g.name).replace(/[^A-Za-z0-9_-]+/g,'_');downloadBlob(blob,`MiAula_${safe}_${today}.xlsx`);toast('Excel generado');}catch(e){console.error(e);toast(e.message,true);}
};
$('#backupBtn').onclick=async()=>{const data=await MiAulaDB.exportBackup(),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});downloadBlob(blob,`MiAula_2.0_Respaldo_${new Date().toISOString().replace(/[:.]/g,'-')}.json`);toast('Respaldo generado');};
$('#restoreFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!confirm('Restaurar este respaldo reemplazará los datos actuales de la tablet. ¿Continuar?')){e.target.value='';return;}await MiAulaDB.restoreBackup(data);await refreshGroups();await loadInstruments();await loadSummary();toast('Respaldo restaurado correctamente');goView('dashboard');}catch(er){console.error(er);toast(er.message,true);}finally{e.target.value='';}};

window.addEventListener('error',e=>{console.error(e.error||e.message);const b=$('#fatalBanner');b.textContent='Error de interfaz: '+(e.message||'desconocido');b.classList.remove('hidden');});

init();
