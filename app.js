/* Progress viewer: data are deduplicated by Nomor Identifikasi. */
const invitationFlowAtLoad=(()=>{
  const hash=new URLSearchParams(location.hash.replace(/^#/,'') );
  const query=new URLSearchParams(location.search);
  return hash.get('type')==='invite'||query.get('type')==='invite'||query.has('invite');
})();
const DB_NAME = 'webgis-progress-db';
const BASE_DATA = window.APP_DATA?.cities || window.APP_DATA || {};
let rowsByCity = Object.fromEntries(Object.entries(BASE_DATA).map(([k,v]) => [k, Array.isArray(v) ? v.slice() : (Array.isArray(v?.rows) ? v.rows.slice() : [])]));
let geoByCity = Object.fromEntries(Object.entries(BASE_DATA).filter(([,v]) => v && !Array.isArray(v) && v.geo).map(([k,v]) => [k,v.geo]));
let geoOverviewByCity = {};
let dbPromise;
let markerLayer;
let polygonLayer;
let mapRowsForRender=[];
let mapIsAllView=false;
let geoForCurrentMap=null;
const THEME_COLORS={primary:'#1746A2',secondary:'#C8102E',light:'#7FA6E8',pale:'#DCE7FA'};
let zoneLayersById = new Map();
let selectedZoneId = '';
let currentCalculation = null;
let zoneListSort = {key:'zone',direction:'asc'};
const zoneIndexCache = new WeakMap();
const zonePropertiesCache = new WeakMap();
let shouldFit = true;
let supabaseClient = null;
let currentUser = null;
let legacyBrowserData = {};
const remoteCitiesLoaded = new Set();
const remoteFullGeoLoaded = new Set();
const remoteOverviewLoaded = new Set();
const remoteZoneMetadata = new Map();
let citySelectionRequest = 0;

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

function configuredSupabaseClient() {
  const config=window.SUPABASE_CONFIG||{};
  if(!config.url||!config.publishableKey||!window.supabase?.createClient)return null;
  return window.supabase.createClient(config.url,config.publishableKey);
}

function addCityOption(city) {
  if(!city||[...citySelect.options].some(option=>option.value===city))return;
  const option=document.createElement('option'); option.value=city; option.textContent=city; citySelect.append(option);
}

function simplifyLine(line,tolerance=0.0005){
  if(!Array.isArray(line)||line.length<=4)return line;
  const closed=line.length>3&&line[0][0]===line[line.length-1][0]&&line[0][1]===line[line.length-1][1];
  const points=closed?line.slice(0,-1):line;
  if(points.length<=3)return line;
  const keep=new Uint8Array(points.length);keep[0]=1;keep[points.length-1]=1;
  const stack=[[0,points.length-1]],tol2=tolerance*tolerance;
  while(stack.length){
    const [first,last]=stack.pop(),a=points[first],b=points[last];
    const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;let max=tol2,index=-1;
    for(let i=first+1;i<last;i++){
      const p=points[i];let t=den?((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den:0;t=Math.max(0,Math.min(1,t));
      const ex=p[0]-(a[0]+t*dx),ey=p[1]-(a[1]+t*dy),distance=ex*ex+ey*ey;
      if(distance>max){max=distance;index=i;}
    }
    if(index>=0){keep[index]=1;stack.push([first,index],[index,last]);}
  }
  const result=points.filter((_,index)=>keep[index]);
  if(result.length<3)return line;
  if(closed)result.push(result[0].slice());
  return result;
}
function makeOverviewGeo(geo){
  const reduceCoords=(coords,type)=>type==='Polygon'?coords.map(ring=>simplifyLine(ring)):coords.map(polygon=>polygon.map(ring=>simplifyLine(ring)));
  return {type:'FeatureCollection',features:(geo.features||[]).map(feature=>{
    const properties=feature.properties||{},zone=propertyValue(properties,['NOZN','NO_ZN','NO_ZONA','ZONE','ID_ZONA','ZONA']);
    const slimProperties=zone==null?{}:{NOZN:zone};
    if(Array.isArray(properties._zone_surveyors))slimProperties._zone_surveyors=properties._zone_surveyors;
    return {...feature,properties:slimProperties,geometry:{...feature.geometry,coordinates:reduceCoords(feature.geometry.coordinates,feature.geometry.type)}};
  })};
}

async function verifyAdminUser(user) {
  if(!user)return false;
  const {data,error}=await supabaseClient.from('webgis_admins').select('user_id').eq('user_id',user.id).maybeSingle();
  if(error)throw error;
  return !!data;
}

async function remoteZoneInfo(city) {
  if(remoteZoneMetadata.has(city))return remoteZoneMetadata.get(city);
  const {data,error}=await supabaseClient.from('city_zones').select('geojson').eq('city',city).maybeSingle();
  if(error)throw error;
  const info=data?.geojson||null;remoteZoneMetadata.set(city,info);return info;
}
async function fetchZoneGeo(info,pathKey) {
  if(!info)return null;
  if(!info[pathKey]){
    if(pathKey==='_overview_path'){
      if(info._storage_path)return makeOverviewGeo(await fetchZoneGeo(info,'_storage_path'));
      if(info.type==='FeatureCollection'||info.type==='Feature')return makeOverviewGeo(info);
      return null;
    }
    return info;
  }
  const {data}=supabaseClient.storage.from('zone-geojson').getPublicUrl(info[pathKey]);
  const publicUrl=new URL(data.publicUrl);
  publicUrl.searchParams.set('v',String(info._version||Date.now()));
  const response=await fetch(publicUrl.toString(),{cache:'no-store'});
  if(!response.ok)throw new Error(`File polygon tidak dapat diunduh dari penyimpanan database (${response.status}).`);
  if(pathKey==='_overview_path'&&info._overview_compressed){
    if(!('DecompressionStream'in window))throw new Error('Browser ini belum mendukung pembukaan polygon ringkas. Perbarui browser Anda.');
    return await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
  }
  return response.json();
}
async function loadRemoteCity(city,{overview=false}={}) {
  const info=await remoteZoneInfo(city);
  const geoSet=overview?remoteOverviewLoaded:remoteFullGeoLoaded;
  if(!geoSet.has(city)){
    const geo=await fetchZoneGeo(info,overview?'_overview_path':'_storage_path');
    if(overview){if(geo)geoOverviewByCity[city]=geo;else delete geoOverviewByCity[city];}
    else {if(geo)geoByCity[city]=geo;else delete geoByCity[city];}
    geoSet.add(city);
  }
  if(!remoteCitiesLoaded.has(city)){
    const records=[]; let from=0; const pageSize=1000;
    while(true){
      const result=await supabaseClient.from('samples')
        .select('zone,sample_number,ident,surveyor,sample_date,longitude,latitude,zone_source,properties')
        .eq('city',city).order('sample_date',{ascending:true}).range(from,from+pageSize-1);
      if(result.error)throw result.error;
      records.push(...(result.data||[]));
      if(!result.data||result.data.length<pageSize)break;
      from+=pageSize;
    }
    rowsByCity[city]=records.map(row=>({zone:row.zone,sample:row.sample_number,ident:row.ident,surveyor:row.surveyor,date:row.sample_date,lon:row.longitude,lat:row.latitude,zoneSource:row.zone_source,properties:row.properties||{}}));
    remoteCitiesLoaded.add(city);
  }
}

async function loadRemoteData() {
  const {data,error}=await supabaseClient.from('city_zones').select('city');
  if(error)throw error;
  for(const row of data||[])addCityOption(row.city);
  if(citySelect.value==='ALL')await loadAllRemoteCities();
  else if(citySelect.value)await loadRemoteCity(citySelect.value);
}

function districtNames(){return [...citySelect.options].map(option=>option.value).filter(city=>city&&city!=='ALL');}
async function loadAllRemoteCities(requestId=null){
  const cities=districtNames();
  for(let index=0;index<cities.length;index++){
    if(requestId!=null&&requestId!==citySelectionRequest)return;
    const city=cities[index];
    setLoadingStatus(`Memuat ${city} (${index+1}/${cities.length}) untuk tampilan ALL…`);
    await loadRemoteCity(city,{overview:true});
    await browserPaint();
  }
}

function sampleToRecord(row,city) {
  return {city,zone:text(row.zone),sample_number:text(row.sample),ident:text(row.ident||row.sample),surveyor:text(row.surveyor),sample_date:row.date,longitude:row.lon==null||row.lon===''?null:Number(row.lon),latitude:row.lat==null||row.lat===''?null:Number(row.lat),zone_source:row.zoneSource||'attribute',properties:row.properties||{},uploaded_by:currentUser.id};
}

async function upsertRemoteSamples(city,rows) {
  if(!currentUser)throw new Error('Silakan login sebagai admin sebelum mengunggah data.');
  const records=rows.map(row=>sampleToRecord(row,city));
  for(let start=0;start<records.length;start+=250){
    const {error}=await supabaseClient.from('samples').upsert(records.slice(start,start+250),{onConflict:'city,sample_date,ident,zone'});
    if(error)throw error;
  }
}

async function replaceRemoteSamples(city,rows) {
  if(!currentUser)throw new Error('Silakan login sebagai admin sebelum mengunggah data.');
  const records=[...new Map(rows.map(row=>{
    const record=sampleToRecord(row,city);
    return [`${record.sample_date}\u0000${record.ident}\u0000${record.zone}`,record];
  })).values()];
  for(let start=0;start<records.length;start+=250){
    const {error}=await supabaseClient.from('samples').upsert(records.slice(start,start+250),{onConflict:'city,sample_date,ident,zone'});
    if(error)throw error;
  }

  // Keep the old dataset until all incoming rows have been saved successfully.
  const keep=new Set(records.map(record=>`${record.sample_date}\u0000${record.ident}\u0000${record.zone}`));
  const existing=[];let from=0;const pageSize=1000;
  while(true){
    const {data,error}=await supabaseClient.from('samples').select('id,ident,sample_date,zone').eq('city',city).order('id',{ascending:true}).range(from,from+pageSize-1);
    if(error)throw error;
    existing.push(...(data||[]));
    if(!data||data.length<pageSize)break;
    from+=pageSize;
  }
  const stale=existing.filter(record=>!keep.has(`${record.sample_date}\u0000${record.ident}\u0000${record.zone}`)).map(record=>record.id);
  for(let start=0;start<stale.length;start+=200){
    const {error}=await supabaseClient.from('samples').delete().eq('city',city).in('id',stale.slice(start,start+200));
    if(error)throw error;
  }
}

async function saveSamples(city,rows) {
  if(supabaseClient)return replaceRemoteSamples(city,rows);
  await persistCity(city);
}

async function saveZone(city,geo) {
  if(!supabaseClient){await persistCity(city);return;}
  if(!currentUser)throw new Error('Silakan login sebagai admin sebelum mengunggah data.');
  const objectName=city.toLocaleLowerCase('en-US').replace(/[^a-z0-9-]+/g,'-');
  const version=Date.now();
  const storagePath=`zones/${objectName}.geojson`;
  const overviewPath=`zones/overview/${objectName}.geojson`;
  const geojsonFile=new Blob([JSON.stringify(geo)],{type:'application/geo+json'});
  const {error:uploadError}=await supabaseClient.storage.from('zone-geojson').upload(storagePath,geojsonFile,{
    contentType:'application/geo+json',cacheControl:'60',upsert:true
  });
  if(uploadError)throw uploadError;
  const overview=makeOverviewGeo(geo);
  const overviewText=JSON.stringify(overview);
  const overviewFile=new Blob([overviewText],{type:'application/geo+json'});
  const overviewMetadata={_overview_path:overviewPath,_overview_compressed:false,_version:version};
  const {error:overviewError}=await supabaseClient.storage.from('zone-geojson').upload(overviewMetadata._overview_path,overviewFile,{
    contentType:overviewFile.type,cacheControl:'60',upsert:true
  });
  if(overviewError)throw overviewError;
  const {data,error}=await supabaseClient.from('city_zones')
    .upsert({city,geojson:{_storage_path:storagePath,...overviewMetadata},updated_by:currentUser.id},{onConflict:'city'})
    .select('city,updated_at').single();
  if(error)throw error;
  if(data?.city!==city)throw new Error('Database tidak mengonfirmasi penyimpanan polygon untuk kabupaten ini.');
  geoOverviewByCity[city]=overview;remoteZoneMetadata.set(city,{_storage_path:storagePath,...overviewMetadata});
  remoteFullGeoLoaded.add(city);remoteOverviewLoaded.add(city);
}

async function prepareExistingOverview(city){
  if(!currentUser)throw new Error('Login sebagai admin terlebih dahulu.');
  const info=await remoteZoneInfo(city);
  if(!info?._storage_path)throw new Error(`Polygon detail ${city} belum tersimpan di database.`);
  const full=geoByCity[city]||await fetchZoneGeo(info,'_storage_path');
  const overview=makeOverviewGeo(full),overviewText=JSON.stringify(overview),objectName=city.toLocaleLowerCase('en-US').replace(/[^a-z0-9-]+/g,'-');
  const path=`zones/overview/${objectName}.geojson`;
  const file=new Blob([overviewText],{type:'application/geo+json'});
  const {error:uploadError}=await supabaseClient.storage.from('zone-geojson').upload(path,file,{contentType:'application/geo+json',cacheControl:'60',upsert:true});
  if(uploadError)throw uploadError;
  const updated={...info,_overview_path:path,_overview_compressed:false,_version:Date.now()};
  const {error}=await supabaseClient.from('city_zones').upsert({city,geojson:updated,updated_by:currentUser.id},{onConflict:'city'});
  if(error)throw error;
  geoOverviewByCity[city]=overview;remoteZoneMetadata.set(city,updated);remoteOverviewLoaded.add(city);
  return overview.features.length;
}

async function syncSpatialSamples(city){
  if(!supabaseClient)return;
  const {error:deleteError}=await supabaseClient.from('samples').delete().eq('city',city).eq('zone_source','spatial');
  if(deleteError)throw deleteError;
  await upsertRemoteSamples(city,(rowsByCity[city]||[]).filter(row=>row.zoneSource==='spatial'));
}

function describeUploadError(error){
  if(!error)return 'Kesalahan tidak diketahui.';
  if(error.code==='NoSuchBucket'||/bucket not found/i.test(error.message||''))return 'Penyimpanan polygon belum disiapkan di database. Jalankan file supabase/storage-migration.sql sekali di SQL Editor, lalu unggah ulang polygon.';
  const parts=[error.message,error.details,error.hint,error.code?`Kode ${error.code}`:''].filter(Boolean);
  return parts.join(' — ')||String(error);
}

const citySelect = document.getElementById('citySelect');
const surveyorSelect = document.getElementById('surveyorSelect');
const TARGET_SAMPLES_PER_ZONE = 3;
const statusLine = document.getElementById('statusLine');
let loadingTimer=null;
let loadingStartedAt=0;
let loadingMessage='';
function beginLoading(message){
  clearInterval(loadingTimer);loadingStartedAt=Date.now();setLoadingStatus(message);
  loadingTimer=setInterval(()=>{const seconds=Math.floor((Date.now()-loadingStartedAt)/1000);statusLine.textContent=`${loadingMessage} (${seconds} dtk)`;},1000);
}
function setLoadingStatus(message){loadingMessage=message;statusLine.dataset.loading='true';statusLine.textContent=message;}
function endLoading(){clearInterval(loadingTimer);loadingTimer=null;delete statusLine.dataset.loading;}
function browserPaint(){return new Promise(resolve=>requestAnimationFrame(()=>resolve()));}
const fmtDate = value => {
  if (!value) return '';
  const [y,m,d] = value.split('-');
  return `${d}/${m}/${y}`;
};
const text = value => value == null ? '' : String(value).trim();
const keyOf = row => text(row.ident || row.sample || `${row.date}|${row.surveyor}|${row.lon}|${row.lat}`);
const idKey = value => text(value).replace(/\.0$/, '').toLocaleLowerCase('id-ID');
const unique = values => [...new Set(values.filter(v => v != null && v !== ''))];

const chooseCityOption=document.createElement('option');chooseCityOption.value='';chooseCityOption.textContent='Pilih kabupaten';chooseCityOption.disabled=true;chooseCityOption.selected=true;citySelect.append(chooseCityOption);
for (const city of [...new Set(['Bangkalan','Pamekasan','Sampang','Sumenep',...Object.keys(rowsByCity)])].sort()) {
  if (!rowsByCity[city]) rowsByCity[city]=[];
  const option = document.createElement('option'); option.value = city; option.textContent = city; citySelect.append(option);
}
const allCityOption=document.createElement('option');allCityOption.value='ALL';allCityOption.textContent='ALL';citySelect.append(allCityOption);
citySelect.value='';

const mapAvailable = typeof L !== 'undefined';
let map;
let mapSelectedSurveyor='';
let userLocationMarker=null;
let userLocationAccuracy=null;
if (mapAvailable) {
  map = L.map('map', { zoomControl: true, preferCanvas:true }).setView([-7.05,113.7], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markerLayer = L.layerGroup();
  markerLayer.addTo(map);
  const locateControl=L.control({position:'topright'});
  locateControl.onAdd=()=>{
    const container=L.DomUtil.create('div','leaflet-bar leaflet-control locate-control');
    const button=L.DomUtil.create('button','locate-button',container);
    button.type='button';button.title='Tampilkan lokasi saya';button.setAttribute('aria-label','Tampilkan lokasi saya');
    button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v3m0 14v3M2 12h3m14 0h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg>';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(button,'click',L.DomEvent.stop).on(button,'click',locateCurrentUser);
    return container;
  };
  locateControl.addTo(map);
  let allMarkersVisible=map.getZoom()>=10;
  map.on('zoomend',()=>{
    if(!mapIsAllView)return;
    const visible=map.getZoom()>=10;
    if(visible===allMarkersVisible)return;
    allMarkersVisible=visible;
    drawSampleMarkers(mapRowsForRender,true,mapSelectedSurveyor);
  });
}

function locateCurrentUser(){
  if(!navigator.geolocation){statusLine.textContent='Browser ini tidak mendukung akses lokasi.';return;}
  statusLine.textContent='Meminta izin lokasi dari browser…';
  navigator.geolocation.getCurrentPosition(position=>{
    const {latitude,longitude,accuracy}=position.coords;
    const location=[latitude,longitude];
    if(userLocationMarker)userLocationMarker.setLatLng(location);
    else userLocationMarker=L.marker(location,{icon:L.divIcon({className:'user-location-marker',html:'<span></span>',iconSize:[22,22],iconAnchor:[11,11]}),keyboard:true,title:'Lokasi saya'}).addTo(map);
    if(userLocationAccuracy)userLocationAccuracy.setLatLng(location).setRadius(accuracy);
    else userLocationAccuracy=L.circle(location,{radius:accuracy,color:'#2563EB',weight:1,fillColor:'#60A5FA',fillOpacity:.12,interactive:false}).addTo(map);
    userLocationMarker.bindPopup(`Lokasi Anda<br>Akurasi sekitar ${Math.round(accuracy)} m`);
    map.flyTo(location,Math.max(map.getZoom(),15),{duration:.7});
    statusLine.textContent=`Lokasi Anda ditampilkan pada peta (akurasi sekitar ${Math.round(accuracy)} m).`;
  },error=>{
    const message=error.code===1?'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser.':error.code===2?'Lokasi tidak tersedia. Pastikan layanan lokasi perangkat aktif.':'Permintaan lokasi melewati batas waktu. Coba tekan tombol lokasi lagi.';
    statusLine.textContent=message;
  },{enableHighAccuracy:true,timeout:20000,maximumAge:30000});
}

function currentRows() {
  if(!citySelect.value)return [];
  if(citySelect.value!=='ALL')return rowsByCity[citySelect.value]||[];
  return districtNames().flatMap(city=>(rowsByCity[city]||[]).map(row=>({...row,_city:city,zone:row.zone?`${city} • ${row.zone}`:row.zone})));
}
function combinedDistrictGeo(){
  const features=[];
  for(const city of districtNames())for(const feature of (geoOverviewByCity[city]||geoByCity[city])?.features||[]){
    const zone=featureZone(feature);
    features.push({...feature,properties:{...(feature.properties||{}),_progress_zone:zone==null?null:`${city} • ${zone}`}});
  }
  return {type:'FeatureCollection',features};
}
function geoForSurveyor(geo,surveyor){
  if(!geo||!surveyor)return geo;
  const assigned=(geo.features||[]).some(feature=>Array.isArray(feature.properties?._zone_surveyors));
  if(!assigned)return geo;
  return {...geo,features:(geo.features||[]).filter(feature=>feature.properties?._zone_surveyors?.includes(surveyor))};
}
function allDates(rows) { return unique(rows.map(r => r.date)).sort(); }
function rebuildFilters() {
  const rows = currentRows();
  const city=citySelect.value;
  const geo=city==='ALL'?combinedDistrictGeo():geoByCity[city];
  const assigned=(geo?.features||[]).flatMap(feature=>Array.isArray(feature.properties?._zone_surveyors)?feature.properties._zone_surveyors:[]);
  const oldPerson = surveyorSelect.value; surveyorSelect.replaceChildren();
  const everybody=document.createElement('option'); everybody.value=''; everybody.textContent='Semua surveyor'; surveyorSelect.append(everybody);
  for (const person of unique([...rows.map(r=>r.surveyor),...assigned]).sort((a,b)=>a.localeCompare(b,'id'))) { const o=document.createElement('option'); o.value=person; o.textContent=person; surveyorSelect.append(o); }
  if ([...surveyorSelect.options].some(o=>o.value===oldPerson)) surveyorSelect.value=oldPerson;
}

function dedupPoints(rows) {
  const seen=new Map();
  for (const r of rows) {const key=r._city?`${r._city}\u0000${keyOf(r)}`:keyOf(r);if (!seen.has(key)) seen.set(key,r);}
  return [...seen.values()];
}

function calculate(rows, threshold, knownZones=null) {
  const byZone=new Map();
  for (const r of rows) {
    if (!r.zone || !r.date) continue;
    const zk=idKey(r.zone);
    if(knownZones&&!knownZones.has(zk))continue;
    if (!byZone.has(zk)) byZone.set(zk,new Map());
    const samples=byZone.get(zk),sampleKey=keyOf(r),existing=samples.get(sampleKey);
    if(!existing||r.date<existing.date)samples.set(sampleKey,r);
  }
  const completed=new Set(); const awards=new Map(); const zoneSampleCounts=new Map(); const individualZones=new Set();
  for(const row of rows){
    if(!row.zone)continue;
    const kind=propertyValue(row.properties,['JENIS_DATA','JENISDATA']);
    if(kind!=null&&normalizedField(kind)==='individual')individualZones.add(idKey(row.zone));
  }
  for (const [zone, uniqueSamples] of byZone) {
    const byDay=new Map();
    for(const row of uniqueSamples.values()){
      if(!byDay.has(row.date))byDay.set(row.date,new Map());
      byDay.get(row.date).set(keyOf(row),row);
    }
    zoneSampleCounts.set(zone,uniqueSamples.size);
    let total=0; let already=false;
    for (const [day, samples] of [...byDay.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
      total += samples.size;
      if (!already && total >= threshold) {
        already=true; completed.add(zone);
        const persons=unique([...samples.values()].map(r=>r.surveyor));
        const owner=persons.length===1 ? persons[0] : 'Kolaborasi';
        const k=`${day}\u0000${owner}`; awards.set(k,(awards.get(k)||0)+1);
      }
    }
  }
  return {completed, awards, zoneSampleCounts, individualZones, zoneCount:knownZones ? knownZones.size : byZone.size};
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

function renderZoneSampleList(geo, calculation) {
  const table=document.getElementById('zoneSampleTable');
  const hint=document.getElementById('zoneListHint');
  table.replaceChildren();
  const thead=document.createElement('thead');
  const headRow=document.createElement('tr');
  const sortColumns=[['zone','Zona (NOZN)'],['count','Jumlah sampel'],['status','Status'],['individual','Individual']];
  for(const [key,label] of sortColumns){
    const th=document.createElement('th');th.setAttribute('aria-sort',zoneListSort.key===key?(zoneListSort.direction==='asc'?'ascending':'descending'):'none');
    const button=document.createElement('button');button.type='button';button.className='zone-sort-button';button.dataset.zoneSort=key;
    button.textContent=`${label}${zoneListSort.key===key?(zoneListSort.direction==='asc'?' ↑':' ↓'):' ↕'}`;th.append(button);headRow.append(th);
  }
  thead.append(headRow);table.append(thead);
  const tbody=document.createElement('tbody');
  const features=(geo?.features||[]).filter(feature=>featureZone(feature)!=null);
  const zones=new Map();
  for(const feature of features){const value=String(featureZone(feature));const id=idKey(value);if(!zones.has(id))zones.set(id,value);}
  const compareZone=(a,b)=>a[1].localeCompare(b[1],'id',{numeric:true,sensitivity:'base'});
  const ordered=[...zones.entries()].sort((a,b)=>{
    let comparison=0;
    if(zoneListSort.key==='count')comparison=(calculation.zoneSampleCounts.get(a[0])||0)-(calculation.zoneSampleCounts.get(b[0])||0);
    else if(zoneListSort.key==='status')comparison=Number((calculation.zoneSampleCounts.get(a[0])||0)>=TARGET_SAMPLES_PER_ZONE)-Number((calculation.zoneSampleCounts.get(b[0])||0)>=TARGET_SAMPLES_PER_ZONE);
    else if(zoneListSort.key==='individual')comparison=Number(calculation.individualZones.has(a[0]))-Number(calculation.individualZones.has(b[0]));
    else comparison=compareZone(a,b);
    if(!comparison&&zoneListSort.key!=='zone')comparison=compareZone(a,b);
    return comparison*(zoneListSort.direction==='asc'?1:-1);
  });
  hint.textContent=`${ordered.length.toLocaleString('id-ID')} zona • Target 3 sampel per zona • Klik baris untuk zoom ke peta.`;
  for(const [id,value] of ordered){
    const count=calculation.zoneSampleCounts.get(id)||0;
    const done=count>=TARGET_SAMPLES_PER_ZONE;
    const row=document.createElement('tr');
    const zoneCell=document.createElement('td');
    const button=document.createElement('button');button.type='button';button.className='zone-link';button.dataset.zoneId=id;button.textContent=`Zona ${value}`;button.setAttribute('aria-label',`Zoom ke zona ${value}, ${count} sampel`);zoneCell.append(button);
    const countCell=document.createElement('td');countCell.textContent=count.toLocaleString('id-ID');
    const statusCell=document.createElement('td');statusCell.textContent=done?'Tercapai':'Belum tercapai';statusCell.className=done?'zone-done':'zone-pending';
    const individualCell=document.createElement('td');const hasIndividual=calculation.individualZones.has(id);individualCell.textContent=hasIndividual?'Ya':'Tidak';individualCell.className=hasIndividual?'zone-done':'zone-no';
    row.append(zoneCell,countCell,statusCell,individualCell);tbody.append(row);
  }
  if(!ordered.length){const row=document.createElement('tr');const cell=document.createElement('td');cell.colSpan=4;cell.textContent='Polygon zona belum tersedia atau atribut NOZN tidak ditemukan.';row.append(cell);tbody.append(row);}
  table.append(tbody);
}

function zoomToZone(id) {
  const layers=zoneLayersById.get(id)||[];
  if(!layers.length&&mapIsAllView&&geoForCurrentMap){
    const feature=(geoForCurrentMap.features||[]).find(item=>idKey(featureZone(item))===id);
    const bounds=geometryBounds(feature?.geometry);
    if(bounds){selectedZoneId=id;map.fitBounds([[bounds[1],bounds[0]],[bounds[3],bounds[2]]],{maxZoom:16});polygonLayer?.setStyle(featureItem=>{const key=idKey(featureZone(featureItem));const done=currentCalculation?.completed.has(key);return {color:key===selectedZoneId?THEME_COLORS.primary:done?THEME_COLORS.secondary:THEME_COLORS.light,weight:.7,fillColor:done?THEME_COLORS.secondary:THEME_COLORS.pale,fillOpacity:.24};});}
    return;
  }
  if(!layers.length)return;
  selectedZoneId=id;
  const bounds=layers.map(layer=>layer.getBounds()).filter(bound=>bound?.isValid());
  if(!bounds.length)return;
  let combined=bounds[0];for(const bound of bounds.slice(1))combined=combined.extend(bound);
  map.fitBounds(combined.pad(.12),{maxZoom:16});
  layers[0].openPopup();
  polygonLayer?.setStyle(feature=>{
    const zone=featureZone(feature);const key=zone==null?'':idKey(zone);const done=zone!=null&&currentCalculation?.completed.has(key);
    return {color:key===selectedZoneId?THEME_COLORS.primary:done?THEME_COLORS.secondary:THEME_COLORS.light,weight:key===selectedZoneId?3:1.4,fillColor:done?THEME_COLORS.secondary:THEME_COLORS.pale,fillOpacity:.38};
  });
}

function featureZone(feature) {
  const p=feature.properties||{};
  if(p._progress_zone!=null&&p._progress_zone!=='')return p._progress_zone;
  return propertyValue(p,['NOZN','NO_ZN','NO_ZONA','ZONE','ID_ZONA','ZONA']);
}

function normalizedField(value) { return String(value||'').toLocaleLowerCase('id-ID').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,''); }
function propertyValue(properties,aliases) {
  const entries=Object.entries(properties||{}).filter(([,value])=>value!=null&&String(value).trim()!==''); const keys=aliases.map(normalizedField);
  for(const alias of keys){const found=entries.find(([name])=>normalizedField(name)===alias);if(found)return found[1];}
  for(const alias of keys){if(alias.length<6)continue;const found=entries.find(([name])=>normalizedField(name).startsWith(alias));if(found)return found[1];}
  for(const alias of keys){const found=entries.find(([name])=>normalizedField(name).length>=6&&alias.startsWith(normalizedField(name)));if(found)return found[1];}
  return null;
}
function landValueFromProperties(properties) {
  const direct=propertyValue(properties,['NILAI_TANAH','NILAI TANAH','NILAI_TANA','NILAI TANA','NILAI_TAN','NILAI_ZNT','NILAI_TANAH_PER_M2','NILAI_TANAH_M2','NILAI_TANAH_M²','NILAI TANAH /M²','NILAI_TNH','LAND_VALUE','NILAI']);
  if(direct!=null)return direct;
  return Object.entries(properties||{}).find(([name,value])=>{
    const key=normalizedField(name);
    return value!=null&&String(value).trim()!==''&&key.includes('nilai')&&(key.includes('tanah')||key.startsWith('nilaita'));
  })?.[1]??null;
}
function landValueForSample(row) {
  const fromSample=landValueFromProperties(row.properties);
  if(fromSample!=null)return fromSample;
  const city=row._city||(citySelect.value==='ALL'?'':citySelect.value);
  let rawZone=String(row.zone??'');
  const prefix=city?`${city} • `:'';
  if(prefix&&rawZone.startsWith(prefix))rawZone=rawZone.slice(prefix.length);
  const zone=idKey(rawZone);
  if(!zone)return null;
  const geo=geoByCity[city];
  if(!geo)return null;
  let index=zonePropertiesCache.get(geo);
  if(!index){index=new Map();for(const feature of geo.features||[]){const id=featureZone(feature);if(id!=null&&!index.has(idKey(id)))index.set(idKey(id),feature.properties||{});}zonePropertiesCache.set(geo,index);}
  return landValueFromProperties(index.get(zone));
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
function geometryBounds(geometry){
  const bounds=[Infinity,Infinity,-Infinity,-Infinity];const stack=[geometry?.coordinates];
  while(stack.length){
    const current=stack.pop();if(!Array.isArray(current))continue;
    if(typeof current[0]==='number'&&typeof current[1]==='number'){
      bounds[0]=Math.min(bounds[0],current[0]);bounds[1]=Math.min(bounds[1],current[1]);bounds[2]=Math.max(bounds[2],current[0]);bounds[3]=Math.max(bounds[3],current[1]);
    }else for(const child of current)stack.push(child);
  }
  return Number.isFinite(bounds[0])?bounds:null;
}
function zoneSpatialIndex(geo){
  if(!geo||typeof geo!=='object')return [];
  if(zoneIndexCache.has(geo))return zoneIndexCache.get(geo);
  const index=(geo.features||[]).map(feature=>({feature,zone:featureZone(feature),bounds:geometryBounds(feature.geometry)})).filter(item=>item.zone!=null&&item.bounds);
  zoneIndexCache.set(geo,index);return index;
}
function zonesAtPoint(lon,lat,geo) {
  if(!geo)return [];
  return unique(zoneSpatialIndex(geo).filter(item=>lon>=item.bounds[0]&&lon<=item.bounds[2]&&lat>=item.bounds[1]&&lat<=item.bounds[3]&&pointInPolygonGeometry([lon,lat],item.feature.geometry)).map(item=>String(item.zone)));
}
async function reassignSpatialRows(city,geo) {
  const rows=rowsByCity[city]||[]; const kept=rows.filter(r=>r.zoneSource!=='spatial');
  const spatial=rows.filter(r=>r.zoneSource==='spatial'); const points=new Map();
  for(const r of spatial)if(!points.has(`${r.date}\u0000${keyOf(r)}`))points.set(`${r.date}\u0000${keyOf(r)}`,r);
  const uniquePoints=[...points.values()];
  for(let index=0;index<uniquePoints.length;index++){
    const r=uniquePoints[index];
    const zones=zonesAtPoint(Number(r.lon),Number(r.lat),geo);
    if(!zones.length)kept.push({...r,zone:''}); else for(const zone of zones)kept.push({...r,zone});
    if((index+1)%100===0||index===uniquePoints.length-1){
      setLoadingStatus(`Mencocokkan titik sampel ke zona… ${Math.round((index+1)/uniquePoints.length*100)}%`);
      await browserPaint();
    }
  }
  rowsByCity[city]=mergeRows([],kept);
}
function mergeRows(existing,incoming) {
  const result=new Map();
  for(const r of [...existing,...incoming]){
    const k=`${r.date}\u0000${keyOf(r)}\u0000${idKey(r.zone)}`;
    result.set(k,r);
  }
  return [...result.values()];
}

function renderMap(rows, calculation, geoOverride, markerRows=rows, selectedSurveyor='') {
  if (!mapAvailable) { document.getElementById('mapHint').textContent='Peta perlu koneksi internet untuk memuat pustaka peta.'; return; }
  currentCalculation=calculation;
  zoneLayersById=new Map();
  mapRowsForRender=markerRows;mapSelectedSurveyor=selectedSurveyor;mapIsAllView=citySelect.value==='ALL';
  if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer=null; }
  const geo=geoOverride===undefined?geoByCity[citySelect.value]:geoOverride;
  geoForCurrentMap=geo;
  let polygonCount=0;
  if (geo) {
    polygonLayer=L.geoJSON(geo,{smoothFactor:2,
      filter: feature => ['Polygon','MultiPolygon'].includes(feature.geometry?.type),
      style: feature => {
        const z=featureZone(feature); const id=z==null?'':idKey(z); const done=z!=null&&calculation.completed.has(id);
        return {color:id===selectedZoneId?THEME_COLORS.primary:done?THEME_COLORS.secondary:THEME_COLORS.light,weight:mapIsAllView ? .7 : 1.4,fillColor:done?THEME_COLORS.secondary:THEME_COLORS.pale,fillOpacity:mapIsAllView ? .24 : .38};
      },
      onEachFeature: mapIsAllView?undefined:(feature,layer) => {
        const z=featureZone(feature); const id=z==null?'':idKey(z); const done=z!=null&&calculation.completed.has(id);
        const n=z==null?0:(calculation.zoneSampleCounts.get(id)||0);
        if(id){if(!zoneLayersById.has(id))zoneLayersById.set(id,[]);zoneLayersById.get(id).push(layer);}
        layer.bindPopup(`<b>Zona ${escapeHtml(z)}</b><br>Sampel terkumpul: ${n}<br>Status: ${done?'Target tercapai':'Belum tercapai'}`);
      }
    }).addTo(map);
    polygonCount=geo.features?.length||0;
  }
  const shown=dedupPoints(markerRows).filter(r=>r.lon!=null&&r.lat!=null&&r.lon!==''&&r.lat!==''&&Number.isFinite(Number(r.lon))&&Number.isFinite(Number(r.lat)));
  if (shouldFit) {
    const bounds=[];
    if (polygonLayer && polygonCount) { try { bounds.push(polygonLayer.getBounds()); } catch (_) {} }
    if (shown.length) bounds.push(L.latLngBounds(shown.map(r=>[Number(r.lat),Number(r.lon)])));
    if (bounds.length) { let b=bounds[0]; for (const x of bounds.slice(1)) b=b.extend(x); map.fitBounds(b.pad(.08),{maxZoom:mapIsAllView?9:14}); }
    shouldFit=false;
  }
  drawSampleMarkers(markerRows,mapIsAllView,selectedSurveyor);
  document.getElementById('mapHint').textContent=`${mapIsAllView&&map.getZoom()<10?`${shown.length.toLocaleString('id-ID')} titik disembunyikan saat zoom jauh; perbesar untuk melihat sampel`: `${shown.length.toLocaleString('id-ID')} titik sampel ditampilkan`}${geo?` • ${polygonCount} polygon`:' • polygon belum dimuat'}.`;
}

function drawSampleMarkers(rows,allView=false,selectedSurveyor=''){
  if(!markerLayer)return;
  markerLayer.clearLayers();
  const points=dedupPoints(rows).filter(r=>r.lon!=null&&r.lat!=null&&r.lon!==''&&r.lat!==''&&Number.isFinite(Number(r.lon))&&Number.isFinite(Number(r.lat))&&Math.abs(Number(r.lon))<=180&&Math.abs(Number(r.lat))<=90);
  if(allView&&map.getZoom()<10){document.getElementById('mapHint').textContent=`${points.length.toLocaleString('id-ID')} titik disembunyikan saat zoom jauh; perbesar untuk melihat sampel.`;return;}
  for(const r of points){
    const kind=propertyValue(r.properties,['JENIS_DATA','JENISDATA']);
    const isIndividual=kind!=null&&normalizedField(kind)==='individual';
    const isOtherSurveyor=Boolean(selectedSurveyor)&&r.surveyor!==selectedSurveyor;
    const marker=L.circleMarker([Number(r.lat),Number(r.lon)],{radius:5,color:'#fff',weight:1,fillColor:isOtherSurveyor?'#EC4899':isIndividual?THEME_COLORS.primary:THEME_COLORS.secondary,fillOpacity:.95});
    marker.bindPopup(()=>{
      const dataKind=propertyValue(r.properties,['JENIS_DATA','JENISDATA']);
      const price=propertyValue(r.properties,['HARGA','HARGA_TANAH','HARGA_ZNT','PRICE']);
      const landValue=landValueForSample(r);
      const area=propertyValue(r.properties,['LUAS','LUAS_TANAH','LUAS_BIDANG','LUAS_M2','AREA','AREA_M2','SHAPE_AREA']);
      return `<b>Titik sampel</b><br>No. sampel: ${escapeHtml(r.sample)}<br>Zona: ${escapeHtml(r.zone)}<br>Surveyor: ${escapeHtml(r.surveyor)}<br>Tanggal: ${escapeHtml(fmtDate(r.date))}<br>Jenis data: ${escapeHtml(dataKind==null||dataKind===''?'-':dataKind)}<br>Harga: ${escapeHtml(price==null||price===''?'-':price)}<br>Nilai tanah: ${escapeHtml(landValue==null||landValue===''?'-':landValue)}<br>Luas: ${escapeHtml(area==null||area===''?'-':area)}`;
    });
    markerLayer.addLayer(marker);
  }
  if(allView)document.getElementById('mapHint').textContent=`${points.length.toLocaleString('id-ID')} titik sampel ditampilkan pada zoom ${map.getZoom()}.`;
}

function escapeHtml(value) { return String(value==null?'':value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

function reportTableData(tableId){
  return [...document.querySelectorAll(`#${tableId} tr`)].map((row,rowIndex)=>[...row.cells].map((cell,columnIndex)=>{
    if(columnIndex===0||rowIndex===0)return rowIndex===0&&columnIndex>0?(cell.title||cell.textContent):cell.textContent;
    return Number(cell.textContent)||0;
  }));
}
function zoneSampleReportData(){
  return [...document.querySelectorAll('#zoneSampleTable tr')].map((row,rowIndex)=>[...row.cells].map((cell,columnIndex)=>{
    const sortButton=cell.querySelector('button[data-zone-sort]');
    if(sortButton)return sortButton.textContent.replace(/[↑↓↕]/g,'').trim();
    const zoneButton=cell.querySelector('button[data-zone-id]');
    if(zoneButton)return zoneButton.textContent.replace(/^Zona\s+/,'');
    if(rowIndex>0&&columnIndex===1)return Number(cell.textContent)||0;
    return cell.textContent;
  }));
}
function downloadAchievementWorkbook(){
  if(!window.XLSX){alert('Pustaka Excel belum termuat. Muat ulang halaman lalu coba lagi.');return;}
  const workbook=XLSX.utils.book_new();
  const zoneSampleSheet=XLSX.utils.aoa_to_sheet(zoneSampleReportData());
  const zoneSheet=XLSX.utils.aoa_to_sheet(reportTableData('zoneTable'));
  const sampleSheet=XLSX.utils.aoa_to_sheet(reportTableData('sampleTable'));
  zoneSampleSheet['!cols']=[{wch:20},{wch:18},{wch:20},{wch:16}];
  zoneSheet['!cols']=[{wch:24},...Array(Math.max(0,(zoneSheet['!ref']?XLSX.utils.decode_range(zoneSheet['!ref']).e.c:0))).fill({wch:14})];
  sampleSheet['!cols']=[{wch:24},...Array(Math.max(0,(sampleSheet['!ref']?XLSX.utils.decode_range(sampleSheet['!ref']).e.c:0))).fill({wch:14})];
  XLSX.utils.book_append_sheet(workbook,zoneSampleSheet,'Jumlah Sampel Zona');
  XLSX.utils.book_append_sheet(workbook,zoneSheet,'Zona Tercapai');
  XLSX.utils.book_append_sheet(workbook,sampleSheet,'Sampel Tercapai');
  const date=new Date().toISOString().slice(0,10);
  XLSX.writeFile(workbook,`Rekap_${citySelect.value}_${date}.xlsx`);
}

function update() {
  const city=citySelect.value; const isAll=city==='ALL'; const selectedPerson=surveyorSelect.value;
  document.getElementById('adminCityName').textContent=city||'Belum dipilih';
  const threshold=TARGET_SAMPLES_PER_ZONE;
  const source=currentRows();
  const filtered=source.filter(r=>!selectedPerson||r.surveyor===selectedPerson);
  const allGeo=isAll?combinedDistrictGeo():geoByCity[city];
  const geo=geoForSurveyor(allGeo,selectedPerson);
  // Dashboard zone totals must come from uploaded polygons, not sample rows.
  const knownZones=new Set(geo?unique((geo.features||[]).map(featureZone).filter(v=>v!=null).map(idKey)):[]);
  const calc=calculate(filtered,threshold,knownZones);
  const zoneCalc=calculate(source,threshold,knownZones);
  const points=dedupPoints(filtered); const people=selectedPerson?[selectedPerson]:unique(source.map(r=>r.surveyor)).sort((a,b)=>a.localeCompare(b,'id'));
  const dates=allDates(filtered);
  const hasAssignedZones=(allGeo?.features||[]).some(feature=>Array.isArray(feature.properties?._zone_surveyors));
  document.getElementById('zonesTotalLabel').textContent=selectedPerson&&hasAssignedZones?`Zona milik ${selectedPerson}`:'Total zona keseluruhan';
  document.getElementById('zonesTotalHint').textContent=selectedPerson&&hasAssignedZones?'Jumlah zona sesuai surveyor terpilih':'Polygon kabupaten terpilih';
  document.getElementById('zonesTotal').textContent=calc.zoneCount.toLocaleString('id-ID');
  document.getElementById('zonesDone').textContent=zoneCalc.completed.size.toLocaleString('id-ID');
  document.getElementById('zonesLeft').textContent=Math.max(0,zoneCalc.zoneCount-zoneCalc.completed.size).toLocaleString('id-ID');
  document.getElementById('zonesRatio').textContent=!allGeo?'Polygon belum dimuat':selectedPerson&&hasAssignedZones?`zona tanggung jawab ${selectedPerson}`:`dari ${zoneCalc.zoneCount.toLocaleString('id-ID')} zona keseluruhan`;
  document.getElementById('sampleCount').textContent=points.length.toLocaleString('id-ID');
  document.getElementById('samplePeriod').textContent='Semua tanggal';
  const sampleTarget=calc.zoneCount*threshold;
  const sampleProgress=sampleTarget?Math.min(100,Math.round(points.length/sampleTarget*100)):0;
  document.getElementById('sampleProgressPercent').textContent=`${sampleProgress}%`;
  document.getElementById('sampleProgressHint').textContent=`${points.length.toLocaleString('id-ID')} dari ${sampleTarget.toLocaleString('id-ID')} target sampel`;
  const pct=zoneCalc.zoneCount?Math.round(zoneCalc.completed.size/zoneCalc.zoneCount*100):0;
  document.getElementById('progressPercent').textContent=`${pct}%`;
  document.getElementById('surveyorCount').textContent=selectedPerson?'1':unique(source.map(r=>r.surveyor)).length;
  document.getElementById('surveyorHint').textContent=selectedPerson||'Pada kabupaten terpilih';
  document.getElementById('progressHint').textContent=`Target tetap ${threshold} sampel per zona`;
  // Daily zone awards use the complete dataset even when the map's surveyor
  // filter is active; otherwise each surveyor would be incorrectly evaluated
  // as if they had collected every sample alone.
  const awardCalc=zoneCalc;
  const awardDates=allDates(source);
  const awardPeople=unique(source.map(r=>r.surveyor)).sort((a,b)=>a.localeCompare(b,'id'));
  const hasCollaboration=[...awardCalc.awards.keys()].some(k=>k.endsWith('\u0000Kolaborasi'));
  const displayedZonePeople=unique([...awardPeople,...(hasCollaboration?['Kolaborasi']:[])]);
  renderTable('zoneTable','zona',awardDates,displayedZonePeople,(d,p)=>awardCalc.awards.get(`${d}\u0000${p}`));
  const sampleCounts=new Map();
  for (const r of points) { const k=`${r.date}\u0000${r.surveyor}`; sampleCounts.set(k,(sampleCounts.get(k)||0)+1); }
  renderTable('sampleTable','sampel',dates,people,(d,p)=>sampleCounts.get(`${d}\u0000${p}`));
  renderZoneSampleList(geo,zoneCalc);
  renderMap(filtered,zoneCalc,geo,selectedPerson?source:filtered,selectedPerson);
  document.getElementById('otherSurveyorLegend').hidden=!selectedPerson;
  if(isAll){
    const missing=districtNames().filter(name=>remoteZoneMetadata.has(name)&&remoteZoneMetadata.get(name)?._storage_path&&!remoteZoneMetadata.get(name)?._overview_path);
    if(missing.length)document.getElementById('mapHint').textContent=`Tampilan ALL ringan: polygon ringkas belum disiapkan untuk ${missing.join(', ')}. Admin dapat memilih kabupaten tersebut lalu menekan “Siapkan polygon ringkas ALL”.`;
  }
  const geoNote=isAll?`${districtNames().length} kabupaten dalam tampilan gabungan.`:geoByCity[city]?'Polygon dimuat.':'Belum ada polygon GeoJSON untuk kabupaten ini.';
  statusLine.innerHTML=city?`Data <strong>${escapeHtml(city)}</strong>: ${source.length.toLocaleString('id-ID')} baris valid • ${geoNote}`:'Pilih kabupaten untuk memuat polygon dan titik sampel.';
  if(!city)document.getElementById('mapHint').textContent='Pilih kabupaten untuk menampilkan polygon dan titik sampel.';
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
function namedShapefileCollections(parsed,archiveName=''){
  if(parsed?.type==='FeatureCollection'||parsed?.type==='Feature'){
    const name=String(parsed.fileName||archiveName).split(/[\\/]/).pop().replace(/\.(zip|shp)$/i,'');
    return [[name,featureCollection(parsed)]];
  }
  const entries=Array.isArray(parsed)?parsed.map((item,index)=>[item?.fileName||item?.name||`Layer ${index+1}`,item]):Object.entries(parsed||{});
  return entries.filter(([,value])=>value?.type==='FeatureCollection'||value?.type==='Feature').map(([name,value])=>[String(name),featureCollection(value)]);
}
function surveyorNameFromLayer(name,city){
  const basename=String(name).replaceAll('\\','/').split('/').pop().replace(/\.(shp|geojson|json)$/i,'').trim();
  const surveyor=basename.replace(/^zona[\s_-]*/i,'').trim();
  if(!surveyor||/^layer\s+\d+$/i.test(surveyor))throw new Error(`Nama file "${basename||name}" tidak dapat dipakai untuk mengenali surveyor. Beri nama seperti "ZONA Husein.shp".`);
  const existing=(rowsByCity[city]||[]).map(row=>text(row.surveyor)).find(person=>normalizedField(person)===normalizedField(surveyor));
  return existing||surveyor;
}
function combineSurveyorZones(layers){
  const byZone=new Map();
  const add=(feature,owners)=>{
    const properties={...(feature.properties||{})};
    const zone=propertyValue(properties,['NOZN','NO_ZN','NO_ZONA','ZONE','ID_ZONA','ZONA']);
    if(zone==null||String(zone).trim()==='')throw new Error('Ada polygon tanpa atribut NOZN. Pastikan semua SHP zona memiliki kolom NOZN.');
    const key=idKey(zone),existing=byZone.get(key),combinedOwners=unique([...(existing?.properties?._zone_surveyors||[]),...owners]);
    if(existing){
      existing.properties={...existing.properties};
      if(combinedOwners.length)existing.properties._zone_surveyors=combinedOwners;
      else delete existing.properties._zone_surveyors;
      return;
    }
    const mergedProperties={...properties,NOZN:zone};
    if(owners.length)mergedProperties._zone_surveyors=unique(owners);else delete mergedProperties._zone_surveyors;
    byZone.set(key,{...feature,properties:mergedProperties});
  };
  for(const {surveyor,geo} of layers){
    const polygonFeatures=(geo.features||[]).filter(feature=>['Polygon','MultiPolygon'].includes(feature.geometry?.type));
    if(!polygonFeatures.length)throw new Error(`File zona untuk ${surveyor} tidak berisi polygon.`);
    for(const feature of polygonFeatures)add(feature,[surveyor]);
  }
  if(!byZone.size)throw new Error('Tidak ada polygon zona dengan atribut NOZN.');
  return {type:'FeatureCollection',features:[...byZone.values()]};
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
      for(const zone of zones)imported.push({zone,sample:text(sample),ident:sampleId,surveyor:text(person),date,lon,lat,zoneSource:explicitZone==null?'spatial':'attribute',properties:props});
    }
  }
  return {imported,skipped,unassigned};
}

document.getElementById('shpInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if(!file)return;
  if(!citySelect.value||citySelect.value==='ALL'){alert('Pilih satu kabupaten sebelum mengunggah sampel.');event.target.value='';return;}
  try{
    beginLoading('Membaca ZIP shapefile titik…');await browserPaint();
    const geo=await readShapefile(file); const city=citySelect.value; const result=importSampleFeatures(geo,city);
    if(!result.imported.length)throw new Error('Tidak ada feature titik dengan atribut nomor sampel, surveyor, dan tanggal. Periksa isi DBF.');
    const cleanRows=mergeRows([],result.imported);
    setLoadingStatus('Mengganti data sampel lama dengan unggahan terbaru…');await saveSamples(city,cleanRows);rowsByCity[city]=cleanRows;setLoadingStatus('Memperbarui peta dan rekap…');await browserPaint();shouldFit=true; rebuildFilters(); update();
    statusLine.innerHTML=`SHP <strong>${escapeHtml(file.name)}</strong> berhasil mengganti data: ${cleanRows.length.toLocaleString('id-ID')} titik; ${result.skipped} feature dilewati${result.unassigned?`; ${result.unassigned} titik belum masuk zona` : ''}.`;
  }catch(error){statusLine.textContent=`Unggah SHP sampel gagal: ${error.message||error}`;alert(`SHP tidak dapat dimuat: ${error.message||error}`);}
  finally{endLoading();event.target.value='';}
});

citySelect.addEventListener('change',async()=>{
  const city=citySelect.value;const request=++citySelectionRequest;shouldFit=true;
  let loadError='';
  selectedZoneId='';
  document.getElementById('adminCityName').textContent=city;
  if(city!=='ALL')try{localStorage.setItem('progress-selected-city',city);}catch{}
  if(supabaseClient&&city==='ALL'){
    beginLoading('Menyiapkan tampilan gabungan…');
    try{await loadAllRemoteCities(request);}catch(error){loadError=`Tampilan ALL belum lengkap: ${error.message||error}`;}
    finally{if(request===citySelectionRequest)endLoading();}
  }else if(supabaseClient&&!remoteFullGeoLoaded.has(city)){
    beginLoading(`Memuat polygon dan sampel ${city}…`);
    try{await loadRemoteCity(city);}catch(error){loadError=`Data ${city} belum dapat dimuat: ${error.message||error}`;}
    finally{if(request===citySelectionRequest)endLoading();}
  }
  if(request!==citySelectionRequest)return;
  rebuildFilters();update();
  if(loadError)statusLine.textContent=loadError;
});
surveyorSelect.addEventListener('change',update);
document.getElementById('excelInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if(!file)return;
  if(!citySelect.value||citySelect.value==='ALL'){alert('Pilih satu kabupaten sebelum mengunggah sampel.');event.target.value='';return;}
  try {
    beginLoading('Membaca file Excel…');await browserPaint();
    if(!window.XLSX)throw new Error('Pustaka Excel tidak termuat. Periksa koneksi internet lalu muat ulang halaman.');
    const wb=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});
    const required=['NOZN','Nomor Sampel','Nama Surveyor','Tanggal Pelaksanaan']; let raw=null;
    for(const sheetName of wb.SheetNames){const data=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{defval:null}); if(data.length&&required.every(k=>Object.keys(normalizeHeader(data[0])).includes(k.toLowerCase()))) {raw=data;break;}}
    if(!raw)throw new Error('Kolom wajib tidak ditemukan: NOZN, Nomor Sampel, Nama Surveyor, dan Tanggal Pelaksanaan.');
    const imported=[];
    for(const row of raw){const r=normalizeHeader(row); const sample=getField(r,['Nomor Sampel','No Sampel']); const surveyor=getField(r,['Nama Surveyor','Surveyor']); const date=normalizeDate(getField(r,['Tanggal Pelaksanaan','Tanggal'])); if(sample==null||!surveyor||!date)continue;
      const x=getField(r,['X','Longitude','Lon']), y=getField(r,['Y','Latitude','Lat']);
      imported.push({zone:text(getField(r,['NOZN','NO ZN','NO ZONA'])),sample:text(sample),ident:text(getField(r,['Nomor Identifikasi','ID Sampel']))||text(sample),surveyor:text(surveyor),date,lon:x==null||x===''?null:Number(x),lat:y==null||y===''?null:Number(y),zoneSource:'attribute',properties:row});
    }
    if(!imported.length)throw new Error('Tidak ada baris sampel dengan tanggal dan surveyor yang valid.');
    const city=citySelect.value;const cleanRows=mergeRows([],imported);
    setLoadingStatus('Mengganti data sampel lama dengan unggahan terbaru…');await saveSamples(city,cleanRows);rowsByCity[city]=cleanRows;setLoadingStatus('Memperbarui peta dan rekap…');await browserPaint();
    shouldFit=true; rebuildFilters(); update(); statusLine.innerHTML=`Excel untuk <strong>${escapeHtml(city)}</strong> berhasil mengganti data: ${cleanRows.length.toLocaleString('id-ID')} baris.`;
  }catch(error){statusLine.textContent=`Impor Excel gagal: ${error.message||error}`;alert(error.message||String(error));}
  finally{endLoading();event.target.value='';}
});
let zoneUploadMode='overall';
const geoInput=document.getElementById('geoInput');
const zoneUploadDialog=document.getElementById('zoneUploadDialog');
document.getElementById('geoUploadButton').addEventListener('click',()=>zoneUploadDialog.showModal());
zoneUploadDialog.addEventListener('click',event=>{
  const modeButton=event.target.closest('[data-zone-upload-mode]');
  if(modeButton){
    zoneUploadMode=modeButton.dataset.zoneUploadMode;
    geoInput.accept=zoneUploadMode==='surveyor'?'.zip,application/zip':'.zip,.geojson,.json,application/zip,application/geo+json';
    zoneUploadDialog.close();geoInput.click();return;
  }
  if(event.target.closest('[data-zone-upload-cancel]'))zoneUploadDialog.close();
});
geoInput.addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if(!file)return;
  if(!citySelect.value||citySelect.value==='ALL'){alert('Pilih satu kabupaten sebelum mengunggah zona.');event.target.value='';return;}
  let polygonSaved=false;let city='';let previousGeo=null;let previousRows=null;
  try{
    city=citySelect.value;
    if(zoneUploadMode==='surveyor'){
      if(!file.name.toLowerCase().endsWith('.zip'))throw new Error('Mode zona per surveyor memerlukan satu ZIP yang berisi beberapa SHP polygon.');
      previousGeo=geoByCity[city]||null;
      if(supabaseClient&&!geoByCity[city]){setLoadingStatus(`Memuat zona tersimpan ${city} sebelum penggantian…`);await browserPaint();await loadRemoteCity(city);previousGeo=geoByCity[city]||null;}
      previousRows=rowsByCity[city]||[];
      beginLoading('Membaca ZIP zona per surveyor…');await browserPaint();
      if(typeof window.shp!=='function')throw new Error('Pembaca SHP belum termuat. Periksa koneksi internet dan muat ulang halaman.');
      const parsed=await window.shp(await file.arrayBuffer());
      const namedLayers=namedShapefileCollections(parsed,file.name);
      if(!namedLayers.length)throw new Error('ZIP tidak berisi SHP polygon yang dapat dibaca. Pastikan setiap shapefile memiliki file .shp, .shx, .dbf, dan .prj.');
      const layers=namedLayers.map(([name,geo])=>({surveyor:surveyorNameFromLayer(name,city),geo}));
      const owners=new Set();for(const layer of layers){const key=normalizedField(layer.surveyor);if(owners.has(key))throw new Error(`Nama file ZIP memuat lebih dari satu layer untuk surveyor ${layer.surveyor}.`);owners.add(key);}
      const polygonCount=layers.reduce((total,layer)=>total+layer.geo.features.filter(feature=>['Polygon','MultiPolygon'].includes(feature.geometry?.type)).length,0);
      setLoadingStatus(`Menggabungkan ${polygonCount.toLocaleString('id-ID')} polygon dari ${layers.length} surveyor…`);await browserPaint();
      const geo=combineSurveyorZones(layers);
      geoByCity[city]=geo;setLoadingStatus('Mencocokkan titik sampel ke zona gabungan…');await browserPaint();await reassignSpatialRows(city,geo);
      setLoadingStatus('Menyimpan gabungan zona terbaru ke database…');await saveZone(city,geo);polygonSaved=true;
      shouldFit=true;rebuildFilters();update();
      setLoadingStatus('Polygon tersimpan. Menyinkronkan titik sampel…');await browserPaint();await syncSpatialSamples(city);
      statusLine.innerHTML=`Zona per surveyor untuk <strong>${escapeHtml(city)}</strong> berhasil diperbarui: ${layers.length} surveyor, ${geo.features.length.toLocaleString('id-ID')} zona unik. Seluruh zona kabupaten diganti dengan data terbaru dari ZIP.`;
    }else{
      beginLoading('Membaca ZIP shapefile zona…');await browserPaint();
      let geo;
      if(file.name.toLowerCase().endsWith('.zip'))geo=await readShapefile(file); else geo=featureCollection(JSON.parse(await file.text()));
      const polygonFeatures=geo.features.filter(feature=>['Polygon','MultiPolygon'].includes(feature.geometry?.type));
      if(!polygonFeatures.length)throw new Error('File tidak berisi polygon. Unggah ZIP shapefile zona yang berisi .shp, .shx, .dbf, dan .prj.');
      geo={...geo,features:polygonFeatures};
      setLoadingStatus(`Menyiapkan ${polygonFeatures.length.toLocaleString('id-ID')} polygon zona…`);await browserPaint();
      geoByCity[city]=geo;setLoadingStatus('Mencocokkan titik sampel ke zona…');await browserPaint();await reassignSpatialRows(city,geo);
      setLoadingStatus('Mengunggah GeoJSON zona ke database…');await saveZone(city,geo);polygonSaved=true;
      shouldFit=true;rebuildFilters();update();
      setLoadingStatus('Polygon tersimpan. Menyinkronkan titik sampel…');await browserPaint();await syncSpatialSamples(city);
      statusLine.innerHTML=`Polygon untuk <strong>${escapeHtml(city)}</strong> disimpan dan ditampilkan: ${geo.features.length.toLocaleString('id-ID')} zona.`;
    }
  }
  catch(error){
    if(!polygonSaved&&zoneUploadMode==='surveyor'&&city){if(previousGeo)geoByCity[city]=previousGeo;else delete geoByCity[city];if(previousRows)rowsByCity[city]=previousRows;shouldFit=true;rebuildFilters();update();}
    const detail=describeUploadError(error);
    const message=polygonSaved?`Polygon ${city} sudah tersimpan dan ditampilkan, tetapi sinkronisasi titik sampel gagal: ${detail}`:`Polygon gagal disimpan ke database: ${detail}`;
    statusLine.textContent=message;alert(message);
  }
  finally{endLoading();event.target.value='';zoneUploadMode='overall';geoInput.accept='.zip,.geojson,.json,application/zip,application/geo+json';}
});

