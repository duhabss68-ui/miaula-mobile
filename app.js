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
let notebookAutoSavePending=false;
let undoHideTimer=null;
let classMode=false;
let studentDrawerState={period:null,studentId:null};
let lastStudentQuickScore=null;
let notebookTeamState={groupId:null,active:false,selectedIndex:0,teams:[]};
let pendingProjectTeam=null;
let manualTeamBuilder={open:false,gid:null,students:[],teamCount:0,assignments:new Map(),activeTeam:null};
let manualTeamSaveChain=Promise.resolve();

const dynamics={
  mode:'roulette',
  students:[],
  used:new Set(),
  rotation:0,
  spinning:false,
  teams:[],
  teamGroupId:null,
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
function fmtShort(v,d=1){
  const t=fmtNum(v,d);return t.includes('.')?t.replace(/\.?0+$/,''):t;
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
  const level=available<=0?' zero':available<=3?' low':available<=6?' mid':' ok';
  return `<small class="activity-daily-max${level}" title="Indicador según días hábiles transcurridos; no limita la calificación que captures.">Máx. ${fmtShort(available,1)}</small>`;
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
  const canvas=$('#rouletteCanvas');
  if(canvas){canvas.style.transition='none';canvas.style.transform='rotate(0deg)';setTimeout(()=>canvas.style.transition='',0);}
  if($('#rouletteNumber')) $('#rouletteNumber').textContent='';
  if($('#rouletteName')) $('#rouletteName').textContent='Gira la ruleta';
  dynamics.lastWinner=null;
  dynamics.winnerRated=false;
  dynamics.ratingBusy=false;
  const extraActions=$('#rouletteExtraActions');
  if(extraActions) extraActions.classList.add('hidden');
  if($('#rouletteExtraStatus')) $('#rouletteExtraStatus').textContent='';
  renderUsedStudents();
  drawWheel();
}

function goView(name){
  if(currentView==='dynamics' && name!=='dynamics'){ resetDynamicsSession(); exitRouletteFullscreen(); }
  if(currentView==='notebook' && name!=='notebook'){ closeStudentDrawer(); window.MiAulaKeypad?.close(); }
  currentView=name;
  document.body.classList.toggle('notebook-view-active',name==='notebook');
  const mainMenuBtn=$('#mainMenuBtn');
  if(mainMenuBtn) mainMenuBtn.classList.toggle('hidden',name==='dashboard');
  $$('.view').forEach(v=>v.classList.remove('active'));
  $('#view-'+name)?.classList.add('active');
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  $('#viewTitle').textContent={
    dashboard:'Inicio',groups:'Mis grupos',attendance:'Asistencia',attendanceHistory:'Historial de asistencia',dynamics:'Ruleta y equipos',
    activities:'Calificaciones',notebook:'Cuaderno digital',grading:'Parcial',evaluation:'Proyecto',more:'Administración'
  }[name]||name;
  updateAppNav();
  if(name==='dashboard') loadSummary();
  if(name==='attendanceHistory'){renderAttendanceMonitor();renderSecretaryPendingList();}
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
  navigator.serviceWorker.register('sw.js?v=2.10.1',{updateViaCache:'none'}).then(reg=>{
    reg.update().catch(()=>{});
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='visible')reg.update().catch(()=>{});
    });
  }).catch(()=>{});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(swControllerChanged)return;
    swControllerChanged=true;
    if(typeof showUpdateBanner==='function')showUpdateBanner();else toast('MiAula se actualizó. La nueva versión quedará activa al volver a abrir la app.');
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
  ['#importGroup','#attendanceGroup','#attendanceHistoryGroup','#dynamicsGroup','#activityGroup','#activityFilter','#notebookGroup','#gradingGroup','#evalGroup','#exportGroup','#contextGroup'].forEach(id=>{
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
  const totalHours=att.reduce((n,a)=>n+(a.status==='S'?0:(+a.class_hours||1)),0);
  const attendedHours=att.reduce((n,a)=>n+((a.status==='F'||a.status==='S')?0:(+a.class_hours||1)),0);
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
    const th=ga.reduce((n,a)=>n+(a.status==='S'?0:(+a.class_hours||1)),0);
    const ah=ga.reduce((n,a)=>n+((a.status==='F'||a.status==='S')?0:(+a.class_hours||1)),0);
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

function openModal(title,html){const card=$('#modal .modal-card');if(card)card.className='modal-card';$('#modalBody').onclick=null;$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').classList.remove('hidden');}
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

function isSecretaryPendingStudent(student){
  return !!(student && (student.secretary_pending===1 || student.secretary_pending===true));
}

async function loadAttendance(){
  const gid=+$('#attendanceGroup').value,dt=$('#attendanceDate').value;
  if(!gid){toast('Selecciona un grupo',true);return;}
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const existing=await MiAulaDB.byIndex('attendance','group_date',[gid,dt]);
  const em=new Map(existing.map(a=>[a.student_id,a]));
  if(existing.length) $('#attendanceHours').value=String(existing[0].class_hours||1);
  attendanceData=students.map(student=>{
    const old=em.get(student.id);
    const pending=isSecretaryPendingStudent(student);
    return {
      student_id:student.id,
      list_number:student.list_number,
      name:studentLabel(student),
      secretary_pending:pending,
      status:old?.status||(pending?'S':'F'),
      notes:old?.notes||''
    };
  });
  renderAttendance();
}

function attendanceStatusButtons(row,i){
  if(row.secretary_pending){
    return `<div class="status-buttons secretary-status"><span class="secretary-state">Pendiente Secretaría</span><button class="btn small subtle" type="button" onclick="resolveSecretaryPending(${row.student_id})">Resolver</button></div>`;
  }
  const buttons=['P','F','R','J'].map(st=>`<button class="status-btn ${row.status===st?'active':''}" data-status="${st}" onclick="setStatus(${i},'${st}',this)">${st}</button>`).join('');
  const unresolved=row.status==='S'?'<span class="secretary-correction-note">Pendiente de corregir</span>':'';
  return `<div class="attendance-row-actions"><div class="status-buttons">${buttons}</div>${unresolved}<button class="btn small secretary-mark-btn" type="button" onclick="markSecretaryPending(${i})">Secretaría</button></div>`;
}

function renderAttendance(){
  $('#attendanceList').className='student-list';
  $('#attendanceList').innerHTML=attendanceData.length?attendanceData.map((row,i)=>`<div class="student-row ${row.secretary_pending?'secretary-pending-row':''}" data-index="${i}"><div class="num">${row.list_number??'—'}</div><div><strong>${escapeHtml(row.name)}</strong>${row.secretary_pending?'<span class="secretary-inline-badge">Por confirmar</span>':''}<div class="student-sub">${escapeHtml(groups.find(g=>g.id===+$('#attendanceGroup').value)?.name||'')}</div></div>${attendanceStatusButtons(row,i)}</div>`).join(''):'<div class="empty-state">Este grupo no tiene alumnos activos.</div>';
  $('#saveAttendance').classList.toggle('hidden',!attendanceData.length);
  $('#attendanceStats').classList.toggle('hidden',!attendanceData.length);
  updateAttendanceStats();
}

window.setStatus=(i,st,el)=>{
  if(attendanceData[i]?.secretary_pending){toast('Primero resuelve el estado pendiente con Secretaría',true);return;}
  attendanceData[i].status=st;
  try{navigator.vibrate?.(10);}catch{}
  el.parentElement.querySelectorAll('button.status-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  const note=el.closest('.attendance-row-actions')?.querySelector('.secretary-correction-note');if(note)note.remove();
  updateAttendanceStats();
};

function updateAttendanceStats(){
  if(!attendanceData.length)return;
  const hours=Math.max(1,+$('#attendanceHours').value||1),counts={P:0,F:0,R:0,J:0,S:0};
  attendanceData.forEach(row=>counts[row.status]=(counts[row.status]||0)+hours);
  $('#attendanceStats').innerHTML=[
    ['Alumnos',attendanceData.length],['Bloque',hours+' h'],['Presentes',counts.P+' h'],['Faltas',counts.F+' h'],['Retardos',counts.R+' h'],['Justificadas',counts.J+' h'],['Secretaría',counts.S+' h']
  ].map(x=>`<div class="attendance-stat"><span>${x[0]}</span><strong>${x[1]}</strong></div>`).join('');
}

async function upsertAttendanceStatus(gid,studentId,dt,status,hours,notes=''){
  const old=await MiAulaDB.firstByIndex('attendance','unique_key',[+gid,+studentId,dt]);
  const rec={...(old||{}),group_id:+gid,student_id:+studentId,attendance_date:dt,status,notes:notes||old?.notes||'',class_hours:Math.max(1,+hours||1),updated_at:new Date().toISOString()};
  if(old)await MiAulaDB.put('attendance',rec);else await MiAulaDB.add('attendance',rec);
  return rec;
}

window.markSecretaryPending=async(i)=>{
  const row=attendanceData[i];if(!row)return;
  const student=await MiAulaDB.get('students',row.student_id);if(!student)return;
  if(!confirm(`¿Marcar a ${studentLabel(student)} como pendiente de confirmar con Secretaría?\n\nNo se eliminará ningún dato y, mientras esté pendiente, no contará como asistencia ni falta.`))return;
  student.secretary_pending=1;
  student.secretary_pending_since=new Date().toISOString();
  student.secretary_pending_reason='Cambio de grupo/carrera por confirmar';
  await MiAulaDB.put('students',student);
  row.secretary_pending=true;row.status='S';
  const gid=+$('#attendanceGroup').value,dt=$('#attendanceDate').value,hours=Math.max(1,+$('#attendanceHours').value||1);
  if(gid&&dt)await upsertAttendanceStatus(gid,row.student_id,dt,'S',hours,'Pendiente de confirmar con Secretaría');
  renderAttendance();
  await renderSecretaryPendingList();
  await loadSummary();
  toast('Alumno marcado como Pendiente Secretaría');
};

window.resolveSecretaryPending=async(studentId)=>{
  const student=await MiAulaDB.get('students',+studentId);if(!student)return;
  openModal(`Confirmación · ${studentLabel(student)}`,`
    <div class="secretary-resolve-copy">
      <span class="secretary-state large">Pendiente Secretaría</span>
      <p>Selecciona la respuesta después de confirmar con Secretaría. Ninguna opción borra el historial anterior.</p>
    </div>
    <div class="secretary-resolve-actions">
      <button class="btn primary wide" id="secretaryKeepsStudent" type="button">Sí continúa en el grupo</button>
      <button class="btn danger wide" id="secretaryWithdrawStudent" type="button">Dar de baja · conservar historial</button>
      <button class="btn wide" id="secretaryCancelResolve" type="button">Cancelar</button>
    </div>`);
  $('#secretaryCancelResolve').onclick=closeModal;
  $('#secretaryKeepsStudent').onclick=async()=>{
    student.secretary_pending=0;
    student.secretary_resolved_at=new Date().toISOString();
    student.secretary_resolution='continues';
    await MiAulaDB.put('students',student);
    closeModal();
    if(currentView==='attendance')await loadAttendance();
    await renderSecretaryPendingList();await renderAttendanceMonitor();await loadSummary();
    toast('Alumno confirmado en el grupo. Corrige los días pendientes desde Historial.');
  };
  $('#secretaryWithdrawStudent').onclick=async()=>{
    if(!confirm(`¿Dar de baja a ${studentLabel(student)}?\n\nSe conservarán asistencias, calificaciones, evaluaciones e historial.`))return;
    student.secretary_pending=0;
    student.secretary_resolved_at=new Date().toISOString();
    student.secretary_resolution='withdrawn';
    await MiAulaDB.put('students',student);
    await MiAulaDB.deactivateStudent(student.id);
    closeModal();
    if(currentView==='attendance')await loadAttendance();
    await renderSecretaryPendingList();await renderAttendanceMonitor();await loadSummary();
    toast('Alumno dado de baja; historial conservado');
  };
};

$('#saveAttendance').onclick=async()=>{
  const gid=+$('#attendanceGroup').value,dt=$('#attendanceDate').value,hours=Math.max(1,+$('#attendanceHours').value||1);
  try{
    for(const row of attendanceData){
      await upsertAttendanceStatus(gid,row.student_id,dt,row.secretary_pending?'S':row.status,hours,row.notes||'');
    }
    toast(`Asistencia guardada · ${hours} hora${hours===1?'':'s'} contabilizadas`);
    await loadSummary();
    if(currentView==='attendanceHistory'){await renderAttendanceMonitor();await renderSecretaryPendingList();}
    if(currentView==='dynamics') await loadDynamicsStudents(true);
  }catch(e){toast(e.message,true);}
};

// -------------------- HISTORIAL Y SEGUIMIENTO ACUMULADO --------------------
function absenceRiskMeta(pct){
  const value=Number.isFinite(+pct)?+pct:0;
  if(value>=20)return {key:'critical',label:'20% o más',detail:'Límite alcanzado'};
  if(value>=15)return {key:'warning',label:'Cerca del 20%',detail:'Revisar asistencia'};
  return {key:'ok',label:'En rango',detail:'Seguimiento normal'};
}
function fmtPct(v){return v==null||!Number.isFinite(+v)?'—':`${(+v).toFixed(1)}%`;}
function attendanceHistoryGroupId(){return +($('#attendanceHistoryGroup')?.value||$('#attendanceGroup')?.value||0);}

async function renderSecretaryPendingList(){
  const box=$('#secretaryPendingList');if(!box)return;
  const gid=attendanceHistoryGroupId();
  if(!gid){box.innerHTML='<div class="empty-state">Selecciona un grupo para revisar pendientes.</div>';return;}
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).filter(isSecretaryPendingStudent).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  box.innerHTML=students.length?`<div class="secretary-pending-grid">${students.map(student=>`<div class="secretary-pending-card"><div><span>No. ${student.list_number??'—'}</span><strong>${escapeHtml(studentLabel(student))}</strong><small>Desde ${student.secretary_pending_since?new Date(student.secretary_pending_since).toLocaleDateString('es-MX'):'—'}</small></div><button class="btn small subtle" type="button" onclick="resolveSecretaryPending(${student.id})">Resolver</button></div>`).join('')}</div>`:'<div class="empty-state">No hay alumnos pendientes de confirmar con Secretaría.</div>';
}

async function renderAttendanceMonitor(){
  const summary=$('#attendanceMonitorSummary'),table=$('#attendanceMonitorTable');
  if(!summary||!table)return;
  const gid=attendanceHistoryGroupId();
  if(!gid){
    summary.innerHTML='<div class="empty-state">Selecciona un grupo para ver el seguimiento acumulado.</div>';
    table.innerHTML='';
    return;
  }
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const records=await MiAulaDB.byIndex('attendance','group_id',gid);
  const byStudent=new Map();
  for(const r of records){if(!byStudent.has(r.student_id))byStudent.set(r.student_id,[]);byStudent.get(r.student_id).push(r);}
  const rows=students.map(student=>{
    const totals=attendanceTotals(byStudent.get(student.id)||[]);
    const risk=absenceRiskMeta(totals.absencePct);
    return {student,totals,risk};
  });
  const pending=students.filter(isSecretaryPendingStudent).length;
  const normalRows=rows.filter(r=>!isSecretaryPendingStudent(r.student));
  const critical=normalRows.filter(r=>(r.totals.absencePct||0)>=20).length;
  const warning=normalRows.filter(r=>(r.totals.absencePct||0)>=15&&(r.totals.absencePct||0)<20).length;
  const inRange=normalRows.filter(r=>(r.totals.absencePct||0)<15).length;
  const classBlocks=new Map();
  for(const r of records){const k=r.attendance_date;classBlocks.set(k,Math.max(classBlocks.get(k)||0,+r.class_hours||1));}
  const classHours=[...classBlocks.values()].reduce((a,b)=>a+b,0);
  const pctRows=normalRows.filter(r=>r.totals.absencePct!=null);
  const groupAbsence=pctRows.length?pctRows.reduce((n,r)=>n+(r.totals.absencePct||0),0)/pctRows.length:0;
  summary.innerHTML=`
    <div class="attendance-monitor-kpi"><span>Horas registradas</span><strong>${classHours||0}</strong><small>del grupo</small></div>
    <div class="attendance-monitor-kpi risk-ok"><span>En rango</span><strong>${inRange}</strong><small>menos de 15%</small></div>
    <div class="attendance-monitor-kpi risk-warning"><span>Cerca del límite</span><strong>${warning}</strong><small>15% a 19.9%</small></div>
    <div class="attendance-monitor-kpi risk-critical"><span>20% o más</span><strong>${critical}</strong><small>requieren atención</small></div>
    <div class="attendance-monitor-kpi"><span>Pend. Secretaría</span><strong>${pending}</strong><small>fuera del cálculo</small></div>
    <div class="attendance-monitor-kpi"><span>Promedio faltas</span><strong>${pctRows.length?groupAbsence.toFixed(1)+'%':'—'}</strong><small>grupo activo</small></div>`;
  if(!rows.length){table.innerHTML='<div class="empty-state">Este grupo no tiene alumnos activos.</div>';return;}
  table.innerHTML=`<div class="table-wrap"><table class="attendance-monitor-grid"><thead><tr><th>No.</th><th>Alumno</th><th>Hrs</th><th>P</th><th>F</th><th>R</th><th>J</th><th>Sec.</th><th>Faltas</th><th>Estado</th><th></th></tr></thead><tbody>${rows.map(({student,totals,risk})=>`<tr class="attendance-risk-row ${risk.key} ${isSecretaryPendingStudent(student)?'secretary-pending-monitor':''}"><td>${student.list_number??'—'}</td><td><strong>${escapeHtml(studentLabel(student))}</strong>${isSecretaryPendingStudent(student)?'<span class="secretary-inline-badge">Pendiente</span>':''}</td><td>${totals.total}</td><td>${totals.P}</td><td class="absence-hours">${totals.F}</td><td>${totals.R}</td><td>${totals.J}</td><td>${totals.S}</td><td><strong class="absence-pct ${risk.key}">${fmtPct(totals.absencePct)}</strong></td><td>${isSecretaryPendingStudent(student)?'<span class="secretary-state">Pendiente Secretaría</span>':`<span class="attendance-risk-badge ${risk.key}">${risk.label}</span>`}</td><td><div class="action-row"><button class="btn small subtle" type="button" onclick="openAttendanceHistory(${student.id})">Historial / corregir</button>${isSecretaryPendingStudent(student)?`<button class="btn small" type="button" onclick="resolveSecretaryPending(${student.id})">Resolver</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`;
}
window.renderAttendanceMonitor=renderAttendanceMonitor;

async function openAttendanceHistory(studentId){
  const student=await MiAulaDB.get('students',+studentId);if(!student)return;
  const records=(await MiAulaDB.byIndex('attendance','student_id',+studentId)).sort((a,b)=>String(b.attendance_date).localeCompare(String(a.attendance_date)));
  const totals=attendanceTotals(records),risk=absenceRiskMeta(totals.absencePct);
  const statusLabels={P:'Presente',F:'Falta',R:'Retardo',J:'Justificada',S:'Pendiente Secretaría'};
  const rows=records.length?records.map(r=>`<tr><td><strong>${escapeHtml(r.attendance_date)}</strong></td><td>${+r.class_hours||1} h</td><td><select class="attendance-history-status" data-attendance-id="${r.id}">${['P','F','R','J','S'].map(st=>`<option value="${st}" ${r.status===st?'selected':''}>${st} · ${statusLabels[st]}</option>`).join('')}</select></td><td><button type="button" class="btn small subtle" onclick="openAttendanceDay('${escapeHtml(r.attendance_date)}')">Abrir día</button></td></tr>`).join(''):'<tr><td colspan="4">Sin registros todavía.</td></tr>';
  openModal(`Asistencia · ${studentLabel(student)}`,`
    <div class="attendance-history-summary">
      <div><span>Horas computables</span><strong>${totals.total}</strong></div>
      <div><span>Presentes</span><strong>${totals.P}</strong></div>
      <div><span>Faltas</span><strong class="danger-text">${totals.F}</strong></div>
      <div><span>Pend. Secretaría</span><strong>${totals.S}</strong></div>
      <div><span>% faltas</span><strong class="${risk.key==='critical'?'danger-text':risk.key==='warning'?'warning-text':''}">${fmtPct(totals.absencePct)}</strong></div>
    </div>
    <div class="attendance-history-alert ${risk.key}"><strong>${risk.label}</strong><span>${risk.detail}. Los registros S quedan fuera del cálculo hasta que los corrijas.</span></div>
    <div class="table-wrap attendance-history-wrap"><table><thead><tr><th>Fecha</th><th>Horas</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <button class="btn primary wide" id="saveAttendanceHistory" type="button" ${records.length?'':'disabled'}>Guardar correcciones</button>`);
  const save=$('#saveAttendanceHistory');
  if(save)save.onclick=async()=>{
    save.disabled=true;
    try{
      const controls=$$('.attendance-history-status');
      for(const sel of controls){
        const rec=await MiAulaDB.get('attendance',+sel.dataset.attendanceId);if(!rec)continue;
        if(rec.status!==sel.value){rec.status=sel.value;rec.updated_at=new Date().toISOString();await MiAulaDB.put('attendance',rec);}
      }
      closeModal();
      await renderAttendanceMonitor();await renderSecretaryPendingList();
      if(currentView==='attendance'&&$('#attendanceDate')?.value)await loadAttendance();
      await loadSummary();
      toast('Asistencia histórica actualizada sin borrar registros');
    }catch(e){toast(e.message,true);save.disabled=false;}
  };
}
window.openAttendanceHistory=openAttendanceHistory;
window.openAttendanceDay=async(date)=>{
  closeModal();
  const gid=attendanceHistoryGroupId();
  if(gid&&$('#attendanceGroup'))$('#attendanceGroup').value=String(gid);
  goView('attendance');
  if($('#attendanceDate'))$('#attendanceDate').value=date;
  await loadAttendance();
  document.querySelector('#view-attendance .attendance-toolbar')?.scrollIntoView({behavior:'smooth',block:'start'});
};

$('#openAttendanceHistorySection')?.addEventListener('click',async()=>{
  const gid=+$('#attendanceGroup').value||+$('#contextGroup')?.value||0;
  if(gid&&$('#attendanceHistoryGroup'))$('#attendanceHistoryGroup').value=String(gid);
  goView('attendanceHistory');
});
$('#backToAttendance')?.addEventListener('click',()=>{
  const gid=+$('#attendanceHistoryGroup').value||0;if(gid&&$('#attendanceGroup'))$('#attendanceGroup').value=String(gid);
  goView('attendance');
});
$('#refreshAttendanceMonitor')?.addEventListener('click',async()=>{await renderAttendanceMonitor();await renderSecretaryPendingList();});
$('#attendanceHistoryGroup')?.addEventListener('change',async()=>{syncContextFromControl('#attendanceHistoryGroup');await renderAttendanceMonitor();await renderSecretaryPendingList();});

// -------------------- RULETA Y EQUIPOS --------------------
$$('#dynamicsTabs button').forEach(btn=>btn.onclick=()=>setDynamicsMode(btn.dataset.mode));
$('#dynamicsGroup').onchange=()=>{closeManualTeamBuilder();loadDynamicsStudents(true);};
$('#dynamicsPresentOnly').onchange=()=>{if(dynamics.mode==='roulette')loadDynamicsStudents(true);};
$('#resetWheel').onclick=()=>{resetDynamicsSession();updateRouletteCounter();toast('Ruleta reiniciada');};
$('#spinWheel').onclick=spinWheel;
$('#fullscreenWheel').onclick=toggleRouletteFullscreen;
$('#rouletteGood').onclick=()=>recordRouletteExtra('good');
$('#rouletteBad').onclick=()=>recordRouletteExtra('bad');
$('#generateTeams').onclick=generateTeams;
$('#manualTeams')?.addEventListener('click',openManualTeamBuilder);
$('#addManualTeam')?.addEventListener('click',addManualTeam);
$('#removeManualTeam')?.addEventListener('click',removeManualTeam);
$('#cancelManualTeams')?.addEventListener('click',closeManualTeamBuilder);
$('#saveManualTeams')?.addEventListener('click',saveManualTeams);
$('#manualTeamRoster')?.addEventListener('click',handleManualTeamClick);
$('#teamSize')?.addEventListener('change',()=>{if(manualTeamBuilder.open){renderManualTeamBuilder();queueManualTeamDraftSave();}});
$('#copyTeams').onclick=copyTeams;
$('#clearTeams')?.addEventListener('click',clearSavedTeams);
$('#openTeamNotebook')?.addEventListener('click',()=>openTeamNotebook(+$('#dynamicsGroup').value,0));

function setDynamicsMode(mode){
  dynamics.mode=mode;
  $$('#dynamicsTabs button').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  $('#rouletteMode').classList.toggle('hidden',mode!=='roulette');
  $('#teamsMode').classList.toggle('hidden',mode!=='teams');
  $('#presentOnlyWrap')?.classList.toggle('hidden',mode==='teams');
  if(mode!=='roulette'){
    dynamics.used.clear();dynamics.rotation=0;renderUsedStudents();drawWheel();exitRouletteFullscreen();
  }
  if(mode==='teams'){
    loadDynamicsStudents(false);
    loadSavedTeamsForDynamics();
  }
  updateAppNav();
}

async function loadDynamicsStudents(reset=true){
  const gid=+$('#dynamicsGroup').value;
  if(!gid){dynamics.students=[];$('#dynamicsSourceInfo').textContent='Selecciona un grupo.';drawWheel();updateRouletteCounter();return;}
  let students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const secretaryPendingCount=students.filter(isSecretaryPendingStudent).length;
  students=students.filter(s=>!isSecretaryPendingStudent(s));
  let note=`${students.length} alumnos activos${secretaryPendingCount?` · ${secretaryPendingCount} pendiente${secretaryPendingCount===1?'':'s'} Secretaría excluido${secretaryPendingCount===1?'':'s'}`:''}`;
  if(dynamics.mode==='roulette' && $('#dynamicsPresentOnly').checked){
    const attendance=await MiAulaDB.byIndex('attendance','group_date',[gid,today]);
    if(attendance.length){
      const presentIds=new Set(attendance.filter(a=>!['F','S'].includes(a.status)).map(a=>a.student_id));
      students=students.filter(s=>presentIds.has(s.id));
      note=`${students.length} presentes hoy · se excluyen faltas`;
    }else{
      note=`No hay asistencia guardada hoy · se usarán los ${students.length} alumnos activos`;
    }
  }else if(dynamics.mode==='teams'){
    note=`${students.length} alumnos del grupo · equipos independientes de la asistencia`;
  }
  dynamics.students=students;
  $('#dynamicsSourceInfo').textContent=note;
  if(reset) resetDynamicsSession();
  if(dynamics.mode==='teams') await loadSavedTeamsForDynamics(gid);
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
    ctx.fillStyle=style.text;ctx.font=`950 ${students.length>42?17:students.length>30?20:students.length>20?24:30}px Segoe UI,Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(used?String(s.list_number??i+1):'?',tx,ty);
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
  if(typeof launchConfetti==='function')launchConfetti();
  await refreshWinnerExtraStatus();
  const result=$('#rouletteResultPanel');
  if(result){result.classList.remove('winner-pop');void result.offsetWidth;result.classList.add('winner-pop');setTimeout(()=>result.classList.remove('winner-pop'),900);}
  renderUsedStudents();
  // Regresa visualmente la rueda a su orientación base manteniendo marcado al alumno que ya salió.
  canvas.style.transition='none';canvas.style.transform='rotate(0deg)';dynamics.rotation=0;drawWheel();
  requestAnimationFrame(()=>requestAnimationFrame(()=>canvas.style.transition=''));
  dynamics.spinning=false;updateRouletteCounter();
}

function teamsMetaKey(gid){return `savedTeams:${+gid}`;}
function teamMemberCount(team){return Array.isArray(team?.member_ids)?team.member_ids.length:Array.isArray(team?.members)?team.members.length:0;}
// Todo equipo con al menos un integrante puede calificarse. “Completo” es solo un estado visual.
function isUsableTeam(team){return teamMemberCount(team)>=1;}
function isCompleteTeam(team){return team?.complete!==false&&teamMemberCount(team)>=1;}
async function readSavedTeams(gid){
  gid=+gid||0;if(!gid)return {record:null,teams:[]};
  const record=await MiAulaDB.get('meta',teamsMetaKey(gid));
  if(!record||!Array.isArray(record.teams))return {record:null,teams:[]};
  const students=await MiAulaDB.groupStudents(gid,{includeInactive:true}),sm=new Map(students.map(x=>[+x.id,x]));
  const preferred=+record.preferred_size||3;
  const draftMode=record.creation_mode==='manual-visual-draft'||record.is_draft===true;
  const teams=record.teams.map((t,i)=>{
    const memberIds=(t.member_ids||[]).map(Number).filter(Boolean);
    const inferredComplete=typeof t.complete==='boolean'?t.complete:(draftMode?memberIds.length>=preferred:memberIds.length>=2);
    return {
      name:t.name||`Equipo ${i+1}`,
      member_ids:memberIds,
      members:memberIds.map(id=>sm.get(+id)).filter(Boolean),
      complete:!!inferredComplete,
      source_index:i
    };
  }).filter(t=>t.member_ids.length);
  return {record,teams};
}
async function saveTeamsRecord(gid,teams,extra={}){
  gid=+gid;
  const prior=await MiAulaDB.get('meta',teamsMetaKey(gid));
  const record={
    ...(prior||{}),key:teamsMetaKey(gid),group_id:gid,
    teams:teams.map((t,i)=>({
      name:t.name||`Equipo ${i+1}`,
      member_ids:Array.isArray(t.member_ids)?t.member_ids.map(Number).filter(Boolean):(t.members||[]).map(s=>+s.id),
      ...(typeof t.complete==='boolean'?{complete:t.complete}:{})
    })),
    created_at:prior?.created_at||new Date().toISOString(),updated_at:new Date().toISOString(),...extra
  };
  await MiAulaDB.put('meta',record);return record;
}
function renderSavedTeams(teams,record=null){
  const gid=+$('#dynamicsGroup')?.value||0,box=$('#teamsResult'),info=$('#teamsSavedInfo');
  if(!box)return;
  if(!teams.length){
    box.innerHTML='<div class="empty-state">Aún no hay equipos guardados para este grupo. Créelos para poder usar la libreta por equipos.</div>';
    if(info)info.textContent='Sin equipos guardados';
    $('#openTeamNotebook')?.setAttribute('disabled','disabled');
    $('#clearTeams')?.setAttribute('disabled','disabled');
    return;
  }
  const completeCount=teams.filter(isCompleteTeam).length,formingCount=teams.filter(t=>isUsableTeam(t)&&!isCompleteTeam(t)).length,gradableCount=teams.filter(isUsableTeam).length;
  if(gradableCount)$('#openTeamNotebook')?.removeAttribute('disabled');else $('#openTeamNotebook')?.setAttribute('disabled','disabled');
  $('#clearTeams')?.removeAttribute('disabled');
  if(info){
    const d=record?.updated_at?new Date(record.updated_at).toLocaleDateString('es-MX'):'';
    info.textContent=`${completeCount} completos${formingCount?` · ${formingCount} en formación`:''}${record?.is_draft?' · borrador guardado':''}${d?` · ${d}`:''}`;
  }
  box.innerHTML=teams.map((t,i)=>{
    const complete=isCompleteTeam(t),usable=isUsableTeam(t),rawIndex=Number.isFinite(t.source_index)?t.source_index:i;
    const gradeActions=usable?`<button class="btn small subtle" onclick="openTeamNotebook(${gid},${rawIndex})">Libreta</button><button class="btn small primary" onclick="openTeamProject(${gid},${rawIndex})">Evaluar proyecto</button>`:'';
    const continueAction=!complete?`<button class="btn small" onclick="openManualTeamBuilder()">Continuar armando</button>`:'';
    return `<div class="team-card saved-team-card ${complete?'saved-complete':'saved-forming'}"><div class="team-card-head"><div><h3>${escapeHtml(t.name)} · ${t.members.length}</h3><small>${complete?'Equipo completo':'En formación · guardado · ya se puede calificar'}</small></div><span class="team-index">${rawIndex+1}</span></div><ul>${t.members.map(s=>`<li class="${s.active===0?'inactive-member':''}"><b>${s.list_number??'—'}</b><span>${escapeHtml(studentLabel(s))}</span>${s.active===0?'<small>Baja</small>':''}</li>`).join('')}</ul><div class="team-card-actions">${gradeActions}${continueAction}</div></div>`;
  }).join('');
}
async function loadSavedTeamsForDynamics(forcedGid=null){
  const gid=+forcedGid||+$('#dynamicsGroup')?.value||0;
  if(!gid){dynamics.teams=[];dynamics.teamGroupId=null;renderSavedTeams([],null);return;}
  const {record,teams}=await readSavedTeams(gid);
  dynamics.teamGroupId=gid;dynamics.teams=teams;renderSavedTeams(teams,record);
}
async function clearSavedTeams(){
  const gid=+$('#dynamicsGroup')?.value||0;if(!gid)return;
  const {teams}=await readSavedTeams(gid);if(!teams.length){toast('No hay equipos guardados.');return;}
  if(!confirm('¿Limpiar los equipos guardados de este grupo? No se borrarán calificaciones ni proyectos ya registrados.'))return;
  await manualTeamSaveChain.catch(()=>{});closeManualTeamBuilder();
  await MiAulaDB.remove('meta',teamsMetaKey(gid));
  dynamics.teams=[];dynamics.teamGroupId=gid;renderSavedTeams([],null);
  if(notebookTeamState.groupId===gid){notebookTeamState={groupId:gid,active:false,selectedIndex:0,teams:[]};}
  toast('Equipos limpiados · calificaciones conservadas');
}

async function teamRosterStudents(gid){
  return (await MiAulaDB.groupStudents(+gid,{includeInactive:false}))
    .filter(s=>!isSecretaryPendingStudent(s))
    .sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
}
function closeManualTeamBuilder(){
  manualTeamBuilder={open:false,gid:null,students:[],teamCount:0,assignments:new Map(),activeTeam:null};
  $('#manualTeamsPanel')?.classList.add('hidden');
}
async function openManualTeamBuilder(){
  const gid=+$('#dynamicsGroup')?.value||0;
  if(!gid){toast('Selecciona un grupo antes de armar equipos.',true);return;}
  const students=await teamRosterStudents(gid);
  if(students.length<2){toast('Este grupo no tiene suficientes alumnos activos para formar equipos.',true);return;}
  const record=await MiAulaDB.get('meta',teamsMetaKey(gid));
  if(record?.preferred_size&&$('#teamSize'))$('#teamSize').value=String(record.preferred_size);
  const assignments=new Map();
  const rawTeams=Array.isArray(record?.teams)?record.teams:[];
  let teamCount=Math.max(+record?.team_count||0,rawTeams.length,1);
  rawTeams.forEach((t,teamIndex)=>(t.member_ids||[]).forEach(id=>{
    if(students.some(s=>+s.id===+id))assignments.set(+id,teamIndex);
  }));
  const preferred=+$('#teamSize')?.value||3;
  let activeTeam=null;
  for(let i=0;i<teamCount;i++){
    const count=students.filter(st=>assignments.get(+st.id)===i).length;
    if(count<preferred){activeTeam=i;break;}
  }
  if(activeTeam==null&&assignments.size<students.length){teamCount+=1;activeTeam=teamCount-1;}
  manualTeamBuilder={open:true,gid,students,teamCount,assignments,activeTeam};
  $('#manualTeamsPanel')?.classList.remove('hidden');
  renderManualTeamBuilder();
  $('#manualTeamsPanel')?.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function manualTeamSnapshot(){
  if(!manualTeamBuilder.open)return null;
  const {gid,students,teamCount,assignments}=manualTeamBuilder,target=manualTeamTarget();
  const teams=Array.from({length:teamCount},(_,i)=>{
    const members=students.filter(s=>assignments.get(+s.id)===i);
    return {name:`Equipo ${i+1}`,members,complete:members.length>=target};
  });
  const assigned=assignments.size,unassigned=Math.max(0,students.length-assigned);
  const forming=teams.filter(t=>t.members.length>0&&!t.complete).length;
  return {gid,teams,teamCount,target,unassigned,forming,isDraft:unassigned>0||forming>0};
}
async function persistManualTeamSnapshot(snapshot,{renderSaved=false}={}){
  if(!snapshot)return null;
  const record=await saveTeamsRecord(snapshot.gid,snapshot.teams,{
    creation_mode:snapshot.isDraft?'manual-visual-draft':'manual-visual',
    is_draft:snapshot.isDraft,preferred_size:snapshot.target,team_count:snapshot.teamCount,
    unassigned_count:snapshot.unassigned,draft_saved_at:new Date().toISOString(),present_only:false
  });
  if(renderSaved){const saved=await readSavedTeams(snapshot.gid);dynamics.teams=saved.teams;dynamics.teamGroupId=snapshot.gid;renderSavedTeams(saved.teams,record);}
  return record;
}
function queueManualTeamDraftSave(){
  const snapshot=manualTeamSnapshot();if(!snapshot)return manualTeamSaveChain;
  const status=$('#teamsSavedInfo');if(status)status.textContent='Guardando borrador…';
  manualTeamSaveChain=manualTeamSaveChain.then(()=>persistManualTeamSnapshot(snapshot,{renderSaved:false})).then(()=>{
    if(status&&manualTeamBuilder.open&&+manualTeamBuilder.gid===+snapshot.gid)status.textContent=`Borrador guardado · ${snapshot.teams.filter(t=>t.complete).length} completos · ${snapshot.unassigned} por asignar`;
  }).catch(e=>{console.error('No se pudo guardar borrador de equipos',e);toast('No se pudo guardar el borrador de equipos.',true);});
  return manualTeamSaveChain;
}
function manualTeamMembers(teamIndex){
  return manualTeamBuilder.students.filter(s=>manualTeamBuilder.assignments.get(+s.id)===teamIndex);
}
function manualTeamTarget(){return +$('#teamSize')?.value||3;}
function updateManualTeamSummary(){
  const box=$('#manualTeamSummary');if(!box)return;
  const target=manualTeamTarget(),assigned=manualTeamBuilder.assignments.size,available=manualTeamBuilder.students.length-assigned;
  const completed=Array.from({length:manualTeamBuilder.teamCount},(_,i)=>manualTeamMembers(i)).filter(m=>m.length>=target).length;
  box.innerHTML=`<div class="manual-summary-main"><strong>${available} disponibles</strong><span>${assigned}/${manualTeamBuilder.students.length} asignados · ${completed} completos</span></div>`+
    `<div class="manual-legend"><span class="legend-forming">En formación</span><span class="legend-complete">Completo</span></div>`;
}
function renderManualTeamBuilder(){
  const box=$('#manualTeamRoster');if(!box||!manualTeamBuilder.open)return;
  const target=manualTeamTarget();
  const available=manualTeamBuilder.students.filter(st=>!manualTeamBuilder.assignments.has(+st.id));
  const availableHtml=available.length?available.map(st=>`<button type="button" class="manual-available-student" data-student="${st.id}"><b>${st.list_number??'—'}</b><span>${escapeHtml(studentLabel(st))}</span><small>Agregar</small></button>`).join(''):'<div class="manual-available-empty">Todos los alumnos ya están asignados.</div>';
  const teamsHtml=Array.from({length:manualTeamBuilder.teamCount},(_,i)=>{
    const members=manualTeamMembers(i),isComplete=members.length>=target,isActive=manualTeamBuilder.activeTeam===i;
    const stateClass=isComplete?'complete':members.length?'forming':'empty';
    const stateText=isComplete?'Completo':members.length?'En formación':'Vacío';
    const memberHtml=members.length?members.map(st=>`<button type="button" class="manual-member-chip" data-remove-student="${st.id}" title="Quitar y devolver a disponibles"><b>${st.list_number??'—'}</b><span>${escapeHtml(studentLabel(st))}</span><i>×</i></button>`).join(''):'<div class="manual-team-empty">Toca alumnos de la lista para agregarlos.</div>';
    return `<section class="manual-team-card ${stateClass} ${isActive?'active':''}" data-team="${i}">
      <button type="button" class="manual-team-card-head" data-select-team="${i}">
        <span><strong>Equipo ${i+1}</strong><small>${members.length}/${target} · ${stateText}</small></span>
        <em>${stateText}</em>
      </button>
      <div class="manual-team-members">${memberHtml}</div>
    </section>`;
  }).join('');
  box.innerHTML=`<div class="manual-builder-layout">
    <section class="manual-available-panel"><div class="manual-builder-title"><div><span class="eyebrow">Alumnos disponibles</span><h4>${available.length} por asignar</h4></div><small>Toca un alumno para agregarlo al equipo activo.</small></div><div class="manual-available-list">${availableHtml}</div></section>
    <section class="manual-teams-board"><div class="manual-builder-title"><div><span class="eyebrow">Equipos</span><h4>${manualTeamBuilder.teamCount} creados</h4></div><small>Azul/ámbar = formando · verde = completo.</small></div><div class="manual-team-cards">${teamsHtml}</div></section>
  </div>`;
  updateManualTeamSummary();
}
function selectManualTeam(index){
  if(!manualTeamBuilder.open)return;
  index=+index;if(index<0||index>=manualTeamBuilder.teamCount)return;
  if(manualTeamMembers(index).length>=3){toast(`Equipo ${index+1} ya tiene 3 integrantes.`,true);return;}
  manualTeamBuilder.activeTeam=index;renderManualTeamBuilder();
}
function addStudentToManualTeam(studentId){
  if(!manualTeamBuilder.open)return;
  const sid=+studentId;if(manualTeamBuilder.assignments.has(sid))return;
  let idx=manualTeamBuilder.activeTeam;
  if(idx==null){toast('Crea o selecciona un equipo en formación.',true);return;}
  const members=manualTeamMembers(idx);
  if(members.length>=3){toast(`Equipo ${idx+1} ya tiene 3 integrantes.`,true);return;}
  manualTeamBuilder.assignments.set(sid,idx);
  queueManualTeamDraftSave();
  const target=manualTeamTarget();
  if(manualTeamMembers(idx).length>=target)manualTeamBuilder.activeTeam=null;
  renderManualTeamBuilder();
}
function removeStudentFromManualTeam(studentId){
  if(!manualTeamBuilder.open)return;
  const sid=+studentId;if(!manualTeamBuilder.assignments.has(sid))return;
  const teamIndex=manualTeamBuilder.assignments.get(sid);
  manualTeamBuilder.assignments.delete(sid);
  queueManualTeamDraftSave();
  manualTeamBuilder.activeTeam=teamIndex;
  renderManualTeamBuilder();
}
function handleManualTeamClick(e){
  const add=e.target.closest?.('[data-student]');
  if(add){addStudentToManualTeam(add.dataset.student);return;}
  const remove=e.target.closest?.('[data-remove-student]');
  if(remove){removeStudentFromManualTeam(remove.dataset.removeStudent);return;}
  const select=e.target.closest?.('[data-select-team]');
  if(select){selectManualTeam(select.dataset.selectTeam);return;}
}
function handleManualTeamAssignment(){/* compatibilidad con versiones anteriores: la asignación actual se realiza por toque */}
function addManualTeam(){
  if(!manualTeamBuilder.open)return;
  const emptyIndex=Array.from({length:manualTeamBuilder.teamCount},(_,i)=>i).find(i=>manualTeamMembers(i).length===0);
  if(Number.isInteger(emptyIndex)){manualTeamBuilder.activeTeam=emptyIndex;renderManualTeamBuilder();queueManualTeamDraftSave();return;}
  manualTeamBuilder.teamCount+=1;
  manualTeamBuilder.activeTeam=manualTeamBuilder.teamCount-1;
  renderManualTeamBuilder();
  queueManualTeamDraftSave();
}
function removeManualTeam(){
  if(!manualTeamBuilder.open||manualTeamBuilder.teamCount<=1)return;
  const last=manualTeamBuilder.teamCount-1,members=manualTeamMembers(last);
  if(members.length&&!confirm(`Equipo ${last+1} tiene ${members.length} alumno(s). ¿Quitar el equipo y devolverlos a disponibles?`))return;
  members.forEach(st=>manualTeamBuilder.assignments.delete(+st.id));
  manualTeamBuilder.teamCount-=1;
  if(manualTeamBuilder.activeTeam>=manualTeamBuilder.teamCount)manualTeamBuilder.activeTeam=manualTeamBuilder.teamCount-1;
  renderManualTeamBuilder();
  queueManualTeamDraftSave();
}
async function saveManualTeams(){
  if(!manualTeamBuilder.open)return;
  const snapshot=manualTeamSnapshot();
  if(!snapshot||!snapshot.teams.some(t=>t.members.length)){toast('Todavía no has asignado alumnos a ningún equipo.',true);return;}
  try{
    await manualTeamSaveChain;
    const record=await persistManualTeamSnapshot(snapshot,{renderSaved:true});
    const complete=snapshot.teams.filter(t=>t.complete).length;
    const forming=snapshot.teams.filter(t=>t.members.length>0&&!t.complete).length;
    closeManualTeamBuilder();
    toast(snapshot.isDraft?`Borrador guardado · ${complete} completos${forming?` · ${forming} en formación`:''} · puedes continuar después`:`${complete} equipos guardados`);
    return record;
  }catch(e){console.error(e);toast(`No se pudieron guardar los equipos: ${e?.message||'error desconocido'}`,true);}
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
async function getTeamCandidateStudents(gid){
  gid=+gid||0;
  if(!gid)return {students:[],presentOnly:false,usedFallback:false};
  const allActive=(await MiAulaDB.groupStudents(gid,{includeInactive:false}))
    .filter(s=>!isSecretaryPendingStudent(s))
    .sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  return {students:allActive,presentOnly:false,usedFallback:false};
}

async function generateTeams(){
  const btn=$('#generateTeams'),gid=+$('#dynamicsGroup')?.value||0,preferred=+$('#teamSize')?.value||3;
  if(manualTeamBuilder.open){await manualTeamSaveChain.catch(()=>{});closeManualTeamBuilder();}
  if(!gid){toast('Selecciona un grupo antes de crear los equipos.',true);return;}
  if(btn){btn.disabled=true;btn.textContent='Creando equipos…';}
  try{
    const source=await getTeamCandidateStudents(gid);
    const pool=shuffled(source.students);
    dynamics.students=source.students;
    if(pool.length<2){
      toast('No hay al menos 2 alumnos activos disponibles en este grupo.',true);
      return;
    }
    const saved=await readSavedTeams(gid);
    if(saved.teams.length&&!confirm('Este grupo ya tiene equipos guardados. ¿Crear nuevos equipos y reemplazar la distribución actual?'))return;
    const sizes=teamSizes(pool.length,preferred);
    if(!sizes.length||sizes.some(n=>n<2))throw new Error('No fue posible distribuir el grupo sin dejar alumnos solos.');
    let pos=0;
    const teams=sizes.map((size,i)=>({name:`Equipo ${i+1}`,members:pool.slice(pos,pos+=size),complete:true}));
    if(teams.some(t=>t.members.length<2))throw new Error('La distribución generó un equipo incompleto.');
    const record=await saveTeamsRecord(gid,teams,{preferred_size:preferred,present_only:false,used_full_group_fallback:false,is_draft:false,team_count:teams.length,creation_mode:'automatic'});
    dynamics.teams=teams;dynamics.teamGroupId=gid;
    renderSavedTeams(teams,record);
    toast(`${teams.length} equipos creados y guardados · lista completa del grupo`);
  }catch(e){
    console.error('Error al crear equipos',e);
    toast(`No se pudieron crear los equipos: ${e?.message||'error desconocido'}`,true);
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Crear equipos automáticamente';}
  }
}
async function copyTeams(){
  if(!dynamics.teams.length)await loadSavedTeamsForDynamics();
  if(!dynamics.teams.length){toast('Primero crea los equipos.',true);return;}
  const text=dynamics.teams.map(t=>`${t.name}${isCompleteTeam(t)?'':' (EN FORMACIÓN)'}\n${t.members.map(s=>`${s.list_number}. ${studentLabel(s)}`).join('\n')}`).join('\n\n');
  try{await navigator.clipboard.writeText(text);toast('Equipos copiados');}catch{toast('No se pudo copiar automáticamente.',true);}
}
window.openTeamNotebook=async function(gid,index=0){
  gid=+gid||0;if(!gid){toast('Selecciona un grupo.',true);return;}
  const {teams}=await readSavedTeams(gid),usable=teams.filter(isUsableTeam);if(!usable.length){toast('Todavía no hay equipos con integrantes para abrir en la libreta.',true);return;}
  const selectedRaw=teams.find(t=>t.source_index===+index),selectedIndex=Math.max(0,usable.findIndex(t=>t===selectedRaw));
  notebookTeamState={groupId:gid,active:true,selectedIndex:selectedIndex<0?0:selectedIndex,teams:usable};
  if($('#notebookGroup'))$('#notebookGroup').value=String(gid);
  await setContextGroup(gid,{propagate:false,refresh:true});
  goView('notebook');
};
window.openTeamProject=async function(gid,index=0){
  gid=+gid||0;if(!gid)return;
  const g=await getGroupState(gid),p=String(g?.current_period||1),scheme=await getScheme(gid,p);
  if((scheme.principal_type||'project')!=='project'){toast('Este parcial está configurado como Examen. La evaluación por equipo con instrumento está disponible en modo Proyecto.',true);return;}
  const {teams}=await readSavedTeams(gid),usable=teams.filter(isUsableTeam);if(!usable.length){toast('Todavía no hay equipos con integrantes para evaluar.',true);return;}
  const selectedRaw=teams.find(t=>t.source_index===+index),selectedIndex=Math.max(0,usable.findIndex(t=>t===selectedRaw));
  pendingProjectTeam={gid,index:selectedIndex<0?0:selectedIndex};
  if($('#evalGroup'))$('#evalGroup').value=String(gid);
  await setContextGroup(gid,{propagate:false,refresh:true});
  goView('evaluation');
};

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
  const gradingMode=d.grading_mode,rubricRef=d.rubric_ref;delete d.grading_mode;delete d.rubric_ref;
  if(gradingMode==='rubric'){
    const snap=await rubricSnapshotFromRef(rubricRef);
    if(!snap){toast('Elige la rúbrica o lista de cotejo con la que vas a calificar.',true);return;}
    d.grading_mode='rubric';d.rubric=snap;d.max_score=10;
  }
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
    ?arr.map(a=>`<div class="activity-card"><div><strong>${escapeHtml(a.title)}</strong>${activityMaxIndicator(a)}<small>${escapeHtml(a.activity_type)} · Parcial ${a.period} · Fecha ${escapeHtml(a.activity_date||'Sin fecha')} · Puntaje original ${a.max_score} · Peso ${a.weight}</small></div><div class="action-row">${activityCardButtons(a)}<button class="btn small subtle" onclick="editActivityDate(${a.id})">Editar fecha</button><button class="btn small danger" onclick="deleteActivity(${a.id})">Eliminar</button></div></div>`).join('')
    :`<div class="empty-state">Parcial ${p} limpio. Crea la primera actividad.</div>`;
  await syncGroupPeriodIndicators(gid);
}
window.openGrades=async aid=>{
  const activity=await MiAulaDB.get('activities',aid);if(!activity)return;
  if(isRubricActivity(activity)){await openRubricEvaluator(aid);return;}
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

window.deleteActivity=async id=>{const delA=await MiAulaDB.get('activities',id),delG=(await MiAulaDB.byIndex('grades','activity_id',id)).filter(g=>g.score!=null||g.status||(g.rubric_levels&&Object.keys(g.rubric_levels).length)).length;if(!confirm(`¿Eliminar definitivamente la actividad «${delA?.title||''}» y sus ${delG} calificaciones${isRubricActivity(delA)?' (incluida su rúbrica)':''}?\n\nEsto no se puede deshacer.`))return;await MiAulaDB.deleteActivity(id);$('#gradePanel').classList.add('hidden');await loadActivities();await loadSummary();toast('Actividad eliminada');};

// -------------------- PARCIAL / ESQUEMA DE EVALUACIÓN --------------------
async function getScheme(gid,period){
  const key=`${gid}:${period}`;
  let s=await MiAulaDB.get('gradingSchemes',key);
  if(!s){
    // 2.10.1: un parcial nuevo copia los porcentajes del parcial anterior; Proyecto/Examen queda por elegir.
    const prev=+period>1?await MiAulaDB.get('gradingSchemes',`${gid}:${+period-1}`):null;
    const okPrev=prev&&[prev.work_pct,prev.project_pct,prev.values_pct,prev.attitudes_pct].reduce((a,b)=>a+(+b||0),0)===100;
    s={
      key,group_id:+gid,period:String(period),
      work_pct:okPrev?+prev.work_pct:40,project_pct:okPrev?+prev.project_pct:40,values_pct:okPrev?+prev.values_pct:10,attitudes_pct:okPrev?+prev.attitudes_pct:10,
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

async function computeGroupGrading(gid,period,opts={}){
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
      const a=actMap.get(g.activity_id);
      const gScore=a&&isRubricActivity(a)?rubricGradeScore(a,g):g.score;
      if(gScore==null)continue;
      if(!a||+a.max_score<=0||+a.weight<=0)continue;
      const normalized=+gScore*10/+a.max_score,w=+a.weight||1,type=String(a.activity_type||'').trim().toLowerCase();
      if(type==='proyecto'){projectTotal+=normalized*w;projectW+=w;}
      else if(type==='examen'){examTotal+=normalized*w;examW+=w;}
      else{workTotal+=normalized*w;workW+=w;}
    }
    // Solo en la exportación «cierre de evaluación»: actividad sin calificación cuenta como 0.
    // NP y rúbricas a medias NO se tocan (siguen sin contar, como en la app).
    if(opts.emptyAsZero&&!isSecretaryPendingStudent(s)){
      const withContent=new Set((gByStudent.get(s.id)||[]).filter(g=>!isEmptyGrade(actMap.get(g.activity_id),g)).map(g=>+g.activity_id));
      for(const a of activities){
        if(withContent.has(+a.id)||+a.max_score<=0||+a.weight<=0)continue;
        const w=+a.weight||1,type=String(a.activity_type||'').trim().toLowerCase();
        if(type==='proyecto')projectW+=w;else if(type==='examen')examW+=w;else workW+=w;
      }
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
  instruments=(await MiAulaDB.all('instruments')).filter(i=>i.format!==MiAulaRubricas.FORMAT).sort((a,b)=>b.id-a.id);
  $('#instrumentCards').innerHTML=instruments.length?instruments.map(i=>`<div class="instrument-card"><div><strong>${escapeHtml(i.name)}</strong><br><small>${i.instrument_type==='rubric'?'Rúbrica':'Lista de cotejo'} · ${i.criteria.length} criterios · ${i.convert_to_grade?'0–10':'Evidencia'}</small></div><button class="btn small danger" onclick="deleteInstrument(${i.id})">Eliminar</button></div>`).join(''):'<div class="empty-state">Crea tu primera rúbrica o lista de cotejo.</div>';
  if(typeof populateEvalInstrumentSelect==='function')await populateEvalInstrumentSelect();
}
window.deleteInstrument=async id=>{
  const used=await MiAulaDB.byIndex('evaluations','instrument_id',id);
  if(used.length){toast('No puede eliminarse porque ya tiene evaluaciones guardadas.',true);return;}
  if(!confirm('¿Eliminar este instrumento del banco?'))return;
  await MiAulaDB.remove('instruments',id);await loadInstruments();toast('Instrumento eliminado');
};

$('#evalGroup').onchange=loadPrincipalWorkspace;
$('#evalInstrument').onchange=()=>{renderEvalCriteria();try{localStorage.setItem('miaula:projectRubric',$('#evalInstrument').value);}catch{}if(typeof refreshProjectBankSelected==='function')refreshProjectBankSelected();};


async function populateProjectTeamSelector(gid){
  const sel=$('#evalSavedTeam');if(!sel)return;
  const {teams}=await readSavedTeams(gid),usable=teams.filter(isUsableTeam);
  sel.innerHTML='<option value="">Seleccionar equipo guardado…</option>'+usable.map((t,i)=>`<option value="${i}">${escapeHtml(t.name)} · ${t.members.filter(m=>m.active!==0&&!isSecretaryPendingStudent(m)).length} alumnos</option>`).join('');
  sel.disabled=!usable.length;
}
async function selectProjectTeam(gid,index){
  const {teams}=await readSavedTeams(gid),team=teams.filter(isUsableTeam)[+index];if(!team)return;
  const eligibleIds=new Set(team.members.filter(m=>m.active!==0&&!isSecretaryPendingStudent(m)).map(m=>+m.id));
  $$('#evalStudents input[type="checkbox"]').forEach(x=>x.checked=eligibleIds.has(+x.value));
  if($('#evalTeam'))$('#evalTeam').value=team.name;
  if($('#evalSavedTeam'))$('#evalSavedTeam').value=String(index);
  toast(`${team.name} seleccionado · ${eligibleIds.size} integrantes disponibles`);
}
$('#evalSavedTeam')?.addEventListener('change',async e=>{
  const gid=+$('#evalGroup').value;if(!gid||e.target.value==='')return;
  await selectProjectTeam(gid,+e.target.value);
});

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
    await populateProjectTeamSelector(gid);
    if(pendingProjectTeam&&+pendingProjectTeam.gid===+gid){
      const idx=pendingProjectTeam.index;pendingProjectTeam=null;await selectProjectTeam(gid,idx);
    }
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

let evalCriteriaRenderedRef=null;
function renderEvalCriteria(){
  const evalRef=String($('#evalInstrument').value||'');
  evalCriteriaRenderedRef=evalRef;
  if(evalRef&&!evalRef.startsWith('legacy:')){renderProjectRubricCriteria(evalRef);return;}
  const inst=instruments.find(i=>i.id===+evalRef.replace('legacy:',''));
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
  const evalRef=String($('#evalInstrument').value||'');
  if(evalRef&&!evalRef.startsWith('legacy:')){await saveProjectRubricEvaluation(gid,p,scheme,evalRef);return;}
  const iid=+evalRef.replace('legacy:',''),title=$('#evalTitle').value.trim(),ids=$$('#evalStudents input:checked').map(x=>+x.value),inst=instruments.find(i=>i.id===iid);
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
    ?`<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Alumno</th><th>Proyecto</th><th>Instrumento</th><th>Calif.</th><th></th></tr></thead><tbody>${evals.slice(0,100).map(e=>`<tr><td>${e.evaluation_date||''}</td><td>${escapeHtml(studentLabel(sm.get(e.student_id)||{}))}</td><td>${escapeHtml(e.title)}</td><td>${escapeHtml(im.get(e.instrument_id)?.name||e.rubric?.name||'')}</td><td><strong>${e.grade??''}</strong></td><td><button class="btn small danger" onclick="deleteEvaluation(${e.id})">Eliminar</button></td></tr>`).join('')}</tbody></table></div>`
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


async function refreshNotebookTeamState(gid,opts={}){
  gid=+gid;
  const {teams}=await readSavedTeams(gid),usable=teams.filter(isUsableTeam);
  if(notebookTeamState.groupId!==gid)notebookTeamState={groupId:gid,active:false,selectedIndex:0,teams:usable};
  else notebookTeamState.teams=usable;
  if(opts.teamMode===true)notebookTeamState.active=!!usable.length;
  if(Number.isFinite(+opts.teamIndex))notebookTeamState.selectedIndex=Math.max(0,Math.min(+opts.teamIndex,Math.max(0,usable.length-1)));
  if(!usable.length){notebookTeamState.active=false;notebookTeamState.selectedIndex=0;}
  if(notebookTeamState.selectedIndex>=usable.length)notebookTeamState.selectedIndex=Math.max(0,usable.length-1);
}
function currentNotebookTeam(){return notebookTeamState.active?notebookTeamState.teams[notebookTeamState.selectedIndex]||null:null;}
function renderNotebookTeamControls(){
  const btn=$('#notebookTeamView'),bar=$('#notebookTeamToolbar'),sel=$('#notebookTeamFilter'),team=currentNotebookTeam();
  if(btn){btn.disabled=!notebookTeamState.teams.length;btn.classList.toggle('active',notebookTeamState.active);btn.querySelector('span')&&(btn.querySelector('span').textContent=notebookTeamState.active?'Vista equipos activa':'Libreta por equipos');}
  if(!bar||!sel)return;
  bar.classList.toggle('hidden',!notebookTeamState.active||!notebookTeamState.teams.length);
  if(!notebookTeamState.active||!notebookTeamState.teams.length)return;
  sel.innerHTML=notebookTeamState.teams.map((t,i)=>`<option value="${i}" ${i===notebookTeamState.selectedIndex?'selected':''}>${escapeHtml(t.name)} · ${t.members.filter(m=>m.active!==0&&!isSecretaryPendingStudent(m)).length} alumnos</option>`).join('');
  if($('#notebookTeamCounter'))$('#notebookTeamCounter').textContent=`Equipo ${notebookTeamState.selectedIndex+1} de ${notebookTeamState.teams.length}`;
  const p=notebookData?.selected,activitySel=$('#teamActivitySelect');
  if(activitySel){
    if(!p||p==='all'){activitySel.innerHTML='<option value="">Selecciona un solo parcial</option>';activitySel.disabled=true;}
    else{
      const pd=notebookData?.periods?.[p],acts=pd?.activities||[];activitySel.disabled=!acts.length;
      activitySel.innerHTML=acts.length?'<option value="">Seleccionar actividad…</option>'+acts.map(a=>`<option value="${a.id}">${escapeHtml(a.title)} · /${fmtNum(a.max_score,1)}</option>`).join(''):'<option value="">Sin actividades</option>';
    }
  }
  const eligibleMembers=team?.members.filter(m=>m.active!==0&&!isSecretaryPendingStudent(m))||[];
  const membersBox=$('#notebookTeamMembers');
  if(membersBox){
    membersBox.innerHTML=eligibleMembers.length?eligibleMembers.map(m=>`<span class="team-member-display"><b>${escapeHtml(String(m.list_number??'—'))}</b><strong>${escapeHtml(studentLabel(m))}</strong></span>`).join(''):'<span class="team-member-display empty"><strong>Sin integrantes activos</strong></span>';
  }
}
async function setNotebookTeamIndex(index){
  if(!notebookTeamState.teams.length)return;
  notebookTeamState.active=true;notebookTeamState.selectedIndex=(+index+notebookTeamState.teams.length)%notebookTeamState.teams.length;
  renderNotebookTeamControls();applyNotebookFilters();
}
async function applyGradeToCurrentTeam(){
  const team=currentNotebookTeam();if(!team){toast('Selecciona un equipo.',true);return;}
  const period=notebookData?.selected;if(!period||period==='all'){toast('Selecciona un parcial específico para calificar por equipo.',true);return;}
  const pd=notebookData.periods?.[period],aid=+$('#teamActivitySelect')?.value,activity=pd?.activities.find(a=>+a.id===aid);
  if(!activity){toast('Selecciona una actividad.',true);return;}
  if(isRubricActivity(activity)){await openRubricEvaluator(activity.id,{mode:'team',teamName:team.name});return;}
  const raw=String($('#teamActivityScore')?.value||'').trim();if(!raw){toast('Escribe una calificación o NP.',true);return;}
  const parsed=notebookParseScore(raw,+activity.max_score||10);if(parsed.invalid){toast(`La calificación debe estar entre 0 y ${activity.max_score}, o usa NP.`,true);return;}
  const activeIds=new Set(pd.students.filter(s=>!isSecretaryPendingStudent(s)).map(s=>+s.id)),ids=team.member_ids.map(Number).filter(id=>activeIds.has(id));
  if(!ids.length){toast('Este equipo no tiene alumnos activos en el cuaderno.',true);return;}
  const value=parsed.status==='NP'?'NP':fmtNum(parsed.score,1);
  if(!confirm(`¿Aplicar ${value} en “${activity.title}” a los ${ids.length} integrantes activos de ${team.name}? Después podrás hacer ajustes individuales.`))return;
  const ok=await saveNotebookChanges({silent:true,noReload:true,skipSummary:true});if(!ok)return;
  for(const sid of ids){
    const old=await MiAulaDB.firstByIndex('grades','unique_key',[activity.id,sid]);
    const rec={...(old||{}),activity_id:activity.id,student_id:sid,score:parsed.score,status:parsed.status,notes:old?.notes||''};
    if(old)await MiAulaDB.put('grades',rec);else await MiAulaDB.add('grades',rec);
  }
  $('#teamActivityScore').value='';
  await loadNotebook();toast(`${value} aplicado a ${team.name} · ajustes individuales disponibles`);
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
  // 2.10.1: si cambió el grupo o se cerró un parcial, abrir el parcial actual (no el que quedó elegido antes).
  const sameContext=periodSelect.dataset.gid===String(gid)&&periodSelect.dataset.current===String(g.current_period||1);
  const previous=opts.resetPeriod||!sameContext?'':periodSelect.value;
  periodSelect.dataset.gid=String(gid);periodSelect.dataset.current=String(g.current_period||1);
  const periods=periodNumbers(g);
  periodSelect.innerHTML=periods.map(p=>`<option value="${p}">Parcial ${p}${+p===+g.current_period?' · actual':''}</option>`).join('')+'<option value="all">Todos los parciales</option>';
  const target=previous && (previous==='all'||periods.includes(previous))?previous:String(g.current_period||periods[0]||1);
  periodSelect.value=target;
  notebookEdits.grades.clear();notebookEdits.components.clear();
  const wanted=target==='all'?periods:[target];
  const data={group:g,selected:target,periods:{}};
  for(const p of wanted)data.periods[p]=await buildNotebookPeriodData(gid,p);
  notebookData=data;
  await refreshNotebookTeamState(gid,opts);
  $('#notebookModeLabel').textContent=target==='all'?`${g.name} · todos los parciales`:`${g.name} · Parcial ${target}`;
  renderNotebook();
  renderNotebookTeamControls();
}

function notebookActivityCell(a,s,pd){
  const rec=pd.grades.get(`${a.id}:${s.id}`);
  if(isRubricActivity(a))return rubricNotebookCell(a,s,pd,rec);
  const val=notebookGradeDisplay(rec);
  const klass=val==='NP'?' np-value':val!==''?' captured-value':' pending-value';
  return `<td class="notebook-grade-cell${klass}"><input class="notebook-score-input" inputmode="decimal" autocomplete="off" spellcheck="false" data-kind="grade" data-period="${pd.period}" data-student="${s.id}" data-activity="${a.id}" data-max="${a.max_score}" value="${escapeHtml(val)}" placeholder="—" aria-label="${escapeHtml(a.title)} · ${escapeHtml(studentLabel(s))}"></td>`;
}
function notebookComponentInput(field,s,pd,value){
  return `<input class="notebook-score-input component-input" inputmode="decimal" autocomplete="off" data-kind="component" data-field="${field}" data-period="${pd.period}" data-student="${s.id}" data-max="10" value="${value==null?'':escapeHtml(value)}" placeholder="—">`;
}
function notebookExtraCell(s,pd){
  const ex=pd.extrasByStudent?.get(s.id)||{goodAvailable:0,bad:0};
  return `<td class="sticky-col-3 notebook-extra-cell"><button type="button" class="extra-cell-button" onclick="openExtraModal('${pd.period}',${s.id})" aria-label="Puntos extra de ${escapeHtml(studentLabel(s))}"><span class="extra-good${ex.goodAvailable?'':' is-zero'}">+${ex.goodAvailable||0}</span><span class="extra-bad${ex.bad?'':' is-zero'}">${formatBadExtras(ex.bad)}</span><span class="extra-none${ex.goodAvailable||ex.bad?' is-zero':''}">—</span><small>Editar</small></button></td>`;
}
const NOTEBOOK_DENSITY_KEY='miaula:notebookDensity';
function applyNotebookDensity(mode){
  const comfortable=mode==='comfortable',view=$('#view-notebook');
  view?.classList.toggle('notebook-comfort',comfortable);
  $('#notebookDensityCompact')?.classList.toggle('active',!comfortable);
  $('#notebookDensityComfort')?.classList.toggle('active',comfortable);
  $('#notebookDensityCompact')?.setAttribute('aria-pressed',String(!comfortable));
  $('#notebookDensityComfort')?.setAttribute('aria-pressed',String(comfortable));
  try{localStorage.setItem(NOTEBOOK_DENSITY_KEY,comfortable?'comfortable':'compact');}catch{}
  requestAnimationFrame(setupNotebookScrollSync);
}
// 2.5.0: ajusta la altura de la tabla al espacio libre para que solo la tabla tenga scroll vertical.
function fitNotebookTable(){
  const view=$('#view-notebook');if(!view||!view.classList.contains('active'))return;
  const wrap=view.querySelector('.notebook-period-block .notebook-table-wrap');
  if(!wrap){view.style.removeProperty('--nb-fit');return;}
  const nav=$('#bottomAppNav'),navVisible=nav&&getComputedStyle(nav).display!=='none';
  const kp=$('#gradeKeypad'),kpVisible=kp&&!kp.classList.contains('hidden');
  const reserve=Math.max(navVisible?nav.offsetHeight+18:0,kpVisible?kp.offsetHeight+16:0)+14;
  const top=wrap.getBoundingClientRect().top+window.scrollY;
  view.style.setProperty('--nb-fit',`${Math.max(300,Math.floor(window.innerHeight-top-reserve))}px`);
}
document.addEventListener('fullscreenchange',()=>setTimeout(fitNotebookTable,120));
function setupNotebookScrollSync(){
  fitNotebookTable();
  $$('#notebookTable .notebook-period-block').forEach(block=>{
    const top=block.querySelector('.notebook-top-scroll'),rail=top?.firstElementChild,wrap=block.querySelector('.notebook-table-wrap'),table=wrap?.querySelector('.notebook-table');
    if(!top||!rail||!wrap||!table)return;
    rail.style.width=`${Math.max(table.scrollWidth,wrap.clientWidth)}px`;
    top.classList.toggle('hidden-scroll',table.scrollWidth<=wrap.clientWidth+2);
    if(top.dataset.synced==='1')return;
    top.dataset.synced='1';let syncing=false;
    top.addEventListener('scroll',()=>{if(syncing)return;syncing=true;wrap.scrollLeft=top.scrollLeft;requestAnimationFrame(()=>syncing=false);},{passive:true});
    wrap.addEventListener('scroll',()=>{if(syncing)return;syncing=true;top.scrollLeft=wrap.scrollLeft;requestAnimationFrame(()=>syncing=false);},{passive:true});
  });
}

function renderNotebookPeriod(pd){
  const principalType=pd.scheme.principal_type||'project',principal=principalLabel(principalType);
  const activityHeads=pd.activities.map(a=>`<th class="activity-head"><span>${escapeHtml(a.title)}</span>${activityMaxIndicator(a)}<small>${isRubricActivity(a)?(activityRubric(a)?.kind==='cotejo'?'Lista de cotejo':'Rúbrica'):escapeHtml(a.activity_type)} · /${fmtShort(a.max_score,1)}</small>${teamColumnButton(a)}</th>`).join('');
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
  return `<div class="notebook-period-block" data-period-block="${pd.period}"><div class="notebook-period-title"><div><h3>Parcial ${pd.period}</h3><p>${pd.activities.length} actividades · Componente principal: <strong>${principal}</strong></p></div><span class="period-badge">Trabajos ${pd.scheme.work_pct}% · ${principal} ${pd.scheme.project_pct}% · Valores ${pd.scheme.values_pct}% · Actitudes ${pd.scheme.attitudes_pct}%</span></div><div class="notebook-top-scroll" aria-label="Desplazamiento horizontal del cuaderno"><div></div></div><div class="notebook-table-wrap"><table class="notebook-table"><thead><tr><th class="sticky-col notebook-num">No.</th><th class="sticky-col-2 notebook-student">Alumno</th><th class="sticky-col-3 notebook-extra-head">Puntos extra</th>${emptyActivities}<th>Prom.<br>trabajos</th><th>${principal}</th><th>Valores</th><th>Actitudes</th><th>Final</th></tr></thead><tbody>${body||`<tr><td colspan="${colspan}" class="empty-state">No hay alumnos activos.</td></tr>`}</tbody></table></div></div>`;
}
function renderNotebook(){
  if(!notebookData)return;
  const pds=Object.values(notebookData.periods);
  const totalActs=pds.reduce((n,p)=>n+p.activities.length,0),students=pds[0]?.students.length||0;
  $('#notebookSummary').classList.remove('hidden');
  $('#notebookSummary').innerHTML=`<div><span>Grupo</span><strong>${escapeHtml(notebookData.group.name)}</strong></div><div><span>Alumnos</span><strong>${students}</strong></div><div><span>Actividades visibles</span><strong>${totalActs}</strong></div><div><span>Vista</span><strong>${notebookData.selected==='all'?'Todos':`Parcial ${notebookData.selected}`}</strong></div>`;
  $('#notebookTable').className='';
  $('#notebookTable').innerHTML=pds.map(renderNotebookPeriod).join('');
  setupNotebookScrollSync();
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
  window.MiAulaKeypad?.prepare();
}
window.openExtraModal=async function(period,studentId){
  if(!notebookData?.group?.id)return;
  const gid=+notebookData.group.id,p=String(period);
  let pd=notebookData.periods?.[p];
  if(!pd)pd=await buildNotebookPeriodData(gid,p);
  const student=pd.students.find(x=>+x.id===+studentId)||await MiAulaDB.get('students',+studentId);if(!student)return;
  const rows=await getStudentExtraRows(gid,+studentId,p),ex=extraSummary(rows);
  const usable=pd.activities.filter(a=>!isRubricActivity(a)&&!['proyecto','examen'].includes(String(a.activity_type||'').trim().toLowerCase())).map(a=>{
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
  if(isRubricActivity(activity)){toast('Los puntos extra solo se aplican a actividades que se califican con número. En una rúbrica la nota sale de los niveles.',true);return;}
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
    const parsed=isRubricActivity(a)?{score:rubricGradeScore(a,pd.grades.get(`${a.id}:${studentId}`))}:notebookParseScore(el?.value,+a.max_score||10);if(parsed.invalid||parsed.score==null)continue;
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

async function buildNotebookWorkbook(gid,selection,opts={}){
  const g=await getGroupState(gid);if(!g)throw new Error('Grupo no encontrado');
  const periods=selection==='all'?periodNumbers(g):[String(selection)];
  const sheets=[];
  for(const p of periods){
    const pd=await buildNotebookPeriodData(gid,p),principal=principalLabel(pd.scheme.principal_type||'project');
    const closing=!!opts.emptyAsZero,closeMap=closing?new Map((await computeGroupGrading(gid,p,{emptyAsZero:true})).students.map(r=>[r.id,r])):null;
    const headers=['No.','Alumno','Extra + disponibles','Extra -','Extra + ganados','Extra + aplicados',...pd.activities.map(a=>`${a.title} [${a.activity_type} /${fmtNum(a.max_score,1)}]`),'Prom. trabajos',principal,'Valores','Actitudes','Final','Estado'];
    const rows=[headers];
    for(const s of pd.students){
      const gr=(closing?closeMap.get(s.id):pd.gradingMap.get(s.id))||{},comp=pd.components.get(s.id)||{},ex=pd.extrasByStudent?.get(s.id)||{goodAvailable:0,bad:0,goodEarned:0,goodUsed:0};
      const scores=pd.activities.map(a=>{const rec=pd.grades.get(`${a.id}:${s.id}`);if(closing&&!isSecretaryPendingStudent(s)&&isEmptyGrade(a,rec)){if(opts.stats)opts.stats.zeros++;return 0;}return exportGradeValue(a,rec);});
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
  if(opts.emptyAsZero)sheets.unshift(closingNotesSheet(g,opts.stats));
  return {sheets};
}

$('#notebookGroup').onchange=()=>{const gid=+$('#notebookGroup').value||0;if(notebookTeamState.groupId!==gid)notebookTeamState={groupId:gid,active:false,selectedIndex:0,teams:[]};syncContextFromControl('#notebookGroup');loadNotebook({resetPeriod:true});};
$('#notebookPeriod').onchange=()=>loadNotebook();
$('#notebookReload').onclick=()=>loadNotebook();
$('#notebookSave').onclick=()=>saveNotebookChanges();
$('#notebookSearch').oninput=applyNotebookFilters;
$('#notebookFilter').onchange=applyNotebookFilters;
$('#notebookDensityCompact')?.addEventListener('click',()=>applyNotebookDensity('compact'));
$('#notebookDensityComfort')?.addEventListener('click',()=>applyNotebookDensity('comfortable'));
try{applyNotebookDensity(localStorage.getItem(NOTEBOOK_DENSITY_KEY)==='comfortable'?'comfortable':'compact');}catch{applyNotebookDensity('compact');}
window.addEventListener('resize',()=>requestAnimationFrame(setupNotebookScrollSync),{passive:true});
$('#notebookStudentView').onclick=()=>openFirstVisibleStudent();
$('#notebookTeamView')?.addEventListener('click',async()=>{
  if(!notebookTeamState.teams.length){toast('Primero crea los equipos desde Herramientas → Equipos.',true);return;}
  notebookTeamState.active=!notebookTeamState.active;renderNotebookTeamControls();applyNotebookFilters();
});
$('#notebookTeamFilter')?.addEventListener('change',e=>setNotebookTeamIndex(+e.target.value));
$('#teamPrev')?.addEventListener('click',()=>setNotebookTeamIndex(notebookTeamState.selectedIndex-1));
$('#teamNext')?.addEventListener('click',()=>setNotebookTeamIndex(notebookTeamState.selectedIndex+1));
$('#exitTeamNotebook')?.addEventListener('click',()=>{notebookTeamState.active=false;renderNotebookTeamControls();applyNotebookFilters();});
$('#applyTeamActivity')?.addEventListener('click',applyGradeToCurrentTeam);
$('#openTeamProjectFromNotebook')?.addEventListener('click',()=>{const team=currentNotebookTeam();if(team)openTeamProject(notebookData.group.id,notebookTeamState.selectedIndex);});
$('#notebookExcel').onclick=async()=>{
  const gid=+$('#notebookGroup').value;if(!gid){toast('Selecciona un grupo',true);return;}
  try{
    const ok=await saveNotebookChanges({silent:true,noReload:true});if(!ok)return;
    const mode=await askExportMode('Generar Excel del cuaderno');if(!mode)return;
    const stats={zeros:0},closing=mode==='closing';
    const g=await MiAulaDB.get('groups',gid),selection=$('#notebookPeriod').value||String(g.current_period||1),book=await buildNotebookWorkbook(gid,selection,closing?{emptyAsZero:true,stats}:{}),blob=XLSXLite.write(book),safe=String(g.name).replace(/[^A-Za-z0-9_-]+/g,'_');
    downloadBlob(blob,`MiAula_Cuaderno_${safe}_${selection==='all'?'Todos':`P${selection}`}${closing?'_CIERRE':''}_${today}.xlsx`);toast(closing?`Excel de cierre generado · ${stats.zeros} vacías exportadas como 0`:'Excel del cuaderno generado');
    await loadNotebook();
  }catch(e){console.error(e);toast(e.message,true);}
};
$('#notebookPresentation').onclick=async()=>{
  const on=!document.body.classList.contains('notebook-focus');document.body.classList.toggle('notebook-focus',on);
  $('#notebookPresentation').innerHTML=`<svg class="ui-icon" aria-hidden="true"><use href="#i-screen"></use></svg><span>${on?'Salir de presentación':'Presentación'}</span>`;
  requestAnimationFrame(fitNotebookTable);
  if(on && document.documentElement.requestFullscreen){try{await document.documentElement.requestFullscreen();}catch{}}
  if(!on && document.fullscreenElement){try{await document.exitFullscreen();}catch{}}
};
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.body.classList.contains('notebook-focus')){document.body.classList.remove('notebook-focus');if($('#notebookPresentation'))$('#notebookPresentation').innerHTML='<svg class="ui-icon" aria-hidden="true"><use href="#i-screen"></use></svg><span>Presentación</span>';}});

function attendanceTotals(records){
  const out={P:0,F:0,R:0,J:0,S:0,total:0,attended:0,absencePct:null};
  for(const a of records){
    const h=+a.class_hours||1,status=String(a.status||'').toUpperCase();
    out[status]=(out[status]||0)+h;
    if(status==='S')continue;
    out.total+=h;
    if(status!=='F')out.attended+=h;
  }
  out.pct=out.total?Math.round(out.attended*1000/out.total)/10:null;
  out.absencePct=out.total?Math.round(out.F*1000/out.total)/10:null;
  return out;
}
async function buildWorkbook(gid,opts={}){
  const g=await MiAulaDB.get('groups',gid);if(!g)throw new Error('Grupo no encontrado');
  const allStudents=await MiAulaDB.groupStudents(gid,{includeInactive:true}),students=allStudents.filter(s=>s.active!==0).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999)),inactive=allStudents.filter(s=>s.active===0);
  const attendance=(await MiAulaDB.byIndex('attendance','group_id',gid)).sort((a,b)=>a.attendance_date.localeCompare(b.attendance_date)),activities=(await MiAulaDB.byIndex('activities','group_id',gid)).sort((a,b)=>String(a.period).localeCompare(String(b.period))||String(a.activity_date).localeCompare(String(b.activity_date)));
  const allGrades=await MiAulaDB.all('grades'),actIds=new Set(activities.map(a=>a.id)),grades=allGrades.filter(x=>actIds.has(x.activity_id)),evals=(await MiAulaDB.byIndex('evaluations','group_id',gid)).sort((a,b)=>String(a.period).localeCompare(String(b.period))||String(a.evaluation_date).localeCompare(String(b.evaluation_date))),insts=await MiAulaDB.all('instruments');
  const im=new Map(insts.map(i=>[i.id,i])),sm=new Map(allStudents.map(s=>[s.id,s])),am=new Map(activities.map(a=>[a.id,a])),gradeKey=new Map(grades.map(gr=>[`${gr.activity_id}:${gr.student_id}`,gr]));
  const dates=[...new Set(attendance.map(a=>a.attendance_date))].sort(),attKey=new Map(attendance.map(a=>[`${a.student_id}:${a.attendance_date}`,a]));
  const periods=periodNumbers(g);const grading={};for(const p of periods)grading[p]=await computeGroupGrading(gid,p,opts.emptyAsZero?{emptyAsZero:true}:{});
  const avgFinal=p=>{const v=grading[p].students.filter(x=>x.final_grade!=null).map(x=>x.final_grade);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
  const groupAttendance=attendanceTotals(attendance.filter(a=>sm.get(a.student_id)?.active!==0));
  const studentAttendanceStats=students.map(st=>attendanceTotals(attendance.filter(a=>a.student_id===st.id)));
  const attendanceCriticalCount=studentAttendanceStats.filter(x=>(x.absencePct||0)>=20).length;
  const attendanceWarningCount=studentAttendanceStats.filter(x=>(x.absencePct||0)>=15&&(x.absencePct||0)<20).length;
  const classBlocks=new Map();for(const a of attendance){const k=a.attendance_date;classBlocks.set(k,Math.max(classBlocks.get(k)||0,+a.class_hours||1));}
  const classHours=[...classBlocks.values()].reduce((a,b)=>a+b,0);
  const resumen=[['Indicador','Valor'],['Grupo',g.name],['Grado / semestre',g.grade||''],['Disciplina',g.discipline||''],['Ciclo escolar',g.school_year||''],['Parciales configurados',totalPeriods(g)],['Alumnos activos',students.length],['Alumnos dados de baja',inactive.length],['Horas de clase registradas',classHours],['Horas-presente',groupAttendance.P],['Horas-falta',groupAttendance.F],['Horas-retardo',groupAttendance.R],['Horas-justificadas',groupAttendance.J],['Horas-pendiente Secretaría',groupAttendance.S],['Asistencia ponderada por hora %',groupAttendance.pct],['Faltas ponderadas por hora %',groupAttendance.absencePct],['Alumnos con faltas >=20%',attendanceCriticalCount],['Alumnos entre 15% y 19.9%',attendanceWarningCount],['Parcial activo',g.current_period||1],['Parciales cerrados',(g.closed_periods||[]).join(', ')||'Ninguno'],...periods.map(p=>[`Promedio final Parcial ${p}`,avgFinal(p)]),['Generado',new Date().toLocaleString('es-MX')]];
  const esquema=[['Parcial','Componente principal','Trabajos %','Principal %','Valores %','Actitudes %','Total %','Estado']];for(const p of periods){const s=grading[p].scheme;esquema.push([p,principalLabel(s.principal_type||'project'),s.work_pct,s.project_pct,s.values_pct,s.attitudes_pct,+s.work_pct+ +s.project_pct+ +s.values_pct+ +s.attitudes_pct,(g.closed_periods||[]).includes(+p)?'Cerrado':(+g.current_period===+p&&!g.course_closed?'En curso':'Pendiente')]);}
  const trim=[['No.','Código','Alumno','Parcial','Trabajos','Trabajos %','Componente principal','Tipo principal','Principal %','Valores','Valores %','Actitudes','Actitudes %','Final','Estado','Observación']];for(const p of periods){const sc=grading[p].scheme;for(const s of grading[p].students)trim.push([s.list_number,s.student_code,s.name,p,s.work_avg,sc.work_pct,s.principal_avg,principalLabel(sc.principal_type||'project'),sc.project_pct,s.values_score,sc.values_pct,s.attitudes_score,sc.attitudes_pct,s.final_grade,s.complete?'Completo':'Pendiente',s.notes||'']);}
  const conc=[['No.','Código','Alumno','Grado','Asistencia %','Faltas %','Alerta asistencia','Hrs P','Hrs F','Hrs R','Hrs J','Hrs Sec.',...activities.map(a=>`${a.title} [P${a.period}]`),'Prom. actividades',...periods.map(p=>`P${p}`)]];
  for(const s of students){
    const sa=attendance.filter(a=>a.student_id===s.id),at=attendanceTotals(sa),normalized=[],risk=absenceRiskMeta(at.absencePct),row=[s.list_number,s.student_code,studentLabel(s),s.grade||'',at.pct,at.absencePct,risk.label,at.P,at.F,at.R,at.J,at.S];
    for(const a of activities){const gr=gradeKey.get(`${a.id}:${s.id}`);let v=isRubricActivity(a)?rubricGradeScore(a,gr):(gr?.score??null),shown=exportGradeValue(a,gr);if(opts.emptyAsZero&&!isSecretaryPendingStudent(s)&&isEmptyGrade(a,gr)){v=0;shown=0;if(opts.stats)opts.stats.zeros++;}row.push(shown);if(v!=null&&+a.max_score>0)normalized.push(+v*10/+a.max_score);}
    row.push(normalized.length?Math.round(100*normalized.reduce((x,y)=>x+y,0)/normalized.length)/100:null,...periods.map(p=>grading[p].students.find(x=>x.id===s.id)?.final_grade??null));conc.push(row);
  }
  const asist=[['No.','Alumno',...dates.map(d=>`${d} (registro)`),'Hrs P','Hrs F','Hrs R','Hrs J','Hrs Sec.','Total hrs computables','Asistencia %','Faltas %','Alerta 20%']];
  for(const s of students){const sa=attendance.filter(a=>a.student_id===s.id),at=attendanceTotals(sa),risk=absenceRiskMeta(at.absencePct);asist.push([s.list_number,studentLabel(s),...dates.map(d=>{const a=attKey.get(`${s.id}:${d}`);return a?`${a.status} ×${a.class_hours||1}`:'';}),at.P,at.F,at.R,at.J,at.S,at.total,at.pct,at.absencePct,risk.label]);}
  const hourHeaders=['No.','Alumno'];for(const d of dates){const hrs=classBlocks.get(d)||1;for(let h=1;h<=hrs;h++)hourHeaders.push(`${d} H${h}`);}const asistHoras=[hourHeaders];
  for(const s of students){const row=[s.list_number,studentLabel(s)];for(const d of dates){const hrs=classBlocks.get(d)||1,a=attKey.get(`${s.id}:${d}`);for(let h=1;h<=hrs;h++)row.push(a?.status||'');}asistHoras.push(row);}
  const acts=[['Actividad','Tipo','Parcial','Fecha','Puntaje máximo','Peso','Capturadas','Pendientes']];for(const a of activities){const count=grades.filter(gr=>gr.activity_id===a.id&&gr.score!=null&&sm.get(gr.student_id)?.active!==0).length;acts.push([a.title,a.activity_type,a.period,a.activity_date,a.max_score,a.weight,count,Math.max(students.length-count,0)]);}
  const detail=[['No.','Alumno','Estatus','Actividad','Tipo','Parcial','Fecha','Calificación','Máximo','Equivalente 0-10','Observación']];for(const gr of grades){const a=am.get(gr.activity_id),s=sm.get(gr.student_id);if(!a||!s)continue;const dv=isRubricActivity(a)?rubricGradeScore(a,gr):gr.score;detail.push([s.list_number,studentLabel(s),s.active!==0?'Activo':'Baja',a.title,a.activity_type,a.period,a.activity_date,exportGradeValue(a,gr),a.max_score,dv==null?null:Math.round(+dv*1000/+a.max_score)/100,gr.notes||'']);}
  const evalSheet=[['Fecha','Parcial','Alumno','Estatus','Proyecto','Instrumento','Tipo','Equipo','Puntaje','Calificación','Observación']];for(const e of evals){const i=im.get(e.instrument_id),s=sm.get(e.student_id);evalSheet.push([e.evaluation_date,e.period,studentLabel(s||{}),s?.active!==0?'Activo':'Baja',e.title,i?.name||e.rubric?.name||'',(e.rubric?e.rubric.kind==='rubrica':i?.instrument_type==='rubric')?'Rúbrica':'Lista de cotejo',e.team_name||'',e.raw_score,e.grade,e.notes||'']);}
  const obs=[['Alumno','Origen','Actividad/Evaluación','Observación']];for(const gr of grades){if(String(gr.notes||'').trim()){const a=am.get(gr.activity_id),s=sm.get(gr.student_id);obs.push([studentLabel(s||{}),'Actividad',a?.title||'',gr.notes]);}}for(const e of evals){if(String(e.notes||'').trim())obs.push([studentLabel(sm.get(e.student_id)||{}),'Evaluación',e.title,e.notes]);}for(const p of periods)for(const s of grading[p].students)if(String(s.notes||'').trim())obs.push([s.name,`Parcial ${p}`,'Valores y Actitudes',s.notes]);
  const bajas=[['Último No.','Código','Apellido paterno','Apellido materno','Nombre(s)','Nombre completo','Fecha de baja','Hrs P','Hrs F','Hrs R','Hrs J','Hrs Sec.','Asistencia %']];for(const s of inactive){const at=attendanceTotals(attendance.filter(a=>a.student_id===s.id));bajas.push([s.former_list_number??s.list_number,s.student_code,s.paternal_last_name||'',s.maternal_last_name||'',s.given_names||'',studentLabel(s),s.withdrawn_at?new Date(s.withdrawn_at).toLocaleDateString('es-MX'):'',at.P,at.F,at.R,at.J,at.S,at.pct]);}
  const instrumentBank=[['Instrumento','Tipo','Convierte a 0-10','Criterios']];for(const i of insts){instrumentBank.push([i.name,i.instrument_type==='rubric'?'Rúbrica':'Lista de cotejo',i.convert_to_grade?'Sí':'No',(i.criteria||[]).map(c=>c.name).join(' · ')]);}
  const extraRows=(await MiAulaDB.all('extraPoints')).filter(r=>+r.group_id===+gid).sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
  const extraSheet=[['Parcial','No.','Alumno','Movimiento','Puntos','Origen','Actividad','Fecha','Nota']];for(const r of extraRows){const st=sm.get(r.student_id),ac=am.get(r.activity_id);extraSheet.push([r.period,st?.list_number??'',studentLabel(st||{}),r.kind==='good'?'Bueno':r.kind==='bad'?'Malo':'Aplicado',r.kind==='bad'?-r.points:r.points,r.source||'',ac?.title||'',r.created_at?new Date(r.created_at).toLocaleString('es-MX'):'',r.note||'']);}
  const {record:teamRecord,teams:savedTeams}=await readSavedTeams(gid);
  const teamSheet=[['Equipo','No.','Alumno','Estado','Guardado / actualizado']];
  for(const t of savedTeams)for(const st of t.members)teamSheet.push([t.name,st.list_number??'',studentLabel(st),st.active!==0?'Activo':'Baja',teamRecord?.updated_at?new Date(teamRecord.updated_at).toLocaleString('es-MX'):'']);
  if(!savedTeams.length)teamSheet.push(['Sin equipos guardados','','','','']);
  return {sheets:[...(opts.emptyAsZero?[closingNotesSheet(g,opts.stats)]:[]),{name:'Resumen',rows:resumen},{name:'Esquemas',rows:esquema},{name:'Calificación parcial',rows:trim},{name:'Concentrado',rows:conc},{name:'Asistencia',rows:asist},{name:'Asistencia por horas',rows:asistHoras},{name:'Actividades',rows:acts},{name:'Detalle calificaciones',rows:detail},{name:'Proyectos',rows:evalSheet},{name:'Equipos',rows:teamSheet},{name:'Puntos extra',rows:extraSheet},{name:'Banco instrumentos',rows:instrumentBank},{name:'Observaciones',rows:obs},{name:'Bajas',rows:bajas}]};
}
async function exportFullExcelForGroup(gid){
  gid=+gid||0;if(!gid){toast('Selecciona un grupo',true);return;}
  const mode=await askExportMode('Exportar todo a Excel');if(!mode)return;
  const stats={zeros:0},closing=mode==='closing';
  try{toast('Generando Excel completo…');const g=await MiAulaDB.get('groups',gid),book=await buildWorkbook(gid,closing?{emptyAsZero:true,stats}:{}),blob=XLSXLite.write(book),safe=String(g.name).replace(/[^A-Za-z0-9_-]+/g,'_');downloadBlob(blob,`MiAula_${safe}${closing?'_CIERRE':''}_${today}.xlsx`);toast(closing?`Excel de cierre generado · ${stats.zeros} vacías exportadas como 0`:'Excel completo generado');}catch(e){console.error(e);toast(e.message,true);}
}
$('#exportBtn').onclick=async()=>{await exportFullExcelForGroup(+$('#exportGroup').value);};
async function downloadMiAulaBackup(){
  try{
    const data=await MiAulaDB.exportBackup();
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    downloadBlob(blob,`MiAula_2.10.1_Respaldo_${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    toast('Respaldo generado');
    try{localStorage.setItem('miaula:lastBackupAt',new Date().toISOString());}catch{}
    if(typeof renderBackupReminder==='function')renderBackupReminder();
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
    else if(currentView==='attendanceHistory')active=v==='attendance';
    else if(currentView==='activities')active=v==='activities';
    else if(['groups','grading','evaluation'].includes(currentView))active=v==='more';
    else active=v===currentView;
    btn.classList.toggle('active',active);
  });
}

$$('.app-tab').forEach(btn=>btn.addEventListener('click',()=>{
  const view=btn.dataset.appView,mode=btn.dataset.mode;
  if(view==='dynamics')openDynamicsMode(mode||'roulette'); else goView(view);
  if(btn.dataset.focus==='new-activity')focusNewActivityForm();
}));
// 2.9.1: acceso directo a «Nueva actividad» desde la barra inferior.
function focusNewActivityForm(){
  if(typeof setActivitiesTab==='function')setActivitiesTab('activities');
  const form=$('#activityForm'),name=form?.querySelector('input[name="title"]');
  if(!form)return;
  form.closest('.panel')?.scrollIntoView({behavior:'smooth',block:'start'});
  setTimeout(()=>name?.focus({preventScroll:true}),350);
}

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
    ['#attendanceGroup','#attendanceHistoryGroup','#dynamicsGroup','#activityGroup','#activityFilter','#notebookGroup','#gradingGroup','#evalGroup','#exportGroup'].forEach(id=>{if($(id)&&[...$(id).options].some(o=>+o.value===gid))$(id).value=String(gid);});
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
  else if(currentView==='attendanceHistory'){await renderAttendanceMonitor();await renderSecretaryPendingList();}
  else if(currentView==='more')await loadAdminOverview();
});
$('#contextNotebook').onclick=()=>{const gid=+$('#contextGroup').value||null;openNotebook(gid);};
$('#contextAttendance').onclick=()=>{const gid=+$('#contextGroup').value||0;if(gid)$('#attendanceGroup').value=String(gid);goView('attendance');};
['#attendanceGroup','#attendanceHistoryGroup','#dynamicsGroup','#activityGroup','#activityFilter','#gradingGroup','#evalGroup','#exportGroup'].forEach(id=>$(id)?.addEventListener('change',()=>syncContextFromControl(id)));

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
  if(typeof renderAttentionPanel==='function')renderAttentionPanel(gid).catch(e=>console.error(e));
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
    const studentId=+(row.dataset.notebookRow||'').split(':').pop();
    const team=currentNotebookTeam(),teamMatch=!team||team.member_ids.map(Number).includes(studentId);
    let match=teamMatch&&(!search||name.includes(search));
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
  notebookAutoSavePending=true;
  notebookAutoSaveTimer=setTimeout(async()=>{
    notebookAutoSavePending=false;
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
    if(isRubricActivity(a))return rubricDrawerCard(a,pd,studentId);
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

// 2.6.0: modo claro / oscuro. Es solo una preferencia de interfaz (localStorage).
const THEME_KEY='miaula:theme';
function applyTheme(theme){
  const light=theme==='light';
  if(light)document.documentElement.setAttribute('data-theme','light');else document.documentElement.removeAttribute('data-theme');
  const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute('content',light?'#EDF1F5':'#111827');
  const btn=$('#themeToggle');
  if(btn){const label=light?'Cambiar a modo oscuro':'Cambiar a modo claro';btn.setAttribute('aria-label',label);btn.title=label;btn.innerHTML=`<svg class="ui-icon" aria-hidden="true"><use href="#${light?'i-moon':'i-sun'}"></use></svg>`;}
  if(typeof drawWheel==='function'){try{drawWheel();}catch{}}
}
function currentTheme(){return document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';}
applyTheme(currentTheme());
$('#themeToggle')?.addEventListener('click',()=>{
  const next=currentTheme()==='light'?'dark':'light';
  applyTheme(next);
  try{localStorage.setItem(THEME_KEY,next);}catch{}
});

// ==========================================================================
// 2.7.0 · Teclado de calificaciones, confeti, alertas, recordatorio de respaldo,
// aviso de actualización, guardado seguro al salir y reportes imprimibles.
// ==========================================================================

// ---------- Guardado seguro: si la app se cierra antes del autoguardado ----------
async function flushNotebookAutoSave(){
  if(!notebookAutoSavePending)return;
  clearTimeout(notebookAutoSaveTimer);notebookAutoSavePending=false;
  try{await saveNotebookChanges({silent:true,noReload:true,skipSummary:true});}catch(e){console.error(e);}
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushNotebookAutoSave();});
window.addEventListener('pagehide',()=>{flushNotebookAutoSave();});

// ---------- Aviso de actualización ----------
function showUpdateBanner(){$('#updateBanner')?.classList.remove('hidden');}
$('#updateNow')?.addEventListener('click',async()=>{
  const btn=$('#updateNow');if(btn){btn.disabled=true;btn.textContent='Actualizando…';}
  await flushNotebookAutoSave();
  location.reload();
});

// ---------- Pantalla de inicio ----------
setTimeout(()=>$('#splash')?.classList.add('done'),650);
setTimeout(()=>$('#splash')?.remove(),1400);

// ---------- Recordatorio de respaldo ----------
function lastBackupInfo(){
  let iso=null;try{iso=localStorage.getItem('miaula:lastBackupAt');}catch{}
  if(!iso)return {state:'never',days:null,text:'Aún no has descargado un respaldo en esta tablet.'};
  const d=new Date(iso),days=Math.floor((Date.now()-d.getTime())/86400000);
  const when=days<=0?'hoy':days===1?'ayer':`hace ${days} días`;
  const date=d.toLocaleDateString('es-MX',{day:'numeric',month:'short'});
  return {state:days>7?'late':'ok',days,text:`Último respaldo: ${when} (${date}).`};
}
function renderBackupReminder(){
  const info=lastBackupInfo();
  const box=$('#backupReminder');
  if(box){
    const title=info.state==='ok'?'Respaldo al día':info.state==='late'?'Conviene respaldar':'Sin respaldo';
    box.className=`panel backup-reminder ${info.state}`;
    box.innerHTML=`<div class="backup-reminder-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-backup"></use></svg></div><div class="backup-reminder-copy"><strong>${title}</strong><small>${escapeHtml(info.text)}</small></div><button type="button" class="btn ${info.state==='ok'?'subtle':'primary'}" id="backupReminderBtn">Respaldar ahora</button>`;
    $('#backupReminderBtn').onclick=downloadMiAulaBackup;
  }
  const admin=$('#backupLastInfo');if(admin){admin.textContent=info.text;admin.className=`backup-last-info ${info.state}`;}
}
renderBackupReminder();

// ---------- Inicio: requiere atención ----------
async function renderAttentionPanel(gid){
  const box=$('#attentionPanel');if(!box)return;
  gid=+gid;if(!gid){box.innerHTML='<div class="attention-empty">Selecciona un grupo para ver lo que requiere atención.</div>';return;}
  const g=await getGroupState(gid);if(!g)return;
  const p=String(g.current_period||1);
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const records=await MiAulaDB.byIndex('attendance','group_id',gid);
  const byStudent=new Map();for(const r of records){if(!byStudent.has(r.student_id))byStudent.set(r.student_id,[]);byStudent.get(r.student_id).push(r);}
  const risk=students.filter(s=>!isSecretaryPendingStudent(s)).map(s=>({s,t:attendanceTotals(byStudent.get(s.id)||[])})).filter(x=>(x.t.absencePct||0)>=15).sort((a,b)=>(b.t.absencePct||0)-(a.t.absencePct||0));
  const pendingSec=students.filter(isSecretaryPendingStudent);
  const activities=(await MiAulaDB.byIndex('activities','group_period',[gid,p])).sort((a,b)=>String(b.activity_date||'').localeCompare(String(a.activity_date||'')));
  const gradeLists=await Promise.all(activities.map(a=>MiAulaDB.byIndex('grades','activity_id',a.id)));
  const eligible=students.filter(s=>!isSecretaryPendingStudent(s));
  const missing=activities.map((a,i)=>{const done=new Set(gradeLists[i].filter(r=>r.score!=null||String(r.status||'').toUpperCase()==='NP').map(r=>r.student_id));return {a,count:eligible.filter(s=>!done.has(s.id)).length};}).filter(x=>x.count>0);
  const items=[];
  for(const {s,t} of risk.slice(0,5)){
    const crit=(t.absencePct||0)>=20;
    items.push(`<button type="button" class="attention-item ${crit?'critical':'warning'}" onclick="goView('attendanceHistory')"><b>${s.list_number??'—'}</b><span>${escapeHtml(studentLabel(s))}</span><em>${fmtPct(t.absencePct)} faltas · ${crit?'20% o más':'cerca del límite'}</em></button>`);
  }
  if(risk.length>5)items.push(`<button type="button" class="attention-item more" onclick="goView('attendanceHistory')"><span>+${risk.length-5} alumnos más con 15% o más de faltas</span></button>`);
  if(pendingSec.length)items.push(`<button type="button" class="attention-item warning" onclick="goView('attendanceHistory')"><b>${pendingSec.length}</b><span>Pendiente${pendingSec.length>1?'s':''} con Secretaría</span><em>Por confirmar</em></button>`);
  for(const {a,count} of missing.slice(0,3))items.push(`<button type="button" class="attention-item info" onclick="openNotebook(${gid})"><b>${count}</b><span>${escapeHtml(a.title)}</span><em>sin calificar</em></button>`);
  if(missing.length>3)items.push(`<button type="button" class="attention-item more" onclick="openNotebook(${gid})"><span>+${missing.length-3} actividades más con calificaciones pendientes</span></button>`);
  box.innerHTML=`<div class="attention-head"><svg class="ui-icon" aria-hidden="true"><use href="#i-alert"></use></svg><strong>Requiere atención</strong><small>${escapeHtml(g.name)} · Parcial ${p}</small></div>${items.length?`<div class="attention-list">${items.join('')}</div>`:'<div class="attention-ok">✓ Todo en orden: sin alumnos en riesgo por faltas, sin pendientes con Secretaría y sin calificaciones pendientes.</div>'}`;
}

// ---------- Confeti al revelar el alumno de la ruleta ----------
function launchConfetti(){
  try{if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;}catch{}
  const canvas=document.createElement('canvas');canvas.className='confetti-canvas';document.body.appendChild(canvas);
  const dpr=Math.min(window.devicePixelRatio||1,2),W=innerWidth,H=innerHeight;
  canvas.width=W*dpr;canvas.height=H*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const colors=['#FF3B30','#FF9500','#FFD60A','#30D158','#00C7BE','#0A84FF','#5E5CE6','#BF5AF2','#FF2D55'];
  const target=$('#rouletteName')?.getBoundingClientRect();
  const ox=target?target.left+target.width/2:W/2,oy=target?target.top+target.height/2:H/3;
  const parts=[];
  for(let i=0;i<170;i++){
    const ang=-Math.PI/2+(Math.random()-.5)*Math.PI*1.25,sp=7+Math.random()*10;
    parts.push({x:ox+(Math.random()-.5)*60,y:oy,vx:Math.cos(ang)*sp,vy:Math.sin(ang)*sp,w:6+Math.random()*7,h:4+Math.random()*5,r:Math.random()*6.28,vr:(Math.random()-.5)*.35,c:colors[i%colors.length],shape:Math.random()<.3?'circle':'rect'});
  }
  const start=performance.now(),dur=2600;
  function frame(now){
    const t=now-start;ctx.clearRect(0,0,W,H);
    const fade=t>dur-700?Math.max(0,(dur-t)/700):1;
    for(const p of parts){
      p.vy+=.32;p.vx*=.985;p.vy*=.985;p.x+=p.vx;p.y+=p.vy;p.r+=p.vr;
      ctx.save();ctx.globalAlpha=fade;ctx.translate(p.x,p.y);ctx.rotate(p.r);ctx.fillStyle=p.c;
      if(p.shape==='circle'){ctx.beginPath();ctx.arc(0,0,p.h/1.6,0,6.28);ctx.fill();}else ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h*Math.abs(Math.cos(p.r*1.7))+1);
      ctx.restore();
    }
    if(t<dur)requestAnimationFrame(frame);else canvas.remove();
  }
  requestAnimationFrame(frame);
  try{navigator.vibrate?.([18,40,18]);}catch{}
}

// ---------- Teclado de calificaciones del Cuaderno ----------
window.MiAulaKeypad=(()=>{
  const KEY='miaula:notebookKeypad';
  const pad=$('#gradeKeypad'),toggle=$('#notebookKeypadToggle');
  let current=null,fresh=true;
  function enabled(){
    let v=null;try{v=localStorage.getItem(KEY);}catch{}
    if(v==='on')return true;if(v==='off')return false;
    try{return window.matchMedia('(pointer: coarse)').matches;}catch{return false;}
  }
  function inputs(){return $$('#notebookTable .notebook-score-input');}
  function prepare(){
    const on=enabled();
    inputs().forEach(i=>i.setAttribute('inputmode',on?'none':'decimal'));
    if(toggle){toggle.setAttribute('aria-pressed',String(on));toggle.classList.toggle('active',on);}
  }
  function label(el){
    const row=el.closest('tr'),name=row?.querySelector('.student-name-button strong')?.textContent||'Alumno',num=row?.querySelector('.notebook-num')?.textContent||'';
    let col='';
    if(el.dataset.kind==='grade'){const a=notebookData?.periods?.[el.dataset.period]?.activities?.find(x=>String(x.id)===String(el.dataset.activity));col=a?a.title:'Actividad';}
    else col={values_score:'Valores',attitudes_score:'Actitudes',exam_score:'Examen'}[el.dataset.field]||'Componente';
    return {name:`${num?num+'. ':''}${name}`,col};
  }
  function sync(){
    if(!current)return;
    const l=label(current);
    $('#kpTargetLabel').textContent=`${l.col} · máx. ${fmtShort(+current.dataset.max||10)}`;
    $('#kpTargetName').textContent=l.name;
    $('#kpValue').textContent=current.value||'—';
    $$('#notebookTable td.kp-active').forEach(td=>td.classList.remove('kp-active'));
    current.closest('td')?.classList.add('kp-active');
  }
  function open(el){
    if(!pad||document.body.classList.contains('notebook-focus'))return;
    current=el;fresh=true;
    const wasHidden=pad.classList.contains('hidden');
    pad.classList.remove('hidden');document.body.classList.add('keypad-open');sync();
    document.documentElement.style.setProperty('--kp-h',pad.offsetHeight+'px');
    if(wasHidden)requestAnimationFrame(()=>{if(typeof fitNotebookTable==='function')fitNotebookTable();setTimeout(()=>el.scrollIntoView({block:'nearest',inline:'nearest'}),30);});
    else el.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  function close(){
    if(!pad||pad.classList.contains('hidden'))return;
    pad.classList.add('hidden');document.body.classList.remove('keypad-open');
    $$('#notebookTable td.kp-active').forEach(td=>td.classList.remove('kp-active'));
    if(current&&document.activeElement===current)current.blur();
    current=null;
    requestAnimationFrame(()=>{if(typeof fitNotebookTable==='function')fitNotebookTable();});
  }
  function setValue(v){
    if(!current)return;
    current.value=v;current.dispatchEvent(new Event('input',{bubbles:true}));
    $('#kpValue').textContent=v||'—';
    try{navigator.vibrate?.(8);}catch{}
  }
  function visibleRows(){return [...document.querySelectorAll('#notebookTable tbody tr[data-notebook-row]:not(.notebook-row-hidden)')];}
  function move(dir){
    if(!current)return;
    const row=current.closest('tr');let next=null;
    if(dir==='left'||dir==='right'){
      const list=[...row.querySelectorAll('.notebook-score-input')],i=list.indexOf(current);
      next=list[i+(dir==='right'?1:-1)]||null;
    }else{
      const rows=visibleRows(),i=rows.indexOf(row),target=rows[i+(dir==='down'?1:-1)];
      if(target){
        const sel=current.dataset.kind==='grade'?`.notebook-score-input[data-activity="${current.dataset.activity}"]`:`.notebook-score-input[data-field="${current.dataset.field}"]`;
        next=target.querySelector(sel);
      }
    }
    if(next){next.focus({preventScroll:true});open(next);}
    else if(dir==='down')toast('Última fila de la columna.');
  }
  if(pad){
    pad.addEventListener('pointerdown',e=>{if(e.target.closest('button'))e.preventDefault();});
    pad.addEventListener('click',e=>{
      const b=e.target.closest('button');if(!b||!current)return;
      if(b.dataset.kpQuick!=null){setValue(b.dataset.kpQuick);fresh=true;setTimeout(()=>move('down'),110);return;}
      if(b.dataset.kpDigit!=null){
        const d=b.dataset.kpDigit;let v=fresh||String(current.value).toUpperCase()==='NP'?'':String(current.value);
        if(d==='.'&&v.includes('.'))return;
        v=(v+d).slice(0,5);if(v==='.')v='0.';fresh=false;setValue(v);return;
      }
      if(b.dataset.kpMove){fresh=true;move(b.dataset.kpMove);return;}
      const act=b.dataset.kp;
      if(act==='back'){fresh=false;setValue(String(current.value).toUpperCase()==='NP'?'':String(current.value).slice(0,-1));}
      else if(act==='clear'){fresh=true;setValue('');}
      else if(act==='close')close();
      else if(act==='system'){
        try{localStorage.setItem(KEY,'off');}catch{}
        const el=current;prepare();close();
        if(el){el.focus();toast('Usando el teclado del sistema. Puedes volver a activar el Teclado MiAula en la barra del Cuaderno.');}
      }
    });
  }
  const table=$('#notebookTable');
  if(table){
    table.addEventListener('focusin',e=>{const el=e.target.closest?.('.notebook-score-input');if(el&&enabled())open(el);});
    table.addEventListener('focusout',()=>setTimeout(()=>{if(!document.activeElement?.closest?.('#notebookTable .notebook-score-input'))close();},140));
  }
  toggle?.addEventListener('click',()=>{
    const on=!enabled();try{localStorage.setItem(KEY,on?'on':'off');}catch{}
    prepare();if(!on)close();
    toast(on?'Teclado MiAula activado':'Teclado MiAula desactivado: se usará el del sistema');
  });
  prepare();
  return {prepare,close,open,enabled};
})();

// ---------- Reportes imprimibles / PDF ----------
function printHTML(title,html){
  const area=$('#printArea');if(!area)return;
  area.innerHTML=`<div class="pr-doc">${html}</div>`;
  const oldTitle=document.title;document.title=title;
  document.body.classList.add('printing');
  const done=()=>{document.body.classList.remove('printing');document.title=oldTitle;area.innerHTML='';window.removeEventListener('afterprint',done);};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{try{window.print();}catch(e){toast('No se pudo abrir la impresión: '+e.message,true);done();}},60);
}
function prHeader(kind,g,extra=''){
  const date=new Date().toLocaleDateString('es-MX',{day:'numeric',month:'long',year:'numeric'});
  return `<header class="pr-head"><div class="pr-brand"><svg viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="#3F6E9E"/><path d="M14 20.5c6-2.6 12-2.2 18 1.6v24c-6-3.8-12-4.2-18-1.6z" fill="#fff"/><path d="M50 20.5c-6-2.6-12-2.2-18 1.6v24c6-3.8 12-4.2 18-1.6z" fill="#fff" opacity=".75"/></svg><div><strong>${escapeHtml(kind)}</strong><span>${escapeHtml(g.name||'')} · ${escapeHtml(g.discipline||'')}${g.school_year?' · Ciclo '+escapeHtml(g.school_year):''}</span></div></div><div class="pr-meta">${extra}<span>Emitido: ${date}</span></div></header>`;
}
const prFoot=()=>`<footer class="pr-foot"><span>Generado con MiAula Slate · Control de bitácora</span></footer>`;
const prScore=v=>v==null?'<span class="pr-muted">Pendiente</span>':fmtNum(v);

async function printStudentReport(){
  const st=studentDrawerState;if(!st?.studentId||!notebookData?.group?.id){toast('Abre primero la Vista alumno.',true);return;}
  const gid=+notebookData.group.id,period=String(st.period),sid=+st.studentId;
  const g=await getGroupState(gid),pd=await buildNotebookPeriodData(gid,period);
  const s=pd.students.find(x=>+x.id===sid);if(!s){toast('No se encontró el alumno.',true);return;}
  const gr=pd.gradingMap.get(sid)||{},sc=pd.scheme,principal=principalLabel(sc.principal_type||'project');
  const att=attendanceTotals((await MiAulaDB.byIndex('attendance','student_id',sid)).filter(r=>+r.group_id===gid));
  const risk=absenceRiskMeta(att.absencePct),ex=pd.extrasByStudent.get(sid)||{goodAvailable:0,goodUsed:0,bad:0};
  const rows=pd.activities.map(a=>{const r=pd.grades.get(`${a.id}:${sid}`),v=String(exportGradeValue(a,r));return `<tr><td>${a.activity_date?parseISODateLocal(a.activity_date).toLocaleDateString('es-MX',{day:'2-digit',month:'short'}):'—'}</td><td>${escapeHtml(a.title)}</td><td>${escapeHtml(a.activity_type||'')}</td><td class="pr-num">${v===''?'<span class="pr-muted">—</span>':v==='NP'?'<b class="pr-np">NP</b>':escapeHtml(v)} <small>/ ${fmtShort(a.max_score)}</small></td></tr>`;}).join('')||'<tr><td colspan="4" class="pr-muted">Sin actividades registradas en este parcial.</td></tr>';
  const comps=[['Trabajos',sc.work_pct,gr.work_avg],[principal,sc.project_pct,gr.principal_avg??gr.exam_score],['Valores',sc.values_pct,gr.values_score],['Actitudes',sc.attitudes_pct,gr.attitudes_score]];
  const html=`${prHeader(`Boleta de calificaciones · Parcial ${period}`,g)}
  <section class="pr-student"><div><small>Alumno</small><strong>${escapeHtml(studentLabel(s))}</strong></div><div><small>No. de lista</small><strong>${s.list_number??'—'}</strong></div><div class="pr-final"><small>Calificación del parcial</small><strong>${gr.final_grade==null?'Pendiente':fmtNum(gr.final_grade)}</strong></div></section>
  <h3>Componentes de evaluación</h3>
  <table class="pr-table"><thead><tr><th>Componente</th><th>Porcentaje</th><th class="pr-num">Calificación</th><th class="pr-num">Aporta</th></tr></thead><tbody>${comps.map(([n,pct,v])=>`<tr><td>${escapeHtml(n)}</td><td>${+pct||0}%</td><td class="pr-num">${+pct>0?prScore(v):'<span class="pr-muted">No aplica</span>'}</td><td class="pr-num">${+pct>0&&v!=null?fmtNum(v*pct/100):'—'}</td></tr>`).join('')}</tbody></table>
  <h3>Actividades del parcial</h3>
  <table class="pr-table"><thead><tr><th>Fecha</th><th>Actividad</th><th>Tipo</th><th class="pr-num">Calificación</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="pr-grid">
    <section><h3>Asistencia (acumulada)</h3><table class="pr-table compact"><tbody><tr><td>Horas computables</td><td class="pr-num">${att.total}</td></tr><tr><td>Presente</td><td class="pr-num">${att.P} h</td></tr><tr><td>Faltas</td><td class="pr-num">${att.F} h</td></tr><tr><td>Retardos</td><td class="pr-num">${att.R} h</td></tr><tr><td>Justificadas</td><td class="pr-num">${att.J} h</td></tr><tr><td><b>Porcentaje de faltas</b></td><td class="pr-num"><b>${fmtPct(att.absencePct)}</b> · ${risk.label}</td></tr></tbody></table></section>
    <section><h3>Puntos extra (Parcial ${period})</h3><table class="pr-table compact"><tbody><tr><td>Disponibles</td><td class="pr-num">+${ex.goodAvailable||0}</td></tr><tr><td>Usados en actividades</td><td class="pr-num">${ex.goodUsed||0}</td></tr><tr><td>Puntos negativos</td><td class="pr-num">${ex.bad?'-'+ex.bad:'0'}</td></tr></tbody></table></section>
  </div>
  <div class="pr-signs"><div><span></span><small>Ing. Niccolás C.M. · Docente</small></div><div><span></span><small>Nombre y firma de enterado (padre, madre o tutor)</small></div></div>
  ${prFoot()}`;
  printHTML(`Boleta ${studentLabel(s)} · Parcial ${period}`,html);
}
$('#printStudentReport')?.addEventListener('click',()=>printStudentReport().catch(e=>{console.error(e);toast(e.message,true);}));

async function printAttendanceReport(){
  const gid=attendanceHistoryGroupId();if(!gid){toast('Selecciona un grupo.',true);return;}
  const g=await getGroupState(gid);
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const records=await MiAulaDB.byIndex('attendance','group_id',gid);
  const byStudent=new Map();for(const r of records){if(!byStudent.has(r.student_id))byStudent.set(r.student_id,[]);byStudent.get(r.student_id).push(r);}
  const rows=students.map(s=>({s,t:attendanceTotals(byStudent.get(s.id)||[]),pending:isSecretaryPendingStudent(s)}));
  const normal=rows.filter(r=>!r.pending),risk=normal.filter(r=>(r.t.absencePct||0)>=15).sort((a,b)=>(b.t.absencePct||0)-(a.t.absencePct||0));
  const dates=[...new Set(records.map(r=>r.attendance_date))].sort();
  const range=dates.length?`${parseISODateLocal(dates[0]).toLocaleDateString('es-MX',{day:'numeric',month:'short'})} – ${parseISODateLocal(dates[dates.length-1]).toLocaleDateString('es-MX',{day:'numeric',month:'short',year:'numeric'})}`:'Sin registros';
  const line=({s,t,pending})=>{const m=absenceRiskMeta(t.absencePct);return `<tr class="${pending?'pr-pending':m.key}"><td class="pr-num">${s.list_number??'—'}</td><td>${escapeHtml(studentLabel(s))}</td><td class="pr-num">${t.total}</td><td class="pr-num">${t.P}</td><td class="pr-num">${t.F}</td><td class="pr-num">${t.R}</td><td class="pr-num">${t.J}</td><td class="pr-num"><b>${pending?'—':fmtPct(t.absencePct)}</b></td><td>${pending?'Pendiente Secretaría':m.label}</td></tr>`;};
  const head='<thead><tr><th class="pr-num">No.</th><th>Alumno</th><th class="pr-num">Horas</th><th class="pr-num">P</th><th class="pr-num">F</th><th class="pr-num">R</th><th class="pr-num">J</th><th class="pr-num">% faltas</th><th>Estado</th></tr></thead>';
  const html=`${prHeader('Reporte de inasistencias',g,`<span>Periodo: ${range}</span>`)}
  <section class="pr-kpis"><div><small>Alumnos activos</small><strong>${students.length}</strong></div><div class="critical"><small>20% o más</small><strong>${normal.filter(r=>(r.t.absencePct||0)>=20).length}</strong></div><div class="warning"><small>15% a 19.9%</small><strong>${normal.filter(r=>(r.t.absencePct||0)>=15&&(r.t.absencePct||0)<20).length}</strong></div><div><small>Pendientes Secretaría</small><strong>${rows.filter(r=>r.pending).length}</strong></div></section>
  <h3>Alumnos que requieren atención (15% o más de faltas)</h3>
  ${risk.length?`<table class="pr-table">${head}<tbody>${risk.map(line).join('')}</tbody></table>`:'<p class="pr-muted">Ningún alumno alcanza el 15% de faltas.</p>'}
  ${rows.some(r=>r.pending)?`<h3>Pendientes de confirmar con Secretaría</h3><table class="pr-table">${head}<tbody>${rows.filter(r=>r.pending).map(line).join('')}</tbody></table>`:''}
  <h3>Lista completa del grupo</h3>
  <table class="pr-table">${head}<tbody>${rows.map(line).join('')}</tbody></table>
  <p class="pr-note">Porcentaje = horas de falta / horas computables × 100. Las horas marcadas como Pendiente Secretaría no se incluyen en el cálculo.</p>
  <div class="pr-signs"><div><span></span><small>Ing. Niccolás C.M. · Docente</small></div><div><span></span><small>Recibido por Secretaría / Control escolar</small></div></div>
  ${prFoot()}`;
  printHTML(`Inasistencias ${g.name}`,html);
}
$('#printAttendanceReport')?.addEventListener('click',()=>printAttendanceReport().catch(e=>{console.error(e);toast(e.message,true);}));

// ==========================================================================
// 2.8.0 · Rúbricas y listas de cotejo de un clic + calificar por equipos
// La lógica de cálculo vive en rubricas.js (MiAulaRubricas) y tiene pruebas.
// Datos: plantillas en el almacén `instruments` (format:'rubrica-v2');
// la actividad guarda una COPIA en activity.rubric; cada alumno guarda su
// selección en grades.rubric_levels y la nota calculada en grades.score.
// ==========================================================================
const RB=MiAulaRubricas;
const listOrder=(a,b)=>(a.list_number??9999)-(b.list_number??9999);
function isRubricActivity(a){return a?.grading_mode==='rubric';}
const activityRubricCache=new WeakMap();
function activityRubric(a){
  if(!isRubricActivity(a))return null;
  if(activityRubricCache.has(a))return activityRubricCache.get(a);
  const n=RB.normalizeRubric(a.rubric),r=n.ok?n.rubric:null;
  activityRubricCache.set(a,r);return r;
}
function rubricGradeState(a,rec){
  const r=activityRubric(a);
  if(!r)return {valid:false,complete:false,done:0,total:0,score:null};
  return RB.rubricScore(r,RB.cleanSelection(r,rec?.rubric_levels),+a.max_score||10);
}
function rubricGradeScore(a,rec){return rubricGradeState(a,rec).score;}
// Valor para Excel/boleta: número completo, “2 de 5 criterios” si está incompleta.
function exportGradeValue(a,rec){
  if(isRubricActivity(a)){
    const st=rubricGradeState(a,rec);
    if(st.complete)return st.score;
    if(st.done>0)return `${st.done} de ${st.total} criterios`;
    return '';
  }
  return rec?.score!=null?rec.score:(String(rec?.status||'').toUpperCase()==='NP'?'NP':'');
}
function scoreTone(score,max=10){
  const v=+score*10/(+max||10);
  return v>=8?'good':v>=6?'mid':'low';
}

// ---------- Deshacer genérico (12 s) ----------
let actionUndoTimer=null,actionUndoFn=null;
function showActionUndo(message,undoFn,ms=12000){
  const bar=$('#actionUndo');if(!bar)return;
  $('#actionUndoMessage').textContent=message;actionUndoFn=undoFn;
  bar.classList.remove('hidden');clearTimeout(actionUndoTimer);
  actionUndoTimer=setTimeout(()=>{bar.classList.add('hidden');actionUndoFn=null;},ms);
}
$('#actionUndoBtn')?.addEventListener('click',async()=>{
  const fn=actionUndoFn;actionUndoFn=null;$('#actionUndo').classList.add('hidden');clearTimeout(actionUndoTimer);
  if(fn){try{await fn();toast('Cambio deshecho');}catch(e){console.error(e);toast('No se pudo deshacer: '+e.message,true);}}
});

async function refreshAfterGradeChange(){
  if(currentView==='notebook')await loadNotebook();
  else if(currentView==='activities')await loadActivities();
  try{await loadSummary();}catch{}
}

// ---------- Plantillas (Mis rúbricas) ----------
async function loadRubricTemplates(){
  return (await MiAulaDB.all('instruments')).filter(i=>i.format===RB.FORMAT).sort((a,b)=>String(a.name).localeCompare(String(b.name),'es'));
}
async function rubricTemplateFromRef(ref){
  const [kind,id]=String(ref||'').split(':');
  if(kind==='bank')return RB.BANK.find(b=>b.id===id)||null;
  if(kind==='mine')return await MiAulaDB.get('instruments',+id)||null;
  return null;
}
async function rubricSnapshotFromRef(ref){
  const t=await rubricTemplateFromRef(ref);if(!t)return null;
  return RB.snapshotForActivity(t,ref);
}
function rubricSummary(r){
  return r.kind==='cotejo'?`Lista de cotejo · ${r.criteria.length} criterios`:`Rúbrica · ${r.levels.length} niveles · ${r.criteria.length} criterios`;
}
async function populateActivityRubricSelect(){
  const sel=$('#activityRubricSelect');if(!sel)return;
  const prev=sel.value,mine=await loadRubricTemplates();
  const opt=(v,t)=>`<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
  sel.innerHTML='<option value="">Elige una…</option>'
    +(mine.length?`<optgroup label="Mis rúbricas">${mine.map(m=>opt('mine:'+m.id,`${m.name} (${m.kind==='cotejo'?'lista de cotejo':'rúbrica'})`)).join('')}</optgroup>`:'')
    +`<optgroup label="Banco de MiAula">${RB.BANK.map(b=>opt('bank:'+b.id,`${b.name} (${b.kind==='cotejo'?'lista de cotejo':'rúbrica'})`)).join('')}</optgroup>`;
  if([...sel.options].some(o=>o.value===prev))sel.value=prev;
  if(typeof populateEvalInstrumentSelect==='function')populateEvalInstrumentSelect();
}
function syncGradingModeUI(){
  const rubric=document.querySelector('#activityForm input[name="grading_mode"]:checked')?.value==='rubric';
  $('#activityRubricLabel')?.classList.toggle('hidden',!rubric);
  $('#activityMaxLabel')?.classList.toggle('hidden',rubric);
  const sel=$('#activityRubricSelect');if(sel)sel.required=rubric;
}
$$('#activityForm input[name="grading_mode"]').forEach(r=>r.addEventListener('change',syncGradingModeUI));
populateActivityRubricSelect();syncGradingModeUI();

// ---------- Botones en tarjetas, cuaderno y Vista alumno ----------
function activityCardButtons(a){
  if(isRubricActivity(a)){
    const ok=!!activityRubric(a);
    return `<button class="btn small primary" onclick="openRubricEvaluator(${a.id})" ${ok?'':'disabled title="La rúbrica de esta actividad está dañada"'}>Evaluar</button><button class="btn small subtle" onclick="openTeamGrading(${a.id})" ${ok?'':'disabled'}>Evaluar por equipos</button><button class="btn small subtle" onclick="openActivityRubricEditor(${a.id})" ${ok?'':'disabled'}>Rúbrica</button>`;
  }
  return `<button class="btn small primary" onclick="openGrades(${a.id})">Calificar</button><button class="btn small subtle" onclick="openTeamGrading(${a.id})">Calificar por equipos</button>`;
}
function teamColumnButton(a){
  const label=isRubricActivity(a)?'Evaluar por equipos':'Calificar por equipos';
  return `<button type="button" class="col-team-btn" onclick="openTeamGrading(${a.id})" aria-label="${label}: ${escapeHtml(a.title)}" title="${label}"><svg class="ui-icon" aria-hidden="true"><use href="#i-teams"></use></svg><span>Equipos</span></button>`;
}
function rubricNotebookCell(a,s,pd,rec){
  const st=rubricGradeState(a,rec),name=studentLabel(s);
  if(!st.valid)return `<td class="notebook-grade-cell rubric-cell"><button type="button" class="rubric-cell-btn broken" disabled aria-label="Rúbrica dañada">—</button></td>`;
  let cls='todo',label='Evaluar',aria=`Evaluar a ${name} en ${a.title}`;
  if(st.complete){cls='done '+scoreTone(st.score,a.max_score);label=fmtNum(st.score);aria=`${name}: ${fmtNum(st.score)} en ${a.title}. Toca para revisar.`;}
  else if(st.done>0){cls='partial';label=`${st.done}/${st.total}`;aria=`${name}: ${st.done} de ${st.total} criterios evaluados en ${a.title}`;}
  return `<td class="notebook-grade-cell rubric-cell"><button type="button" class="rubric-cell-btn ${cls}" onclick="openRubricEvaluator(${a.id},{studentId:${s.id}})" aria-label="${escapeHtml(aria)}">${label}</button></td>`;
}
function rubricDrawerCard(a,pd,studentId){
  const st=rubricGradeState(a,pd.grades.get(`${a.id}:${studentId}`)),r=activityRubric(a);
  const status=!st.valid?'<span class="pending-score">Rúbrica dañada</span>':st.complete?`<b class="rubric-pill ${scoreTone(st.score,a.max_score)}">${fmtNum(st.score)}</b>`:st.done?`<b class="rubric-pill partial">${st.done}/${st.total}</b>`:'<span class="pending-score">Sin evaluar</span>';
  return `<div class="student-activity-card"><div class="student-activity-copy"><strong>${escapeHtml(a.title)}</strong>${activityMaxIndicator(a)}<small>${r?escapeHtml(rubricSummary(r)):'Rúbrica'}</small></div><div class="student-score-box rubric-drawer-box">${status}<button type="button" class="btn small primary" ${st.valid?'':'disabled'} onclick="closeStudentDrawer();openRubricEvaluator(${a.id},{studentId:${studentId}})">Evaluar con rúbrica</button></div></div>`;
}

// ---------- Pestañas de Calificaciones ----------
function setActivitiesTab(tab){
  $$('#activitiesTabs button').forEach(b=>{const on=b.dataset.tab===tab;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});
  $('#rubricLibrary')?.classList.toggle('hidden',tab!=='rubrics');
  $('#activitiesTabMain')?.classList.toggle('hidden',tab==='rubrics');
  if(tab==='rubrics'){$('#gradePanel')?.classList.add('hidden');renderRubricLibrary();}
}
$$('#activitiesTabs button').forEach(b=>b.addEventListener('click',()=>setActivitiesTab(b.dataset.tab)));

// ---------- Biblioteca de rúbricas ----------
async function renderRubricLibrary(){
  const box=$('#rubricLibrary');if(!box)return;
  const mine=await loadRubricTemplates();
  const legacy=(await MiAulaDB.all('instruments')).filter(i=>i.format!==RB.FORMAT&&Array.isArray(i.criteria));
  const card=(r,actions,extraCls='')=>`<article class="rubric-card ${extraCls}"><div class="rubric-card-head"><span class="rubric-kind ${r.kind}">${r.kind==='cotejo'?'Lista de cotejo':'Rúbrica'}</span><h4>${escapeHtml(r.name)}</h4><small>${escapeHtml(rubricSummary(r))}</small></div><p class="rubric-card-crit">${r.criteria.slice(0,4).map(c=>escapeHtml(c.n)).join(' · ')}${r.criteria.length>4?' · …':''}</p><div class="rubric-card-actions">${actions}</div></article>`;
  const mineCards=mine.map(m=>{const n=RB.normalizeRubric(m);if(!n.ok)return `<article class="rubric-card broken"><h4>${escapeHtml(m.name||'Sin nombre')}</h4><p>Esta rúbrica está dañada y no se puede usar.</p><div class="rubric-card-actions"><button class="btn small danger" onclick="removeRubricTemplate(${m.id})">Quitar</button></div></article>`;
    return card(n.rubric,`<button class="btn small primary" onclick="useRubricInActivity('mine:${m.id}')">Usar en una actividad</button><button class="btn small subtle" onclick="editRubricTemplate(${m.id})">Editar</button><button class="btn small subtle" onclick="duplicateRubricTemplate(${m.id})">Duplicar</button><button class="btn small subtle" onclick="printRubricRef('mine:${m.id}')">Imprimir</button><button class="btn small subtle" onclick="shareRubricTemplate(${m.id})">Compartir</button><button class="btn small danger" onclick="removeRubricTemplate(${m.id})">Quitar</button>`);}).join('');
  const bankCards=RB.BANK.map(b=>card(b,`<button class="btn small primary" onclick="useRubricInActivity('bank:${b.id}')">Usar en una actividad</button><button class="btn small subtle" onclick="viewRubricRef('bank:${b.id}')">Ver</button><button class="btn small subtle" onclick="printRubricRef('bank:${b.id}')">Imprimir</button><button class="btn small subtle" onclick="copyBankRubric('${b.id}')">Hacer una copia para editar</button>`,'bank')).join('');
  const legacyCards=legacy.map(i=>`<article class="rubric-card legacy"><div class="rubric-card-head"><span class="rubric-kind">${i.instrument_type==='checklist'?'Lista de cotejo':'Rúbrica'} · Proyecto</span><h4>${escapeHtml(i.name)}</h4><small>${i.criteria.length} criterios · formato anterior</small></div><p class="rubric-card-crit">Sigue funcionando igual en la pantalla Proyecto.</p><div class="rubric-card-actions"><button class="btn small subtle" onclick="convertLegacyInstrument(${i.id})">Crear copia de un clic</button></div></article>`).join('');
  box.innerHTML=`
    <div class="panel rubric-help"><div><h3>Rúbricas y listas de cotejo</h3><p>Crea una actividad con <b>«Cómo se califica: Rúbrica o lista de cotejo»</b>. Al evaluar, solo tocas el nivel de cada criterio y MiAula calcula la nota de 0 a 10. Puedes usar las del banco tal cual o hacer una copia para ajustarla.</p></div>
      <div class="rubric-help-actions"><button class="btn primary" onclick="newRubricTemplate('rubrica')">+ Nueva rúbrica</button><button class="btn subtle" onclick="newRubricTemplate('cotejo')">+ Nueva lista de cotejo</button><button class="btn subtle" onclick="exportMyRubrics()" ${mine.length?'':'disabled'}>Guardar mis rúbricas en un archivo</button><button class="btn subtle" onclick="openRubricImport()">Traer rúbricas de un archivo</button></div></div>
    <section class="rubric-section"><h3>Mis rúbricas <small>${mine.length}</small></h3>${mine.length?`<div class="rubric-grid">${mineCards}</div>`:'<div class="empty-state">Todavía no tienes rúbricas propias. Usa una del banco, haz una copia para editarla o crea una nueva.</div>'}</section>
    ${legacy.length?`<section class="rubric-section"><h3>Instrumentos de Proyecto (formato anterior) <small>${legacy.length}</small></h3><div class="rubric-grid">${legacyCards}</div></section>`:''}
    <section class="rubric-section"><h3>Banco de MiAula <small>${RB.BANK.length}</small></h3><div class="rubric-grid">${bankCards}</div></section>`;
}
window.useRubricInActivity=async ref=>{
  setActivitiesTab('activities');
  const radio=document.querySelector('#activityForm input[name="grading_mode"][value="rubric"]');if(radio)radio.checked=true;
  await populateActivityRubricSelect();$('#activityRubricSelect').value=ref;syncGradingModeUI();
  const name=document.querySelector('#activityForm input[name="title"]');name?.focus();name?.scrollIntoView({block:'center'});
  toast('Escribe el nombre de la actividad y toca «Crear actividad».');
};
window.copyBankRubric=async id=>{
  const b=RB.BANK.find(x=>x.id===id);if(!b)return;
  const mine=await loadRubricTemplates(),copy=RB.clone(RB.normalizeRubric(b).rubric);
  copy.name=RB.uniqueName(`${b.name} (mi copia)`,mine.map(m=>m.name));copy.criteria=copy.criteria.map(c=>({...c,id:RB.newId()}));
  const id2=await MiAulaDB.add('instruments',{...copy,format:RB.FORMAT,created_at:new Date().toISOString()});
  await populateActivityRubricSelect();await renderRubricLibrary();toast('Copia creada en «Mis rúbricas»');
  editRubricTemplate(id2);
};
window.duplicateRubricTemplate=async id=>{
  const t=await MiAulaDB.get('instruments',id);if(!t)return;
  const mine=await loadRubricTemplates(),copy=RB.clone(t);delete copy.id;
  copy.name=RB.uniqueName(t.name,mine.map(m=>m.name));copy.criteria=(copy.criteria||[]).map(c=>({...c,id:RB.newId()}));copy.created_at=new Date().toISOString();
  await MiAulaDB.add('instruments',copy);await populateActivityRubricSelect();await renderRubricLibrary();toast(`Duplicada como «${copy.name}»`);
};
window.removeRubricTemplate=async id=>{
  const t=await MiAulaDB.get('instruments',id);if(!t)return;
  await MiAulaDB.remove('instruments',id);await populateActivityRubricSelect();await renderRubricLibrary();
  showActionUndo(`Se quitó «${t.name}». Las actividades que ya la usan no cambian.`,async()=>{await MiAulaDB.put('instruments',t);await populateActivityRubricSelect();await renderRubricLibrary();});
};
window.convertLegacyInstrument=async id=>{
  const inst=await MiAulaDB.get('instruments',id),r=RB.fromLegacyInstrument(inst);if(!r){toast('No se pudo convertir este instrumento.',true);return;}
  const mine=await loadRubricTemplates();r.name=RB.uniqueName(r.name,mine.map(m=>m.name));
  const nid=await MiAulaDB.add('instruments',{...r,format:RB.FORMAT,created_at:new Date().toISOString()});
  await populateActivityRubricSelect();await renderRubricLibrary();toast('Copia creada. Escribe las descripciones de cada nivel.');editRubricTemplate(nid);
};
window.newRubricTemplate=kind=>{
  const levels=kind==='cotejo'?RB.clone(RB.CHECKLIST_LEVELS):[{n:'Destacado',p:10},{n:'Satisfactorio',p:8},{n:'Suficiente',p:6},{n:'Requiere apoyo',p:5}];
  openRubricEditor({mode:'template',isNew:true,rubric:{name:'',kind,levels,criteria:[{id:RB.newId(),n:'',w:kind==='cotejo'?1:25,d:levels.map(()=> '')}]}});
};
window.editRubricTemplate=async id=>{
  const t=await MiAulaDB.get('instruments',id);if(!t)return;
  openRubricEditor({mode:'template',id,rubric:RB.clone(t)});
};
window.viewRubricRef=async ref=>{
  const t=await rubricTemplateFromRef(ref),n=RB.normalizeRubric(t);if(!n.ok){toast('Esta rúbrica está dañada.',true);return;}
  openModal(n.rubric.name,`<div class="rubric-preview">${rubricTableHTML(n.rubric)}</div><div class="modal-actions"><button class="btn subtle" onclick="printRubricRef('${escapeHtml(ref)}')">Imprimir</button>${ref.startsWith('bank:')?`<button class="btn primary" onclick="closeModal();copyBankRubric('${escapeHtml(ref.slice(5))}')">Hacer una copia para editar</button>`:''}</div>`);
  $('#modal .modal-card')?.classList.add('wide');
};
function rubricTableHTML(r){
  const pct=RB.weightPercents(r.criteria);
  if(r.kind==='cotejo')return `<table class="rubric-view-table"><thead><tr><th>Criterio</th><th>Peso</th><th>Sí</th><th>No</th></tr></thead><tbody>${r.criteria.map((c,i)=>`<tr><td>${escapeHtml(c.n)}</td><td>${pct[i]}%</td><td class="box"></td><td class="box"></td></tr>`).join('')}</tbody></table>`;
  return `<table class="rubric-view-table"><thead><tr><th>Criterio</th>${r.levels.map(l=>`<th>${escapeHtml(l.n)}<small>${fmtShort(l.p)} pts</small></th>`).join('')}</tr></thead><tbody>${r.criteria.map((c,i)=>`<tr><td><b>${escapeHtml(c.n)}</b><small>${pct[i]}%</small></td>${r.levels.map((_,j)=>`<td>${escapeHtml(c.d?.[j]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function printRubricSheet(r,opts={}){
  const g=opts.group||{};
  const html=`<header class="pr-head"><div class="pr-brand"><svg viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="#3F6E9E"/><path d="M14 20.5c6-2.6 12-2.2 18 1.6v24c-6-3.8-12-4.2-18-1.6z" fill="#fff"/><path d="M50 20.5c-6-2.6-12-2.2-18 1.6v24c6-3.8 12-4.2 18-1.6z" fill="#fff" opacity=".75"/></svg><div><strong>${escapeHtml(opts.title||r.name)}</strong><span>${r.kind==='cotejo'?'Lista de cotejo':'Rúbrica'}${opts.title?` · ${escapeHtml(r.name)}`:''}${g.name?` · ${escapeHtml(g.name)} ${escapeHtml(g.discipline||'')}`:''}</span></div></div><div class="pr-meta"><span>Calificación de 0 a ${fmtShort(opts.maxScore||10)}</span></div></header>
  <section class="pr-fill"><div><small>Nombre del alumno</small><span></span></div><div><small>Grupo</small><span></span></div><div><small>Fecha</small><span></span></div><div><small>Calificación</small><span></span></div></section>
  <div class="pr-rubric">${rubricTableHTML(r)}</div>
  <p class="pr-note">${r.kind==='cotejo'?'Cada criterio cumplido (Sí) suma según su peso.':'La calificación se calcula con el nivel alcanzado en cada criterio y su peso.'}</p>
  <footer class="pr-foot"><span>Generado con MiAula Slate · Control de bitácora</span></footer>`;
  printHTML(`${r.kind==='cotejo'?'Lista de cotejo':'Rúbrica'} ${r.name}`,html);
}
window.printRubricRef=async ref=>{const t=await rubricTemplateFromRef(ref),n=RB.normalizeRubric(t);if(!n.ok){toast('Esta rúbrica está dañada.',true);return;}printRubricSheet(n.rubric);};

// ---------- Compartir por archivo ----------
function downloadRubricFile(list,label){
  const file=RB.buildShareFile(list);
  downloadBlob(new Blob([JSON.stringify(file,null,2)],{type:'application/json'}),`MiAula_rubricas_${label}_${new Date().toISOString().slice(0,10)}.json`);
  toast(`Archivo guardado con ${file.count} rúbrica${file.count===1?'':'s'}. No incluye datos de alumnos.`);
}
window.exportMyRubrics=async()=>{const mine=await loadRubricTemplates();if(!mine.length){toast('Aún no tienes rúbricas propias.',true);return;}downloadRubricFile(mine,'mis_rubricas');};
window.shareRubricTemplate=async id=>{const t=await MiAulaDB.get('instruments',id);if(t)downloadRubricFile([t],String(t.name).replace(/[^\wáéíóúñü]+/gi,'_').slice(0,40));};
let rubricImportItems=[];
window.openRubricImport=()=>{
  openModal('Traer rúbricas de un archivo',`<p class="modal-help">Elige o arrastra un archivo <b>.json</b> de rúbricas de MiAula (por ejemplo, el que te compartió otro docente). Antes de agregar podrás ver cuáles trae.</p>
    <label class="rubric-drop" id="rubricDrop" tabindex="0"><input type="file" id="rubricImportFile" accept=".json,application/json" hidden><b>Arrastra aquí el archivo</b><span>o toca para elegirlo</span></label>
    <div id="rubricImportResult"></div>`);
  $('#modal .modal-card')?.classList.add('wide');
  const drop=$('#rubricDrop'),input=$('#rubricImportFile');
  input.onchange=()=>{if(input.files[0])readRubricImportFile(input.files[0]);};
  drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click();}});
  ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
  ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
  drop.addEventListener('drop',e=>{const f=e.dataTransfer?.files?.[0];if(f)readRubricImportFile(f);});
};
async function readRubricImportFile(file){
  const box=$('#rubricImportResult');
  const res=RB.parseShareFile(await file.text());
  if(!res.ok){rubricImportItems=[];box.innerHTML=`<div class="import-error ${res.backup?'backup':''}">${escapeHtml(res.error)}</div>`;return;}
  rubricImportItems=res.items;
  box.innerHTML=`<div class="import-list">${res.items.map((it,i)=>`<label class="import-item ${it.ok?'':'bad'}"><input type="checkbox" data-import="${i}" ${it.ok?'checked':'disabled'}><span><b>${escapeHtml(it.name)}</b><small>${it.ok?escapeHtml(rubricSummary(it.rubric)):'Dañada: '+escapeHtml(it.error||'')}</small></span></label>`).join('')}</div>
    <div class="modal-actions"><button class="btn subtle" onclick="closeModal()">Cancelar</button><button class="btn primary" id="rubricImportApply">Agregar las seleccionadas</button></div>`;
  $('#rubricImportApply').onclick=applyRubricImport;
}
async function applyRubricImport(){
  const chosen=$$('#rubricImportResult input[data-import]:checked').map(x=>rubricImportItems[+x.dataset.import]).filter(it=>it?.ok).map(it=>it.rubric);
  if(!chosen.length){toast('Marca al menos una rúbrica.',true);return;}
  const mine=await loadRubricTemplates(),prepared=RB.prepareImport(chosen,mine.map(m=>m.name)),now=new Date().toISOString();
  for(const r of prepared)await MiAulaDB.add('instruments',{...r,format:RB.FORMAT,imported_at:now,created_at:now});
  closeModal();await populateActivityRubricSelect();await renderRubricLibrary();
  toast(`${prepared.length} rúbrica${prepared.length===1?' agregada':'s agregadas'} a «Mis rúbricas»`);
}

// ---------- Editor de rúbricas ----------
let rubricEditorState=null;
function openRubricEditor(opts){
  rubricEditorState={...opts,draft:RB.clone(opts.rubric)};
  const d=rubricEditorState.draft;
  if(d.kind==='cotejo')d.levels=RB.clone(RB.CHECKLIST_LEVELS);
  d.criteria=(d.criteria||[]).map(c=>({id:c.id||RB.newId(),n:c.n||'',w:c.w??(d.kind==='cotejo'?1:25),d:d.levels.map((_,j)=>c.d?.[j]||'')}));
  $('#rubricEditor').classList.remove('hidden');document.body.classList.add('sheet-open');
  renderRubricEditor();
  setTimeout(()=>$('#rbeName')?.focus(),50);
}
function closeRubricEditor(){$('#rubricEditor').classList.add('hidden');document.body.classList.toggle('sheet-open',!$('#rubricEval').classList.contains('hidden'));rubricEditorState=null;}
function renderRubricEditor(){
  const st=rubricEditorState,d=st.draft,box=$('#rubricEditor'),locked=!!st.locked,cot=d.kind==='cotejo';
  const pct=RB.weightPercents(d.criteria);
  const title=st.mode==='activity'?`Rúbrica de la actividad «${escapeHtml(st.activityTitle||'')}»`:st.isNew?(cot?'Nueva lista de cotejo':'Nueva rúbrica'):'Editar rúbrica';
  box.innerHTML=`<div class="rb-sheet-inner">
    <header class="rb-head"><div><span class="eyebrow">${st.mode==='activity'?'Solo cambia esta actividad':'Plantilla en «Mis rúbricas»'}</span><h2 id="rubricEditorTitle">${title}</h2></div><button type="button" class="btn subtle" data-rbe="cancel">Cerrar sin guardar</button></header>
    <p class="rb-help">${cot?'En una lista de cotejo cada criterio se marca <b>Sí</b> o <b>No</b>. El peso indica cuánto vale cada criterio.':'Los niveles van del <b>mejor</b> al más bajo. El peso dice cuánto vale cada criterio (se muestra en %). En cada casilla describe cómo se ve ese nivel.'}${st.mode==='activity'?' Si cambias pesos o puntos, las notas de esta actividad se recalculan solas.':''}</p>
    ${locked?'<div class="rb-notice">Esta actividad ya tiene alumnos evaluados: puedes cambiar textos, pesos y puntos, pero no agregar ni quitar criterios o niveles.</div>':''}
    <div class="rbe-top"><label class="rbe-name">Nombre<input id="rbeName" data-rbe-field="name" value="${escapeHtml(d.name)}" placeholder="${cot?'Ej. Entrega de tarea':'Ej. Exposición oral'}" maxlength="120"></label>
    ${cot?'':`<div class="rbe-levels"><span class="rbe-label">Niveles (del mejor al más bajo)</span><div class="rbe-level-list">${d.levels.map((l,i)=>`<div class="rbe-level"><input aria-label="Nombre del nivel ${i+1}" data-lv-name="${i}" value="${escapeHtml(l.n)}"><label class="rbe-pts"><input type="number" aria-label="Puntos del nivel ${i+1}" data-lv-points="${i}" min="0" max="100" step="0.5" value="${escapeHtml(l.p)}"><span>pts</span></label>${!locked&&d.levels.length>2?`<button type="button" class="rbe-mini" data-lv-del="${i}" aria-label="Quitar el nivel ${escapeHtml(l.n||i+1)}">−</button>`:''}</div>`).join('')}${!locked&&d.levels.length<6?'<button type="button" class="btn small subtle" data-rbe="add-level">+ Nivel</button>':''}</div></div>`}</div>
    <div class="rbe-table-wrap"><table class="rbe-table"><thead><tr><th>Criterio</th><th class="rbe-w">Peso</th>${cot?'':d.levels.map((l,j)=>`<th data-lv-head="${j}">${escapeHtml(l.n)}</th>`).join('')}<th class="rbe-del"></th></tr></thead><tbody>
      ${d.criteria.map((c,i)=>`<tr><td><textarea rows="2" aria-label="Criterio ${i+1}" data-c-name="${i}" placeholder="Ej. Dominio del tema">${escapeHtml(c.n)}</textarea></td><td class="rbe-w"><input type="number" aria-label="Peso del criterio ${i+1}" data-c-w="${i}" min="0.1" max="100" step="0.5" value="${escapeHtml(c.w)}"><small data-c-pct="${i}">${pct[i]}%</small></td>${cot?'':d.levels.map((l,j)=>`<td><textarea rows="3" aria-label="Descripción de ${escapeHtml(l.n)} en criterio ${i+1}" data-c-d="${i}:${j}">${escapeHtml(c.d[j]||'')}</textarea></td>`).join('')}<td class="rbe-del">${!locked&&d.criteria.length>1?`<button type="button" class="rbe-mini" data-c-del="${i}" aria-label="Quitar el criterio ${i+1}">×</button>`:''}</td></tr>`).join('')}
    </tbody></table></div>
    ${!locked&&d.criteria.length<30?'<button type="button" class="btn subtle rbe-add" data-rbe="add-criterion">+ Agregar criterio</button>':''}
    <div class="rbe-errors" id="rbeErrors" role="alert"></div>
    <footer class="rb-foot"><button type="button" class="btn subtle" data-rbe="cancel">Cancelar</button><button type="button" class="btn primary rb-big" data-rbe="save">Guardar</button></footer>
  </div>`;
}
function rbeUpdatePercents(){
  const pct=RB.weightPercents(rubricEditorState.draft.criteria);
  pct.forEach((p,i)=>{const el=document.querySelector(`#rubricEditor [data-c-pct="${i}"]`);if(el)el.textContent=`${p}%`;});
}
$('#rubricEditor')?.addEventListener('input',e=>{
  const st=rubricEditorState;if(!st)return;const d=st.draft,t=e.target;
  if(t.dataset.rbeField==='name')d.name=t.value;
  else if(t.dataset.lvName!=null){d.levels[+t.dataset.lvName].n=t.value;const h=document.querySelector(`#rubricEditor [data-lv-head="${t.dataset.lvName}"]`);if(h)h.textContent=t.value;}
  else if(t.dataset.lvPoints!=null)d.levels[+t.dataset.lvPoints].p=t.value===''?'':+t.value;
  else if(t.dataset.cName!=null)d.criteria[+t.dataset.cName].n=t.value;
  else if(t.dataset.cW!=null){d.criteria[+t.dataset.cW].w=t.value===''?'':+t.value;rbeUpdatePercents();}
  else if(t.dataset.cD!=null){const [i,j]=t.dataset.cD.split(':').map(Number);d.criteria[i].d[j]=t.value;}
});
$('#rubricEditor')?.addEventListener('click',async e=>{
  const st=rubricEditorState;if(!st)return;const d=st.draft,b=e.target.closest('button');if(!b)return;
  const scrollBox=$('#rubricEditor'),y=scrollBox.scrollTop;
  if(b.dataset.lvDel!=null&&!st.locked){const i=+b.dataset.lvDel;d.levels.splice(i,1);d.criteria.forEach(c=>c.d.splice(i,1));renderRubricEditor();scrollBox.scrollTop=y;return;}
  if(b.dataset.cDel!=null&&!st.locked){d.criteria.splice(+b.dataset.cDel,1);renderRubricEditor();scrollBox.scrollTop=y;return;}
  const act=b.dataset.rbe;
  if(act==='add-level'&&!st.locked&&d.levels.length<6){d.levels.push({n:'Nuevo nivel',p:0});d.criteria.forEach(c=>c.d.push(''));renderRubricEditor();scrollBox.scrollTop=y;}
  else if(act==='add-criterion'&&!st.locked&&d.criteria.length<30){d.criteria.push({id:RB.newId(),n:'',w:d.kind==='cotejo'?1:15,d:d.levels.map(()=> '')});renderRubricEditor();scrollBox.scrollTop=scrollBox.scrollHeight;setTimeout(()=>{const all=$$('#rubricEditor [data-c-name]');all[all.length-1]?.focus();},30);}
  else if(act==='cancel')closeRubricEditor();
  else if(act==='save')await saveRubricEditor();
});
async function saveRubricEditor(){
  const st=rubricEditorState,d=RB.clone(st.draft);
  d.name=String(d.name||'').trim();d.criteria.forEach(c=>{c.n=String(c.n||'').trim();});
  const errors=RB.validateRubric(d);
  const errBox=$('#rbeErrors');
  if(errors.length){errBox.innerHTML=`<b>Revisa antes de guardar:</b><ul>${errors.slice(0,8).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`;errBox.scrollIntoView({block:'nearest'});return;}
  const norm=RB.normalizeRubric(d);if(!norm.ok){errBox.textContent=norm.error;return;}
  if(st.mode==='template'){
    const now=new Date().toISOString();
    let savedId=st.id;
    if(st.id){const old=await MiAulaDB.get('instruments',st.id);await MiAulaDB.put('instruments',{...(old||{}),...norm.rubric,id:st.id,format:RB.FORMAT,updated_at:now});}
    else savedId=await MiAulaDB.add('instruments',{...norm.rubric,format:RB.FORMAT,created_at:now});
    closeRubricEditor();await populateActivityRubricSelect();await renderRubricLibrary();toast('Rúbrica guardada');
    document.dispatchEvent(new CustomEvent('miaula:rubric-saved',{detail:{id:savedId}}));
    return;
  }
  // Rúbrica de una actividad
  const activity=await MiAulaDB.get('activities',st.activityId);if(!activity)return;
  const oldR=activityRubric(activity),grades=await MiAulaDB.byIndex('grades','activity_id',activity.id);
  const evaluated=grades.some(g=>g.rubric_levels&&Object.keys(g.rubric_levels).length);
  const check=RB.canApplyActivityEdit(oldR,norm.rubric,evaluated);
  if(!check.ok){errBox.textContent=check.error;return;}
  const updated={...activity,rubric:{...norm.rubric,source:activity.rubric?.source,copied_at:activity.rubric?.copied_at,edited_at:new Date().toISOString()}};
  await saveActivityRubric(updated,grades);
  closeRubricEditor();toast('Rúbrica de la actividad guardada · notas recalculadas');
  if(rubricEvalState&&+rubricEvalState.activity.id===+updated.id){rubricEvalState.activity=updated;rubricEvalState.rubric=activityRubric(updated);renderRubricEval();}
  else await refreshAfterGradeChange();
}
async function saveActivityRubric(activity,grades){
  await MiAulaDB.put('activities',activity);
  const r=activityRubric(activity);if(!r)return;
  for(const g of grades){
    if(!g.rubric_levels)continue;
    const sc=RB.rubricScore(r,RB.cleanSelection(r,g.rubric_levels),+activity.max_score||10).score;
    if(g.score!==sc)await MiAulaDB.put('grades',{...g,score:sc,updated_at:new Date().toISOString()});
  }
}
window.openActivityRubricEditor=async aid=>{
  const a=await MiAulaDB.get('activities',+aid),r=activityRubric(a);if(!r){toast('La rúbrica de esta actividad está dañada.',true);return;}
  const grades=await MiAulaDB.byIndex('grades','activity_id',a.id);
  const evaluated=grades.some(g=>g.rubric_levels&&Object.keys(g.rubric_levels).length);
  openRubricEditor({mode:'activity',activityId:a.id,activityTitle:a.title,rubric:r,locked:evaluated});
};

// ---------- Pantalla «Evaluar con rúbrica» ----------
let rubricEvalState=null;
window.openRubricEvaluator=async function(aid,opts={}){
  await flushNotebookAutoSave();
  const activity=await MiAulaDB.get('activities',+aid);if(!activity)return;
  if(!isRubricActivity(activity)){await openTeamGrading(aid);return;}
  const rubric=activityRubric(activity);
  if(!rubric){toast('La rúbrica de esta actividad está dañada; no se puede evaluar. El resto de tus datos está bien.',true);return;}
  const gid=+activity.group_id,g=await getGroupState(gid);
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort(listOrder);
  if(!students.length){toast('Este grupo no tiene alumnos activos.',true);return;}
  const grades=await MiAulaDB.byIndex('grades','activity_id',activity.id);
  const {teams}=await readSavedTeams(gid);
  rubricEvalState={activity,rubric,gid,group:g,students,recs:new Map(grades.map(x=>[+x.student_id,x])),teams:teams.filter(isUsableTeam),mode:'student',index:0,teamIndex:0,queue:Promise.resolve()};
  const st=rubricEvalState;
  if(opts.mode==='team'&&st.teams.length){st.mode='team';const i=st.teams.findIndex(t=>t.name===opts.teamName);st.teamIndex=i>=0?i:0;}
  else if(opts.studentId){const i=students.findIndex(s=>+s.id===+opts.studentId);st.index=i>=0?i:0;}
  $('#rubricEval').classList.remove('hidden');document.body.classList.add('sheet-open');
  renderRubricEval();
  setTimeout(()=>$('#rubricEval .rb-level')?.focus(),60);
};
function rbSelection(sid){
  const st=rubricEvalState;return RB.cleanSelection(st.rubric,st.recs.get(+sid)?.rubric_levels||{});
}
function rbTeamMembers(t){
  const st=rubricEvalState,active=new Map(st.students.map(s=>[+s.id,s]));
  return (t?.member_ids||[]).map(Number).filter(id=>active.has(id)&&!isSecretaryPendingStudent(active.get(id)));
}
function rbTargets(){
  const st=rubricEvalState;
  if(st.mode==='team')return rbTeamMembers(st.teams[st.teamIndex]);
  return [+st.students[st.index].id];
}
function rbStudentStatus(sid){
  const st=rubricEvalState;return RB.rubricScore(st.rubric,rbSelection(sid),+st.activity.max_score||10);
}
function rbTeamStatus(t){
  const st=rubricEvalState,ids=rbTeamMembers(t),sels=ids.map(rbSelection),total=st.rubric.criteria.length;
  if(!ids.length)return {label:'Sin alumnos',cls:'empty',done:0,total,complete:false};
  const done=st.rubric.criteria.filter(c=>Number.isInteger(RB.teamCriterionState(sels,c.id))).length;
  const scores=ids.map(rbStudentStatus);
  if(scores.every(x=>x.complete)){const same=scores.every(x=>x.score===scores[0].score);return {label:same?fmtNum(scores[0].score):'Ajustada',cls:same?'done '+scoreTone(scores[0].score,st.activity.max_score):'partial',done:total,total,complete:true,score:same?scores[0].score:null};}
  return {label:done?`${done}/${total}`:'Evaluar',cls:done?'partial':'todo',done,total,complete:false};
}
function statusChip(s,max){
  if(s.complete)return `<b class="rubric-pill ${scoreTone(s.score,max)}">${fmtNum(s.score)}</b>`;
  if(s.done)return `<b class="rubric-pill partial">${s.done}/${s.total}</b>`;
  return '<b class="rubric-pill todo">—</b>';
}
function renderRubricEval(){
  const st=rubricEvalState;if(!st)return;
  const r=st.rubric,a=st.activity,max=+a.max_score||10,cot=r.kind==='cotejo',team=st.mode==='team';
  const pct=RB.weightPercents(r.criteria),best=r.levels[0];
  const targets=rbTargets(),sels=targets.map(rbSelection);
  const stateFor=cid=>team?RB.teamCriterionState(sels,cid):(Number.isInteger(sels[0]?.[cid])?sels[0][cid]:null);
  let headName,headSub,scoreBox,members='',warning='';
  if(team){
    const t=st.teams[st.teamIndex],ts=rbTeamStatus(t);
    headName=escapeHtml(t.name);headSub=`Equipo ${st.teamIndex+1} de ${st.teams.length}`;
    const tags=(t.members||[]).map(m=>{const ok=targets.includes(+m.id);return `<span class="rb-member ${ok?'':'off'}">${m.list_number??'—'}. ${escapeHtml(studentLabel(m))}${ok?'':` · ${m.active===0?'baja':'Secretaría'} (no se califica)`}</span>`;}).join('');
    members=`<div class="rb-members">${tags||'<span class="rb-member off">Sin integrantes</span>'}</div>`;
    if(targets.length>1&&RB.selectionsDiffer(sels))warning='<div class="rb-warning" role="status">Algunos integrantes tienen evaluaciones distintas: cada criterio que toques quedará igual para todos.</div>';
    scoreBox=!targets.length?'<div class="rb-score empty">Sin alumnos activos</div>':ts.complete&&ts.score!=null?`<div class="rb-score ${scoreTone(ts.score,max)}"><small>Nota del equipo</small><b>${fmtNum(ts.score)}</b><span>de ${fmtShort(max)}</span></div>`:ts.complete?'<div class="rb-score partial"><small>Nota</small><b>Ajustada</b><span>cada integrante tiene su nota</span></div>':`<div class="rb-score pending"><small>Faltan</small><b>${ts.total-ts.done}</b><span>criterio${ts.total-ts.done===1?'':'s'}</span></div>`;
  }else{
    const s=st.students[st.index],res=RB.rubricScore(r,sels[0],max);
    headName=`${s.list_number??'—'}. ${escapeHtml(studentLabel(s))}`;headSub=`Alumno ${st.index+1} de ${st.students.length}`;
    scoreBox=res.complete?`<div class="rb-score ${scoreTone(res.score,max)}"><small>Nota</small><b>${fmtNum(res.score)}</b><span>de ${fmtShort(max)}</span></div>`:`<div class="rb-score pending"><small>Faltan</small><b>${res.total-res.done}</b><span>criterio${res.total-res.done===1?'':'s'}</span></div>`;
  }
  const list=team
    ?st.teams.map((t,i)=>{const ts=rbTeamStatus(t);return `<button type="button" class="rb-list-item ${i===st.teamIndex?'current':''}" data-rb-team="${i}" aria-current="${i===st.teamIndex}"><span><b>${escapeHtml(t.name)}</b><small>${rbTeamMembers(t).length} alumnos</small></span><b class="rubric-pill ${ts.cls}">${ts.label}</b></button>`;}).join('')
    :st.students.map((s,i)=>`<button type="button" class="rb-list-item ${i===st.index?'current':''}" data-rb-student="${i}" aria-current="${i===st.index}"><span><b>${s.list_number??'—'}</b>${escapeHtml(studentLabel(s))}</span>${statusChip(rbStudentStatus(s.id),max)}</button>`).join('');
  const rows=r.criteria.map((c,i)=>{
    const cur=stateFor(c.id),some=team?new Set(sels.map(x=>x[c.id]).filter(Number.isInteger)):new Set();
    return `<tr><th scope="row"><b>${escapeHtml(c.n)}</b><small>${pct[i]}%</small></th>${r.levels.map((l,j)=>{
      const on=cur===j,partial=!on&&cur==='mixed'&&some.has(j);
      const desc=cot?'':(c.d?.[j]||'');
      const aria=`${c.n}: ${l.n}${cot?'':` (${fmtShort(l.p)} puntos)`}${desc?'. '+desc:''}${on?'. Elegido':''}`;
      return `<td><button type="button" class="rb-level ${on?'on':''} ${partial?'some':''} ${cot&&j===1?'is-no':''}" data-crit="${escapeHtml(c.id)}" data-level="${j}" aria-pressed="${on}" aria-label="${escapeHtml(aria)}"><b>${escapeHtml(l.n)}</b>${desc?`<span>${escapeHtml(desc)}</span>`:''}</button></td>`;
    }).join('')}</tr>`;
  }).join('');
  const lastIdx=team?st.teams.length-1:st.students.length-1,cur=team?st.teamIndex:st.index;
  $('#rubricEval').innerHTML=`<div class="rb-eval-layout">
    <aside class="rb-list" aria-label="${team?'Equipos':'Alumnos del grupo'}"><div class="rb-list-head"><b>${team?'Equipos':'Grupo '+escapeHtml(st.group?.name||'')}</b><small>${team?'Toca un equipo':'Toca un alumno'}</small></div><div class="rb-list-items">${list}</div></aside>
    <section class="rb-main">
      <header class="rb-eval-head">
        <div class="rb-eval-title"><span class="eyebrow">${cot?'Lista de cotejo':'Rúbrica'} · ${escapeHtml(a.title)}</span><h2 id="rubricEvalTitle">${headName}</h2><small>${headSub}</small>${members}</div>
        ${scoreBox}
        <button type="button" class="btn subtle rb-close" data-rb="close" aria-label="Cerrar la evaluación">Cerrar</button>
      </header>
      <div class="rb-tools"><button type="button" class="rb-link" data-rb="edit">Ver o cambiar la rúbrica</button><button type="button" class="rb-link" data-rb="print">Imprimir la rúbrica</button>${team?'<button type="button" class="rb-link" data-rb="mode-student">Evaluar alumno por alumno</button>':st.teams.length?'<button type="button" class="rb-link" data-rb="mode-team">Evaluar por equipos</button>':'<span class="rb-hint">Para evaluar por equipos, forma equipos en «Ruleta y equipos».</span>'}</div>
      ${warning}
      <p class="rb-help">${team?'Cada nivel que toques se aplica a todos los integrantes. ':''}Toca el nivel de cada criterio. Tocar otro nivel lo cambia; tocar el mismo lo quita. Se guarda solo.</p>
      <div class="rb-table-wrap"><table class="rb-table ${cot?'cotejo':''}"><thead><tr><th>Criterio</th>${r.levels.map(l=>`<th>${escapeHtml(l.n)}${cot?'':`<small>${fmtShort(l.p)} pts</small>`}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <footer class="rb-eval-foot">
        <button type="button" class="btn subtle" data-rb="prev" ${cur<=0?'disabled':''}>← ${team?'Equipo anterior':'Anterior'}</button>
        <button type="button" class="btn subtle" data-rb="all-best" ${team&&!targets.length?'disabled':''}>Todo en «${escapeHtml(best.n)}»</button>
        <button type="button" class="btn subtle danger-text-btn" data-rb="clear" ${team&&!targets.length?'disabled':''}>Borrar lo de este ${team?'equipo':'alumno'}</button>
        <button type="button" class="btn primary rb-next" id="rbNext" data-rb="next">${cur>=lastIdx?'Terminar':team?'Siguiente equipo →':'Siguiente alumno →'}</button>
      </footer>
    </section></div>`;
  $('#rubricEval .rb-list-item.current')?.scrollIntoView({block:'nearest'});
}
function rbSave(entries){
  const st=rubricEvalState,a=st.activity,r=st.rubric,max=+a.max_score||10,now=new Date().toISOString();
  for(const {sid,sel} of entries){
    const old=st.recs.get(+sid)||null;
    st.recs.set(+sid,{...(old||{}),activity_id:a.id,student_id:+sid,rubric_levels:sel,score:RB.rubricScore(r,sel,max).score,status:'',notes:old?.notes||'',updated_at:now});
  }
  setSaveState('saving','Guardando…');
  st.queue=st.queue.then(async()=>{
    for(const {sid} of entries){
      const rec=st.recs.get(+sid),old=await MiAulaDB.firstByIndex('grades','unique_key',[a.id,+sid]);
      if(old){await MiAulaDB.put('grades',{...old,...rec,id:old.id});st.recs.set(+sid,{...old,...rec,id:old.id});}
      else{const id=await MiAulaDB.add('grades',{...rec});st.recs.set(+sid,{...rec,id});}
    }
    setSaveState('saved','Todo guardado');
  }).catch(e=>{console.error(e);setSaveState('error','No se pudo guardar');toast('No se pudo guardar la evaluación: '+e.message,true);});
  return st.queue;
}
function rbIsComplete(){
  const st=rubricEvalState;if(!st)return false;
  const ids=rbTargets();if(!ids.length)return false;
  return ids.every(id=>rbStudentStatus(id).complete);
}
function rbMove(delta){
  const st=rubricEvalState;
  if(st.mode==='team'){const n=st.teamIndex+delta;if(n<0)return;if(n>=st.teams.length){closeRubricEvaluator();return;}st.teamIndex=n;}
  else{const n=st.index+delta;if(n<0)return;if(n>=st.students.length){closeRubricEvaluator();return;}st.index=n;}
  renderRubricEval();$('#rubricEval .rb-main')?.scrollTo({top:0});
  setTimeout(()=>$('#rubricEval .rb-level')?.focus({preventScroll:true}),30);
}
async function closeRubricEvaluator(){
  const st=rubricEvalState;if(!st)return;
  await st.queue;
  $('#rubricEval').classList.add('hidden');document.body.classList.toggle('sheet-open',!$('#rubricEditor').classList.contains('hidden'));
  rubricEvalState=null;
  await refreshAfterGradeChange();
}
$('#rubricEval')?.addEventListener('click',async e=>{
  const st=rubricEvalState;if(!st)return;
  const b=e.target.closest('button');if(!b||b.disabled)return;
  if(b.dataset.crit!=null){
    const cid=b.dataset.crit,j=+b.dataset.level,ids=rbTargets();if(!ids.length)return;
    const wasComplete=rbIsComplete();
    const sels=ids.map(rbSelection);
    const next=st.mode==='team'?RB.applyTeamTap(sels,cid,j):sels.map(s=>{const n={...s};if(n[cid]===j)delete n[cid];else n[cid]=j;return n;});
    rbSave(ids.map((sid,i)=>({sid,sel:next[i]})));
    try{navigator.vibrate?.(8);}catch{}
    renderRubricEval();
    if(!wasComplete&&rbIsComplete())$('#rbNext')?.focus();
    else document.querySelector(`#rubricEval .rb-level[data-crit="${CSS.escape(cid)}"][data-level="${j}"]`)?.focus({preventScroll:true});
    return;
  }
  if(b.dataset.rbStudent!=null){st.index=+b.dataset.rbStudent;renderRubricEval();return;}
  if(b.dataset.rbTeam!=null){st.teamIndex=+b.dataset.rbTeam;renderRubricEval();return;}
  const act=b.dataset.rb;
  if(act==='next')rbMove(1);
  else if(act==='prev')rbMove(-1);
  else if(act==='close')closeRubricEvaluator();
  else if(act==='all-best'||act==='clear'){
    const ids=rbTargets();if(!ids.length)return;
    const before=ids.map(sid=>({sid,sel:rbSelection(sid)}));
    const sel=act==='clear'?{}:Object.fromEntries(st.rubric.criteria.map(c=>[c.id,0]));
    rbSave(ids.map(sid=>({sid,sel:{...sel}})));renderRubricEval();
    const who=st.mode==='team'?`al equipo (${ids.length} alumnos)`:'al alumno';
    showActionUndo(act==='clear'?`Se borró la evaluación ${st.mode==='team'?'del equipo':'del alumno'}.`:`Se puso todo en «${st.rubric.levels[0].n}» ${who}.`,async()=>{
      if(!rubricEvalState)return;await rbSave(before);renderRubricEval();
    });
    if(act==='all-best')$('#rbNext')?.focus();
  }
  else if(act==='edit'){await st.queue;await openActivityRubricEditor(st.activity.id);}
  else if(act==='print')printRubricSheet(st.rubric,{title:st.activity.title,maxScore:st.activity.max_score,group:st.group});
  else if(act==='mode-team'&&st.teams.length){
    const sid=+st.students[st.index].id,ti=st.teams.findIndex(t=>(t.member_ids||[]).map(Number).includes(sid));
    st.mode='team';st.teamIndex=ti>=0?ti:0;renderRubricEval();
  }
  else if(act==='mode-student'){
    const first=rbTargets()[0],i=st.students.findIndex(s=>+s.id===+first);
    st.mode='student';st.index=i>=0?i:0;renderRubricEval();
  }
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  if(!$('#rubricEditor')?.classList.contains('hidden')){closeRubricEditor();return;}
  if(!$('#rubricEval')?.classList.contains('hidden'))closeRubricEvaluator();
});

// ---------- Calificar por equipos (actividades con número) ----------
function noTeamsHTML(){
  return `<div class="tg-empty"><p><b>Este grupo todavía no tiene equipos guardados.</b></p><ol><li>Abre <b>Ruleta y equipos → Formar equipos</b>.</li><li>Toca <b>Crear equipos</b> (a mano) o <b>Crear automáticamente</b> (al azar, indicando cuántos por equipo).</li><li>Los equipos se guardan solos. Regresa aquí y vuelve a tocar «Calificar por equipos».</li></ol><div class="modal-actions"><button class="btn subtle" onclick="closeModal()">Cerrar</button><button class="btn primary" onclick="closeModal();openDynamicsMode('teams')">Ir a formar equipos</button></div></div>`;
}
window.openTeamGrading=async function(aid){
  await flushNotebookAutoSave();
  const activity=await MiAulaDB.get('activities',+aid);if(!activity)return;
  const gid=+activity.group_id,{record,teams}=await readSavedTeams(gid),usable=teams.filter(isUsableTeam);
  if(!usable.length){openModal(isRubricActivity(activity)?'Evaluar por equipos':'Calificar por equipos',noTeamsHTML());return;}
  if(isRubricActivity(activity)){await openRubricEvaluator(aid,{mode:'team'});return;}
  const all=await MiAulaDB.groupStudents(gid,{includeInactive:true}),sm=new Map(all.map(s=>[+s.id,s]));
  const grades=await MiAulaDB.byIndex('grades','activity_id',activity.id),gm=new Map(grades.map(x=>[+x.student_id,x]));
  const eligible=s=>s&&s.active!==0&&!isSecretaryPendingStudent(s);
  const hasGrade=g=>!!g&&(g.score!=null||String(g.status||'').toUpperCase()==='NP');
  const inTeam=new Set(usable.flatMap(t=>t.member_ids.map(Number)));
  const teamless=all.filter(s=>eligible(s)&&!inTeam.has(+s.id)).sort(listOrder);
  const max=+activity.max_score||10,quick=[10,9,8,7,6].filter(v=>v<=max);
  const date=record?.updated_at?new Date(record.updated_at).toLocaleDateString('es-MX'):'';
  const rows=usable.map((t,i)=>{
    const ids=t.member_ids.map(Number),elig=ids.filter(id=>eligible(sm.get(id))),graded=elig.filter(id=>hasGrade(gm.get(id))).length;
    const chips=ids.map(id=>{const s=sm.get(id);if(!s)return '';const ok=eligible(s);return `<span class="tg-chip ${ok?'':'off'}">${s.list_number??'—'}. ${escapeHtml(studentLabel(s))}${ok?'':` · ${s.active===0?'baja':'Secretaría'}`}</span>`;}).join('');
    return `<div class="tg-row"><div class="tg-team"><strong>${escapeHtml(t.name)}</strong><small>${graded} de ${elig.length} ya tienen calificación</small><div class="tg-members">${chips}</div></div><div class="tg-input"><input type="text" inputmode="decimal" autocomplete="off" data-tg="${i}" placeholder="0 a ${fmtShort(max)} o NP" aria-label="Calificación de ${escapeHtml(t.name)}"><div class="tg-quick">${quick.map(v=>`<button type="button" data-tgq="${i}" data-v="${v}">${v}</button>`).join('')}<button type="button" data-tgq="${i}" data-v="NP" class="np">NP</button></div></div></div>`;
  }).join('');
  openModal('Calificar por equipos',`<p class="modal-help"><b>${escapeHtml(activity.title)}</b> · calificación de 0 a ${fmtShort(max)} o NP. Escribe la nota de cada equipo y toca «Aplicar». Después puedes cambiar a un alumno en particular en el cuaderno.</p>
    <div class="tg-options"><label>Organización de equipos<select id="tgOrg"><option>Equipos guardados del grupo${date?` (${date})`:''} · ${usable.length} equipos</option></select></label>
    <label class="tg-replace"><input type="checkbox" id="tgReplace"> Reemplazar las notas que ya tienen</label></div>
    <div class="tg-list">${rows}</div>
    ${teamless.length?`<p class="tg-teamless"><b>Sin equipo (se califican aparte):</b> ${teamless.map(s=>`${s.list_number??'—'}. ${escapeHtml(studentLabel(s))}`).join(' · ')}</p>`:''}
    <div class="rbe-errors" id="tgErrors" role="alert"></div>
    <div class="modal-actions"><button class="btn subtle" onclick="closeModal()">Cancelar</button><button class="btn primary" id="tgApply">Aplicar a los equipos</button></div>`);
  $('#modal .modal-card')?.classList.add('wide');
  $('#modalBody').onclick=e=>{const b=e.target.closest('[data-tgq]');if(!b)return;const inp=document.querySelector(`#modalBody input[data-tg="${b.dataset.tgq}"]`);if(inp){inp.value=b.dataset.v;inp.dispatchEvent(new Event('input'));}};
  $('#tgApply').onclick=async()=>{
    const values={};$$('#modalBody input[data-tg]').forEach(x=>{values[x.dataset.tg]=x.value;});
    const replace=$('#tgReplace').checked;
    const studentsMap=new Map(all.map(s=>[+s.id,{active:s.active,secretary_pending:isSecretaryPendingStudent(s)}]));
    const plan=RB.planTeamGrades({teams:usable,students:studentsMap,existing:gm,values,replace,parse:raw=>notebookParseScore(raw,max)});
    const err=$('#tgErrors');
    if(plan.errors.length){err.innerHTML=`<b>Revisa:</b> ${plan.errors.map(escapeHtml).join(' ')} La calificación debe ir de 0 a ${fmtShort(max)} o NP.`;return;}
    if(!plan.filledTeams){err.textContent='No escribiste la calificación de ningún equipo.';return;}
    if(!plan.changes.length){err.textContent=`No se cambió nada: ${plan.kept} alumno${plan.kept===1?' ya tenía':'s ya tenían'} calificación. Marca «Reemplazar las notas que ya tienen» si quieres cambiarlas.`;return;}
    $('#tgApply').disabled=true;
    const undo=[];
    for(const c of plan.changes){
      const old=await MiAulaDB.firstByIndex('grades','unique_key',[activity.id,c.student_id]);
      const rec={...(old||{}),activity_id:activity.id,student_id:c.student_id,score:c.score,status:c.status,notes:old?.notes||'',updated_at:new Date().toISOString()};
      if(old){await MiAulaDB.put('grades',rec);undo.push({old});}
      else{const id=await MiAulaDB.add('grades',rec);undo.push({newId:id});}
    }
    closeModal();await refreshAfterGradeChange();
    showActionUndo(`Calificación aplicada a ${plan.changes.length} alumno${plan.changes.length===1?'':'s'}${plan.kept?` · se ${plan.kept===1?'respetó 1 nota que ya existía':`respetaron ${plan.kept} notas que ya existían`}`:''}.`,async()=>{
      for(const u of undo){if(u.old)await MiAulaDB.put('grades',u.old);else if(u.newId!=null)await MiAulaDB.remove('grades',u.newId);}
      await refreshAfterGradeChange();
    });
  };
};

// ==========================================================================
// 2.9.0 · Banco de rúbricas en Proyecto
// Elegir una ya hecha, modificar, crear o subir. Las evaluaciones nuevas guardan
// una COPIA de la rúbrica y su nota (0–10); las del formato anterior no cambian.
// ==========================================================================
let projectEvalSelection={},projectEvalRef='';
function isLegacyRef(ref){return String(ref||'').startsWith('legacy:');}
async function projectRubricFromRef(ref){
  if(!ref||isLegacyRef(ref))return null;
  const t=await rubricTemplateFromRef(ref),n=RB.normalizeRubric(t);
  return n.ok?n.rubric:null;
}
async function populateEvalInstrumentSelect(){
  const sel=$('#evalInstrument');if(!sel)return;
  let prev=sel.value;if(!prev){try{prev=localStorage.getItem('miaula:projectRubric')||'';}catch{}}
  const mine=await loadRubricTemplates();
  const opt=(v,t)=>`<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
  sel.innerHTML='<option value="">Elige una rúbrica…</option>'
    +(mine.length?`<optgroup label="Mis rúbricas">${mine.map(m=>opt('mine:'+m.id,`${m.name} (${m.kind==='cotejo'?'lista de cotejo':'rúbrica'})`)).join('')}</optgroup>`:'')
    +`<optgroup label="Banco de MiAula">${RB.BANK.map(b=>opt('bank:'+b.id,`${b.name} (${b.kind==='cotejo'?'lista de cotejo':'rúbrica'})`)).join('')}</optgroup>`
    +(instruments.length?`<optgroup label="Formato anterior">${instruments.map(i=>opt('legacy:'+i.id,`${i.name} (formato anterior)`)).join('')}</optgroup>`:'');
  if([...sel.options].some(o=>o.value===prev))sel.value=prev;else sel.value='';
  if(sel.value!==evalCriteriaRenderedRef)renderEvalCriteria();
  refreshProjectBank();
}
async function refreshProjectBank(){
  const list=$('#projectMyRubrics');if(!list)return;
  const mine=await loadRubricTemplates(),cur=$('#evalInstrument')?.value||'';
  if($('#projectBankCount'))$('#projectBankCount').textContent=mine.length?`${mine.length} guardada${mine.length===1?'':'s'}`:'';
  list.innerHTML=mine.length?mine.map(m=>{const n=RB.normalizeRubric(m),ok=n.ok;return `<div class="bank-mini ${cur==='mine:'+m.id?'current':''}"><span><b>${escapeHtml(m.name||'Sin nombre')}</b><small>${ok?escapeHtml(rubricSummary(n.rubric)):'Dañada'}</small></span><button type="button" class="btn small primary" ${ok?'':'disabled'} onclick="selectProjectRubric('mine:${m.id}')">Usar</button><button type="button" class="btn small subtle" onclick="editRubricTemplate(${m.id})">Modificar</button></div>`;}).join(''):'<div class="bank-empty">Aún no tienes rúbricas propias. Usa <b>Elegir una ya hecha</b> o <b>Crear una nueva</b>.</div>';
  refreshProjectBankSelected();
}
async function refreshProjectBankSelected(){
  const box=$('#projectBankSelected');if(!box)return;
  const ref=$('#evalInstrument')?.value||'';
  if(!ref){box.innerHTML='<div class="bank-selected-empty">Aún no eliges con qué evaluar. Toca <b>Elegir una ya hecha</b>.</div>';return;}
  if(isLegacyRef(ref)){const i=instruments.find(x=>x.id===+ref.slice(7));box.innerHTML=`<div class="bank-selected-card"><span class="rubric-kind">Formato anterior</span><b>${escapeHtml(i?.name||'')}</b><small>${i?i.criteria.length:0} criterios</small></div>`;return;}
  const r=await projectRubricFromRef(ref);
  if(!r){box.innerHTML='<div class="bank-selected-empty">La rúbrica elegida está dañada. Elige otra.</div>';return;}
  const mine=ref.startsWith('mine:');
  box.innerHTML=`<div class="bank-selected-card"><span class="rubric-kind ${r.kind}">${mine?'Mi rúbrica':'Banco de MiAula'} · ${r.kind==='cotejo'?'Lista de cotejo':'Rúbrica'}</span><b>${escapeHtml(r.name)}</b><small>${escapeHtml(rubricSummary(r))}</small><div class="bank-selected-actions"><button type="button" class="btn small subtle" onclick="viewRubricRef('${escapeHtml(ref)}')">Ver</button><button type="button" class="btn small subtle" onclick="${mine?`editRubricTemplate(${+ref.slice(5)})`:`copyBankRubric('${escapeHtml(ref.slice(5))}')`}">${mine?'Modificar':'Hacer una copia y modificar'}</button><button type="button" class="btn small subtle" onclick="printRubricRef('${escapeHtml(ref)}')">Imprimir</button></div></div>`;
}
window.selectProjectRubric=async ref=>{
  closeModal();
  const sel=$('#evalInstrument');if(!sel)return;
  if(![...sel.options].some(o=>o.value===ref))await populateEvalInstrumentSelect();
  sel.value=ref;try{localStorage.setItem('miaula:projectRubric',ref);}catch{}
  renderEvalCriteria();refreshProjectBank();
  $('#projectWorkspace')?.scrollIntoView({behavior:'smooth',block:'start'});
  toast('Rúbrica lista. Escribe el nombre del proyecto y marca a los alumnos.');
};
function openProjectBankPicker(mode){
  const pick=mode==='pick';
  loadRubricTemplates().then(mine=>{
    const row=(ref,r,actions)=>`<div class="picker-row"><span><b>${escapeHtml(r.name)}</b><small>${escapeHtml(rubricSummary(r))} · ${r.criteria.slice(0,3).map(c=>escapeHtml(c.n)).join(' · ')}${r.criteria.length>3?' · …':''}</small></span><div class="picker-actions"><button type="button" class="btn small subtle" onclick="viewRubricRef('${escapeHtml(ref)}')">Ver</button>${actions}</div></div>`;
    const mineRows=mine.map(m=>{const n=RB.normalizeRubric(m);if(!n.ok)return '';return row('mine:'+m.id,n.rubric,pick?`<button type="button" class="btn small primary" onclick="selectProjectRubric('mine:${m.id}')">Usar esta</button>`:`<button type="button" class="btn small primary" onclick="closeModal();editRubricTemplate(${m.id})">Modificar</button>`);}).join('');
    const bankRows=RB.BANK.map(b=>row('bank:'+b.id,b,pick?`<button type="button" class="btn small primary" onclick="selectProjectRubric('bank:${b.id}')">Usar esta</button>`:`<button type="button" class="btn small primary" onclick="closeModal();copyBankRubric('${b.id}')">Hacer una copia y modificar</button>`)).join('');
    const legacyRows=instruments.map(i=>`<div class="picker-row"><span><b>${escapeHtml(i.name)}</b><small>Formato anterior · ${i.criteria.length} criterios</small></span><div class="picker-actions">${pick?`<button type="button" class="btn small primary" onclick="selectProjectRubric('legacy:${i.id}')">Usar esta</button>`:`<button type="button" class="btn small primary" onclick="closeModal();convertLegacyInstrument(${i.id})">Convertir y modificar</button>`}</div></div>`).join('');
    openModal(pick?'Elegir una rúbrica ya hecha':'Modificar una rúbrica',`<p class="modal-help">${pick?'Toca <b>Usar esta</b> para evaluar el proyecto con ella. Con <b>Ver</b> la revisas completa antes.':'Tus rúbricas se modifican directamente. Las del banco de MiAula se copian primero a «Mis rúbricas» para que puedas cambiarlas sin perder la original. Los proyectos ya evaluados no cambian.'}</p>
      <section class="picker-section"><h4>Mis rúbricas <small>${mine.length}</small></h4>${mineRows||'<p class="muted-text">Aún no tienes rúbricas propias.</p>'}</section>
      <section class="picker-section"><h4>Banco de MiAula <small>${RB.BANK.length}</small></h4>${bankRows}</section>
      ${instruments.length?`<section class="picker-section"><h4>Formato anterior <small>${instruments.length}</small></h4>${legacyRows}</section>`:''}`);
    $('#modal .modal-card')?.classList.add('wide');
  });
}
$('#bankPick')?.addEventListener('click',()=>openProjectBankPicker('pick'));
$('#bankModify')?.addEventListener('click',()=>openProjectBankPicker('modify'));
$('#bankCreate')?.addEventListener('click',()=>{
  openModal('Crear una nueva',`<p class="modal-help">¿Qué quieres crear?</p><div class="create-choice"><button type="button" class="bank-action" onclick="closeModal();newRubricTemplate('rubrica')"><span class="bank-action-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-eval"></use></svg></span><span><b>Rúbrica</b><small>Niveles (Destacado, Satisfactorio…) con descripción en cada criterio</small></span></button><button type="button" class="bank-action" onclick="closeModal();newRubricTemplate('cotejo')"><span class="bank-action-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-attendance"></use></svg></span><span><b>Lista de cotejo</b><small>Cada criterio se marca Sí o No</small></span></button></div>`);
});
$('#bankUpload')?.addEventListener('click',()=>openRubricImport());
document.addEventListener('miaula:rubric-saved',async e=>{
  if(currentView!=='evaluation')return;
  await populateEvalInstrumentSelect();
  if(e.detail?.id)await selectProjectRubric('mine:'+e.detail.id);
});

async function renderProjectRubricCriteria(ref){
  const box=$('#evalCriteria');if(!box)return;
  if(ref!==projectEvalRef){projectEvalSelection={};projectEvalRef=ref;}
  const r=await projectRubricFromRef(ref);
  if(!r){box.className='empty-state';box.textContent='Esta rúbrica está dañada. Elige otra.';return;}
  projectEvalSelection=RB.cleanSelection(r,projectEvalSelection);
  const res=RB.rubricScore(r,projectEvalSelection,10),cot=r.kind==='cotejo',pct=RB.weightPercents(r.criteria);
  box.className='project-rubric-eval';
  box.innerHTML=`<div class="pe-head"><div><b>${escapeHtml(r.name)}</b><small>Toca el nivel de cada criterio. Tocar el mismo lo quita.</small></div>${res.complete?`<div class="pe-score ${scoreTone(res.score)}"><small>Nota</small><b>${fmtNum(res.score)}</b></div>`:`<div class="pe-score pending"><small>Faltan</small><b>${res.total-res.done}</b></div>`}</div>
    <div class="pe-table-wrap"><table class="rb-table pe-table ${cot?'cotejo':''}"><thead><tr><th>Criterio</th>${r.levels.map(l=>`<th>${escapeHtml(l.n)}${cot?'':`<small>${fmtShort(l.p)} pts</small>`}</th>`).join('')}</tr></thead><tbody>
    ${r.criteria.map((c,i)=>`<tr><th scope="row"><b>${escapeHtml(c.n)}</b><small>${pct[i]}%</small></th>${r.levels.map((l,j)=>{const on=projectEvalSelection[c.id]===j,desc=cot?'':(c.d?.[j]||'');return `<td><button type="button" class="rb-level ${on?'on':''} ${cot&&j===1?'is-no':''}" data-pe-crit="${escapeHtml(c.id)}" data-pe-level="${j}" aria-pressed="${on}" aria-label="${escapeHtml(`${c.n}: ${l.n}${desc?'. '+desc:''}${on?'. Elegido':''}`)}"><b>${escapeHtml(l.n)}</b>${desc?`<span>${escapeHtml(desc)}</span>`:''}</button></td>`;}).join('')}</tr>`).join('')}
    </tbody></table></div>
    <div class="pe-actions"><button type="button" class="btn small subtle" data-pe="all-best">Todo en «${escapeHtml(r.levels[0].n)}»</button><button type="button" class="btn small subtle" data-pe="clear">Borrar selección</button></div>`;
}
$('#evalCriteria')?.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||!projectEvalRef||isLegacyRef($('#evalInstrument').value))return;
  if(b.dataset.peCrit!=null){
    const c=b.dataset.peCrit,j=+b.dataset.peLevel;
    if(projectEvalSelection[c]===j)delete projectEvalSelection[c];else projectEvalSelection[c]=j;
  }else if(b.dataset.pe==='clear')projectEvalSelection={};
  else if(b.dataset.pe==='all-best'){projectRubricFromRef(projectEvalRef).then(r=>{if(!r)return;projectEvalSelection=Object.fromEntries(r.criteria.map(c=>[c.id,0]));renderProjectRubricCriteria(projectEvalRef);});return;}
  else return;
  renderProjectRubricCriteria(projectEvalRef).then(()=>{
    if(b.dataset.peCrit!=null)document.querySelector(`#evalCriteria .rb-level[data-pe-crit="${CSS.escape(b.dataset.peCrit)}"][data-pe-level="${b.dataset.peLevel}"]`)?.focus({preventScroll:true});
  });
});
async function saveProjectRubricEvaluation(gid,p,scheme,ref){
  const title=$('#evalTitle').value.trim(),ids=$$('#evalStudents input:checked').map(x=>+x.value);
  if(!title||!ids.length){toast('Escribe el nombre del proyecto y marca al menos un alumno (o elige un equipo guardado).',true);return;}
  const template=await rubricTemplateFromRef(ref),snap=RB.snapshotForActivity(template,ref);
  if(!snap){toast('La rúbrica elegida está dañada. Elige otra.',true);return;}
  const res=RB.rubricScore(snap,projectEvalSelection,10);
  if(!res.complete){toast(`Marca el nivel de todos los criterios (faltan ${res.total-res.done}).`,true);return;}
  if(!scheme.mode_locked){scheme.principal_type='project';scheme.mode_locked=true;scheme.updated_at=new Date().toISOString();await MiAulaDB.put('gradingSchemes',scheme);}
  const now=new Date().toISOString(),team=$('#evalTeam').value.trim(),notes=$('#evalNotes').value.trim(),date=$('#evalDate').value;
  for(const sid of ids){
    await MiAulaDB.add('evaluations',{group_id:gid,instrument_id:null,instrument_ref:ref,rubric:snap,title,student_id:sid,team_name:team,raw_score:res.score,grade:res.score,details:{...projectEvalSelection},notes,evaluation_date:date,period:p,created_at:now});
  }
  toast(`Proyecto guardado · ${fmtNum(res.score)} para ${ids.length} alumno${ids.length===1?'':'s'}`);
  $$('#evalStudents input').forEach(x=>x.checked=false);
  $('#evalNotes').value='';if($('#evalSavedTeam'))$('#evalSavedTeam').value='';
  projectEvalSelection={};await renderProjectRubricCriteria(ref);
  await loadEvalHistory(gid,p);await loadSummary();
  if(+$('#gradingGroup').value===gid)await loadGrading();
}

