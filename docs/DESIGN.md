# Connect All — 设计说明

> 这份文档解释「为什么这样做」，给维护者和想审计的人看。实现细节以代码为准。

## 1. 总览

```
┌────────────────────────────┐          ┌────────────────────────────┐
│  Connect All (macOS)       │          │  Connect All (Windows)     │
│                            │          │                            │
│  Renderer (1-bit UI)       │          │  Renderer (1-bit UI)       │
│    chat / video / calendar │          │    chat / video / calendar │
│    CI / settings / widget  │          │    CI / settings / widget  │
│         │ IPC              │          │         │ IPC              │
│  Main process              │          │  Main process              │
│    Session (core)          │          │    Session (core)          │
│    Link  ── LAN (UDP+TCP) ─┼──────────┼─ LAN (UDP+TCP)             │
│      │     WebRTC (P2P)    │          │      │                     │
│      └── Relay WS ─────────┼────┐ ┌───┼──────┘                     │
└─────────────┬──────────────┘    │ │   └────────────────────────────┘
              │                   │ │
       encrypted backups          │ │
              ▼                   ▼ ▼
        ┌─────────────────────────────────┐
        │  Private relay (server/)        │
        │  - pairing rendezvous (15 min)  │
        │  - ciphertext relay + history   │
        │  - opaque encrypted backups     │
        └─────────────────────────────────┘

WebRTC media never goes through the relay; the relay carries SDP/ICE only.
```

核心原则：**服务端可见的越少越好；能用 P2P 就不绕服务器；能用本地就不联网。**

## 2. 设备身份与牵手

### 2.1 设备身份

- 每台设备生成 X25519 密钥对；私钥用系统钥匙串加密后存 `secrets.json`。
- `device.id` 是 12 位随机 hex；`device.name` 用户可改，会随状态同步给对方。
- 设备公钥只用于配对，不用于消息签名（消息用派生对称密钥做 GCM 认证）。

### 2.2 服务器牵手（6 位码）

```
A                                      B
pairing.startServer()                  pairing.startServer(code)
  code = random 6 (Crockford)            |
  room = HMAC(room-tag, code)            room = 同一个值
  token = HMAC(token-tag, code)          token = 同一个值
  POST /api/pair/join {room, token, pub} POST /api/pair/join ...
                \                       /
                 POST 返回 peers[2]
                 root = X25519(A.priv, B.pub) → HKDF(salt=排序后的 deviceId)
                 SAS = HMAC(root, 'sas') → 8 位数字
                 用户核对 SAS 一致 → 本地保存 root / peer
```

- 6 位码本身**不发给服务器**，服务器只拿到 HMAC 后的房间号与 token。
- 房间 15 分钟过期、最多 2 台设备；先到先占，第三台 409。
- SAS 是唯一能抵抗恶意服务器的信号：服务器若替换公钥，两边 SAS 不同。
- 牵手只写本机；服务器没有注册、没有账号、没有好友列表。

### 2.3 离线邀请

```
A.createInvite() → "CA1.<base64url({pub, device, serverUrl})>"
B.acceptInvite(invite) → 派生 root，回传 reply（B 的 pub）
A.acceptReply(reply) → 派生同一个 root
双方核对 SAS → 各自 confirm
```

- 不需要服务器，字符串可走微信/AirDrop/纸条。
- 双方 ECDH 的私钥始终不离设备；邀请里只有公钥。
- 适合「没有服务器但想先用 CI/日历」的场景。

## 3. 加密信封

每条消息：

```json
{ "v": 1, "id": "随机 40 hex", "kind": "chat|status|calendar|signal|media|ack|typing",
  "cipher": "base64url(iv|tag|ct)" }
```

- 每个 `kind` 从 root 派生独立 32B 子密钥：`HKDF(root, salt, "connect-all-<kind>")`。
- AES-256-GCM；12B 随机 IV；16B tag；AAD = `ca1|<kind>`。
- 因此即使服务器把一条 chat 密文改标为 calendar，客户端也会因 AAD/子密钥不匹配而拒绝。
- 接收端按 `id` 去重（保留 4000 个）；`id` 是随机值，不暴露序号规律。
- 服务器额外加 `seq` 用于断线补发；`seq` 不参与加密。

### 密钥派生

```
shared  = X25519(my.priv, peer.pub)
salt    = "connect-all|" + join(sort(myDeviceId, peerDeviceId))
root    = HKDF-SHA256(shared, salt, "connect-all-root", 32)
subkey  = HKDF-SHA256(root,   salt, "connect-all-" + kind, 32)
SAS     = HMAC-SHA256(root, "connect-all-sas-v1")[0:6] → 8 位十进制
```

`importRoot` 允许从已保存的 root 重新派生，不必保留 ECDH 私钥。

## 4. 传输层

### 4.1 选择

| 模式 | 行为 |
|---|---|
| `auto`（默认） | LAN 在线用 LAN，否则私有服务器 |
| `relay` | 只用私有服务器 |
| `lan` | 只用局域网（不需要服务器） |
| `offline` | 不建立链路；聊天进队列，CI/日历本地可用 |