const adminPanel=document.getElementById('adminPanel');
const adminLogin=document.getElementById('adminLogin');
const setPasswordForm=document.getElementById('setPasswordForm');
const adminTools=document.getElementById('adminTools');
document.getElementById('zoneSampleTable').addEventListener('click',event=>{
  const sortButton=event.target.closest('button[data-zone-sort]');
  if(sortButton){
    const key=sortButton.dataset.zoneSort;
    if(zoneListSort.key===key)zoneListSort.direction=zoneListSort.direction==='asc'?'desc':'asc';
    else zoneListSort={key,direction:'asc'};
    const allGeo=citySelect.value==='ALL'?combinedDistrictGeo():geoByCity[citySelect.value];
    renderZoneSampleList(geoForSurveyor(allGeo,surveyorSelect.value),currentCalculation);return;
  }
  const button=event.target.closest('button[data-zone-id]');
  if(button)zoomToZone(button.dataset.zoneId);
});
document.getElementById('downloadReportButton').addEventListener('click',downloadAchievementWorkbook);
document.getElementById('adminToggle').addEventListener('click',()=>{adminPanel.hidden=!adminPanel.hidden;});
setPasswordForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const email=document.getElementById('inviteEmail').value.trim();
  const password=document.getElementById('invitePassword').value;
  const confirmation=document.getElementById('invitePasswordConfirm').value;
  const message=document.getElementById('setPasswordMessage');
  if(!supabaseClient){message.textContent='Koneksi database tidak tersedia. Muat ulang halaman dan buka kembali tautan undangan.';return;}
  if(password!==confirmation){message.textContent='Konfirmasi password belum sama.';return;}
  if(password.length<8){message.textContent='Password minimal 8 karakter.';return;}
  const submit=setPasswordForm.querySelector('button[type="submit"]');submit.disabled=true;message.textContent='Menyimpan password ke database…';
  try{
    const {data,error}=await supabaseClient.auth.updateUser({password});
    if(error)throw error;
    await supabaseClient.auth.signOut();
    setPasswordForm.hidden=true;adminLogin.hidden=false;
    document.getElementById('adminEmail').value=data.user?.email||email;
    document.getElementById('adminPassword').value='';
    document.getElementById('setPasswordMessage').textContent='';
    document.getElementById('adminMessage').textContent='Password berhasil dibuat. Silakan login dengan email dan password baru.';
    setPasswordForm.reset();
  }catch(error){message.textContent=`Password gagal disimpan: ${error.message||error}`;}
  finally{submit.disabled=false;}
});
adminLogin.addEventListener('submit',async event=>{
  event.preventDefault();
  const email=document.getElementById('adminEmail').value.trim();
  const password=document.getElementById('adminPassword').value;
  const message=document.getElementById('adminMessage');
  if(!supabaseClient){message.textContent='Database belum dikonfigurasi. Isi URL dan publishable key di file konfigurasi.';return;}
  message.textContent='Memeriksa akun…';
  try{
    const {data,error}=await supabaseClient.auth.signInWithPassword({email,password});
    if(error){message.textContent='Email belum terdaftar atau password salah. Periksa kembali email dan password akun Anda.';return;}
    if(!await verifyAdminUser(data.user)){
      await supabaseClient.auth.signOut(); message.textContent='Akun ini belum diberi akses admin.';return;
    }
    currentUser=data.user; adminLogin.hidden=true; adminTools.hidden=false; message.textContent=''; document.getElementById('adminPassword').value='';
    document.getElementById('adminCityName').textContent=citySelect.value;
  }catch(error){
    await supabaseClient.auth.signOut().catch(()=>{});
    message.textContent=`Tidak dapat menghubungi database atau memeriksa akses admin. Periksa koneksi dan konfigurasi. ${error.message||error}`;
  }
});
document.getElementById('adminLogout').addEventListener('click',async()=>{if(supabaseClient)await supabaseClient.auth.signOut();currentUser=null;adminTools.hidden=true;adminLogin.hidden=false;adminLogin.reset();});
document.getElementById('migrateLocalButton').addEventListener('click',async()=>{
  if(!currentUser){alert('Login sebagai admin terlebih dahulu.');return;}
  const button=document.getElementById('migrateLocalButton'); button.disabled=true; statusLine.textContent='Mengimpor data lama dari browser ke database…';
  try{
    for(const [city,legacy] of Object.entries(legacyBrowserData)){
      if(legacy.geo){const {error}=await supabaseClient.from('city_zones').upsert({city,geojson:legacy.geo,updated_by:currentUser.id},{onConflict:'city'});if(error)throw error;}
      if(legacy.rows?.length)await upsertRemoteSamples(city,legacy.rows);
    }
    legacyBrowserData={}; button.hidden=true; await loadRemoteData(); rebuildFilters(); update();
    statusLine.textContent='Data lama dari browser berhasil diimpor ke database bersama.';
  }catch(error){statusLine.textContent=`Impor data lama gagal: ${error.message||error}`;}
  finally{button.disabled=false;}
});
document.getElementById('prepareOverviewButton').addEventListener('click',async()=>{
  if(!currentUser){alert('Login sebagai admin terlebih dahulu.');return;}
  const city=citySelect.value;
  if(!city||city==='ALL'){alert('Pilih satu kabupaten dahulu untuk menyiapkan polygon ringkas.');return;}
  const button=document.getElementById('prepareOverviewButton');button.disabled=true;
  beginLoading(`Membuat polygon ringkas untuk ${city}…`);await browserPaint();
  try{
    const count=await prepareExistingOverview(city);
    if(citySelect.value==='ALL')await loadAllRemoteCities(citySelectionRequest);
    update();statusLine.textContent=`Polygon ringkas ${city} berhasil disiapkan untuk tampilan ALL (${count.toLocaleString('id-ID')} zona).`;
  }catch(error){statusLine.textContent=`Polygon ringkas gagal dibuat: ${error.message||error}`;}
  finally{button.disabled=false;endLoading();}
});

