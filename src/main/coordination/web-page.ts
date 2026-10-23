/** 预览通道独立单文件模板：IM 形态（左栏会话列表 + 右栏气泡消息流 + 内嵌任务/问题卡）。
 *  不再叠加稳定版基页字符串补丁；API 客户端、控制提交、草稿、SSE/轮询与离开守卫沿用既有语义。
 *  wording='real-model'/'real-cli' 时把"模拟"字样替换为真实能力标识；real-cli 再加真实执行说明。 */
export type CoordinationWording = 'synthetic' | 'real-model' | 'real-cli'

export interface CoordinationPageConfig {
  businessApiBase: '/api' | '/preview/api'
  authApiBase: '/api'
  releaseId: string
  previewLabel: string
  /** 常驻部署（稳定入口 + worker）时展示返回稳定版入口；独立演示入口无稳定版可回，隐藏。 */
  stableLink: boolean
}

const defaultCoordinationPageConfig: CoordinationPageConfig = {
  businessApiBase: '/api',
  authApiBase: '/api',
  releaseId: 'coordination-preview-local',
  previewLabel: '预览版 · 模拟演示',
  stableLink: false,
}

export function coordinationPage(config: Partial<CoordinationPageConfig> = {}, wording: CoordinationWording = 'synthetic'): string {
  const merged = { ...defaultCoordinationPageConfig }
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value
  }
  const page = coordinationPageTemplate
    .replace('__COORDINATION_PAGE_CONFIG__', JSON.stringify(merged).replace(/</g, '\\u003c'))
    .replace('__PREVIEW_LABEL__', merged.previewLabel.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  if (wording === 'synthetic') return page
  const real = page
    .replace('模拟 / 联调 · 无真实项目执行', '真实模型 · 受限工具（无真实项目执行）')
    .replace('工作项目群 · 模拟', '工作项目群')
    .replace('工作项目 Agent · 模拟', '工作项目 Agent')
    .replace('系统 · 模拟', '系统')
    .replaceAll('模拟任务 ', '任务 ')
    .replaceAll('模拟问题 · ', '问题 · ')
    .replace('回答模拟问题', '回答问题')
    .replace('请求取消模拟任务', '请求取消任务')
  if (wording === 'real-model') return real
  return real.replace('真实模型 · 受限工具（无真实项目执行）', '真实模型 · 真实执行（限白名单项目）')
}

/** Shared by generated UI and DOM regression fixtures; contains no private data. */
export const coordinationCardsScript = `
const answerDrafts=new Map(),answerFocus=new Map();
const cardNodes=new Map();let cardSnapshot='';const cancelling=new Set();
function rememberAnswerFocus(){
  const field=document.activeElement;
  if(field?.dataset?.questionInput){const key=conversation+':'+field.dataset.questionInput;answerDrafts.set(key,field.value);answerFocus.set(conversation,{id:field.dataset.questionInput,start:field.selectionStart,end:field.selectionEnd})}
}
function assignmentStatusText(s){return ({queued:'排队',running:'进行中',waiting_input:'待回答',completed:'已完成',failed:'已失败',cancelled:'已取消',interrupted:'已中断',unknown:'状态未知'})[s]||s}
function questionStatusText(s){return ({pending:'待回答',answered:'已回答',revoked:'已撤销'})[s]||s}
function activeAssignmentStatus(s){return ['queued','running','waiting_input'].includes(s)}
function cardUnfinished(card){return card.dataset.cardKey.startsWith('a:')?activeAssignmentStatus(card.status):card.status==='pending'}
function findAnchor(presentation,assignmentId,runId){
  const flow=document.querySelector('#messages');let found;
  for(const row of Array.from(flow.children)){const d=row.dataset||{};if(d.presentation!==presentation)continue;if(assignmentId&&d.assignmentId!==assignmentId)continue;if(runId&&d.runId!==runId)continue;found=row}
  return found
}
function renderCards(state){
  const snapshot=JSON.stringify([conversation,state.assignments,state.questions,state.execution]);if(snapshot===cardSnapshot)return;
  rememberAnswerFocus();cardSnapshot=snapshot;
  const keep=new Set();
  if(conversation==='fake-work'){
    for(const a of state.assignments||[]){
      const key='a:'+a.id;keep.add(key);let card=cardNodes.get(key);
      if(!card){card=document.createElement('div');card.className='card task-card';card.dataset.cardKey=key;card.dataset.assignment=a.id;
        card.titleEl=document.createElement('p');card.titleEl.className='card-title';card.metaEl=document.createElement('p');card.metaEl.className='card-meta';card.append(card.titleEl,card.metaEl);cardNodes.set(key,card)}
      card.status=a.status;
      const anchor=findAnchor('dispatch',a.id,null);
      card.titleEl.textContent='模拟任务 '+(anchor&&anchor.dataset.objective?anchor.dataset.objective:a.id.slice(0,8));
      card.metaEl.textContent='状态：'+assignmentStatusText(a.status)+' · '+(state.execution==='cli'?'真实 CLI':'合成');
      if(!activeAssignmentStatus(a.status))cancelling.delete(a.id);
      if(activeAssignmentStatus(a.status)&&!card.button){const b=document.createElement('button');b.textContent='取消';b.dataset.cancel=a.id;
        b.onclick=()=>{cancelling.add(a.id);b.textContent='取消中…';b.disabled=true;void control('cancel',a.id,'请求取消模拟任务',b)};
        card.append(b);card.button=b}
      if(card.button&&activeAssignmentStatus(a.status)){if(cancelling.has(a.id)){card.button.textContent='取消中…';card.button.disabled=true}else{card.button.textContent='取消';card.button.disabled=false}}
      if(!activeAssignmentStatus(a.status)&&card.button){card.button.remove();card.button=null}
    }
    for(const q of state.questions||[]){
      const key='q:'+q.id;keep.add(key);let card=cardNodes.get(key);
      if(!card){card=document.createElement('div');card.className='card question-card';card.dataset.cardKey=key;card.dataset.question=q.id;card.dataset.assignment=q.assignment_id;if(q.run_id)card.dataset.runId=q.run_id;
        card.titleEl=document.createElement('p');card.titleEl.className='card-title';card.bodyEl=document.createElement('p');card.bodyEl.className='card-body';card.append(card.titleEl,card.bodyEl);cardNodes.set(key,card)}
      card.status=q.status;
      card.titleEl.textContent='模拟问题 · '+questionStatusText(q.status);
      card.bodyEl.textContent=q.body;
      const draftKey=conversation+':'+q.id;
      if(q.status==='pending'&&!card.field){const answer=document.createElement('input');answer.dataset.questionInput=q.id;answer.setAttribute('aria-label','回答模拟问题');answer.value=answerDrafts.get(draftKey)||'';answer.oninput=()=>answerDrafts.set(draftKey,answer.value);
        const b=document.createElement('button');b.textContent='提交回答';b.dataset.answer=q.id;b.onclick=()=>control('answer',q.id,answer.value,b);card.append(answer,b);card.field=answer;card.button=b;
        const focus=answerFocus.get(conversation);if(focus?.id===q.id){answer.focus();answer.setSelectionRange(focus.start,focus.end)}
      }else if(q.status!=='pending'){answerDrafts.delete(draftKey);if(answerFocus.get(conversation)?.id===q.id)answerFocus.delete(conversation);card.field?.remove();card.button?.remove();card.field=null;card.button=null}
    }
  }
  for(const [key,card] of cardNodes)if(!keep.has(key)){card.remove();cardNodes.delete(key)}
  placeCards();
}
function placeCards(){
  const todo=document.querySelector('#todo-area');
  for(const card of cardNodes.values()){
    const anchor=card.dataset.cardKey.startsWith('a:')?findAnchor('dispatch',card.dataset.assignment,null):(findAnchor('receipt',null,card.dataset.runId)||findAnchor('receipt',card.dataset.assignment,null));
    // 已在正确位置的卡片保持原样：重挂载会打断回答框焦点（真实 DOM 属性是 parentNode）。
    if(anchor){if(card.parentNode!==anchor)anchor.append(card)}
    else if(cardUnfinished(card)){if(card.parentNode!==todo)todo.append(card)}
    else card.remove();
  }
  todo.hidden=todo.children.length===0;
  renderTodoEntry();
}
function renderTodoEntry(){
  const jump=document.querySelector('#todo-jump');if(!jump)return;
  let n=0;for(const card of cardNodes.values())if(cardUnfinished(card))n++;
  jump.hidden=n===0||conversation!=='fake-work';jump.textContent='待办 '+n;
}
`

