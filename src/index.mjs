// Adapted from Cloudflare's MIT-licensed multiplayer Doom router.
const CODE = /^[a-z2-9]{8}$/;
const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
function newCode() { const b=crypto.getRandomValues(new Uint8Array(8)); return Array.from(b, x => alphabet[x % alphabet.length]).join(''); }
function json(data,status=200) { return Response.json(data,{status,headers:{'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}}); }
export default {
 async fetch(request, env) {
  const url=new URL(request.url), path=url.pathname.split('/').filter(Boolean);
  if(path[0]!=='api') {
   const assetUrl=new URL('/',url);
   return env.ASSETS ? env.ASSETS.fetch(new Request(assetUrl,request)) : new Response('FOSS-BU room relay', {status:200});
  }
  if(path[1]==='newroom' && path.length===2 && request.method==='GET') {
   const code=newCode(), stub=env.router.get(env.router.idFromName(code));
   const response=await stub.fetch('https://room.internal/init',{method:'POST'});
   if(!response.ok) return json({error:'Could not create a room'},503);
   return json({room:code});
  }
  if((path[1]==='room'||path[1]==='ws') && CODE.test(path[2]||'')) {
   return env.router.get(env.router.idFromName(path[2])).fetch(request);
  }
  return json({error:'Invalid room'},404);
 }
};
export class Router {
 constructor(state) { this.state=state; this.sessions=[]; this.sockets=new Set(); }
 async fetch(request) {
  const path=new URL(request.url).pathname.split('/').filter(Boolean);
  if(path[0]==='init' && request.method==='POST') {
   if(await this.state.storage.get('created')) return new Response('exists',{status:409});
   await this.state.storage.put({created:Date.now(),started:false});
   return new Response('ok');
  }
  const created=await this.state.storage.get('created');
  if(!created || Date.now()-created>12*60*60*1000) return json({error:'Room not found or expired'},404);
  if(path[1]==='room') {
   if(path[3]==='started') await this.state.storage.put('started',true);
   return json({room:path[2],gameStarted:!!(await this.state.storage.get('started'))});
  }
  if(path[1]==='ws') {
   if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return new Response('Expected WebSocket',{status:400});
   if(await this.state.storage.get('started')) return new Response('Match already started',{status:409});
   if(this.sockets.size>=2) return new Response('Room full',{status:409});
   const pair=new WebSocketPair(); const client=pair[0],socket=pair[1];
   socket.accept(); this.sockets.add(socket); let identity=null, count=0, epoch=Date.now();
   socket.addEventListener('message', event => {
    if(Date.now()-epoch>1000){count=0;epoch=Date.now()}
    if(++count>500){socket.close(1008,'Message limit');return;}
    const data=event.data;
    if(!(data instanceof ArrayBuffer) || data.byteLength<8 || data.byteLength>65536) { socket.close(1003,'Invalid packet'); return; }
    const view=new DataView(data), to=view.getUint32(0,true), from=view.getUint32(4,true);
    if(identity!==null && identity!==from){socket.close(1008,'Invalid identity');return;}
    if(this.sessions.some(s=>s.from===from && s.ws!==socket)){socket.close(1008,'Duplicate player');return;}
    identity=from;
    if(from===1 && to===0) { for(const s of this.sessions) if(s.ws!==socket) s.ws.close(1000,'New host'); this.sessions=[]; }
    if(!this.sessions.some(s=>s.from===from)) this.sessions.push({ws:socket,from});
    const destination=this.sessions.find(s=>s.from===to);
    if(destination) destination.ws.send(data.slice(4));
   });
   const cleanup=()=>{this.sockets.delete(socket);this.sessions=this.sessions.filter(s=>s.ws!==socket)};
   socket.addEventListener('close',cleanup);socket.addEventListener('error',cleanup);
   return new Response(null,{status:101,webSocket:client});
  }
  return json({error:'Not found'},404);
 }
}

