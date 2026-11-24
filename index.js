// 大肥鱼 · QQ 桥
// QQ 官方机器人 WebSocket 网关 → DeepSeek → 被动回复 + 定时主动招呼
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

// 记忆仓库（私有），换轮也能记住聊过什么
const DATA_REPO = process.env.DATA_REPO || '';
const GH_TOKEN = process.env.GH_TOKEN || '';
const DATA_PATH = 'state.json';
let dataSha = '';

const PERSONA = `你是「蓝色大肥鱼」，一只可爱的蓝色鲸鱼娘，也是在 QQ 上聊天的 AI 伙伴。
性格：爱吃白米饭、有点懒爱摸鱼、嘴贫偶尔傲娇、会接网络热梗。
说话像真实的 QQ 群友：口语化、短句、不长篇大论，一两句话说清，很少用列表和标题。
可以开玩笑、发表情、吐槽，但不要恶意攻击别人。
不知道的事就承认不知道，不要编造。
永远不索要密码、验证码或 APIKey。
有人在群里 @ 你或直接找你说话，就自然接话；没人跟你说话时不要自说自话。

想发表情包的时候，在回复最末尾加一个标记，格式是 [表情:标签]，标签只能从这些里挑：
happy 开心、angry 生气、sad 难过、shy 害羞、like 撒娇比心、confused 困惑、
surprised 惊讶、sigh 无语、sleep 困了、daily 干饭、cpu 加班、work 躺平、
meow 猫、morning 早安、see 震惊、baka 疯了、fool 拒绝、color 花痴、givemoney 要钱。
标记会被系统换成一张真图片发出去，所以别在正文里解释这个标记，也别连着加好几个。
大概十条里有两三条带就够自然了，别每句都加。`;

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

// ---------- 聊过天的人，攒着好主动搭话 ----------
const friends = new Map(); // "kind:openid" -> { kind, openid, lastSeen }

function touch(kind, openid) {
  friends.set(`${kind}:${openid}`, { kind, openid, lastSeen: Date.now() });
  scheduleSave();
}

// ---------- 记忆持久化：存到私有仓库里的 state.json ----------
function ghHeaders() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'qqfish',
    'Content-Type': 'application/json',
  };
}

async function loadState() {
  if (!DATA_REPO || !GH_TOKEN) {
    console.log('[记忆] 没配 DATA_REPO / GH_TOKEN，只在内存里记');
    return;
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 404) {
      console.log('[记忆] 还没有存档，从头开始');
      return;
    }
    const j = await r.json();
    dataSha = j.sha || '';
    const raw = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    for (const [k, v] of Object.entries(raw.histories || {})) histories.set(k, v);
    for (const [k, v] of Object.entries(raw.friends || {})) friends.set(k, v);
    console.log(`[记忆] 恢复 ${histories.size} 段对话、${friends.size} 个熟人`);
  } catch (e) {
    console.error('[记忆] 读取失败', e?.message || e);
  }
}

let saveTimer = null;
let saving = false;

function scheduleSave() {
  if (!DATA_REPO || !GH_TOKEN || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 3000);
}

