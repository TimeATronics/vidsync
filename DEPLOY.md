# VidSync — Deployment Guide

> **Target**: RackNerd KVM VPS · Ubuntu 24.04 · `107.172.140.164`  
> **Subdomain**: `watch.aradhyac.com` (added alongside existing `aradhyac.com` portfolio)  
> **GitHub repo**: `https://github.com/TimeATronics/vidsync`  
> **Last verified against live system**: April 2026

---

## Live System State (as of verification)

| Item | Status |
|---|---|
| nginx 1.24.0 | ✅ Running — `aradhyac.com` served from `/var/www/ui` |
| Flask/gunicorn | ✅ Running — 3 workers on `127.0.0.1:5000` |
| MariaDB | ✅ Running on `127.0.0.1:3306` |
| Node.js v24.14.1 | ✅ Already installed — **skip Step 1** |
| SSL cert (`aradhyac.com`, `www.aradhyac.com`) | ✅ Valid — expires 2026-06-16 |
| PM2 | ❌ Not installed |
| yt-dlp | ❌ Not installed |
| Playwright/Chromium | ❌ Not installed |
| Port 3000 | ✅ Free |

**Do not modify** `/etc/nginx/sites-available/service` — it manages the live portfolio.

---

## Architecture

```
Internet
    │
    ├─ aradhyac.com / www.aradhyac.com
    │       └─► nginx (sites-available/service)
    │               ├─► /var/www/ui          (React SPA)
    │               └─► 127.0.0.1:5000       (Flask/gunicorn)
    │
    └─ watch.aradhyac.com
            └─► nginx (sites-available/vidsync)  ← NEW, created below
                    └─► 127.0.0.1:3000           (VidSync Node.js / PM2)
```

---

## Step 0 — DNS (Cloudflare)

> Your domain is registered at GoDaddy but DNS is managed by Cloudflare — add the record there.

