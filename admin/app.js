const byId=id=>document.getElementById(id);
const form=byId('save');
const slug=byId('slug');
let selected=null;
let originalHtml='';
let draftHtml='';
const visualFrame=byId('visual-frame');
const visualDialog=byId('visual-dialog');
let visualOpening=0;
function openVisual(){
  const current=selected;
  const opening=++visualOpening;
  visualDialog.showModal();
  const apply=byId('visual-apply');
  apply.disabled=true;
  visualFrame.onload=()=>{
    if(opening!==visualOpening||!visualDialog.open||selected!==current)return;
    try{
      visualFrame.contentWindow.reportEditor.open(draftHtml,current.url);
      apply.disabled=false;
    }catch(error){
      visualDialog.close();
      message('Не удалось открыть редактор: '+error.message,true);
    }
  };
  visualFrame.src='visual-editor.html?v=photos2';
}
byId('visual-open').onclick=openVisual;
byId('visual-close').onclick=()=>visualDialog.close();
visualDialog.addEventListener('close',()=>{
  visualOpening++;
  visualFrame.onload=null;
  visualFrame.src='about:blank';
});
byId('visual-apply').onclick=()=>{
  try{
    draftHtml=visualFrame.contentWindow.reportEditor.exportHtml();
    visualDialog.close();
    message('Правки применены. Нажмите «Сохранить в GitHub».');
    byId('editor').scrollIntoView({block:'start'});
  }catch(error){message(error.message,true);}
};
let busy=false;
let authorization='';
function apiUrl(suffix) {
  const url=new URL(window.ADMIN_API_URL);
  if(url.protocol!=='https:'||url.hostname==='your-service.up.railway.app') {
    throw new Error('Укажите HTTPS-адрес Railway в admin/config.js.');
  }
  return new URL('/admin/api/reports'+suffix,url);
}
function request(suffix,method='GET',payload) {
  const headers={Authorization:authorization};
  if(payload)Object.assign(headers,{'Content-Type':'application/json','X-Admin-Request':'1'});
  return fetch(apiUrl(suffix),{method,headers,credentials:'omit',redirect:'error',
    body:payload?JSON.stringify(payload):undefined});
}

async function api(suffix='',method='GET',payload) {
  const response=await request(suffix,method,payload);
  if(response.status===401)throw new Error('Неверный пароль.');
  const result=await response.json();
  if(!response.ok) throw new Error(result.error||'Ошибка запроса.');
  return result;
}