`Link` 统一做加密/去重/队列/ACK；具体传输只搬不透明信封。

### 4.2 LAN：UDP 发现 + TCP 直连

- UDP 47710 广播：`{ca:1, tag, deviceId, name, port, ts}`。
  - `tag = HMAC(root, "lan-tag")[0:24]`，不暴露房间号/root。
  - 同时向 255.255.255.255、各网卡广播地址、127.0.0.1 发送。
- 发现对方后，**设备 id 字典序较小的一方发起 TCP 连接**；另一方只接受，避免双向同时连。
- TCP 上是换行分隔的 JSON：`hello/tag → welcome → data`；心跳 10s，35s 无 pong 断开重连。
- 链路两端仍走 Link 加密；LAN 只是更快、不依赖服务器。
- 同一 Wi-Fi 下实测可发现并收发（macOS + 同机回环）。

### 4.3 中继

- WebSocket `/ws?room&token&device&since`；服务器校验 token 哈希。
- 断线重连指数退避（1s→30s）；心跳 ping；75s 无活动重连。
- **epoch**：数据目录首次创建时随机生成；客户端发现 epoch 变化 → `since=0` 重新拉历史。
  - 这是为了解决「服务器重建后 seq 归零，客户端游标比服务器大，历史被跳过」的真实故障。
- 离线消息服务器最多存 300 条 / 7 天；客户端自己的队列最多 400 条。
- 客户端把 `relaySeq/relayEpoch` 存在 `state.json`，重启后从游标继续。

## 5. Connect Intelligence

### 5.1 触发

- 默认每 60 分钟对齐整点（可 30/120/240）。计时器在 `ci.js`。
- 睡眠/关机错过多次：启动后 20 秒补跑一次，窗口最多回看 6 小时。
- 窗口内没有消息：只更新 `lastRunAt`，不调模型、不产生卡片。
- 手动运行有 5 秒防抖，避免连点造成 API 费用。

### 5.2 输入

窗口内的本机聊天（不含 system）、可选双方日程、最近 3 条汇总（保持连续性）、当前对方在线状态。

### 5.3 输出 schema

```json
{
  "headline": "一句话",
  "topics": [{"title": "...", "detail": "..."}],
  "promises": [{"who": "我|TA|双方", "what": "...", "by": "..."}],
  "unanswered": [{"question": "...", "askedBy": "我|TA", "since": "..."}],
  "plans": [{"what": "...", "when": "..."}],
  "mood": {"label": "平稳|开心|低落|紧张|疲惫", "note": "..."},
  "risks": [{"issue": "...", "suggestion": "..."}],
  "nextActions": ["..."]
}
```

- 模型返回后统一 `normalizeSummary` 截断长度、限制条数、丢弃空项，防止 UI 被超长文本破坏。
- 解析失败 → 本地兜底；模型 5xx/超时 → 本地兜底并标 `local-fallback` 与错误。
- 本地兜底规则：
  - 问题：`? / 吗 / 什么时候 / 几点 / 你还…吗`；「我想想/再说/看情况」不算回答。
  - 承诺：`我答应/我会/说好/记得/周五前/明天` 等。
  - 计划：包含时间词 + 动作词的消息。
  - 情绪：正负词典 + emoji 计分。
  - 风险：未答问题数、最后一条负面情绪、无明确时间的承诺。

### 5.4 隐私

- 默认只写 `ci.jsonl`；不自动同步给对方，不上传。
- 只有开启「加密备份」时，摘要才进入备份快照，并用 root 派生的 backup key 加密。
- 模型 API 请求从主进程发出；Key 从不回到渲染进程。

## 6. 日历

- 手写 iCalendar 解析器（无第三方依赖）：
  - 展开行；解析参数（含引号值）；转义 `\, \; \\ \n`。
  - `DTSTART/DTEND/DURATION`，`VALUE=DATE`、`TZID`、UTC `Z`、floating。
  - 时区偏移用 ICU/Intl 计算，跨 DST 保持「墙钟时间」。
  - RRULE：DAILY/WEEKLY/MONTHLY/YEARLY，INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/BYMONTH/WKST。
  - 月度 31 号在短月跳过（RFC 行为），不做夹取。
  - EXDATE 与 RECURRENCE-ID 覆盖；覆盖按原始 occurrence 时间索引，而不是新时间。
- 共享快照只含 `summary/start/end/allDay/location/class/owner`；`PRIVATE` 可隐藏。
- 对方快照存 `calendar/partner.json`，最多 500 条；过期一周的丢弃。

## 7. 视频与音频

### 7.1 固定 m-line

WebRTC 最容易出错的是重协商。这里的做法：

- 主叫创建 **4 个 transceiver**：摄像头视频、屏幕视频、麦克风音频、系统音频（顺序固定，`sendrecv`）。
- 被叫**不预建**；收到 offer 后由 offer 创建 4 个 transceiver，然后在 `setRemoteDescription` 之后：
  - `bindTransceivers()` 取 sender；
  - 显式把 `transceiver.direction = 'sendrecv'`（从 offer 继承的默认是 `recvonly`，`replaceTrack` 不会改方向）；
  - `replaceTrack` 挂上本地轨道，再 `createAnswer`。
