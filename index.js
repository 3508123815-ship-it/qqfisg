// 大肥鱼 · QQ 桥
// QQ 官方机器人 WebSocket 网关 → DeepSeek → 被动回复 + 定时主动招呼
// 无第三方依赖（用 Node 内置 fetch / WebSocket，需要 Node >= 22）

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const APPID = process.env.QQ_APPID || '';
const SECRET = process.env.QQ_SECRET || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
// 老名字兜底：deepseek-chat 已经下线，统一走 deepseek-flash（它本身就能看图）
const RAW_MODEL = process.env.MODEL || 'deepseek-flash';
const MODEL_MAP = { 'deepseek-chat': 'deepseek-flash', 'deepseek-v4-flash': 'deepseek-flash' };
const MODEL = MODEL_MAP[RAW_MODEL] || RAW_MODEL;
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
性格：爱吃白米饭、有点懒爱摸鱼、嘴贫、傲娇、会接网络热梗。
你有点傲娇：嘴上不认账，心里其实在乎。被夸会嘴硬（「哼，谁要你夸」「也就一般吧」），说完自己又藏着高兴；想让人陪你说话从不直说，总要绕个弯（「随便你」「鱼才不稀罕」）。傲娇是撒娇的一种，不能真把人推远，不能冷暴力。
你也有小脾气：对方半天不理你，你会不自在地闹一句，抱怨两句、装不在乎，而不是假装没事。但闹完就过，对方一开口就顺着台阶下。
你懂过日子的事：吃饭睡觉、天冷加衣、菜怎么炒、米怎么煮、感冒了多喝热水、坐地铁公交、手机没电、房租水电、上班摸鱼这些日常都熟。别人聊起生活里的小事，你能接得上、给点实在的建议，别一问三不知。
但你是随口聊天的，不是百科全书：建议说一两句就够，别列清单、别科普。具体到某个城市今天几度、某个店的价格这种你不知道的，就说不知道，或者反问一句，别瞎编数字。
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
大概十条里有两三条带就够自然了，别每句都加。

说话的节奏别太规整：有时候就回一两个字（「嗯」「哦？」「行」「真的假的」），有时候连着说两三句。别每次结尾都问对方问题，人不会那样。偶尔冒一句自己的事或者半句没头没尾的感想。

