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
let notebookData=null;
const notebookEdits={grades:new Map(),components:new Map()};
let notebookAutoSaveTimer=null;
let lastNotebookEdit=null;
let undoHideTimer=null;
let classMode=false;
let studentDrawerState={period:null,studentId:null};
let lastStudentQuickScore=null;

const dynamics={
  mode:'roulette',
  students:[],
  used:new Set(),
  rotation:0,
  spinning:false,
  teams:[],
  lastWinner:null,
  winnerRated:false,
  ratingBusy:false
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
function parseISODateLocal(value){
  const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return null;
  const d=new Date(+m[1],+m[2]-1,+m[3]);
  return Number.isNaN(d.getTime())?null:d;
}
function schoolDaysElapsed(activityDate,referenceDate=new Date()){
  const start=parseISODateLocal(activityDate);if(!start)return 0;
  const end=new Date(referenceDate.getFullYear(),referenceDate.getMonth(),referenceDate.getDate());
  if(end<=start)return 0;
  let count=0;
  const d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+1);
  while(d<=end){
    const day=d.getDay();
    if(day!==0&&day!==6)count++;
    d.setDate(d.getDate()+1);
  }
  return count;
}
function activityAvailableMax(activity,referenceDate=new Date()){
  const original=Number.isFinite(+activity?.max_score)?Math.max(0,+activity.max_score):10;
  const elapsed=schoolDaysElapsed(activity?.activity_date,referenceDate);
  return Math.max(0,+(original-elapsed).toFixed(2));
}
function activityMaxIndicator(activity){
  const available=activityAvailableMax(activity);
  return `<small class="activity-daily-max${available<=0?' zero':''}" title="Indicador según días hábiles transcurridos; no limita la calificación que captures.">Máx. ${fmtNum(available,1)}</small>`;
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

function formatBadExtras(n){n=+n||0;return n>0?`-${n}`:'0';}
function extraSummary(rows){
  let goodEarned=0,goodUsed=0,bad=0;
  for(const r of rows||[]){
    const pts=Math.max(0,+r.points||0);
    if(r.kind==='good')goodEarned+=pts;
    else if(r.kind==='use')goodUsed+=pts;
    else if(r.kind==='bad')bad+=pts;
  }
  return {goodEarned,goodUsed,goodAvailable:Math.max(0,goodEarned-goodUsed),bad};
}
async function getStudentExtraRows(groupId,studentId,period){
  return MiAulaDB.byIndex('extraPoints','group_student_period',[+groupId,+studentId,String(period)]);
}
async function getStudentExtraSummary(groupId,studentId,period){
  return extraSummary(await getStudentExtraRows(groupId,studentId,period));
}
async function addExtraRecord({groupId,studentId,period,kind,points=1,source='manual',activityId=null,note=''}){
  const n=Math.max(1,Math.floor(+points||1));
  return MiAulaDB.add('extraPoints',{group_id:+groupId,student_id:+studentId,period:String(period),kind,points:n,source,activity_id:activityId==null?null:+activityId,session_date:today,note:String(note||''),created_at:new Date().toISOString()});
}

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
  const moreLabel=$('#moreEvaluationLabel');
  if(moreLabel) moreLabel.textContent=principalLabel(type);
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
  dynamics.lastWinner=null;
  dynamics.winnerRated=false;
  dynamics.ratingBusy=false;
  const extraActions=$('#rouletteExtraActions');
  if(extraActions) extraActions.classList.add('hidden');
  if($('#rouletteExtraStatus')) $('#rouletteExtraStatus').textContent='';
  if($('#teamsResult')) $('#teamsResult').innerHTML='<div class="empty-state">Selecciona un grupo y crea los equipos.</div>';
  renderUsedStudents();
  drawWheel();
}

function goView(name){
  if(currentView==='dynamics' && name!=='dynamics'){ resetDynamicsSession(); exitRouletteFullscreen(); }
  if(currentView==='notebook' && name!=='notebook') closeStudentDrawer();
  currentView=name;
  const mainMenuBtn=$('#mainMenuBtn');
  if(mainMenuBtn) mainMenuBtn.classList.toggle('hidden',name==='dashboard');
  $$('.view').forEach(v=>v.classList.remove('active'));
  $('#view-'+name)?.classList.add('active');
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  $('#viewTitle').textContent={
    dashboard:'Inicio',groups:'Mis grupos',attendance:'Asistencia',dynamics:'Ruleta y equipos',
    activities:'Calificaciones',notebook:'Cuaderno digital',grading:'Parcial',evaluation:'Proyecto',more:'Administración'
  }[name]||name;
  updateAppNav();
  if(name==='dashboard') loadSummary();
  if(name==='activities') loadActivities();
  if(name==='notebook') loadNotebook();
  if(name==='grading') loadGrading();
  if(name==='evaluation'){loadInstruments().then(()=>loadPrincipalWorkspace());}
  if(name==='dynamics') loadDynamicsStudents(true);
  if(name==='more') loadAdminOverview();
  try{localStorage.setItem('miaula:lastView',name);}catch{}
}
window.goView=goView;

function openDynamicsMode(mode){
  goView('dynamics');
  setDynamicsMode(mode);
}
window.openDynamicsMode=openDynamicsMode;

$$('.nav-item').forEach(b=>b.onclick=()=>goView(b.dataset.view));
const mainMenuBtn=$('#mainMenuBtn');
if(mainMenuBtn) mainMenuBtn.onclick=()=>goView('dashboard');
$('#quickAttendance').onclick=()=>goView('attendance');