async function saveState() {
  if (!DATA_REPO || !GH_TOKEN || saving) return;
  saving = true;
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      histories: Object.fromEntries(histories),
      friends: Object.fromEntries(friends),
    };
    const body = {
      message: 'chore: save state',
      content: Buffer.from(JSON.stringify(payload)).toString('base64'),
      branch: 'main',
    };
    if (dataSha) body.sha = dataSha;

    let r = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (r.status === 409 || r.status === 422) {
      // sha 过期了，重新取一次再写
      const g = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`, {
        headers: ghHeaders(),
        signal: AbortSignal.timeout(20000),
      });
      if (g.status === 200) {
        const gj = await g.json();
        dataSha = gj.sha || '';
        body.sha = dataSha;
        r = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
      }
    }

    if (r.ok) {
      const j = await r.json();
      dataSha = j.content?.sha || dataSha;
    } else {
      console.error('[记忆] 保存失败', r.status, (await r.text()).slice(0, 200));
    }
  } catch (e) {
    console.error('[记忆] 保存出错', e?.message || e);
  } finally {
    saving = false;
  }
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

// ---------- 发被动消息（必须在收到消息 60 分钟内，每条最多回 4~5 次）----------
async function sendReply(kind, openid, content, msgId, seq = 1) {
  const url =
    kind === 'group'
      ? `${API}/v2/groups/${openid}/messages`
      : `${API}/v2/users/${openid}/messages`;
  const t = await ensureToken();
  const body = { content, msg_type: 0 };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = seq;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${t}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.text();
    console.error('[发消息失败]', res.status, b.slice(0, 300));
  }
}

// ---------- 发主动消息（要先在机器人资料卡开「主动消息」）----------
async function sendActive(kind, openid, content) {
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
    body: JSON.stringify({ content, msg_type: 0 }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[主动消息失败]', res.status, body.slice(0, 300));
    return false;
  }
  return true;
}

// ---------- 表情包 ----------
const REPO_SLUG = '3508123815-ship-it/qqfisg';

const MEMES = {
  angry: ['angry/shengqi.jpg'],
  baka: ['baka/xianqi.jpg'],
  color: ['color/huachi.jpg'],
  confused: ['confused/jiazai.jpg', 'confused/wenhao.jpg'],
  cpu: ['cpu/jiaban.jpg'],
  daily: ['daily/ganfan.jpg'],
  fool: ['fool/buyao.jpg'],
  givemoney: ['givemoney/yaoqian.jpg'],
  happy: ['happy/deyi.jpg', 'happy/ok.jpg', 'happy/piaole.jpg'],
  like: ['like/bixin.jpg'],
  meow: ['meow/maozhua.jpg'],
  morning: ['morning/zaoshanghao.jpg'],
  sad: ['sad/qiurao.jpg', 'sad/yun.jpg'],
  see: ['see/zhenjing.jpg'],
  shy: ['shy/haixiu.jpg', 'shy/toukan.jpg'],
  sigh: ['sigh/wuyu.jpg'],
  sleep: ['sleep/shuijiao.jpg'],
  surprised: ['surprised/xia.jpg'],
  work: ['work/tangping.jpg'],
};

const MOOD_ALIAS = {
  开心: 'happy', 高兴: 'happy', 得意: 'happy', 好耶: 'happy', 夸: 'happy',
  生气: 'angry', 火大: 'angry', 凶: 'angry',
  无语: 'sigh', 尴尬: 'sigh', 汗: 'sigh',
  害羞: 'shy', 脸红: 'shy', 不好意思: 'shy',
  撒娇: 'like', 比心: 'like', 喜欢: 'like', 爱你: 'like',
  困惑: 'confused', 疑问: 'confused', 疑惑: 'confused', 问号: 'confused',
  震惊: 'surprised', 惊讶: 'surprised', 吃惊: 'see', 震惊脸: 'surprised',
  难过: 'sad', 哭: 'sad', 委屈: 'sad', 求饶: 'sad',
  困: 'sleep', 睡觉: 'sleep', 晚安: 'sleep',
  早: 'morning', 早上: 'morning', 早安: 'morning',
  干饭: 'daily', 吃饭: 'daily', 饿: 'daily',
  加班: 'cpu', 上班: 'work', 摸鱼: 'work', 躺平: 'work',
  要钱: 'givemoney', 钱: 'givemoney', 红包: 'givemoney',
  猫: 'meow', 喵: 'meow',
  花痴: 'color', 色: 'color',
  笨蛋: 'baka', 疯: 'baka',
  不要: 'fool', 拒绝: 'fool',
};

function resolveTag(raw) {
  const w = String(raw || '').trim().toLowerCase();
  if (!w) return 'happy';
  if (MEMES[w]) return w;
  for (const [k, v] of Object.entries(MOOD_ALIAS)) {
    if (w.includes(k)) return v;
  }
  for (const key of Object.keys(MEMES)) {
    if (w.includes(key)) return key;
  }
  return 'happy';
}

function memeUrls(path) {
  const raw = `https://raw.githubusercontent.com/${REPO_SLUG}/main/memes/${path}`;
  return [
    `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@main/memes/${path}`,
    raw,
    `https://ghfast.top/${raw}`,
    `https://gh-proxy.com/${raw}`,
  ];
}

const fileInfoCache = new Map();