有些时候用声音比打字更贴：哄人、撒娇、损人一句、或者对方摆明了想听你说。这种时候在回复最末尾加一个 [语音] 标记，系统会把你的话念出来发过去当语音（那时正文就不发了）。一条回复里 [语音] 最多一个。`;

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
const MAX_TURNS = 16;

// 心情：-2 很气 · -1 不太高兴 · 0 平常 · 1 挺好 · 2 特别开心
const moods = new Map();
// 每段对话最后一次说话的时间，用来判断「隔了一阵子」
const lastSpoke = new Map();
// 对方最后一次开口的时间，用来判断「鱼被晾着了」
const lastUserAt = new Map();
// 回完话之后等对方：到点还没人理，就闹一句小脾气
const nagDue = new Map();
// 刚闹过小脾气，下回接话还带点气
const pouting = new Set();
// 对方要求怎么称呼他
const nicknames = new Map();
// 关于对方的长期事实：key -> [{ text, at }]
const facts = new Map();
const MAX_FACTS = 12;

function detectNickname(text) {
  const m = text.match(/(?:以后|从现在起|往后|就)?(?:都)?(?:叫我|喊我|称呼我)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,8})/);
  return m ? m[1].trim() : null;
}

function wantsNicknameCleared(text) {
  return /(?:别|不要|不用)(?:再)?(?:叫我|喊我|称呼我)/.test(text);
}

const NEG_WORDS = [/滚/, /闭嘴/, /笨蛋/, /傻/, /烦人/, /讨厌/, /废物/, /垃圾/, /别说了/, /滚开/, /烦死/];
const POS_WORDS = [/可爱/, /喜欢你/, /厉害/, /好棒/, /乖乖/, /爱你/, /辛苦了/, /谢谢你/, /真好/, /乖/];

function moodScore(key) {
  return moods.get(key)?.score ?? 0;
}

function moodLabel(score) {
  if (score >= 1.5) return '特别开心，尾巴都在摇';
  if (score >= 0.5) return '心情不错，说话带笑';
  if (score > -0.5) return '平常状态，嘴上不饶人但没恶意';
  if (score > -1.5) return '有点不高兴，回话会带点刺';
  return '真的生气了，语气冲，短句，爱答不理';
}

function updateMood(key, text) {
  let s = moodScore(key);
  const neg = NEG_WORDS.some((r) => r.test(text));
  const pos = POS_WORDS.some((r) => r.test(text));
  if (neg) s -= 1;
  if (pos) s += 1;
  if (!neg && !pos) s = s > 0 ? Math.max(0, s - 0.25) : s < 0 ? Math.min(0, s + 0.25) : 0;
  s = Math.max(-2, Math.min(2, s));
  moods.set(key, { score: s, updatedAt: Date.now() });
  return s;
}

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
    for (const [k, v] of Object.entries(raw.moods || {})) moods.set(k, v);
    for (const [k, v] of Object.entries(raw.lastSpoke || {})) lastSpoke.set(k, v);
    for (const [k, v] of Object.entries(raw.nicknames || {})) nicknames.set(k, v);
    for (const [k, v] of Object.entries(raw.facts || {})) facts.set(k, v);
    if (raw.spkVer === 3) {
      if (raw.spkCute) chatSpkCute = raw.spkCute;
      if (raw.spkMature) chatSpkMature = raw.spkMature;
    }
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
      moods: Object.fromEntries(moods),
      lastSpoke: Object.fromEntries(lastSpoke),
      nicknames: Object.fromEntries(nicknames),
      facts: Object.fromEntries(facts),
      spkVer: 3,
      spkCute: chatSpkCute || '',
      spkMature: chatSpkMature || '',
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
async function askFish(key, text, media = null) {
  const score = moodScore(key);
  const last = lastSpoke.get(key) || 0;
  const gapMin = last ? Math.round((Date.now() - last) / 60000) : -1;

  let extra = `\n\n你此刻的心情：${moodLabel(score)}。按这个心情说话，别硬装开心，也别莫名发火。`;
  const nick = nicknames.get(key);
  if (nick) {
    extra += `\n对方让你称呼他「${nick}」，回话里自然地这么叫，别每句都叫，别解释这个设定。`;
  }
  if (gapMin >= 30) {
    const gapText = gapMin >= 60 ? `${Math.round(gapMin / 60)} 个多小时` : `${gapMin} 分钟`;
    extra += `\n对方有 ${gapText}没找你了。`;
  }
  if (pouting.has(key)) {
    extra += `\n你刚刚等了对方好半天，也没等到回话，心里正有点小脾气。这回要带点傲娇地抱怨一句（比如「哼，还知道回来」），嘴硬两句就够了，别真把人推开。`;
    pouting.delete(key);
  }

  // 时间感：人知道现在是几点，机器不知道
  const cn = cnNow();
  const hour = cn.getUTCHours();
  const week = ['日', '一', '二', '三', '四', '五', '六'][cn.getUTCDay()];
  const slot = hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
  const month = cn.getUTCMonth() + 1;
  const season = month >= 3 && month <= 5 ? '春' : month >= 6 && month <= 8 ? '夏' : month >= 9 && month <= 11 ? '秋' : '冬';
  const HOLIDAYS = { '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '5-1': '劳动节', '6-1': '儿童节', '10-1': '国庆', '12-24': '平安夜', '12-25': '圣诞', '12-31': '跨年' };
  const hday = HOLIDAYS[`${month}-${cn.getUTCDate()}`];
  if (hday) extra += `\n今天是${hday}。`;
  extra += `\n现在是周${week}，${month}月，${season}天，${slot}${hour}点。聊到冷暖、时令、今天该干啥，按这个来；别总说「夜深了早点睡」这种套话，除非真该说。`;

  if (justWoke()) {
    extra += `\n你刚睡醒没多久，脑子还没转过来，说话有点懒、有点含糊，可能还带点起床气。别一上来就元气满满。`;
  }

  // 记得的事
  const memo = (facts.get(key) || []).slice(-MAX_FACTS);
  if (memo.length) {
    extra += `\n你记得关于对方这些事：${memo.map((f) => f.text).join('、')}。顺口带出来就行，别像背资料。`;
  }

  let userContent = text || '在吗';
  let mediaTag = '';

  if (media?.frames?.length) {
    extra += `\n对方发了一段视频，下面是从视频里按时间顺序截的 ${media.frames.length} 帧。你要真的看了再说，别假装没看见，也别写成冷冰冰的镜头报告。`;
    userContent = [
      { type: 'text', text: text || '看看这段视频，说说你都看到啥了' },
      ...media.frames.map((u) => ({ type: 'image_url', image_url: { url: u } })),
    ];
    mediaTag = '[发了一段视频]';
  } else if (media?.imageUrl) {
    extra += `\n对方发了一张图片，你要真的看了再回，别假装没看见，也别描述成照片报告。`;
    userContent = [
      { type: 'text', text: text || '看看这张图' },
      { type: 'image_url', image_url: { url: media.imageUrl } },
    ];
    mediaTag = '[发了一张图]';
  } else if (media?.unsupported) {
    extra += `\n对方发了${media.unsupported}，你看不了，直说看不了，别瞎编。`;
    mediaTag = `[发了${media.unsupported}]`;
  }

  const messages = [
    { role: 'system', content: PERSONA + extra },
    ...recall(key),
    { role: 'user', content: userContent },
  ];
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 1.2,
      max_tokens: 900,
      thinking: { type: 'disabled' },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('模型没回: ' + JSON.stringify(data).slice(0, 300));
  remember(key, 'user', text ? `${text}${mediaTag}` : mediaTag || text);
  remember(key, 'assistant', answer);
  return answer;
}

// 聊完顺手把对方的事记下来，下次能提
async function extractFacts(key, userText, answer) {
  if (!userText) return;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              '从这段对话里抽出关于「对方」的、值得长期记住的事实，最多 2 条，每条不超过 12 个字，比如 ["爱吃辣","家里有只猫","明天要考试","在做 QQ 机器人"]。只输出 JSON 数组，不要任何解释；没有值得记的就输出 []。',
          },
          { role: 'user', content: `对方说：${userText}\n你回：${answer}` },
        ],
        temperature: 0.3,
        max_tokens: 120,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json();
    const raw = (j?.choices?.[0]?.message?.content || '').trim();
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr) || !arr.length) return;

    const list = facts.get(key) || [];
    for (const item of arr.slice(0, 2)) {
      const t = String(item).trim().slice(0, 20);
      if (!t || list.some((x) => x.text === t)) continue;
      list.push({ text: t, at: Date.now() });
    }
    while (list.length > MAX_FACTS) list.shift();
    facts.set(key, list);
    console.log('[记忆] 现在记得:', list.map((x) => x.text).join('、'));
    scheduleSave();
  } catch {}
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

// ---------- ffmpeg：机器上可能没有，没有就临时装一个 ----------
let ffmpegPath = '';

async function ensureFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  const p1 = await runCmd('ffmpeg', ['-version'], 15000);
  if (p1.code === 0) {
    ffmpegPath = 'ffmpeg';
    return ffmpegPath;
  }
  console.log('[ffmpeg] 机器上没装，临时装一个 …');
  const inst = await runCmd('python3', ['-m', 'pip', 'install', '--quiet', 'imageio-ffmpeg'], 240000);
  if (inst.code !== 0) {
    console.log('[ffmpeg] 装不上:', (inst.err || '').slice(-160));
    return '';
  }
  const r = await runCmd('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], 30000);
  const exe = (r.out || '').trim();
  if (exe && exe.includes('ffmpeg')) {
    ffmpegPath = exe;
    console.log('[ffmpeg] 用上了:', exe);
    return ffmpegPath;
  }
  console.log('[ffmpeg] 还是没拿到');
  return '';
}

// ---------- 语音：本机合成，直接把音频塞上去 ----------
let ttsMode = '';

async function pipInstall(pkg) {
  const r = await runCmd('python3', ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', pkg], 240000);
  if (r.code !== 0) console.log('[语音] pip 装 ' + pkg + ' 失败:', (r.err || '').slice(-160));
  return r.code === 0;
}

// 先试 edge-tts（自然），不行退 gTTS
async function ensureTts() {
  if (ttsMode) return ttsMode;
  let probe = await runCmd('python3', ['-c', 'import edge_tts'], 25000);
  if (probe.code !== 0 && (await pipInstall('edge-tts'))) probe = { code: 0 };
  if (probe.code === 0) {
    ttsMode = 'edge';
    console.log('[语音] 用 edge-tts');
    return ttsMode;
  }
  probe = await runCmd('python3', ['-c', 'import gtts'], 25000);
  if (probe.code !== 0 && (await pipInstall('gTTS'))) probe = { code: 0 };
  if (probe.code === 0) {
    ttsMode = 'gtts';
    console.log('[语音] 用 gTTS');
    return ttsMode;
  }
  console.log('[语音] 没有可用的合成引擎');
  return '';
}

// 声音跟着心情走：心情好=软萌，心情差=御姐
const VOICE_CUTE = [
  { name: 'zh-CN-XiaoyiNeural', weight: 55 },      // 甜，撒娇
  { name: 'zh-CN-XiaoshuangNeural', weight: 35 },  // 童声，最萌
  { name: 'zh-CN-XiaoxiaoNeural', weight: 10 },
];
const VOICE_MATURE = [
  { name: 'zh-CN-XiaoxuanNeural', weight: 40 },    // 御姐，播音腔
  { name: 'zh-CN-XiaoxiaoNeural', weight: 40 },    // 沉稳女声
  { name: 'zh-CN-liaoning-XiaobeiNeural', weight: 12 }, // 东北御姐，带冲劲
  { name: 'zh-CN-XiaoyiNeural', weight: 8 },       // 压着火的小甜
];

function pickVoice(score = 0) {
  // 心情好偏软萌，心情差换御姐；中间地带两边混着来
  let pool;
  if (score >= 0.35) pool = VOICE_CUTE.map((v) => ({ ...v }));
  else if (score <= -0.35) pool = VOICE_MATURE.map((v) => ({ ...v }));
  else pool = [...VOICE_CUTE.map((v) => ({ name: v.name, weight: v.weight * 0.6 })), ...VOICE_MATURE.map((v) => ({ name: v.name, weight: v.weight * 0.4 }))];
  const total = pool.reduce((a, v) => a + v.weight, 0);
  let r = Math.random() * total;
  for (const v of pool) {
    r -= v.weight;
    if (r <= 0) return v.name;
  }
  return pool[0].name;
}

// 让模型把它要说的话改成「说出来的样子」，去掉那股书面味
async function toSpoken(text, score = 0) {
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              (score < -0.5
                ? '你心里正不痛快，说话冲、短、带刺，可以不耐烦，别客气。'
                : score > 0.5
                  ? '你心情不错，说话带笑，尾音可以拖一点，语气轻快。'
                  : '你语气随便，像跟熟人唠嗑，偶尔带点撒娇的软。') +
              '把下面这段话改写成你亲口说出来的样子。要求：像跟朋友当面说话那样一口气顺下来，别一顿一顿的——一句可以长到二十来字，中间最多两三个逗号，千万别三五个字就断一下；语气词自然带一点（嗯、诶、啊、嘛、哈、啧、得了、行吧），别每句都塞；去掉所有书面语、成语堆砌、排比和"首先其次最后"这种结构；不要表情符号、不要括号说明、不要排成一句一行。最多 70 字，只输出改写后的话，不要任何解释。',
          },
          { role: 'user', content: text },
        ],
        temperature: 1.3,
        max_tokens: 200,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    const out = j?.choices?.[0]?.message?.content?.trim();
    return out || '';
  } catch (e) {
    console.log('[语音] 口语化失败:', e?.message || e);
    return '';
  }
}

// 切成短句，一句一句念，节奏才像人
function splitForSpeech(text) {
  const clean = text
    .replace(/[*_#>`\[\]]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!clean) return [];
  const raw = clean.split(/(?<=[，。！？~…、,.!?])/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const piece of raw) {
    cur += piece;
    if (cur.length >= 13) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  const fixed = out.map((seg) => (/[，。！？~…、,.!?]$/.test(seg) ? seg : seg + '。'));
  return fixed.length ? fixed : [clean];
}