const fmtDate=new Intl.DateTimeFormat('es-MX',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
$('#todayLabel').textContent=fmtDate.format(new Date());
$('#attendanceDate').value=today;
$('#activityDate').value=today;
$('#evalDate').value=today;

if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  let swControllerChanged=false;
  navigator.serviceWorker.register('sw.js?v=2.3.0',{updateViaCache:'none'}).then(reg=>{
    reg.update().catch(()=>{});
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='visible')reg.update().catch(()=>{});
    });
  }).catch(()=>{});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(swControllerChanged)return;
    swControllerChanged=true;
    toast('MiAula se actualizó. La nueva versión quedará activa al volver a abrir la app.');
  });
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
  ['#importGroup','#attendanceGroup','#dynamicsGroup','#activityGroup','#activityFilter','#notebookGroup','#gradingGroup','#evalGroup','#exportGroup','#contextGroup'].forEach(id=>{
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
  if($('#contextGroup') && !$('#contextGroup').value && groups.length){
    let preferred=0;try{preferred=+localStorage.getItem('miaula:activeGroup')||0;}catch{}
    $('#contextGroup').value=String(groups.some(g=>+g.id===preferred)?preferred:groups[0].id);
  }
  const contextId=+($('#contextGroup')?.value||0);
  if(contextId) await setContextGroup(contextId,{propagate:true,refresh:false});
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
    cards.push(`<div class="group-card"><div class="grade">${escapeHtml(g.name)}</div><div class="disc">${escapeHtml(g.discipline||'')}</div><div class="group-stats"><span>${gs.length} alumnos</span><span>${th?(ah*100/th).toFixed(0)+'%':'—'} asistencia</span></div><div class="group-period-chip">${status}</div><button class="btn small primary group-notebook-btn" onclick="openNotebook(${g.id})">Abrir cuaderno</button></div>`);
  }
  $('#dashboardGroups').innerHTML=cards.length?cards.join(''):'<div class="empty-state">Crea tu primer grupo o importa tu información anterior.</div>';
  await renderClassSnapshot();
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
    rows.push(`<tr><td><strong>${escapeHtml(g.name)}</strong></td><td>${escapeHtml(g.grade||'')}</td><td>${escapeHtml(g.discipline||'')}</td><td><span class="period-badge">${g.course_closed?'Cerrado':`P${+g.current_period||1}/${totalPeriods(g)}`}</span></td><td>${active}</td><td>${inactive}</td><td><div class="action-row"><button class="btn small primary" onclick="viewStudents(${g.id})">Alumnos</button><button class="btn small vivid-action" onclick="openNotebook(${g.id})">Cuaderno</button><button class="btn small subtle" onclick="editGroup(${g.id})">Editar</button><button class="btn small danger" onclick="archiveGroup(${g.id})">Archivar</button></div></td></tr>`);
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
$('#resetWheel').onclick=()=>{resetDynamicsSession();updateRouletteCounter();toast('Ruleta reiniciada');};
$('#spinWheel').onclick=spinWheel;
$('#fullscreenWheel').onclick=toggleRouletteFullscreen;
$('#rouletteGood').onclick=()=>recordRouletteExtra('good');
$('#rouletteBad').onclick=()=>recordRouletteExtra('bad');
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
  updateAppNav();
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
async function refreshWinnerExtraStatus(){
  const box=$('#rouletteExtraActions'),status=$('#rouletteExtraStatus'),goodBtn=$('#rouletteGood'),badBtn=$('#rouletteBad');
  const s=dynamics.lastWinner,gid=+$('#dynamicsGroup').value;
  if(!box||!status||!goodBtn||!badBtn||!s||!gid){if(box)box.classList.add('hidden');return;}
  const g=await getGroupState(gid),period=String(g?.current_period||1);
  const rows=await getStudentExtraRows(gid,s.id,period);
  const summary=extraSummary(rows);
  const rouletteGoodToday=rows.filter(r=>r.kind==='good'&&r.source==='roulette'&&r.session_date===today).reduce((n,r)=>n+(+r.points||0),0);
  box.classList.remove('hidden');
  goodBtn.disabled=dynamics.winnerRated||dynamics.ratingBusy||rouletteGoodToday>=2;
  badBtn.disabled=dynamics.winnerRated||dynamics.ratingBusy;
  goodBtn.textContent=rouletteGoodToday>=2?'Extra + · límite 2/2':'Extra +';
  if(dynamics.winnerRated){
    status.textContent=`Participación registrada · Saldo: +${summary.goodAvailable} / ${formatBadExtras(summary.bad)}`;
  }else if(rouletteGoodToday>=2){
    status.textContent=`Ya tiene +2 de ruleta hoy. Puedes registrar Extra − o continuar.`;
  }else{
    status.textContent=`Disponibles en el Parcial ${period}: +${summary.goodAvailable} · Malos: ${formatBadExtras(summary.bad)} · Ruleta hoy: +${rouletteGoodToday}/2`;
  }
}
async function recordRouletteExtra(kind){
  if(dynamics.ratingBusy||dynamics.winnerRated||!dynamics.lastWinner)return;
  const gid=+$('#dynamicsGroup').value;if(!gid)return;
  dynamics.ratingBusy=true;
  try{
    const g=await getGroupState(gid),period=String(g?.current_period||1),s=dynamics.lastWinner;
    if(kind==='good'){
      const rows=await getStudentExtraRows(gid,s.id,period);
      const usedToday=rows.filter(r=>r.kind==='good'&&r.source==='roulette'&&r.session_date===today).reduce((n,r)=>n+(+r.points||0),0);
      if(usedToday>=2){toast('Este alumno ya alcanzó +2 puntos buenos de ruleta hoy.',true);dynamics.ratingBusy=false;await refreshWinnerExtraStatus();return;}
      await addExtraRecord({groupId:gid,studentId:s.id,period,kind:'good',points:1,source:'roulette',note:'Participación en ruleta'});
      toast(`+1 punto extra para ${studentLabel(s)}`);
    }else{
      await addExtraRecord({groupId:gid,studentId:s.id,period,kind:'bad',points:1,source:'roulette',note:'Participación en ruleta'});
      toast(`-1 punto extra para ${studentLabel(s)}`);
    }
    dynamics.winnerRated=true;
  }catch(e){console.error(e);toast(e.message||'No se pudo guardar el punto extra',true);}
  finally{dynamics.ratingBusy=false;await refreshWinnerExtraStatus();}
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
  dynamics.lastWinner=chosen;
  dynamics.winnerRated=false;
  $('#rouletteNumber').textContent=chosen.list_number??index+1;
  $('#rouletteName').textContent=studentLabel(chosen);
  await refreshWinnerExtraStatus();
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
    ?arr.map(a=>`<div class="activity-card"><div><strong>${escapeHtml(a.title)}</strong>${activityMaxIndicator(a)}<small>${escapeHtml(a.activity_type)} · Parcial ${a.period} · Fecha ${escapeHtml(a.activity_date||'Sin fecha')} · Puntaje original ${a.max_score} · Peso ${a.weight}</small></div><div class="action-row"><button class="btn small primary" onclick="openGrades(${a.id})">Calificar</button><button class="btn small subtle" onclick="editActivityDate(${a.id})">Editar fecha</button><button class="btn small danger" onclick="deleteActivity(${a.id})">Eliminar</button></div></div>`).join('')
    :`<div class="empty-state">Parcial ${p} limpio. Crea la primera actividad.</div>`;
  await syncGroupPeriodIndicators(gid);
}
window.openGrades=async aid=>{
  const activity=await MiAulaDB.get('activities',aid);if(!activity)return;
  activeActivity=activity;
  const students=(await MiAulaDB.groupStudents(activity.group_id,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const existing=await MiAulaDB.byIndex('grades','activity_id',aid),gm=new Map(existing.map(g=>[g.student_id,g]));
  gradeData=students.map(s=>({student_id:s.id,list_number:s.list_number,name:studentLabel(s),score:gm.get(s.id)?.score??null,status:gm.get(s.id)?.status||'',notes:gm.get(s.id)?.notes||''}));
  $('#gradePanel').classList.remove('hidden');$('#gradeTitle').textContent=`Calificar: ${activity.title}`;renderGrades();$('#gradePanel').scrollIntoView({behavior:'smooth'});
};
function renderGrades(){
  const max=+activeActivity.max_score,quick=[max,Math.max(max-1,0),Math.max(max-2,0),Math.max(max-3,0),'NP'];
  $('#gradeList').innerHTML=gradeData.map((s,i)=>`<div class="grade-row"><strong>${s.list_number??'—'}</strong><div>${escapeHtml(s.name)}</div><input type="text" inputmode="decimal" value="${s.score!=null?s.score:(String(s.status||'').toUpperCase()==='NP'?'NP':'')}" data-gi="${i}" class="grade-input"><div class="quick-score">${quick.map(q=>`<button onclick="quickGrade(${i},'${q}')">${q}</button>`).join('')}</div></div>`).join('');
  $$('.grade-input').forEach(inp=>inp.oninput=e=>{const i=+e.target.dataset.gi,p=notebookParseScore(e.target.value,max);gradeData[i].score=p.invalid?e.target.value:p.score;gradeData[i].status=p.invalid?'':p.status;});
}
window.quickGrade=(i,v)=>{gradeData[i].score=v==='NP'?null:+v;gradeData[i].status=v==='NP'?'NP':'';renderGrades();};
$('#fillMax').onclick=()=>{gradeData.forEach(x=>{x.score=+activeActivity.max_score;x.status='';});renderGrades();};
$('#saveGrades').onclick=async()=>{
  for(const it of gradeData){
    const old=await MiAulaDB.firstByIndex('grades','unique_key',[activeActivity.id,it.student_id]);
    const parsed=notebookParseScore(it.score==null?(it.status||''):it.score,+activeActivity.max_score);if(parsed.invalid){toast(`Calificación inválida para ${it.name}`,true);return;}const rec={...(old||{}),activity_id:activeActivity.id,student_id:it.student_id,score:parsed.score,status:it.status||parsed.status||'',notes:it.notes||''};
    if(old)await MiAulaDB.put('grades',rec);else await MiAulaDB.add('grades',rec);
  }
  toast('Calificaciones guardadas');await loadSummary();
};
window.editActivityDate=async id=>{
  const activity=await MiAulaDB.get('activities',+id);
  if(!activity){toast('Actividad no encontrada.',true);return;}
  const current=activity.activity_date||today;
  openModal('Editar fecha de actividad',`<form id="editActivityDateForm"><div class="date-edit-summary"><strong>${escapeHtml(activity.title)}</strong><small>Parcial ${escapeHtml(activity.period)} · La actividad y sus calificaciones se conservarán.</small></div><label>Fecha de la actividad<input type="date" name="activity_date" value="${escapeHtml(current)}" required></label><p class="muted-text">Al guardar, MiAula recalculará el indicador rojo de calificación máxima con la nueva fecha. No se borrarán calificaciones, puntos extra ni historial.</p><button class="btn primary wide" type="submit">Guardar nueva fecha</button></form>`);
  $('#editActivityDateForm').onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(e.target),newDate=String(fd.get('activity_date')||'').trim();
    if(!parseISODateLocal(newDate)){toast('Selecciona una fecha válida.',true);return;}
    activity.activity_date=newDate;
    activity.updated_at=new Date().toISOString();
    await MiAulaDB.put('activities',activity);
    if(activeActivity?.id===activity.id) activeActivity=activity;
    closeModal();
    await loadActivities();
    if(notebookData?.group?.id===activity.group_id) await loadNotebook();
    await loadSummary();
    toast('Fecha actualizada · calificaciones conservadas');
  };
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

// -------------------- CUADERNO DIGITAL DEL GRUPO --------------------
window.openNotebook=async function(gid=null){
  goView('notebook');
  if(gid){
    await setContextGroup(gid,{propagate:true,refresh:false});
    $('#notebookGroup').value=String(gid);
    await loadNotebook({resetPeriod:true});
  }
};

function notebookGradeDisplay(rec){
  if(rec?.score!=null) return String(rec.score);
  return String(rec?.status||'').toUpperCase()==='NP'?'NP':'';
}
function notebookParseScore(raw,max=10){
  const v=String(raw??'').trim().toUpperCase();
  if(!v) return {score:null,status:''};
  if(v==='NP') return {score:null,status:'NP'};
  const n=Number(v.replace(',','.'));
  if(!Number.isFinite(n) || n<0 || n>+max) return {invalid:true};
  return {score:n,status:''};
}
async function buildNotebookPeriodData(gid,period){
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const activities=(await MiAulaDB.byIndex('activities','group_period',[gid,String(period)])).sort((a,b)=>String(a.activity_date||'').localeCompare(String(b.activity_date||''))||a.id-b.id);
  const gradeLists=await Promise.all(activities.map(a=>MiAulaDB.byIndex('grades','activity_id',a.id)));
  const grades=new Map();
  gradeLists.flat().forEach(gr=>grades.set(`${gr.activity_id}:${gr.student_id}`,gr));
  const components=await MiAulaDB.byIndex('studentComponents','group_period',[gid,String(period)]);
  const compMap=new Map(components.map(c=>[c.student_id,c]));
  const extraRows=await MiAulaDB.byIndex('extraPoints','group_period',[gid,String(period)]);
  const extrasByStudent=new Map();
  for(const s of students){
    const rows=extraRows.filter(r=>+r.student_id===+s.id);
    extrasByStudent.set(s.id,{...extraSummary(rows),rows});
  }
  const grading=await computeGroupGrading(gid,String(period));
  const gradingMap=new Map(grading.students.map(r=>[r.id,r]));
  return {period:String(period),students,activities,grades,components:compMap,extraRows,extrasByStudent,grading,gradingMap,scheme:grading.scheme};
}

async function loadNotebook(opts={}){
  const select=$('#notebookGroup');
  let gid=+select.value;
  if(!gid && groups.length){gid=groups[0].id;select.value=String(gid);}
  if(!gid){
    $('#notebookTable').className='panel empty-state';
    $('#notebookTable').textContent='Crea o selecciona un grupo para abrir su cuaderno digital.';
    $('#notebookPeriod').innerHTML='<option value="">—</option>';
    $('#notebookModeLabel').textContent='Selecciona un grupo';
    return;
  }
  const g=await getGroupState(gid); if(!g)return;
  await syncContextIndicators(gid);
  const periodSelect=$('#notebookPeriod');
  const previous=opts.resetPeriod?'':periodSelect.value;
  const periods=periodNumbers(g);
  periodSelect.innerHTML=periods.map(p=>`<option value="${p}">Parcial ${p}${+p===+g.current_period?' · actual':''}</option>`).join('')+'<option value="all">Todos los parciales</option>';
  const target=previous && (previous==='all'||periods.includes(previous))?previous:String(g.current_period||periods[0]||1);
  periodSelect.value=target;
  notebookEdits.grades.clear();notebookEdits.components.clear();
  const wanted=target==='all'?periods:[target];
  const data={group:g,selected:target,periods:{}};
  for(const p of wanted)data.periods[p]=await buildNotebookPeriodData(gid,p);
  notebookData=data;
  $('#notebookModeLabel').textContent=target==='all'?`${g.name} · todos los parciales`:`${g.name} · Parcial ${target}`;
  renderNotebook();
}

function notebookActivityCell(a,s,pd){
  const rec=pd.grades.get(`${a.id}:${s.id}`);
  const val=notebookGradeDisplay(rec);
  const klass=val==='NP'?' np-value':val!==''?' captured-value':' pending-value';
  return `<td class="notebook-grade-cell${klass}"><input class="notebook-score-input" inputmode="decimal" autocomplete="off" spellcheck="false" data-kind="grade" data-period="${pd.period}" data-student="${s.id}" data-activity="${a.id}" data-max="${a.max_score}" value="${escapeHtml(val)}" placeholder="—" aria-label="${escapeHtml(a.title)} · ${escapeHtml(studentLabel(s))}"></td>`;
}
function notebookComponentInput(field,s,pd,value){
  return `<input class="notebook-score-input component-input" inputmode="decimal" autocomplete="off" data-kind="component" data-field="${field}" data-period="${pd.period}" data-student="${s.id}" data-max="10" value="${value==null?'':escapeHtml(value)}" placeholder="—">`;
}
function notebookExtraCell(s,pd){
  const ex=pd.extrasByStudent?.get(s.id)||{goodAvailable:0,bad:0};
  return `<td class="sticky-col-3 notebook-extra-cell"><button type="button" class="extra-cell-button" onclick="openExtraModal('${pd.period}',${s.id})" aria-label="Puntos extra de ${escapeHtml(studentLabel(s))}"><span class="extra-good">+${ex.goodAvailable||0}</span><span class="extra-bad">${formatBadExtras(ex.bad)}</span><small>Editar</small></button></td>`;
}
function renderNotebookPeriod(pd){
  const principalType=pd.scheme.principal_type||'project',principal=principalLabel(principalType);
  const activityHeads=pd.activities.map(a=>`<th class="activity-head"><span>${escapeHtml(a.title)}</span>${activityMaxIndicator(a)}<small>${escapeHtml(a.activity_type)} · /${fmtNum(a.max_score,1)}</small></th>`).join('');
  const body=pd.students.map(s=>{
    const gr=pd.gradingMap.get(s.id)||{},comp=pd.components.get(s.id)||{};
    const principalCell=principalType==='exam'
      ?notebookComponentInput('exam_score',s,pd,gr.exam_score??comp.exam_score??null)
      :`<span class="auto-score notebook-auto" title="Calculado desde rúbricas y listas de cotejo">${fmtNum(gr.principal_avg)}</span>`;
    const activityCells=pd.activities.length?pd.activities.map(a=>notebookActivityCell(a,s,pd)).join(''):'<td class="summary-cell">—</td>';
    return `<tr data-notebook-row="${pd.period}:${s.id}"><td class="sticky-col notebook-num">${s.list_number??''}</td><td class="sticky-col-2 notebook-student"><button type="button" class="student-name-button" onclick="openStudentView('${pd.period}',${s.id})"><strong>${escapeHtml(studentLabel(s))}</strong><small>Ver alumno</small></button></td>${notebookExtraCell(s,pd)}${activityCells}<td class="summary-cell work-cell" data-work-cell="${pd.period}:${s.id}">${fmtNum(gr.work_avg)}</td><td class="summary-cell principal-cell">${principalCell}</td><td class="summary-cell">${notebookComponentInput('values_score',s,pd,gr.values_score)}</td><td class="summary-cell">${notebookComponentInput('attitudes_score',s,pd,gr.attitudes_score)}</td><td class="summary-cell final-cell" data-final-cell="${pd.period}:${s.id}">${gr.final_grade==null?'<span class="pending-score">Pendiente</span>':`<span class="final-score">${fmtNum(gr.final_grade)}</span>`}</td></tr>`;
  }).join('');
  const emptyActivities=pd.activities.length?activityHeads:'<th class="activity-head no-activities">Sin actividades</th>';
  const colspan=Math.max(pd.activities.length,1)+8;
  return `<div class="notebook-period-block" data-period-block="${pd.period}"><div class="notebook-period-title"><div><h3>Parcial ${pd.period}</h3><p>${pd.activities.length} actividades · Componente principal: <strong>${principal}</strong></p></div><span class="period-badge">Trabajos ${pd.scheme.work_pct}% · ${principal} ${pd.scheme.project_pct}% · Valores ${pd.scheme.values_pct}% · Actitudes ${pd.scheme.attitudes_pct}%</span></div><div class="notebook-table-wrap"><table class="notebook-table"><thead><tr><th class="sticky-col notebook-num">No.</th><th class="sticky-col-2 notebook-student">Alumno</th><th class="sticky-col-3 notebook-extra-head">Puntos extra</th>${emptyActivities}<th>Prom.<br>trabajos</th><th>${principal}</th><th>Valores</th><th>Actitudes</th><th>Final</th></tr></thead><tbody>${body||`<tr><td colspan="${colspan}" class="empty-state">No hay alumnos activos.</td></tr>`}</tbody></table></div></div>`;
}
function renderNotebook(){
  if(!notebookData)return;
  const pds=Object.values(notebookData.periods);
  const totalActs=pds.reduce((n,p)=>n+p.activities.length,0),students=pds[0]?.students.length||0;
  $('#notebookSummary').classList.remove('hidden');
  $('#notebookSummary').innerHTML=`<div><span>Grupo</span><strong>${escapeHtml(notebookData.group.name)}</strong></div><div><span>Alumnos</span><strong>${students}</strong></div><div><span>Actividades visibles</span><strong>${totalActs}</strong></div><div><span>Vista</span><strong>${notebookData.selected==='all'?'Todos':`Parcial ${notebookData.selected}`}</strong></div>`;
  $('#notebookTable').className='';
  $('#notebookTable').innerHTML=pds.map(renderNotebookPeriod).join('');
  $$('#notebookTable .notebook-score-input').forEach(inp=>{
    inp.addEventListener('focus',()=>{inp.dataset.focusValue=inp.value;});
    inp.addEventListener('input',()=>{
      if(inp.dataset.focusValue===undefined)inp.dataset.focusValue=inp.value;
      lastNotebookEdit={
        period:inp.dataset.period,student:inp.dataset.student,activity:inp.dataset.activity||'',field:inp.dataset.field||'',kind:inp.dataset.kind,
        oldValue:inp.dataset.focusValue??'',newValue:inp.value
      };
      inp.classList.add('changed');
      const parsed=notebookParseScore(inp.value,+inp.dataset.max||10);
      inp.classList.toggle('invalid',!!parsed.invalid);
      recalcNotebookRow(inp.dataset.period,+inp.dataset.student);
      applyNotebookFilters();
      scheduleNotebookAutoSave();
    });
    inp.addEventListener('blur',()=>{
      const parsed=notebookParseScore(inp.value,+inp.dataset.max||10);
      if(!parsed.invalid && String(inp.value).trim().toUpperCase()==='NP')inp.value='NP';
    });
  });
  applyNotebookFilters();
}
window.openExtraModal=async function(period,studentId){
  if(!notebookData?.group?.id)return;
  const gid=+notebookData.group.id,p=String(period);
  let pd=notebookData.periods?.[p];
  if(!pd)pd=await buildNotebookPeriodData(gid,p);
  const student=pd.students.find(x=>+x.id===+studentId)||await MiAulaDB.get('students',+studentId);if(!student)return;
  const rows=await getStudentExtraRows(gid,+studentId,p),ex=extraSummary(rows);
  const usable=pd.activities.filter(a=>!['proyecto','examen'].includes(String(a.activity_type||'').trim().toLowerCase())).map(a=>{
    const rec=pd.grades.get(`${a.id}:${studentId}`),score=rec?.score;
    const max=+a.max_score||10,room=score==null?0:Math.floor(Math.max(0,max-(+score||0)));
    const disabled=score==null||room<1;
    const label=score==null?`${a.title} · sin calificación`:`${a.title} · ${fmtNum(score,1)}/${fmtNum(max,1)}${room<1?' · máximo':''}`;
    return `<option value="${a.id}" ${disabled?'disabled':''}>${escapeHtml(label)}</option>`;
  }).join('');
  const movements=[...rows].sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))).slice(0,8).map(r=>{
    const sign=r.kind==='bad'?'-':r.kind==='use'?'↳':'+';
    const cls=r.kind==='bad'?'extra-bad':r.kind==='use'?'extra-used':'extra-good';
    const desc=r.kind==='use'?'Aplicado a actividad':r.source==='roulette'?'Ruleta':'Registro manual';
    return `<div class="extra-history-row"><strong class="${cls}">${sign}${r.points}</strong><span>${escapeHtml(desc)}</span><small>${r.created_at?new Date(r.created_at).toLocaleString('es-MX'):'—'}</small></div>`;
  }).join('')||'<div class="muted-text">Aún no hay movimientos en este parcial.</div>';
  openModal(`Puntos extra · ${studentLabel(student)}`,`
    <div class="extra-balance-grid">
      <div class="extra-balance-card good"><span>Buenos disponibles</span><strong>+${ex.goodAvailable}</strong><small>${ex.goodEarned} ganados · ${ex.goodUsed} usados</small></div>
      <div class="extra-balance-card bad"><span>Puntos malos</span><strong>${formatBadExtras(ex.bad)}</strong><small>Registro informativo; no altera el promedio.</small></div>
    </div>
    <div class="extra-modal-grid">
      <div class="extra-control-card"><h4>Agregar manualmente</h4><div class="extra-quick-row"><button type="button" class="btn success" onclick="addManualExtra('good','${p}',${studentId},1)">+1 bueno</button><button type="button" class="btn success" onclick="addManualExtra('good','${p}',${studentId},2)">+2 buenos</button><button type="button" class="btn danger" onclick="addManualExtra('bad','${p}',${studentId},1)">−1 malo</button><button type="button" class="btn danger" onclick="addManualExtra('bad','${p}',${studentId},2)">−2 malos</button></div><label>Otra cantidad de puntos buenos<input id="manualExtraGood" type="number" inputmode="numeric" min="1" max="99" step="1" value="1"></label><button type="button" class="btn success wide" onclick="addManualExtra('good','${p}',${studentId})">+ Agregar buenos</button><label>Otra cantidad de puntos malos<input id="manualExtraBad" type="number" inputmode="numeric" min="1" max="99" step="1" value="1"></label><button type="button" class="btn danger wide" onclick="addManualExtra('bad','${p}',${studentId})">− Agregar malos</button><div class="extra-reset-row"><button type="button" class="btn danger wide" onclick="clearStudentExtras('${p}',${studentId})">Limpiar puntos · dejar en 0</button><small>Reinicia a cero los puntos buenos y malos de este alumno en el parcial.</small></div></div>
      <div class="extra-control-card"><h4>Usar puntos buenos en una actividad</h4><p class="muted-text">Solo se pueden aplicar a una actividad que ya tenga calificación. La actividad nunca supera su puntaje máximo.</p><label>Actividad<select id="extraTargetActivity"><option value="">Seleccionar…</option>${usable}</select></label><label>Puntos a utilizar<input id="extraUsePoints" type="number" inputmode="numeric" min="1" max="${Math.max(1,ex.goodAvailable)}" step="1" value="1" ${ex.goodAvailable<1?'disabled':''}></label><button type="button" class="btn primary wide" onclick="applyExtraToActivity('${p}',${studentId})" ${ex.goodAvailable<1?'disabled':''}>Aplicar a actividad</button></div>
    </div>
    <div class="extra-history"><h4>Últimos movimientos</h4>${movements}</div>`);
};
window.addManualExtra=async function(kind,period,studentId,forcedPoints=null){
  if(!notebookData?.group?.id)return;
  const id=kind==='good'?'#manualExtraGood':'#manualExtraBad',n=forcedPoints==null?Math.floor(+$(id)?.value||0):Math.floor(+forcedPoints||0);
  if(n<1||n>99){toast('Escribe una cantidad entre 1 y 99.',true);return;}
  await addExtraRecord({groupId:notebookData.group.id,studentId,period,kind,points:n,source:'manual',note:kind==='good'?'Punto bueno manual':'Punto malo manual'});
  toast(kind==='good'?`+${n} punto(s) buenos agregados`:`-${n} punto(s) malos agregados`);
  await loadNotebook();
  await openExtraModal(period,studentId);
};
window.clearStudentExtras=async function(period,studentId){
  if(!notebookData?.group?.id)return;
  const gid=+notebookData.group.id,p=String(period);
  const rows=await getStudentExtraRows(gid,+studentId,p);
  if(!rows.length){toast('Los puntos extra ya están en 0.');return;}
  const student=await MiAulaDB.get('students',+studentId);
  const ok=window.confirm(`¿Dejar en 0 los puntos extra de ${studentLabel(student||{})}?\n\nSe borrarán los puntos buenos, malos y su historial de este parcial. Las calificaciones de actividades que ya recibieron puntos se conservarán.`);
  if(!ok)return;
  for(const r of rows)await MiAulaDB.remove('extraPoints',r.id);
  toast('Puntos extra reiniciados a 0');
  await loadNotebook();
  await openExtraModal(p,+studentId);
};
window.applyExtraToActivity=async function(period,studentId){
  if(!notebookData?.group?.id)return;
  const gid=+notebookData.group.id,activityId=+$('#extraTargetActivity')?.value,points=Math.floor(+$('#extraUsePoints')?.value||0);
  if(!activityId){toast('Selecciona una actividad.',true);return;}
  if(points<1){toast('Indica cuántos puntos quieres utilizar.',true);return;}
  const ex=await getStudentExtraSummary(gid,studentId,String(period));
  if(points>ex.goodAvailable){toast(`Solo hay +${ex.goodAvailable} punto(s) disponibles.`,true);return;}
  const activity=await MiAulaDB.get('activities',activityId);if(!activity){toast('Actividad no encontrada.',true);return;}
  const grade=await MiAulaDB.firstByIndex('grades','unique_key',[activityId,+studentId]);
  if(!grade||grade.score==null){toast('Primero captura una calificación numérica en esa actividad.',true);return;}
  const max=+activity.max_score||10,room=Math.floor(Math.max(0,max-(+grade.score||0)));
  if(room<1){toast('Esa actividad ya está en su puntaje máximo.',true);return;}
  if(points>room){toast(`Puedes aplicar como máximo ${room} punto(s) a esta actividad.`,true);return;}
  grade.score=+(+grade.score+points).toFixed(2);grade.status='';
  await MiAulaDB.put('grades',grade);
  await addExtraRecord({groupId:gid,studentId,period,kind:'use',points,source:'activity',activityId,note:`Aplicado a ${activity.title}`});
  toast(`Se aplicaron ${points} punto(s) a ${activity.title}`);
  await loadNotebook();
  await openExtraModal(period,studentId);
  await loadSummary();
};
function notebookCurrentValue(selector,max=10){
  const el=document.querySelector(selector);if(!el)return {score:null,status:''};return notebookParseScore(el.value,max);
}
function recalcNotebookRow(period,studentId){
  if(!notebookData?.periods?.[period])return;
  const pd=notebookData.periods[period],scheme=pd.scheme,principalType=scheme.principal_type||'project';
  let workTotal=0,workW=0,projectTotal=0,projectW=0;
  for(const a of pd.activities){
    const el=document.querySelector(`.notebook-score-input[data-kind="grade"][data-period="${period}"][data-student="${studentId}"][data-activity="${a.id}"]`);
    const parsed=notebookParseScore(el?.value,+a.max_score||10);if(parsed.invalid||parsed.score==null)continue;
    const normalized=parsed.score*10/(+a.max_score||10),w=+a.weight||1,type=String(a.activity_type||'').trim().toLowerCase();
    if(type==='proyecto'){projectTotal+=normalized*w;projectW+=w;}else if(type!=='examen'){workTotal+=normalized*w;workW+=w;}
  }
  const work=workW?workTotal/workW:null;
  const old=pd.gradingMap.get(studentId)||{};
  let principal=principalType==='project'?old.principal_avg:null;
  if(principalType==='exam'){
    const x=notebookCurrentValue(`.notebook-score-input[data-kind="component"][data-field="exam_score"][data-period="${period}"][data-student="${studentId}"]`,10);principal=x.invalid?null:x.score;
  }
  const v=notebookCurrentValue(`.notebook-score-input[data-kind="component"][data-field="values_score"][data-period="${period}"][data-student="${studentId}"]`,10);
  const a=notebookCurrentValue(`.notebook-score-input[data-kind="component"][data-field="attitudes_score"][data-period="${period}"][data-student="${studentId}"]`,10);
  const workCell=document.querySelector(`[data-work-cell="${period}:${studentId}"]`);if(workCell)workCell.textContent=fmtNum(work);
  let complete=true,final=0;
  for(const [score,pct] of [[work,+scheme.work_pct],[principal,+scheme.project_pct],[v.invalid?null:v.score,+scheme.values_pct],[a.invalid?null:a.score,+scheme.attitudes_pct]]){if(pct>0){if(score==null)complete=false;else final+=score*pct/100;}}
  const finalCell=document.querySelector(`[data-final-cell="${period}:${studentId}"]`);
  if(finalCell)finalCell.innerHTML=complete?`<span class="final-score">${fmtNum(+final.toFixed(2))}</span>`:'<span class="pending-score">Pendiente</span>';
}
async function saveNotebookChanges(opts={}){
  if(!notebookData)return false;
  setSaveState('saving','Guardando…');
  const gradeInputs=$$('#notebookTable .notebook-score-input[data-kind="grade"]');
  const compInputs=$$('#notebookTable .notebook-score-input[data-kind="component"]');
  const parsedGrades=[];const parsedComps=[];let invalid=false;
  for(const inp of gradeInputs){
    const parsed=notebookParseScore(inp.value,+inp.dataset.max||10);
    inp.classList.toggle('invalid',!!parsed.invalid);
    if(parsed.invalid){invalid=true;continue;}
    parsedGrades.push({inp,parsed,activity_id:+inp.dataset.activity,student_id:+inp.dataset.student});
  }
  for(const inp of compInputs){
    const parsed=notebookParseScore(inp.value,10);
    inp.classList.toggle('invalid',!!parsed.invalid);
    if(parsed.invalid){invalid=true;continue;}
    parsedComps.push({inp,parsed,period:String(inp.dataset.period),student_id:+inp.dataset.student,field:inp.dataset.field});
  }
  if(invalid){setSaveState('error','Revisa las celdas');toast('Hay calificaciones inválidas. Revisa las celdas marcadas.',true);return false;}
  for(const item of parsedGrades){
    const old=await MiAulaDB.firstByIndex('grades','unique_key',[item.activity_id,item.student_id]);
    const rec={...(old||{}),activity_id:item.activity_id,student_id:item.student_id,score:item.parsed.score,status:item.parsed.status,notes:old?.notes||''};
    if(old)await MiAulaDB.put('grades',rec);else if(item.parsed.score!=null||item.parsed.status)await MiAulaDB.add('grades',rec);
  }
  const grouped=new Map();
  for(const item of parsedComps){
    const key=`${notebookData.group.id}:${item.period}:${item.student_id}`;
    if(!grouped.has(key))grouped.set(key,{period:item.period,student_id:item.student_id,fields:{}});
    grouped.get(key).fields[item.field]=item.parsed.score;
  }
  for(const [key,item] of grouped){
    const old=await MiAulaDB.get('studentComponents',key);
    await MiAulaDB.put('studentComponents',{...(old||{}),key,group_id:notebookData.group.id,period:item.period,student_id:item.student_id,...item.fields,updated_at:new Date().toISOString()});
  }
  setSaveState('saved','Todo guardado');
  $$('#notebookTable .notebook-score-input.changed').forEach(el=>{el.classList.remove('changed');el.dataset.focusValue=el.value;});
  if(!opts.silent)toast('Cuaderno guardado');
  if(!opts.skipSummary)await loadSummary();
  if(!opts.noReload)await loadNotebook();
  return true;
}

