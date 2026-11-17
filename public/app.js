/*
 * Hubungkan spreadsheet: ganti SHEET_CSV_URL dengan URL CSV dari
 * Google Sheets > File > Share > Publish to web > DATA_KLASTER > CSV.
 */
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRkXRhEJYgrlu_tKjg5BQ3R_C_ghkU2sdb9T-4ndRBvqo2tDJHtCOUOjHm7WHv9lA/pub?gid=130288309&single=true&output=csv";
// Isi dengan URL CSV publik sheet HISTORI_STATUS untuk mengaktifkan tren perubahan status.
const HISTORY_CSV_URL = "";
const GEOJSON_URLS = [
  // File ringan dan sesuai untuk peta tingkat provinsi.
  "https://raw.githubusercontent.com/superpikar/indonesia-geojson/master/indonesia-province-simple.json",
  // GeoJSON dengan kode provinsi.
  "https://raw.githubusercontent.com/ans-4175/peta-indonesia-geojson/master/indonesia-prov.geojson",
  // Sumber lengkap sebagai fallback terakhir.
  "https://raw.githubusercontent.com/superpikar/indonesia-geojson/master/indonesia-province.json"
];

let dataLoadInProgress = false;
let searchDebounceHandle = null;
let diagnosticsCache = null;
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, {...options, signal: controller.signal}); }
  finally { clearTimeout(timer); }
}

const $ = (id) => document.getElementById(id);
let clusters = [];
let activeKorwil = "";
let currentPage = 1;
let pageSize = 10;
let sortKey = "tahun";
let sortDirection = "desc";
let filteredRowsCache = [];
let dataLoadSucceeded = false;
let lastDataCheckedAt = null;
let provinceLayer = null;
let map = null;
let provinceFeatures = [];
let provinceCodeKeys = ["kode_provinsi", "kode provinsi", "prov_code", "kode"];
let csvStructuralIssues = [];
let masterWilayah = null;
let masterLoadError = "";