Log in to [dash.cloudflare.com](https://dash.cloudflare.com) → select `aradhyac.com` → **DNS** → **Add record**:

| Type | Name  | IPv4 address    | Proxy status | TTL  |
|------|-------|-----------------|--------------|------|
| A    | watch | 107.172.140.164 | **DNS only** (grey cloud) | Auto |

> **Important**: Set proxy status to **DNS only** (grey cloud), NOT proxied (orange cloud). Cloudflare's proxy intercepts WebSocket upgrades in ways that break Socket.io unless you're on a paid plan. DNS-only passes traffic straight to the VPS where nginx handles everything.

Verify propagation (wait up to 5 minutes — Cloudflare is fast):
```bash
nslookup watch.aradhyac.com
# Should resolve to 107.172.140.164
```

---

## Step 1 — SSH into the VPS

```bash
ssh root@107.172.140.164
```

Node.js v24.14.1 is already installed. Skip any Node.js install steps.

---

## Step 2 — Install PM2

```bash
npm install -g pm2
pm2 --version   # verify
```

---

## Step 3 — Install yt-dlp

```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

Add a weekly auto-update cron (providers break extractors regularly):
```bash
crontab -e
# Add this line:
0 3 * * 0 /usr/local/bin/yt-dlp -U
```

---

## Step 4 — Install Playwright Chromium System Dependencies

```bash
apt-get update
apt-get install -y \
  libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2
```

The Chromium binary itself is installed in Step 6 after cloning.

---

## Step 5 — Clone and Build VidSync

```bash
cd /var/www
git clone https://github.com/TimeATronics/vidsync.git
cd vidsync

npm install
npx playwright install chromium
npm run build
```

---

## Step 6 — Configure Environment

```bash
cp .env.example .env
nano .env
```

Set the following values (replace the secret key):

```env
PORT=3000
SECRET_KEY=<run: openssl rand -hex 32>
PUBLIC_URL=https://watch.aradhyac.com
```

Generate the key:
```bash
openssl rand -hex 32
```

---

## Step 7 — Nginx Config for VidSync

Create a **new** config file. Do not edit the `service` file.

```bash
nano /etc/nginx/sites-available/vidsync
```

Paste:
```nginx
server {
    listen 80;
    server_name watch.aradhyac.com;
    # Certbot will add SSL directives here automatically in Step 8
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required for Socket.io WebSocket upgrade
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Long timeout needed for HLS segment streaming
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Enable and test:
```bash
ln -s /etc/nginx/sites-available/vidsync /etc/nginx/sites-enabled/vidsync
nginx -t          # must print: syntax is ok
systemctl reload nginx
```

---

## Step 8 — SSL Certificate

> **Note on certificate validity**: Let's Encrypt issues 90-day certificates — there is no way to get a 1-year cert from them. The solution is ensuring auto-renewal runs properly, which keeps the cert perpetually valid with zero manual work.

### 8a — Expand the existing cert to cover `watch.aradhyac.com`

This adds the new subdomain to the same certificate that already covers `aradhyac.com`:

```bash
certbot --expand -d aradhyac.com -d www.aradhyac.com -d watch.aradhyac.com --nginx
```

Certbot will:
- Issue a new cert covering all three names
- Automatically update the nginx configs for all three domains with SSL directives
- Choose "Redirect" (option 2) when prompted to force HTTPS

### 8b — Verify auto-renewal timer is active (ensures perpetual validity)

```bash
systemctl status certbot.timer
# Should say: active (waiting)

# If it's not active, enable it:
systemctl enable --now certbot.timer

# Test a dry-run renewal to confirm it works:
certbot renew --dry-run
```

This timer runs twice daily and renews any cert expiring within 30 days — both `aradhyac.com` and `watch.aradhyac.com` will renew automatically forever.

### 8c — Force-renew the existing cert right now (optional, resets the 90-day clock)

```bash
certbot renew --force-renewal
systemctl reload nginx
```

---

## Step 9 — Start VidSync with PM2

```bash
cd /var/www/vidsync
pm2 start dist/server/index.js --name vidsync
pm2 save
```

Auto-start PM2 on server reboot:
```bash
pm2 startup
# PM2 prints a command — copy and run it exactly
# It looks like: env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root
```

---

## Step 10 — Verify Everything

```bash
# VidSync process
pm2 status

# Logs (watch for errors on first start)
pm2 logs vidsync --lines 30

# Health check via HTTPS
curl https://watch.aradhyac.com/health
# Expected: {"status":"ok"}

# Confirm portfolio still works
curl -o /dev/null -s -w "%{http_code}" https://aradhyac.com
# Expected: 200
```

Open `https://watch.aradhyac.com` in a browser — the join screen should appear.

---

## Updating the App (After Code Changes)

```bash
cd /var/www/vidsync
git pull
npm install
npm run build
pm2 restart vidsync
```

---

## GitHub Actions Auto-Deploy (Optional)

Create `.github/workflows/deploy.yml` in the repo:

```yaml
name: Deploy to VPS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: root
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /var/www/vidsync
            git pull
            npm install
            npm run build
            pm2 restart vidsync
```

Add repository secrets in GitHub → Settings → Secrets:
- `VPS_HOST` → `107.172.140.164`
- `VPS_SSH_KEY` → contents of `/root/.ssh/id_ed25519` (private key)

Set up key-based SSH auth first (if not already done):
```bash
# On your local Windows machine (PowerShell):
ssh-keygen -t ed25519 -C "vidsync-deploy"
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@107.172.140.164 "cat >> /root/.ssh/authorized_keys"
```

---

## RAM Budget (Verified Against Live System)

| Process | Measured / Estimated RAM |
|---|---|
| MariaDB | ~105 MB (measured) |
| gunicorn master + 3 workers | ~243 MB (measured: ~81 MB/worker) |
| nginx master + worker | ~9 MB (measured) |
| fail2ban | ~24 MB (measured) |
| System/kernel/other | ~263 MB (measured) |
| **Current total** | **~644 MB used** |
| VidSync Node.js | ~100 MB |
| Playwright Chromium (idle, shared instance) | ~80 MB |
| Playwright Chromium (active extraction, ~15s burst) | +150 MB peak |
| **Peak total with VidSync** | **~975 MB** |
| **Free headroom (2.4 GB total)** | **~1.4 GB** |

> **Optional optimization**: Reduce gunicorn to 2 workers (saves ~81 MB) — the portfolio serves a personal site with low concurrency. Edit `/etc/systemd/system/aradhyac.service`, change `--workers 3` to `--workers 2`, then `systemctl daemon-reload && systemctl restart aradhyac`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `502 Bad Gateway` on VidSync | `pm2 logs vidsync` — check for crash on startup |
| WebSocket fails to connect | Confirm nginx has `Upgrade` + `Connection "upgrade"` headers |
| Portfolio broken after deploy | Run `nginx -t` — likely a syntax error in the new vidsync config |
| yt-dlp extraction fails | `yt-dlp -U && pm2 restart vidsync` |
| Playwright times out | `free -h` — if low RAM, reduce gunicorn workers as above |
| SSL cert expired | `certbot renew` + `systemctl reload nginx`. Also check: `systemctl status certbot.timer` |
| Port 3000 in use | `ss -tlnp | grep 3000` — kill the conflicting process |
