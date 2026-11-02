const C=window.ST_CONFIG;
if(!C?.SUPABASE_URL||C.SUPABASE_URL.includes('YOUR-PROJECT'))document.body.insertAdjacentHTML('afterbegin','<div class="card" style="color:#ffcf74">Configure Supabase in sharkconfig.js first. See sharkREADME.md.</div>');
const db=window.supabase.createClient(C.SUPABASE_URL,C.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const $=id=>document.getElementById(id);
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(n||0));
const date=s=>new Date(s).toLocaleString();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const code=()=>localStorage.getItem('st_investor_code')||'';
const adminCode=()=>sessionStorage.getItem('st_admin_code')||'';
let state=null,channel=null,loading=false;
function toast(msg,error=false){let d=document.createElement('div');d.className='toast';d.textContent=msg;d.style.borderColor=error?'#f78698':'#6a99c4';document.body.append(d);setTimeout(()=>d.remove(),4500)}
async function auth(){let {data:{session}}=await db.auth.getSession();if(!session){let {error}=await db.auth.signInAnonymously();if(error)throw error}}
async function api(action,extra={},which=''){let c=which==='admin'?adminCode():which==='investor'?code():'';const {data,error}=await db.rpc('st_api',{p_action:action,p:{...extra,...(which?{code:c}:{})}});if(error)throw error;return data}
async function sync(){if(loading)return;loading=true;try{state=await api('state',{},location.pathname.endsWith('sharkhost.html')?'admin':location.pathname.endsWith('sharkinvestor.html')?'investor':'');render()}catch(e){toast(e.message,true)}finally{loading=false}}
async function act(name,obj={},as='admin'){try{await api(name,obj,as);await sync();toast('Saved successfully')}catch(e){toast(e.message,true)}}
async function init(){try{await auth();await sync();channel=db.channel('st-changes').on('postgres_changes',{event:'UPDATE',schema:'public',table:'st_signal'},()=>sync()).subscribe();document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync()});setInterval(sync,30000)}catch(e){toast('Connection failed: '+e.message,true)}}
function lookup(id,field){return(state?.[field]||[]).find(x=>x.id===id)}
function section(type){return state?.offers?.filter(o=>o.status===type)||[]}
function dealRow(o){let b=lookup(o.business_id,'businesses'),i=lookup(o.investor_id,'investors');return `<div class="rowitem"><b>${safe(b?.name||'Business')}</b> · ${safe(i?.name||'Investor')}<div>${money(o.amount)} for ${safe(o.equity)}% equity${o.terms?' · '+safe(o.terms):''}</div><div class="small muted">${safe(o.status)} · ${date(o.updated_at)}</div></div>`}
function csv(name,rows){if(!rows.length){toast('Nothing to export');return}let cols=[...new Set(rows.flatMap(x=>Object.keys(x)))];let text=[cols,...rows.map(r=>cols.map(k=>typeof r[k]==='object'?JSON.stringify(r[k]):r[k]??''))].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n');let a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv'}));a.download=name+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
