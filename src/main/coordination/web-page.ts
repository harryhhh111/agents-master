/** Extend the existing login/composer/IME/retry/scroll UI only for explicit preview.
 *  wording='real-model' 时把"模拟"字样替换为真实模型标识；执行工具仍为受限合成。 */
export function coordinationPage(base: string, wording: 'synthetic' | 'real-model' = 'synthetic'): string {
  const page = base
    .replace('<h1>主 Agent</h1>', '<h1>模拟 / 联调 · 无真实项目执行</h1>')
    .replace('<details id="settings"', '<nav><button id="conversation-main">主 Agent · 置顶</button><button id="conversation-work">工作项目群 · 模拟</button><span id="scope-label">主 Agent</span></nav><details><summary>模拟任务与待答问题</summary><div id="coordination-cards" style="max-height:25vh;overflow:auto"></div></details><details id="settings"')
    .replace("const setupStorageKey=", "let conversation='main',cardSnapshot='';const drafts=new Map();\nconst setupStorageKey=")
    .replace("const generation=viewGeneration,revision=eventRevision;sending=true;", "if(!failedSends.includes(attempt))failedSends.push(attempt);const generation=viewGeneration,revision=eventRevision;sending=true;")
    .replace("async function request(url,options){", "function scopedUrl(url){return ['/api/history','/api/status','/api/messages','/api/events','/api/recover','/api/control'].some(p=>url.split('?')[0]===p)?url+(url.includes('?')?'&':'?')+'conversation='+encodeURIComponent(conversation):url}\nasync function request(url,options){")
    .replace("fetch(channelUrl(url),{...options", "fetch(channelUrl(scopedUrl(url)),{...options")
    .replace("new EventSource(channelUrl('/api/events?cursor='+encodeURIComponent(cursor)))", "new EventSource(channelUrl(scopedUrl('/api/events?cursor='+encodeURIComponent(cursor))))")
    .replace("role.textContent=message.role==='assistant'?'主 Agent':'你'", "role.textContent=({'user':'你','main-agent':'主 Agent','fake-work-agent':'工作项目 Agent · 模拟','runtime':'系统 · 模拟'})[message.author]||'系统'")
    .replace("if(seen.has(message.id))return;", "if(message.conversation_id!==conversation||seen.has(message.id))return;")
    .replace("const current=await request('/api/status');if(!active(generation))return;", "const current=await request('/api/status');if(!active(generation))return;renderCards(current);")
    .replace("viewGeneration++;stopPolling();", "viewGeneration++;drafts.clear();answerDrafts.clear();answerFocus.clear();controlKeys.clear();uncertainControls.clear();rejectedControls.clear();cardSnapshot='';document.querySelector('#coordination-cards').replaceChildren();stopPolling();")
    .replace('initialize();\n</script>', `
function switchConversation(next){
  if(next===conversation)return;
  rememberAnswerFocus();drafts.set(conversation,{text:input.value,failed:failedSends});conversation=next;
  const saved=drafts.get(next);input.value=saved?.text||'';failedSends=saved?.failed||[];
  messages.replaceChildren();seen.clear();cardSnapshot='';document.querySelector('#coordination-cards').replaceChildren();
  sending=false;recovering=false;composing=false;draftRevision++;eventRevision++;replyState='idle';replyError='';
  document.querySelector('#scope-label').textContent=next==='main'?'主 Agent':'工作项目群（默认领域 Agent；@main 呼叫主 Agent）';
  renderSendErrors();void load();
}
document.querySelector('#conversation-main').onclick=()=>switchConversation('main');
document.querySelector('#conversation-work').onclick=()=>switchConversation('fake-work');
${coordinationCardsScript}
const controlKeys=new Map();let pendingControls=0;const uncertainControls=new Set();const rejectedControls=new Map();
// 切换守卫扩展钩子（稳定版页面不存在这两个函数，基础守卫用 typeof 探测）：
// 待确认的控制提交硬阻止切换；回答草稿、其他会话草稿与未确认/被拒控制提交纳入“丢弃未提交内容”确认。
function extraSwitchBlock(){return pendingControls>0?'提交尚未确认，请完成或超时后再切换。':undefined}
function extraSwitchDirty(){if(uncertainControls.size||rejectedControls.size)return true;for(const text of answerDrafts.values()){if(text.trim())return true}for(const draft of drafts.values()){if(draft.text.trim()||draft.failed.length)return true}return false}
// 控制提交超时/5xx 后保持“接收状态未知”提示；被明确拒绝时保留原因。两者都不被轮询清空。
function extraErrorText(){
  if(uncertainControls.size)return '有提交尚未确认是否送达：可再次点击重试，相同提交不会重复执行。'
  const rejected=rejectedControls.values().next().value
  return rejected?'提交未被接受：'+rejected:''
}
async function control(kind,id,content,button){if(!content.trim())return;const generation=viewGeneration;const signature=JSON.stringify([conversation,kind,id,content]);if(!controlKeys.has(signature))controlKeys.set(signature,crypto.randomUUID());button.disabled=true;pendingControls++;
try{await request('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,id,content,idempotencyKey:controlKeys.get(signature)})});if(active(generation)){uncertainControls.delete(signature);rejectedControls.delete(signature);const state=await request('/api/status');if(active(generation))renderCards(state)}}
catch(e){if(active(generation)){if(!e.status||e.status>=500)uncertainControls.add(signature);else rejectedControls.set(signature,e.message||'请求被拒绝。');renderState()}}
finally{pendingControls--;if(active(generation)){button.disabled=false;renderState()}}}
initialize();
</script>`)
  if (wording === 'synthetic') return page
  return page
    .replace('模拟 / 联调 · 无真实项目执行', '真实模型 · 受限工具（无真实项目执行）')
    .replace('工作项目群 · 模拟', '工作项目群')
    .replace('工作项目 Agent · 模拟', '工作项目 Agent')
    .replace('系统 · 模拟', '系统')
    .replace('模拟任务与待答问题', '任务与待答问题')
    .replaceAll('模拟任务 ', '任务 ')
    .replaceAll('模拟问题 · ', '问题 · ')
    .replace('回答模拟问题', '回答问题')
    .replace('请求取消模拟任务', '请求取消任务')
}

