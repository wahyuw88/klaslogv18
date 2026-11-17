const test=require("node:test");
const assert=require("node:assert/strict");
const {validate}=require("../public/history-validator.js");
const current=[{cluster_id:"K-1",status_pembentukan:"Terbentuk"}];
const base={cluster_id:"K-1",baseline_status:"Dalam Proses",baseline_tanggal:"2026-01-01",baseline_sumber:"SK-001"};
const ev=(over={})=>({...base,tanggal_perubahan:"2026-01-02",status_sebelumnya:"Dalam Proses",status_baru:"Terbentuk",...over});
test("valid single event",()=>assert.equal(validate([ev()],current).valid.length,1));
test("reject whole chain if later event breaks continuity",()=>{
 const a=ev(),b=ev({tanggal_perubahan:"2026-01-03",status_sebelumnya:"Dalam Proses",status_baru:"Terbentuk"});
 const r=validate([a,b],current);assert.equal(r.valid.length,0);assert.equal(r.rejected.length,2);
});
test("duplicate current ID rejected even same status",()=>{
 const r=validate([ev()],[...current,...current]);assert.equal(r.valid.length,0);
});
test("partial same-day ordering rejected",()=>{
 const a=ev({waktu_perubahan:"09:00"}),b=ev({tanggal_perubahan:"2026-01-02",status_sebelumnya:"Terbentuk",status_baru:"Dalam Proses",urutan_event:"2"});
 const r=validate([a,b],current);assert.equal(r.valid.length,0);
});
test("conflicting time and sequence order rejected",()=>{
 const a=ev({waktu_perubahan:"09:00",urutan_event:"2"}),b=ev({tanggal_perubahan:"2026-01-02",status_sebelumnya:"Terbentuk",status_baru:"Dalam Proses",waktu_perubahan:"10:00",urutan_event:"1"});
 const r=validate([a,b],[{cluster_id:"K-1",status_pembentukan:"Dalam Proses"}]);assert.equal(r.valid.length,0);
});
test("inconsistent baseline rejected",()=>{
 const r=validate([ev(),ev({tanggal_perubahan:"2026-01-03",baseline_sumber:"SK-002"})],current);assert.equal(r.valid.length,0);
});
test("unknown and blank IDs rejected",()=>{
 const r=validate([ev({cluster_id:"X"}),ev({cluster_id:""})],current);assert.equal(r.valid.length,0);assert.equal(r.rejected.length,2);
});
test("invalid date quarantines whole chain",()=>{
 const r=validate([ev(),ev({tanggal_perubahan:"2026-02-30"})],current);assert.equal(r.valid.length,0);assert.equal(r.rejected.length,2);
});
