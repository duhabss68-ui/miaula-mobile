'use strict';

const MiAulaDB = (() => {
  const DB_NAME = 'MiAulaMobileDB';
  const DB_VERSION = 1;
  const stores = [
    'groups','students','attendance','activities','grades','instruments',
    'evaluations','gradingSchemes','studentComponents','meta'
  ];
  let _db = null;

  function open(){
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains('groups')){
          const s=db.createObjectStore('groups',{keyPath:'id',autoIncrement:true});
          s.createIndex('active','active',{unique:false});
        }
        if(!db.objectStoreNames.contains('students')){
          const s=db.createObjectStore('students',{keyPath:'id',autoIncrement:true});
          s.createIndex('group_id','group_id',{unique:false});
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
      req.onsuccess = () => { _db=req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(store, mode='readonly'){
    const db=await open();
    return db.transaction(store,mode).objectStore(store);
  }
  function request(req){ return new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);}); }
  async function all(store){ const s=await tx(store); return request(s.getAll()); }
  async function get(store,key){ const s=await tx(store); return request(s.get(key)); }
  async function add(store,obj){ const s=await tx(store,'readwrite'); return request(s.add(obj)); }
  async function put(store,obj){ const s=await tx(store,'readwrite'); return request(s.put(obj)); }
  async function remove(store,key){ const s=await tx(store,'readwrite'); return request(s.delete(key)); }
  async function clear(store){ const s=await tx(store,'readwrite'); return request(s.clear()); }
  async function byIndex(store,index,value){ const s=await tx(store); return request(s.index(index).getAll(IDBKeyRange.only(value))); }
  async function firstByIndex(store,index,value){ const s=await tx(store); return request(s.index(index).get(IDBKeyRange.only(value))); }

  async function nextStudentCode(){
    const rows=await all('students');
    let max=0;
    for(const r of rows){
      const m=String(r.student_code||'').match(/(\d+)$/); if(m) max=Math.max(max,+m[1]);
    }
    return 'ALU'+String(max+1).padStart(6,'0');
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
    const g=await get('groups',groupId); if(!g) return; g.active=0; await put('groups',g);
  }

  async function exportBackup(){
    const out={format:'MiAulaMobileBackup',schemaVersion:1,appVersion:'0.1',exportedAt:new Date().toISOString(),stores:{}};
    for(const s of stores){ out.stores[s]=await all(s); }
    return out;
  }

  async function restoreBackup(data){
    if(!data || data.format!=='MiAulaMobileBackup' || !data.stores) throw new Error('Este archivo no es un respaldo válido de MiAula Mobile.');
    const db=await open();
    for(const name of stores){
      const t=db.transaction(name,'readwrite'); const st=t.objectStore(name); st.clear();
      const rows=Array.isArray(data.stores[name])?data.stores[name]:[];
      for(const row of rows) st.put(row);
      await new Promise((res,rej)=>{t.oncomplete=res;t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||new Error('Operación cancelada'));});
    }
  }

  async function resetAll(){ for(const s of stores) await clear(s); }

  return {open,all,get,add,put,remove,clear,byIndex,firstByIndex,nextStudentCode,cascadeDeleteStudent,deleteActivity,archiveGroup,exportBackup,restoreBackup,resetAll,stores};
})();