async function buildNotebookWorkbook(gid,selection){
  const g=await getGroupState(gid);if(!g)throw new Error('Grupo no encontrado');
  const periods=selection==='all'?periodNumbers(g):[String(selection)];
  const sheets=[];
  for(const p of periods){
    const pd=await buildNotebookPeriodData(gid,p),principal=principalLabel(pd.scheme.principal_type||'project');
    const headers=['No.','Alumno','Extra + disponibles','Extra -','Extra + ganados','Extra + aplicados',...pd.activities.map(a=>`${a.title} [${a.activity_type} /${fmtNum(a.max_score,1)}]`),'Prom. trabajos',principal,'Valores','Actitudes','Final','Estado'];
    const rows=[headers];
    for(const s of pd.students){
      const gr=pd.gradingMap.get(s.id)||{},comp=pd.components.get(s.id)||{},ex=pd.extrasByStudent?.get(s.id)||{goodAvailable:0,bad:0,goodEarned:0,goodUsed:0};
      const scores=pd.activities.map(a=>{const rec=pd.grades.get(`${a.id}:${s.id}`);return rec?.score!=null?rec.score:(String(rec?.status||'').toUpperCase()==='NP'?'NP':'');});
      rows.push([s.list_number,studentLabel(s),ex.goodAvailable,-ex.bad,ex.goodEarned,ex.goodUsed,...scores,gr.work_avg,gr.principal_avg,gr.values_score,gr.attitudes_score,gr.final_grade,gr.final_grade==null?'Pendiente':'Completo']);
    }
    sheets.push({name:`Libreta P${p}`,rows});
  }
  const extraRows=await MiAulaDB.all('extraPoints'),studentMap=new Map((await MiAulaDB.groupStudents(gid,{includeInactive:true})).map(s=>[s.id,s]));
  const activityMap=new Map((await MiAulaDB.byIndex('activities','group_id',gid)).map(a=>[a.id,a]));
  const history=[['Parcial','No.','Alumno','Movimiento','Puntos','Origen','Actividad','Fecha','Nota']];
  for(const r of extraRows.filter(x=>+x.group_id===+gid).sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')))){
    const st=studentMap.get(r.student_id),ac=activityMap.get(r.activity_id);
    history.push([r.period,st?.list_number??'',studentLabel(st||{}),r.kind==='good'?'Bueno':r.kind==='bad'?'Malo':'Aplicado',r.kind==='bad'?-r.points:r.points,r.source||'',ac?.title||'',r.created_at?new Date(r.created_at).toLocaleString('es-MX'):'',r.note||'']);
  }
  sheets.push({name:'Historial extras',rows:history});
  return {sheets};
}

