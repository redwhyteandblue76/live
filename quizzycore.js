'use strict';
/* Quizzy • Shark Tank-compatible Supabase architecture. Public key only. */
(()=> {
const page=document.body.dataset.page, cfg=window.ST_CONFIG;
const db=window.supabase?.createClient(cfg?.SUPABASE_URL,cfg?.SUPABASE_ANON_KEY,{auth:{storageKey:'quizzy_guest_auth',persistSession:true,detectSessionInUrl:false}});
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr=esc;
const pin=()=>new URLSearchParams(location.search).get('pin')||localStorage.getItem('quizzy_last_pin')||'';
const hostCode=()=>sessionStorage.getItem('quizzy_host_code')||'';
let state=null,quizzes=[],sessions=[],chosen=[],editor=null,timer=null,channel=null,loading=false,lastKey='';
const link=(path,p)=>new URL(path+(p?'?pin='+encodeURIComponent(p):''),location.href).href;
const form=(id,html)=>'<form id="'+id+'">'+html+'</form>';
function notice(msg){$('notice').textContent=msg||''}
function toastError(e){notice(e?.message||String(e))}
function option(text,value){return '<option value="'+attr(value??text)+'">'+esc(text)+'</option>'}
async function initAuth(){
 if(!db)throw Error('Supabase configuration unavailable');
 let {data,error}=await db.auth.getSession();if(error)throw error;
 if(!data.session){({error}=await db.auth.signInAnonymously());if(error)throw error}
}
async function api(action,p={}){let {data,error}=await db.rpc('quizzy_api',{p_action:action,p:{...p,...(hostCode()?{host_code:hostCode()}:{})}});if(error)throw error;return data}
async function execute(fn){notice('');try{await fn()}catch(e){toastError(e)}}
function busy(btn,flag){if(btn)btn.disabled=flag}
function persistPin(p){localStorage.setItem('quizzy_last_pin',p)}
function teamRows(s){
 let rows=s.players||[],filtered=rows.filter(x=>!x.removed),groups={};
 for(let r of filtered){let k=r.team||'Everyone';(groups[k]??=[]).push(Number(r.score)||0)}
 return Object.entries(groups).map(([name,values])=>({name,score:s.team_mode==='average'?Math.round(values.reduce((a,b)=>a+b,0)/values.length):values.reduce((a,b)=>a+b,0)})).sort((a,b)=>b.score-a.score);
}
function leaderRows(s){return s.mode==='team'?teamRows(s).map(x=>({nickname:x.name,score:x.score})): (s.players||[]).filter(x=>!x.removed).map(x=>({nickname:x.nickname,score:x.score||0})).sort((a,b)=>b.score-a.score)}
function leaders(s){const rows=leaderRows(s);return '<div class="tablewrap"><table><thead><tr><th>Rank</th><th>'+(s.mode==='team'?'Team':'Player')+'</th><th>Points</th></tr></thead><tbody>'+rows.map((x,i)=>'<tr><td>'+ (i+1) +'</td><td>'+esc(x.nickname)+'</td><td>'+Number(x.score).toLocaleString()+'</td></tr>').join('')+'</tbody></table></div>'}
function podium(s){const a=leaderRows(s).slice(0,3);if(!a.length)return '<p>No results yet.</p>';const order=[a[1],a[0],a[2]];return '<div class="podium">'+order.map((r,i)=>r?'<div><div class="eyebrow">'+[2,1,3][i]+' PLACE</div><h2>'+esc(r.nickname)+'</h2><strong>'+Number(r.score).toLocaleString()+'</strong></div>':'<div></div>').join('')+'</div>'}
function renderClock(s){const node=$('countdown');if(!node)return;const q=s.question; if(!q){node.textContent='';return}const secs=Number(q.seconds)||30;let elapsed=(Date.now()-Date.parse(s.started_at))/1000;if(s.phase==='paused')elapsed=(Date.parse(s.paused_at)-Date.parse(s.started_at))/1000;const remaining=Math.max(0,Math.ceil(secs-elapsed));node.textContent=(s.phase==='question'||s.phase==='paused')?remaining+'s':'';}
function questionCard(s,projector){
 const q=s.question;if(!q)return '<div class="card center">Preparing the next question…</div>';
 const mode=s.display_mode;
 const showText=projector||mode==='both';
 let choices='';
 if(q.type==='numeric')choices=projector?'<p>Enter a number on your device.</p>':'<label>Number<input type="number" step="any" id="numericResponse" placeholder="Your answer"></label><button onclick="Quizzy.answerNumber()">Lock answer</button>';
 else if(projector){
 choices='<div class="grid">'+(q.options||[]).map((x,i)=>'<div class="card"><div class="eyebrow">'+String.fromCharCode(65+i)+'</div><h2>'+esc(x)+'</h2></div>').join('')+'</div>';
 }else{
 choices=(q.options||[]).map((x,i)=>'<button type="button" class="choice '+(chosen.includes(x)?'selected':'')+'" onclick="Quizzy.choose('+i+')">'+String.fromCharCode(65+i)+(showText?' · '+esc(x):'')+'</button>').join('');
 if(q.type==='multi')choices+='<button onclick="Quizzy.lockMulti()">Lock selected answers</button>';
 }
 return '<div class="card"><div class="between"><span class="tag">Question '+(s.question_index+1)+' / '+s.question_count+'</span><div id="countdown" class="timer"></div></div>'+(showText?'<h1>'+esc(q.text)+'</h1>':'<h2>Choose an answer using the projector.</h2>')+choices+'</div>';
}
function bindForm(id,callback){const node=$(id);if(node)node.addEventListener('submit',async e=>{e.preventDefault();await execute(()=>callback(new FormData(node)))});}
function renderJoin(){
 const p=pin(),name=$('nickname')?.value||'',team=$('team')?.value||'';
 $('app').innerHTML=form('joinForm','<label>Six-digit game PIN</label><input name="pin" maxlength="6" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" required value="'+attr(p)+'"><label>Nickname</label><input name="nickname" id="nickname" maxlength="30" required value="'+attr(name)+'"><div id="teamSelect">'+(state?.mode==='team'?'<label>Choose a team</label><select name="team" id="team">'+(state.teams||[]).map(t=>option(t,t)).join('')+'</select>':'')+'</div><button style="width:100%;margin-top:16px">Join game →</button>');
 bindForm('joinForm',async d=>{let p=String(d.get('pin')||'').trim(),nickname=String(d.get('nickname')||'').trim(),team=String(d.get('team')||'');await api('join',{pin,nickname,team});persistPin(p);location.href=link('quizzyplay.html',p)});
 const pinBox=$('joinForm').elements.namedItem('pin');
 pinBox.addEventListener('change',async()=>{let p=pinBox.value.trim();if(!/^\d{6}$/.test(p))return;try{state=await api('public_state',{pin:p});const name=$('nickname')?.value||'';renderJoin();$('nickname').value=name;}catch(e){notice('Game lookup: '+e.message)}});
 if(state?.mode==='team')$('team')?.setAttribute('value',team);
}
function renderPlayer(){
 if(!state){$('app').innerHTML='<div class="card">Connecting to game…</div>';return}
 $('gameTag').textContent=state.phase.toUpperCase();
 if(!state.me){$('app').innerHTML='<div class="card"><h2>Join this game first</h2><a class="action" href="'+link('quizzy.html',state.pin)+'">Join Quizzy</a></div>';return}
 const phase=state.phase;
 if(phase==='lobby'){$('app').innerHTML='<section class="hero center"><div class="eyebrow">You are in!</div><h1>'+esc(state.me.nickname)+'</h1><p>Waiting for the host to start · '+(state.players||[]).length+' joined</p></section>';return}
 if(phase==='question'||phase==='paused'){
 $('app').innerHTML='<div class="center muted">Playing as '+esc(state.me.nickname)+'</div>'+((state.my_answer!==null && state.my_answer!==undefined)?'<div class="card center"><h1>✓ Answer locked</h1><p>Waiting for the next question.</p></div>':phase==='paused'?'<div class="card center"><h1>⏸ Game paused</h1><p>Answers are paused.</p></div>':questionCard(state,false));
 renderClock(state);return;
 }
 if(phase==='reveal'||phase==='leaderboard'){
 let q=state.question,correct= q?.type==='numeric'?state.numeric_value:(state.correct||[]).join(', ');
 $('app').innerHTML='<div class="card center"><div class="eyebrow">Answer reveal</div><h2>'+esc(q?.text||'')+'</h2><h1>'+esc(correct||'Poll — no correct answer')+'</h1><p>'+esc(state.explanation||'')+'</p></div>'+(phase==='leaderboard'&&state.rankings_visible?'<div class="card">'+leaders(state)+'</div>':'<p class="center">Waiting for the host…</p>');return;
 }
 if(phase==='finished'){$('app').innerHTML='<section class="hero center"><h1>Game complete!</h1><p>Great playing, '+esc(state.me.nickname)+'</p></section>'+podium(state)+'<div class="card">'+leaders(state)+'</div>';return}
}
async function refresh(){if(loading||!pin()||page==='edit')return;loading=true;try{state=await api(page==='host'&&hostCode()?'host_state':'public_state',{pin:pin()});notice('');if(page==='host')renderHostSession();else if(page==='play')renderPlayer();else if(page==='projector')renderProjector();else if(page==='results')renderResults();}catch(e){toastError(e)}finally{loading=false}}
function subscribe(){if(channel)db.removeChannel(channel);if(!pin())return;channel=db.channel('quizzy-'+pin()).on('postgres_changes',{event:'UPDATE',schema:'public',table:'quizzy_signal'},()=>refresh()).subscribe()}
async function choose(i){
 if(!state||state.phase!=='question'||state.my_answer!=null)return;
 let q=state.question,v=q.options[i];if(q.type==='multi'){chosen=chosen.includes(v)?chosen.filter(x=>x!==v):[...chosen,v];renderPlayer();return}
 await execute(async()=>{await api('submit',{pin:pin(),answer:q.type==='poll'?v:[v]});chosen=[];await refresh()});
}
async function lockMulti(){if(!chosen.length)return notice('Select at least one answer');await execute(async()=>{await api('submit',{pin:pin(),answer:chosen});chosen=[];await refresh()})}
async function answerNumber(){let v=Number($('numericResponse')?.value);if(!$('numericResponse')?.value||!Number.isFinite(v))return notice('Enter a valid number');await execute(async()=>{await api('submit',{pin:pin(),answer:v});await refresh()})}
function renderProjector(){
 if(!state){$('app').innerHTML='<div class="card center">Waiting for a game…</div>';return}
 const s=state,phase=s.phase;
 if(phase==='lobby'){
 $('app').innerHTML='<section class="hero center"><div class="eyebrow">Join Quizzy</div><h1>'+esc(s.title)+'</h1><div class="pin">'+esc(s.pin)+'</div><div id="qr" class="qr"></div><p>Scan or visit '+esc(link('quizzy.html',s.pin))+'</p><h2>'+(s.players||[]).length+' joined</h2><p>'+s.players.map(x=>esc(x.nickname)).join(' · ')+'</p></section>';const qr=$('qr');if(typeof QRCode==='function')new QRCode(qr,{text:link('quizzy.html',s.pin),width:180,height:180});else qr.textContent='QR unavailable';return;
 }
 if(phase==='question'||phase==='paused'){$('app').innerHTML=(phase==='paused'?'<div class="tag">⏸ PAUSED</div>':'')+questionCard(s,true)+'<div class="card center"><h2>'+esc(s.title)+'</h2><p>Answer on your phone</p></div>';renderClock(s);return}
 if(phase==='reveal'||phase==='leaderboard'){
 $('app').innerHTML='<section class="hero center"><div class="eyebrow">Answer reveal</div><h1>'+esc(s.question?.text||'')+'</h1><h2>'+esc(s.question?.type==='numeric'?s.numeric_value:(s.correct||[]).join(' · ')||'Poll results')+'</h2><p>'+esc(s.explanation||'')+'</p></section>'+ (phase==='leaderboard'&&s.rankings_visible?'<div class="card">'+leaders(s)+'</div>':'') + (s.stats?'<p class="center">'+s.stats.length+' responses</p>':'');return}
 if(phase==='finished'){$('app').innerHTML='<section class="hero center"><div class="eyebrow">Final standings</div><h1>'+esc(s.title)+'</h1></section>'+podium(s)+'<div class="card">'+leaders(s)+'</div>'}
}
function renderResults(){if(!state)return;$('app').innerHTML='<section class="hero center"><h1>'+esc(state.title)+'</h1><p>Results</p></section>'+podium(state)+'<div class="card">'+leaders(state)+'</div>'}
function loginUI(){
 $('app').innerHTML='<section class="hero"><div class="eyebrow">Quizzy host console</div><h1>Run the show.</h1><p>Enter a Quizzy host code to create games and control a live session.</p></section><section class="card">'+form('loginForm','<label>Private host code</label><input name="code" type="password" autocomplete="off" required><button>Unlock host console</button>')+'</section>';
 bindForm('loginForm',async d=>{sessionStorage.setItem('quizzy_host_code',String(d.get('code')));try{await api('host_login');if(page==='edit')await initEditor();else await initHost()}catch(e){sessionStorage.removeItem('quizzy_host_code');throw e}});
}
async function initHost(){if(!hostCode()){loginUI();return}await api('host_login');quizzes=await api('host_quizzes');sessions=await api('host_sessions');renderHost();if(pin()){subscribe();await refresh()}}
function renderHost(){
 $('app').innerHTML='<section class="hero"><div class="eyebrow">Host dashboard</div><h1>Your Quizzy games.</h1><p>Create a quiz, then host it as many times as you like.</p><a class="action" href="quizzyedit.html">+ Create or edit quiz</a></section>'
 +'<div class="grid"><section class="card"><h2>Start a new game</h2>'+form('newSession','<label>Quiz</label><select name="quiz_id" required>'+quizzes.map(q=>option(q.title,q.id)).join('')+'</select><label>Competition</label><select name="mode">'+option('Individual','solo')+option('Teams','team')+'</select><label>Team names (comma separated for team mode)</label><input name="teams" placeholder="Red, Blue, Green"><label>Scoring</label><select name="score_mode">'+option('Accuracy + speed','speed')+option('Accuracy only','accuracy')+'</select><label>Team scoring</label><select name="team_mode">'+option('Sum','sum')+option('Average','average')+'</select><label>Player phone display</label><select name="display_mode">'+option('Full question and options','both')+option('Answer buttons only','projector')+'</select><label><input type="checkbox" name="streak_enabled"> Streak bonus</label><button '+(!quizzes.length?'disabled':'')+'>Create game</button>')+'</section>'
 +'<section class="card"><h2>Previous games</h2>'+(sessions.length?sessions.map(s=>'<div class="between" style="margin:10px 0"><div><strong>'+esc(s.title)+'</strong><div class="muted small">'+esc(s.pin)+' · '+esc(s.phase)+'</div></div><button class="secondary" onclick="Quizzy.openSession(\''+esc(s.pin)+'\')">Manage</button></div>').join(''):'<p>No sessions yet.</p>')+'</section></div>'
 +(pin()?'<section id="hostSession" class="card"><p>Loading session…</p></section>':'');
 bindForm('newSession',async d=>{
 let teams=String(d.get('teams')||'').split(',').map(x=>x.trim()).filter(Boolean);
 if(d.get('mode')==='team'&&new Set(teams).size<2)throw Error('Enter at least two distinct team names');
 let s=await api('create_session',{quiz_id:d.get('quiz_id'),mode:d.get('mode'),teams:teams,score_mode:d.get('score_mode'),team_mode:d.get('team_mode'),display_mode:d.get('display_mode'),streak_enabled:d.has('streak_enabled')});
 persistPin(s.pin);location.href=link('quizzyhost.html',s.pin);
 });
}
function renderHostSession(){
 if(page!=='host')return;let box=$('hostSession');if(!box){renderHost();box=$('hostSession')}if(!state)return;
 let s=state;const controls=[['start','Start / next question'],['pause','Pause'],['resume','Resume'],['reveal','Reveal answer'],['leaderboard','Show leaderboard'],['next','Next question'],['previous','Previous question'],['reopen','Reopen question'],['skip','Cancel question'],['joining',s.joining_locked?'Unlock joining':'Lock joining'],['rankings',s.rankings_visible?'Hide rankings':'Show rankings'],['finish','End game']];
 box.innerHTML='<div class="between"><div><span class="eyebrow">Game PIN</span><div class="pin">'+esc(s.pin)+'</div><h2>'+esc(s.title)+'</h2><span class="tag">'+esc(s.phase)+'</span></div><div class="stack"><a target="_blank" href="'+link('quizzyprojector.html',s.pin)+'">Open projector ↗</a><a target="_blank" href="'+link('quizzy.html',s.pin)+'">Player join link ↗</a><a target="_blank" href="'+link('quizzyresults.html',s.pin)+'">Results ↗</a></div></div><h2>Live controls</h2><div class="row">'+controls.map(x=>'<button class="'+(['skip','finish','reopen'].includes(x[0])?'danger':'secondary')+'" onclick="Quizzy.control(\''+x[0]+'\')">'+x[1]+'</button>').join('')+'</div>'
 +'<div class="grid"><div class="card"><div class="eyebrow">Current question</div><h2>'+(s.question_index+1)+' / '+s.question_count+'</h2><h3>'+esc(s.question?.text||'Lobby')+'</h3><div id="countdown" class="timer"></div><p>'+((s.answers||[]).filter(a=>a.question_index===s.question_index)).length+' answers received</p></div><div class="card"><h2>Standings</h2>'+leaders(s)+'</div></div>'
 +'<h2>Players ('+s.players.length+')</h2><div class="tablewrap"><table><thead><tr><th>Nickname</th><th>Team</th><th>Score</th><th>Actions</th></tr></thead><tbody>'+s.players.map(x=>'<tr><td>'+esc(x.nickname)+(x.removed?' (removed)':'')+'</td><td>'+esc(x.team||'—')+'</td><td>'+Number(x.score||0)+'</td><td><button class="secondary" onclick="Quizzy.adjust(\''+x.id+'\')">± Points</button> <button class="danger" onclick="Quizzy.removePlayer(\''+x.id+'\')">Remove</button></td></tr>').join('')+'</tbody></table></div>'
 +'<div class="row"><button onclick="Quizzy.exportCSV()">Export results CSV</button><button class="secondary" onclick="Quizzy.exportJSON()">Export full JSON</button><button class="secondary" onclick="Quizzy.refresh()">↻ Refresh</button></div>';
 renderClock(s);
}
async function control(command){
 if(command==='finish'&&!confirm('End this game for everyone?'))return;
 if(command==='reopen'&&!confirm('Reopen this question? All previous answers for this question will be deleted and scores recalculated.'))return;
 if(command==='skip'&&!confirm('Cancel this question and remove its points from rankings?'))return;
 await execute(async()=>{await api('control',{pin:pin(),command,...(command==='reopen'?{confirm:'REOPEN'}:{})});await refresh()});
}
async function adjust(player_id){let raw=prompt('Points adjustment (e.g. 100 or -100):');if(raw===null)return;let delta=Number(raw);if(!Number.isInteger(delta)||Math.abs(delta)>100000)return notice('Enter an integer between -100000 and 100000');await execute(async()=>{await api('adjust',{pin:pin(),player_id,delta,reason:'Manual host adjustment'});await refresh()})}
async function removePlayer(player_id){if(!confirm('Remove this player?'))return;await execute(async()=>{await api('remove_player',{pin:pin(),player_id});await refresh()})}
function csv(rows){if(!rows?.length)return notice('No records to export');let keys=[...new Set(rows.flatMap(o=>Object.keys(o)))];let body=[keys,...rows.map(o=>keys.map(k=>typeof o[k]==='object'?JSON.stringify(o[k]):o[k]??''))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n');download('quizzy-'+pin()+'.csv',body,'text/csv')}
function download(filename,body,mime){let u=URL.createObjectURL(new Blob([body],{type:mime})),a=document.createElement('a');a.href=u;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(u),1500)}
async function exportCSV(){await execute(async()=>{let d=await api('export',{pin:pin()});csv(d.players)})}
async function exportJSON(){await execute(async()=>{let d=await api('export',{pin:pin()});download('quizzy-'+pin()+'.json',JSON.stringify(d,null,2),'application/json')})}
function defaultQuestion(){return {type:'single',text:'',options:['Option A','Option B','Option C','Option D'],correct:['Option A'],seconds:30,points:1000,multi_scoring:'all',value:0,tolerance:0,explanation:''}}
async function initEditor(){if(!hostCode()){loginUI();return}await api('host_login');quizzes=await api('host_quizzes');let id=new URLSearchParams(location.search).get('id');if(id){let q=quizzes.find(x=>x.id===id);if(!q)throw Error('Quiz not found');editor={id,title:q.title,questions:structuredClone(q.content.questions)}}else{editor={id:null,title:'',questions:[defaultQuestion()]}}renderEditor()}
function renderEditor(){
 $('app').innerHTML='<section class="hero"><div class="eyebrow">Quiz creator</div><h1>Make something memorable.</h1><p>Create up to 100 questions; each question gets its own timer.</p></section><div class="card"><label>Quiz title</label><input id="quizTitle" maxlength="150" value="'+attr(editor.title)+'"><div class="row"><button onclick="Quizzy.addQuestion()">+ Add question</button><button onclick="Quizzy.saveEditor()">Save quiz</button><button class="secondary" onclick="Quizzy.importJSON()">Import JSON</button><button class="secondary" onclick="Quizzy.importCSV()">Import CSV</button><button class="secondary" onclick="Quizzy.exportQuiz()">Download JSON</button></div><input type="file" class="hidden" id="fileImport" accept=".json,.csv"></div>'
 +editor.questions.map((q,i)=>'<article class="editor-question"><div class="between"><h2>Question '+(i+1)+'</h2><div class="row"><button class="secondary" onclick="Quizzy.moveQuestion('+i+',-1)">↑</button><button class="secondary" onclick="Quizzy.moveQuestion('+i+',1)">↓</button><button class="danger" onclick="Quizzy.deleteQuestion('+i+')">Delete</button></div></div><label>Question type</label><select data-i="'+i+'" data-field="type">'+[['single','Multiple choice'],['tf','True / False'],['multi','Multiple correct'],['poll','Poll'],['numeric','Numeric answer']].map(x=>option(x[1],x[0])).join('')+'</select><label>Question text</label><textarea data-i="'+i+'" data-field="text">'+esc(q.text)+'</textarea><div class="grid"><div><label>Time limit (5–300 seconds)</label><input type="number" min="5" max="300" data-i="'+i+'" data-field="seconds" value="'+Number(q.seconds||30)+'"></div><div><label>Points</label><input type="number" min="0" max="10000" data-i="'+i+'" data-field="points" value="'+Number(q.points??1000)+'"></div></div>'
 +(q.type==='numeric'?'<label>Correct number</label><input type="number" step="any" data-i="'+i+'" data-field="value" value="'+Number(q.value||0)+'"><label>Accepted tolerance (±)</label><input type="number" min="0" step="any" data-i="'+i+'" data-field="tolerance" value="'+Number(q.tolerance||0)+'">':'<label>Options — check correct answers where applicable</label>'+q.options.map((o,j)=>'<div class="option-row"><input data-i="'+i+'" data-option="'+j+'" value="'+attr(o)+'"><input type="checkbox" aria-label="Correct answer" data-i="'+i+'" data-correct="'+j+'" '+(q.correct.includes(o)?'checked':'')+' '+(q.type==='poll'?'disabled':'')+'></div>').join('')+'<div class="row"><button class="secondary" onclick="Quizzy.addOption('+i+')">+ Option</button><button class="secondary" onclick="Quizzy.removeOption('+i+')">− Option</button></div>'
 +(q.type==='multi'?'<label>Multiple-answer scoring</label><select data-i="'+i+'" data-field="multi_scoring">'+option('All correct required','all')+option('Partial credit','partial')+'</select>':''))
 +'<label>Explanation (optional)</label><textarea data-i="'+i+'" data-field="explanation">'+esc(q.explanation||'')+'</textarea></article>').join('')
 +'<div class="row"><button onclick="Quizzy.addQuestion()">+ Add question</button><button onclick="Quizzy.saveEditor()">Save quiz</button></div>'
 +'<section class="card"><h2>My quiz library</h2>'+quizzes.map(q=>'<div class="between" style="padding:8px 0"><strong>'+esc(q.title)+'</strong><div class="row"><a href="quizzyedit.html?id='+encodeURIComponent(q.id)+'">Edit</a><button class="secondary" onclick="Quizzy.duplicate(\''+q.id+'\')">Duplicate</button><button class="secondary" onclick="Quizzy.share(\''+q.id+'\')">Share</button><button class="danger" onclick="Quizzy.deleteQuiz(\''+q.id+'\')">Delete</button></div></div>').join('')+'</section>';
 document.querySelectorAll('[data-field="type"],[data-field="multi_scoring"]').forEach(n=>{n.value=editor.questions[Number(n.dataset.i)][n.dataset.field]});
 document.querySelectorAll('[data-option]').forEach(n=>n.addEventListener('input',()=>{const i=Number(n.dataset.i),j=Number(n.dataset.option),old=editor.questions[i].options[j];editor.questions[i].options[j]=n.value;editor.questions[i].correct=editor.questions[i].correct.map(x=>x===old?n.value:x)}));
 document.querySelectorAll('[data-correct]').forEach(n=>n.addEventListener('change',()=>{const q=editor.questions[Number(n.dataset.i)],v=q.options[Number(n.dataset.correct)];if(n.checked){q.correct=q.type==='multi'?[...new Set([...q.correct,v])]:[v]}else q.correct=q.correct.filter(x=>x!==v);if(q.type!=='multi')renderEditor()}));
 document.querySelectorAll('[data-field]').forEach(n=>n.addEventListener('change',()=>{let i=Number(n.dataset.i),key=n.dataset.field,value=n.value;editor.questions[i][key]=['seconds','points','value','tolerance'].includes(key)?Number(value):value;if(key==='type'){let q=editor.questions[i];if(value==='tf'){q.options=['True','False'];q.correct=['True']}if(value==='numeric'||value==='poll')q.correct=[];renderEditor()}}));
 $('quizTitle').addEventListener('input',e=>editor.title=e.target.value);
}
function addQuestion(){if(editor.questions.length>=100)return notice('Maximum 100 questions');editor.questions.push(defaultQuestion());renderEditor()}
function deleteQuestion(i){if(editor.questions.length===1)return notice('At least one question required');editor.questions.splice(i,1);renderEditor()}
function moveQuestion(i,d){let j=i+d;if(j<0||j>=editor.questions.length)return;[editor.questions[i],editor.questions[j]]=[editor.questions[j],editor.questions[i]];renderEditor()}
function addOption(i){let q=editor.questions[i];if(q.options.length>=6)return notice('Maximum six options');q.options.push('Option '+String.fromCharCode(65+q.options.length));renderEditor()}
function removeOption(i){let q=editor.questions[i];if(q.options.length<=2)return notice('Minimum two options');q.correct=q.correct.filter(x=>x!==q.options.at(-1));q.options.pop();renderEditor()}
async function saveEditor(){await execute(async()=>{if(!editor.title.trim())throw Error('Quiz title required');for(let q of editor.questions){if(!q.text.trim())throw Error('Every question requires text');if(q.type==='single'||q.type==='tf'){if(q.correct.length!==1)throw Error('Single-choice questions need exactly one correct answer')}if(q.type==='multi'&&!q.correct.length)throw Error('Multi-answer questions need at least one correct answer')}let saved=await api('save_quiz',{id:editor.id,title:editor.title,questions:editor.questions});editor.id=saved.id;notice('Saved!');quizzes=await api('host_quizzes');history.replaceState(null,'','quizzyedit.html?id='+saved.id);renderEditor()})}
async function duplicate(id){await execute(async()=>{let q=quizzes.find(x=>x.id===id);let saved=await api('save_quiz',{title:q.title+' (copy)',questions:q.content.questions});location.href='quizzyedit.html?id='+saved.id})}
function share(id){let q=quizzes.find(x=>x.id===id),url=new URL('quizzyedit.html',location.href);url.searchParams.set('share',q.share_token);navigator.clipboard?.writeText(url.href).then(()=>notice('Share link copied: '+url.href),()=>prompt('Copy share link:',url.href))}
async function deleteQuiz(id){if(!confirm('Delete this saved quiz? Previous sessions will remain.'))return;await execute(async()=>{await api('delete_quiz',{id});quizzes=await api('host_quizzes');renderEditor()})}
function importJSON(){importFile('.json',async text=>{let data=JSON.parse(text);if(!Array.isArray(data.questions))throw Error('Expected a JSON object containing questions[]');editor={id:null,title:data.title||'Imported quiz',questions:data.questions};renderEditor()})}
function parseCSV(text){let rows=[],row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){let c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell=''}else cell+=c}row.push(cell);if(row.some(x=>x.trim()))rows.push(row);return rows}
function importCSV(){importFile('.csv',async text=>{let rows=parseCSV(text),headers=rows.shift()?.map(x=>x.trim().toLowerCase());if(!headers?.includes('question')||!headers.includes('type'))throw Error('CSV needs question and type headers');let qs=rows.map(row=>{let r=Object.fromEntries(headers.map((h,i)=>[h,row[i]||''])),q=defaultQuestion();q.text=r.question;q.type=r.type;q.seconds=Number(r.seconds||30);q.points=Number(r.points||1000);q.options=(r.options||'').split('|').map(x=>x.trim()).filter(Boolean);q.correct=(r.correct||'').split('|').map(x=>x.trim()).filter(Boolean);q.value=Number(r.value||0);q.tolerance=Number(r.tolerance||0);q.multi_scoring=r.multi_scoring||'all';q.explanation=r.explanation||'';if(q.type==='tf'&&!q.options.length)q.options=['True','False'];return q});editor={id:null,title:'Imported quiz',questions:qs};renderEditor()})}
function importFile(accept,handler){let input=$('fileImport');input.accept=accept;input.onchange=async()=>{if(!input.files?.[0])return;await execute(async()=>handler(await input.files[0].text()))};input.click()}
function exportQuiz(){download((editor.title||'quizzy')+'.json',JSON.stringify({title:editor.title,questions:editor.questions},null,2),'application/json')}
async function openShare(){let token=new URLSearchParams(location.search).get('share');if(!token)return false;let q=await api('shared_quiz',{token});editor={id:null,title:q.title+' (copy)',questions:q.content.questions};quizzes=await api('host_quizzes');renderEditor();notice('Shared quiz loaded as an independent copy. Save to add it to your library.');return true}
async function init(){
 try{
 await initAuth();
 if(page==='join'){
   const p=new URLSearchParams(location.search).get('pin');
   if(p){try{state=await api('public_state',{pin:p})}catch(e){notice(e.message)}}
   renderJoin();
 }else if(page==='host'){await initHost()}
 else if(page==='edit'){if(!hostCode())loginUI();else if(!(await openShare()))await initEditor()}
 else {if(!pin()){location.href='quizzy.html';return}subscribe();await refresh()}
 if(['host','play','projector','results'].includes(page)){
   setInterval(()=>{if(state)renderClock(state)},300);
   setInterval(()=>{if(!document.hidden)refresh()},5000);
   document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
 }
 }catch(e){toastError(e);if(page==='host'||page==='edit')loginUI()}
}
window.Quizzy={logout(){sessionStorage.removeItem('quizzy_host_code');location.href='quizzyhost.html'},refresh,choose,lockMulti,answerNumber,control,adjust,removePlayer,exportCSV,exportJSON,openSession(p){persistPin(p);location.href=link('quizzyhost.html',p)},addQuestion,deleteQuestion,moveQuestion,addOption,removeOption,saveEditor,duplicate,share,deleteQuiz,importJSON,importCSV,exportQuiz};
init();
})();