// ==========================================================================
// 2.9.2 · Exportación «cierre de evaluación»: actividades vacías = 0
// Solo cambia el archivo exportado. En MiAula los vacíos siguen pendientes.
// ==========================================================================
// Vacía = sin calificación, sin NP y (en rúbrica) sin ningún criterio marcado.
function isEmptyGrade(a,rec){
  if(!rec)return true;
  if(rec.score!=null)return false;
  if(String(rec.status||'').toUpperCase()==='NP')return false;
  if(a&&isRubricActivity(a)&&rec.rubric_levels&&Object.keys(rec.rubric_levels).length)return false;
  return true;
}
function closingNotesSheet(g,stats){
  return {name:'Cierre',rows:[
    ['Exportación para cierre de evaluación'],
    ['Grupo',`${g?.name||''} · ${g?.discipline||''}`],
    ['Fecha',new Date().toLocaleString('es-MX')],
    ['Actividades sin calificación exportadas como 0',stats?.zeros??''],
    ['Regla','Las actividades sin calificación cuentan como 0 en el promedio de trabajos y en la final de este archivo.'],
    ['NP','Se exporta como «NP» y no cuenta en el promedio (igual que en MiAula).'],
    ['Rúbricas a medias','Se exportan como «N de M criterios» y no cuentan en el promedio.'],
    ['Pendiente Secretaría','Sus actividades vacías no se convierten en 0.'],
    ['Importante','En MiAula no se cambió ninguna calificación: los vacíos siguen como pendientes.']
  ]};
}
function askExportMode(title){
  return new Promise(resolve=>{
    let done=false;const finish=v=>{if(done)return;done=true;resolve(v);};
    openModal(title,`<p class="modal-help">¿Cómo quieres exportar?</p>
      <div class="create-choice export-choice">
        <button type="button" class="bank-action" id="exportAsIs"><span class="bank-action-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-excel"></use></svg></span><span><b>Como está</b><small>Las actividades sin calificación quedan en blanco</small></span></button>
        <button type="button" class="bank-action closing" id="exportClosing"><span class="bank-action-icon"><svg class="ui-icon" aria-hidden="true"><use href="#i-alert"></use></svg></span><span><b>Para cierre de evaluación</b><small>Las actividades sin calificación salen en <b>0</b> y cuentan en el promedio y la final. NP y rúbricas a medias se quedan igual.</small></span></button>
      </div>
      <p class="muted-text export-choice-note">En ambos casos tus calificaciones en MiAula no cambian.</p>`);
    $('#exportAsIs').onclick=()=>{closeModal();finish('asis');};
    $('#exportClosing').onclick=()=>{closeModal();finish('closing');};
    const obs=new MutationObserver(()=>{if($('#modal').classList.contains('hidden')){obs.disconnect();finish(null);}});
    obs.observe($('#modal'),{attributes:true,attributeFilter:['class']});
  });
}

