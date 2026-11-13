import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO = 'den123444/autoteka',
  GITHUB_BRANCH = 'main', PUBLIC_REPORTS_URL = 'https://den123444.github.io/autoteka/' } = process.env;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16 || !GITHUB_TOKEN) {
  throw new Error('Укажите ADMIN_PASSWORD (от 16 символов) и GITHUB_TOKEN.');
}
if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPO)) throw new Error('Некорректный GITHUB_REPO.');
const publicBase = new URL(PUBLIC_REPORTS_URL);
if (publicBase.protocol !== 'https:' || !publicBase.pathname.endsWith('/')) {
  throw new Error('PUBLIC_REPORTS_URL должен быть HTTPS-адресом с / в конце.');
}
const adminOrigin = new URL(process.env.ADMIN_ORIGIN || publicBase.origin).origin;
const expected = digest('admin:' + ADMIN_PASSWORD);
const slugPattern = /^(?!admin$)[a-z0-9][a-z0-9-]{0,99}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const allowedAsset = /^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp|gif|avif|ico|svg|css|js|woff2?)$/i;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };
const staticFiles = new Map([
  ['/admin', ['index.html', 'text/html; charset=utf-8']],
  ['/admin/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/admin/style.css', ['style.css', 'text/css; charset=utf-8']]
].map(([url,[file,type]]) => [url,[readFileSync(new URL(file,import.meta.url)),type]]));

function digest(value) { return createHash('sha256').update(value).digest(); }
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function send(res,status,body,type='application/json; charset=utf-8',extra={}) {
  res.writeHead(status,{...headers,...res.adminCors,'Content-Type':type,...extra});
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
async function github(endpoint,method='GET',body) {
  const response = await fetch('https://api.github.com/repos/'+GITHUB_REPO+endpoint,{
    method, signal:AbortSignal.timeout(30_000),
    headers:{Authorization:'Bearer '+GITHUB_TOKEN,Accept:'application/vnd.github+json',
      'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    if (['409','422'].includes(String(response.status)) && endpoint.startsWith('/git/refs/')) {
      fail(409,'Ветка изменилась или защищена. Обновите список и проверьте настройки ветки.');
    }
    fail(502,'GitHub вернул '+response.status+'. Проверьте токен, ветку и доступ к репозиторию.');
  }
  return response.json();
}
const ref='/git/ref/heads/'+encodeURIComponent(GITHUB_BRANCH);
async function repository() {
  const head=(await github(ref)).object.sha;
  const commit=await github('/git/commits/'+head);
  const root=await github('/git/trees/'+commit.tree.sha+'?recursive=1');
  if (root.truncated) fail(502,'Дерево GitHub слишком большое. Данные не изменены.');
  const entries=new Map(root.tree.map(entry=>[entry.path,entry]));
  const reports=root.tree.filter(entry=>{
    const [slug,file,extra]=entry.path.split('/');
    return file==='index.html' && !extra && slugPattern.test(slug) &&
      entry.mode==='100644' && entries.get(slug)?.type==='tree';
  }).map(entry=>{
    const slug=entry.path.split('/')[0];
    return {slug,revision:entries.get(slug).sha,url:new URL(slug+'/',publicBase).href};
  });
  return {head,tree:commit.tree.sha,reports,entries};
}
async function readJson(req) {
  if (req.headers['x-admin-request']!=='1' || req.headers['content-type']!=='application/json') {
    fail(403,'Запрос отклонён.');
  }
  const chunks=[];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>32_000_000) fail(413,'Пакет слишком большой. Лимит файлов — 20 МБ.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { fail(400,'Некорректные данные.'); }
}
function normalizeFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length>120) fail(400,'Выберите от 1 до 120 файлов.');
  const unique=new Map();
  let size=0;
  for (const file of files) {
    if (!file || typeof file.path!=='string' || typeof file.data!=='string' ||
      !(file.path==='index.html' || allowedAsset.test(file.path)) ||
      unique.has(file.path) || !/^[a-zA-Z0-9+/]*={0,2}$/.test(file.data) || file.data.length%4) {
      fail(400,'Разрешены index.html и поддерживаемые файлы внутри assets/.');
    }
    const bytes=Buffer.from(file.data,'base64');
    size+=bytes.length;
    if (size>20_000_000) fail(413,'Лимит файлов — 20 МБ.');
    if (file.path==='index.html' && !/<(?:!doctype html|html)(?:\s|>)/i.test(bytes.toString('utf8'))) {
      fail(400,'Загрузите полный HTML отчёта.');
    }
    unique.set(file.path,file.data);
  }
  return unique;
}
async function publish(repo,slug,changes,message) {
  const tree=await github('/git/trees','POST',{base_tree:repo.tree,tree:changes});
  const commit=await github('/git/commits','POST',{message:message+': '+slug,tree:tree.sha,parents:[repo.head]});
  await github(ref.replace('/ref/','/refs/'),'PATCH',{sha:commit.sha,force:false});
  return {commit:commit.sha, url:new URL(slug+'/',publicBase).href};
}

