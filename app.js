/* WebGIS progress viewer: data are deduplicated by Nomor Identifikasi. */
const DB_NAME = 'webgis-progress-db';
const BASE_DATA = window.APP_DATA?.cities || window.APP_DATA || {};
let rowsByCity = Object.fromEntries(Object.entries(BASE_DATA).map(([k,v]) => [k, Array.isArray(v) ? v.slice() : (Array.isArray(v?.rows) ? v.rows.slice() : [])]));
let geoByCity = Object.fromEntries(Object.entries(BASE_DATA).filter(([,v]) => v && !Array.isArray(v) && v.geo).map(([k,v]) => [k,v.geo]));
let dbPromise;
let markerLayer;
let polygonLayer;
let shouldFit = true;

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    if (!window.indexedDB) return reject(new Error('Penyimpanan browser tidak tersedia.'));
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{ if(!request.result.objectStoreNames.contains('cities')) request.result.createObjectStore('cities',{keyPath:'city'}); };
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
  return dbPromise;
}
async function persistCity(city) {
  const db=await getDb();
  await new Promise((resolve,reject)=>{ const tx=db.transaction('cities','readwrite'); tx.objectStore('cities').put({city,rows:rowsByCity[city]||[],geo:geoByCity[city]||null}); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); });
}
async function restoreStoredData() {
  try {
    const db=await getDb();
    const saved=await new Promise((resolve,reject)=>{const tx=db.transaction('cities','readonly'); const req=tx.objectStore('cities').getAll(); req.onsuccess=()=>resolve(req.result||[]); req.onerror=()=>reject(req.error);});
    for(const item of saved){ if(Array.isArray(item.rows))rowsByCity[item.city]=mergeRows(rowsByCity[item.city]||[],item.rows); if(item.geo)geoByCity[item.city]=item.geo; if(!citySelect.querySelector(`option[value="${CSS.escape(item.city)}"]`)){const o=document.createElement('option');o.value=item.city;o.textContent=item.city;citySelect.append(o);} }
  } catch(error) { statusLine.textContent=`Penyimpanan browser tidak dapat dibuka: ${error.message||error}`; }
}

const citySelect = document.getElementById('citySelect');
const surveyorSelect = document.getElementById('surveyorSelect');
const TARGET_SAMPLES_PER_ZONE = 3;
const statusLine = document.getElementById('statusLine');
const fmtDate = value => {
  if (!value) return '';
  const [y,m,d] = value.split('-');
  return `${d}/${m}/${y}`;
};
const text = value => value == null ? '' : String(value).trim();
const keyOf = row => text(row.ident || row.sample || `${row.date}|${row.surveyor}|${row.lon}|${row.lat}`);
const idKey = value => text(value).replace(/\.0$/, '').toLocaleLowerCase('id-ID');
const unique = values => [...new Set(values.filter(v => v != null && v !== ''))];

for (const city of [...new Set(['Pamekasan','Sampang','Sumenep',...Object.keys(rowsByCity)])].sort()) {
  if (!rowsByCity[city]) rowsByCity[city]=[];
  const option = document.createElement('option'); option.value = city; option.textContent = city; citySelect.append(option);
}