function norm(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function clean(value) { return String(value ?? "").trim(); }

function masterKorwilMap() {
  return masterWilayah && masterWilayah.korwilByProvince && typeof masterWilayah.korwilByProvince === "object"
    ? masterWilayah.korwilByProvince : {};
}
function getKorwil(province) {
  const key = norm(canonicalProvince(province));
  const mapping = masterKorwilMap();
  const found = Object.entries(mapping).find(([name]) => norm(name) === key);
  return found ? found[1] : null;
}

function parseCSV(text) {
  // Detect comma/semicolon/tab separators from the header line, respecting quotes.
  const firstLine = (text.split(/\r\n|\n|\r/).find(line => line.trim()) || "");
  const separators = [",", ";", "\t"];
  let delimiter = ",";
  let best = -1;
  for (const sep of separators) {
    let count = 0, quoted = false;
    for (let i = 0; i < firstLine.length; i++) {
      if (firstLine[i] === '"') {
        if (quoted && firstLine[i+1] === '"') i++;
        else quoted = !quoted;
      } else if (firstLine[i] === sep && !quoted) count++;
    }
    if (count > best) { best = count; delimiter = sep; }
  }

  const rows = []; let row = []; let cell = ""; let quoted = false; let rowNumber = 1;
  csvStructuralIssues = [];
  for (let i=0; i<text.length; i++) {
    const c = text[i], next = text[i+1];
    if (c === '"' && quoted && next === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && next === '\n') i++;
      row.push(cell); if (row.some(v => clean(v) !== "")) rows.push(row);
      row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("CSV memiliki tanda kutip yang tidak berpasangan");
  if (cell.length || row.length) { row.push(cell); if (row.some(v => clean(v) !== "")) rows.push(row); }
  if (!rows.length) return [];

  const normalizeHeader = h => clean(h).replace(/^\uFEFF/, "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s./-]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^_+|_+$/g, "");
  const aliases = {
    cluster_id: ["cluster_id","id_klaster","id","kode_klaster","kode"],
    nama_klaster: ["nama_klaster","nama_klaster_logistik","klaster","nama_cluster","nama"],
    kode_provinsi: ["kode_provinsi","kode_prov","kode_provinsi_induk"],
    nama_provinsi: ["nama_provinsi","provinsi","provinsi_nama","nama_propinsi","propinsi"],
    kode_kab_kota: ["kode_kab_kota","kode_kabupaten_kota","kode_kab_kota_induk","kode_wilayah"],
    nama_kab_kota: ["nama_kab_kota","nama_kabupaten_kota","kabupaten_kota","kab_kota","nama_kabupaten","nama_kota","kabupaten","kota"],
    jenis_wilayah: ["jenis_wilayah","tingkat_wilayah","kategori_wilayah","jenis_daerah"],
    status_pembentukan: ["status_pembentukan","status","status_klaster","status_pembentukan_klaster"],
    tanggal_pembentukan: ["tanggal_pembentukan","tgl_pembentukan","tanggal"],
    tahun_pembentukan: ["tahun_pembentukan","tahun","tahun_dibentuk"],
    tanggal_pembaruan: ["tanggal_pembaruan","updated_at","last_updated","tanggal_update"],
    diubah_oleh: ["diubah_oleh","updated_by","editor"],
    status_sebelumnya: ["status_sebelumnya","previous_status"],
    catatan_perubahan: ["catatan_perubahan","change_note","riwayat_perubahan"],
    catatan: ["catatan","keterangan","deskripsi"]
  };
  const headers = rows.shift().map(normalizeHeader);
  const canonical = headers.map(h => {
    for (const [key, names] of Object.entries(aliases)) if (names.includes(h)) return key;
    return h;
  });
  return rows.map((values,index) => {
    const obj = {};
    if(values.length !== canonical.length) {
      const issue = `Baris CSV ${index+2}: jumlah kolom ${values.length}, seharusnya ${canonical.length}`;
      csvStructuralIssues.push(issue); obj._csv_issue = issue;
    }
    canonical.forEach((h,i) => { if (h) obj[h] = clean(values[i]); });
    if(values.length > canonical.length) obj._csv_extra = values.slice(canonical.length).join(" | ");
    return obj;
  }).filter(r => Object.entries(r).some(([k,v]) => !k.startsWith("_") && v !== ""));
}
function get(row, key) { return clean(row[key]); }
function statusClass(status) {
  const s = normalizedStatus(status);
  if (s === "terbentuk") return "status-terbentuk";
  if (s === "dalam proses") return "status-dalam-proses";
  if (s === "belum terbentuk") return "status-belum-terbentuk";
  if (s === "perlu verifikasi" || s === "tidak diketahui") return "status-perlu-verifikasi";
  return "status-unknown";
}
function statusColor(status) {
  const s = norm(status);
  if (s === "terbentuk") return "#198754";
  if (s === "dalam proses") return "#d6a21d";
  return "#b8c5d1";
}
function provinceName(feature) {
  const p = feature.properties || {};
  const candidates = [
    p.Propinsi, p.PROVINSI, p.provinsi, p.Provinsi,
    p.name, p.NAME, p.NAME_1, p.NAME_2, p.NAME_3,
    p.prov_name, p.province, p.PROVINCE, p.PROVINCE_NAME,
    p.Propinsi, p.NAMOBJ, p.WADMPR, p.nm_provinsi
  ];
  const value = candidates.find(v => typeof v === "string" && v.trim());
  return value || "Provinsi";
}
function formatProvinceName(name) {
  const value = String(name || "").trim().toLocaleLowerCase("id-ID");
  const title = value.replace(/\b\p{L}/gu, ch => ch.toLocaleUpperCase("id-ID"));
  return title
    .replace(/^Di Yogyakarta$/i, "DI Yogyakarta")
    .replace(/^Dki Jakarta$/i, "DKI Jakarta");
}
function clustersForProvince(name) {
  const key=norm(canonicalProvince(name));
  return clusters.filter(c=>norm(canonicalProvince(get(c,"nama_provinsi")))===key);
}
function normalizedStatus(value) {
  const v = norm(value).replace(/[._-]+/g," ").replace(/\s+/g," ").trim();
  if (["terbentuk","sudah terbentuk","dibentuk"].includes(v)) return "terbentuk";
  if (["dalam proses","proses","sedang dibentuk"].includes(v)) return "dalam proses";
  if (["belum terbentuk","belum dibentuk","belum ada"].includes(v)) return "belum terbentuk";
  if (["perlu verifikasi","verifikasi"].includes(v)) return "perlu verifikasi";
  return "tidak diketahui";
}
function statusCounts(rows) {
  const keys=["terbentuk","dalam proses","belum terbentuk","perlu verifikasi","tidak diketahui"];
  return Object.fromEntries(keys.map(k=>[k,rows.filter(c=>effectiveStatus(c,clusters)===k).length]));
}
function provinceSummary(name) {
  const data=uniqueClusters(filteredForMap(clustersForProvince(name)));
  if(!data.length)return {status:"Belum Ada Data",count:0,color:"#b8c5d1",counts:{}};
  const counts=statusCounts(data),present=Object.keys(counts).filter(k=>counts[k]>0);
  if(present.length>1)return {status:"Campuran",count:data.length,color:"#7a68b5",counts};
  const status=present[0]||"tidak diketahui";
  const colors={terbentuk:"#198754","dalam proses":"#d6a21d","belum terbentuk":"#c94b48","perlu verifikasi":"#4d83b8","tidak diketahui":"#718096"};
  const labels={terbentuk:"Terbentuk","dalam proses":"Dalam Proses","belum terbentuk":"Belum Terbentuk","perlu verifikasi":"Perlu Verifikasi","tidak diketahui":"Tidak Diketahui"};
  return {status:labels[status]||"Perlu Verifikasi",count:data.length,color:colors[status]||"#718096",counts};
}
function styleFeature(feature) {
  const s = provinceSummary(provinceName(feature));
  return {color:"#ffffff", weight:1.2, opacity:1, fillColor:s.color, fillOpacity:.78};
}
async function loadProvinceGeoJSON() {
  let lastError = null;
  for (const url of GEOJSON_URLS) {
    try {
      const response = await fetchWithTimeout(url, {cache:"force-cache"}, 20000);
      if (!response.ok) throw new Error(`Sumber peta merespons ${response.status}`);
      const geo = await response.json();
      if (!geo || !Array.isArray(geo.features) || !geo.features.length) throw new Error("Format GeoJSON tidak valid");
      return geo;
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error("Semua sumber peta gagal");
}
function initMap() {
  if (!window.L) {
    showNotice("Library peta tidak berhasil dimuat. Periksa koneksi internet atau blokir CDN.");
    return;
  }
  map = L.map("map", {scrollWheelZoom:false, zoomControl:true, preferCanvas:true}).setView([-2.5,118], 4.2);
  // Basemap terbaru dan interaktif: label tempat + pilihan layer peta.
  const voyager = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution:'&copy; OpenStreetMap contributors &copy; CARTO', subdomains:"abcd", maxZoom:20
  }).addTo(map);
  voyager.on("tileerror",()=>showNotice("Basemap peta gagal dimuat. Coba ganti layer ke OpenStreetMap; tabel dan statistik tetap tersedia."));
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:'&copy; OpenStreetMap contributors', maxZoom:19
  });
  osm.on("tileerror",()=>showNotice("Layanan tile OpenStreetMap sedang bermasalah. Data tabel tetap tersedia."));
  L.control.layers({"Peta modern (Voyager)":voyager,"OpenStreetMap":osm}, null, {collapsed:true}).addTo(map);
  L.control.scale({imperial:false, position:"bottomleft"}).addTo(map);
  loadProvinceGeoJSON().then(geo => {
    provinceFeatures = geo.features || [];
    provinceLayer = L.geoJSON(geo, {
      style:styleFeature,
      onEachFeature:(feature, layer) => {
        const name = provinceName(feature);
        layer.on("mouseover", function(){ this.setStyle({weight:2.5, color:"#102a43", fillOpacity:.92}); });
        layer.on("mouseout", function(){ if (provinceLayer) provinceLayer.resetStyle(this); });
        layer.on("click", function() {
          const provinceData = uniqueClusters(filteredForMap(clustersForProvince(name)));
          const kabKotaNames = [...new Set(provinceData
            .filter(c => isKabKota(c))
            .map(c => get(c,"nama_kab_kota"))
            .filter(Boolean))];
          const provinceLabel = escapeHTML(formatProvinceName(name));
          const kabKotaLabel = escapeHTML(kabKotaNames.join(", ") || "—");
          const totalClusters = provinceData.length;
          const summary=provinceSummary(name);
          const counts=statusCounts(provinceData);
          const statusCounts=Object.entries(counts).filter(([,n])=>n>0);
          const statusBreakdown=statusCounts.map(([st,n])=>`<div class="popup-line">${escapeHTML(st.replace(/\b\w/g,ch=>ch.toUpperCase()))}: ${n} (${Math.round(n/Math.max(1,totalClusters)*100)}%)</div>`).join("");
          const diag=buildDiagnostics(clusters),verified=provinceData.filter(c=>rowQuality(c,clusters,diag).length===0&&c._identity_state==="identified").length;
          const masterMatched=provinceData.filter(c=>masterValidationIssues(c).length===0).length;
          const masterIssues=provinceData.length-masterMatched;
          const html = `<div class="popup-title">${totalClusters} Kandidat Klaster</div><div class="popup-line">Provinsi: ${provinceLabel}</div><div class="popup-line">Kabupaten/Kota: ${kabKotaLabel}</div><div class="popup-line">Identitas terverifikasi: ${verified} · Sementara/perlu audit: ${totalClusters-verified}</div><div class="popup-line">Cocok master wilayah: ${masterMatched} · Ada temuan/belum lengkap: ${masterIssues}</div><div class="popup-line"><strong>Rincian status efektif</strong> <small>(bukan histori perubahan)</small></div>${statusBreakdown}`;
          this.bindPopup(html).openPopup();
          $("searchInput").value = name;
          renderTable();
        });
      }
    }).addTo(map);
    try { map.fitBounds(provinceLayer.getBounds(), {padding:[8,8]}); } catch(e) {}
    setTimeout(() => { if (map) map.invalidateSize(); }, 100);
    refreshMap();
  }).catch((error) => {
    console.error("Gagal memuat GeoJSON provinsi:", error);
    showNotice("Peta batas provinsi gagal dimuat. Periksa koneksi internet/CDN atau buka Console browser untuk melihat sumber GeoJSON yang gagal. Daftar data tetap bisa digunakan.");
  });
}
function refreshMap() { if (provinceLayer) provinceLayer.setStyle(styleFeature); }
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function showNotice(message) { $("notice").hidden = false; $("notice").textContent = message; }
function hideNotice() { $("notice").hidden = true; }
function visibleClusters() { return activeKorwil ? clusters.filter(c => getKorwil(get(c,"nama_provinsi")) === activeKorwil) : clusters; }


function identitySignature(c) {
  return ["nama_klaster","jenis_wilayah","kode_provinsi","nama_provinsi","kode_kab_kota","nama_kab_kota"].map(k=>norm(get(c,k))).join("|");
}
function stateSignature(c) {
  return [normalizedStatus(get(c,"status_pembentukan")),get(c,"tahun_pembentukan")].join("|");
}
function rowSignature(c) {
  return [get(c,"cluster_id"),identitySignature(c),stateSignature(c)].map(norm).join("|");
}
function entitySignature(c) { return identitySignature(c); }
function idGroups(rows=clusters) {
  const groups=new Map(); rows.filter(c=>get(c,"cluster_id")).forEach(c=>{
    const id=norm(get(c,"cluster_id")); if(!groups.has(id))groups.set(id,[]); groups.get(id).push(c);
  }); return groups;
}
function idConflicts(rows=clusters) {
  return new Set([...idGroups(rows)].filter(([,items])=>new Set(items.map(entitySignature)).size>1).map(([id])=>id));
}
function noIdGroups(rows=clusters) {
  const groups=new Map(); rows.filter(c=>!get(c,"cluster_id")).forEach(c=>{
    const sig=entitySignature(c); if(!groups.has(sig))groups.set(sig,[]); groups.get(sig).push(c);
  }); return groups;
}
function noIdCandidates(rows=clusters) {
  return new Set([...noIdGroups(rows)].filter(([,items])=>new Set(items.map(stateSignature)).size>1).map(([sig])=>sig));
}
function duplicateRowCount(rows=clusters) {
  const counts=new Map(); rows.forEach(c=>{const sig=rowSignature(c);counts.set(sig,(counts.get(sig)||0)+1);});
  return [...counts.values()].reduce((n,v)=>n+Math.max(0,v-1),0);
}
function effectiveStatus(c) {
  // Konflik lintas Korwil tetap diperiksa secara global; cache mencegah penghitungan ulang berulang.
  const diagnostics=diagnosticsCache || buildDiagnostics(clusters);
  const id=norm(get(c,"cluster_id"));
  if(id && (diagnostics.conflicts.has(id) || diagnostics.stateVariants.has(id))) return "perlu verifikasi";
  if(!id && diagnostics.noIdCandidates.has(entitySignature(c))) return "perlu verifikasi";
  return normalizedStatus(get(c,"status_pembentukan"));
}
function uniqueClusters(rows=clusters) {
  const groups=idGroups(rows), conflicts=idConflicts(rows), noId=noIdGroups(rows), noIdVariant=noIdCandidates(rows);
  const seen=new Set(), out=[];
  rows.forEach(c=>{
    const id=norm(get(c,"cluster_id"));
    const key=id?`id:${id}:${entitySignature(c)}`:`noid:${entitySignature(c)}`;
    if(seen.has(key))return; seen.add(key);
    const copy={...c};
    const sameEntityRows=id ? (groups.get(id)||[]).filter(x=>entitySignature(x)===entitySignature(c)) : (noId.get(entitySignature(c))||[]);
    copy._source_years=[...new Set(sameEntityRows.map(x=>get(x,"tahun_pembentukan")).filter(y=>/^\d{4}$/.test(y)))];
    copy._source_rows=sameEntityRows.length;
    if(!id) {
      const variants=noId.get(entitySignature(c))||[];
      copy._identity_state=noIdVariant.has(entitySignature(c))?"noid-history-review":"provisional";
      if(noIdVariant.has(entitySignature(c))) {copy.status_pembentukan="Perlu Verifikasi";copy.tahun_pembentukan="";}
    } else {
      const items=groups.get(id)||[];
      if(conflicts.has(id)) {copy.status_pembentukan="Perlu Verifikasi";copy.tahun_pembentukan="";copy._identity_state="conflict";}
      else if(new Set(items.map(stateSignature)).size>1) {copy.status_pembentukan="Perlu Verifikasi";copy.tahun_pembentukan="";copy._identity_state="history-review";}
      else copy._identity_state="identified";
    }
    out.push(copy);
  });
  return out;
}
function tableRows(rows=clusters){
  const seen=new Set();return rows.filter(c=>{if(c._csv_issue||c._csv_extra)return true;const sig=rowSignature(c);if(seen.has(sig))return false;seen.add(sig);return true;});
}
function idAttributeVariants(rows=clusters){
  const groups=idGroups(rows);
  return new Set([...groups].filter(([,items])=>new Set(items.map(c=>stateSignature(c))).size>1).map(([id])=>id));
}
function buildDiagnostics(rows=clusters){
  // Hitung diagnostik dataset utama sekali per pemuatan, lalu gunakan ulang.
  if(rows===clusters && diagnosticsCache) return diagnosticsCache;
  const result={conflicts:idConflicts(rows),stateVariants:idAttributeVariants(rows),noIdCandidates:noIdCandidates(rows),groups:idGroups(rows)};
  if(rows===clusters) diagnosticsCache=result;
  return result;
}
function masterValidationIssues(c){
  if(!masterWilayah) return ["Master wilayah tidak tersedia"];
  const issues=[], province=canonicalProvince(get(c,"nama_provinsi")), sourceProvCode=get(c,"kode_provinsi"), sourceProvName=get(c,"nama_provinsi");
  const provinceRows=masterWilayah.records.filter(r=>String(r.jenis_wilayah).toLowerCase()==="provinsi");
  const byCode=sourceProvCode?provinceRows.find(r=>String(r.kode_provinsi)===sourceProvCode):null;
  const byName=province?provinceRows.find(r=>norm(canonicalProvince(r.nama_provinsi))===norm(province)):null;
  const p=byCode||byName;
  if(!p){
    if(province||sourceProvCode) issues.push("Provinsi belum tercakup dalam master kode wilayah yang tersedia");
    return issues;
  }
  if(!sourceProvCode) issues.push("Kode provinsi kosong untuk validasi master");
  else if(sourceProvCode!==String(p.kode_provinsi)) issues.push("Kode provinsi tidak cocok dengan nama pada master");
  if(!sourceProvName) issues.push("Nama provinsi kosong untuk validasi master");
  else if(norm(canonicalProvince(sourceProvName))!==norm(canonicalProvince(p.nama_provinsi))) issues.push("Nama provinsi tidak cocok dengan kode pada master");
  if(isKabKota(c)){
    const code=get(c,"kode_kab_kota"), name=get(c,"nama_kab_kota");
    if(!code) issues.push("Kode Kabupaten/Kota kosong untuk validasi master");
    if(!name) issues.push("Nama Kabupaten/Kota kosong untuk validasi master");
    const byDistrictCode=code?masterWilayah.records.find(r=>r.kode_provinsi===p.kode_provinsi&&r.kode_kab_kota===code):null;
    const byDistrictName=name?masterWilayah.records.find(r=>r.kode_provinsi===p.kode_provinsi&&norm(r.nama_kab_kota)===norm(name)):null;
    if(code&&!byDistrictCode) issues.push("Kode Kabupaten/Kota tidak ditemukan pada master untuk provinsi induk");
    if(name&&!byDistrictName) issues.push("Nama Kabupaten/Kota tidak ditemukan pada master untuk provinsi induk");
    if(byDistrictCode&&name&&norm(byDistrictCode.nama_kab_kota)!==norm(name)) issues.push("Nama Kabupaten/Kota tidak cocok dengan kode pada master");
    if(byDistrictName&&code&&byDistrictName.kode_kab_kota!==code) issues.push("Kode Kabupaten/Kota tidak cocok dengan nama pada master");
  }
  return issues;
}

function isStructurallyUsable(c){return !c._csv_issue&&!c._csv_extra;}

function masterValidationSummary(rows){
 const evaluated=rows.filter(c=>isStructurallyUsable(c)&&get(c,"nama_provinsi"));
 let matched=0, uncovered=0, mismatched=0, incomplete=0, withAnyIssue=0;
 evaluated.forEach(c=>{
   const issues=masterValidationIssues(c);
   if(!issues.length) matched++;
   if(issues.some(x=>/belum tercakup|tidak ditemukan/i.test(x))) uncovered++;
   if(issues.some(x=>/tidak cocok/i.test(x))) mismatched++;
   if(issues.some(x=>/kosong untuk validasi|kode dan nama .* kosong|kosong.*validasi/i.test(x))) incomplete++;
   if(issues.length) withAnyIssue++;
 });
 return {evaluated: evaluated.length, matched, uncovered, mismatched, incomplete, withAnyIssue};
}
function latestSourceUpdate(rows){
 const dates=rows.map(c=>clean(get(c,"tanggal_pembaruan"))).filter(Boolean)
   .map(value=>({value,date:new Date(value)})).filter(x=>!Number.isNaN(x.date.getTime()));
 if(!dates.length)return "Tidak tersedia pada sumber";
 dates.sort((a,b)=>b.date-a.date);
 return dates[0].date.toLocaleString("id-ID",{dateStyle:"medium"});
}
function activeFilterDescription(){
 const parts=[];
 if(activeKorwil)parts.push("Korwil="+activeKorwil);
 if($("typeFilter")?.value)parts.push("Jenis="+$("typeFilter").selectedOptions[0]?.textContent);
 const q=clean($("searchInput")?.value); if(q)parts.push("Pencarian="+q);
 return parts.length?parts.join(" | "):"Semua data (tanpa filter)";
}

function rowQuality(c, rows=clusters, diagnostics=buildDiagnostics(rows)) {
  const issues=[];
  if(!get(c,"cluster_id"))issues.push("ID kosong; identitas sementara");
  if(!get(c,"nama_klaster"))issues.push("Nama klaster kosong");
  if(!get(c,"nama_provinsi"))issues.push("Provinsi kosong");
  else if(!getKorwil(get(c,"nama_provinsi")))issues.push("Provinsi belum memiliki pemetaan Korwil pada master");
  if(!get(c,"jenis_wilayah"))issues.push("Jenis wilayah kosong");
  else if(kindOf(c)==="unknown")issues.push("Jenis wilayah tidak dikenali");
  if(isKabKota(c)&&!get(c,"nama_kab_kota"))issues.push("Kabupaten/Kota kosong");
  if(isKabKota(c)&&!get(c,"kode_kab_kota"))issues.push("Kode Kabupaten/Kota kosong");
  if(kindOf(c)==="provinsi"&&!get(c,"kode_provinsi"))issues.push("Kode provinsi kosong");
  if(kindOf(c)==="provinsi"&&(get(c,"kode_kab_kota")||get(c,"nama_kab_kota")))issues.push("Kolom Kabupaten/Kota terisi pada tingkat provinsi");
  if(isKabKota(c)&&!get(c,"kode_provinsi"))issues.push("Kode provinsi induk kosong");
  if(get(c,"kode_provinsi")&&!/^\d{1,3}$/.test(get(c,"kode_provinsi")))issues.push("Format kode provinsi perlu diperiksa");
  if(isKabKota(c)&&get(c,"kode_kab_kota")&&!/^\d{1,6}$/.test(get(c,"kode_kab_kota")))issues.push("Format kode Kabupaten/Kota perlu diperiksa");
  const year=get(c,"tahun_pembentukan");
  if(!/^\d{4}$/.test(year)||Number(year)<1900||Number(year)>new Date().getFullYear()+1)issues.push("Tahun tidak valid/kosong");
  const normalized=normalizedStatus(get(c,"status_pembentukan"));
  if(!get(c,"status_pembentukan"))issues.push("Status kosong");
  else if(normalized==="perlu verifikasi")issues.push("Status secara eksplisit perlu diverifikasi");
  else if(normalized==="tidak diketahui")issues.push("Status tidak dikenali");
  const expectedKorwil=getKorwil(get(c,"nama_provinsi"));
  if(!get(c,"nama_korwil"))issues.push(expectedKorwil?"Korwil kosong di sumber; pemetaan aplikasi: "+expectedKorwil:"Nama Korwil kosong dan provinsi belum dipetakan");
  else if(expectedKorwil&&norm(get(c,"nama_korwil"))!==norm(expectedKorwil))issues.push("Nama Korwil sumber tidak sesuai pemetaan provinsi");
  issues.push(...masterValidationIssues(c));
  if(c._csv_issue)issues.push(c._csv_issue);
  if(c._csv_extra)issues.push("Terdapat kolom tambahan di luar header");
  const id=norm(get(c,"cluster_id"));
  if(id&&diagnostics.conflicts.has(id))issues.push("ID digunakan untuk entitas berbeda");
  else if(id&&diagnostics.stateVariants.has(id))issues.push("ID memiliki variasi status/tahun; perlu rekonsiliasi");
  else if(!id&&diagnostics.noIdCandidates.has(entitySignature(c)))issues.push("Kandidat duplikasi tanpa ID dengan variasi status/tahun");
  return issues;
}
function issueSeverity(issues) {
  if(issues.some(x=>/CSV|entitas berbeda|provinsi kosong|nama provinsi tidak ada|kode .*tidak cocok|nama .*tidak cocok|kabupaten\/kota tidak ditemukan|kabupaten\/kota tidak cocok|format kode|jenis wilayah tidak dikenali/i.test(x)))return "kritis";
  if(issues.length)return "peringatan";
  return "valid";
}
function kindOf(c) {
  const k=norm(get(c,"jenis_wilayah")).replace(/[^a-z0-9]/g,"");
  if(["provinsi","prov","tingkatprovinsi"].includes(k))return "provinsi";
  if(["kabupaten","kabkota","kabupatenkota","kota","kotakabupaten","tingkatkabupatenkota"].includes(k) || k.startsWith("kabupaten") || k.startsWith("kota"))return "kabupaten-kota";
  return "unknown";
}
function isKabKota(c){return kindOf(c)==="kabupaten-kota";}
function activeScope(rows=clusters){return activeKorwil?rows.filter(c=>getKorwil(get(c,"nama_provinsi"))===activeKorwil):rows;}
function filteredForMap(rows=clusters, options={}){
  const scoped=uniqueClusters(activeScope(rows)).filter(isStructurallyUsable),type=$("typeFilter").value;
  return scoped.filter(c=>!type||kindOf(c)===type);
}
function rowMatchesFilters(c) {
  const q=norm($("searchInput").value),type=$("typeFilter").value,scope=visibleClusters();
  const hay=norm([get(c,"cluster_id"),get(c,"nama_klaster"),get(c,"nama_provinsi"),get(c,"nama_kab_kota"),get(c,"jenis_wilayah"),getKorwil(get(c,"nama_provinsi"))||""].join(" "));
  return (!q||hay.includes(q))&&(!type||kindOf(c)===type);
}
function csvSafe(value) {
  let text=String(value??"");
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function canonicalProvince(name){
 const aliases={"dki jakarta":"Daerah Khusus Jakarta","jakarta":"Daerah Khusus Jakarta","di yogyakarta":"Daerah Istimewa Yogyakarta","yogyakarta":"Daerah Istimewa Yogyakarta","babel":"Kepulauan Bangka Belitung","bangka belitung":"Kepulauan Bangka Belitung","kepri":"Kepulauan Riau","nusantara":"Ibu Kota Nusantara","ntb":"Nusa Tenggara Barat","ntt":"Nusa Tenggara Timur"};
 const n=norm(name); if(aliases[n])return aliases[n];
 const names=Object.keys(masterKorwilMap());
 return names.find(x=>norm(x)===n)||clean(name);
}

function exportVisibleCSV(){
 const rows=filteredRowsCache;
 const cols=["cluster_id","nama_klaster","jenis_wilayah","kode_provinsi","nama_provinsi","kode_kab_kota","nama_kab_kota","nama_korwil","status_pembentukan","tahun_pembentukan","tanggal_pembaruan","diubah_oleh","status_sebelumnya","catatan_perubahan"];
 const diagnostics=buildDiagnostics(clusters),exportedAt=new Date().toISOString(),scope=activeFilterDescription();
 const exportHeaders=[...cols,"tahun_sumber_terkait","status_identitas","tingkat_temuan","kualitas_data","hasil_validasi_master","catatan_kualitas","sumber_data","cakupan_ekspor","jumlah_baris_ekspor","filter_ekspor","waktu_ekspor"];
 const csv=[exportHeaders.map(csvSafe).join(","),...rows.map(r=>{
   const id=norm(get(r,"cluster_id"));
   const identityState=!id?"sementara tanpa ID":diagnostics.conflicts.has(id)?"konflik identitas":diagnostics.stateVariants.has(id)?"riwayat perlu rekonsiliasi":"teridentifikasi";
   const issues=rowQuality(r,visibleClusters(),diagnostics);
   return [...cols.map(k=>get(r,k)),(r._source_years||[]).join("|"),identityState,issueSeverity(issues),issues.length?"Perlu diperiksa":"Lengkap",masterValidationIssues(r).join("; ")||"Cocok/ tidak ada temuan",issues.join("; "),"Google Sheets · DATA_KLASTER","Hasil sesuai filter aktif",rows.length,scope,exportedAt].map(csvSafe).join(",");
 })].join("\r\n");
 const blob=new Blob(["\uFEFF",csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
 const stamp=exportedAt.slice(0,10).replace(/-/g,"");
 a.href=url;a.download=`data-klaster-logistik-${stamp}-${rows.length}-baris.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function renderStats() {
  const source=activeScope(clusters),scoped=uniqueClusters(source).filter(isStructurallyUsable);
  const formed=scoped.filter(c=>effectiveStatus(c,source)==="terbentuk");
  const provinceClusters=formed.filter(c=>kindOf(c)==="provinsi"),kabKotaClusters=formed.filter(c=>kindOf(c)==="kabupaten-kota");
  $("formedTotalCount").textContent=scoped.length.toLocaleString("id-ID");
  $("provinceClusterCount").textContent=provinceClusters.length.toLocaleString("id-ID");
  $("regencyClusterCount").textContent=kabKotaClusters.length.toLocaleString("id-ID");
  $("inProgressCount").textContent=scoped.filter(c=>effectiveStatus(c,source)==="dalam proses").length.toLocaleString("id-ID");
}

function renderTable() {
  const scoped=visibleClusters(),diagnostics=buildDiagnostics(clusters);
  let rows=tableRows(scoped).filter(rowMatchesFilters);
  rows.sort((a,b)=>{
    const keys={id:[get(a,"cluster_id"),get(b,"cluster_id")],tahun:[get(a,"tahun_pembentukan"),get(b,"tahun_pembentukan")],nama:[get(a,"nama_klaster")||get(a,"nama_provinsi"),get(b,"nama_klaster")||get(b,"nama_provinsi")],korwil:[getKorwil(get(a,"nama_provinsi"))||"",getKorwil(get(b,"nama_provinsi"))||""],status:[get(a,"status_pembentukan"),get(b,"status_pembentukan")]};
    const [av,bv]=keys[sortKey]||keys.tahun;const cmp=sortKey==="tahun"?(Number(av)||0)-(Number(bv)||0):String(av).localeCompare(String(bv),"id",{numeric:true,sensitivity:"base"});
    return sortDirection==="asc"?cmp:-cmp;
  });
  filteredRowsCache=rows;
  const totalPages=Math.max(1,Math.ceil(rows.length/pageSize));currentPage=Math.min(currentPage,totalPages);
  const start=(currentPage-1)*pageSize,pageRows=rows.slice(start,start+pageSize);
  $("resultCount").textContent=`${rows.length.toLocaleString("id-ID")} data ditampilkan`;
  $("pageInfo").textContent=`Halaman ${currentPage} dari ${totalPages}`;
  $("prevPage").disabled=currentPage<=1;$("nextPage").disabled=currentPage>=totalPages;
  if(!pageRows.length){$("clusterRows").innerHTML=`<tr><td colspan="6" class="empty">${scoped.length?"Tidak ada data yang cocok dengan filter.":"Belum ada data klaster. Periksa sumber Google Sheets."}</td></tr>`;return;}
  $("clusterRows").innerHTML=pageRows.map(c=>{
    const title=get(c,"nama_klaster")||get(c,"cluster_id")||"Klaster tanpa nama";
    const masterIssues=masterValidationIssues(c);
    const sourceYears=(c._source_years||[]).join(", ");
    const region=[get(c,"jenis_wilayah"),get(c,"nama_kab_kota"),get(c,"nama_provinsi")].filter(Boolean).join(", ")||"Wilayah belum diisi";
    const korwil=getKorwil(get(c,"nama_provinsi"))||"Belum dipetakan";
    const id=norm(get(c,"cluster_id"));
    const uncertainId=id&&(diagnostics.conflicts.has(id)||diagnostics.stateVariants.has(id));
    const statusText=effectiveStatus(c,scoped)==="perlu verifikasi"?"Perlu Verifikasi":get(c,"status_pembentukan");
    const issues=rowQuality(c,scoped,diagnostics),severity=issueSeverity(issues),quality=issues.length?`<span class="quality-flag ${severity}">${severity==="kritis"?"Kritis":"Peringatan"} (${issues.length})</span>`:'<span class="quality-ok">Lengkap</span>';
    const auditDetails=`<details class="row-audit"><summary>Detail pemeriksaan</summary><div><strong>Tahun pada sumber:</strong> ${escapeHTML(sourceYears||"Tidak tersedia")}<br><strong>Baris sumber terkait:</strong> ${Number(c._source_rows||1)}<br><strong>Validasi master:</strong> ${escapeHTML(masterIssues.join("; ")||"Tidak ada temuan")}<br><strong>Temuan kualitas:</strong> ${escapeHTML(issues.join("; ")||"Tidak ada temuan")}</div></details>`;
    return `<tr><td>${escapeHTML(get(c,"cluster_id")||"—")}</td><td><span class="cluster-name">${escapeHTML(title)}</span><span class="cluster-region">${escapeHTML(region)}</span>${auditDetails}</td><td>${escapeHTML(korwil)}</td><td><span class="status-badge ${statusClass(statusText)}">${escapeHTML(statusText)}</span></td><td>${escapeHTML(get(c,"tahun_pembentukan")||"—")}</td><td>${quality}</td></tr>`;
  }).join("");
}
async function loadMasterWilayah(){
  try {
    const response=await fetchWithTimeout("/data/master-wilayah.json",{cache:"no-cache"},10000);
    if(!response.ok)throw new Error("HTTP "+response.status);
    const data=await response.json();
    if(!Array.isArray(data.records)||!data.records.length)throw new Error("Master kosong atau format tidak sesuai");
    masterWilayah=data;masterLoadError="";
  } catch(error) { masterWilayah=null;masterLoadError=error.message;console.warn("Master wilayah tidak tersedia:",error); }
}
async function loadData() {
  if (dataLoadInProgress) return;
  dataLoadInProgress = true;
  const refreshButton = $("refreshBtn");
  const originalRefreshLabel = refreshButton.textContent;
  refreshButton.disabled = true;
  refreshButton.textContent = "Memuat data…";
  refreshButton.setAttribute("aria-busy", "true");
  $("clusterRows").innerHTML='<tr><td colspan="6" class="empty">Menghubungkan sumber data…</td></tr>';
  hideNotice(); dataLoadSucceeded=false;

  // Sumber utama dimuat tanpa menunggu master wilayah dan histori.
  const supportLoads=Promise.allSettled([loadMasterWilayah()]);
  try {
    if(!SHEET_CSV_URL.startsWith("https://docs.google.com/spreadsheets/"))throw new Error("URL sumber bukan URL Google Sheets yang dikenali");
    const response=await fetchWithTimeout(SHEET_CSV_URL,{cache:"no-store"},20000);
    if(!response.ok)throw new Error("Google Sheets merespons "+response.status);
    const csv=await response.text(); lastDataCheckedAt=new Date();
    const parsed=parseCSV(csv); const mainCsvStructuralIssues=[...csvStructuralIssues];
    if(!parsed.length)throw new Error("CSV kosong atau tidak memiliki baris data");
    const headers=Object.keys(parsed[0]||{}),required=["cluster_id","nama_klaster","kode_provinsi","nama_provinsi","kode_kab_kota","nama_kab_kota","jenis_wilayah","status_pembentukan","tahun_pembentukan","nama_korwil"];
    const missing=required.filter(k=>!headers.includes(k));
    if(missing.length)throw new Error("Struktur CSV tidak sesuai. Kolom wajib tidak ditemukan: "+missing.join(", "));
    const usable=parsed.filter(c=>!norm(get(c,"cluster_id")).includes("contoh-hapus")&&!norm(get(c,"nama_klaster")).includes("contoh-hapus"));
    clusters=usable; dataLoadSucceeded=true; diagnosticsCache=null; diagnosticsCache=buildDiagnostics(clusters); const loadDiagnostics=diagnosticsCache;
    renderStats();renderTable();refreshMap();
    await supportLoads;
    csvStructuralIssues=mainCsvStructuralIssues;
    renderStats();renderTable();refreshMap();
    if(!clusters.length)showNotice("Google Sheets berhasil diakses dan struktur kolom sesuai, tetapi belum ada baris klaster. Data kosong tidak dianggap sebagai nol capaian.");
    else if(clusters.some(c=>rowQuality(c,clusters,loadDiagnostics).length))showNotice("Data berhasil dimuat, tetapi terdapat baris yang perlu diperiksa. Lihat panel Sumber dan Kualitas Data serta penanda pada tabel.");
    if(masterLoadError)showNotice("Master wilayah tidak berhasil dimuat ("+masterLoadError+"). Validasi kode administratif dilewati; statistik sumber tetap dapat dibaca.");
    if(csvStructuralIssues.length)showNotice("CSV berhasil dibaca, tetapi ada "+csvStructuralIssues.length+" baris dengan jumlah kolom tidak sesuai. Periksa ekspor spreadsheet sebelum menggunakan angka sebagai laporan final.");
  } catch(error) {
    dataLoadSucceeded=false;lastDataCheckedAt=new Date();clusters=[];diagnosticsCache=buildDiagnostics(clusters);renderStats();renderTable();refreshMap();
    await supportLoads;
    renderStats();renderTable();
    showNotice("Data tidak dapat digunakan: "+(error.name==="AbortError"?"Waktu tunggu sumber data habis":error.message)+". Periksa URL publikasi CSV, izin akses, dan header sheet DATA_KLASTER.");
  } finally {
    dataLoadInProgress = false;
    refreshButton.disabled = false;
    refreshButton.textContent = originalRefreshLabel;
    refreshButton.removeAttribute("aria-busy");
  }
}
$("searchInput").addEventListener("input",()=>{
  currentPage=1;
  clearTimeout(searchDebounceHandle);
  searchDebounceHandle=setTimeout(renderTable,180);
});
$("typeFilter").addEventListener("change",()=>{currentPage=1;renderTable();refreshMap();});
$("pageSize").addEventListener("change",()=>{pageSize=Number($("pageSize").value)||10;currentPage=1;renderTable();});
$("prevPage").addEventListener("click",()=>{currentPage=Math.max(1,currentPage-1);renderTable();});
$("nextPage").addEventListener("click",()=>{currentPage++;renderTable();});
document.querySelectorAll("th[data-sort]").forEach(th=>{const sort=()=>{const key=th.dataset.sort;if(sortKey===key)sortDirection=sortDirection==="asc"?"desc":"asc";else{sortKey=key;sortDirection=key==="tahun"?"desc":"asc";}currentPage=1;renderTable();};th.addEventListener("click",sort);th.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();sort();}});});
document.querySelectorAll(".korwil-button").forEach(button => button.addEventListener("click", () => {
  activeKorwil = button.dataset.korwil || "";
  currentPage=1;
  document.querySelectorAll(".korwil-button").forEach(item => item.classList.toggle("active", item === button));
  renderStats(); renderTable(); refreshMap();
}));
$("refreshBtn").addEventListener("click", loadData);
$("resetFiltersBtn").addEventListener("click",()=>{
  $("searchInput").value="";
  $("typeFilter").value="";
  activeKorwil=""; currentPage=1;
  document.querySelectorAll(".korwil-button").forEach(button=>button.classList.toggle("active",!button.dataset.korwil));
  renderStats();renderTable();refreshMap();
});
initMap();
loadData();


$("exportCsvBtn").addEventListener("click",exportVisibleCSV);