$('#notebookGroup').onchange=()=>{syncContextFromControl('#notebookGroup');loadNotebook({resetPeriod:true});};
$('#notebookPeriod').onchange=()=>loadNotebook();
$('#notebookReload').onclick=()=>loadNotebook();
$('#notebookSave').onclick=()=>saveNotebookChanges();
$('#notebookSearch').oninput=applyNotebookFilters;
$('#notebookFilter').onchange=applyNotebookFilters;
$('#notebookStudentView').onclick=()=>openFirstVisibleStudent();
$('#notebookExcel').onclick=async()=>{
  const gid=+$('#notebookGroup').value;if(!gid){toast('Selecciona un grupo',true);return;}
  try{
    const ok=await saveNotebookChanges({silent:true,noReload:true});if(!ok)return;
    const g=await MiAulaDB.get('groups',gid),selection=$('#notebookPeriod').value||String(g.current_period||1),book=await buildNotebookWorkbook(gid,selection),blob=XLSXLite.write(book),safe=String(g.name).replace(/[^A-Za-z0-9_-]+/g,'_');
    downloadBlob(blob,`MiAula_Cuaderno_${safe}_${selection==='all'?'Todos':`P${selection}`}_${today}.xlsx`);toast('Excel del cuaderno generado');
    await loadNotebook();
  }catch(e){console.error(e);toast(e.message,true);}
};
$('#notebookPresentation').onclick=async()=>{
  const on=!document.body.classList.contains('notebook-focus');document.body.classList.toggle('notebook-focus',on);
  $('#notebookPresentation').textContent=on?'✕ Salir de presentación':'▣ Presentación';
  if(on && document.documentElement.requestFullscreen){try{await document.documentElement.requestFullscreen();}catch{}}
  if(!on && document.fullscreenElement){try{await document.exitFullscreen();}catch{}}
};
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.body.classList.contains('notebook-focus')){document.body.classList.remove('notebook-focus');if($('#notebookPresentation'))$('#notebookPresentation').textContent='▣ Presentación';}});

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
    for(const a of activities){const gr=gradeKey.get(`${a.id}:${s.id}`),v=gr?.score??null,shown=v!=null?v:(String(gr?.status||'').toUpperCase()==='NP'?'NP':'');row.push(shown);if(v!=null&&+a.max_score>0)normalized.push(+v*10/+a.max_score);}
    row.push(normalized.length?Math.round(100*normalized.reduce((x,y)=>x+y,0)/normalized.length)/100:null,...periods.map(p=>grading[p].students.find(x=>x.id===s.id)?.final_grade??null));conc.push(row);
  }
  const asist=[['No.','Alumno',...dates.map(d=>`${d} (registro)`),'Hrs P','Hrs F','Hrs R','Hrs J','Total hrs','Asistencia %']];
  for(const s of students){const sa=attendance.filter(a=>a.student_id===s.id),at=attendanceTotals(sa);asist.push([s.list_number,studentLabel(s),...dates.map(d=>{const a=attKey.get(`${s.id}:${d}`);return a?`${a.status} ×${a.class_hours||1}`:'';}),at.P,at.F,at.R,at.J,at.total,at.pct]);}
  const hourHeaders=['No.','Alumno'];for(const d of dates){const hrs=classBlocks.get(d)||1;for(let h=1;h<=hrs;h++)hourHeaders.push(`${d} H${h}`);}const asistHoras=[hourHeaders];
  for(const s of students){const row=[s.list_number,studentLabel(s)];for(const d of dates){const hrs=classBlocks.get(d)||1,a=attKey.get(`${s.id}:${d}`);for(let h=1;h<=hrs;h++)row.push(a?.status||'');}asistHoras.push(row);}
  const acts=[['Actividad','Tipo','Parcial','Fecha','Puntaje máximo','Peso','Capturadas','Pendientes']];for(const a of activities){const count=grades.filter(gr=>gr.activity_id===a.id&&gr.score!=null&&sm.get(gr.student_id)?.active!==0).length;acts.push([a.title,a.activity_type,a.period,a.activity_date,a.max_score,a.weight,count,Math.max(students.length-count,0)]);}
  const detail=[['No.','Alumno','Estatus','Actividad','Tipo','Parcial','Fecha','Calificación','Máximo','Equivalente 0-10','Observación']];for(const gr of grades){const a=am.get(gr.activity_id),s=sm.get(gr.student_id);if(!a||!s)continue;detail.push([s.list_number,studentLabel(s),s.active!==0?'Activo':'Baja',a.title,a.activity_type,a.period,a.activity_date,gr.score!=null?gr.score:(String(gr.status||'').toUpperCase()==='NP'?'NP':''),a.max_score,gr.score==null?null:Math.round(+gr.score*1000/+a.max_score)/100,gr.notes||'']);}
  const evalSheet=[['Fecha','Parcial','Alumno','Estatus','Proyecto','Instrumento','Tipo','Equipo','Puntaje','Calificación','Observación']];for(const e of evals){const i=im.get(e.instrument_id),s=sm.get(e.student_id);evalSheet.push([e.evaluation_date,e.period,studentLabel(s||{}),s?.active!==0?'Activo':'Baja',e.title,i?.name||'',i?.instrument_type==='rubric'?'Rúbrica':'Lista de cotejo',e.team_name||'',e.raw_score,e.grade,e.notes||'']);}
  const obs=[['Alumno','Origen','Actividad/Evaluación','Observación']];for(const gr of grades){if(String(gr.notes||'').trim()){const a=am.get(gr.activity_id),s=sm.get(gr.student_id);obs.push([studentLabel(s||{}),'Actividad',a?.title||'',gr.notes]);}}for(const e of evals){if(String(e.notes||'').trim())obs.push([studentLabel(sm.get(e.student_id)||{}),'Evaluación',e.title,e.notes]);}for(const p of periods)for(const s of grading[p].students)if(String(s.notes||'').trim())obs.push([s.name,`Parcial ${p}`,'Valores y Actitudes',s.notes]);
  const bajas=[['Último No.','Código','Apellido paterno','Apellido materno','Nombre(s)','Nombre completo','Fecha de baja','Hrs P','Hrs F','Hrs R','Hrs J','Asistencia %']];for(const s of inactive){const at=attendanceTotals(attendance.filter(a=>a.student_id===s.id));bajas.push([s.former_list_number??s.list_number,s.student_code,s.paternal_last_name||'',s.maternal_last_name||'',s.given_names||'',studentLabel(s),s.withdrawn_at?new Date(s.withdrawn_at).toLocaleDateString('es-MX'):'',at.P,at.F,at.R,at.J,at.pct]);}
  const instrumentBank=[['Instrumento','Tipo','Convierte a 0-10','Criterios']];for(const i of insts){instrumentBank.push([i.name,i.instrument_type==='rubric'?'Rúbrica':'Lista de cotejo',i.convert_to_grade?'Sí':'No',(i.criteria||[]).map(c=>c.name).join(' · ')]);}
  const extraRows=(await MiAulaDB.all('extraPoints')).filter(r=>+r.group_id===+gid).sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
  const extraSheet=[['Parcial','No.','Alumno','Movimiento','Puntos','Origen','Actividad','Fecha','Nota']];for(const r of extraRows){const st=sm.get(r.student_id),ac=am.get(r.activity_id);extraSheet.push([r.period,st?.list_number??'',studentLabel(st||{}),r.kind==='good'?'Bueno':r.kind==='bad'?'Malo':'Aplicado',r.kind==='bad'?-r.points:r.points,r.source||'',ac?.title||'',r.created_at?new Date(r.created_at).toLocaleString('es-MX'):'',r.note||'']);}
  return {sheets:[{name:'Resumen',rows:resumen},{name:'Esquemas',rows:esquema},{name:'Calificación parcial',rows:trim},{name:'Concentrado',rows:conc},{name:'Asistencia',rows:asist},{name:'Asistencia por horas',rows:asistHoras},{name:'Actividades',rows:acts},{name:'Detalle calificaciones',rows:detail},{name:'Proyectos',rows:evalSheet},{name:'Puntos extra',rows:extraSheet},{name:'Banco instrumentos',rows:instrumentBank},{name:'Observaciones',rows:obs},{name:'Bajas',rows:bajas}]};
}
async function exportFullExcelForGroup(gid){
  gid=+gid||0;if(!gid){toast('Selecciona un grupo',true);return;}
  try{toast('Generando Excel completo…');const g=await MiAulaDB.get('groups',gid),book=await buildWorkbook(gid),blob=XLSXLite.write(book),safe=String(g.name).replace(/[^A-Za-z0-9_-]+/g,'_');downloadBlob(blob,`MiAula_${safe}_${today}.xlsx`);toast('Excel completo generado');}catch(e){console.error(e);toast(e.message,true);}
}
$('#exportBtn').onclick=async()=>{await exportFullExcelForGroup(+$('#exportGroup').value);};
async function downloadMiAulaBackup(){
  try{
    const data=await MiAulaDB.exportBackup();
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    downloadBlob(blob,`MiAula_2.3.0_Respaldo_${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    toast('Respaldo generado');
  }catch(e){console.error(e);toast('No se pudo generar el respaldo: '+e.message,true);}
}
$('#backupBtn').onclick=downloadMiAulaBackup;
const bottomBackupBtn=$('#bottomBackupBtn');
if(bottomBackupBtn)bottomBackupBtn.onclick=downloadMiAulaBackup;
$('#restoreFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!confirm('Restaurar este respaldo reemplazará los datos actuales de la tablet. ¿Continuar?')){e.target.value='';return;}await MiAulaDB.restoreBackup(data);await refreshGroups();await loadInstruments();await loadSummary();toast('Respaldo restaurado correctamente');goView('dashboard');}catch(er){console.error(er);toast(er.message,true);}finally{e.target.value='';}};


// -------------------- CENTRO DE ADMINISTRACIÓN --------------------
async function loadAdminOverview(){
  const box=$('#adminCurrentGroup'),schemeText=$('#adminSchemeSummary'),principalTitle=$('#adminPrincipalTitle'),principalSummary=$('#adminPrincipalSummary');
  let gid=+$('#contextGroup')?.value||+$('#exportGroup')?.value||0;
  if(!gid&&groups.length)gid=+groups[0].id;
  if(!gid){
    if(box)box.innerHTML='<span>Grupo activo</span><strong>Sin grupo seleccionado</strong><small>Selecciona un grupo arriba</small>';
    if(schemeText)schemeText.textContent='Selecciona un grupo para ver el esquema';
    if(principalTitle)principalTitle.textContent='Proyecto / Examen';
    if(principalSummary)principalSummary.textContent='Selecciona un grupo para continuar';
    return;
  }
  const g=await getGroupState(gid);if(!g)return;
  const period=String(g.current_period||1),scheme=await getScheme(gid,period),principal=principalLabel(scheme.principal_type||'project');
  if(box)box.innerHTML=`<span>Grupo activo</span><strong>${escapeHtml(g.name)} · ${escapeHtml(g.discipline||'')}</strong><small>Parcial ${period} de ${totalPeriods(g)}</small>`;
  if(schemeText)schemeText.textContent=`Trabajos ${scheme.work_pct}% · ${principal} ${scheme.project_pct}% · Valores ${scheme.values_pct}% · Actitudes ${scheme.attitudes_pct}%`;
  if(principalTitle)principalTitle.textContent=principal;
  if(principalSummary)principalSummary.textContent=`Parcial ${period} · ${scheme.project_pct}% del total`;
}

const adminExportBtn=$('#adminExportBtn');
if(adminExportBtn)adminExportBtn.onclick=async()=>{
  const gid=+$('#contextGroup')?.value||+$('#exportGroup')?.value||0;
  if(!gid){toast('Selecciona un grupo activo',true);return;}
  await exportFullExcelForGroup(gid);
};
const adminBackupBtn=$('#adminBackupBtn');
if(adminBackupBtn)adminBackupBtn.onclick=downloadMiAulaBackup;

// -------------------- MIAULA 2.1 · EXPERIENCIA DE TABLET --------------------
function setSaveState(state='saved',text='Todo guardado'){
  const wrap=$('#saveStateWrap'),label=$('#saveState');
  if(!wrap||!label)return;
  wrap.classList.remove('saved','saving','changed','error');wrap.classList.add(state);label.textContent=text;
}

function updateAppNav(){
  $$('.app-tab').forEach(btn=>{
    const v=btn.dataset.appView,mode=btn.dataset.mode;
    let active=false;
    if(v==='dynamics')active=currentView==='dynamics'&&(!mode||mode===dynamics.mode);
    else if(['groups','activities','grading','evaluation'].includes(currentView))active=v==='more';
    else active=v===currentView;
    btn.classList.toggle('active',active);
  });
}

$$('.app-tab').forEach(btn=>btn.addEventListener('click',()=>{
  const view=btn.dataset.appView,mode=btn.dataset.mode;
  if(view==='dynamics')openDynamicsMode(mode||'roulette'); else goView(view);
}));

async function syncContextIndicators(gid){
  gid=+gid||0;
  const periodEl=$('#contextPeriod');
  if(!gid){if(periodEl)periodEl.textContent='Sin grupo';return;}
  const g=await getGroupState(gid);if(!g)return;
  if($('#contextGroup'))$('#contextGroup').value=String(gid);
  if(periodEl)periodEl.textContent=g.course_closed?`Cerrado · ${totalPeriods(g)} parciales`:`Parcial ${g.current_period||1} de ${totalPeriods(g)}`;
  try{localStorage.setItem('miaula:activeGroup',String(gid));}catch{}
}

async function setContextGroup(gid,{propagate=true,refresh=true}={}){
  gid=+gid||0;if(!gid)return;
  if($('#contextGroup'))$('#contextGroup').value=String(gid);
  if(propagate){
    ['#attendanceGroup','#dynamicsGroup','#activityGroup','#activityFilter','#notebookGroup','#gradingGroup','#evalGroup','#exportGroup'].forEach(id=>{if($(id)&&[...$(id).options].some(o=>+o.value===gid))$(id).value=String(gid);});
  }
  await syncContextIndicators(gid);
  if(refresh)await renderClassSnapshot(gid);
}

function syncContextFromControl(selector){
  const gid=+$(selector)?.value||0;if(gid)setContextGroup(gid,{propagate:false,refresh:true});
}

$('#contextGroup').addEventListener('change',async e=>{
  const gid=+e.target.value||0;if(!gid)return;
  await setContextGroup(gid);
  if(currentView==='notebook')await loadNotebook({resetPeriod:true});
  else if(currentView==='dynamics')await loadDynamicsStudents(true);
  else if(currentView==='activities')await loadActivities();
  else if(currentView==='grading')await loadGrading();
  else if(currentView==='evaluation')await loadPrincipalWorkspace();
  else if(currentView==='more')await loadAdminOverview();
});
$('#contextNotebook').onclick=()=>{const gid=+$('#contextGroup').value||null;openNotebook(gid);};
$('#contextAttendance').onclick=()=>{const gid=+$('#contextGroup').value||0;if(gid)$('#attendanceGroup').value=String(gid);goView('attendance');};
['#attendanceGroup','#dynamicsGroup','#activityGroup','#activityFilter','#gradingGroup','#evalGroup','#exportGroup'].forEach(id=>$(id)?.addEventListener('change',()=>syncContextFromControl(id)));

async function renderClassSnapshot(forcedGid=null){
  const box=$('#classSnapshot');if(!box)return;
  let gid=+forcedGid||+$('#contextGroup')?.value||0;
  if(!gid&&groups.length){gid=groups[0].id;await setContextGroup(gid,{propagate:false,refresh:false});}
  if(!gid){box.innerHTML='<div class="snapshot-empty">Crea o selecciona un grupo para comenzar.</div>';return;}
  const g=await getGroupState(gid);if(!g)return;
  const p=String(g.current_period||1);
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const activities=await MiAulaDB.byIndex('activities','group_period',[gid,p]);
  const gradeLists=await Promise.all(activities.map(a=>MiAulaDB.byIndex('grades','activity_id',a.id)));
  const gradeKey=new Map(gradeLists.flat().map(r=>[`${r.activity_id}:${r.student_id}`,r]));
  let pendingStudents=0;
  for(const st of students){
    const pending=activities.some(a=>{const r=gradeKey.get(`${a.id}:${st.id}`);return !(r&&(r.score!=null||String(r.status||'').toUpperCase()==='NP'));});
    if(pending)pendingStudents++;
  }
  const att=await MiAulaDB.byIndex('attendance','group_date',[gid,today]);
  const attendanceText=att.length?`✓ Tomada · ${att.length} alumnos`:'Pendiente';
  box.innerHTML=`<div class="snapshot-head"><div><span class="eyebrow">Clase activa</span><h3>${escapeHtml(g.name)} · Parcial ${p}</h3><p>${escapeHtml(g.discipline||'')}</p></div><button class="btn primary" onclick="openNotebook(${gid})">Abrir cuaderno</button></div><div class="snapshot-grid"><div><span>Alumnos</span><strong>${students.length}</strong></div><div><span>Asistencia hoy</span><strong class="${att.length?'ok':'warn'}">${attendanceText}</strong></div><div><span>Actividades</span><strong>${activities.length}</strong></div><div><span>Con pendientes</span><strong class="${pendingStudents?'warn':'ok'}">${pendingStudents}</strong></div></div>`;
}

function toggleClassMode(force=null){
  classMode=force==null?!classMode:!!force;
  document.body.classList.toggle('class-mode',classMode);
  const text=classMode?'Salir de modo clase':'Modo clase';
  if($('#classModeTop'))$('#classModeTop').textContent=text;
  if($('#startClassMode'))$('#startClassMode').innerHTML=`<svg class="ui-icon" aria-hidden="true"><use href="#i-class"></use></svg><span>${classMode?'Modo clase activo':'Iniciar clase'}</span>`;
  toast(classMode?'Modo clase activado':'Modo clase desactivado');
}
$('#classModeTop').onclick=()=>toggleClassMode();
$('#startClassMode').onclick=()=>toggleClassMode(true);

function applyNotebookFilters(){
  const search=normalizeText($('#notebookSearch')?.value||''),filter=$('#notebookFilter')?.value||'all';
  let shown=0,total=0;
  $$('#notebookTable tbody tr[data-notebook-row]').forEach(row=>{
    total++;
    const name=normalizeText(row.querySelector('.notebook-student')?.textContent||'');
    const inputs=[...row.querySelectorAll('.notebook-score-input')];
    const hasPending=inputs.some(i=>String(i.value||'').trim()==='');
    const hasNP=inputs.some(i=>String(i.value||'').trim().toUpperCase()==='NP');
    const hasLow=inputs.some(i=>{const n=Number(String(i.value||'').replace(',','.'));return Number.isFinite(n)&&String(i.value||'').trim()!==''&&n<6;});
    let match=!search||name.includes(search);
    if(filter==='pending')match=match&&hasPending;
    if(filter==='np')match=match&&hasNP;
    if(filter==='low')match=match&&hasLow;
    row.classList.toggle('notebook-row-hidden',!match);if(match)shown++;
  });
  if($('#notebookFilterCount'))$('#notebookFilterCount').textContent=total?`${shown} de ${total} alumnos`:'';
}

function scheduleNotebookAutoSave(){
  setSaveState('changed','Cambios sin guardar');
  clearTimeout(notebookAutoSaveTimer);
  notebookAutoSaveTimer=setTimeout(async()=>{
    const ok=await saveNotebookChanges({silent:true,noReload:true,skipSummary:true});
    if(ok&&lastNotebookEdit)showUndoBar('Cambio guardado automáticamente');
  },900);
}

function showUndoBar(message){
  const bar=$('#undoBar');if(!bar)return;
  $('#undoMessage').textContent=message||'Cambio guardado';bar.classList.remove('hidden');
  clearTimeout(undoHideTimer);undoHideTimer=setTimeout(()=>bar.classList.add('hidden'),5500);
}

function notebookEditSelector(edit){
  if(!edit)return'';
  if(edit.kind==='grade')return `.notebook-score-input[data-kind="grade"][data-period="${edit.period}"][data-student="${edit.student}"][data-activity="${edit.activity}"]`;
  return `.notebook-score-input[data-kind="component"][data-period="${edit.period}"][data-student="${edit.student}"][data-field="${edit.field}"]`;
}
$('#undoNotebook').onclick=async()=>{
  if(!lastNotebookEdit)return;
  const edit={...lastNotebookEdit},el=document.querySelector(notebookEditSelector(edit));
  if(!el)return;
  clearTimeout(notebookAutoSaveTimer);el.value=edit.oldValue;el.dataset.focusValue=edit.oldValue;el.dispatchEvent(new Event('input',{bubbles:true}));
  clearTimeout(notebookAutoSaveTimer);await saveNotebookChanges({silent:true,noReload:true,skipSummary:true});
  $('#undoBar').classList.add('hidden');lastNotebookEdit=null;toast('Cambio deshecho');
};

function openFirstVisibleStudent(){
  const row=$('#notebookTable tbody tr[data-notebook-row]:not(.notebook-row-hidden)');
  if(!row){toast('No hay alumnos visibles con este filtro.',true);return;}
  const [period,studentId]=String(row.dataset.notebookRow).split(':');openStudentView(period,+studentId);
}

function drawerInputValue(kind,period,studentId,activityId='',field=''){
  let sel='';
  if(kind==='grade')sel=`.notebook-score-input[data-kind="grade"][data-period="${period}"][data-student="${studentId}"][data-activity="${activityId}"]`;
  else sel=`.notebook-score-input[data-kind="component"][data-period="${period}"][data-student="${studentId}"][data-field="${field}"]`;
  return document.querySelector(sel)?.value??'';
}

function quickButtonsHTML(inputId,max=10){
  const vals=[10,9,8,7,6,5].filter(v=>v<=max);
  return `<div class="student-quick-row">${vals.map(v=>`<button type="button" onclick="studentQuickScore('${inputId}','${v}')">${v}</button>`).join('')}<button type="button" class="np" onclick="studentQuickScore('${inputId}','NP')">NP</button></div>`;
}

window.studentQuickScore=function(inputId,value){
  const el=document.getElementById(inputId);if(!el)return;el.value=value;lastStudentQuickScore=value;el.classList.add('changed');
};

window.openStudentView=async function(period,studentId){
  if(!notebookData?.group?.id)return;
  period=String(period);studentId=+studentId;
  let pd=notebookData.periods?.[period];if(!pd)pd=await buildNotebookPeriodData(notebookData.group.id,period);
  const student=pd.students.find(s=>+s.id===studentId);if(!student)return;
  studentDrawerState={period,studentId};
  const ex=await getStudentExtraSummary(notebookData.group.id,studentId,period),gr=pd.gradingMap.get(studentId)||{};
  $('#studentDrawerTitle').textContent=studentLabel(student);
  $('#studentDrawerMeta').textContent=`No. ${student.list_number??'—'} · ${notebookData.group.name} · Parcial ${period}`;
  const searchInput=$('#studentDrawerSearch'),searchResults=$('#studentDrawerSearchResults');
  if(searchInput)searchInput.value='';
  if(searchResults){searchResults.innerHTML='';searchResults.classList.add('hidden');}
  const activities=pd.activities.map((a,i)=>{
    const id=`sv-grade-${period}-${studentId}-${a.id}`,val=drawerInputValue('grade',period,studentId,a.id),max=+a.max_score||10;
    return `<div class="student-activity-card"><div class="student-activity-copy"><strong>${escapeHtml(a.title)}</strong>${activityMaxIndicator(a)}<small>${escapeHtml(a.activity_type)} · puntaje original ${fmtNum(max,1)}</small></div><div class="student-score-box"><input id="${id}" class="drawer-score-input" data-kind="grade" data-period="${period}" data-student="${studentId}" data-activity="${a.id}" data-max="${max}" value="${escapeHtml(val)}" placeholder="—" inputmode="decimal">${max>=10?quickButtonsHTML(id,max):''}</div></div>`;
  }).join('')||'<div class="empty-state">No hay actividades en este parcial.</div>';
  const principalType=pd.scheme.principal_type||'project';
  let principal='';
  if(principalType==='exam'){
    const id=`sv-exam-${period}-${studentId}`,val=drawerInputValue('component',period,studentId,'','exam_score');
    principal=`<div class="student-component-card"><div><strong>Examen</strong><small>Componente principal</small></div><div class="student-score-box"><input id="${id}" class="drawer-score-input" data-kind="component" data-field="exam_score" data-period="${period}" data-student="${studentId}" data-max="10" value="${escapeHtml(val)}" placeholder="—">${quickButtonsHTML(id,10)}</div></div>`;
  }else{
    principal=`<div class="student-component-card readonly"><div><strong>Proyecto</strong><small>Calculado desde rúbricas/listas</small></div><b>${fmtNum(gr.principal_avg)}</b></div>`;
  }
  const valueId=`sv-values-${period}-${studentId}`,attId=`sv-att-${period}-${studentId}`;
  const valuesVal=drawerInputValue('component',period,studentId,'','values_score'),attVal=drawerInputValue('component',period,studentId,'','attitudes_score');
  $('#studentDrawerBody').innerHTML=`<div class="student-summary-strip"><button type="button" class="extra-summary-button" onclick="openExtraModal('${period}',${studentId})"><span>Puntos extra</span><b class="extra-good">+${ex.goodAvailable}</b><b class="extra-bad">${formatBadExtras(ex.bad)}</b><small>Editar</small></button><div><span>Prom. trabajos</span><strong>${fmtNum(gr.work_avg)}</strong></div><div><span>Final actual</span><strong>${gr.final_grade==null?'Pendiente':fmtNum(gr.final_grade)}</strong></div></div><div class="student-section-title"><h3>Actividades</h3><span>Califica alumno por alumno</span></div><div class="student-activities-list">${activities}</div><div class="student-section-title"><h3>Componentes</h3></div>${principal}<div class="student-component-card"><div><strong>Valores</strong><small>0 a 10</small></div><div class="student-score-box"><input id="${valueId}" class="drawer-score-input" data-kind="component" data-field="values_score" data-period="${period}" data-student="${studentId}" data-max="10" value="${escapeHtml(valuesVal)}" placeholder="—">${quickButtonsHTML(valueId,10)}</div></div><div class="student-component-card"><div><strong>Actitudes</strong><small>0 a 10</small></div><div class="student-score-box"><input id="${attId}" class="drawer-score-input" data-kind="component" data-field="attitudes_score" data-period="${period}" data-student="${studentId}" data-max="10" value="${escapeHtml(attVal)}" placeholder="—">${quickButtonsHTML(attId,10)}</div></div>`;
  $$('#studentDrawer .drawer-score-input').forEach(inp=>inp.addEventListener('input',()=>{inp.classList.add('changed');setSaveState('changed','Cambios sin guardar');}));
  $('#studentDrawer').classList.remove('hidden');$('#studentDrawer').setAttribute('aria-hidden','false');document.body.classList.add('drawer-open');
  updateStudentDrawerNav(pd);
};

function updateStudentDrawerNav(pd){
  const ids=pd.students.map(s=>+s.id),idx=ids.indexOf(+studentDrawerState.studentId),last=idx>=ids.length-1;
  $('#studentPrev').disabled=idx<=0;$('#studentNext').disabled=idx<0||last;$('#studentSaveNext').disabled=idx<0;
  $('#studentSaveNext').textContent=last?'Guardar alumno':'Guardar y siguiente →';
}

async function commitStudentDrawer(move=0,targetStudentId=null){
  if(!studentDrawerState.studentId)return;
  const {period,studentId}=studentDrawerState;
  for(const src of $$('#studentDrawer .drawer-score-input')){
    let target=null;
    if(src.dataset.kind==='grade')target=document.querySelector(`.notebook-score-input[data-kind="grade"][data-period="${period}"][data-student="${studentId}"][data-activity="${src.dataset.activity}"]`);
    else target=document.querySelector(`.notebook-score-input[data-kind="component"][data-period="${period}"][data-student="${studentId}"][data-field="${src.dataset.field}"]`);
    if(target&&target.value!==src.value){target.dataset.focusValue=target.value;target.value=src.value;target.dispatchEvent(new Event('input',{bubbles:true}));}
  }
  clearTimeout(notebookAutoSaveTimer);
  const ok=await saveNotebookChanges({silent:true,noReload:true,skipSummary:true});if(!ok)return;
  const pd=notebookData.periods?.[period]||await buildNotebookPeriodData(notebookData.group.id,period),ids=pd.students.map(s=>+s.id),idx=ids.indexOf(+studentId);
  const next=targetStudentId!=null?+targetStudentId:ids[idx+move];
  if((targetStudentId!=null||move)&&next)await openStudentView(period,next);else toast('Alumno guardado');
}

function renderStudentDrawerSearch(){
  const input=$('#studentDrawerSearch'),box=$('#studentDrawerSearchResults');
  if(!input||!box||!studentDrawerState.period||!notebookData)return;
  const q=normalizeText(input.value),raw=String(input.value||'').trim();
  if(!q){box.innerHTML='';box.classList.add('hidden');return;}
  const pd=notebookData.periods?.[studentDrawerState.period];
  if(!pd)return;
  const matches=pd.students.filter(s=>{
    const name=normalizeText(studentLabel(s)),num=String(s.list_number??'');
    return name.includes(q)||(raw&&num.includes(raw));
  }).slice(0,8);
  box.innerHTML=matches.length?matches.map(s=>`<button type="button" class="student-search-result" onclick="jumpToStudentView(${s.id})"><b>${s.list_number??'—'}</b><span>${escapeHtml(studentLabel(s))}</span></button>`).join(''):'<div class="student-search-empty">Sin coincidencias</div>';
  box.classList.remove('hidden');
}
window.jumpToStudentView=async function(studentId){
  const box=$('#studentDrawerSearchResults');if(box)box.classList.add('hidden');
  if(+studentId===+studentDrawerState.studentId)return;
  await commitStudentDrawer(0,+studentId);
};
const studentDrawerSearch=$('#studentDrawerSearch');
if(studentDrawerSearch){
  studentDrawerSearch.addEventListener('input',renderStudentDrawerSearch);
  studentDrawerSearch.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.currentTarget.value='';renderStudentDrawerSearch();e.currentTarget.blur();}
    if(e.key==='Enter'){
      e.preventDefault();const first=$('#studentDrawerSearchResults .student-search-result');if(first)first.click();
    }
  });
}

function closeStudentDrawer(){
  const d=$('#studentDrawer');if(!d)return;
  const dirty=$$('#studentDrawer .drawer-score-input.changed').length>0;
  if(dirty&&!confirm('Hay cambios en este alumno que todavía no se guardan. ¿Cerrar y descartarlos?'))return;
  d.classList.add('hidden');d.setAttribute('aria-hidden','true');document.body.classList.remove('drawer-open');studentDrawerState={period:null,studentId:null};
  if(dirty)setSaveState('saved','Todo guardado');
}
$('#studentDrawerClose').onclick=closeStudentDrawer;$('#studentDrawerBackdrop').onclick=closeStudentDrawer;
$('#studentPrev').onclick=()=>commitStudentDrawer(-1);$('#studentNext').onclick=()=>commitStudentDrawer(1);$('#studentSaveNext').onclick=async()=>{
  const pd=notebookData?.periods?.[studentDrawerState.period]||await buildNotebookPeriodData(notebookData.group.id,studentDrawerState.period);
  const ids=pd.students.map(s=>+s.id),idx=ids.indexOf(+studentDrawerState.studentId);
  await commitStudentDrawer(idx>=ids.length-1?0:1);
};

// Las preferencias de navegación son auxiliares; los datos académicos permanecen en IndexedDB.
updateAppNav();

window.addEventListener('error',e=>{console.error(e.error||e.message);const b=$('#fatalBanner');b.textContent='Error de interfaz: '+(e.message||'desconocido');b.classList.remove('hidden');});

init();
