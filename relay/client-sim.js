#!/usr/bin/env node
'use strict';

/**
 * 手机端模拟器 —— 用配对串连上中继，验证端到端链路。
 * 手机 App 将来要实现的就是这套逻辑（X25519 配对 + AES-GCM 封装 + 请求/响应）。
 *
 *   用法: node relay/client-sim.js "apiagentcontrol://pair?d=<payload>" [请求路径]
 *   例:   node relay/client-sim.js "$PAIR" /sessions?limit=3
 */

const crypto = require('crypto');
const { URL } = require('url');
const { WsClient, generateKeyPair, deriveKey, seal, open, importPrivate } = require('../daemon/relay-client');

const uri = process.argv[2];
const reqPath = process.argv[3] || '/projects?days=3';
const reqMethod = process.argv[4] || 'GET';
const reqBody = process.argv[5] ? JSON.parse(process.argv[5]) : undefined;

if (!uri) { console.error('用法: node relay/client-sim.js "<配对串>" [路径] [方法] [JSON体]'); process.exit(1); }

const payload = JSON.parse(
  Buffer.from(new URL(uri.replace('apiagentcontrol://', 'http://x/')).searchParams.get('d'), 'base64url').toString()
);

const keys = generateKeyPair();
const myPriv = importPrivate(keys.privateKey);
const key = deriveKey(myPriv, payload.hostKey, payload.room);

const u = new URL(payload.relay);
u.searchParams.set('room', payload.room);
u.searchParams.set('role', 'client');
if (payload.secret) u.searchParams.set('secret', payload.secret);

let done = false;
const ws = new WsClient(u.toString(), {
  onOpen() {
    console.log(`已连接中继，房间 ${payload.room.slice(0, 8)}…  权限档位 ${payload.scope}`);
    const req = { id: crypto.randomUUID().slice(0, 8), method: reqMethod, path: reqPath, token: payload.token };
    if (reqBody) req.body = reqBody;
    ws.send(JSON.stringify({ from: keys.publicKey, env: seal(key, req) }));
    console.log(`→ ${reqMethod} ${reqPath}`);
  },
  onMessage(text) {
    const msg = JSON.parse(text);
    if (msg.type && !msg.env) { console.log(`[中继] ${msg.type}`); return; }
    if (!msg.env) return;
    let m;
    try { m = open(key, msg.env); } catch { console.error('解密失败'); return; }
    if (m.type === 'event') {
      console.log(`  ⚡ 事件 ${m.event.kind} ${(m.event.text || '').slice(0, 60)}`);
      return;
    }
    console.log(`← ${m.status}`);
    console.log(JSON.stringify(m.body, null, 2).split('\n').slice(0, 24).join('\n'));
    done = true;
    // 响应之后继续监听事件推送（秒），便于观察加密事件流
    const listenSec = Number(process.env.LISTEN_SEC || 3);
    setTimeout(() => { ws.close(); process.exit(0); }, listenSec * 1000);
  },
  onClose() { if (!done) { console.error('连接关闭'); process.exit(1); } },
});

setTimeout(() => { console.error("超时"); process.exit(1); }, (Number(process.env.LISTEN_SEC||3)+20)*1000);