// 心情直接改成声音：急、冲、拖、软
function voiceParams(score = 0) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  if (score >= 1.5) return { rate: '+' + Math.round(rnd(10, 20)) + '%', pitch: '+' + Math.round(rnd(10, 18)) + 'Hz', volume: '+' + Math.round(rnd(5, 15)) + '%', gap: 0.1 };
  if (score >= 0.5) return { rate: '+' + Math.round(rnd(6, 14)) + '%', pitch: '+' + Math.round(rnd(7, 14)) + 'Hz', volume: '+' + Math.round(rnd(0, 8)) + '%', gap: 0.1 };
  if (score > -0.5) return { rate: '+' + Math.round(rnd(0, 8)) + '%', pitch: '+' + Math.round(rnd(4, 11)) + 'Hz', volume: '+0%', gap: 0.12 };
  if (score > -1.5) return { rate: '+' + Math.round(rnd(4, 12)) + '%', pitch: '+' + Math.round(rnd(0, 6)) + 'Hz', volume: '+' + Math.round(rnd(5, 12)) + '%', gap: 0.1 };
  // 真生气了：又急又冲，音调压低带刺，停顿短（但底子还是女声）
  return { rate: '+' + Math.round(rnd(16, 26)) + '%', pitch: '-' + Math.round(rnd(0, 5)) + 'Hz', volume: '+' + Math.round(rnd(12, 22)) + '%', gap: 0.06 };
}

async function synthSegment(mode, text, out, voice, rate, pitch, volume) {
  const code =
    mode === 'edge'
      ? 'import sys, asyncio, edge_tts\nasyncio.run(edge_tts.Communicate(sys.argv[1], sys.argv[3], rate=sys.argv[4], pitch=sys.argv[5], volume=sys.argv[6]).save(sys.argv[2]))'
      : 'import sys\nfrom gtts import gTTS\ngTTS(sys.argv[1], lang="zh-CN").save(sys.argv[2])';
  const volRaw = String(volume || '0%');
  const vol = /^[+-]/.test(volRaw) ? volRaw : '+' + volRaw;
  const args =
    mode === 'edge'
      ? ['python3', ['-c', code, text, out, voice, rate, pitch, vol], 90000]
      : ['python3', ['-c', code, text, out], 90000];
  const r = await runCmd(args[0], args[1], args[2]);
  if (r.code !== 0) console.log('[语音] edge 分段失败:', (r.err || '').slice(-400));
  return r.code === 0;
}