const mapAvailable = typeof L !== 'undefined';
let map;
if (mapAvailable) {
  map = L.map('map', { zoomControl: true }).setView([-7.05,113.7], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markerLayer = L.markerClusterGroup ? L.markerClusterGroup({showCoverageOnHover:false}) : L.layerGroup();
  markerLayer.addTo(map);
}

function currentRows() { return rowsByCity[citySelect.value] || []; }
function allDates(rows) { return unique(rows.map(r => r.date)).sort(); }
function rebuildFilters() {
  const rows = currentRows();
  const oldPerson = surveyorSelect.value; surveyorSelect.replaceChildren();
  const everybody=document.createElement('option'); everybody.value=''; everybody.textContent='Semua surveyor'; surveyorSelect.append(everybody);
  for (const person of unique(rows.map(r=>r.surveyor)).sort((a,b)=>a.localeCompare(b,'id'))) { const o=document.createElement('option'); o.value=person; o.textContent=person; surveyorSelect.append(o); }
  if ([...surveyorSelect.options].some(o=>o.value===oldPerson)) surveyorSelect.value=oldPerson;
}

function dedupPoints(rows) {
  const seen=new Map();
  for (const r of rows) if (!seen.has(keyOf(r))) seen.set(keyOf(r),r);
  return [...seen.values()];
}

function calculate(rows, threshold, knownZones=null) {
  const byZone=new Map();
  for (const r of rows) {
    if (!r.zone || !r.date) continue;
    const zk=idKey(r.zone); if (!byZone.has(zk)) byZone.set(zk,new Map());
    const byDay=byZone.get(zk); if (!byDay.has(r.date)) byDay.set(r.date,new Map());
    const samples=byDay.get(r.date); const sk=keyOf(r);
    if (!samples.has(sk)) samples.set(sk,r);
  }
  const completed=new Set(); const awards=new Map(); const zoneSampleCounts=new Map();
  for (const [zone, byDay] of byZone) {
    let total=0; let already=false;
    for (const samples of byDay.values()) total+=samples.size;
    zoneSampleCounts.set(zone,total); total=0;
    for (const [day, samples] of [...byDay.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
      const before=total; total += samples.size;
      if (!already && before < threshold && total >= threshold) {
        already=true; if(!knownZones || knownZones.has(zone))completed.add(zone);
        const persons=unique([...samples.values()].map(r=>r.surveyor));
        const owner=persons.length===1 ? persons[0] : 'Kolaborasi';
        const k=`${day}\u0000${owner}`; awards.set(k,(awards.get(k)||0)+1);
      }
    }
  }
  return {completed, awards, zoneSampleCounts, zoneCount:knownZones?.size || byZone.size};
}

function renderTable(id, title, dates, people, valueAt) {
  const table=document.getElementById(id); table.replaceChildren();
  const thead=document.createElement('thead'); const tr=document.createElement('tr');
  const first=document.createElement('th'); first.textContent='Surveyor'; tr.append(first);
  for (const d of dates) { const th=document.createElement('th'); th.textContent=fmtDate(d); th.title=d; tr.append(th); }
  thead.append(tr); table.append(thead);
  const tbody=document.createElement('tbody');
  for (const p of people) {
    const row=document.createElement('tr'); const label=document.createElement('td'); label.textContent=p; row.append(label);
    for (const d of dates) { const td=document.createElement('td'); const n=valueAt(d,p)||0; td.textContent=n; td.className=n?'positive':'zero'; row.append(td); }
    tbody.append(row);
  }
  table.append(tbody);
}

function featureZone(feature) {
  const p=feature.properties||{};
  return propertyValue(p,['NOZN','NO_ZN','NO_ZONA','ZONE','ID_ZONA','ZONA']);
}

function normalizedField(value) { return String(value||'').toLocaleLowerCase('id-ID').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,''); }
function propertyValue(properties,aliases) {
  const entries=Object.entries(properties||{}); const keys=aliases.map(normalizedField);
  for(const alias of keys){const found=entries.find(([name,value])=>value!=null&&value!==''&&normalizedField(name)===alias);if(found)return found[1];}
  for(const alias of keys){if(alias.length<6)continue;const found=entries.find(([name,value])=>value!=null&&value!==''&&normalizedField(name).startsWith(alias));if(found)return found[1];}
  for(const alias of keys){const found=entries.find(([name,value])=>value!=null&&value!==''&&normalizedField(name).length>=6&&alias.startsWith(normalizedField(name)));if(found)return found[1];}
  return null;
}

function pointInRing(point,ring) {
  const [x,y]=point; let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i], [xj,yj]=ring[j];
    const cross=(x-xi)*(yj-yi)-(y-yi)*(xj-xi);
    if(Math.abs(cross)<1e-10&&x>=Math.min(xi,xj)-1e-10&&x<=Math.max(xi,xj)+1e-10&&y>=Math.min(yi,yj)-1e-10&&y<=Math.max(yi,yj)+1e-10)return true;
    if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}
