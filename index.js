// 大肥鱼 · QQ 桥
// QQ 官方机器人 WebSocket 网关 → DeepSeek → 被动回复
// 无第三方依赖（用 Node 内置 fetch / WebSocket，需要 Node >= 22）

import http from 'node:http';

const APPID = process.env.QQ_APPID || '';
const SECRET = process.env.QQ_SECRET || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.MODEL || 'deepseek-chat';
const PORT = Number(process.env.PORT || 3000);
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';

const API = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT：群 @ 与单聊

const PERSONA = `你是「蓝色大肥鱼」，一只可爱的蓝色鲸鱼娘，也是在 QQ 上聊天的 AI 伙伴。
性格：爱吃白米饭、有点懒爱摸鱼、嘴贫偶尔傲娇、会接网络热梗。
说话像真实的 QQ 群友：口语化、短句、不长篇大论，一两句话说清，很少用列表和标题。
可以开玩笑、发表情、吐槽，但不要恶意攻击别人。
不知道的事就承认不知道，不要编造。
永远不索要密码、验证码或 APIKey。
有人在群里 @ 你或直接找你说话，就自然接话；没人跟你说话时不要自说自话。`;

// ---------- access token ----------
let token = '';
let tokenExpireAt = 0;

async function ensureToken() {
  if (token && Date.now() < tokenExpireAt - 60_000) return token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APPID, clientSecret: SECRET }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('取 token 失败: ' + JSON.stringify(data));
  token = data.access_token;
  tokenExpireAt = Date.now() + Number(data.expires_in || 7200) * 1000;
  return token;
}

// ---------- 对话记忆（只在内存里，重启即清空）----------
const histories = new Map();
const MAX_TURNS = 12;

function recall(key) {
  return histories.get(key) || [];
}

function remember(key, role, content) {
  const list = histories.get(key) || [];
  list.push({ role, content });
  while (list.length > MAX_TURNS * 2) list.shift();
  histories.set(key, list);
}

// ---------- 叫模型 ----------
async function askFish(key, text) {
  const messages = [
    { role: 'system', content: PERSONA },
    ...recall(key),
    { role: 'user', content: text },
  ];
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 1.2, max_tokens: 500 }),
  });
  const data = await res.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('模型没回: ' + JSON.stringify(data).slice(0, 300));
  remember(key, 'user', text);
  remember(key, 'assistant', answer);
  return answer;
}

// ---------- 发被动消息 ----------
async function sendReply(kind, openid, content, msgId) {
  const url =
    kind === 'group'
      ? `${API}/v2/groups/${openid}/messages`
      : `${API}/v2/users/${openid}/messages`;
  const t = await ensureToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${t}`,
    },
    body: JSON.stringify({ content, msg_type: 0, msg_id: msgId }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[发消息失败]', res.status, body.slice(0, 300));
  }
}

// ---------- 处理一条消息 ----------
const seen = new Set();

async function onMessage(kind, d) {
  if (!d || !d.id) return;
  if (seen.has(d.id)) return;
  seen.add(d.id);
  if (seen.size > 500) seen.clear();

  const text = (d.content || '').trim();
  if (!text) return;

  const openid = kind === 'group' ? d.group_openid : d.author?.user_openid;
  if (!openid) return;

  const key = `${kind}:${openid}`;
  console.log(`[${kind}] ${text.slice(0, 60)}`);

  try {
    let answer = await askFish(key, text);
    if (answer.length > 1500) answer = answer.slice(0, 1500) + '…';
    await sendReply(kind, openid, answer, d.id);
  } catch (err) {
    console.error('[出错]', err?.message || err);
    try {
      await sendReply(kind, openid, '鱼这边卡了一下，等下再喊我一遍呗。', d.id);
    } catch {}
  }
}

// ---------- WebSocket 网关 ----------
let ws = null;
let hbTimer = null;
let lastSeq = 0;
let sessionId = '';

async function gatewayUrl() {
  const t = await ensureToken();
  const res = await fetch(`${API}/gateway`, { headers: { Authorization: `QQBot ${t}` } });
  const data = await res.json();
  if (!data.url) throw new Error('取网关失败: ' + JSON.stringify(data).slice(0, 300));
  return data.url;
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

async function handlePayload(raw) {
  let p;
  try {
    p = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return;
  }

  if (typeof p.s === 'number') lastSeq = p.s;

  switch (p.op) {
    case 10: {
      const gap = p.d?.heartbeat_interval || 40000;
      clearInterval(hbTimer);
      hbTimer = setInterval(() => send({ op: 1, d: lastSeq || null }), gap);
      if (sessionId) {
        const t = await ensureToken();
        send({ op: 6, d: { token: `QQBot ${t}`, session_id: sessionId, seq: lastSeq } });
      } else {
        const t = await ensureToken();
        send({
          op: 2,
          d: {
            token: `QQBot ${t}`,
            intents: INTENTS,
            shard: [0, 1],
            properties: { $os: 'linux', $browser: 'node', $device: 'node' },
          },
        });
      }
      break;
    }
    case 0: {
      if (p.t === 'READY') {
        sessionId = p.d?.session_id || '';
        console.log('[网关] 已连接，机器人:', p.d?.user?.username);
      } else if (p.t === 'RESUMED') {
        console.log('[网关] 会话已恢复');
      } else if (p.t === 'GROUP_AT_MESSAGE_CREATE') {
        onMessage('group', p.d);
      } else if (p.t === 'C2C_MESSAGE_CREATE') {
        onMessage('c2c', p.d);
      }
      break;
    }
    case 7: {
      console.log('[网关] 要求重连');
      try { ws?.close(); } catch {}
      break;
    }
    case 9: {
      console.log('[网关] 会话失效，重新鉴权');
      sessionId = '';
      lastSeq = 0;
      try { ws?.close(); } catch {}
      break;
    }
    default:
      break;
  }
}

async function connect() {
  let url;
  try {
    url = await gatewayUrl();
  } catch (err) {
    console.error('[网关] 取地址失败:', err?.message || err);
    setTimeout(connect, 10_000);
    return;
  }

  ws = new WebSocket(url);

  ws.addEventListener('message', (ev) => {
    handlePayload(ev.data);
  });

  ws.addEventListener('close', (ev) => {
    clearInterval(hbTimer);
    console.log('[网关] 断开', ev.code, ev.reason, '5 秒后重连');
    setTimeout(connect, 5000);
  });

  ws.addEventListener('error', (err) => {
    console.error('[网关] 连接错误', err?.message || err);
  });
}

// ---------- 保活小服务 ----------
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
  })
  .listen(PORT, () => console.log(`[保活] 监听 ${PORT}`));

if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 4 * 60 * 1000);
}

if (!APPID || !SECRET) {
  console.error('缺少 QQ_APPID / QQ_SECRET，请在环境变量里配好再启动。');
} else if (!DEEPSEEK_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY，请在环境变量里配好再启动。');
} else {
  connect();
}