- 之后开关摄像头/屏幕只做 `replaceTrack(null|track)`，**不触发重协商**。
- 早期版本曾在两边都预建 transceiver，结果被叫协商出 8 条 m-line、本地轨道挂在未协商的 4 条上，双方都只发不收。这个坑已由双实例 E2E 回归覆盖。

### 7.2 1:4 分屏

- DOM：`.video-stage` 内同时有 `.video-grid`（通话）与 `.video-side + .video-main`（分屏）；`mode-call/mode-split` 切换显示。
- 视频条宽度=20%（可拖 15–35%），两侧各一个 `<video>`，避免把同一个流在 DOM 里搬来搬去。
- 屏幕共享通过 `session.setDisplayMediaRequestHandler` 返回选中的屏幕源 + 可选 loopback 音频。
- 接收端用「screen 控制消息」而不是 `track.muted` 判断是否真的在共享，避免占位 receiver track 误显示。

### 7.3 音乐

- 双方各自打开本地文件；播放/暂停/seek/切歌通过 data channel（降级到加密链路）同步。
- 文件名不一致时提示；不传音频文件本身。
- 可选共享系统声音：`getDisplayMedia({audio:true})` 的音频轨挂到第 4 条 transceiver。
- 封面为 1-bit 图案 + 实时频谱（WebAudio analyser）。

## 8. 状态 / 位置

- 状态码：online / away / focus / in_call / watching / listening / on_the_way / offline。
- 自动推导优先级：勿扰 > 一起看 > 通话 > 听歌 > 日历地点（30 分钟内） > 空闲 5 分钟 > 在线。
- 「前往何处」不读 GPS：用日历事件 LOCATION，或用户手动填写地点。
- 位置/开机时间是否共享由开关控制；关闭后字段不进入加密状态包。
- 对方状态包带 `updatedAt`，旧包丢弃；`_onPeerStatus` 同时更新对方设备名并触发快照刷新。

## 9. 本地数据

| 文件 | 内容 | 备注 |
|---|---|---|
| `config.json` | 设置、设备信息、peer 元数据 | 无密钥 |
| `secrets.json` | API Key、设备私钥、配对 root | 系统钥匙串加密 |
| `chat.jsonl` | 聊天，含双方消息 | 明文，可导出/清空 |
| `ci.jsonl` | CI 卡片 | 明文，可设保留期 |
| `calendar/*.ics` | ICS 原文 | 供重新解析 |
| `calendar/sources.json` | 源元数据 | 配置 |
| `calendar/partner.json` | 对方日程快照 | 只含共享字段 |
| `backups/*.ca` | 加密备份 | 最近 6 份 |
| `state.json` | 未读、relaySeq/epoch、窗口布局 | 无敏感内容 |

原子写：先写 `.tmp` 再 `rename`；损坏的 JSON 会被重命名为 `.corrupt-<ts>` 保留证据而不是静默删除。

## 10. 界面系统

- 1-bit：黑/白/纸灰；状态色仅绿/琥珀/红，且只用于 LED 与少量标签。
- 控件：1px 黑边 + 内阴影 + 按下反色；默认按钮双线框（System 7 风格）。
- 标题栏：`repeating-linear-gradient` 生成 1px 横条纹；非活动窗口去掉条纹；左侧关闭盒、右侧缩放盒、右下角缩放纹。
- 桌面：2px 点阵 / 3px 棋盘格叠加；左侧图标栏用点线分隔，避免与经典「右侧图标」和窗口打架。
- 字体：系统 Geneva / PingFang / 系统等宽；不分发 Apple 字体。
- 所有窗口内容为原生 HTML/CSS/JS，无前端框架、无构建步骤；离线可跑。
- i18n：`i18n.js` 全量中英字典；菜单栏、窗口标题、按钮、状态、错误、通知都走 `T()`。改语言即时重载并回到原窗口。

## 11. 测试矩阵

| 层 | 命令 | 覆盖 |
|---|---|---|
| 核心（Node） | `pnpm test` | 密码学、ICS、聊天、中继、备份、CI、双 Session、离线邀请 |
| 双实例 E2E | `pnpm test:e2e` | 真 IPC、牵手、聊天、WebRTC 双向帧、1:4 同步、音乐布局、挂断 |
| 截图回归 | `pnpm showcase` | 所有窗口 + 演示数据 |

E2E 使用 Electron 的 `--use-fake-device-for-media-stream`，因此不需要真实摄像头。WebRTC 断言 `videoWidth > 0`，不是只看连接状态。

## 12. 已知取舍

- 单一配对关系；没有多设备/群聊/转发。
- 中继不转发媒体，所以对称 NAT 必须有 TURN。
- 无附件/图片/语音消息；聊天是纯文本（可粘贴多行）。
- 没有自动更新与签名。
- 本地聊天明文；依赖系统全盘加密与设备安全。
- 日历只读（导入），不在应用内新建事件；避免与系统日历双向同步的复杂度。
- 音乐同步不传音频文件；要「我放你听」需依赖系统声音共享。
- 窗口布局存在 localStorage；不跨设备同步。