const coordinationPageTemplate = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>主 Agent</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}body{font:16px/1.6 system-ui,sans-serif;color:#202c32;background:#edf1f3}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #cbd5da;border-radius:12px;padding:.5rem .85rem;background:#fff;color:inherit;touch-action:manipulation}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #087d69;outline-offset:2px}[hidden]{display:none!important}h1,h2,p,ul{margin:0}ul{padding:0;list-style:none}#app{height:100vh;height:100dvh}#im-layout{display:flex;height:100%}
#sidebar{width:280px;flex:none;background:#f4f7f8;border-right:1px solid #dee5e8;display:flex;flex-direction:column;min-height:0}.sidebar-head{padding:.85rem 1rem;border-bottom:1px solid #e2e8eb}h1{font-size:1.05rem}
#conversation-list{flex:1;min-height:0;overflow-y:auto;padding:.5rem}.conv-item{display:flex;align-items:center;gap:.5rem;padding:.6rem .7rem;border-radius:12px;cursor:pointer;margin-bottom:.2rem}.conv-item:hover{background:#eaf0f2}.conv-item.active{background:#dcebe6}.conv-text{flex:1;min-width:0;display:flex;flex-direction:column}.conv-name{font-weight:600;font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conv-preview{font-size:.75rem;color:#63737b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:1.1em}.conv-side{display:flex;align-items:center;gap:.3rem;flex:none}.conv-badge{font-size:.68rem;border-radius:999px;padding:.05rem .45rem;background:#e3e9ec;color:#52636c;white-space:nowrap}.conv-badge.urgent{background:#fde8e8;color:#a12525}.conv-warn{width:.95rem;height:.95rem;border-radius:50%;background:#d98e04;color:#fff;font-size:.62rem;display:inline-flex;align-items:center;justify-content:center;flex:none}
.sidebar-foot{border-top:1px solid #e2e8eb;padding:.55rem 1rem;font-size:.8rem;display:grid;gap:.45rem}.capability{font-size:.72rem;color:#63737b}#version-switch{display:flex;align-items:center;flex-wrap:wrap;gap:.3rem .5rem}#version-current{color:#63737b;font-size:.75rem;flex:1 1 100%;overflow-wrap:anywhere}#to-stable{color:#087d69;text-decoration:none;border:1px solid #b8d9d1;border-radius:999px;padding:.15rem .55rem;white-space:nowrap}#open-settings{justify-self:start;font-size:.85rem;padding:.35rem .9rem}
.modal-backdrop{position:fixed;inset:0;z-index:20;background:#20303040;display:flex;align-items:center;justify-content:center;padding:1rem}.modal{background:#fff;border-radius:16px;width:100%;max-width:520px;max-height:85vh;overflow:auto;padding:1rem 1.25rem;box-shadow:0 8px 40px #20303030}.modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem}#close-settings{border:none;font-size:1.2rem;line-height:1;padding:.25rem .55rem}
.settings-body{padding:.4rem 0 .2rem;font-size:.85rem}.settings-body p{color:#63737b;margin:.5rem 0}.settings-body textarea{display:block;width:100%;min-height:7rem;resize:vertical;max-height:24vh;padding:.6rem;border:1px solid #cbd5da;border-radius:10px}.settings-body button{margin-top:.5rem}
#sidebar-handle{width:5px;flex:none;cursor:col-resize;background:transparent;touch-action:none}#sidebar-handle:hover,#sidebar-handle:active{background:#b8d9d1}
#chat-panel{flex:1;min-width:0;display:flex;flex-direction:column;background:#f7f9fa}#chat-header{display:flex;align-items:center;gap:.7rem;padding:.55rem 1rem;border-bottom:1px solid #dee5e8;background:#fff;flex:none}#back-to-list{display:none;font-size:.85rem;padding:.3rem .6rem}.chat-heading{flex:1;min-width:0}#chat-title{font-size:1rem}#chat-subtitle{font-size:.72rem;color:#63737b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#todo-jump{font-size:.75rem;padding:.25rem .6rem;flex:none}.status{font-size:.78rem;color:#63737b;white-space:nowrap;flex:none}
.control-banner{flex:none;background:#fdf6e3;border-bottom:1px solid #f0e2b6;color:#8a5a00;font-size:.82rem;padding:.45rem 1rem}.control-banner p{margin:.1rem 0}
.todo-area{flex:none;background:#fff;border-bottom:1px solid #dee5e8;padding:.5rem 1rem;max-height:30vh;overflow:auto}
.conversation{position:relative;flex:1;min-height:0}.messages{height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;overflow-anchor:none;padding:1rem;padding-inline:max(1rem,calc((100% - 720px)/2))}
.message{display:flex;flex-direction:column;align-items:flex-start;margin:0 0 .9rem;min-width:0}.message.user{align-items:flex-end}.message.runtime{align-items:center}.runtime-note{font-size:.75rem;color:#8a979e;text-align:center;max-width:80%}.time-divider{justify-content:center;font-size:.72rem;color:#8a979e;text-align:center;margin:.4rem 0 .9rem}
.bubble-wrap{max-width:78%;min-width:0;display:flex;flex-direction:column;align-items:flex-start}.user .bubble-wrap{align-items:flex-end}.agent-head{display:flex;align-items:center;gap:.4rem;margin:0 .3rem .25rem}.avatar{width:1.6rem;height:1.6rem;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.75rem;color:#fff;background:#087d69;flex:none}.avatar.work{background:#5b6abf}.agent-name{font-size:.72rem;color:#63737b}
.bubble{min-width:0;padding:.55rem .8rem;border-radius:16px 16px 16px 4px;background:#fff;border:1px solid #e2e8eb;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.bubble.main{border-left:3px solid #087d69}.bubble.work{background:#f0f2fc;border-color:#dfe3f5;border-left:3px solid #5b6abf}.user .bubble{background:#d9f3e9;border-color:#c3e7da;border-radius:16px 16px 4px 16px}.chip{display:inline-block;font-size:.65rem;border-radius:6px;padding:0 .35rem;background:#087d69;color:#fff;margin-right:.4rem;vertical-align:.12em}.work .chip,.chip.work{background:#5b6abf}
.card{border:1px solid #e2d9c8;background:#fffcf5;border-radius:12px;padding:.55rem .75rem;margin-top:.4rem;font-size:.85rem;max-width:100%;min-width:14rem}.message>.card{max-width:78%}.todo-area .card{margin:.35rem 0}.card-title{font-weight:600;font-size:.85rem}.card-meta,.card-body{margin:.15rem 0;font-size:.8rem;color:#52636c;overflow-wrap:anywhere}.card input{border:1px solid #cbd5da;border-radius:8px;padding:.35rem .5rem;margin-right:.4rem;font-size:.85rem;max-width:60%}.card button{font-size:.78rem;padding:.25rem .6rem;margin-top:.3rem}
.empty-state{position:absolute;top:30%;left:1rem;right:1rem;text-align:center;color:#63737b;pointer-events:none}.latest{position:absolute;bottom:.75rem;left:50%;transform:translateX(-50%);box-shadow:0 2px 10px #20303020;white-space:nowrap;font-size:.85rem}
.feedback{flex:none;padding:0 1rem;background:#fff;max-height:25vh;overflow:auto;font-size:.85rem}.error{color:#a12525;overflow-wrap:anywhere}.error:not(:empty){padding:.4rem 0}.send-failure{padding:.5rem 0;border-bottom:1px solid #edf1f3;overflow-wrap:anywhere}.send-failure button{font-size:.8rem;padding:.2rem .5rem;margin-left:.5rem}
.composer{flex:none;background:#fff;border-top:1px solid #dee5e8;padding:.65rem 1rem max(.65rem,env(safe-area-inset-bottom))}.chat{display:flex;align-items:flex-end;gap:.6rem;min-width:0}.chat textarea{display:block;flex:1;min-width:0;width:0;resize:none;min-height:46px;max-height:160px;overflow-y:auto;border:1px solid #cbd5da;border-radius:14px;padding:.6rem .75rem;line-height:1.5}.chat button{background:#087d69;color:#fff;border-color:#087d69;min-height:46px}.turn-dot{width:.55rem;height:.55rem;border-radius:50%;background:#d98e04;align-self:center;flex:none}.hint{font-size:.72rem;color:#63737b;margin-top:.25rem}
#reload-chat{align-self:center;margin:.5rem}
#login-panel{position:fixed;inset:0;z-index:10;background:#f7f9fa;padding:1.5rem;overflow:auto}#login-panel form{display:grid;gap:.8rem;max-width:400px}#login-panel input{display:block;width:100%;min-width:0;border:1px solid #cbd5da;padding:.6rem;border-radius:10px}#login-panel p{margin-top:.75rem;font-size:.85rem}
@media(max-width:767px){#sidebar{display:none;width:100%!important;border-right:none}#sidebar-handle{display:none}body.show-list #sidebar{display:flex}body.show-list #chat-panel{display:none}#back-to-list{display:inline-block}.messages{padding:.8rem}.bubble-wrap{max-width:88%}.hint{display:none}#chat-subtitle{display:none}}
@media(pointer:coarse){.hint{display:none}}
</style>
<main id="app">
<section id="login-panel" hidden><h2 id="login-title">登录</h2><form id="login"><label id="setup-credential-panel" hidden>初始化凭据<input id="setup-credential" type="password" aria-label="初始化凭据" autocomplete="off" maxlength="200"></label><input id="password" type="password" aria-label="密码" autocomplete="current-password" minlength="8" maxlength="256" required><button id="login-button">登录</button></form><p id="login-notice"></p><p id="login-error" class="error" role="alert"></p></section>
<div id="im-layout" hidden>
<aside id="sidebar">
<div class="sidebar-head"><h1>主 Agent</h1></div>
<ul id="conversation-list" aria-label="会话列表"></ul>
<div class="sidebar-foot"><p id="app-capability" class="capability">模拟 / 联调 · 无真实项目执行</p><nav id="version-switch" hidden><span id="version-current">当前：__PREVIEW_LABEL__</span><a id="to-stable" href="/">稳定版</a></nav>
<button id="open-settings" type="button">设置</button>
</div>
</aside>
<div id="sidebar-handle" aria-hidden="true"></div>
<section id="chat-panel">
<header id="chat-header"><button id="back-to-list" type="button">‹ 会话</button><div class="chat-heading"><h2 id="chat-title">主 Agent</h2><p id="chat-subtitle">一对一 · 置顶</p></div><button id="todo-jump" type="button" hidden>待办 0</button><p id="status" class="status" role="status">正在连接…</p></header>
<div id="control-banner" class="control-banner" role="alert" hidden></div>
<div id="todo-area" class="todo-area" hidden></div>
<div id="memory-area" class="todo-area" hidden></div>
<div class="conversation"><div id="messages" class="messages" role="log" aria-label="聊天记录" aria-live="polite" tabindex="0"></div><p id="empty-state" class="empty-state">正在加载聊天…</p><button id="latest" class="latest" type="button" hidden>回到最新</button></div>
<div class="feedback"><p id="error" class="error" role="alert"></p><button id="recover" type="button" hidden>重试回复</button><div id="send-errors" aria-live="polite"></div></div><button id="reload-chat" type="button" hidden>重新加载聊天</button>
<div class="composer"><form id="chat" class="chat"><textarea id="message" rows="1" aria-label="消息" placeholder="聊点什么…" autocomplete="off" maxlength="8000" enterkeyhint="enter"></textarea><span id="turn-dot" class="turn-dot" hidden title="回合进行中"></span><button id="send" disabled>发送</button></form><p class="hint">Enter 发送 · Shift + Enter 换行</p></div>
</section>
</div>
<div id="settings-modal" class="modal-backdrop" hidden><div class="modal" role="dialog" aria-modal="true" aria-label="设置"><div class="modal-head"><h2>设置</h2><button id="close-settings" type="button" aria-label="关闭设置">×</button></div><div class="settings-body"><h2>主人上下文</h2><p>你明确维护的稳定背景，不是自动记忆。保存后仅影响未来回合。</p><textarea id="owner" aria-label="主人上下文" maxlength="12000"></textarea><button id="save-owner" type="button">明确保存主人上下文</button><p id="owner-status" role="status"></p><p>预览通道与稳定版数据相互独立。</p><h2>清空对话</h2><p>删除该会话的全部消息记录，不可恢复；清空工作项目群会同时删除其中的任务与问题记录。对话正在处理中时不能清空。</p><button id="clear-main" type="button">清空主 Agent 对话</button> <button id="clear-group" type="button">清空工作项目群</button><p id="clear-status" role="status"></p><h2>已确认的记忆</h2><p>模型提议、你明确确认过的关于你的事实，会进入后续对话的背景。删除后不再使用。</p><ul id="memory-list"></ul><button id="logout" type="button">退出登录</button></div></div></div>
</main>
<script>
const appConfig=__COORDINATION_PAGE_CONFIG__;
function channelUrl(url){const base=url.startsWith('/api/auth')?appConfig.authApiBase:appConfig.businessApiBase;return base==='/api'?url:base+url.slice('/api'.length)}
function scopedUrl(url){if(url.includes('conversation='))return url;return ['/api/history','/api/status','/api/messages','/api/events','/api/recover','/api/control'].some(p=>url.split('?')[0]===p)?url+(url.includes('?')?'&':'?')+'conversation='+encodeURIComponent(conversation):url}
const messages=document.querySelector('#messages'),status=document.querySelector('#status'),error=document.querySelector('#error'),input=document.querySelector('#message'),owner=document.querySelector('#owner');
const banner=document.querySelector('#control-banner'),todoJump=document.querySelector('#todo-jump'),chatTitle=document.querySelector('#chat-title'),chatSubtitle=document.querySelector('#chat-subtitle'),listEl=document.querySelector('#conversation-list');
const loginPanel=document.querySelector('#login-panel'),privatePanel=document.querySelector('#im-layout'),password=document.querySelector('#password'),loginError=document.querySelector('#login-error');
const sendButton=document.querySelector('#send'),recoverButton=document.querySelector('#recover'),latest=document.querySelector('#latest'),emptyState=document.querySelector('#empty-state'),sendErrors=document.querySelector('#send-errors'),reloadButton=document.querySelector('#reload-chat'),ownerStatus=document.querySelector('#owner-status'),turnDot=document.querySelector('#turn-dot');
const setupStorageKey='agents-main-web-pending-setup';
const fragmentSetupToken=new URLSearchParams(location.hash.slice(1)).get('setup_token');
let setupToken=fragmentSetupToken;
try{if(fragmentSetupToken!==null){if(fragmentSetupToken)sessionStorage.setItem(setupStorageKey,fragmentSetupToken);else sessionStorage.removeItem(setupStorageKey)}else setupToken=sessionStorage.getItem(setupStorageKey)}catch(e){}
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
let stream,pollTimer,viewGeneration=0,eventRevision=0;
let conversation='main';
const drafts=new Map();
const conversations=[],convState=new Map();
let loaded=false,loading=false,connectionLost=false,liveDisconnected=false,replyState='idle',replyError='',recovering=false,composing=false,compositionEndedAt=-Infinity,draftRevision=0,unread=0;
let failedSends=[];
let memorySuggestions=[];
let savedOwnerContent='';
let followingLatest=true,scrollWidth=messages.clientWidth,scrollHeight=messages.clientHeight,touchY;
const seen=new Set();let lastMessageTime=0;
const controlKeys=new Map();let pendingControls=0;const uncertainControls=new Set();const rejectedControls=new Map();
// 在途消息发送按来源会话跟踪；sessionRevision 在登出时递增，隔离旧登录的迟到回调。
const sendingConversations=new Set();let sessionRevision=0;
function signatureConversation(sig){try{return JSON.parse(sig)[0]}catch(e){return undefined}}
const conversationMeta={main:{name:'主 Agent',subtitle:'一对一 · 置顶',placeholder:'聊点什么…'},'fake-work':{name:'工作项目群 · 模拟',subtitle:'我 + 主 Agent + 工作项目 Agent（3 人）· 默认发给领域 Agent，@main 呼叫主 Agent',placeholder:'发给工作项目群…（@main 呼叫主 Agent）'}};
function metaOf(id){return conversationMeta[id]||{name:id,subtitle:'领域群聊',placeholder:'发给群聊…（@main 呼叫主 Agent）'}}
function clearSetupToken(){setupToken=null;document.querySelector('#setup-credential').value='';try{sessionStorage.removeItem(setupStorageKey)}catch(e){}}
function stopPolling(){if(pollTimer!==undefined)clearTimeout(pollTimer);pollTimer=undefined}
function active(generation){return generation===viewGeneration&&!privatePanel.hidden}
function resizeInput(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight+2,160)+'px';syncChatSize()}
function updateSend(){const busy=sendingConversations.has(conversation);sendButton.disabled=!loaded||busy||!input.value.trim();sendButton.textContent=busy?'发送中…':'发送'}
function replyFailure(message){return typeof message==='string'&&message.trim()?message.replaceAll('重试失败回合','重试回复'):'回复暂时失败，消息已保留。点击「重试回复」继续。'}
function renderState(){
  status.textContent=loading?'正在加载聊天…':!loaded?'聊天加载失败':connectionLost?'连接中断，正在重连…':liveDisconnected?'实时连接重连中…':replyState==='blocked'?'回复失败':replyState==='processing'?'正在思考…':'在线';
  turnDot.hidden=replyState!=='processing';
  error.textContent=replyState==='blocked'?(replyError||'回复暂时失败，消息已保留。'):'';
  recoverButton.hidden=replyState!=='blocked';recoverButton.disabled=recovering;
  banner.replaceChildren();
  // 横幅只显示当前会话的异常；其他会话靠侧栏警示点，离开检查仍覆盖全部会话。
  let uncertainHere=false;for(const sig of uncertainControls)if(signatureConversation(sig)===conversation){uncertainHere=true;break}
  if(uncertainHere){const p=document.createElement('p');p.textContent='是否送达未知（可重试，相同提交不会重复执行）';banner.append(p)}
  for(const [sig,reason] of rejectedControls){if(signatureConversation(sig)!==conversation)continue;const p=document.createElement('p');p.textContent='已确定被拒绝：'+reason;banner.append(p)}
  banner.hidden=!banner.children.length;
  emptyState.hidden=seen.size>0;emptyState.textContent=loading?'正在加载聊天…':loaded?'从一句话开始聊天吧。':'聊天未能加载，请重试。';updateSend();renderMemorySuggestions();
}
function renderSendErrors(){
  sendErrors.replaceChildren();
  for(const attempt of failedSends){
    const row=document.createElement('div'),label=document.createElement('span'),button=document.createElement('button');row.className='send-failure';
    label.textContent=(attempt.uncertain?'尚未确认是否送达':'发送失败')+'：「'+attempt.content.slice(0,60)+(attempt.content.length>60?'…':'')+'」。'+attempt.error;
    button.type='button';button.textContent='重试发送';button.disabled=sendingConversations.has(conversation);button.addEventListener('click',()=>send(attempt));row.append(label,button);sendErrors.append(row);
  }
}
function renderConversations(){
  listEl.replaceChildren();
  const sorted=conversations.slice().sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0));
  for(const c of sorted){
    const meta=metaOf(c.id),state=convState.get(c.id)||{};
    const item=document.createElement('li');item.className='conv-item'+(c.id===conversation?' active':'');item.dataset.conversation=c.id;
    const text=document.createElement('span');text.className='conv-text';
    const name=document.createElement('span');name.className='conv-name';name.textContent=meta.name;
    const preview=document.createElement('span');preview.className='conv-preview';preview.textContent=state.preview||'';
    text.append(name,preview);
    const side=document.createElement('span');side.className='conv-side';
    if(state.badge){const badge=document.createElement('span');badge.className='conv-badge'+(state.badge==='待回答'?' urgent':'');badge.textContent=state.badge;side.append(badge)}
    if(state.warn){const dot=document.createElement('span');dot.className='conv-warn';dot.textContent='!';dot.title='有提交未确认是否送达或已被拒绝';side.append(dot)}
    item.append(text,side);
    item.onclick=()=>{switchConversation(c.id);document.body.classList.remove('show-list')};
    listEl.append(item);
  }
}
async function pollSidebar(generation){
  try{
    const data=await request('/api/conversations');if(!active(generation))return;
    conversations.length=0;for(const c of data.conversations||[])conversations.push(c);
    await Promise.all(conversations.map(async c=>{
      try{
        const statusData=await request('/api/status?conversation='+encodeURIComponent(c.id));if(!active(generation))return;
        const historyData=await request('/api/history?conversation='+encodeURIComponent(c.id));if(!active(generation))return;
        const last=historyData.messages[historyData.messages.length-1];
        const grouped=c.id!=='main';
        const pending=grouped&&(statusData.questions||[]).some(q=>q.status==='pending');
        const running=grouped&&(statusData.assignments||[]).some(a=>['queued','running','waiting_input'].includes(a.status));
        const warn=Array.from(uncertainControls).concat(Array.from(rejectedControls.keys())).some(sig=>{try{return JSON.parse(sig)[0]===c.id}catch(e){return false}});
        convState.set(c.id,{preview:last?(last.author==='user'?String(last.content):unwrapEnvelope(String(last.content))).slice(0,40):'',badge:pending?'待回答':running?'进行中':'',warn});
      }catch(e){}
    }));
    if(active(generation))renderConversations();
  }catch(e){}
}
function showLogin(configured=true){
  viewGeneration++;sessionRevision++;sendingConversations.clear();stopPolling();if(stream){stream.close();stream=null}
  messages.replaceChildren();seen.clear();lastMessageTime=0;owner.value='';savedOwnerContent='';input.value='';error.textContent='';status.textContent='';privatePanel.hidden=true;loginPanel.hidden=false;
  loaded=false;loading=false;recovering=false;composing=false;compositionEndedAt=-Infinity;draftRevision++;failedSends=[];replyState='idle';replyError='';connectionLost=false;liveDisconnected=false;unread=0;followingLatest=true;
  drafts.clear();answerDrafts.clear();answerFocus.clear();controlKeys.clear();uncertainControls.clear();rejectedControls.clear();cancelling.clear();cardSnapshot='';
  for(const card of cardNodes.values())card.remove();cardNodes.clear();document.querySelector('#todo-area').replaceChildren();
  conversations.length=0;convState.clear();listEl.replaceChildren();banner.replaceChildren();banner.hidden=true;
  latest.hidden=true;reloadButton.hidden=true;ownerStatus.textContent='';document.querySelector('#settings-modal').hidden=true;document.querySelector('#save-owner').disabled=false;document.querySelector('#login-button').disabled=false;
  renderSendErrors();renderTodoEntry();resizeInput();updateSend();if(configured)clearSetupToken();
  document.querySelector('#setup-credential-panel').hidden=configured;document.querySelector('#setup-credential').value=setupToken||'';document.querySelector('#login-title').textContent=configured?'登录':'设置登录密码';document.querySelector('#login-button').textContent=configured?'登录':'设置密码';password.autocomplete=configured?'current-password':'new-password';
  document.querySelector('#login-notice').textContent=configured?'登录状态保持 30 天。':'请设置至少 8 个字符的密码。若没有初始化凭据，请从服务器本次启动日志中的 #setup_token= 后复制凭据并填入上方。';
}
async function pollStatus(generation){
  const revision=eventRevision;
  try{
    const current=await request('/api/status');if(!active(generation))return;renderCards(current);memorySuggestions=current.memorySuggestions||[];
    const history=await request('/api/history');if(!active(generation))return;
    history.messages.forEach(add);connectionLost=false;if(!stream)openEvents(history.cursor);
    if(revision===eventRevision){replyState=current.state;replyError=current.state==='blocked'?replyFailure(current.message):''}
    renderState();void pollSidebar(generation);
  }catch(e){if(active(generation)){connectionLost=true;renderState()}}
  finally{if(active(generation))pollTimer=setTimeout(()=>pollStatus(generation),3000)}
}
function nearBottom(){return messages.scrollHeight-messages.scrollTop-messages.clientHeight<80}
function showLatest(){latest.hidden=nearBottom();latest.textContent=unread?'有新消息 · 回到最新':'回到最新'}
function sizeChanged(){return scrollWidth!==messages.clientWidth||scrollHeight!==messages.clientHeight}
function rememberSize(){scrollWidth=messages.clientWidth;scrollHeight=messages.clientHeight}
function goLatest(){followingLatest=true;rememberSize();messages.scrollTop=messages.scrollHeight;unread=0;latest.hidden=true}
function syncChatSize(){
  if(privatePanel.hidden||!sizeChanged())return;
  rememberSize();if(followingLatest)goLatest();else showLatest();
}
messages.addEventListener('scroll',()=>{
  // Reflow can itself dispatch scroll before ResizeObserver runs. Preserve the
  // previous intent in that case instead of treating it as reading history.
  if(sizeChanged()){syncChatSize();return}
  followingLatest=nearBottom();if(followingLatest)unread=0;showLatest();
});
// An explicit move towards history wins even if a resize notification is pending.
messages.addEventListener('wheel',event=>{if(event.deltaY<0)followingLatest=false},{passive:true});
messages.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY},{passive:true});
messages.addEventListener('touchmove',event=>{const y=event.touches[0]?.clientY;if(y>touchY)followingLatest=false;touchY=y},{passive:true});
messages.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key)||(event.key===' '&&event.shiftKey))followingLatest=false});
if(typeof ResizeObserver==='function')new ResizeObserver(syncChatSize).observe(messages);
if(typeof window!=='undefined'){
  window.addEventListener('resize',syncChatSize);
  window.visualViewport?.addEventListener('resize',syncChatSize);
}
latest.addEventListener('click',goLatest);
function formatTime(value){const d=new Date(value);if(isNaN(d.getTime()))return'';return (d.getMonth()+1)+'月'+d.getDate()+'日 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}
// 与 model-host.unwrapAuthorEnvelope 同规则：全文恰为 {author,text} 信封（两键均为字符串）时取 text。
function unwrapEnvelope(content){const t=content.trim();if(!t.startsWith('{')||!t.endsWith('}'))return content;try{const p=JSON.parse(t);if(p&&typeof p==='object'&&typeof p.author==='string'&&typeof p.text==='string'&&Object.keys(p).every(k=>k==='author'||k==='text'))return p.text}catch(e){}return content}
function add(message){
  if(message.conversation_id!==conversation||seen.has(message.id))return;
  // 存量 Agent 消息可能存的是 {author,text} 信封原文（真实模型模仿上下文格式所致）；展示层剥掉信封。用户消息保持原文——用户可能本来就在讨论 JSON。
  message={...message,content:message.author==='user'?String(message.content):unwrapEnvelope(String(message.content))};
  const follow=sizeChanged()?followingLatest:nearBottom();followingLatest=follow;seen.add(message.id);
  const at=message.createdAt||message.created_at||'';const time=Date.parse(at);
  if(time&&time-lastMessageTime>300000){const divider=document.createElement('div');divider.className='time-divider';divider.textContent=formatTime(at);messages.append(divider)}
  if(time)lastMessageTime=time;
  const row=document.createElement('div');
  row.dataset.messageId=message.id;row.dataset.presentation=message.presentation||'';
  if(message.assignment_id)row.dataset.assignmentId=message.assignment_id;
  if(message.run_id)row.dataset.runId=message.run_id;
  if(message.presentation==='dispatch')row.dataset.objective=String(message.content).replace(/^(FAKE dispatch: |委派：)/,'');
  if(message.author==='runtime'){
    row.className='message runtime';const note=document.createElement('div');note.className='runtime-note';note.textContent=message.content;row.append(note);
  }else{
    const isUser=message.author==='user';row.className='message '+(isUser?'user':'agent');
    const name=({'user':'你','main-agent':'主 Agent','fake-work-agent':'工作项目 Agent · 模拟'})[message.author]||'主 Agent';
    const wrap=document.createElement('div');wrap.className='bubble-wrap';
    if(!isUser){
      const head=document.createElement('div');head.className='agent-head';
      const avatar=document.createElement('span');avatar.className='avatar '+(message.author==='fake-work-agent'?'work':'main');avatar.textContent=name.slice(0,1);
      head.append(avatar);
      if(conversation!=='main'||message.author!=='main-agent'){const who=document.createElement('span');who.className='agent-name';who.textContent=name;head.append(who)}
      wrap.append(head);
    }
    const bubble=document.createElement('div');bubble.className='bubble '+(isUser?'user':message.author==='fake-work-agent'?'work':'main');
    const chip=({dispatch:'委派',receipt:'回执',report:'回传'})[message.presentation];
    if(chip){const tag=document.createElement('span');tag.className='chip';tag.textContent=chip;bubble.append(tag)}
    const text=document.createElement('span');text.className='bubble-text';text.textContent=message.content;bubble.append(text);
    wrap.append(bubble);row.append(wrap);
  }
  messages.append(row);emptyState.hidden=true;
  placeCards();
  if(follow)goLatest();else{unread++;showLatest()}
}
async function request(url,options,detached){
  const generation=viewGeneration,session=sessionRevision;
  // 应用层 deadline：请求超时按“接收状态未知”处理，进入可重试确认流程，而不是无限 pending。
  const timeout=typeof AbortSignal==='function'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(30000):undefined;
  const response=await fetch(channelUrl(scopedUrl(url)),{...options,credentials:'same-origin',...(timeout?{signal:timeout}:{})});
  // detached（消息/控制提交）的响应必须归位来源会话，视图切换不丢弃结果；其余请求随视图作废。
  if(!detached&&generation!==viewGeneration)throw new Error('会话已切换');
  // 401 的登出副作用只在请求所属登录代次内生效：旧登录迟到的 401 不能踢掉新登录。
  if(response.status===401){if(session===sessionRevision){showLogin();loginError.textContent='请重新登录。'}throw new Error('请重新登录。')}
  // The status already confirms acceptance even if the response body is lost.
  if(url==='/api/messages'&&response.ok)return {};
  let body;try{body=await response.json()}catch(e){if(response.ok)throw new Error('无法读取服务器响应。');body={}}
  if(!detached&&generation!==viewGeneration)throw new Error('会话已切换');
  if(!response.ok){const failure=new Error(body.error||'请求无法完成。');failure.status=response.status;throw failure}return body;
}
function openEvents(cursor){
  if(stream)stream.close();stream=new EventSource(channelUrl(scopedUrl('/api/events?cursor='+encodeURIComponent(cursor))));const current=stream,generation=viewGeneration;
  const isCurrent=()=>stream===current&&active(generation);
  current.addEventListener('open',()=>{if(isCurrent()){liveDisconnected=false;renderState()}});
  current.addEventListener('update',event=>{
    if(!isCurrent())return;const update=JSON.parse(event.data);eventRevision++;
    if(update.type==='submitted'){add(update.message);if(replyState!=='blocked')replyState='processing'}
    if(update.type==='reply'){add(update.message);replyState='idle';replyError=''}
    if(update.type==='error'){replyError=replyFailure(update.message);replyState='blocked'}
    if(update.type==='recovered'){replyState=update.count?'processing':'idle';replyError=''}
    if(update.type==='cleared'){resetConversationView(conversation);return}renderState();
  });
  // Reload only the chat snapshot: a replay reset must not discard a draft or uncertain send.
  current.addEventListener('reset',async()=>{
    if(!isCurrent())return;current.close();
    try{const history=await request('/api/history');if(!isCurrent())return;history.messages.forEach(add);openEvents(history.cursor)}catch(e){if(isCurrent()){liveDisconnected=true;renderState();current.close();stream=null}}
  });
  current.onerror=async()=>{
    if(!isCurrent())return;liveDisconnected=true;renderState();
    try{const auth=await request('/api/auth');if(!isCurrent())return;if(!auth.authenticated){showLogin();loginError.textContent='请重新登录。'}}catch(e){if(isCurrent()){liveDisconnected=true;renderState()}}
  };
}
async function load(){
  stopPolling();if(stream){stream.close();stream=null}const generation=++viewGeneration;loading=true;loaded=false;loginError.textContent='';loginPanel.hidden=true;privatePanel.hidden=false;reloadButton.hidden=true;
  const meta=metaOf(conversation);chatTitle.textContent=meta.name;chatSubtitle.textContent=meta.subtitle;input.placeholder=meta.placeholder;renderConversations();renderState();
  try{
    const history=await request('/api/history');if(!active(generation))return;
    const context=await request('/api/owner-context');if(!active(generation))return;
    history.messages.forEach(add);goLatest();owner.value=context.content;savedOwnerContent=context.content;loaded=true;loading=false;renderState();resizeInput();openEvents(history.cursor);await pollStatus(generation);
  }catch(e){if(active(generation)){loading=false;reloadButton.hidden=false;renderState()}}
}
reloadButton.addEventListener('click',load);
async function initialize(){try{const auth=await request('/api/auth');if(auth.configured)clearSetupToken();if(auth.authenticated)await load();else showLogin(auth.configured)}catch(e){showLogin(false);loginError.textContent='无法连接服务器，请稍后刷新。'}}
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();loginError.textContent='';const button=document.querySelector('#login-button');if(button.disabled)return;button.disabled=true;try{const auth=await request('/api/auth');if(auth.configured)clearSetupToken();const credential=document.querySelector('#setup-credential').value.trim()||setupToken;if(!auth.configured&&!credential){loginError.textContent='请从服务器本次启动日志的 #setup_token= 后复制初始化凭据，填入上方后再设置密码。';document.querySelector('#setup-credential-panel').hidden=false;document.querySelector('#setup-credential').focus();return}await request(auth.configured?'/api/auth/login':'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:password.value,...(!auth.configured?{setupToken:credential}:{})})});clearSetupToken();password.value='';await load()}catch(e){loginError.textContent=e.message}finally{button.disabled=false}});
function leaveBlock(){if(sendingConversations.size)return '发送尚未确认，请完成或超时后再离开。';if(pendingControls>0)return '提交尚未确认，请完成或超时后再离开。';return undefined}
function leaveDirty(){
  if(input.value.trim()||failedSends.length||owner.value!==savedOwnerContent||uncertainControls.size||rejectedControls.size)return true;
  for(const text of answerDrafts.values()){if(text.trim())return true}
  for(const draft of drafts.values()){if(draft.text.trim()||draft.failed.length)return true}
  return false
}
document.querySelector('#logout').addEventListener('click',async()=>{
  const blocked=leaveBlock();if(blocked){status.textContent=blocked;return}
  if(leaveDirty()&&!confirm('退出登录将丢弃未提交内容。'))return;
  showLogin();const generation=viewGeneration,button=document.querySelector('#login-button');button.disabled=true;
  try{await request('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(generation===viewGeneration)loginError.textContent='已退出登录。'}
  catch(e){if(generation===viewGeneration)loginError.textContent='退出请求未确认，请刷新页面后再次退出。'}finally{if(generation===viewGeneration)button.disabled=false}
});
input.addEventListener('input',()=>{draftRevision++;resizeInput();updateSend()});
input.addEventListener('compositionstart',()=>{composing=true});
input.addEventListener('compositionend',()=>{composing=false;compositionEndedAt=Date.now()});
function isComposing(event){return composing||event.isComposing||event.keyCode===229||Date.now()-compositionEndedAt<60}
input.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.shiftKey||isComposing(event))return;
  if(typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches)return;
  event.preventDefault();if(!event.repeat)void send();
});
document.querySelector('#chat').addEventListener('submit',event=>{event.preventDefault();if(!isComposing(event))return send()});
async function send(retry){
  if(!loaded||privatePanel.hidden||composing)return;
  const source=conversation;
  if(sendingConversations.has(source))return;
  const content=retry?retry.content:input.value;if(!content.trim())return;
  // Reuse a failed attempt even when resubmitted from the composer. A successful
  // attempt is removed, so intentionally sending the same text again gets a new key.
  const attempt=retry||failedSends.find(item=>item.content===content)||{content,idempotencyKey:crypto.randomUUID(),revision:draftRevision};
  // 在途提交、原始幂等键与结果都归属来源会话：切换视图只阻止更新错误页面，不丢弃结果。
  const session=sessionRevision,generation=viewGeneration,revision=eventRevision;
  const alive=()=>session===sessionRevision,inView=()=>alive()&&source===conversation&&active(generation);
  // 往返切回后来源会话重新可见：错误列表与发送控件按当前可见性刷新，状态推进仍限原视图。
  const visible=()=>alive()&&source===conversation&&!privatePanel.hidden;
  sendingConversations.add(source);updateSend();renderSendErrors();
  try{
    await request('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:attempt.content,idempotencyKey:attempt.idempotencyKey})},true);
    if(!alive())return;
    if(source===conversation){
      failedSends=failedSends.filter(item=>item!==attempt);
      if(input.value===attempt.content&&draftRevision===attempt.revision){input.value='';draftRevision++;resizeInput()}
    }else{
      const saved=drafts.get(source);
      if(saved){saved.failed=saved.failed.filter(item=>item!==attempt);if(saved.text===attempt.content&&saved.revision===attempt.revision)saved.text=''}
    }
    if(inView()){if(eventRevision===revision&&replyState!=='blocked')replyState='processing';eventRevision++}
  }catch(e){
    if(!alive())return;
    attempt.uncertain=!e.status||e.status>=500||e.status===408;
    attempt.error=attempt.uncertain?'可重试确认，同一条消息不会重复保存。':e.message;
    if(source===conversation){if(!failedSends.includes(attempt))failedSends.push(attempt)}
    else{const saved=drafts.get(source)||{text:'',failed:[],revision:draftRevision};if(!saved.failed.includes(attempt))saved.failed.push(attempt);drafts.set(source,saved)}
  }finally{
    // 占用清理同样校验登录代次：旧登录迟到的结束不能抹掉新登录的同会话在途占用。
    if(alive())sendingConversations.delete(source);
    if(visible()){renderState();renderSendErrors()}
  }
}
document.querySelector('#save-owner').addEventListener('click',async()=>{
  const generation=viewGeneration,button=document.querySelector('#save-owner');if(button.disabled)return;button.disabled=true;ownerStatus.textContent='正在保存…';
  try{await request('/api/owner-context',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:owner.value})});if(active(generation)){savedOwnerContent=owner.value;ownerStatus.textContent='已明确保存，仅未来回合会使用。'}}
  catch(e){if(active(generation))ownerStatus.textContent=e.message}finally{if(active(generation))button.disabled=false}
});
// 清空对话：本地视图复位与 switchConversation 同款清理；服务端广播 cleared 事件，其他打开的标签页也随之刷新。
function resetConversationView(id){
  convState.delete(id);
  if(id!==conversation){renderConversations();return}
  messages.replaceChildren();seen.clear();lastMessageTime=0;cardSnapshot='';
  for(const card of cardNodes.values())card.remove();cardNodes.clear();cancelling.clear();
  document.querySelector('#todo-area').replaceChildren();
  replyState='idle';replyError='';renderConversations();void load();
}
async function clearConversation(id,label){
  const clearStatus=document.querySelector('#clear-status');clearStatus.textContent='';
  if(!window.confirm('确定清空「'+label+'」的全部消息记录吗？此操作不可恢复。'+(id==='fake-work'?'其中的任务与问题记录也会一并删除。':'')))return;
  try{await request('/api/clear?conversation='+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});resetConversationView(id);clearStatus.textContent='「'+label+'」已清空。'}
  catch(e){clearStatus.textContent=e.message}
}
document.querySelector('#clear-main').addEventListener('click',()=>clearConversation('main','主 Agent 对话'));
document.querySelector('#clear-group').addEventListener('click',()=>clearConversation('fake-work','工作项目群'));
// 提议制记忆：pending 提议在主对话顶部成卡片，确认/忽略后服务端刷新检查点；已确认记忆在设置里可删。
function renderMemorySuggestions(){
  const area=document.querySelector('#memory-area');area.replaceChildren();
  if(conversation!=='main'||!memorySuggestions.length){area.hidden=true;return}
  for(const s of memorySuggestions){
    const card=document.createElement('div');card.className='card';
    const title=document.createElement('div');title.className='card-title';title.textContent='建议记住';
    const body=document.createElement('div');body.className='card-body';body.textContent=s.fact;
    const yes=document.createElement('button');yes.type='button';yes.textContent='记住';
    yes.addEventListener('click',()=>memoryAction(s.id,'confirm',yes));
    const no=document.createElement('button');no.type='button';no.textContent='忽略';
    no.addEventListener('click',()=>memoryAction(s.id,'dismiss',no));
    card.append(title,body,yes,no);area.append(card);
  }
  area.hidden=false;
}
async function memoryAction(id,action,button){
  if(button.disabled)return;button.disabled=true;
  try{await request('/api/memories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action})});memorySuggestions=memorySuggestions.filter(s=>s.id!==id);renderMemorySuggestions();void loadMemories()}
  catch(e){button.disabled=false}
}
async function loadMemories(){
  const list=document.querySelector('#memory-list');
  try{const data=await request('/api/memories');list.replaceChildren();
    for(const m of (data.memories||[]).filter(m=>m.status==='confirmed')){
      const item=document.createElement('li');item.append(document.createTextNode(m.fact+' '));
      const del=document.createElement('button');del.type='button';del.textContent='删除';
      del.addEventListener('click',async()=>{del.disabled=true;try{await request('/api/memories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:m.id,action:'delete'})});await loadMemories()}catch(e){del.disabled=false}});
      item.append(del);list.append(item);
    }
    if(!list.children.length){const empty=document.createElement('li');empty.textContent='暂无已确认的记忆。';list.append(empty)}
  }catch(e){}
}
recoverButton.addEventListener('click',async()=>{
  if(recovering||replyState!=='blocked')return;const generation=viewGeneration;recovering=true;eventRevision++;renderState();const revision=eventRevision;
  try{const body=await request('/api/recover',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!active(generation))return;if(eventRevision===revision){replyState=body.started?'processing':'idle';replyError=''}eventRevision++}
  catch(e){if(active(generation)){replyState='blocked';replyError='暂时无法重试，请稍后再试。'}}finally{if(active(generation)){recovering=false;renderState()}}
});
${coordinationCardsScript}
async function control(kind,id,content,button){
  if(!content.trim())return;
  // 在途控制提交与结果归属来源会话：自由切换不丢弃迟到的接受/拒绝/未知。
  const source=conversation,session=sessionRevision,generation=viewGeneration;
  const signature=JSON.stringify([source,kind,id,content]);
  if(!controlKeys.has(signature))controlKeys.set(signature,crypto.randomUUID());
  const alive=()=>session===sessionRevision,inView=()=>alive()&&source===conversation&&active(generation);
  button.disabled=true;pendingControls++;
  let uncertain=false;
  try{
    await request('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,id,content,idempotencyKey:controlKeys.get(signature)})},true);
    if(alive()){uncertainControls.delete(signature);rejectedControls.delete(signature);
      if(inView()){const state=await request('/api/status');if(inView()){renderCards(state);renderState()}}}
  }catch(e){
    if(e&&e.message==='会话已切换'){/* 提交已受理后的状态刷新被切换打断；结果由轮询归位 */}
    else if(alive()){uncertain=!e.status||e.status>=500;if(uncertain)uncertainControls.add(signature);else rejectedControls.set(signature,e.message||'请求被拒绝。');
      if(button.dataset&&button.dataset.cancel){cancelling.delete(button.dataset.cancel);button.textContent='取消'}
      renderState();renderConversations()}
  }finally{
    pendingControls--;
    if(alive()){
      if(button.dataset&&button.dataset.cancel&&cancelling.has(button.dataset.cancel)&&!uncertain){button.disabled=true;button.textContent='取消中…'}else button.disabled=false;
      if(inView()){renderState();renderConversations()}
    }
  }
}
// 会话内切换（主聊↔工作群）自由无阻塞：草稿按会话保留，进行中的控制提交后台继续。
function switchConversation(next){
  if(next===conversation)return;
  // 草稿修订号随草稿一起存取：在途提交成功后能识别“草稿未被再编辑”并安全清空。
  rememberAnswerFocus();drafts.set(conversation,{text:input.value,failed:failedSends,revision:draftRevision});
  conversation=next;
  const saved=drafts.get(next);input.value=saved?.text||'';failedSends=saved?.failed||[];
  if(saved&&saved.revision!==undefined)draftRevision=saved.revision;else draftRevision++;
  messages.replaceChildren();seen.clear();lastMessageTime=0;cardSnapshot='';
  for(const card of cardNodes.values())card.remove();cardNodes.clear();cancelling.clear();
  document.querySelector('#todo-area').replaceChildren();
  recovering=false;composing=false;eventRevision++;replyState='idle';replyError='';
  const meta=metaOf(next);chatTitle.textContent=meta.name;chatSubtitle.textContent=meta.subtitle;input.placeholder=meta.placeholder;
  banner.replaceChildren();banner.hidden=true;renderConversations();renderSendErrors();renderCards({});renderState();
  void load();
}
document.querySelector('#back-to-list').addEventListener('click',()=>{document.body.classList.add('show-list')});
todoJump.addEventListener('click',()=>{
  for(const card of cardNodes.values())if(cardUnfinished(card)&&card.parentNode){card.scrollIntoView({block:'center'});return}
});
function setupVersionSwitch(){
  const nav=document.querySelector('#version-switch');nav.hidden=!appConfig.stableLink;
  document.querySelector('#to-stable').addEventListener('click',event=>{
    const blocked=leaveBlock();if(blocked){event.preventDefault();status.textContent=blocked;return}
    if(leaveDirty()&&!confirm('离开预览将丢弃未提交内容。'))event.preventDefault();
  });
}
// 设置弹窗：按钮打开，Esc / 点遮罩 / × 关闭；退出登录守卫不变。
const settingsModal=document.querySelector('#settings-modal');
document.querySelector('#open-settings').addEventListener('click',()=>{settingsModal.hidden=false;void loadMemories()});
document.querySelector('#close-settings').addEventListener('click',()=>{settingsModal.hidden=true});
settingsModal.addEventListener('click',event=>{if(event.target===settingsModal)settingsModal.hidden=true});
window.addEventListener('keydown',event=>{if(event.key==='Escape')settingsModal.hidden=true});
// 左栏宽度拖拽：200–400px，localStorage 记忆；窄屏单栏不出现也不生效。
const sidebarEl=document.querySelector('#sidebar'),sidebarHandle=document.querySelector('#sidebar-handle'),sidebarWidthKey='agents-preview-sidebar-width';
function narrowLayout(){return typeof matchMedia==='function'&&matchMedia('(max-width: 767px)').matches}
function clampSidebarWidth(w){return Math.min(400,Math.max(200,Math.round(w)))}
try{const savedWidth=Number(localStorage.getItem(sidebarWidthKey));if(savedWidth>=200&&savedWidth<=400)sidebarEl.style.width=clampSidebarWidth(savedWidth)+'px'}catch(e){}
sidebarHandle.addEventListener('pointerdown',event=>{
  if(narrowLayout())return;
  event.preventDefault();
  const move=moveEvent=>{sidebarEl.style.width=clampSidebarWidth(moveEvent.clientX)+'px'};
  const up=upEvent=>{
    window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);
    try{localStorage.setItem(sidebarWidthKey,String(clampSidebarWidth(upEvent.clientX)))}catch(e){}
  };
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
});
window.addEventListener('beforeunload',event=>{if(leaveBlock()){event.preventDefault();event.returnValue=''}});
setupVersionSwitch();
initialize();
</script>`
