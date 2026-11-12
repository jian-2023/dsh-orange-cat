/**
 * dsh-orange-cat — 橘猫桌宠 for the DSH web GUI.
 *
 * 服务端职责（全部在 host 侧，零第三方依赖）：
 *  - `webserver/index-inject` 把样式、猫的 DOM 和控制器脚本注入 index.html；
 *  - `prefix` 路由 /orange-cat/media 带 Range 支持地提供精灵图与音效；
 *  - `POST /orange-cat/notify?kind=done|ask` 让任何脚本显式触发提醒，
 *    通过 SSE（/orange-cat/events）广播给所有打开的 GUI 标签页。
 *
 * 客户端职责（注入的脚本，见 buildClientScript）：
 *  - canvas 逐帧播放精灵图动画（静坐/舔毛/眨眼/玩耍 + 两个点击姿势）；
 *  - 拖动、单击表情、双击曼波、右键菜单；
 *  - 侦测「助手回答结束」并播放任务完成提示音（曼波/哈基米 各 1/2）。
 *
 * @module dsh-orange-cat
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolvePath(fileURLToPath(new URL('..', import.meta.url)))

export const name = 'dsh-orange-cat'
export const inject = ['webServer']

const MEDIA_ROUTE = '/orange-cat/media'
const NOTIFY_ROUTE = '/orange-cat/notify'
const SSE_ROUTE = '/orange-cat/events'

const MIME = {
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

export const DEFAULTS = {
  enabled: true,
  mediaDir: 'media',
  /** 猫画布边长（px）。 */
  size: 150,
  /** 初始贴边距离。 */
  marginX: 28,
  marginY: 28,
  volume: 0.8,
  doneSounds: ['manbo.wav', 'hjm.wav'],
  askSounds: ['manbo.wav'],
  /** 在浏览器里侦测回答结束并自动播放提示音。 */
  taskDoneWatch: true,
  weights: {
    real_sit: 0.74,
    real_groom: 0.16,
    real_1: 0.05,
    real_2: 0.05,
  },
  /** 静坐一次保持的秒数（原生版为 60s，网页里略缩短）。 */
  sitHoldSec: 25,
  /** 单击姿势保持毫秒数。 */
  poseHoldMs: 700,
}