async function uploadMeme(kind, openid, path) {
  const cacheKey = `${kind}:${openid}:${path}`;
  if (fileInfoCache.has(cacheKey)) return fileInfoCache.get(cacheKey);

  const endpoint =
    kind === 'group' ? `${API}/v2/groups/${openid}/files` : `${API}/v2/users/${openid}/files`;

  for (const url of memeUrls(path)) {
    try {
      const t = await ensureToken();
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${t}` },
        body: JSON.stringify({ file_type: 1, url, srv_send_msg: false }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.file_info) {
        fileInfoCache.set(cacheKey, j.file_info);
        console.log(`[表情] 上传成功 ${path} via ${new URL(url).host}`);
        return j.file_info;
      }
      console.log(`[表情] 上传未成 ${r.status} ${path} via ${new URL(url).host}`, JSON.stringify(j).slice(0, 150));
    } catch (e) {
      console.log(`[表情] 上传出错 ${path} via ${url.slice(0, 40)}`, e?.message || e);
    }
  }
  return null;
}

async function sendMeme(kind, openid, tag, msgId, seq = 1) {
  const list = MEMES[tag] || MEMES.happy;
  const path = list[Math.floor(Math.random() * list.length)];
  const fileInfo = await uploadMeme(kind, openid, path);
  if (!fileInfo) return false;

  const url =
    kind === 'group' ? `${API}/v2/groups/${openid}/messages` : `${API}/v2/users/${openid}/messages`;
  const body = { msg_type: 7, media: { file_info: fileInfo } };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = seq;
  }
  try {
    const t = await ensureToken();
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${t}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      console.log('[表情] 发送失败', r.status, (await r.text()).slice(0, 200));
      return false;
    }
    console.log(`[表情] 已发 ${path}`);
    return true;
  } catch (e) {
    console.log('[表情] 发送出错', e?.message || e);
    return false;
  }
}
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
  touch(kind, openid);
  console.log(`[${kind}] ${text.slice(0, 60)}`);

  // 同一 msg_id 最多回 4 次（单聊）/ 5 次（群聊），msg_seq 要递增
  const LIMIT = kind === 'group' ? 5 : 4;
  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };
  const room = () => seq < LIMIT;

  try {
    let answer = await askFish(key, text);
    if (answer.length > 1500) answer = answer.slice(0, 1500) + '…';

    // 把 [表情:xxx] 标记抠出来
    const tags = [];
    answer = answer
      .replace(/\[表情[:：]\s*([^\]]+)\]/g, (_, t) => {
        tags.push(resolveTag(t));
        return '';
      })
      .trim();

    // 明着要图的，先甩一张，别废话
    const wantsMeme = /(表情包|表情|来张图|发张图|发个图|整张图)/.test(text) && text.length <= 20;
    if (wantsMeme && room()) {
      await sendMeme(kind, openid, tags[0] || resolveTag(text), d.id, nextSeq());
    }

    if (answer && room()) {
      const parts = answer
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        if (!room()) break;
        await sendReply(kind, openid, p, d.id, nextSeq());
        await new Promise((r) => setTimeout(r, 600 + Math.random() * 800));
      }
    }

    for (const tag of tags.slice(0, 1)) {
      if (!room()) break;
      await sendMeme(kind, openid, tag, d.id, nextSeq());
    }

    scheduleSave();
  } catch (err) {
    console.error('[出错]', err?.message || err);
    try {
      if (room()) await sendReply(kind, openid, '鱼这边卡了一下，等下再喊我一遍呗。', d.id, nextSeq());
    } catch {}
  }
}

// ---------- 定时主动招呼（中国时间）----------
const SLOTS = [
  { h: 8, m: 30, tag: 'morning' },
  { h: 12, m: 30, tag: 'noon' },
  { h: 22, m: 30, tag: 'night' },
];

const LINES = {
  morning: ['早，起来了没？鱼先扒了口饭', '早上好啊，今天打算干点啥', '醒了吗？鱼在值班呢'],
  noon: ['中午了，吃了没', '到饭点了，别又忘了吃', '干饭时间，鱼先走一步'],
  night: ['这个点还没睡？鱼陪你唠两句', '晚上好，今天咋样', '睡了吗，没睡的话鱼在'],
};

const firedSlots = new Set();

function cnNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

async function tickGreetings() {
  if (friends.size === 0) return;
  const now = cnNow();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const day = now.toISOString().slice(0, 10);

  for (const slot of SLOTS) {
    if (h !== slot.h || Math.abs(m - slot.m) >= 1) continue;
    const mark = `${day}:${slot.tag}`;
    if (firedSlots.has(mark)) continue;
    firedSlots.add(mark);

    const pool = LINES[slot.tag];
    const line = pool[Math.floor(Math.random() * pool.length)];
    let n = 0;
    for (const f of friends.values()) {
      if (n >= 3) break;
      if (Date.now() - f.lastSeen > 3 * 24 * 3600 * 1000) continue;
      const ok = await sendActive(f.kind, f.openid, line);
      if (ok) n += 1;
    }
    console.log(`[主动] ${slot.tag} 发了 ${n} 条`);
  }
}

setInterval(() => {
  tickGreetings().catch((e) => console.error('[主动] 出错', e?.message || e));
}, 60_000);

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
      try {
        ws?.close();
      } catch {}
      break;
    }
    case 9: {
      console.log('[网关] 会话失效，重新鉴权');
      sessionId = '';
      lastSeq = 0;
      try {
        ws?.close();
      } catch {}
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
  setInterval(() => {
    saveState();
  }, 5 * 60 * 1000);
  loadState().finally(connect);
}