// ==========================================================================
// 2.10.0 · Lista de asistencia tradicional en Excel (+ calificación al final)
// Marcas: «.» asistencia · «/» falta · «J» justificada · «R» retardo · «S» Pendiente Secretaría
// ==========================================================================
const MONTHS_ES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const WEEKDAY_LETTER=['D','L','M','M','J','V','S'];
function xlsCol(n){let s='';n++;while(n){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s;}
function longDateEs(iso){const d=parseISODateLocal(iso);return `${d.getDate()} de ${MONTHS_ES[d.getMonth()]} de ${d.getFullYear()}`;}
const ATT_MARK={P:'.',F:'/',J:'J',R:'R',S:'S'};
async function buildAttendanceListWorkbook(gid,opts={}){
  const g=await getGroupState(gid);if(!g)throw new Error('Grupo no encontrado');
  const unit=opts.unit==='sessions'?'sessions':'hours',closing=!!opts.closing;
  const students=(await MiAulaDB.groupStudents(gid,{includeInactive:false})).sort((a,b)=>(a.list_number??9999)-(b.list_number??9999));
  const records=(await MiAulaDB.byIndex('attendance','group_id',gid)).filter(r=>(!opts.from||r.attendance_date>=opts.from)&&(!opts.to||r.attendance_date<=opts.to));
  const dates=[...new Set(records.map(r=>r.attendance_date))].sort();
  const recMap=new Map(records.map(r=>[`${r.student_id}|${r.attendance_date}`,r]));
  const periods=periodNumbers(g),finals={};
  for(const p of periods){const res=await computeGroupGrading(gid,p,closing?{emptyAsZero:true}:{});finals[p]=new Map(res.students.map(r=>[r.id,r.final_grade]));}
  const D=dates.length,c0=2,cT=c0+D;
  const totalsHead=['ASISTENCIAS','RETARDOS','FALTAS JUSTIFICADAS','FALTAS INJUSTIFICADAS','% ASISTENCIA','% FALTAS'];
  const gradeHead=[...periods.map(p=>`CALIFICACIÓN PARCIAL ${p}`),'PROMEDIO'];
  const lastCol=cT+totalsHead.length+gradeHead.length-1;
  const cell=(v,s)=>({v,s}),blankRow=()=>Array.from({length:lastCol+1},()=>'');
  const rows=[];
  const r0=blankRow();r0[0]=cell('LISTA DE ASISTENCIA','title');rows.push(r0);
  const range=D?`del ${longDateEs(dates[0])} al ${longDateEs(dates[D-1])}`:'sin registros';
  const r1=blankRow();r1[0]=cell(`Grupo: ${g.name}${g.discipline?` · Asignatura: ${g.discipline}`:''}${g.school_year?` · Ciclo ${g.school_year}`:''} · Docente: Ing. Niccolás C.M. · Periodo ${range}`,'sub');rows.push(r1);
  const h1=blankRow(),h2=blankRow(),h3=blankRow();
  h1[0]=cell('No.','h');h1[1]=cell('NOMBRE DEL ALUMNO','h');
  [h2,h3].forEach(r=>{r[0]=cell('','h');r[1]=cell('','h');});
  if(D){h1[c0]=cell('A  S  I  S  T  E  N  C  I  A  S','h');for(let i=1;i<D;i++)h1[c0+i]=cell('','h');}
  dates.forEach((d,i)=>{h2[c0+i]=cell(WEEKDAY_LETTER[parseISODateLocal(d).getDay()],'h');h3[c0+i]=cell(longDateEs(d),'v');});
  [...totalsHead,...gradeHead].forEach((t,i)=>{h1[cT+i]=cell(t,'v');h2[cT+i]=cell('','v');h3[cT+i]=cell('','v');});
  rows.push(h1,h2,h3);
  const stats={students:students.length,dates:D};
  for(const s of students){
    const r=blankRow();let asis=0,ret=0,just=0,inj=0;
    r[0]=cell(s.list_number??'','c');r[1]=cell(studentLabel(s).toUpperCase(),'l');
    dates.forEach((d,i)=>{
      const a=recMap.get(`${s.id}|${d}`),st=String(a?.status||'').toUpperCase(),u=unit==='hours'?Math.max(1,+a?.class_hours||1):1;
      r[c0+i]=cell(ATT_MARK[st]||'',st==='F'?'f':st==='J'?'j':'c');
      if(st==='P')asis+=u;else if(st==='R'){asis+=u;ret+=u;}else if(st==='J')just+=u;else if(st==='F')inj+=u;
    });
    const total=asis+just+inj;
    const pctAs=total?Math.round((total-inj)*1000/total)/10:'';
    const pctF=total?Math.round(inj*1000/total)/10:'';
    [asis,ret,just,inj].forEach((v,i)=>r[cT+i]=cell(v,'c'));
    r[cT+4]=cell(pctAs,'p');r[cT+5]=cell(pctF,pctF!==''&&pctF>=20?'pf':'p');
    const fs=periods.map(p=>finals[p].get(s.id)??null);
    fs.forEach((v,i)=>r[cT+6+i]=cell(v==null?'Pend.':v,v==null?'c':'cb'));
    const all=fs.every(v=>v!=null);
    r[cT+6+periods.length]=cell(all?Math.round(fs.reduce((a,b)=>a+b,0)*100/fs.length)/100:'Pend.',all?'cb':'c');
    rows.push(r);
  }
  rows.push(blankRow());
  const legend=blankRow();legend[1]=cell('Marcas:  .  asistencia    /  falta    J  justificada    R  retardo    S  pendiente con Secretaría (no cuenta)','sub');rows.push(legend);
  const note=blankRow();note[1]=cell(`Totales en ${unit==='hours'?'horas de clase (igual que MiAula y la regla del 20%)':'sesiones (una marca por día)'}. % asistencia = (computables − faltas injustificadas) ÷ computables. % faltas en rojo cuando llega al 20%.`,'sub');rows.push(note);
  const note2=blankRow();note2[1]=cell(closing?'Calificación para cierre de evaluación: las actividades sin calificación cuentan como 0 (NP y rúbricas a medias sin cambio). «Pend.» = falta proyecto/examen, valores o actitudes. En MiAula no se modificó ninguna calificación.':'Calificación como está en MiAula. «Pend.» = al alumno le falta algún componente (trabajos, proyecto/examen, valores o actitudes) en ese parcial. El promedio aparece cuando todos los parciales tienen calificación.','sub');rows.push(note2);
  const sign=blankRow();sign[1]=cell('Firma del docente: ____________________________','sub');rows.push(blankRow(),sign);
  const merges=[`A1:${xlsCol(lastCol)}1`,`A2:${xlsCol(lastCol)}2`,'A3:A5','B3:B5'];
  if(D>1)merges.push(`${xlsCol(c0)}3:${xlsCol(cT-1)}3`);
  for(let i=0;i<totalsHead.length+gradeHead.length;i++)merges.push(`${xlsCol(cT+i)}3:${xlsCol(cT+i)}5`);
  const legendRow=rows.length-5;[legendRow,legendRow+1,legendRow+2,rows.length-1].forEach(r=>merges.push(`B${r+1}:${xlsCol(lastCol)}${r+1}`));
  const cols=[5,40,...dates.map(()=>3.6),...totalsHead.map(()=>6.5),...gradeHead.map(()=>9.5)];
  const sheet={name:'Lista de asistencia',rows,format:{cols,merges,heights:{0:26,1:30,4:128},freeze:{row:5,col:2},landscape:true}};
  return {workbook:{sheets:[sheet]},stats};
}
function openAttendanceListExport(gid){
  gid=+gid||attendanceHistoryGroupId()||+$('#contextGroup')?.value||0;
  if(!gid){toast('Selecciona un grupo.',true);return;}
  MiAulaDB.byIndex('attendance','group_id',gid).then(recs=>{
    const dates=[...new Set(recs.map(r=>r.attendance_date))].sort(),first=dates[0]||today,last=dates[dates.length-1]||today;
    openModal('Lista de asistencia (Excel)',`<p class="modal-help">Se genera como lista tradicional: una columna por fecha con <b>.</b> asistencia, <b>/</b> falta y <b>J</b> justificada; al final los totales, el % y la calificación de cada parcial.</p>
      <div class="al-form">
        <fieldset><legend>Fechas</legend>
          <label class="al-opt"><input type="radio" name="alRange" value="all" checked> Todas las fechas registradas (${dates.length})</label>
          <label class="al-opt"><input type="radio" name="alRange" value="range"> Solo un periodo</label>
          <div class="al-dates"><label>Desde<input type="date" id="alFrom" value="${first}"></label><label>Hasta<input type="date" id="alTo" value="${last}"></label></div>
        </fieldset>
        <fieldset><legend>Contar las asistencias por</legend>
          <label class="al-opt"><input type="radio" name="alUnit" value="hours" checked> Horas de clase <small>(igual que MiAula y la regla del 20%)</small></label>
          <label class="al-opt"><input type="radio" name="alUnit" value="sessions"> Sesiones <small>(una marca por día, como lista de papel)</small></label>
        </fieldset>
        <fieldset><legend>Calificación al final</legend>
          <label class="al-opt"><input type="radio" name="alGrade" value="asis" checked> Como está en MiAula</label>
          <label class="al-opt"><input type="radio" name="alGrade" value="closing"> Para cierre de evaluación <small>(actividades sin calificación = 0; NP y rúbricas a medias igual)</small></label>
        </fieldset>
      </div>
      <div class="modal-actions"><button class="btn subtle" onclick="closeModal()">Cancelar</button><button class="btn primary" id="alGenerate">Generar lista</button></div>`);
    $('#modal .modal-card')?.classList.add('wide');
    $('#alGenerate').onclick=async()=>{
      const range=document.querySelector('input[name="alRange"]:checked').value,unit=document.querySelector('input[name="alUnit"]:checked').value,closing=document.querySelector('input[name="alGrade"]:checked').value==='closing';
      const from=range==='range'?$('#alFrom').value:'',to=range==='range'?$('#alTo').value:'';
      if(from&&to&&from>to){toast('La fecha «Desde» debe ser antes de «Hasta».',true);return;}
      try{
        const {workbook,stats}=await buildAttendanceListWorkbook(gid,{from,to,unit,closing});
        if(!stats.dates){toast('No hay asistencias registradas en esas fechas.',true);return;}
        const g=await MiAulaDB.get('groups',gid),safe=String(g.name).replace(/[^A-Za-z0-9_-]+/g,'_');
        downloadBlob(XLSXLite.write(workbook),`MiAula_ListaAsistencia_${safe}${closing?'_CIERRE':''}_${today}.xlsx`);
        closeModal();toast(`Lista generada · ${stats.students} alumnos · ${stats.dates} fechas`);
      }catch(e){console.error(e);toast(e.message,true);}
    };
  });
}
$('#exportAttendanceList')?.addEventListener('click',()=>openAttendanceListExport(attendanceHistoryGroupId()));
$('#exportAttendanceListAdmin')?.addEventListener('click',()=>openAttendanceListExport(+$('#exportGroup')?.value||0));
