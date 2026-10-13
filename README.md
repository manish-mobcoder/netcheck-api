# NetCheck API

Throwaway Node.js backend for testing the MediXpert prod VPC before the real app moves in.
It has CRUD with Swagger on port 3000, behind Nginx on port 80. It uses the same `/api/v1` prefix and
`/api/v1/health` path as the MediXpert api-gateway, so ALB health checks and target groups carry over unchanged.

| Endpoint | What it proves |
|---|---|
| `GET/POST/PUT/DELETE /api/v1/items` | App + Nginx + ALB path works end to end (in-memory data) |
| `GET /api/v1/health` | Target group health check |
| `GET /api/v1/network/instance` | Which VPC / subnet / AZ / SGs the instance is really in, and whether it has a public IP |
| `GET /api/v1/network/egress` | Outbound internet. App subnet → returns NAT IP **3.109.125.80**. Data subnet → 504 timeout |
| `GET /api/v1/network/external-sample` | A real third-party API call via NAT (like PhonePe / Zoho would be) |
| `GET /api/v1/network/dns?host=…` | VPC DNS resolution (e.g. RDS / ElastiCache endpoints later) |
| `GET /api/v1/network/tcp?host=…&port=…` | SG chaining, e.g. RDS `:5432`, Redis `:6379` |
| `/docs` | Swagger UI |

## Run locally

```bash
npm install
PORT=3000 npm start      # http://localhost:3000/docs
```

## Deploy on EC2

```bash
# on the instance, inside the copied project folder
sudo bash deploy/setup-ec2.sh
```

The script installs Node 22 and Nginx (Amazon Linux 2023 or Ubuntu), runs the app as a systemd service
(`netcheck`) on `127.0.0.1:3000`, puts Nginx on `:80` in front of it, then runs a smoke test.

Useful commands: `systemctl status netcheck nginx`, `journalctl -u netcheck -f`, `curl localhost/api/v1/network/egress`.

## Security notes

- `/network/tcp` can probe any host:port the instance can reach. Set `ENABLE_TCP_CHECK=false` in
  `deploy/netcheck.service` (or delete the instance) once testing is done.
- Swagger has no auth here. Don't leave this exposed on a public ALB.