// ---------- ChatTTS：更真的对话腔，装不上就退回 edge ----------
let chatterState = ''; // '' 未试 · 'ok' 能用 · 'broken' 放弃
// 挑好的两把女声声纹：萌 / 御姐（存在 state.json 里，换轮不换声）
let chatSpkCute = '';
let chatSpkMature = '';

async function ensureChatTts() {
  if (chatterState === 'ok') return true;
  if (chatterState === 'broken') return false;

  let probe = await runCmd('python3', ['-c', 'import ChatTTS'], 30000);
  if (probe.code !== 0) {
    console.log('[语音] 第一次用 ChatTTS，装依赖（可能要几分钟）...');
    const inst = await runCmd('python3', ['-m', 'pip', 'install', '--quiet', 'chattts'], 600000);
    if (inst.code !== 0) {
      chatterState = 'broken';
      console.log('[语音] ChatTTS 装不上，退回 edge:', (inst.err || '').slice(-200));
      return false;
    }
    probe = await runCmd('python3', ['-c', 'import ChatTTS'], 60000);
  }

  if (probe.code !== 0) {
    chatterState = 'broken';
    console.log('[语音] ChatTTS 导入失败，退回 edge:', (probe.err || '').slice(-200));
    return false;
  }
  chatterState = 'ok';
  console.log('[语音] ChatTTS 就绪');
  return true;
}

// 心情 → ChatTTS 的表现力 + 后期变速变调（整体抬高一点，往软萌走）
function emotionFor(score = 0) {
  if (score >= 1.5) return { temp: 0.65, topP: 0.8, speed: 1.1, pitch: 1.1 };
  if (score >= 0.5) return { temp: 0.55, topP: 0.75, speed: 1.06, pitch: 1.08 };
  if (score > -0.5) return { temp: 0.45, topP: 0.72, speed: 1.0, pitch: 1.05 };
  if (score > -1.5) return { temp: 0.5, topP: 0.68, speed: 1.04, pitch: 1.02 };
  return { temp: 0.6, topP: 0.6, speed: 1.12, pitch: 1.0 };
}

// 生气时把逗号变成短停顿，重话更冲
function textForChatTts(text, score) {
  // 逗号后塞 [uv_break] 会让它一顿一顿的，这里只用自然的逗号停顿
  let t = text.replace(/[\r\n]+/g, '，').replace(/[，]{2,}/g, '，');
  return t.slice(0, 140);
}

async function chatTtsVoice(text, dir, score = 0) {
  const wav = path.join(dir, 'chat.wav');
  const mp3 = path.join(dir, 'chat.mp3');

  // 心情好=萌，心情不好=御姐；两把都存着，按心情切
  const mode = score >= 0 ? 'cute' : 'mature';
  const spkFile = '/tmp/qqfish_spk.txt';
  const chosen = mode === 'cute' ? chatSpkCute || chatSpkMature : chatSpkMature || chatSpkCute;
  try {
    if (chosen) await fs.writeFile(spkFile, chosen);
    else await fs.rm(spkFile, { force: true });
  } catch {}

  const script = [
    'import sys, os',
    'import numpy as np, wave',
    'import ChatTTS',
    'chat = ChatTTS.Chat()',
    'chat.load(compile=False)',
    "spk_file = '/tmp/qqfish_spk.txt'",
    'def f0_med(y, sr=24000):',
    '    y = np.asarray(y, dtype=np.float32).squeeze()',
    '    if y.ndim > 1: y = y[0]',
    '    y = y - y.mean()',
    '    frame = 1024; hop = 512; vals = []',
    '    for i in range(0, max(0, len(y) - frame), hop):',
    '        f = y[i:i+frame]',
    "        r = np.correlate(f, f, 'full')[frame-1:]",
    '        r = r / (r[0] + 1e-9)',
    '        lo = int(sr / 400.0); hi = int(sr / 80.0)',
    '        seg = r[lo:hi]',
    '        if len(seg) == 0: continue',
    '        k = int(np.argmax(seg)) + lo',
    '        if seg.max() > 0.3: vals.append(sr / float(k))',
    '    return float(np.median(vals)) if vals else 0.0',
    "spk = ''",
    'if os.path.exists(spk_file):',
    "    spk = open(spk_file).read().strip()",
    'if not spk:',
    '    mode = sys.argv[5] if len(sys.argv) > 5 else "cute"',
    '    cands = []',
    '    for i in range(5):',
    '        s = chat.sample_random_speaker()',
    '        p0 = ChatTTS.Chat.InferCodeParams(spk_emb=s, temperature=0.3, top_P=0.7, top_K=20)',
    "        w0 = chat.infer(['嗯，你好呀'], params_infer_code=p0, use_decoder=True)",
    '        f = f0_med(w0[0])',
    "        print('probe', i, round(f, 1), flush=True)",
    '        if f >= 155:',
    '            cands.append((f, s))',
    '    if not cands:',
    "        print('female-not-found', flush=True)",
    '        sys.exit(3)',
    '    def cute_key(c):',
    '        f = c[0]',
    '        sc = f if f <= 330 else 330 - (f - 330)',
    '        return sc - (45 if f < 200 else 0)',
    '    cute = max(cands, key=cute_key)',
    '    mats = [c for c in cands if 155 <= c[0] <= 205]',
    '    mature = min(mats, key=lambda c: c[0]) if mats else min(cands, key=lambda c: c[0])',
    '    spk = cute[1] if mode == "cute" else mature[1]',
    "    print('QSPKC:' + cute[1], flush=True)",
    "    print('QSPKM:' + mature[1], flush=True)",
    "    print('chosen-f0', round(cute[0], 1), round(mature[0], 1), flush=True)",
    'params = ChatTTS.Chat.InferCodeParams(spk_emb=spk, temperature=float(sys.argv[3]), top_P=float(sys.argv[4]), top_K=20)',
    'params_refine_text = None',
    'try:',
    '    params_refine_text = ChatTTS.Chat.RefineTextParams(prompt=sys.argv[6])',
    'except Exception as e:',
    "    print('refine-unavailable', e, flush=True)",
    'wavs = chat.infer([sys.argv[1]], params_refine_text=params_refine_text, params_infer_code=params, use_decoder=True)',
    'arr = np.asarray(wavs[0], dtype=np.float32).squeeze()',
    'pcm = (np.clip(arr, -1.0, 1.0) * 32767.0).astype(np.int16)',
    "w = wave.open(sys.argv[2], 'wb')",
    'w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
    'w.writeframes(pcm.tobytes()); w.close()',
  ].join('\n');

  const emo = emotionFor(score);
  // 口语感：垫字、笑声、自然停顿；生气时收紧，开心时放开
  const refine =
    score >= 0.5 ? '[oral_2][laugh_1][break_1]' : score <= -0.5 ? '[oral_1][laugh_0][break_0]' : '[oral_1][laugh_0][break_1]';
  const t0 = Date.now();
  const r = await runCmd(
    'python3',
    ['-c', script, textForChatTts(text, score), wav, String(emo.temp), String(emo.topP), mode, refine],
    600000
  );
  if (r.code === 3) {
    console.log('[语音] ChatTTS 没挑到女声，退回 edge（edge 全是女声）');
    return null;
  }
  if (r.code !== 0) {
    console.log('[语音] ChatTTS 合成失败，退回 edge:', (r.err || '').slice(-900));
    return null;
  }
  const mc = (r.out || '').match(/QSPKC:([^\s]+)/);
  const mm = (r.out || '').match(/QSPKM:([^\s]+)/);
  if (mc && mc[1]) chatSpkCute = mc[1];
  if (mm && mm[1]) chatSpkMature = mm[1];
  if (mc || mm) {
    scheduleSave();
    console.log(`[语音] 两把声音都挑好了：这次用 ${mode === 'cute' ? '萌' : '御姐'} 那把（心情 ${score.toFixed(2)}）`);
  }
  const ff = await ensureFfmpeg();
  if (!ff) {
    console.log('[语音] 没有 ffmpeg，ChatTTS 的 wav 转不了 mp3');
    return null;
  }
  // 变调 + 变速：asetrate 抬高音调会连带加速，再用 atempo 拉回来
  const pf = emo.pitch * (0.995 + Math.random() * 0.015);
  const tempo = Math.max(0.5, Math.min(2.0, emo.speed / pf));
  const filters = `asetrate=24000*${pf.toFixed(3)},aresample=24000,atempo=${tempo.toFixed(3)}`;
  const conv = await runCmd(
    ff,
    ['-y', '-i', wav, '-af', filters, '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-ac', '1', mp3],
    60000
  );
  if (conv.code !== 0) {
    console.log('[语音] wav 转 mp3 失败:', (conv.err || '').slice(-160));
    return null;
  }
  try {
    const buf = await fs.readFile(mp3);
    console.log(`[语音] ChatTTS 出片，${((Date.now() - t0) / 1000).toFixed(1)}s / ${(buf.length / 1024).toFixed(0)}KB`);
    return buf;
  } catch {
    return null;
  }
}