/** 已连接的 SSE 客户端（res 对象）。 */
const sseClients = new Set()
/** 最近一次通知，供新连接的客户端立即感知。 */
let lastNotify = null

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  if (!cfg.enabled) return

  for (const file of [...cfg.doneSounds, ...cfg.askSounds]) {
    if (!existsSync(join(cfg.mediaDir, file))) {
      ctx.logger?.warn?.(`dsh-orange-cat: missing sound ${join(cfg.mediaDir, file)}`)
    }
  }
  if (!existsSync(join(cfg.mediaDir, 'manifest.json'))) {
    ctx.logger?.warn?.('dsh-orange-cat: media/manifest.json missing — cat will not animate')
  }

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: MEDIA_ROUTE,
        handler: createMediaHandler(cfg),
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-orange-cat: cannot serve ${MEDIA_ROUTE}: ${String(error)}`)
      return () => {}
    }
  })

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: SSE_ROUTE,
        handler: createSseHandler(),
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-orange-cat: cannot serve ${SSE_ROUTE}: ${String(error)}`)
      return () => {}
    }
  })

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: NOTIFY_ROUTE,
        handler: createNotifyHandler(cfg),
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-orange-cat: cannot serve ${NOTIFY_ROUTE}: ${String(error)}`)
      return () => {}
    }
  })

  ctx.on('webserver/index-inject', (table) => {
    table.push(
      { kind: 'style', text: buildStyle(cfg) },
      { kind: 'html', placement: 'body', html: buildMarkup(cfg) },
      { kind: 'script', placement: 'body', text: buildClientScript(cfg) },
    )
  })
}

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...input }
  cfg.enabled = cfg.enabled !== false
  cfg.mediaDir = resolvePath(PKG_DIR, String(cfg.mediaDir || DEFAULTS.mediaDir))
  cfg.size = clamp(cfg.size, 60, 400, DEFAULTS.size)
  cfg.marginX = clamp(cfg.marginX, 0, 500, DEFAULTS.marginX)
  cfg.marginY = clamp(cfg.marginY, 0, 500, DEFAULTS.marginY)
  cfg.volume = clampFloat(cfg.volume, 0, 1, DEFAULTS.volume)
  cfg.sitHoldSec = clamp(cfg.sitHoldSec, 3, 600, DEFAULTS.sitHoldSec)
  cfg.poseHoldMs = clamp(cfg.poseHoldMs, 100, 5000, DEFAULTS.poseHoldMs)
  cfg.doneSounds = strList(cfg.doneSounds, DEFAULTS.doneSounds)
  cfg.askSounds = strList(cfg.askSounds, DEFAULTS.askSounds)
  cfg.taskDoneWatch = cfg.taskDoneWatch !== false
  const w = cfg.weights && typeof cfg.weights === 'object' ? cfg.weights : DEFAULTS.weights
  const weights = {}
  let sum = 0
  for (const [k, v] of Object.entries(w)) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0 && typeof k === 'string' && /^[\w-]+$/.test(k)) {
      weights[k] = n
      sum += n
    }
  }
  cfg.weights = sum > 0 ? weights : DEFAULTS.weights
  return cfg
}

function strList(v, fallback) {
  if (!Array.isArray(v)) return fallback
  const out = v.filter((s) => typeof s === 'string' && /^[\w.-]+$/.test(s))
  return out.length ? out : fallback
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/* -------------------------------------------------------------------------- */
/* media route (Range-capable static file server)                             */
/* -------------------------------------------------------------------------- */

function createMediaHandler(cfg) {
  return function mediaHandler(req, res) {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const rel = (pathname.startsWith(MEDIA_ROUTE) ? pathname.slice(MEDIA_ROUTE.length) : pathname)
      .replace(/^\/+/, '')
    if (!rel || rel.includes('/') || rel.includes('\\') || rel.includes('..')) {
      res.writeHead(404)
      res.end()
      return
    }
    const file = join(cfg.mediaDir, rel)
    let stat
    try {
      stat = statSync(file)
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    const size = stat.size
    const headers = {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache, no-transform',
      etag: `"${size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
      'last-modified': stat.mtime.toUTCString(),
    }
    const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match !== null && (match[1] !== '' || match[2] !== '')) {
      let start
      let end
      if (match[1] === '') {
        const suffix = Number(match[2])
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
          res.end()
          return
        }
        start = Math.max(0, size - suffix)
        end = size - 1
      } else {
        start = Number(match[1])
        end = match[2] === '' ? size - 1 : Number(match[2])
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
          res.end()
          return
        }
        end = Math.min(end, size - 1)
      }
      res.writeHead(206, {
        ...headers,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
      })
      if (method === 'HEAD') { res.end(); return }
      stream(res, file, { start, end })
      return
    }
    res.writeHead(200, { ...headers, 'content-length': size })
    if (method === 'HEAD') { res.end(); return }
    stream(res, file, {})
  }
}

function stream(res, file, options) {
  const source = createReadStream(file, options)
  source.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.destroy()
  })
  res.on('close', () => source.destroy())
  source.pipe(res)
}

/* -------------------------------------------------------------------------- */
/* SSE broadcast + notify endpoint                                            */
/* -------------------------------------------------------------------------- */

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch { /* client gone */ }
}

function broadcast(event, data) {
  for (const res of sseClients) sseWrite(res, event, data)
}

function createSseHandler() {
  return function sseHandler(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    if (lastNotify) sseWrite(res, 'notify', lastNotify)
    sseClients.add(res)
    const ping = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* ignore */ }
    }, 15000)
    const drop = () => {
      clearInterval(ping)
      sseClients.delete(res)
    }
    res.on('close', drop)
    res.on('error', drop)
  }
}

function createNotifyHandler(cfg) {
  return function notifyHandler(req, res) {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }
    let kind = 'done'
    try {
      kind = new URL(req.url ?? '/', 'http://localhost').searchParams.get('kind') ?? 'done'
    } catch { /* keep default */ }
    if (kind !== 'done' && kind !== 'ask') kind = 'done'
    const payload = { kind, at: Date.now() }
    lastNotify = payload
    broadcast('notify', payload)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, kind, clients: sseClients.size }))
  }
}

/* -------------------------------------------------------------------------- */
/* injected markup / style / client script                                    */
/* -------------------------------------------------------------------------- */