async function init() {
  supabaseClient=configuredSupabaseClient();
  if(supabaseClient){
    try{
      await restoreStoredData();
      legacyBrowserData=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(rowsByCity).map(([city,rows])=>[city,{rows,geo:geoByCity[city]||null}]))));
      document.getElementById('migrateLocalButton').hidden=!Object.values(legacyBrowserData).some(item=>item.rows.length||item.geo);
      const {data,error}=await supabaseClient.auth.getSession(); if(error)throw error;
      if(invitationFlowAtLoad&&data.session){
        adminPanel.hidden=false;adminLogin.hidden=true;adminTools.hidden=true;setPasswordForm.hidden=false;
        document.getElementById('inviteEmail').value=data.session.user?.email||'';
        document.getElementById('setPasswordMessage').textContent='Undangan terkonfirmasi. Buat password untuk akun ini.';
        const cleanUrl=new URL(location.href);cleanUrl.hash='';cleanUrl.searchParams.delete('invite');if(cleanUrl.searchParams.get('type')==='invite')cleanUrl.searchParams.delete('type');
        history.replaceState({},document.title,cleanUrl.pathname+cleanUrl.search);
      }else if(invitationFlowAtLoad&&!data.session){
        adminPanel.hidden=false;adminLogin.hidden=true;setPasswordForm.hidden=false;
        document.getElementById('setPasswordMessage').textContent='Sesi undangan tidak ditemukan atau tautan sudah kedaluwarsa. Minta admin mengirim undangan baru.';
      }else if(data.session){
        const user=data.session.user;
        if(await verifyAdminUser(user)){currentUser=user;adminLogin.hidden=true;adminTools.hidden=false;}
        else await supabaseClient.auth.signOut();
      }
      beginLoading('Menghubungkan ke database…');
      await loadRemoteData();
      endLoading();
      statusLine.textContent='Terhubung ke database bersama. Data akan diperbarui untuk semua pengguna setelah unggahan admin berhasil.';
    }catch(error){endLoading();statusLine.textContent=`Database belum dapat dimuat: ${error.message||error}. Periksa konfigurasi database.`;}
  }else{
    await restoreStoredData();
    statusLine.textContent='Database belum dikonfigurasi. Data belum tersinkron antar pengguna.';
    document.getElementById('adminMessage').textContent='Database belum dikonfigurasi. Isi URL dan publishable key terlebih dahulu.';
  }
  rebuildFilters(); update();
}
init();
