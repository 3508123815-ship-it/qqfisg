# qqfish · 大肥鱼 QQ 桥

QQ 官方机器人（WebSocket 长连接）→ DeepSeek → 被动回复。零第三方依赖，Node ≥ 22 直接跑。

## 部署（Render 免费实例）

1. Render 控制台 → New → Web Service → 连这个仓库
2. 语言选 Node，Build 填 `npm install`，Start 填 `node index.js`
3. 实例类型选 **Free**
4. 环境变量加三个：

| 变量 | 值 |
| --- | --- |
| `QQ_APPID` | q.qq.com 机器人详情里的 AppID |
| `QQ_SECRET` | 同页面的 AppSecret |
| `DEEPSEEK_API_KEY` | 自己的 key |

5. Deploy，看日志出现 `[网关] 已连接，机器人: xxx` 就是通了

## 保活

Render 免费实例 15 分钟没人访问会睡（每月 750 小时，24×31 刚好 744）。

程序自己会每 4 分钟请求一次自己的 `/health`，一般够用。保险起见再加一个外部探针：
[cron-job.org](https://cron-job.org) 免费建一个任务，每 10 分钟 GET `https://<你的服务>.onrender.com/health`。

真的睡着了也不会自己醒 —— 所以外部探针是兜底，别省。

## 排错

- 日志报 `缺少 QQ_APPID`：环境变量没配，或改了没点 Save 后重新部署
- `[网关] 取地址失败`：AppID / AppSecret 不对，或者没在 q.qq.com 配沙箱
- 能连上但微信里 @ 没反应：开放平台沙箱里没把自己加进测试成员 / 测试群
- 发消息 403：没开「单聊」权限（私聊需要申请，群 @ 默认有）
- 回复乱码或超时：模型 key 无效

## 已知道限制

- 对话记忆只在内存里，实例重启（部署/睡醒）就清空
- 这是简化版的鱼：没有手机端那些工具，记忆跟手机端不是一套
- 被动回复必须在收到消息 5 分钟内发出，所以别接长任务
