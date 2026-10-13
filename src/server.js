'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const os = require('node:os');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./openapi');

const PORT = Number(process.env.PORT || 3000);
// Bind to localhost by default so only Nginx can reach the app; set HOST=0.0.0.0 to expose it directly.
const HOST = process.env.HOST || '127.0.0.1';
// The TCP check can probe any host:port reachable from the instance. Disable it outside of testing.
const ENABLE_TCP_CHECK = process.env.ENABLE_TCP_CHECK !== 'false';

const app = express();
app.use(express.json());

const api = express.Router();

// ---------- Health (same paths as MediXpert api-gateway, so ALB health checks carry over) ----------

api.get('/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), hostname: os.hostname() });
});

// ---------- CRUD: in-memory items ----------

const items = new Map();

function validateItem(body, partial) {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') return '"name" must be a non-empty string';
  }
  if (body.price !== undefined && (typeof body.price !== 'number' || body.price < 0)) {
    return '"price" must be a non-negative number';
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return '"description" must be a string';
  }
  return null;
}

api.get('/items', (req, res) => {
  res.json([...items.values()]);
});

api.get('/items/:id', (req, res) => {
  const item = items.get(req.params.id);
  if (!item) return res.status(404).json({ message: 'Item not found' });
  res.json(item);
});

api.post('/items', (req, res) => {
  const error = validateItem(req.body, false);
  if (error) return res.status(400).json({ message: error });
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    name: req.body.name.trim(),
    description: req.body.description ?? '',
    price: req.body.price ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  items.set(item.id, item);
  res.status(201).json(item);
});

api.put('/items/:id', (req, res) => {
  const item = items.get(req.params.id);
  if (!item) return res.status(404).json({ message: 'Item not found' });
  const error = validateItem(req.body, true);
  if (error) return res.status(400).json({ message: error });
  const { name, description, price } = req.body;
  if (name !== undefined) item.name = name.trim();
  if (description !== undefined) item.description = description;
  if (price !== undefined) item.price = price;
  item.updatedAt = new Date().toISOString();
  res.json(item);
});

api.delete('/items/:id', (req, res) => {
  if (!items.delete(req.params.id)) return res.status(404).json({ message: 'Item not found' });
  res.status(204).end();
});

// ---------- Network diagnostics ----------

// IMDSv2: tells us which VPC / subnet / AZ this instance actually landed in.
async function imds(path, token) {
  const r = await fetch(`http://169.254.169.254/latest/${path}`, {
    headers: { 'X-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) throw new Error(`IMDS ${path} -> HTTP ${r.status}`);
  return (await r.text()).trim();
}

api.get('/network/instance', async (req, res) => {
  try {
    const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
      signal: AbortSignal.timeout(2000),
    });
    if (!tokenRes.ok) throw new Error(`IMDS token -> HTTP ${tokenRes.status}`);
    const token = await tokenRes.text();
    const mac = await imds('meta-data/mac', token);
    const iface = `meta-data/network/interfaces/macs/${mac}`;
    const [instanceId, az, privateIp, vpcId, subnetId, subnetCidr, sgIds] = await Promise.all([
      imds('meta-data/instance-id', token),
      imds('meta-data/placement/availability-zone', token),
      imds('meta-data/local-ipv4', token),
      imds(`${iface}/vpc-id`, token),
      imds(`${iface}/subnet-id`, token),
      imds(`${iface}/subnet-ipv4-cidr-block`, token),
      imds(`${iface}/security-group-ids`, token),
    ]);
    // A missing public IP is expected (and desired) for instances in private subnets.
    const publicIp = await imds('meta-data/public-ipv4', token).catch(() => null);
    res.json({
      instanceId,
      availabilityZone: az,
      vpcId,
      subnetId,
      subnetCidr,
      privateIp,
      publicIp,
      securityGroupIds: sgIds.split('\n'),
    });
  } catch (err) {
    res.status(502).json({ message: 'Could not read EC2 instance metadata (not on EC2, or IMDS disabled)', error: err.message });
  }
});

// Outbound internet test. From the app subnets this should return the NAT gateway IP;
// from the data subnets it should time out (no route to the internet).
api.get('/network/egress', async (req, res) => {
  const started = Date.now();
  try {
    const r = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5000) });
    const publicIp = (await r.text()).trim();
    res.json({ internet: true, egressPublicIp: publicIp, latencyMs: Date.now() - started });
  } catch (err) {
    res.status(504).json({ internet: false, error: err.cause?.code || err.name, latencyMs: Date.now() - started });
  }
});

// Fetch an external JSON API, to show a realistic "backend calls a third party" request going through NAT.
api.get('/network/external-sample', async (req, res) => {
  try {
    const r = await fetch('https://jsonplaceholder.typicode.com/todos/1', { signal: AbortSignal.timeout(5000) });
    res.json({ upstreamStatus: r.status, body: await r.json() });
  } catch (err) {
    res.status(504).json({ message: 'External API unreachable', error: err.cause?.code || err.name });
  }
});

api.get('/network/dns', async (req, res) => {
  const host = String(req.query.host || '');
  if (!host) return res.status(400).json({ message: 'Query param "host" is required' });
  try {
    const addresses = await dns.lookup(host, { all: true });
    res.json({ host, addresses });
  } catch (err) {
    res.status(502).json({ host, error: err.code || err.message });
  }
});

// TCP reachability, e.g. RDS on 5432 or ElastiCache on 6379, to verify security group chaining.
api.get('/network/tcp', (req, res) => {
  if (!ENABLE_TCP_CHECK) return res.status(403).json({ message: 'TCP check disabled (ENABLE_TCP_CHECK=false)' });
  const host = String(req.query.host || '');
  const port = Number(req.query.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ message: 'Query params "host" and "port" (1-65535) are required' });
  }
  const started = Date.now();
  const socket = net.connect({ host, port });
  const finish = (status, body) => {
    socket.destroy();
    if (!res.headersSent) res.status(status).json({ host, port, latencyMs: Date.now() - started, ...body });
  };
  socket.setTimeout(3000);
  socket.once('connect', () => finish(200, { reachable: true }));
  socket.once('timeout', () => finish(504, { reachable: false, error: 'TIMEOUT (usually a security group or route blocking it)' }));
  socket.once('error', (err) => finish(502, { reachable: false, error: err.code }));
});

app.use('/api/v1', api);
app.get('/docs.json', (req, res) => res.json(openapi));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/', (req, res) => res.redirect('/docs'));

app.use((req, res) => res.status(404).json({ message: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`netcheck-api listening on http://${HOST}:${PORT} (Swagger at /docs)`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