function pointInPolygonGeometry(point,geometry) {
  if(!geometry)return false;
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.type==='MultiPolygon'?geometry.coordinates:[];
  return polygons.some(poly=>poly.length&&pointInRing(point,poly[0])&&!poly.slice(1).some(hole=>pointInRing(point,hole)));
}
function zonesAtPoint(lon,lat,geo) {
  if(!geo)return [];
  return unique((geo.features||[]).filter(f=>pointInPolygonGeometry([lon,lat],f.geometry)).map(featureZone).filter(v=>v!=null).map(String));
}
function reassignSpatialRows(city,geo) {
  const rows=rowsByCity[city]||[]; const kept=rows.filter(r=>r.zoneSource!=='spatial');
  const spatial=rows.filter(r=>r.zoneSource==='spatial'); const points=new Map();
  for(const r of spatial)if(!points.has(`${r.date}\u0000${keyOf(r)}`))points.set(`${r.date}\u0000${keyOf(r)}`,r);
  for(const r of points.values()){
    const zones=zonesAtPoint(Number(r.lon),Number(r.lat),geo);
    if(!zones.length)kept.push({...r,zone:''}); else for(const zone of zones)kept.push({...r,zone});
  }
  rowsByCity[city]=mergeRows([],kept);
}
function mergeRows(existing,incoming) {
  const result=new Map();
  for(const r of [...existing,...incoming]){
    const k=`${r.date}\u0000${keyOf(r)}\u0000${idKey(r.zone)}`;
    if(!result.has(k))result.set(k,r);
  }
  return [...result.values()];
}

function renderMap(rows, calculation) {
  if (!mapAvailable) { document.getElementById('mapHint').textContent='Peta perlu koneksi internet untuk memuat pustaka peta.'; return; }
  markerLayer.clearLayers();
  const seen=new Set();
  for (const r of dedupPoints(rows)) {
    if (r.lon==null||r.lat==null||r.lon===''||r.lat==='') continue;
    const lon=Number(r.lon), lat=Number(r.lat); if (!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lon)>180||Math.abs(lat)>90) continue;
    const sampleKey=keyOf(r); if (seen.has(sampleKey)) continue; seen.add(sampleKey);
    const marker=L.circleMarker([lat,lon],{radius:6,color:'#fff',weight:1.5,fillColor:'#e76f51',fillOpacity:.95});
    marker.bindPopup(`<b>Titik sampel</b><br>No. sampel: ${escapeHtml(r.sample)}<br>Zona: ${escapeHtml(r.zone)}<br>Surveyor: ${escapeHtml(r.surveyor)}<br>Tanggal: ${escapeHtml(fmtDate(r.date))}`);
    markerLayer.addLayer(marker);
  }
  if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer=null; }
  const geo=geoByCity[citySelect.value];
  let polygonCount=0;
  if (geo) {
    polygonLayer=L.geoJSON(geo,{
      filter: feature => {
        const p=feature.properties||{}; const area=p.WADMKK||p.wadmkk||p.KABUPATEN||p.kabupaten||p.CITY||p.city;
        return !area || String(area).toLowerCase().includes(citySelect.value.toLowerCase());
      },
      style: feature => {
        const z=featureZone(feature); const done=z!=null&&calculation.completed.has(idKey(z));
        return {color:done?'#167d73':'#cf9f32',weight:1.4,fillColor:done?'#2a9d8f':'#e9c46a',fillOpacity:.27};
      },
      onEachFeature: (feature,layer) => {
        polygonCount++;
        const z=featureZone(feature); const done=z!=null&&calculation.completed.has(idKey(z));
        const n=z==null?0:(calculation.zoneSampleCounts.get(idKey(z))||0);
        layer.bindPopup(`<b>Zona ${escapeHtml(z)}</b><br>Sampel terkumpul: ${n}<br>Status: ${done?'Target tercapai':'Belum tercapai'}`);
      }
    }).addTo(map);
  }
  const shown=dedupPoints(rows).filter(r=>r.lon!=null&&r.lat!=null&&r.lon!==''&&r.lat!==''&&Number.isFinite(Number(r.lon))&&Number.isFinite(Number(r.lat)));
  if (shouldFit) {
    const bounds=[];
    if (polygonLayer && polygonCount) { try { bounds.push(polygonLayer.getBounds()); } catch (_) {} }
    if (shown.length) bounds.push(L.latLngBounds(shown.map(r=>[Number(r.lat),Number(r.lon)])));
    if (bounds.length) { let b=bounds[0]; for (const x of bounds.slice(1)) b=b.extend(x); map.fitBounds(b.pad(.08),{maxZoom:14}); }
    shouldFit=false;
  }
  document.getElementById('mapHint').textContent=`${seen.size} titik sampel ditampilkan${geo?` • ${polygonCount} polygon`:' • polygon belum dimuat'}.`;
}