const publicationKey='autoteka-admin-publications';
const publications=new Map();
let publicationTimer;
let publicationSession=0;
try {
  for(const item of JSON.parse(localStorage.getItem(publicationKey)||'[]')){
    if(/^[a-f0-9]{40}$/.test(item.sha))publications.set(item.sha,item);
  }
} catch { /* Storage may be unavailable. */ }
function savePublications(){
  try {localStorage.setItem(publicationKey,JSON.stringify([...publications.values()]));} catch {}
}
function publicationStatus(item){
    let status='Ждём запуска GitHub Pages';
    if(item.status==='queued'||item.status==='requested'||item.status==='pending'||item.status==='waiting_for_approval')status='В очереди';
    if(item.status==='in_progress')status='GitHub Pages публикует обновление';
    if(item.status==='completed'){
      const labels={success:'Опубликовано',failure:'Сборка завершилась ошибкой',cancelled:'Публикация отменена',skipped:'Публикация пропущена'};
      status=labels[item.conclusion]||'Публикация не подтверждена ('+(item.conclusion||'без результата')+')';
      if(item.updatedAt)status+=' · '+new Date(item.updatedAt).toLocaleString('ru-RU');
    }
    if(item.error)status='Статус недоступен: '+item.error;
    if(!item.error&&item.status!=='completed'&&Date.now()-item.started>20*60_000)status+=' · проверьте Actions';
    return status;
}
function renderPublications(){
  for(const badge of document.querySelectorAll('[data-publication-sha]')){
    const item=publications.get(badge.dataset.publicationSha);
    badge.replaceChildren();
    if(!item)continue;
    badge.textContent=' · '+publicationStatus(item);
    if(item.url){
      const link=element('a',' · GitHub Actions',badge);
      link.href=item.url;
      link.target='_blank';
      link.rel='noopener noreferrer';
    }
  }
  const linked=new Set([...document.querySelectorAll('[data-publication-sha]')].map(node=>node.dataset.publicationSha));
  const pending=[...publications.values()].filter(item=>item.status!=='completed'&&!linked.has(item.sha)&&!hiddenHistory.has(item.sha));
  byId('publications').hidden=!pending.length;
  const list=byId('publication-list');
  list.replaceChildren();
  for(const item of pending.reverse()){
    const row=element('article','',list);
    const details=element('div','',row);
    element('strong',item.slug+' · '+item.sha.slice(0,8),details);
    const status=publicationStatus(item);
    element('div',status,details);
    if(item.url){
      const link=element('a','Открыть GitHub Actions',row);
      link.href=item.url;
      link.target='_blank';
      link.rel='noopener noreferrer';
    }
  }
}
async function checkPublications(){
  clearTimeout(publicationTimer);
  if(!authorization)return;
  const session=++publicationSession;
  const pending=[...publications.values()].filter(item=>item.status!=='completed');
  await Promise.all(pending.map(async item=>{
    try {
      const result=await api('/publication?sha='+item.sha);
      if(session===publicationSession)Object.assign(item,result,{error:''});
    }catch(error){
      if(session===publicationSession)item.error=error.message;
    }
  }));
  if(session!==publicationSession||!authorization)return;
  savePublications();
  renderPublications();
  if(pending.some(item=>item.status!=='completed'&&Date.now()-item.started<20*60_000)){
    publicationTimer=setTimeout(checkPublications,15000);
  }
}
function trackPublication(result,name){
  publications.set(result.commit,{sha:result.commit,slug:name,started:Date.now()});
  while(publications.size>8)publications.delete(publications.keys().next().value);
  savePublications();
  renderPublications();
  void checkPublications();
}
function message(text,error=false) {
  byId('status').textContent=text;
  byId('status').classList.toggle('error',error);
}
async function run(action) {
  if(busy)return;
  busy=true;
  document.querySelectorAll('button').forEach(button=>button.disabled=true);
  message('Выполняется…');
  try { await action(); } catch(error) { message(error.message,true); }
  finally {
    busy=false;
    document.querySelectorAll('button:not(#visual-apply)').forEach(button=>button.disabled=false);
  }
}
function element(tag,text,parent) {
  const node=document.createElement(tag);
  node.textContent=text;
  parent.append(node);
  return node;
}
const sessionStorageKey='autoteka-admin-session';
function storeSession(value){
  try{
    if(value)localStorage.setItem(sessionStorageKey,JSON.stringify(value));
    else localStorage.removeItem(sessionStorageKey);
  }catch{}
}
function readSession(){
  try{
    const session=JSON.parse(localStorage.getItem(sessionStorageKey)||'null');
    if(session && session.expires>Date.now() && typeof session.token==='string')return session;
  }catch{}
  return null;
}
function reportValues(html){
  const inert=document.createElement('template');
  inert.innerHTML=html;
  const values=[];
  const tree=inert.content;
  for(const meta of tree.querySelectorAll('meta[property^="og:"]')){
    values.push(meta.getAttribute('property')+': '+meta.content);
  }
  const walker=document.createTreeWalker(tree,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
    const node=walker.currentNode;
    if(node.parentElement?.closest('script,style,template,svg,noscript'))continue;
    const text=node.textContent.replace(/\s+/g,' ').trim();
    if(text)values.push(text);
  }
  return {values,images:[...tree.querySelectorAll('img[src]')].map(img=>img.getAttribute('src')).filter(src=>src&&!src.startsWith('data:'))};
}
function difference(source,target){
  const counts=new Map();
  for(const text of target)counts.set(text,(counts.get(text)||0)+1);
  return source.filter(text=>{
    const count=counts.get(text)||0;
    if(!count)return true;
    counts.set(text,count-1);
    return false;
  });
}
async function compareReport(sha,parent){
  const status=element('p','Сравниваем версии отчёта…',parent);
  try{
    const [before,after]=await Promise.all(['before','after'].map(async side=>{
      const response=await request('/history/html?sha='+sha+'&side='+side);
      if(!response.ok)throw new Error('GitHub не отдал версию HTML.');
      return reportValues(await response.text());
    }));
    const oldText=difference(before.values,after.values);
    const newText=difference(after.values,before.values);
    const oldImages=difference(before.images,after.images);
    const newImages=difference(after.images,before.images);
    if(!oldText.length&&!newText.length&&!oldImages.length&&!newImages.length){
      status.textContent='Изменения видимого текста и ссылок на фото не обнаружены. Правки могли затронуть разметку, стили или данные внутри отчёта.';
      return;
    }
    status.textContent='Было → стало';
    for(const [label,text,images] of [['Было',oldText,oldImages],['Стало',newText,newImages]]){
      element('strong',label,parent);
      const preview=element('pre',[...text,...images.map(src=>'Фото: '+src)].slice(0,100).join('\n')||'—',parent);
      preview.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:250px;overflow:auto';
    }
  }catch(error){status.textContent='Сравнение недоступно: '+error.message;}
}
const hiddenHistoryKey='autoteka-admin-hidden-history';
const hiddenHistory=new Set();
try{
  for(const sha of JSON.parse(localStorage.getItem(hiddenHistoryKey)||'[]')){
    if(/^[a-f0-9]{40}$/.test(sha))hiddenHistory.add(sha);
  }
}catch{}
function saveHiddenHistory(){
  try{localStorage.setItem(hiddenHistoryKey,JSON.stringify([...hiddenHistory]));}catch{}
}