function buildStyle(cfg) {
  return `
#dsh-orange-cat{position:fixed;z-index:2147483000;width:${cfg.size}px;height:${cfg.size}px;
  pointer-events:auto;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;
  filter:drop-shadow(0 6px 10px rgba(0,0,0,.35));transition:opacity .25s ease}
#dsh-orange-cat.is-hidden{display:none!important}
#dsh-orange-cat.is-dragging{cursor:grabbing}
#dsh-orange-cat canvas{width:100%;height:100%;display:block}
#dsh-oc-toast{position:fixed;z-index:2147483001;padding:6px 14px;border-radius:10px;
  background:rgba(20,26,36,.92);color:#f2e8dc;font:13px/1.4 system-ui,sans-serif;
  box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:none;opacity:0;
  transition:opacity .2s ease,transform .2s ease;transform:translateY(4px)}
#dsh-oc-toast.is-show{opacity:1;transform:translateY(0)}
#dsh-oc-menu{position:fixed;z-index:2147483002;min-width:110px;padding:4px;border-radius:10px;
  background:rgba(24,28,38,.96);border:1px solid rgba(255,255,255,.12);
  box-shadow:0 6px 18px rgba(0,0,0,.45);font:13px/1 system-ui,sans-serif;color:#eee;display:none}
#dsh-oc-menu.is-open{display:block}
#dsh-oc-menu button{display:block;width:100%;padding:7px 12px;border:0;background:none;
  color:inherit;font:inherit;text-align:left;border-radius:7px;cursor:pointer}
#dsh-oc-menu button:hover{background:rgba(240,149,59,.25)}
`.trim()
}

function buildMarkup(_cfg) {
  return [
    '<div id="dsh-orange-cat" role="img" aria-label="橘猫桌宠" data-state="idle">',
    '<canvas width="8" height="8"></canvas>',
    '</div>',
    '<div id="dsh-oc-toast"></div>',
    '<div id="dsh-oc-menu"></div>',
  ].join('')
}

