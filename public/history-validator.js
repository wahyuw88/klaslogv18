(function(root){
  "use strict";
  const ALLOWED = new Set(["terbentuk","dalam proses"]);
  const clean = v => String(v ?? "").trim();
  const norm = v => clean(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const status = v => norm(v).replace(/[._-]+/g," ").replace(/\s+/g," ").trim();
  function isoDate(s){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d=new Date(s+"T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10)===s;
  }
  function validate(events,currentRows){
    const currentCounts=new Map(), currentStatus=new Map();
    for(const row of currentRows||[]){
      const id=norm(row.cluster_id);
      if(!id) continue;
      currentCounts.set(id,(currentCounts.get(id)||0)+1);
      if(!currentStatus.has(id)) currentStatus.set(id,new Set());
      currentStatus.get(id).add(status(row.status_pembentukan));
    }
    const groups=new Map();
    (events||[]).forEach((r,index)=>{
      const id=norm(r.cluster_id)||"";
      if(!groups.has(id)) groups.set(id,[]);
      groups.get(id).push({r,index});
    });
    const valid=[], rejected=[], conflicts=[], incomplete=[];
    for(const [id,list] of groups){
      const reasons=new Set();
      if(!id) reasons.add("ID klaster kosong");
      if(id && !currentCounts.has(id)) reasons.add("ID tidak ditemukan pada DATA_KLASTER");
      if(id && (currentCounts.get(id)||0)>1) reasons.add("ID duplikat pada DATA_KLASTER");
      if(id && (currentStatus.get(id)?.size||0)>1) reasons.add("Status DATA_KLASTER berbeda untuk ID yang sama");
      const parsed=list.map(x=>({...x,date:clean(x.r.tanggal_perubahan),time:clean(x.r.waktu_perubahan),seq:clean(x.r.urutan_event)}));
      if(parsed.some(x=>!isoDate(x.date))) reasons.add("Tanggal tidak valid; seluruh rangkaian dikarantina");
      const dated=parsed.filter(x=>isoDate(x.date)).sort((a,b)=>a.date.localeCompare(b.date));
      const firstDate=dated[0]?.date||"";
      const baselineFields=["baseline_status","baseline_tanggal","baseline_sumber"];
      if(parsed.some(x=>baselineFields.some(k=>!clean(x.r[k])))) reasons.add("Baseline tidak lengkap");
      const baselineSigs=new Set(parsed.map(x=>baselineFields.map(k=>clean(x.r[k])).join("|")));
      if(baselineSigs.size>1) reasons.add("Baseline tidak konsisten antar-event");
      const b=parsed[0]?.r||{};
      const bs=status(b.baseline_status), bd=clean(b.baseline_tanggal);
      if(!ALLOWED.has(bs)) reasons.add("Status baseline tidak valid");
      if(!isoDate(bd)) reasons.add("Tanggal baseline tidak valid");
      if(isoDate(bd)&&firstDate&&bd>firstDate) reasons.add("Baseline lebih baru dari event pertama");
      if(dated.length && bs!==status(dated[0].r.status_sebelumnya)) reasons.add("Baseline tidak cocok dengan status sebelumnya pada event pertama");
      // Validate order independently for each date.
      const byDate=new Map();
      for(const x of parsed){if(!byDate.has(x.date))byDate.set(x.date,[]);byDate.get(x.date).push(x);}
      for(const [date,items] of byDate){
        if(items.length<2) continue;
        const allTime=items.every(x=>x.time), allSeq=items.every(x=>x.seq);
        const timeOk=allTime && items.every(x=>/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(x.time)) && new Set(items.map(x=>x.time)).size===items.length;
        const seqOk=allSeq && items.every(x=>/^[1-9]\d*$/.test(x.seq)) && new Set(items.map(x=>x.seq)).size===items.length;
        if(!timeOk&&!seqOk) reasons.add("Urutan event pada tanggal "+date+" ambigu atau tidak lengkap");
        if(timeOk&&seqOk){
          const byT=[...items].sort((a,b)=>a.time.localeCompare(b.time));
          const byS=[...items].sort((a,b)=>Number(a.seq)-Number(b.seq));
          if(byT.some((x,i)=>x.index!==byS[i].index)) reasons.add("Urutan waktu dan nomor event bertentangan pada "+date);
        }
      }
      // Sort deterministically only when ordering is explicit for same-day events.
      const ordered=[...parsed].sort((a,b)=>{
        if(a.date!==b.date)return a.date.localeCompare(b.date);
        if(a.time&&b.time)return a.time.localeCompare(b.time);
        if(a.seq&&b.seq)return Number(a.seq)-Number(b.seq);
        return a.index-b.index;
      });
      let previous=null;
      for(const x of ordered){
        const from=status(x.r.status_sebelumnya),to=status(x.r.status_baru);
        if(!ALLOWED.has(from)||!ALLOWED.has(to)||from===to) reasons.add("Status event tidak valid");
        if(previous!==null&&from!==previous) reasons.add("Rangkaian status terputus");
        previous=to;
      }
      const current=[...(currentStatus.get(id)||[])];
      if(id && current.length===1 && previous && current[0]!==previous) conflicts.push({cluster_id:id,reason:"Status akhir histori berbeda dengan DATA_KLASTER",history_status:previous,current_status:current[0]});
      if(reasons.size){
        const reason=[...reasons].join("; ");
        list.forEach(x=>rejected.push({...x.r,_reason:reason}));
        incomplete.push({cluster_id:id||"(kosong)",reason,event_count:list.length});
      }else{
        list.forEach(x=>valid.push(x.r));
      }
    }
    // A conflict at final reconciliation also invalidates the complete chain.
    const conflictIds=new Set(conflicts.map(x=>norm(x.cluster_id)));
    for(let i=valid.length-1;i>=0;i--){
      if(conflictIds.has(norm(valid[i].cluster_id))){
        const row=valid.splice(i,1)[0];
        rejected.push({...row,_reason:"Status akhir histori berbeda dengan DATA_KLASTER"});
      }
    }
    for(const c of conflicts) incomplete.push({cluster_id:c.cluster_id,reason:c.reason,event_count:(events||[]).filter(r=>norm(r.cluster_id)===norm(c.cluster_id)).length});
    return {valid,rejected,conflicts,incomplete,summary:{valid:valid.length,rejected:rejected.length,conflicts:conflicts.length,incomplete:incomplete.length}};
  }
  const api={validate};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  else root.HistoryValidator=api;
})(typeof globalThis!=="undefined"?globalThis:this);
