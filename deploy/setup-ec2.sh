#!/usr/bin/env bash
# Sets up NetCheck API + Nginx on a fresh EC2 instance (Amazon Linux 2023 or Ubuntu 22.04/24.04).
# Run from the project root on the instance:  sudo bash deploy/setup-ec2.sh
#
# Needs outbound internet (to install packages). In an app subnet that goes through the NAT gateway,
# so a successful run already proves the NAT route works. In a data subnet it will fail, as it should.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/netcheck-api
NODE_MAJOR=22

. /etc/os-release
echo "==> Detected OS: ${PRETTY_NAME}"

echo "==> Installing Node.js ${NODE_MAJOR} and Nginx"
if [[ "${ID}" == "amzn" ]]; then
  dnf install -y "nodejs${NODE_MAJOR}" nginx
  # AL2023 installs node22 as /usr/bin/node-22; expose it as /usr/bin/node for the systemd unit.
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "${NODE_MAJOR}" ]]; then
    alternatives --install /usr/bin/node node "/usr/bin/node-${NODE_MAJOR}" 100 || true
    alternatives --install /usr/bin/npm npm "/usr/bin/npm-${NODE_MAJOR}" 100 || true
  fi
  NGINX_CONF=/etc/nginx/conf.d/netcheck.conf
elif [[ "${ID}" == "ubuntu" || "${ID}" == "debian" ]]; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg nginx
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "${NODE_MAJOR}" ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi
  rm -f /etc/nginx/sites-enabled/default
  NGINX_CONF=/etc/nginx/conf.d/netcheck.conf
else
  echo "Unsupported OS: ${ID}" >&2
  exit 1
fi

echo "==> Node $(node -v), npm $(npm -v)"

echo "==> Creating service user and copying app to ${APP_DIR}"
id netcheck >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin netcheck
mkdir -p "${APP_DIR}"
cp -r "${SRC_DIR}/package.json" "${SRC_DIR}/src" "${APP_DIR}/"
[[ -f "${SRC_DIR}/package-lock.json" ]] && cp "${SRC_DIR}/package-lock.json" "${APP_DIR}/"
cd "${APP_DIR}"
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
chown -R netcheck:netcheck "${APP_DIR}"

echo "==> Installing systemd unit"
cp "${SRC_DIR}/deploy/netcheck.service" /etc/systemd/system/netcheck.service
systemctl daemon-reload
systemctl enable --now netcheck
systemctl restart netcheck

echo "==> Configuring Nginx"
cp "${SRC_DIR}/deploy/nginx-netcheck.conf" "${NGINX_CONF}"
# AL2023's stock nginx.conf also has a default_server on :80; drop it so ours wins.
if [[ "${ID}" == "amzn" ]]; then
  sed -i 's/listen\s\+80 default_server;/listen 80;/; s/listen\s\+\[::\]:80 default_server;/listen [::]:80;/' /etc/nginx/nginx.conf
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> Smoke test"
sleep 2
curl -fsS http://127.0.0.1/api/v1/health && echo
curl -sS http://127.0.0.1/api/v1/network/egress && echo

echo
echo "Done. Swagger: http://<instance-or-alb-address>/docs"
echo "Logs:  journalctl -u netcheck -f"
