# Connect All — 私有服务器部署

中继服务器只做三件事：**转发加密信令/消息、暂存离线密文、保存加密备份**。它没有账号、没有数据库、没有 npm 依赖；`server/` 里两个文件即可运行。

---

## 1. 最小部署（5 分钟）

要求：一台有公网 IP 的 VPS / NAS / 家里常开的机器，Node 18+（推荐 20/22/24），一个域名（可选但强烈建议）。

```bash
# 本地
scp -r server/ you@server:/opt/connect-all/

# 服务器
cd /opt/connect-all/server
node ca-server.js --port 8787 --data ./ca-data --quota-mb 512
```

打开 `http://服务器IP:8787/` 会看到一个状态页，`/api/health` 返回 JSON。

在 Connect All「私有服务器」窗口填写 `http://服务器IP:8787`，点「测试连接」→「保存并使用」。

> **局域网**：两台设备在同一个 Wi-Fi 时，Connect All 会优先走 UDP 发现 + TCP 直连，不依赖服务器。服务器主要用于异地信令和备份。

---

## 2. 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `-p, --port` | `8787` | 监听端口 |
| `--host` | `0.0.0.0` | 绑定地址（只想本机用可设 `127.0.0.1`） |
| `-d, --data` | `./ca-data` | 数据目录：`rooms/` 历史、`backups/` 密文、`rooms-meta.json` |
| `--quota-mb` | `512` | **每个房间**的加密备份配额 |
| `--history` | `300` | 每房间保留的离线消息条数 |
| `--history-days` | `7` | 离线消息保留天数 |
| `--tls-cert` / `--tls-key` | — | 直接由 Node 提供 TLS（通常交给 Caddy/nginx） |
| `--quiet` | 关 | 减少日志 |

环境变量：无。全部靠参数。

数据布局：

```
ca-data/
  rooms-meta.json          房间 token 哈希 + 服务器 epoch
  rooms/<room>.jsonl       离线密文消息（不含明文）
  backups/<room>/*.bin     加密备份（AES-GCM 密文）
```

`rooms-meta.json` 中的 `epoch` 在数据目录第一次创建时随机生成；客户端发现 epoch 变化会自动重放历史，避免服务器重建后丢消息。

---

## 3. systemd

```ini
[Unit]
Description=Connect All relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/connect-all/server
ExecStart=/usr/bin/node /opt/connect-all/server/ca-server.js --port 8787 --data /var/lib/connect-all --quota-mb 1024
Restart=always
RestartSec=2
User=connectall
Group=connectall
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/connect-all

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/connect-all --shell /usr/sbin/nologin connectall
sudo mkdir -p /var/lib/connect-all && sudo chown -R connectall: /var/lib/connect-all
sudo systemctl daemon-reload && sudo systemctl enable --now connect-all
journalctl -u connect-all -f
```

> 登录节点/桌面机器也能用，但不要把它暴露在公网裸 HTTP。用下面的 TLS 反向代理。

---

## 4. TLS + WebSocket 反向代理

### Caddy（最简单，自动证书）

```caddyfile
ca.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 默认就会转发 WebSocket Upgrade，无需额外配置。客户端填 `https://ca.example.com`。

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name ca.example.com;

    ssl_certificate     /etc/letsencrypt/live/ca.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ca.example.com/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

> `/ws` 必须支持 Upgrade；`proxy_read_timeout` 要足够长，否则客户端会周期性断线重连。

### 自签名证书

客户端「私有服务器」窗口有「接受自签名证书」开关。只在完全信任自己的服务器时打开。

---

## 5. TURN（跨网络视频更稳）