export const server=createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if (req.method==='GET' && url.pathname==='/health') return send(res,200,{ok:true});
    if (req.method==='GET' && (url.pathname==='/' || url.pathname==='/admin/')) {
      return send(res,302,'','text/plain',{Location:'/admin'});
    }
    const origin=req.headers.origin;
    if (origin && origin!==adminOrigin) fail(403,'Источник запроса не разрешён.');
    if (origin) res.adminCors={
      'Access-Control-Allow-Origin':adminOrigin,'Vary':'Origin',
      'Access-Control-Allow-Methods':'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':'Authorization, Content-Type, X-Admin-Request'
    };
    if (req.method==='OPTIONS' && url.pathname.startsWith('/admin/api/')) {
      return send(res,204,'');
    }
    const auth=req.headers.authorization||'';
    const credentials=auth.startsWith('Basic ') ? Buffer.from(auth.slice(6),'base64') : Buffer.alloc(0);
    if (!timingSafeEqual(digest(credentials),expected)) {
      return send(res,401,'Требуется вход. Имя пользователя: admin.','text/plain; charset=utf-8',
        {'WWW-Authenticate':'Basic realm="Reports Admin", charset="UTF-8"'});
    }
    if (req.method==='GET' && staticFiles.has(url.pathname)) {
      const [content,type]=staticFiles.get(url.pathname);
      return send(res,200,content,type);
    }
    if (req.method==='GET' && url.pathname==='/admin/api/reports') {
      return send(res,200,(await repository()).reports);
    }
    if (req.method==='GET' && url.pathname==='/admin/api/reports/publication') {
      const sha=url.searchParams.get('sha')||'';
      if (!shaPattern.test(sha)) fail(400,'Некорректный SHA коммита.');
      const workflow=process.env.PAGES_WORKFLOW?.trim();
      const endpoint=workflow ? '/actions/workflows/'+encodeURIComponent(workflow)+'/runs' : '/actions/runs';
      const query=new URLSearchParams({head_sha:sha,per_page:'100'});
      const {workflow_runs}=await github(endpoint+'?'+query);
      const run=workflow_runs.filter(item=>item.head_sha===sha && (workflow ||
        /^pages build and deployment$/i.test(item.name) ||
        /(?:^|\/)(?:pages|jekyll|jekyll-docker)\.ya?ml(?:@|$)/i.test(item.path||'')
      )).sort((a,b)=>b.id-a.id)[0];
      const actions='https://github.com/'+GITHUB_REPO+'/actions';
      if (!run) return send(res,200,{status:'waiting',url:actions});
      return send(res,200,{
        status:run.status,conclusion:run.conclusion,
        updatedAt:run.updated_at,url:actions+'/runs/'+run.id
      });
    }
    const match=url.pathname.match(/^\/admin\/api\/reports\/([a-z0-9-]+)$/);
    const slug=match?.[1];
    if (!slug || !slugPattern.test(slug)) fail(404,'Страница не найдена.');
    if (req.method==='GET') {
      const repo=await repository();
      if (!repo.reports.some(report=>report.slug===slug)) fail(404,'Отчёт не найден.');
      const entry=repo.entries.get(slug+'/index.html');
      const blob=await github('/git/blobs/'+entry.sha);
      return send(res,200,Buffer.from(blob.content,'base64'),'application/octet-stream',
        {'Content-Disposition':'attachment; filename="'+slug+'.html"'});
    }
    if (!['PUT','DELETE'].includes(req.method)) fail(405,'Метод не поддерживается.');
    const input=await readJson(req);
    if (!input || typeof input!=='object') fail(400,'Некорректные данные.');
    const files=req.method==='PUT'?normalizeFiles(input.files):null;
    const repo=await repository();
    const current=repo.reports.find(report=>report.slug===slug);
    if (input.revision===null && req.method==='PUT') {
      if (repo.entries.has(slug)) fail(409,'Папка с таким адресом уже существует.');
      if (!files.has('index.html')) fail(400,'Для нового отчёта нужен index.html.');
    } else if (!shaPattern.test(input.revision||'') || !current || input.revision!==current.revision) {
      fail(409,'Отчёт изменился. Обновите список перед сохранением.');
    }
    if (req.method==='DELETE') {
      if (input.confirm!==slug) fail(400,'Подтвердите название папки.');
      return send(res,200,await publish(repo,slug,[{path:slug,mode:'040000',type:'tree',sha:null}],'Remove report'));
    }
    const changes=[];
    for(const [file,content] of files) {
      const blob=await github('/git/blobs','POST',{content,encoding:'base64'});
      changes.push({path:slug+'/'+file,mode:'100644',type:'blob',sha:blob.sha});
    }
    return send(res,200,await publish(repo,slug,changes,current?'Update report':'Add report'));
  } catch(error) {
    if (!res.headersSent) send(res,error.status||500,{error:error.status?error.message:'Не удалось выполнить запрос.'});
  }
});
server.listen(Number(process.env.PORT||3000),'0.0.0.0');