function buildClientScript(cfg) {
  const client = {
    base: MEDIA_ROUTE,
    sse: SSE_ROUTE,
    size: cfg.size,
    marginX: cfg.marginX,
    marginY: cfg.marginY,
    volume: cfg.volume,
    doneSounds: cfg.doneSounds,
    askSounds: cfg.askSounds,
    taskDoneWatch: cfg.taskDoneWatch,
    weights: cfg.weights,
    sitHoldSec: cfg.sitHoldSec,
    poseHoldMs: cfg.poseHoldMs,
  }
  return `(function(){
var CFG=${js(client)}
try{
var cat=document.getElementById('dsh-orange-cat')
if(!cat)return
var canvas=cat.querySelector('canvas')
var ctx2d=canvas.getContext('2d')
var toastEl=document.getElementById('dsh-oc-toast')
var menuEl=document.getElementById('dsh-oc-menu')
var LS='dsh-orange-cat'
var prefs={}
try{prefs=JSON.parse(localStorage.getItem(LS)||'{}')}catch(e){}
if(prefs.muted===undefined)prefs.muted=false
if(prefs.enabled===undefined)prefs.enabled=true
if(!prefs.enabled){cat.classList.add('is-hidden');return}
var manifest=null,images={}
var state={anim:'real_sit',frame:0,timer:null,holdUntil:0,poseBackup:null}
var audioUnlocked=false

/* ---------- 精灵图 ---------- */
function load(cb){
  fetch(CFG.base+'/manifest.json').then(function(r){return r.json()}).then(function(m){
    manifest=m;var anims=m.anims||{};var pending=0
    var names=Object.keys(anims)
    names.forEach(function(n){pending++
      var im=new Image()
      im.onload=function(){if(--pending<=0)cb()}
      im.onerror=function(){if(--pending<=0)cb()}
      im.src=CFG.base+'/'+anims[n].sheet
      images[n]=im
    })
    if(pending<=0)cb()
  }).catch(function(){cb()})
}

function draw(){
  if(!manifest)return
  var a=manifest.anims[state.anim]
  if(!a||!images[state.anim]||!images[state.anim].naturalWidth)return
  if(canvas.width!==a.fw||canvas.height!==a.fh){canvas.width=a.fw;canvas.height=a.fh}
  var col=state.frame%a.cols,row=Math.floor(state.frame/a.cols)
  ctx2d.clearRect(0,0,a.fw,a.fh)
  ctx2d.drawImage(images[state.anim],col*a.fw,row*a.fh,a.fw,a.fh,0,0,a.fw,a.fh)
}

function play(anim,onEnd){
  stopTimer()
  state.anim=anim;state.frame=0
  if(!manifest||!manifest.anims[anim]){if(onEnd)onEnd();return}
  var a=manifest.anims[anim]
  var tick=function(){
    state.frame++
    if(state.frame>=a.count){
      if(onEnd){onEnd();return}
      state.frame=0
    }
    draw()
    state.timer=setTimeout(tick,a.delay)
  }
  draw();state.timer=setTimeout(tick,a.delay)
}
function loop(anim){play(anim,null)}
function stopTimer(){if(state.timer){clearTimeout(state.timer);state.timer=null}}

/* ---------- 片段调度（同原生版：按权重抽取，静坐保持） ---------- */
function pick(){
  var entries=Object.entries(CFG.weights).filter(function(e){return manifest&&manifest.anims[e[0]]})
  var sum=0;entries.forEach(function(e){sum+=e[1]})
  if(sum<=0)return 'real_sit'
  var r=Math.random()*sum
  for(var i=0;i<entries.length;i++){r-=entries[i][1];if(r<=0)return entries[i][0]}
  return entries[0][0]
}
function schedule(){
  var anim=pick()
  if(anim==='real_sit'){
    loop('real_sit')
    state.holdUntil=Date.now()+CFG.sitHoldSec*1000
    state.timer=setTimeout(schedule,CFG.sitHoldSec*1000)
  }else{
    play(anim,schedule)
  }
}

/* ---------- 音效 ---------- */
var audioPool={}
function sound(files){
  if(prefs.muted||!files||!files.length)return false
  var f=files[Math.floor(Math.random()*files.length)]
  try{
    var a=audioPool[f]
    if(!a){a=new Audio(CFG.base+'/'+encodeURIComponent(f));a.volume=CFG.volume;a.preload='auto';audioPool[f]=a}
    a.currentTime=0
    var p=a.play()
    if(p&&p.catch)p.catch(function(){toast('🔇 浏览器拦截了自动播放，点一下猫即可解锁音效')})
    return true
  }catch(e){return false}
}
function unlockAudio(){
  if(audioUnlocked)return;audioUnlocked=true
  Object.keys(audioPool).forEach(function(k){try{audioPool[k].play().then(function(){audioPool[k].pause()}).catch(function(){})}catch(e){}})
}
document.addEventListener('pointerdown',unlockAudio,{once:true,capture:true})

/* ---------- 提示气泡 ---------- */
var toastTimer=null
function toast(msg){
  if(!toastEl)return
  toastEl.textContent=msg
  var x=cat.getBoundingClientRect()
  toastEl.style.left=Math.max(8,x.left+x.width/2-80)+'px'
  toastEl.style.top=Math.max(8,(x.top-36))+'px'
  toastEl.classList.add('is-show')
  if(toastTimer)clearTimeout(toastTimer)
  toastTimer=setTimeout(function(){toastEl.classList.remove('is-show')},2600)
}

/* ---------- 任务完成 / 询问 提醒 ---------- */
var lastDone=0
function notify(kind){
  if(kind==='ask'){
    sound(CFG.askSounds);toast('💬 在等你确认～');react('pose_tilt');return
  }
  var now=Date.now()
  if(now-lastDone<1000)return  /* 与原生版一致的 1s 去抖 */
  lastDone=now
  sound(CFG.doneSounds);toast('✅ 任务完成！')
  /* 反应动作：随机一段眨眼睛动画播完回调度 */
  var blinks=['real_1'].filter(function(n){return manifest&&manifest.anims[n]})
  if(blinks.length)play(blinks[Math.floor(Math.random()*blinks.length)],schedule)
  else schedule()
}

/* SSE：外部脚本可 POST /orange-cat/notify?kind=done|ask */
try{
  var es=new EventSource(CFG.sse)
  es.addEventListener('notify',function(ev){
    try{var d=JSON.parse(ev.data);notify(d.kind==='ask'?'ask':'done')}catch(e){}
  })
}catch(e){}

/* 浏览器内侦测「助手回答结束」：包装 fetch，识别流式聊天响应 */
if(CFG.taskDoneWatch&&!window.__dshOrangeCatPatched){
  window.__dshOrangeCatPatched=true
  var of=window.fetch
  window.fetch=function(){
    var args=arguments
    var url=''
    try{url=String(typeof args[0]==='string'?args[0]:(args[0]&&args[0].url)||'')}catch(e){}
    var out=of.apply(this,args)
    var isChat=/chat|completion|message|agent|session/i.test(url)&&/POST/i.test((args[1]&&args[1].method)||'GET')
    if(isChat){
      out.then(function(res){
        try{
          var ct=(res.headers&&res.headers.get&&res.headers.get('content-type'))||''
          if(!/stream|text\\/event-stream/i.test(ct))return
          var body=res.body;if(!body)return
          var rd=body.getReader()
          var chunks=0
          function pump(){
            rd.read().then(function(r){
              if(r.done){if(chunks>2)setTimeout(function(){notify('done')},400);return}
              chunks++;return pump()
            }).catch(function(){})
          }
          pump()
        }catch(e){}
      }).catch(function(){})
    }
    return out
  }
}

/* ---------- 指针交互：拖动 / 单击表情 / 双击曼波 / 右键菜单 ---------- */
var down=null,moved=false,dragging=false,offX=0,offY=0,lastClick=0
function clampPos(x,y){
  var s=CFG.size
  return [Math.min(Math.max(0,x),window.innerWidth-s),
          Math.min(Math.max(0,y),window.innerHeight-s)]
}
function setPos(x,y){
  var p=clampPos(x,y)
  cat.style.left=p[0]+'px';cat.style.top=p[1]+'px'
  prefs.x=p[0];prefs.y=p[1]
}
function initPos(){
  if(typeof prefs.x==='number'&&typeof prefs.y==='number'){setPos(prefs.x,prefs.y);return}
  setPos(window.innerWidth-CFG.size-CFG.marginX,window.innerHeight-CFG.size-CFG.marginY)
}
cat.addEventListener('pointerdown',function(e){
  if(e.button===2)return
  down={t:Date.now(),x:e.clientX,y:e.clientY};moved=false
  cat.setPointerCapture(e.pointerId)
})
cat.addEventListener('pointermove',function(e){
  if(!down)return
  var dx=e.clientX-down.x,dy=e.clientY-down.y
  if(!moved&&Math.hypot(dx,dy)>4){moved=true;dragging=true;cat.classList.add('is-dragging')
    var r=cat.getBoundingClientRect();offX=e.clientX-r.left;offY=e.clientY-r.top}
  if(dragging)setPos(e.clientX-offX,e.clientY-offY)
})
cat.addEventListener('pointerup',function(e){
  if(!down)return
  var d=down;down=null
  if(dragging){dragging=false;cat.classList.remove('is-dragging')
    try{localStorage.setItem(LS,JSON.stringify(prefs))}catch(err){}
    return}
  var dt=Date.now()-d.t
  if(dt>600)return
  if(e.button===2)return
  var now=Date.now()
  if(now-lastClick<300){lastClick=0;sound(['manbo.wav']);toast('🎵 曼波！');react('pose_tilt');return}
  lastClick=now
  /* 单击：惊讶/眯眼歪头 各 1/2，保持后回调度 */
  react(Math.random()<0.5?'pose_surprise':'pose_tilt')
})
cat.addEventListener('contextmenu',function(e){
  e.preventDefault();e.stopPropagation()
  openMenu(e.clientX,e.clientY)
})
function react(name){
  if(!manifest||!manifest.anims[name])return
  play(name,function(){
    /* 回到点击前的片段：简化为回调度（静坐循环无缝） */
    if(Date.now()<state.holdUntil){loop('real_sit');state.timer=setTimeout(schedule,Math.max(0,state.holdUntil-Date.now()))}
    else schedule()
  })
}

/* ---------- 右键菜单 ---------- */
function menuBtn(label,fn){
  var b=document.createElement('button');b.textContent=label
  b.addEventListener('click',function(ev){ev.stopPropagation();closeMenu();fn()})
  return b
}
function openMenu(x,y){
  if(!menuEl)return
  menuEl.innerHTML=''
  menuEl.appendChild(menuBtn(prefs.muted?'🔇 取消静音':'🔊 静音',function(){
    prefs.muted=!prefs.muted;save()
  }))
  menuEl.appendChild(menuBtn('📍 重置位置',function(){
    setPos(window.innerWidth-CFG.size-CFG.marginX,window.innerHeight-CFG.size-CFG.marginY);save()
  }))
  menuEl.appendChild(menuBtn('🙈 隐藏（右键无入口，刷新页面即恢复）',function(){
    cat.classList.add('is-hidden')
  }))
  menuEl.style.left=Math.min(x,window.innerWidth-130)+'px'
  menuEl.style.top=Math.min(y,window.innerHeight-120)+'px'
  menuEl.classList.add('is-open')
}
function closeMenu(){if(menuEl)menuEl.classList.remove('is-open')}
document.addEventListener('pointerdown',function(e){
  if(menuEl&&menuEl.classList.contains('is-open')&&!menuEl.contains(e.target))closeMenu()
},true)
function save(){try{localStorage.setItem(LS,JSON.stringify(prefs))}catch(e){}}

window.addEventListener('resize',function(){initPos()})

/* ---------- 启动 ---------- */
initPos()
load(function(){
  if(!manifest){toast('橘猫素材加载失败');return}
  schedule()
})
/* 供其它脚本调用：window.__orangeCat.notify('done'|'ask') */
window.__orangeCat={notify:notify,react:react,toast:toast}
}catch(e){try{console.warn('[dsh-orange-cat]',e)}catch(_){}}})()`
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function js(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
