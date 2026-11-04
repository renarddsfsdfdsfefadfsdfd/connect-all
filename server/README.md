# Connect All relay

Two files, zero npm dependencies. Node 18+.

```bash
node ca-server.js --port 8787 --data ./ca-data --quota-mb 512
```

- `ca-server.js` — HTTP + WebSocket relay, pairing rendezvous, encrypted backup vault
- `ws.js` — dependency-free WebSocket implementation shared with the desktop client

It only sees room ids, device names, ciphertext sizes and opaque backup blobs. TLS is normally terminated by Caddy/nginx; examples are in `examples/`. Full deployment guide: `../docs/SERVER.md`.
