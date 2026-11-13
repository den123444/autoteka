const byId=id=>document.getElementById(id);
const form=byId('save');
const slug=byId('slug');
let selected=null;
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
function renderPublications(){
  byId('publications').hidden=!publications.size;
  const list=byId('publication-list');
  list.replaceChildren();
  for(const item of [...publications.values()].reverse()){
    const row=element('article','',list);
    const details=element('div','',row);
    element('strong',item.slug+' · '+item.sha.slice(0,8),details);
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
    document.querySelectorAll('button').forEach(button=>button.disabled=false);
  }
}
function element(tag,text,parent) {
  const node=document.createElement(tag);
  node.textContent=text;
  parent.append(node);
  return node;
}
function select(report) {
  form.reset();
  selected=report;
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
    element('button','Редактировать',actions).onclick=()=>{
      select(report);
      byId('editor').scrollIntoView();
    };
    const remove=element('button','Убрать',actions);
    remove.className='remove';
    remove.onclick=()=>{
      const confirm=prompt('Чтобы убрать отчёт, введите название папки: '+report.slug);
      if(confirm!==report.slug)return;
      run(async()=>{
        const result=await api('/'+report.slug,'DELETE',{confirm,revision:report.revision});
        trackPublication(result,report.slug);
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
    const html=byId('html').files[0];
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
    select(null);
    await list();
    message('Сохранено в GitHub. Коммит '+result.commit.slice(0,8)+'. GitHub Pages обновит страницу после сборки.');
  });
};
byId('reset').onclick=()=>select(null);
byId('refresh').onclick=()=>run(async()=>{await list();void checkPublications();message('Список обновлён.');});
byId('login').onsubmit=event=>{
  event.preventDefault();
  run(async()=>{
    const password=byId('password');
    const bytes=new TextEncoder().encode('admin:'+password.value);
    authorization='Basic '+btoa(String.fromCharCode(...bytes));
    password.value='';
    try { await list(); } catch(error) { authorization=''; throw error; }
    byId('login').hidden=true;
    byId('workspace').hidden=false;
    byId('refresh').hidden=false;
    message('Вход выполнен.');
    renderPublications();
    void checkPublications();
  });
};
byId('logout').onclick=()=>{
  authorization='';
  publicationSession++;
  clearTimeout(publicationTimer);
  select(null);
  byId('reports').replaceChildren();
  byId('workspace').hidden=true;
  byId('refresh').hidden=true;
  byId('login').hidden=false;
  message('Вы вышли.');
};