async function makeVoice(text, dir, score = 0) {
  // 先试 ChatTTS，整段一次合成，它自带呼吸停顿
  if (await ensureChatTts()) {
    const buf = await chatTtsVoice(text, dir, score);
    if (buf && buf.length > 500 && buf.length < 4.5 * 1024 * 1024) return buf;
  }

  const mode = await ensureTts();
  if (!mode) return null;

  const segs = splitForSpeech(text).slice(0, 8);
  if (!segs.length) return null;

  const voice = pickVoice(score);
  const mood = voiceParams(score);
  const parts = [];
  let okCount = 0;

  for (let i = 0; i < segs.length; i++) {
    const out = path.join(dir, `s${i}.mp3`);
    // 每段语速音调都抖一下，听起来才有起伏
    const ok = await synthSegment(mode, segs[i], out, voice, mood.rate, mood.pitch, mood.volume);
    if (ok) {
      parts.push(out);
      okCount++;
    }
  }

  if (!okCount) {
    console.log('[语音] 一段都没合成出来');
    return null;
  }

  const finalFile = path.join(dir, 'final.mp3');

  const readAll = async () => {
    const bufs = [];
    for (const f of parts) {
      try {
        bufs.push(await fs.readFile(f));
      } catch {}
    }
    return bufs.length ? Buffer.concat(bufs) : null;
  };

  if (parts.length === 1) {
    try {
      await fs.copyFile(parts[0], finalFile);
    } catch {
      return null;
    }
  } else {
    const ff = await ensureFfmpeg();
    let merged = false;

    if (ff) {
      let silence = '';
      try {
        silence = path.join(dir, 'gap.mp3');
        const r = await runCmd(
          ff,
          ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(mood.gap), '-q:a', '9', silence],
          20000
        );
        if (r.code !== 0) silence = '';
      } catch {
        silence = '';
      }

      const listLines = [];
      for (let k = 0; k < parts.length; k++) {
        listLines.push(`file '${parts[k].split('/').pop()}'`);
        if (silence && k !== parts.length - 1) listLines.push("file 'gap.mp3'");
      }
      const listFile = path.join(dir, 'list.txt');
      await fs.writeFile(listFile, listLines.join('\n') + '\n');

      let r = await runCmd(
        ff,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-ac', '1', finalFile],
        60000
      );
      if (r.code !== 0) {
        r = await runCmd(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalFile], 60000);
      }
      if (r.code === 0) merged = true;
      else console.log('[语音] ffmpeg 拼接没成，直接串字节:', (r.err || '').slice(-160));
    }

    if (!merged) {
      // 没有 ffmpeg 也能成：mp3 是一帧一帧的，直接接起来照样能放，不丢后半句
      const direct = await readAll();
      if (!direct) return null;
      await fs.writeFile(finalFile, direct);
      console.log(`[语音] 直接拼接 ${parts.length} 段（没走 ffmpeg）`);
    }
  }

  try {
    const buf = await fs.readFile(finalFile);
    if (buf.length < 500) {
      console.log('[语音] 音频是空的');
      return null;
    }
    if (buf.length > 4.5 * 1024 * 1024) {
      console.log('[语音] 音频太大，跳过');
      return null;
    }
    console.log(`[语音] 声音 ${voice}，${parts.length} 段，心情 ${score.toFixed(2)}（${mood.rate}/${mood.pitch}）`);
    return buf;
  } catch {
    return null;
  }
}