const historyCutoffKey='autoteka-admin-history-cutoff';
let historyCutoff=0;
try { historyCutoff=Number(localStorage.getItem(historyCutoffKey))||0; } catch {}
let latestHistory=[];
function historyHidden(item){
  return hiddenHistory.has(item.sha) || (Date.parse(item.date)||0)<=historyCutoff;
}
byId('history-clear').onclick=()=>{
  if(!latestHistory.some(item=>!historyHidden(item)))return;
  if(!window.confirm('Очистить историю в этом браузере? Отчёты и коммиты останутся в GitHub.'))return;
  historyCutoff=Math.max(historyCutoff,...latestHistory.map(item=>Date.parse(item.date)||0));
  for(const item of latestHistory)hiddenHistory.add(item.sha);
  try { localStorage.setItem(historyCutoffKey,String(historyCutoff)); } catch {}
  saveHiddenHistory();
  byId('history-list').replaceChildren();
  byId('history-clear').disabled=true;
  byId('history-status').textContent='История очищена.';
  renderPublications();
};
async function showHistory(){
  const container=byId('history-list');
  const status=byId('history-status');
  const auth=authorization;
  status.textContent='Загрузка истории…';
  try{
    const history=await api('/history');
    if(!authorization||authorization!==auth)return;
    container.replaceChildren();
    latestHistory=history;
    const visible=history.filter(item=>!historyHidden(item));
    byId('history-clear').disabled=!visible.length;
    status.textContent=visible.length?'':history.length?'Все текущие записи скрыты.':'Изменений пока нет.';
    for(const item of visible){
      const entry=element('details','',container);
      const title=item.message.replace(/^Add report:/,'Добавлен:').replace(/^Update report:/,'Изменён:').replace(/^Remove report:/,'Удалён:');
      entry.style.cssText='background:white;border:1px solid #dbe3ee;border-radius:12px;padding:12px;margin:8px 0';
      const summary=element('summary',title+' · '+new Date(item.date).toLocaleString('ru-RU'),entry);
      summary.style.cursor='pointer';
      element('span','',summary).dataset.publicationSha=item.sha;
      const remove=element('button','Убрать из истории',entry);
      remove.type='button';
      remove.className='remove';
      remove.onclick=()=>{
        if(!window.confirm('Убрать эту запись из истории? '+title))return;
        hiddenHistory.add(item.sha);
        saveHiddenHistory();
        entry.remove();
        renderPublications();
        if(!container.children.length)status.textContent='Все текущие записи скрыты.';
      };
      const content=element('div','',entry);
      entry.ontoggle=async()=>{
        if(!entry.open||entry.dataset.loaded)return;
        entry.dataset.loaded='true';
        content.textContent='Загрузка изменений…';
        try{
          const detail=await api('/history/detail?sha='+item.sha);
          content.replaceChildren();
          for(const file of detail.files){
            const card=element('article','',content);
            const column=element('div','',card);
            element('strong',file.path,column);
            element('p',({added:'Добавлен',removed:'Удалён',modified:'Изменён',renamed:'Переименован'})[file.status]||file.status,column);
            if(file.before||file.after){
              const images=element('div','',column);
              images.className='actions';
              for(const [label,url] of [['Было',file.before],['Стало',file.after]]){
                const figure=element('figure','',images);
                element('figcaption',label,figure);
                if(!url){element('span','—',figure);continue;}
                const img=element('img','',figure);
                img.alt=label;
                img.loading='lazy';
                img.width=160;
                img.src=url;
              }
            }
            if(file.path.endsWith('/index.html')){
              await compareReport(item.sha,column);
            }else if(file.patch){
              const lines=file.patch.split('\n');
              const comparison=element('details','',column);
              element('summary','Было → стало',comparison);
              for(const [label,prefix] of [['Было','-'],['Стало','+']]){
                element('strong',label,comparison);
                const preview=element('pre',lines.filter(line=>line.startsWith(prefix)).map(line=>line.slice(1)).join('\n')||'—',comparison);
                preview.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto';
              }
            }
          }
          if(detail.more)element('p','Показаны первые 100 файлов.',content);
        }catch(error){content.textContent=error.message;delete entry.dataset.loaded;}
      };
    }
    renderPublications();
  }catch(error){if(authorization===auth)status.textContent='История недоступна: '+error.message;}
}
byId('history-refresh').onclick=showHistory;
function select(report) {
  HTMLFormElement.prototype.reset.call(form);
  selected=report;
  originalHtml='';
  draftHtml='';
  byId('source-field').hidden=true;
  byId('source-field').style.display='none';
  slug.value=report?.slug||'';
  slug.readOnly=Boolean(report);
  byId('form-title').textContent=report?'Редактировать '+report.slug:'Добавить автомобиль';
}
async function list() {
  const reports=await api();
  const container=byId('reports');
  container.replaceChildren();
  if(!reports.length) element('p','Отчётов пока нет.',container);
  for(const report of reports) {
    const row=element('article','',container);
    element('strong',report.slug,row);
    const actions=element('div','',row);
    actions.className='actions';
    const page=element('a','Открыть',actions);
    page.href=report.url;
    page.target='_blank';
    page.rel='noopener noreferrer';
    const download=element('button','Скачать HTML',actions);
    download.onclick=()=>run(async()=>{
      const response=await request('/'+report.slug);
      if(!response.ok)throw new Error('Не удалось скачать отчёт.');
      const url=URL.createObjectURL(await response.blob());
      const anchor=document.createElement('a');
      anchor.href=url;
      anchor.download=report.slug+'.html';
      anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),2000);
      message('HTML скачан.');
    });
    const edit=element('button','Редактировать',actions);
    edit.setAttribute('aria-controls','editor');
    edit.onclick=()=>run(async()=>{
      if(selected && draftHtml!==originalHtml &&
        !window.confirm('Открыть другой отчёт и сбросить несохранённые правки?')) {
        message('Правки остались в форме.');
        return;
      }
      const response=await request('/'+report.slug);
      if(!response.ok)throw new Error('Не удалось загрузить HTML отчёта.');
      const html=await response.text();
      select(report);
      draftHtml=html;
      originalHtml=html;
      byId('source-field').hidden=false;
      byId('source-field').style.display='grid';
      message('Открыт отчёт '+report.slug+'.');
      byId('editor').scrollIntoView({block:'start'});
      openVisual();
    });
    const remove=element('button','Убрать',actions);
    remove.className='remove';
    remove.onclick=()=>{
      const confirm=prompt('Чтобы убрать отчёт, введите название папки: '+report.slug);
      if(confirm!==report.slug)return;
      run(async()=>{
        const result=await api('/'+report.slug,'DELETE',{confirm,revision:report.revision});
        trackPublication(result,report.slug);
        void showHistory();
        if(selected?.slug===report.slug)select(null);
        await list();
        message('Отчёт убран. Коммит '+result.commit.slice(0,8)+'.');
      });
    };
  }
}
function encode(file) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result.split(',')[1]);
    reader.onerror=()=>reject(new Error('Не удалось прочитать '+file.name));
    reader.readAsDataURL(file);
  });
}
form.onsubmit=event=>{
  event.preventDefault();
  run(async()=>{
    const edited=selected && draftHtml!==originalHtml;
    const html=byId('html').files[0] || (edited
      ? new File([draftHtml],'index.html',{type:'text/html;charset=utf-8'})
      : null);
    const assets=[...byId('assets').files];
    if(!selected&&!html)throw new Error('Выберите HTML нового отчёта.');
    const files=assets.map(file=>{
      const parts=file.webkitRelativePath.split('/');
      return {file,path:'assets/'+parts.slice(1).join('/')};
    });
    if(html)files.unshift({file:html,path:'index.html'});
    if(!files.length)throw new Error('Выберите файлы для сохранения.');
    if(files.length>120||files.reduce((sum,{file})=>sum+file.size,0)>20_000_000) {
      throw new Error('Лимит — 120 файлов и 20 МБ.');
    }
    const payload=[];
    for(const {file,path} of files)payload.push({path,data:await encode(file)});
    const result=await api('/'+slug.value,'PUT',{revision:selected?.revision??null,files:payload});
    trackPublication(result,slug.value);
    void showHistory();
    select(null);
    await list();
    message('Сохранено в GitHub. Коммит '+result.commit.slice(0,8)+'. GitHub Pages обновит страницу после сборки.');
  });
};
byId('new-report').onclick=()=>select(null);
byId('refresh').onclick=()=>run(async()=>{await list();void checkPublications();message('Список обновлён.');});
byId('login').onsubmit=event=>{
  event.preventDefault();
  run(async()=>{
    const password=byId('password');
    const bytes=new TextEncoder().encode('admin:'+password.value);
    authorization='Basic '+btoa(String.fromCharCode(...bytes));
    password.value='';
    try {
      if(byId('remember').checked){
        const session=await api('/session','POST',{});
        storeSession(session);
        authorization='Bearer '+session.token;
      }
      await enterWorkspace();
    } catch(error){authorization='';storeSession(null);throw error;}
  });
};
async function enterWorkspace(){
    await list();
    byId('login').hidden=true;
    byId('workspace').hidden=false;
    byId('refresh').hidden=false;
    message('Вход выполнен.');
    renderPublications();
    void checkPublications();
    void showHistory();
}
byId('logout').onclick=()=>{
  authorization='';
  storeSession(null);
  byId('history-list').replaceChildren();
  publicationSession++;
  clearTimeout(publicationTimer);
  select(null);
  byId('reports').replaceChildren();
  byId('workspace').hidden=true;
  byId('refresh').hidden=true;
  byId('login').hidden=false;
  message('Вы вышли.');
};

const savedSession=readSession();
if(savedSession){
  authorization='Bearer '+savedSession.token;
  void run(async()=>{
    try{await enterWorkspace();}
    catch(error){authorization='';storeSession(null);throw error;}
  });
}