中继**不转发视频**，只转发信令。WebRTC 在对称 NAT 下需要 TURN。用 [coturn](https://github.com/coturn/coturn)：

```bash
sudo apt install coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

`/etc/turnserver.conf`：

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=couple:换一个长密码
realm=ca.example.com
external-ip=你的公网IP
min-port=49152
max-port=65535
no-multicast-peers
no-cli
```

防火墙放行 3478/tcp+udp、5349/tcp+udp、49152–65535/udp。

在 Connect All「设置 → 服务器与备份 → ICE / TURN」填写：

- TURN 地址：`turn:ca.example.com:3478`
- 用户名 / 密码：上面的 `couple` / 密码

保存后会用在双方下一次通话。

---

## 6. Docker（可选）

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server/ /app/server/
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "/app/server/ca-server.js", "--port", "8787", "--data", "/data"]
```

```bash
docker build -t connect-all-relay .
docker run -d --name ca-relay -p 8787:8787 -v ca-data:/data --restart unless-stopped connect-all-relay
```

对外仍然建议前面放 Caddy。

---

## 7. API 与安全边界

### HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 状态页 |
| GET | `/api/health` | `{ok, version, epoch, rooms, quotaMB, historyLimit}` |
| POST | `/api/pair/join` | 牵手房间：投递公钥，最多 2 台设备，15 分钟 TTL |
| POST | `/api/pair/leave` | 取消牵手 |
| GET | `/api/backup/:room` | 列出该房间的备份（需 token） |
| GET | `/api/backup/:room/:name` | 下载密文 |
| PUT | `/api/backup/:room/:name` | 上传密文（需 token，受配额限制） |
| DELETE | `/api/backup/:room/:name` | 删除密文 |

### WebSocket

`/ws?room=<hex>&token=<hex>&device=<id>&since=<seq>`

- 服务端按房间广播 `msg`，附带单调递增 `seq`；
- 重连时补发 `seq > since` 的历史（最多 500 条）；
- 心跳 ping/pong，90 秒无活动断开；
- 消息体上限 256 KB，房间历史 300 条 / 7 天（可调）。

### 服务端能看到什么

- 房间 ID（由 6 位牵手码 HMAC 派生，或由配对根密钥派生）
- 设备 ID / 设备名 / 平台
- 密文大小、时间戳、序号
- 备份文件名与大小

**看不到**：聊天内容、日程、位置、状态、CI 记忆、API Key、配对根密钥。所有消息在客户端用 AES-256-GCM 加密；AAD 绑定消息类型，防止跨类型替换。

### 服务端防护

- 房间 token 使用 SHA-256 哈希存储；常量时间比较；
- 每 IP 的牵手 / 备份 / WebSocket 频率限制；
- 备份文件名严格白名单，防路径穿越；
- 每房间配额，防止被当成免费网盘；
- 可配置 TLS；建议只对公网开放 443，源站 8787 仅本机；
- 无管理后台、无默认口令。服务器被入侵时，攻击者拿到的是密文和元数据，不是聊天内容。

### 需要自己承担的风险

- 6 位牵手码可被在线猜测（受限流 + 15 分钟 TTL + 8 位 SAS 校验缓解）；
- 恶意服务器可以做中间人替换公钥，**SAS 校验是唯一的人类防线**，务必核对；
- 没有账号恢复：丢失配对密钥 = 无法解密旧备份；
- 服务器只做静态文件式备份，不做去重/增量；每份快照独立。

---

## 8. 升级与备份服务器自身

```bash
# 升级：停服务 → 替换 server/ → 启服务
sudo systemctl stop connect-all
sudo cp -r server/* /opt/connect-all/server/
sudo systemctl start connect-all
```

`ca-data/` 里全是密文；仍建议定期打包备份（它包含你们的加密记忆，没有配对密钥也解不开）。

---

## 9. 排错

| 现象 | 可能原因 |
|---|---|
| 客户端「测试连接」失败 | 反向代理未转发 WebSocket / 端口未放行 / 证书不受信（可开自签名开关） |
| 能测试但不能聊天 | 两端 token/房间不一致（解除牵手重配）、系统时间偏差过大 |
| 聊天偶尔断线 | `proxy_read_timeout` 太短、NAT 空闲超时；客户端会自动重连 |
| 视频连不上 | 需要 TURN（对称 NAT）；或客户端被防火墙拦 UDP |
| 备份 413 | 房间配额满；删除旧归档或调大 `--quota-mb` |
| 服务器重启后丢消息 | 数据目录不在持久卷；确认 `--data` 指向持久盘 |

日志里不会出现消息内容，只有房间前缀、设备前缀、字节数与错误。