/** Shared by generated UI and DOM regression fixtures; contains no private data. */
export const coordinationCardsScript = `
const answerDrafts=new Map(),answerFocus=new Map();
function rememberAnswerFocus(){
  const field=document.activeElement;
  if(field?.dataset?.questionInput){const key=conversation+':'+field.dataset.questionInput;answerDrafts.set(key,field.value);answerFocus.set(conversation,{id:field.dataset.questionInput,start:field.selectionStart,end:field.selectionEnd})}
}
function renderCards(state){
  const snapshot=JSON.stringify([state.assignments,state.questions]);if(snapshot===cardSnapshot)return;
  rememberAnswerFocus();cardSnapshot=snapshot;
  const target=document.querySelector('#coordination-cards'),old=new Map(Array.from(target.children).map(row=>[row.dataset.cardKey,row])),keep=new Set();
  function getRow(key){let row=old.get(key);if(!row){row=document.createElement('div');row.dataset.cardKey=key;row.label=document.createElement('span');row.append(row.label);target.append(row)}keep.add(key);return row}
  for(const a of state.assignments||[]){const row=getRow('a:'+a.id);row.dataset.assignment=a.id;row.label.textContent='模拟任务 '+a.id.slice(0,8)+' · '+a.status;
    if(['queued','running','waiting_input'].includes(a.status)){if(!row.button){const b=document.createElement('button');b.textContent='取消';b.dataset.cancel=a.id;b.onclick=()=>control('cancel',a.id,'请求取消模拟任务',b);row.append(b);row.button=b}}
    else if(row.button){row.button.remove();row.button=null}}
  for(const q of state.questions||[]){const row=getRow('q:'+q.id);row.dataset.question=q.id;row.label.textContent='模拟问题 · '+q.body+' · '+q.status;const key=conversation+':'+q.id;
    if(q.status==='pending'&&!row.field){const answer=document.createElement('input');answer.dataset.questionInput=q.id;answer.setAttribute('aria-label','回答模拟问题');answer.value=answerDrafts.get(key)||'';answer.oninput=()=>answerDrafts.set(key,answer.value);
      const b=document.createElement('button');b.textContent='提交回答';b.dataset.answer=q.id;b.onclick=()=>control('answer',q.id,answer.value,b);row.append(answer,b);row.field=answer;row.button=b;
      const focus=answerFocus.get(conversation);if(focus?.id===q.id){answer.focus();answer.setSelectionRange(focus.start,focus.end)}
    }else if(q.status!=='pending'){answerDrafts.delete(key);if(answerFocus.get(conversation)?.id===q.id)answerFocus.delete(conversation);row.field?.remove();row.button?.remove();row.field=null;row.button=null}}
  for(const [key,row] of old)if(!keep.has(key))row.remove();
}
`
