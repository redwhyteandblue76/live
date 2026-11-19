
let eventListCache=null;
async function evReq(action,p={}) { return api(action,p,'admin'); }
async function evReload(){eventListCache=await evReq('event_list');await sync();}
function evFile(name,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
function evSlug(s){return (s||'shark-tank').replace(/[^a-z0-9-]+/gi,'-').slice(0,70)}
async function evBackup(id){const b=await evReq('event_export',{id});if(b.format!=='12one-sharktank-backup'||b.version!==1)throw Error('Unrecognized backup');return b}
async function evJson(id){try{const b=await evBackup(id);evFile(evSlug(b.event.name)+'-backup.json',JSON.stringify(b,null,2),'application/json');toast('JSON download started. Keep investor codes private.')}catch(e){toast(e.message,true)}}
function evReportHTML(b){
 const s=b.snapshot,bs=s.businesses||[],iv=s.investors||[],of=s.offers||[],vt=s.votes||[],lg=s.logs||[];
 const rows=(a,fn)=>a.map(x=>'<tr>'+fn(x).map(y=>'<td>'+safe(y)+'</td>').join('')+'</tr>').join('');
 const table=(heads,body)=>'<table><thead><tr>'+heads.map(h=>'<th>'+safe(h)+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody></table>';
 const accepted=of.filter(x=>x.status==='accepted');
 return '<!doctype html><html><head><meta charset="utf-8"><title>'+safe(b.event.name)+' Event Report</title><style>body{font:14px system-ui;max-width:1100px;margin:35px auto;padding:16px;color:#162338}table{border-collapse:collapse;width:100%;margin-bottom:28px}th,td{padding:8px;border-bottom:1px solid #ccd5df;text-align:left}h2{margin-top:32px}@media print{tr{break-inside:avoid}}</style></head><body>'+
 '<h1>'+safe(b.event.name)+'</h1><p>Event status: '+safe(b.event.status)+' · Report generated '+safe(new Date().toLocaleString())+'</p>'+
 '<p>'+bs.length+' businesses · '+iv.length+' investors · '+accepted.length+' accepted deals · '+money(accepted.reduce((n,o)=>n+Number(o.amount),0))+' committed</p>'+
 '<h2>Businesses and Audience Ratings</h2>'+table(['Business','Entrepreneur','Asking','Equity','Rating'],rows(bs,x=>{const r=vt.filter(v=>v.business_id===x.id&&v.rating!=null);return [x.name,x.entrepreneur,money(x.ask_amount),x.ask_equity+'%',r.length?(r.reduce((n,v)=>n+Number(v.rating),0)/r.length).toFixed(2)+' / 5 ('+r.length+')':'No ratings']}))+
 '<h2>Investor Portfolios</h2>'+table(['Investor','Title','Starting budget','Invested','Remaining'],rows(iv,x=>{const used=accepted.filter(o=>o.investor_id===x.id).reduce((n,o)=>n+Number(o.amount),0);return [x.name,x.title,money(s.settings?.starting_budget),money(used),money(Number(s.settings?.starting_budget||0)-used)]}))+
 '<h2>All Offers</h2>'+table(['Business','Investor','Amount','Equity','Status','Terms','Created'],rows(of,x=>[bs.find(y=>y.id===x.business_id)?.name||'',iv.find(y=>y.id===x.investor_id)?.name||'',money(x.amount),x.equity+'%',x.status,x.terms,x.created_at]))+
 '<h2>Activity History</h2>'+table(['Time','Action','Actor','Details'],rows(lg,x=>[x.at,x.action,x.actor,JSON.stringify(x.details||{})]))+
 '<p>This reference report omits investor access codes and anonymous voter IDs. Keep a JSON backup for restoration.</p></body></html>';
}
async function evReport(id){try{const b=await evBackup(id);evFile(evSlug(b.event.name)+'-report.html',evReportHTML(b),'text/html');toast('Report download started. Open the HTML file to print or save to PDF.')}catch(e){toast(e.message,true)}}
async function evAction(action,params,confirmation){
 if(confirmation&&!confirm(confirmation))return;
 try{await evReq(action,params);await evReload();toast('Event updated')}catch(e){toast(e.message,true)}
}
function evNew(){const name=prompt('New event name:','Shark Tank Night');if(name?.trim())evAction('event_create',{name:name.trim()})}
function evSelect(id){evAction('event_select',{id},'Save the current event and load this event in paused mode? Public screens will switch to it.')}
function evStatus(status,id=state?.settings?.event_id){evAction('event_status',{id,status},'Change this event to '+status+'?')}
function eventEnd(){evStatus('ended')}
function evImport(){
 const el=document.createElement('input');el.type='file';el.accept='.json,application/json';
 el.onchange=async()=>{try{
 const f=el.files?.[0];if(!f)return;if(f.size>10000000)throw Error('Maximum 10 MB');
 const b=JSON.parse(await f.text()),s=b.snapshot;
 if(b.format!=='12one-sharktank-backup'||b.version!==1||!b.event||!s||!s.settings||!['businesses','investors','offers','votes','logs'].every(k=>Array.isArray(s[k])))throw Error('Unsupported backup format');
 if(!confirm('Import '+b.event.name+' as a new paused event?\n'+s.businesses.length+' businesses, '+s.investors.length+' investors, '+s.offers.length+' offers, '+s.votes.length+' ratings. Existing events will not be replaced.'))return;
 await evReq('event_import',{backup:b});await evReload();toast('Event imported; select it when ready');
 }catch(e){toast('Import failed: '+e.message,true)}};
 el.click();
}
function evDeleteDialog(id){
 const e=eventListCache?.events.find(x=>x.id===id);if(!e)return;
 modal('<h2>Delete '+safe(e.name)+'?</h2><p>Download a restorable backup or a personal event report before deleting. Deletion cannot be undone.</p>'+
 '<div class="stack"><button class="secondary" onclick="evJson(\''+id+'\')">Download restorable JSON</button>'+
 '<button class="secondary" onclick="evReport(\''+id+'\')">Download personal report</button>'+
 '<p class="small muted">JSON backups contain private investor access codes. Downloads cannot be verified automatically.'+(e.current?' Deleting the current event will first create and load a blank, paused replacement.':'')+'</p><label>Type DELETE to confirm</label>'+
 '<input id="evDeleteType" autocomplete="off" placeholder="DELETE"><button class="danger" onclick="evDelete(\''+id+'\')">Permanently Delete</button></div>');
}
async function evDelete(id){
 if($('evDeleteType')?.value!=='DELETE')return toast('Type DELETE first',true);
 const entry=eventListCache?.events?.find(e=>e.id===id);
 if(!entry)return toast('Event not found. Refresh the library.',true);
 const current=entry.current;
 const warning=current
  ? 'Final warning: delete the CURRENT event? A fresh, paused replacement will be created and loaded first. This event and its stored data will then be deleted.'
  : 'Final warning: permanently delete this saved event?';
 if(!confirm(warning))return;
 try{
   if(current){
     // The database cannot delete the loaded event. Create a safe blank replacement,
     // switch transactionally (saving the old event), then remove the old snapshot.
     const created=await evReq('event_create',{name:'New Shark Tank Event'});
     if(!created?.event_id)throw Error('Unable to create a replacement event');
     await evReq('event_select',{id:created.event_id});
   }
   await evReq('event_delete',{id});
   $('editModal')?.remove();
   await evReload();
   toast('Event deleted permanently');
 }catch(e){
   await evReload().catch(()=>{});
   toast('Delete incomplete: '+e.message,true);
 }
}
function eventPanel(){
 if(!eventListCache)Promise.resolve().then(()=>evReq('event_list').then(x=>{eventListCache=x;if(tab==='events')render()}).catch(e=>toast('Apply the new SQL migration first: '+e.message,true)));
 const arr=eventListCache?.events||[],id=state?.settings?.event_id,cur=arr.find(x=>x.id===id);
 const btn=(caption,call,style='secondary')=>'<button class="'+style+'" onclick="'+call+'">'+caption+'</button>';
 const currentControls=cur?[cur.status==='active'?btn('Pause Event',"evStatus('paused')"):null,
 cur.status==='paused'?btn('Activate Event',"evStatus('active')",'success'):null,
 cur.status==='ended'?btn('Reopen as Paused',"evStatus('paused')",'success'):null,
 cur.status!=='ended'?btn('End Event','eventEnd()','danger'):null,
 btn('Download JSON',"evJson('"+id+"')"),btn('Download Report',"evReport('"+id+"')"),btn('Delete Event',"evDeleteDialog('"+id+"')",'danger')].filter(Boolean).join(''):'Loading current event…';
 return '<div class="between"><div><h2>Event Library</h2><p class="muted small">Only one event is loaded publicly at once. New and imported events are saved paused.</p></div><div class="flex">'+btn('↻ Refresh',"evReq('event_list').then(x=>{eventListCache=x;render()})")+btn('＋ New Event','evNew()','success')+btn('Import JSON','evImport()')+'</div></div>'+
 '<div class="card" style="margin:15px 0"><h2>Current: '+safe(state?.settings?.event_name||'Shark Tank')+'</h2><p class="muted">Lifecycle: '+safe(cur?.status||state?.settings?.event_status||'loading')+'</p><div class="flex">'+currentControls+'</div><p class="small muted">The separate Master Lock still controls temporary participation while an event is active.</p></div>'+
 '<div class="grid">'+arr.map(e=>'<div class="card"><div class="between"><h3>'+safe(e.name)+'</h3><span class="tag">'+safe(e.status.toUpperCase())+'</span></div><p class="small muted">'+(e.current?'CURRENT EVENT · ':'')+'Created '+safe(new Date(e.created_at).toLocaleDateString())+'</p><div class="flex">'+
 (!e.current&&e.status!=='archived'?btn('Load Event',"evSelect('"+e.id+"')",'success'):'')+
 (e.status==='archived'?btn('Unarchive',"evStatus('paused','"+e.id+"')"):'')+
 (!e.current&&e.status!=='archived'?btn('Archive',"evStatus('archived','"+e.id+"')"):'')+
 btn('JSON',"evJson('"+e.id+"')")+btn('Report',"evReport('"+e.id+"')")+
 (!e.current?btn('Delete',"evDeleteDialog('"+e.id+"')",'danger'):'')+
 '</div></div>').join('')+'</div><p class="small muted">Deleting a currently loaded event automatically creates and loads a blank paused replacement first. Switching events saves the outgoing state transactionally.</p>';
}