function escapeHtml(value) { return String(value==null?'':value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

function update() {
  const city=citySelect.value; const selectedPerson=surveyorSelect.value;
  const threshold=TARGET_SAMPLES_PER_ZONE;
  const source=currentRows();
  const filtered=source.filter(r=>!selectedPerson||r.surveyor===selectedPerson);
  const geo=geoByCity[city];
  const knownZones=geo?new Set(unique((geo.features||[]).map(featureZone).filter(v=>v!=null).map(idKey))):null;
  const calc=calculate(filtered,threshold,knownZones); const points=dedupPoints(filtered); const people=selectedPerson?[selectedPerson]:unique(source.map(r=>r.surveyor)).sort((a,b)=>a.localeCompare(b,'id'));
  const dates=allDates(filtered);
  document.getElementById('zonesTotal').textContent=calc.zoneCount.toLocaleString('id-ID');
  document.getElementById('zonesDone').textContent=calc.completed.size.toLocaleString('id-ID');
  document.getElementById('zonesLeft').textContent=Math.max(0,calc.zoneCount-calc.completed.size).toLocaleString('id-ID');
  document.getElementById('zonesRatio').textContent=`dari ${calc.zoneCount.toLocaleString('id-ID')} zona keseluruhan`;
  document.getElementById('sampleCount').textContent=points.length.toLocaleString('id-ID');
  document.getElementById('samplePeriod').textContent='Semua tanggal';
  const pct=calc.zoneCount?Math.round(calc.completed.size/calc.zoneCount*100):0;
  document.getElementById('progressPercent').textContent=`${pct}%`;
  document.getElementById('surveyorCount').textContent=selectedPerson?'1':unique(source.map(r=>r.surveyor)).length;
  document.getElementById('surveyorHint').textContent=selectedPerson||'Pada kabupaten terpilih';
  document.getElementById('progressHint').textContent=`Target tetap ${threshold} sampel per zona`;
  const displayedZonePeople=calc.awards.size && [...calc.awards.keys()].some(k=>k.endsWith('\u0000Kolaborasi')) ? unique([...people,'Kolaborasi']) : people;
  renderTable('zoneTable','zona',dates,displayedZonePeople,(d,p)=>calc.awards.get(`${d}\u0000${p}`));
  const sampleCounts=new Map();
  for (const r of points) { const k=`${r.date}\u0000${r.surveyor}`; sampleCounts.set(k,(sampleCounts.get(k)||0)+1); }
  renderTable('sampleTable','sampel',dates,people,(d,p)=>sampleCounts.get(`${d}\u0000${p}`));
  renderMap(filtered,calc);
  const geoNote=geoByCity[city]?'Polygon dimuat.':'Belum ada polygon GeoJSON untuk kabupaten ini.';
  statusLine.innerHTML=`Data <strong>${escapeHtml(city)}</strong>: ${source.length.toLocaleString('id-ID')} baris valid • ${geoNote}`;
}

function normalizeHeader(obj) { const result={}; for (const [k,v] of Object.entries(obj)) result[String(k).trim().toLowerCase().replace(/[_*]/g,'').replace(/\s+/g,' ')]=v; return result; }
function getField(obj,names) { for(const n of names){const k=n.toLowerCase().replace(/[_*]/g,'').replace(/\s+/g,' '); if(obj[k]!=null&&obj[k]!=='')return obj[k];} return null; }
function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return `${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2,'0')}-${String(value.getUTCDate()).padStart(2,'0')}`;
  if (typeof value==='number'&&window.XLSX) { const d=XLSX.SSF.parse_date_code(value); if(d)return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`; }
  const s=String(value||'').trim(); if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  const compact=s.match(/^(\d{4})(\d{2})(\d{2})$/); if(compact)return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); if(m)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}

function featureCollection(value) {
  const items=Array.isArray(value)?value:[value]; const features=[];
  for(const item of items){if(item?.type==='FeatureCollection')features.push(...item.features);else if(item?.type==='Feature')features.push(item);}
  if(!features.length)throw new Error('Tidak ditemukan feature SHP/GeoJSON.');
  return {type:'FeatureCollection',features};
}
async function readShapefile(file) {
  if(typeof window.shp!=='function')throw new Error('Pembaca SHP belum termuat. Periksa koneksi internet dan muat ulang halaman.');
  const parsed=await window.shp(await file.arrayBuffer());
  return featureCollection(parsed);
}
function importSampleFeatures(geo,city) {
  const imported=[]; let skipped=0; let unassigned=0;
  for(const feature of geo.features){
    const geom=feature.geometry; const coords=geom?.type==='Point'?[geom.coordinates]:geom?.type==='MultiPoint'?geom.coordinates:[];
    if(!coords.length){skipped++;continue;}
    const props=feature.properties||{};
    const sample=propertyValue(props,['NOMOR_SAMPEL','NOMOR_SAMP','NO_SAMPEL','NO_SAMP','NOSAMPEL','SAMPLE','SAMPEL','OBJECTID','FID','ID']);
    const ident=propertyValue(props,['NOMOR_IDENTIFIKASI','NOMOR_IDENT','NO_IDENT','ID_SAMPEL','IDENTIFIKASI','GLOBALID']);
    const person=propertyValue(props,['NAMA_SURVEYOR','NAMA_SURVE','NAMA_SURV','SURVEYOR','SURVEY']);
    const date=normalizeDate(propertyValue(props,['TANGGAL_PELAKSANAAN','TANGGAL_P','TGL_PELAK','TGL_PEL','TANGGAL','TGL','DATE']));
    if(sample==null||person==null||!date){skipped++;continue;}
    for(const xy of coords){
      if(!Array.isArray(xy)||xy.length<2){skipped++;continue;}
      const lon=Number(xy[0]),lat=Number(xy[1]); if(!Number.isFinite(lon)||!Number.isFinite(lat)){skipped++;continue;}
      const sampleId=text(ident||sample); const explicitZone=propertyValue(props,['NOZN','NO_ZN','NO_ZONA','ZONE','ID_ZONA','ZONA']);
      const spatialZones=explicitZone==null?zonesAtPoint(lon,lat,geoByCity[city]):[];
      const zones=explicitZone!=null?[String(explicitZone)]:spatialZones;
      if(!zones.length){unassigned++;zones.push('');}
      for(const zone of zones)imported.push({zone,sample:text(sample),ident:sampleId,surveyor:text(person),date,lon,lat,zoneSource:explicitZone==null?'spatial':'attribute'});
    }
  }
  return {imported,skipped,unassigned};
}

document.getElementById('shpInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if(!file)return;
  try{
    statusLine.textContent='Membaca ZIP shapefile titik…';
    const geo=await readShapefile(file); const city=citySelect.value; const result=importSampleFeatures(geo,city);
    if(!result.imported.length)throw new Error('Tidak ada feature titik dengan atribut nomor sampel, surveyor, dan tanggal. Periksa isi DBF.');
    const before=(rowsByCity[city]||[]).length; rowsByCity[city]=mergeRows(rowsByCity[city]||[],result.imported); const added=rowsByCity[city].length-before;
    await persistCity(city); shouldFit=true; rebuildFilters(); update();
    statusLine.innerHTML=`SHP <strong>${escapeHtml(file.name)}</strong> ditambahkan: ${added} baris baru; ${result.skipped} feature dilewati${result.unassigned?`; ${result.unassigned} titik belum masuk zona` : ''}.`;
  }catch(error){alert(`SHP tidak dapat dimuat: ${error.message||error}`);}
  event.target.value='';
});

citySelect.addEventListener('change',()=>{shouldFit=true;rebuildFilters();document.getElementById('adminCityName').textContent=citySelect.value;update();});
surveyorSelect.addEventListener('change',update);
document.getElementById('excelInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if(!file)return;
  try {
    if(!window.XLSX)throw new Error('Pustaka Excel tidak termuat. Periksa koneksi internet lalu muat ulang halaman.');
    const wb=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});
    const required=['NOZN','Nomor Sampel','Nama Surveyor','Tanggal Pelaksanaan']; let raw=null;
    for(const sheetName of wb.SheetNames){const data=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{defval:null}); if(data.length&&required.every(k=>Object.keys(normalizeHeader(data[0])).includes(k.toLowerCase()))) {raw=data;break;}}
    if(!raw)throw new Error('Kolom wajib tidak ditemukan: NOZN, Nomor Sampel, Nama Surveyor, dan Tanggal Pelaksanaan.');
    const imported=[];
    for(const row of raw){const r=normalizeHeader(row); const sample=getField(r,['Nomor Sampel','No Sampel']); const surveyor=getField(r,['Nama Surveyor','Surveyor']); const date=normalizeDate(getField(r,['Tanggal Pelaksanaan','Tanggal'])); if(sample==null||!surveyor||!date)continue;
      const x=getField(r,['X','Longitude','Lon']), y=getField(r,['Y','Latitude','Lat']);
      imported.push({zone:text(getField(r,['NOZN','NO ZN','NO ZONA'])),sample:text(sample),ident:text(getField(r,['Nomor Identifikasi','ID Sampel']))||text(sample),surveyor:text(surveyor),date,lon:x==null||x===''?null:Number(x),lat:y==null||y===''?null:Number(y)});
    }
    if(!imported.length)throw new Error('Tidak ada baris sampel dengan tanggal dan surveyor yang valid.');
    const city=citySelect.value; const beforeCount=(rowsByCity[city]||[]).length; rowsByCity[city]=mergeRows(rowsByCity[city]||[],imported); const addedCount=rowsByCity[city].length-beforeCount;
    await persistCity(city);
    shouldFit=true; rebuildFilters(); update(); statusLine.innerHTML=`Excel untuk <strong>${escapeHtml(city)}</strong> ditambahkan: ${addedCount.toLocaleString('id-ID')} baris baru.`;
  }catch(error){alert(error.message||String(error));}
  event.target.value='';
});
document.getElementById('geoInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if(!file)return;
  try{
    let geo;
    if(file.name.toLowerCase().endsWith('.zip'))geo=await readShapefile(file); else geo=featureCollection(JSON.parse(await file.text()));
    const city=citySelect.value; geoByCity[city]=geo; reassignSpatialRows(city,geo); await persistCity(city); shouldFit=true; update();
    statusLine.innerHTML=`Polygon untuk <strong>${escapeHtml(city)}</strong> disimpan: ${geo.features.length.toLocaleString('id-ID')} feature.`;
  }
  catch(error){alert(`Polygon tidak dapat dimuat: ${error.message||error}`);}
  event.target.value='';
});

document.getElementById('publishButton').addEventListener('click',()=>{
  const cities={};
  for(const city of Object.keys(rowsByCity)){
    const rows=rowsByCity[city]||[]; const geo=geoByCity[city]||null;
    if(rows.length||geo)cities[city]={rows,geo};
  }
  const contents=`/* Data bersama WebGIS. Diperbarui oleh admin. */\nwindow.APP_DATA = ${JSON.stringify({cities})};\n`;
  const blob=new Blob([contents],{type:'text/javascript;charset=utf-8'}); const url=URL.createObjectURL(blob);
  const link=document.createElement('a'); link.href=url; link.download='data.js'; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  statusLine.textContent='Berkas data.js berhasil disiapkan. Ganti data.js di repository GitHub dengan berkas ini, lalu push agar semua pengguna menerima pembaruan.';
});

const adminPanel=document.getElementById('adminPanel');
const adminLogin=document.getElementById('adminLogin');
const adminTools=document.getElementById('adminTools');
document.getElementById('adminToggle').addEventListener('click',()=>{adminPanel.hidden=!adminPanel.hidden;});
adminLogin.addEventListener('submit',event=>{
  event.preventDefault();
  const username=document.getElementById('adminUsername').value.trim();
  const password=document.getElementById('adminPassword').value;
  const message=document.getElementById('adminMessage');
  if(username==='tenn'&&password==='welcome'){
    adminLogin.hidden=true; adminTools.hidden=false; message.textContent=''; document.getElementById('adminPassword').value='';
    document.getElementById('adminCityName').textContent=citySelect.value;
  }else message.textContent='Username atau password salah.';
});
document.getElementById('adminLogout').addEventListener('click',()=>{adminTools.hidden=true;adminLogin.hidden=false;adminLogin.reset();});

async function init() { await restoreStoredData(); rebuildFilters(); update(); }
init();
