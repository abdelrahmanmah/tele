const $ = id => document.getElementById(id);
const state = { step:1, token:'', qrUrl:'', expiresAt:'', connectedName:'', config:null,
  sources:[], active:false, paused:false, progress:'idle', cancelRequested:false, matched:0, scanned:0, rawCount:0, hashes:new Set() };
const KEY = 'mersad-session-v1';
let db;
let collectionController = null;
let collectionTask = null;
let resetting = false;

function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open('mersad-telegram-v1',1);req.onupgradeneeded=()=>{const d=req.result;d.createObjectStore('raw',{keyPath:'key'});d.createObjectStore('filtered',{keyPath:'key'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function storeRows(name,rows){return new Promise((resolve,reject)=>{if(!rows.length)return resolve();const tx=db.transaction(name,'readwrite');const store=tx.objectStore(name);rows.forEach(row=>store.put({...row,key:`${row.chat_id}:${row.message_id}`}));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
function readRows(name){return new Promise((resolve,reject)=>{const req=db.transaction(name).objectStore(name).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function clearRows(){return new Promise((resolve,reject)=>{const tx=db.transaction(['raw','filtered'],'readwrite');tx.objectStore('raw').clear();tx.objectStore('filtered').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
function save(){if(resetting)return;sessionStorage.setItem(KEY,JSON.stringify({step:state.step,token:state.token,qrUrl:state.qrUrl,expiresAt:state.expiresAt,connectedName:state.connectedName,config:state.config,sources:state.sources,progress:state.progress,matched:state.matched,scanned:state.scanned,rawCount:state.rawCount}));}
function show(step){if(resetting)return;state.step=step;document.querySelectorAll('.screen').forEach(el=>el.hidden=el.id!==`screen-${step}`);document.querySelectorAll('.step').forEach(el=>{const n=Number(el.dataset.step);el.classList.toggle('active',n===step);el.classList.toggle('done',n<step);});$('notice').hidden=true;save();window.scrollTo({top:0,behavior:'smooth'});}
function notice(message,type='error'){$('notice').textContent=message;$('notice').className=`notice ${type}`;$('notice').hidden=false;window.scrollTo({top:300,behavior:'smooth'});}
async function api(path,payload,signal){
  const response=await fetch(`/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store',signal});
  let data;
  try{data=await response.json();}catch{
    if(response.status===404)throw Error('The API endpoint was not found (HTTP 404). Check the Vercel deployment and try again.');
    throw Error(`The server returned an unreadable response (HTTP ${response.status}). Check the deployment logs and try again.`);
  }
  if(!response.ok){const err=Error(data.error||'Connection failed.');err.waitSeconds=data.wait_seconds||0;throw err;}
  return data;
}
function busy(button,flag,label){if(flag){button.dataset.label=button.textContent;button.disabled=true;button.textContent=label;}else{button.disabled=false;button.textContent=button.dataset.label||button.textContent;}}
function setQR(data){if(resetting)return;state.token=data.token;state.qrUrl=data.qr_url;state.expiresAt=data.expires_at;$('qr-image').src=data.qr_image;$('qr-image').hidden=false;save();}
function connected(data){if(resetting)return;state.token=data.token;state.connectedName=data.name||'your account';state.qrUrl='';state.expiresAt='';$('qr-view').hidden=true;$('password-form').hidden=true;$('connected-card').hidden=false;$('connected-name').textContent=`${state.connectedName} is connected. You can now choose channels and start searching.`;save();}
let pollRun=0;
function handleQRResult(result){
  if(result.status==='connected'){connected(result);return false;}
  if(result.status==='password'){
    state.token=result.token;state.qrUrl='';state.expiresAt='';
    $('qr-view').hidden=true;$('password-form').hidden=false;save();return false;
  }
  if(result.status==='waiting'){
    setQR(result);
    $('scan-message').textContent=result.reset?'The previous code expired. Scan this new QR code.':'Waiting for you to scan and approve...';
  }
  return true;
}
async function refreshQR(){
  const run=++pollRun;
  const button=$('refresh-qr');
  button.disabled=true;
  $('scan-message').textContent='Generating a new QR code...';
  try{
    const result=await api('refresh-qr',{token:state.token});
    if(run!==pollRun)return;
    if(handleQRResult(result))pollQR();
  }catch(err){if(run===pollRun)$('scan-message').textContent=`${err.message} Try refreshing the QR code.`;}
  finally{button.disabled=false;}
}
async function pollQR(){
  if(resetting)return;
  const run=++pollRun;
  while(run===pollRun&&state.step===2&&state.qrUrl){
    try{
      const expiring=Date.parse(state.expiresAt)-Date.now()<=3000;
      const result=await api(expiring?'refresh-qr':'poll',expiring?{token:state.token}:{token:state.token,qr_url:state.qrUrl,expires_at:state.expiresAt});
      if(run!==pollRun)return;
      if(!handleQRResult(result))return;
    }catch(err){
      if(run!==pollRun)return;
      if(err.message.includes('AUTH_TOKEN_EXPIRED')){
        refreshQR();return;
      }
      $('scan-message').textContent=`${err.message} You can refresh the QR code.`;
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
  }
}
function countdown(){
  if(state.step===2&&state.qrUrl){
    const seconds=Math.max(0,Math.ceil((new Date(state.expiresAt)-Date.now())/1000));
    $('qr-image').hidden=!seconds;
    $('qr-countdown').textContent=seconds?`QR code refreshes automatically • ${seconds} seconds`:'Refreshing the QR code...';
  }
  setTimeout(countdown,1000);
}
function parseSources(text){return [...new Set(text.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean))].slice(0,50);}
function parseTerms(text){return [...new Set(text.split(/[\n,،]+/).map(s=>s.trim()).filter(Boolean))].slice(0,12);}
function limitReached(){return state.matched>=state.config.max||(state.config.maxScanned>0&&state.scanned>=state.config.maxScanned);}
function restoreForm(){if(!state.config)return;$('sources').value=state.sources.map(s=>s.source).join('\n');$('start-date').value=state.config.start;const last=new Date(`${state.config.end}T00:00:00Z`);last.setUTCDate(last.getUTCDate()-1);$('end-date').value=last.toISOString().slice(0,10);const mode=document.querySelector(`[name=mode][value=${state.config.mode}]`);if(mode)mode.checked=true;for(const field of ['keywords','stocks','countries'])$(field).value=(state.config[field]||[]).join(', ');$('max-matches').value=state.config.max||5000;$('max-scanned').value=state.config.maxScanned||'';}
function initials(name){return (name||'?').replace(/^@/,'').slice(0,2).toUpperCase();}
function sourceStatus(s){
  if(s.error)return ['Could not access','failed'];
  if(s.done)return ['Completed',''];
  if(state.progress==='cancelled')return ['Collection cancelled',''];
  if(state.config&&!state.active&&limitReached())return ['Limit reached',''];
  if(s.resolved)return ['Collecting',''];
  return ['Checking',''];
}
function renderProgress(){
  const labels={idle:'Ready to start',running:'Collecting',paused:'Paused',done:'Completed',error:'Collection failed',cancelled:'Collection cancelled'};
  const status=labels[state.progress]||labels.idle;
  $('progress-card').dataset.state=state.progress;
  $('progress-state').textContent=status;
  $('progress-track').setAttribute('aria-valuetext',status);
  $('pause-button').hidden=state.progress==='done'||state.progress==='cancelled';
  $('cancel-button').hidden=state.progress==='done'||state.progress==='cancelled';
}
function restoreCollectionView(){
  if(state.progress==='cancelled'){
    $('results-title').textContent='Collection stopped';
    $('results-subtitle').textContent='Your collected messages are still available. Download them or start another search.';
    $('progress-label').textContent='Collection cancelled';
  }else if(state.progress==='done'||(state.config&&(limitReached()||state.sources.length&&state.sources.every(s=>s.done||s.error)))){
    state.progress='done';
    $('results-title').textContent='Your results are ready';
    $('results-subtitle').textContent=`Found ${state.matched} unique results after scanning ${state.scanned} messages. You can download the files now.`;
    $('progress-label').textContent='Collection complete';
  }else if(state.progress==='error'){
    $('progress-label').textContent='Collection stopped because of an error';
    $('pause-button').textContent='Try again';
  }else{
    state.progress='paused';
    $('progress-label').textContent='You can resume collection';
    $('pause-button').textContent='Resume collection';
  }
  renderProgress();save();
}
function renderSources(){const list=$('source-list');list.replaceChildren();for(const s of state.sources){const row=document.createElement('div');row.className='source-row';const avatar=s.photo?document.createElement('img'):document.createElement('span');avatar.className='source-avatar';if(s.photo)avatar.src=s.photo;else avatar.textContent=initials(s.title||s.source);const info=document.createElement('span');info.className='source-info';const title=document.createElement('b');title.dir='auto';title.textContent=s.title||s.source;const sub=document.createElement('small');sub.textContent=s.error||`${s.scanned||0} scanned • ${s.matched||0} results`;info.append(title,sub);const badge=document.createElement('span');const [label,kind]=sourceStatus(s);badge.className=`source-badge ${kind}`;badge.textContent=label;row.append(avatar,info,badge);list.append(row);}const done=state.sources.filter(s=>s.done||s.error).length;$('sources-count').textContent=`${done} / ${state.sources.length}`;$('source-summary').textContent=`${state.sources.length} sources`;$('matched-count').textContent=state.matched.toLocaleString('en-US');$('scanned-count').textContent=state.scanned.toLocaleString('en-US');renderProgress();$('download-filtered').disabled=!state.matched;$('download-raw').disabled=!state.rawCount;}
function renderResults(rows){if(!rows.length)return;const list=$('result-list');if(list.querySelector('.empty-state'))list.replaceChildren();for(const r of rows.slice(-15).reverse()){const row=document.createElement('div');row.className='result-row';const av=document.createElement('span');av.className='source-avatar';av.textContent=initials(r.chat_title);const info=document.createElement('div');info.className='result-info';const top=document.createElement('div');const title=document.createElement('b');title.dir='auto';title.textContent=r.chat_title||r.chat_username||'Channel';const date=document.createElement('small');date.textContent=new Date(r.date_utc).toLocaleDateString('en-US');top.append(title,date);const p=document.createElement('p');p.dir='auto';p.textContent=r.text;info.append(top,p);if(r.url){const a=document.createElement('a');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='View message ↗';info.append(a);}row.append(av,info);list.prepend(row);}while(list.children.length>15)list.lastChild.remove();$('result-summary').textContent=`${state.matched} unique results`;}
async function resumeCounts(){const rows=await readRows('filtered');state.hashes=new Set(rows.map(r=>r.content_sha256));state.matched=rows.length;state.rawCount=(await readRows('raw')).length;renderResults(rows.slice(-15));renderSources();}
function abortError(){const error=Error('Collection cancelled');error.name='AbortError';return error;}
function wait(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(abortError());
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
    function onAbort(){clearTimeout(timer);reject(abortError());}
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}
async function withWait(path,payload,signal){
  for(;;){
    if(signal.aborted)throw abortError();
    try{return await api(path,payload,signal);}
    catch(err){
      if(signal.aborted)throw abortError();
      if(err.waitSeconds&&err.waitSeconds<=60){
        $('progress-label').textContent=`Telegram asked us to wait ${err.waitSeconds} seconds`;
        await wait((err.waitSeconds+2)*1000,signal);
        continue;
      }
      throw err;
    }
  }
}
function cancelCollection(){
  if(state.progress==='done'||state.progress==='cancelled')return;
  state.cancelRequested=true;
  state.paused=false;
  state.progress='cancelled';
  collectionController?.abort();
  restoreCollectionView();
  renderSources();
}
async function runCollection(){
  if(state.active||resetting)return;
  const controller=new AbortController();
  collectionController=controller;
  const signal=controller.signal;
  state.active=true;
  state.paused=false;
  state.cancelRequested=false;
  state.progress='running';
  $('pause-button').textContent='Pause';
  renderSources();save();
  try{
    for(const s of state.sources){
      if(state.paused||state.cancelRequested||limitReached())break;
      if(s.done||s.error)continue;
      $('progress-label').textContent=`Checking ${s.source}`;
      if(!s.resolved){
        try{
          const result=await withWait('source',{token:state.token,source:s.source},signal);
          if(signal.aborted)throw abortError();
          Object.assign(s,result,{resolved:true,scanned:0,matched:0});
          save();renderSources();
        }catch(err){
          if(signal.aborted)throw err;
          s.error=err.message;save();renderSources();continue;
        }
      }
      while(!s.done&&!state.paused&&!state.cancelRequested&&!limitReached()){
        $('progress-label').textContent=`Collecting from ${s.title||s.source}...`;
        let batch;
        try{
          batch=await withWait('page',{token:state.token,peer:s.peer,title:s.title,username:s.username,start:state.config.start,end:state.config.end,cursor:s.cursor||0,mode:state.config.mode,keywords:state.config.keywords,stocks:state.config.stocks,countries:state.config.countries,limit:state.config.maxScanned?Math.min(60,state.config.maxScanned-state.scanned):60},signal);
          if(signal.aborted)throw abortError();
        }catch(err){
          if(signal.aborted)throw err;
          s.error=err.message;save();renderSources();break;
        }
        const fresh=[];
        for(const row of batch.rows){
          if(state.hashes.has(row.content_sha256))continue;
          state.hashes.add(row.content_sha256);
          fresh.push(row);
          if(state.matched+fresh.length>=state.config.max)break;
        }
        await storeRows('raw',batch.raw_rows);
        await storeRows('filtered',fresh);
        state.matched+=fresh.length;
        state.rawCount+=batch.raw_rows.length;
        state.scanned+=batch.scanned;
        s.scanned+=batch.scanned;
        s.matched+=fresh.length;
        s.cursor=batch.cursor;
        s.done=batch.done;
        save();renderSources();renderResults(fresh);
        await wait(250,signal);
      }
    }
    if(state.cancelRequested){restoreCollectionView();}
    else if(state.paused){state.progress='paused';$('progress-label').textContent='Paused';}
    else{
      state.progress='done';
      $('progress-label').textContent='Collection complete';
      $('results-title').textContent='Your results are ready';
      $('results-subtitle').textContent=`Found ${state.matched} unique results after scanning ${state.scanned} messages. You can download the files now.`;
    }
  }catch(err){
    if(state.cancelRequested||signal.aborted){state.progress='cancelled';restoreCollectionView();}
    else{state.progress='error';notice(err.message);$('progress-label').textContent='Collection stopped because of an error';}
  }finally{
    state.active=false;
    if(collectionController===controller)collectionController=null;
    $('pause-button').textContent=state.paused?'Resume collection':'Try again';
    renderSources();save();
  }
}
function csvCell(v){const text=String(v??'');return '"'+text.replaceAll('"','""')+'"';}
async function download(name,kind){const rows=await readRows(kind);if(!rows.length)return;const columns=kind==='raw'?['chat_id','chat_title','chat_username','message_id','date_utc','text','url']:['chat_id','chat_title','chat_username','message_id','date_utc','text','url','categories','companies','content_sha256'];const csv='\ufeff'+columns.join(',')+'\r\n'+rows.map(row=>columns.map(k=>csvCell(row[k])).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function resetApp(){
  if(resetting||!confirm('Disconnect Telegram and delete this browser’s collected messages and settings?'))return;
  resetting=true;
  pollRun++;
  const button=$('reset-app');
  busy(button,true,'Disconnecting...');
  const token=state.token;
  if(state.active)cancelCollection();
  if(collectionTask)await collectionTask;
  let disconnectError;
  if(token){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const result=await api('disconnect',{token},controller.signal);
      if(!result.disconnected)throw Error('Telegram did not confirm disconnection.');
    }catch(err){disconnectError=err;}
    finally{clearTimeout(timer);}
  }
  try{
    await clearRows();
    sessionStorage.removeItem(KEY);
  }catch(err){
    resetting=false;
    busy(button,false);
    notice(`Could not clear local data: ${err.message}`);
    return;
  }
  if(disconnectError)alert('Local data was reset, but Telegram disconnection could not be confirmed. Remove this device in Telegram → Settings → Devices.');
  window.location.reload();
}
async function init(){db=await openDB();const saved=sessionStorage.getItem(KEY);if(saved){try{Object.assign(state,JSON.parse(saved));state.hashes=new Set();state.active=false;state.paused=false;state.progress=state.progress==='running'?'paused':state.progress||'idle';if(state.token&&!state.token.startsWith('v1.')){state.token='';state.step=1;state.connectedName='';state.qrUrl='';}}catch{sessionStorage.removeItem(KEY);}}document.querySelectorAll('.step').forEach(btn=>btn.addEventListener('click',()=>{const n=Number(btn.dataset.step);if(state.active&&n!==4)return;if(n<state.step||n===3&&state.token||n===4&&state.config)show(n);}));$('keys-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;busy(button,true,'Creating your QR code...');try{const data=await api('start',{api_id:$('api-id').value.trim(),api_hash:$('api-hash').value.trim()});state.connectedName='';setQR(data);$('qr-view').hidden=false;$('connected-card').hidden=true;$('password-form').hidden=true;show(2);pollQR();}catch(err){notice(err.message);}finally{busy(button,false);}});$('password-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;busy(button,true,'Checking...');try{connected(await api('password',{token:state.token,password:$('twofa-password').value}));$('twofa-password').value='';}catch(err){notice(err.message);}finally{busy(button,false);}});$('to-config').addEventListener('click',()=>show(3));$('config-form').addEventListener('submit',async e=>{e.preventDefault();const sources=parseSources($('sources').value);if(!sources.length)return notice('Add at least one channel or group.');const start=$('start-date').value,end=$('end-date').value;if(start>end)return notice('The start date must be before the end date.');if(state.config&&(state.matched||state.rawCount)&&!confirm('Starting a new search will delete the current results from this browser. Continue?'))return;const endExclusive=new Date(`${end}T00:00:00Z`);endExclusive.setUTCDate(endExclusive.getUTCDate()+1);state.config={start,end:endExclusive.toISOString().slice(0,10),mode:document.querySelector('[name=mode]:checked').value,keywords:parseTerms($('keywords').value),stocks:parseTerms($('stocks').value),countries:parseTerms($('countries').value),max:Number($('max-matches').value),maxScanned:Number($('max-scanned').value)||0};state.sources=sources.map(source=>({source,cursor:0,done:false,scanned:0,matched:0}));state.scanned=state.matched=state.rawCount=0;state.hashes.clear();state.progress='idle';state.cancelRequested=false;await clearRows();show(4);renderSources();collectionTask=runCollection();});$('pause-button').addEventListener('click',()=>{if(state.active){state.paused=true;state.progress='paused';renderProgress();save();$('pause-button').disabled=true;setTimeout(()=>$('pause-button').disabled=false,1200);}else collectionTask=runCollection();});$('cancel-button').addEventListener('click',cancelCollection);$('new-search-button').addEventListener('click',async()=>{if(state.active)cancelCollection();if(collectionTask)await collectionTask;restoreForm();show(3);});$('download-filtered').addEventListener('click',()=>download('filtered_posts.csv','filtered'));$('download-raw').addEventListener('click',()=>download('raw_posts.csv','raw'));if(state.step>1&&!state.token)state.step=1;restoreForm();show(state.step);if(state.step===2){if(state.connectedName){connected({token:state.token,name:state.connectedName});}else if(state.qrUrl){$('qr-countdown').textContent='Restoring your QR code...';pollQR();}}if(state.step===4){await resumeCounts();restoreCollectionView();}countdown();}
$('refresh-qr').addEventListener('click',refreshQR);
$('reset-app').addEventListener('click',resetApp);
init().catch(err=>notice(`Could not open local storage: ${err.message}`));
