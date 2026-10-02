'use strict';

const MiAulaDB = (() => {
  const DB_NAME = 'MiAulaMobileDB';
  const DB_VERSION = 2;
  const stores = [
    'groups','students','attendance','activities','grades','instruments',
    'evaluations','gradingSchemes','studentComponents','meta'
  ];
  let _db = null;

  function request(req){
    return new Promise((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }

  function open(){
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=e=>{
        const db=e.target.result;
        const oldVersion=e.oldVersion||0;

        if(!db.objectStoreNames.contains('groups')){
          const s=db.createObjectStore('groups',{keyPath:'id',autoIncrement:true});
          s.createIndex('active','active',{unique:false});
        }
        if(!db.objectStoreNames.contains('students')){
          const s=db.createObjectStore('students',{keyPath:'id',autoIncrement:true});
          s.createIndex('group_id','group_id',{unique:false});
          s.createIndex('active','active',{unique:false});
        }else if(oldVersion<2){
          const s=req.transaction.objectStore('students');
          if(!s.indexNames.contains('active')) s.createIndex('active','active',{unique:false});
        }
        if(!db.objectStoreNames.contains('attendance')){
          const s=db.createObjectStore('attendance',{keyPath:'id',autoIncrement:true});
          s.createIndex('group_id','group_id',{unique:false});
          s.createIndex('student_id','student_id',{unique:false});
          s.createIndex('group_date',['group_id','attendance_date'],{unique:false});
          s.createIndex('unique_key',['group_id','student_id','attendance_date'],{unique:true});
        }
        if(!db.objectStoreNames.contains('activities')){
          const s=db.createObjectStore('activities',{keyPath:'id',autoIncrement:true});
          s.createIndex('group_id','group_id',{unique:false});
          s.createIndex('group_period',['group_id','period'],{unique:false});
        }
        if(!db.objectStoreNames.contains('grades')){
          const s=db.createObjectStore('grades',{keyPath:'id',autoIncrement:true});
          s.createIndex('activity_id','activity_id',{unique:false});
          s.createIndex('student_id','student_id',{unique:false});
          s.createIndex('unique_key',['activity_id','student_id'],{unique:true});
        }
        if(!db.objectStoreNames.contains('instruments')){
          db.createObjectStore('instruments',{keyPath:'id',autoIncrement:true});
        }
        if(!db.objectStoreNames.contains('evaluations')){
          const s=db.createObjectStore('evaluations',{keyPath:'id',autoIncrement:true});
          s.createIndex('group_id','group_id',{unique:false});
          s.createIndex('student_id','student_id',{unique:false});
          s.createIndex('group_period',['group_id','period'],{unique:false});
          s.createIndex('instrument_id','instrument_id',{unique:false});
        }
        if(!db.objectStoreNames.contains('gradingSchemes')){
          db.createObjectStore('gradingSchemes',{keyPath:'key'});
        }
        if(!db.objectStoreNames.contains('studentComponents')){
          const s=db.createObjectStore('studentComponents',{keyPath:'key'});
          s.createIndex('group_period',['group_id','period'],{unique:false});
          s.createIndex('student_id','student_id',{unique:false});
        }
        if(!db.objectStoreNames.contains('meta')){
          db.createObjectStore('meta',{keyPath:'key'});
        }
      };
      req.onsuccess=()=>{
        _db=req.result;
        _db.onversionchange=()=>{_db.close();_db=null;};
        resolve(_db);
      };
      req.onerror=()=>reject(req.error);
    });
  }

  async function tx(store,mode='readonly'){
    const db=await open();
    return db.transaction(store,mode).objectStore(store);
  }
  async function all(store){return request((await tx(store)).getAll());}
  async function get(store,key){return request((await tx(store)).get(key));}
  async function add(store,obj){return request((await tx(store,'readwrite')).add(obj));}
  async function put(store,obj){return request((await tx(store,'readwrite')).put(obj));}
  async function remove(store,key){return request((await tx(store,'readwrite')).delete(key));}
  async function clear(store){return request((await tx(store,'readwrite')).clear());}
  async function byIndex(store,index,value){return request((await tx(store)).index(index).getAll(IDBKeyRange.only(value)));}
  async function firstByIndex(store,index,value){return request((await tx(store)).index(index).get(IDBKeyRange.only(value)));}

  function cleanName(v){return String(v??'').trim().replace(/\s+/g,' ');}
  function sortKey(v){return cleanName(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es-MX');}
  function displayName(student){
    const parts=[student.paternal_last_name,student.maternal_last_name,student.given_names].map(cleanName).filter(Boolean);
    return parts.length?parts.join(' '):cleanName(student.name);
  }
  function compareStudents(a,b){
    const ka=[a.paternal_last_name||a.name||'',a.maternal_last_name||'',a.given_names||a.name||''].map(sortKey);
    const kb=[b.paternal_last_name||b.name||'',b.maternal_last_name||'',b.given_names||b.name||''].map(sortKey);
    for(let i=0;i<ka.length;i++){
      const c=ka[i].localeCompare(kb[i],'es',{sensitivity:'base',numeric:true});
      if(c) return c;
    }
    return (a.id||0)-(b.id||0);
  }

  async function normalizeRecords(){
    const groups=await all('groups');
    for(const g of groups){
      let changed=false;
      if(g.active===undefined){g.active=1;changed=true;}
      if(!Number.isFinite(+g.current_period)||+g.current_period<1){g.current_period=1;changed=true;}
      if(!Array.isArray(g.closed_periods)){g.closed_periods=[];changed=true;}
      const highestUsed=Math.max(1,+g.current_period||1,...(g.closed_periods||[]).map(x=>+x||0));
      if(!Number.isFinite(+g.total_periods)||+g.total_periods<1){g.total_periods=Math.max(3,highestUsed);changed=true;}
      if(+g.total_periods<highestUsed){g.total_periods=highestUsed;changed=true;}
      if(g.course_closed===undefined){g.course_closed=false;changed=true;}
      if(changed) await put('groups',g);
    }
    const students=await all('students');
    for(const s of students){
      let changed=false;
      if(s.active===undefined){s.active=1;changed=true;}
      if(s.paternal_last_name===undefined){s.paternal_last_name='';changed=true;}
      if(s.maternal_last_name===undefined){s.maternal_last_name='';changed=true;}
      if(s.given_names===undefined){s.given_names='';changed=true;}
      const n=displayName(s);
      if(n && s.name!==n && (s.paternal_last_name||s.maternal_last_name||s.given_names)){s.name=n;changed=true;}
      if(changed) await put('students',s);
    }
    const attendance=await all('attendance');
    for(const a of attendance){
      if(!Number.isFinite(+a.class_hours)||+a.class_hours<1){a.class_hours=1;await put('attendance',a);}
    }
  }

  async function nextStudentCode(){
    const rows=await all('students');
    let max=0;
    for(const r of rows){
      const m=String(r.student_code||'').match(/(\d+)$/);
      if(m) max=Math.max(max,+m[1]);
    }
    return 'ALU'+String(max+1).padStart(6,'0');
  }

  async function groupStudents(groupId,{includeInactive=true}={}){
    const rows=await byIndex('students','group_id',+groupId);
    return rows.filter(s=>includeInactive||s.active!==0).sort(compareStudents);
  }

  async function reorganizeGroup(groupId,{forceAlphabetical=false}={}){
    const rows=await groupStudents(groupId,{includeInactive:true});
    const active=rows.filter(s=>s.active!==0);
    const canAlphabetize=active.every(s=>cleanName(s.paternal_last_name));
    if(forceAlphabetical || canAlphabetize){
      active.sort(compareStudents);
    }else{
      // En registros heredados sin apellidos separados se conserva el orden previo.
      active.sort((a,b)=>(a.list_number??9999)-(b.list_number??9999)||compareStudents(a,b));
    }
    let n=1;
    for(const s of active){
      if(s.list_number!==n || s.name!==displayName(s)){
        s.list_number=n;
        s.name=displayName(s);
        await put('students',s);
      }
      n++;
    }
    return active;
  }

  async function deactivateStudent(studentId){
    const s=await get('students',studentId);
    if(!s) return;
    s.active=0;
    s.withdrawn_at=new Date().toISOString();
    s.former_list_number=s.list_number??null;
    await put('students',s);
    await reorganizeGroup(s.group_id);
  }

  async function reactivateStudent(studentId){
    const s=await get('students',studentId);
    if(!s) return;
    s.active=1;
    s.reactivated_at=new Date().toISOString();
    await put('students',s);
    await reorganizeGroup(s.group_id);
  }

  async function cascadeDeleteStudent(studentId){
    const student=await get('students',studentId); if(!student) return;
    const attendance=await byIndex('attendance','student_id',studentId); for(const r of attendance) await remove('attendance',r.id);
    const grades=await byIndex('grades','student_id',studentId); for(const r of grades) await remove('grades',r.id);
    const evals=await byIndex('evaluations','student_id',studentId); for(const r of evals) await remove('evaluations',r.id);
    const comps=await byIndex('studentComponents','student_id',studentId); for(const r of comps) await remove('studentComponents',r.key);
    await remove('students',studentId);
  }

  async function deleteActivity(activityId){
    const grades=await byIndex('grades','activity_id',activityId); for(const r of grades) await remove('grades',r.id);
    await remove('activities',activityId);
  }

  async function archiveGroup(groupId){
    const g=await get('groups',groupId); if(!g) return;
    g.active=0;
    g.archived_at=new Date().toISOString();
    await put('groups',g);
  }

  async function exportBackup(){
    const out={format:'MiAulaMobileBackup',schemaVersion:3,appVersion:'2.0-CETIS',exportedAt:new Date().toISOString(),stores:{}};
    for(const s of stores) out.stores[s]=await all(s);
    return out;
  }

  async function restoreBackup(data){
    if(!data || data.format!=='MiAulaMobileBackup' || !data.stores) throw new Error('Este archivo no es un respaldo válido de MiAula.');
    const db=await open();
    for(const name of stores){
      const t=db.transaction(name,'readwrite');
      const st=t.objectStore(name);
      st.clear();
      const rows=Array.isArray(data.stores[name])?data.stores[name]:[];
      for(const row of rows) st.put(row);
      await new Promise((resolve,reject)=>{
        t.oncomplete=resolve;
        t.onerror=()=>reject(t.error);
        t.onabort=()=>reject(t.error||new Error('Operación cancelada'));
      });
    }
    await normalizeRecords();
    const groups=await all('groups');
    for(const g of groups) if(g.active!==0) await reorganizeGroup(g.id);
  }

  async function resetAll(){for(const s of stores) await clear(s);}

  return {
    open,all,get,add,put,remove,clear,byIndex,firstByIndex,nextStudentCode,
    cascadeDeleteStudent,deleteActivity,archiveGroup,exportBackup,restoreBackup,
    resetAll,stores,normalizeRecords,groupStudents,reorganizeGroup,deactivateStudent,
    reactivateStudent,displayName,compareStudents
  };
})();