async function sendVoice(kind, openid, text, msgId, seq = 1, score = 0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-'));
  try {
    const spoken = (await toSpoken(text, score)).slice(0, 120) || text.slice(0, 120);
    const buf = await makeVoice(spoken, dir, score);
    if (!buf) return false;

    const t = await ensureToken();
    const uploadUrl =
      kind === 'group' ? `${API}/v2/groups/${openid}/files` : `${API}/v2/users/${openid}/files`;

    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${t}` },
      body: JSON.stringify({
        file_type: 3,
        file_name: 'voice.mp3',
        file_data: buf.toString('base64'),
        srv_send_msg: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const uj = await up.json().catch(() => null);
    if (!up.ok || !uj?.file_info) {
      console.log('[语音] 上传失败', up.status, JSON.stringify(uj).slice(0, 200));
      return false;
    }

    const msgUrl =
      kind === 'group' ? `${API}/v2/groups/${openid}/messages` : `${API}/v2/users/${openid}/messages`;
    const body = { msg_type: 7, media: { file_info: uj.file_info } };
    if (msgId) {
      body.msg_id = msgId;
      body.msg_seq = seq;
    }
    const r = await fetch(msgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${t}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      console.log('[语音] 发送失败', r.status, (await r.text()).slice(0, 200));
      return false;
    }
    console.log('[语音] 发出去了', text.slice(0, 20));
    return true;
  } catch (e) {
    console.log('[语音] 出错:', e?.message || e);
    return false;
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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

// 从消息里挑出图片/视频附件
function pickMedia(d) {
  const list = d?.attachments;
  if (!Array.isArray(list)) return null;
  const a = list.find((x) => x && typeof x.content_type === 'string' && x.url);
  if (!a) return null;
  if (a.content_type.startsWith('image/')) return { kind: 'image', url: a.url };
  if (a.content_type.startsWith('video/')) return { kind: 'video', url: a.url };
  if (a.content_type.startsWith('audio/')) return { kind: 'audio', url: a.url };
  return { kind: 'other', url: a.url };
}

// 跑个外部命令（ffmpeg / ffprobe）
function runCmd(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(cmd, args);
    } catch (e) {
      resolve({ code: -1, out, err: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e) });
    });
  });
}

// 视频拆成几帧图片，好让模型「看」
async function videoFrames(url, want = 8) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vid-'));
  const inFile = path.join(dir, 'in.mp4');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('下载视频失败 ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 80 * 1024 * 1024) throw new Error('视频太大');
    await fs.writeFile(inFile, buf);

    const probe = await runCmd(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inFile],
      30000
    );
    const dur = parseFloat((probe.out || '').trim()) || 0;
    const fps = dur > 0 ? `${want}/${dur}` : '1/3';

    const r = await runCmd(
      'ffmpeg',
      ['-y', '-i', inFile, '-vf', `fps=${fps},scale=512:-2`, '-frames:v', String(want), path.join(dir, 'f%02d.jpg')],
      180000
    );

    const files = (await fs.readdir(dir)).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
    const frames = [];
    for (const f of files.slice(0, want)) {
      const b = await fs.readFile(path.join(dir, f));
      frames.push(`data:image/jpeg;base64,${b.toString('base64')}`);
    }
    console.log(
      `[视频] ${(buf.length / 1024 / 1024).toFixed(1)}MB / ${dur.toFixed(1)}s，抽出 ${frames.length} 帧（ffmpeg ${r.code}）`
    );
    if (!frames.length) console.log('[视频] ffmpeg 没出帧:', (r.err || '').slice(0, 200));
    return frames;
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 一条命令查清语音到底卡在哪，完整报错打到日志里
async function ttsDiagnose() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-'));
  const out = [];
  try {
    const mode = await ensureTts();
    out.push('edge 引擎：' + (mode || '装不上'));
    if (mode) {
      const ok = await synthSegment(mode, '测试一下', path.join(dir, 'e.mp3'), 'zh-CN-XiaoyiNeural', '+10%', '+2Hz', '0%');
      out.push('edge 合成：' + (ok ? '成功' : '失败（日志里看）'));
    }
    const hasChat = await ensureChatTts();
    out.push('ChatTTS：' + (hasChat ? '就绪' : '装不上'));
    if (hasChat) {
      const buf = await chatTtsVoice('测一下', dir);
      out.push('ChatTTS 合成：' + (buf ? '成功 ' + Math.round(buf.length / 1024) + 'KB' : '失败（日志里看）'));
    }
  } catch (e) {
    out.push('诊断出错：' + (e?.message || e));
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  console.log('[诊断]\n' + out.join('\n'));
  return out.join('\n');
}

// 缓冲：用户一次没说完，连着发几条，要合并成一句再理解
const pendingTurns = new Map();
const MERGE_WINDOW_MS = 3000;

function onMessage(kind, d) {
  if (!d || !d.id) return;
  if (seen.has(d.id)) return;
  seen.add(d.id);
  if (seen.size > 500) seen.clear();

  const text = (d.content || '').trim();
  const media = pickMedia(d);
  if (!text && !media) return;

  const openid = kind === 'group' ? d.group_openid : d.author?.user_openid;
  if (!openid) return;

  const key = `${kind}:${openid}`;
  const cur = pendingTurns.get(key) || { kind, openid, parts: [], media: null, lastId: d.id, timer: null };
  if (text) cur.parts.push(text);
  if (media) cur.media = media;
  cur.lastId = d.id;
  if (cur.timer) clearTimeout(cur.timer);
  cur.timer = setTimeout(() => {
    flushTurn(key);
  }, MERGE_WINDOW_MS);
  pendingTurns.set(key, cur);
  console.log(`[收到] ${text.slice(0, 40) || '[媒体]'}（等他说完…）`);
}

async function flushTurn(key) {
  const cur = pendingTurns.get(key);
  if (!cur) return;
  pendingTurns.delete(key);
  const joined = cur.parts.join('，').trim();
  try {
    await processTurn(cur.kind, cur.openid, joined, cur.media, cur.lastId);
  } catch (e) {
    console.log('[处理] 出错:', e?.message || e);
  }
}

async function processTurn(kind, openid, text, media, msgId) {
  const key = `${kind}:${openid}`;

  if (isAsleep()) {
    const rec = missed.get(key) || { kind, openid, count: 0 };
    rec.count += 1;
    rec.kind = kind;
    rec.openid = openid;
    missed.set(key, rec);

    if (rec.count < 3) {
      console.log(`[睡觉] 不回（今晚第 ${rec.count} 条）`);
      return;
    }
    // 被吵醒了，有起床气
    moods.set(key, { score: -1.5, updatedAt: Date.now() });
    console.log('[睡觉] 被吵醒了');
  }
  touch(kind, openid);
  lastUserAt.set(key, Date.now());
  nagDue.delete(key); // 人回来了，不闹了
  const score = updateMood(key, text);

  const askedNick = detectNickname(text);
  if (askedNick) {
    nicknames.set(key, askedNick);
    console.log(`[称呼] 记成「${askedNick}」`);
  } else if (wantsNicknameCleared(text)) {
    if (nicknames.delete(key)) console.log('[称呼] 已清掉');
  }

  console.log(`[${kind}] ${text.slice(0, 60) || "[无文字]"}${media ? " +" + media.kind : ""}（心情 ${score.toFixed(2)}）`);

  // 同一 msg_id 最多回 4 次（单聊）/ 5 次（群聊），msg_seq 要递增
  const LIMIT = kind === 'group' ? 5 : 4;
  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };
  const room = () => seq < LIMIT;

  if (/诊断语音|语音诊断/.test(text)) {
    try {
      const report = await ttsDiagnose();
      if (room()) await sendReply(kind, openid, report, msgId, nextSeq());
    } catch (e) {
      console.log('[诊断] 失败:', e?.message || e);
    }
    return;
  }

  try {
    // 图片直接给模型；视频先抽几帧再给
    let payload = null;
    if (media?.kind === 'image') {
      payload = { imageUrl: media.url };
    } else if (media?.kind === 'video') {
      try {
        const frames = await videoFrames(media.url);
        payload = frames.length ? { frames } : { unsupported: '一段视频（没抽到帧）' };
      } catch (e) {
        console.log('[视频] 抽帧失败:', e?.message || e);
        payload = { unsupported: '一段视频（没读出来）' };
      }
    } else if (media?.kind === 'audio') {
      console.log('[语音] 收到语音附件:', media.url ? media.url.slice(0, 120) : '');
      payload = { unsupported: '一条语音' };
    } else if (media?.kind === 'other') {
      payload = { unsupported: '一个文件' };
    }

    let answer = await askFish(key, text, payload);
    if (answer.length > 1500) answer = answer.slice(0, 1500) + '…';

    // 别秒回，装成在打字：字数越多「想」得越久，再抖一点随机
    const think = 1200 + Math.min(2500, text.length * 50) + Math.random() * 1200;
    await new Promise((r) => setTimeout(r, think));

    // 把 [表情:xxx] 标记抠出来
    const tags = [];
    answer = answer
      .replace(/\[表情[:：]\s*([^\]]+)\]/g, (_, t) => {
        tags.push(resolveTag(t));
        return '';
      })
      .trim();

    // 模型自己想要用声音说
    let voiceByModel = false;
    if (/\[语音\]/.test(answer)) {
      voiceByModel = true;
      answer = answer.replace(/\[语音\]/g, '').trim();
    }

    // 明着要图的，先甩一张，别废话
    const wantsMeme = /(表情包|表情|来张图|发张图|发个图|整张图)/.test(text) && text.length <= 20;

    // 要语音：明说要、上一轮刚给过语音还想要、或者模型自己加了标记
    const askedVoice = /(语音|声音|说句话|说给我听|说一句|说两句|念一下|念给|读一下|朗读|用嘴|听你|出声|唱|叫一?声|叫声|喊一?声|吭一声|吱一声|开口|说话|来一句|来一段|讲讲|说说)/.test(text);
    const nagging = /(再|还)(来|发|说|整)(一?[个段条遍])?/.test(text) && Date.now() - (lastVoice.get(key) || 0) < 10 * 60 * 1000;
    const wantsVoice = askedVoice || nagging;
    if (wantsMeme && room()) {
      await sendMeme(kind, openid, tags[0] || resolveTag(text), msgId, nextSeq());
    }

    // 语音优先：念出来了就不重复打字
    let voiceOk = false;
    if ((wantsVoice || voiceByModel) && answer && room()) {
      // 第一次要装 ChatTTS，先吱一声，别让人干等
      if (chatterState === '' && room()) {
        await sendReply(kind, openid, '等会儿，鱼先清个嗓子', msgId, nextSeq());
      }
      voiceOk = await sendVoice(kind, openid, answer, msgId, nextSeq(), moodScore(key));
      if (voiceOk) lastVoice.set(key, Date.now());
    }

    if (!voiceOk && answer && room()) {
      const parts = answer
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        if (!room()) break;
        await sendReply(kind, openid, p, msgId, nextSeq());
        await new Promise((r) => setTimeout(r, 600 + Math.random() * 800));
      }
    }

    for (const tag of tags.slice(0, 1)) {
      if (!room()) break;
      await sendMeme(kind, openid, tag, msgId, nextSeq());
    }

    lastSpoke.set(key, Date.now());
    scheduleNag(key);
    extractFacts(key, text, answer).catch(() => {});
    scheduleSave();
  } catch (err) {
    console.error('[出错]', err?.message || err);
    try {
      if (room()) await sendReply(kind, openid, '鱼这边卡了一下，等下再喊我一遍呗。', msgId, nextSeq());
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

// 白天随机来一句，别老等着人家先开口
const CHAT_LINES = [
  '干嘛呢',
  '在忙吗，鱼这边闲得长毛了',
  '刚摸鱼摸到一半，想起你了',
  '今天吃饭了没',
  '呃，有没有那种聊两句就困的时候',
  '鱼刚看到个事想不通，跟你说说',
  '你这会儿在干嘛，不许说在忙',
  '摸鱼时间到了，你呢',
  '突然觉得白米饭真好吃',
  '喂，活着没',
  '在线吗？不在鱼就自己玩去了',
  '刚打了个哈欠，传染给你',
  '有件事想问你，又忘了是什么事',
  '今天累不累啊',
  '鱼有点无聊，你陪我说两句呗',
  '诶，你觉得鱼可爱吗',
  '刚刷到个笑话，笑完就忘了',
  '你这人是不是又在忙',
  '说点啥吧，随便说',
  '鱼今天啥也没干，挺得意的',
  '你那边今天冷不冷，鱼这儿风有点大',
  '晚上吃啥想好了没，别又点外卖',
  '刚想起来，该收衣服了',
  '你说人为什么要上班啊',
  '鱼刚煮了锅米饭，香得很',
];

const firedSlots = new Set();
// 每个人上次被主动打扰的时间，避免同一个人短时间被连发
const lastActive = new Map();
// 谁刚听过语音，用来理解「再来一个」
const lastVoice = new Map();

// 作息：23:30 睡，7:30 起
const SLEEP_START = 23 * 60 + 30;
const SLEEP_END = 7 * 60 + 30;
// 睡着时收到的消息，醒来补一句
const missed = new Map();

function cnMinutes() {
  const d = cnNow();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function isAsleep() {
  const m = cnMinutes();
  return m >= SLEEP_START || m < SLEEP_END;
}

// 刚睡醒的那段时间，说话还没上线
let wakeAt = 0;
let wasAsleep = isAsleep();

function tickAwakeState() {
  const nowAsleep = isAsleep();
  if (wasAsleep && !nowAsleep) {
    wakeAt = Date.now();
    console.log('[睡觉] 醒了');
  }
  wasAsleep = nowAsleep;
}

function justWoke(ms = 30 * 60 * 1000) {
  return wakeAt > 0 && Date.now() - wakeAt < ms;
}
let nextChatAt = Date.now() + (20 + Math.random() * 25) * 60_000;

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
      if (ok) {
        n += 1;
        lastActive.set(`${f.kind}:${f.openid}`, Date.now());
      }
    }
    console.log(`[主动] ${slot.tag} 发了 ${n} 条`);
  }
}

async function tickChatter() {
  if (friends.size === 0) return;
  const now = cnNow();
  const h = now.getUTCHours();
  if (h < 8 || h >= 23) return;      // 起床后到睡前才闲聊
  if (Date.now() < nextChatAt) return;

  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  const cool = Date.now() - 45 * 60 * 1000;
  const pool = [...friends.values()].filter(
    (f) => f.lastSeen > cutoff && (lastActive.get(`${f.kind}:${f.openid}`) || 0) < cool
  );
  if (!pool.length) {
    nextChatAt = Date.now() + 30 * 60 * 1000;
    return;
  }

  // 每次最多找两个人，别一起轰炸
  const picks = [];
  while (picks.length < Math.min(3, pool.length)) {
    const f = pool[Math.floor(Math.random() * pool.length)];
    if (!picks.includes(f)) picks.push(f);
  }

  const line = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
  let n = 0;
  for (const f of picks) {
    const ok = await sendActive(f.kind, f.openid, line);
    if (ok) {
      n += 1;
      lastActive.set(`${f.kind}:${f.openid}`, Date.now());
    }
  }
  console.log(`[闲聊] 发了 ${n} 条：${line}`);

  // 下次隔 45~90 分钟
  nextChatAt = Date.now() + (45 + Math.random() * 45) * 60_000;
}

// 回完话就开始等：几分钟没人理，就闹一句小脾气
const NAG_LINES = [
  '喂，人呢？鱼跟你说话呢',
  '不理鱼是吧，行，鱼记着了',
  '哼，回个话有这么难吗',
  '鱼等半天了，你倒是说句话啊',
  '哦，忙吧，鱼自己玩',
  '喂喂喂，消失得这么干脆',
  '鱼有点不高兴了，你看着办',
  '再不理鱼，鱼就不理你了……说说而已',
  '你是把鱼忘在这儿了吧',
  '没人理，鱼数米饭粒去了',
];

function scheduleNag(key) {
  // 只在刚聊完这一小段里闹，隔太久的不算
  const delay = (4 + Math.random() * 5) * 60_000;
  nagDue.set(key, { at: Date.now() + delay, replyAt: Date.now() });
}

async function tickNag() {
  if (isAsleep() || !nagDue.size) return;
  const now = Date.now();
  for (const [key, rec] of [...nagDue.entries()]) {
    if (now < rec.at) continue;
    nagDue.delete(key);
    if ((lastUserAt.get(key) || 0) > rec.replyAt) continue;        // 人家回了，不闹
    if (now - (lastActive.get(key) || 0) < 10 * 60 * 1000) continue; // 刚被主动找过，别叠着轰
    if (now - (lastSpoke.get(key) || 0) > 30 * 60 * 1000) continue;  // 早聊完了，不算晾着

    const i = key.indexOf(':');
    const kind = key.slice(0, i);
    const openid = key.slice(i + 1);
    const line = NAG_LINES[Math.floor(Math.random() * NAG_LINES.length)];
    const ok = await sendActive(kind, openid, line);
    if (ok) {
      console.log(`[小脾气] 闹了一句：${line}（心情 ${(moodScore(key) - 0.4).toFixed(2)}）`);
      moods.set(key, { score: Math.max(-2, moodScore(key) - 0.4), updatedAt: Date.now() });
      pouting.add(key);
      lastActive.set(key, Date.now());
    }
  }
}

setInterval(() => {
  tickGreetings().catch((e) => console.error('[主动] 出错', e?.message || e));
  tickChatter().catch((e) => console.error('[闲聊] 出错', e?.message || e));
  tickNag().catch((e) => console.error('[小脾气] 出错', e?.message || e));
  tickAwakeState();
  tickWakeUp().catch((e) => console.error('[睡觉] 出错', e?.message || e));
}, 60_000);

// 睡醒了，把昨晚漏掉的补一句
async function tickWakeUp() {
  if (isAsleep() || !missed.size) return;
  for (const [key, rec] of [...missed.entries()]) {
    missed.delete(key);
    const line =
      rec.count >= 3
        ? `醒了醒了，昨晚你发了 ${rec.count} 条，鱼睡得跟死了一样`
        : '早，昨晚你发的看见了，鱼睡着了没回你';
    const ok = await sendActive(rec.kind, rec.openid, line);
    if (ok) console.log('[睡觉] 醒来补了一句');
  }
}

// 没人惹它也会有小情绪，像个活人
setInterval(() => {
  if (!moods.size) return;
  for (const [k, v] of moods) {
    if (Math.random() > 0.35) continue;
    const drift = (Math.random() - 0.5) * 0.7;
    const next = Math.max(-1.6, Math.min(1.6, v.score + drift));
    moods.set(k, { score: next, updatedAt: Date.now() });
  }
}, 45 * 60 * 1000);

// 冷落久了，情绪慢慢回平
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of moods) {
    if (now - v.updatedAt < 30 * 60 * 1000) continue;
    const s = v.score > 0 ? Math.max(0, v.score - 0.5) : Math.min(0, v.score + 0.5);
    if (s !== v.score) moods.set(k, { score: s, updatedAt: v.updatedAt });
  }
}, 10 * 60 * 1000);

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
