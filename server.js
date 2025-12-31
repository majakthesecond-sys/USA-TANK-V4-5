const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const INDEX_A = path.join(__dirname, "public", "index.html");
const INDEX_B = path.join(__dirname, "index.html");

function readIndex() {
  if (fs.existsSync(INDEX_A)) return fs.readFileSync(INDEX_A);
  if (fs.existsSync(INDEX_B)) return fs.readFileSync(INDEX_B);
  return null;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// --- Matchmaking ---
// We support:
// - ONLINE1V1 (2 players)
// - ONLINE2V2 (4 players)
// - ONLINEPVP (2-6 players, auto-balance; starts after a short queue window or when 6 reached)
const clients = new Map(); // ws -> {id, tier, tankName, mode, roomId, username}
const waiting = new Map(); // key=(mode|tier) -> {queue:[ws...], timer:null, startedAt:number}
const rooms = new Map();   // roomId -> {hostWs, sockets:[ws...], players:[{id,tankName,username}], mode, tier}

function needMin(mode){
  if(mode === "ONLINE2V2") return 4;
  return 2; // ONLINE1V1 + ONLINEPVP
}
function needExact(mode){
  if(mode === "ONLINE1V1") return 2;
  if(mode === "ONLINE2V2") return 4;
  return 0; // ONLINEPVP variable
}
function maxPlayers(mode){
  return (mode === "ONLINEPVP") ? 6 : needExact(mode);
}
function keyOf(mode, tier){
  return `${mode}|${tier}`;
}

function send(ws, obj){
  if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(queue, obj){
  for(const s of queue) send(s, obj);
}

function cleanup(ws){
  const c = clients.get(ws);
  if(!c) return;

  // remove from waiting queues
  if(c.mode && c.tier != null){
    const k = keyOf(c.mode, c.tier);
    const bucket = waiting.get(k);
    if(bucket){
      bucket.queue = bucket.queue.filter(x=>x!==ws);
      if(bucket.queue.length === 0){
        if(bucket.timer) clearTimeout(bucket.timer);
        waiting.delete(k);
      }
    }
  }

  // close room if in one
  if(c.roomId && rooms.has(c.roomId)){
    const room = rooms.get(c.roomId);
    for(const s of room.sockets){
      if(s!==ws) send(s, {type:"info", text:"A player disconnected. Match ended."});
      try{ s.close(); }catch(_){}
    }
    rooms.delete(c.roomId);
  }

  clients.delete(ws);
}

// create room from first N sockets in queue
function createRoomFromQueue(mode, tier, takeN){
  const k = keyOf(mode, tier);
  const bucket = waiting.get(k);
  if(!bucket) return;
  const q = bucket.queue;

  if(takeN <= 0) return;
  const sockets = q.splice(0, takeN);

  // update bucket / cancel timer if emptied
  if(q.length === 0){
    if(bucket.timer) clearTimeout(bucket.timer);
    waiting.delete(k);
  } else {
    // keep bucket and re-broadcast status
    const need = needExact(mode) || `${needMin(mode)}-${maxPlayers(mode)}`;
    broadcast(q, { type:"roomInfo", roomId:null, hostId:null, players:[], text:`Searching… ${q.length}/${need} players` });
  }

  const roomId = uid();
  const hostWs = sockets[0];
  const players = sockets.map(s=>{
    const cc = clients.get(s);
    return { id: cc.id, tankName: cc.tankName, username: (cc.username||"") };
  });

  for(const s of sockets) clients.get(s).roomId = roomId;

  rooms.set(roomId, { hostWs, sockets, players, mode, tier });

  for(const s of sockets){
    send(s, { type:"roomInfo", roomId, hostId: clients.get(hostWs).id, players, text:"Match found!" });
  }
  send(hostWs, { type:"hostStart" });
}

function maybeStart(mode, tier){
  const k = keyOf(mode, tier);
  const bucket = waiting.get(k);
  if(!bucket) return;
  const q = bucket.queue;
  const exact = needExact(mode);
  const maxP = maxPlayers(mode);
  const minP = needMin(mode);

  // Exact-size modes
  if(exact){
    if(q.length >= exact){
      createRoomFromQueue(mode, tier, exact);
    }
    return;
  }

  // Variable-size PVP
  if(q.length >= maxP){
    // start immediately at 6
    createRoomFromQueue(mode, tier, maxP);
    return;
  }

  // start after a short window if >= min
  if(q.length >= minP && !bucket.timer){
    bucket.startedAt = Date.now();
    bucket.timer = setTimeout(()=>{
      // still have bucket?
      const b = waiting.get(k);
      if(!b) return;
      b.timer = null;
      const n = Math.min(maxPlayers(mode), b.queue.length);
      if(n >= minP){
        createRoomFromQueue(mode, tier, n);
      }
    }, 6500); // 6.5s "queue window"
  }
}

const server = http.createServer((req, res)=>{
  if(req.url === "/healthz"){
    res.writeHead(200, {"Content-Type":"text/plain"});
    return res.end("ok");
  }
  if(req.url === "/" || req.url === "/index.html"){
    const html = readIndex();
    if(!html){
      res.writeHead(500, {"Content-Type":"text/plain"});
      return res.end("Missing index.html (need public/index.html or index.html at root)");
    }
    res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
    return res.end(html);
  }
  res.writeHead(404, {"Content-Type":"text/plain"});
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws)=>{
  const id = uid();
  clients.set(ws, { id, tier:null, tankName:null, mode:null, roomId:null, username:"" });
  send(ws, { type:"welcome", id });

  ws.on("message", (buf)=>{
    let msg;
    try{ msg = JSON.parse(buf.toString("utf8")); }catch(_){ return; }
    const c = clients.get(ws);
    if(!c) return;

    if(msg.type === "join"){
      c.tier = Number(msg.tier || 1);
      c.tankName = String(msg.tankName || "Tank");
      c.mode = String(msg.mode || "ONLINEPVP");
      c.username = String(msg.username || "").trim().slice(0,16);

      const k = keyOf(c.mode, c.tier);
      const bucket = waiting.get(k) || { queue:[], timer:null, startedAt:0 };
      // avoid duplicates
      if(!bucket.queue.includes(ws)) bucket.queue.push(ws);
      waiting.set(k, bucket);

      const exact = needExact(c.mode);
      const needTxt = exact ? `${bucket.queue.length}/${exact}` : `${bucket.queue.length}/${needMin(c.mode)}-${maxPlayers(c.mode)}`;
      broadcast(bucket.queue, { type:"roomInfo", roomId:null, hostId:null, players:[], text:`Searching… ${needTxt} players` });

      maybeStart(c.mode, c.tier);
      return;
    }

    if(msg.type === "input" || msg.type === "init" || msg.type === "snapshot"){
      if(!c.roomId) return;
      const room = rooms.get(c.roomId);
      if(!room) return;

      if(msg.type === "input"){
        if(room.hostWs !== ws){
          send(room.hostWs, { type:"input", fromId:c.id, payload: msg.payload || {} });
        }
        return;
      }

      if(room.hostWs === ws){
        for(const s of room.sockets){
          if(s!==ws) send(s, { type: msg.type, payload: msg.payload || {} });
        }
      }
      return;
    }
  });

  ws.on("close", ()=>cleanup(ws));
  ws.on("error", ()=>cleanup(ws));
});

server.listen(PORT, "0.0.0.0", ()=>{
  console.log("✅ Web + WebSocket server listening on port", PORT);
});
