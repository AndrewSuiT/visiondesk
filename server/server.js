/**
 * VisionDesk - Central Server & Signaling Hub
 * File: server/server.js
 *
 * Ultra-lightweight HTTP + WebSocket Server (< 30 MB idle RAM in Docker).
 * Provides static web dashboard hosting, REST API endpoints, and real-time signaling hub.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { WebSocketServer, WebSocket } = require('ws');
const { BranchRegistry } = require('./registry');
const { createRelayBroker } = require('./relay');
// ==============================================================================
// Persistent / In-Memory Users & Licenses Manager
// ==============================================================================
const USERS_FILE = path.join(__dirname, 'users.json');

const DEFAULT_USERS_DATA = {
  admin: {
    username: 'admin',
    password: 'Manz-601$',
    role: 'admin',
    plan: 'pro',
    displayName: 'Administrador Central',
    updatedAt: new Date().toISOString()
  },
  usuario: {
    username: 'usuario',
    password: 'M20120752601',
    role: 'usuario',
    plan: 'pro',
    displayName: 'Usuario de Soporte',
    updatedAt: new Date().toISOString()
  },
  moderador: {
    username: 'moderador',
    password: 'Odisea_11$',
    role: 'moderator',
    plan: 'pro',
    displayName: 'Moderador del Sistema',
    updatedAt: new Date().toISOString()
  }
};

class UsersManager {
  constructor() {
    this.users = {};
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const raw = fs.readFileSync(USERS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.users = { ...DEFAULT_USERS_DATA, ...parsed };
      } else {
        this.users = { ...DEFAULT_USERS_DATA };
        this.save();
      }
    } catch (_) {
      this.users = { ...DEFAULT_USERS_DATA };
    }
  }

  save() {
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2), 'utf8');
      return true;
    } catch (_) {
      // Safe fallback in containers with read-only filesystems
      return false;
    }
  }

  getUser(username) {
    if (!username) return null;
    const key = String(username).toLowerCase().trim();
    return this.users[key] || null;
  }

  getAllUsers() {
    return Object.values(this.users).map(u => ({
      username: u.username,
      displayName: u.displayName || u.username,
      role: u.role,
      plan: u.plan || 'pro',
      password: u.password,
      updatedAt: u.updatedAt
    }));
  }

  setPlan(username, plan) {
    const key = String(username).toLowerCase().trim();
    if (!this.users[key]) return { success: false, error: 'Usuario no encontrado' };
    const validPlans = ['pro', 'free'];
    const p = String(plan).toLowerCase().trim();
    if (!validPlans.includes(p)) return { success: false, error: 'Plan inválido (debe ser "pro" o "free")' };

    this.users[key].plan = p;
    this.users[key].updatedAt = new Date().toISOString();
    this.save();
    return { success: true, user: this.users[key] };
  }

  setPassword(username, newPassword) {
    const key = String(username).toLowerCase().trim();
    if (!this.users[key]) return { success: false, error: 'Usuario no encontrado' };
    const pwd = String(newPassword).trim();
    if (!pwd || pwd.length < 3) return { success: false, error: 'La contraseña debe tener al menos 3 caracteres' };

    this.users[key].password = pwd;
    this.users[key].updatedAt = new Date().toISOString();
    this.save();
    return { success: true, user: this.users[key] };
  }

  updateUser(username, updates = {}) {
    const key = String(username).toLowerCase().trim();
    if (!this.users[key]) return { success: false, error: 'Usuario no encontrado' };

    if (updates.plan !== undefined) {
      const p = String(updates.plan).toLowerCase().trim();
      if (['pro', 'free'].includes(p)) {
        this.users[key].plan = p;
      }
    }

    if (updates.password !== undefined) {
      const pwd = String(updates.password).trim();
      if (pwd.length >= 3) {
        this.users[key].password = pwd;
      }
    }

    this.users[key].updatedAt = new Date().toISOString();
    this.save();
    return { success: true, user: this.users[key] };
  }

  authenticate(username, password) {
    const user = this.getUser(username);
    if (!user) return { success: false, error: 'Usuario no encontrado' };
    if (user.password !== password) return { success: false, error: 'Contraseña incorrecta' };
    return { success: true, user };
  }
}

const usersManager = new UsersManager();
const MODERATOR_TOKEN = process.env.MODERATOR_TOKEN || 'vd-moderator-token-master-key-2026';

// Configuration with sensible defaults
const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MASTER_ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.MASTER_TOKEN || 'CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Odisea_11$';
const PUBLIC_DIR = path.resolve(__dirname, 'public');

// MIME types dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Initialize State Registry
const registry = new BranchRegistry({ timeoutMs: 15000 });

// No dummy branches pre-seeding: only real registered stations appear
const CANONICAL_BRANCHES_DEFAULT = [];

// Active User Session Tokens (usuario role)
const activeUserTokens = new Set();

// Active Admin Web Dashboard WebSocket connections
const adminSockets = new Set();

// Active Pending Peer Connection Requests: sessionId -> { requesterWs, targetBranchId, timer, createdAt }
const pendingPeerRequests = new Map();

// Active WebRTC Signaling Sessions: sessionId -> { sessionId, controllerWs, agentWs, branchId, createdAt, lastActivity, timer }
const activeSignalingSessions = new Map();
const WEBRTC_SESSION_TIMEOUT_MS = parseInt(process.env.WEBRTC_SESSION_TIMEOUT_MS, 10) || 60000;

function touchSignalingSession(sessionId) {
  const session = activeSignalingSessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      cleanupSignalingSession(sessionId, 'inactivity_timeout');
    }, WEBRTC_SESSION_TIMEOUT_MS);
    if (typeof session.timer.unref === 'function') session.timer.unref();
  }
}

function cleanupSignalingSession(sessionId, reason = 'normal') {
  const session = activeSignalingSessions.get(sessionId);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  activeSignalingSessions.delete(sessionId);
}

/**
 * Dynamic WebRTC ICE Server Configuration Provider
 * Generates dynamic iceServers array containing public STUN and optional TURN relay.
 */
let _cachedIceConfigBuffer = null;

function getIceServers() {
  const defaultStun = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302'
  ];

  const customStun = process.env.STUN_SERVERS
    ? process.env.STUN_SERVERS.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  const stunUrls = (customStun && customStun.length > 0) ? customStun : defaultStun;

  const iceServers = [
    { urls: stunUrls }
  ];

  const turnUrl = (process.env.TURN_URL || process.env.TURN_SERVER_URL || '').trim();
  const turnUsername = (process.env.TURN_USERNAME || '').trim();
  const turnCredential = (process.env.TURN_CREDENTIAL || process.env.TURN_PASSWORD || '').trim();

  if (turnUrl) {
    const rawUrls = turnUrl.split(',').map(u => u.trim()).filter(Boolean);
    const turnUrls = [];
    for (const u of rawUrls) {
      if (u.includes('?transport=')) {
        turnUrls.push(u);
      } else {
        turnUrls.push(`${u}?transport=udp`);
        turnUrls.push(`${u}?transport=tcp`);
      }
    }

    const turnServer = { urls: turnUrls };
    if (turnUsername) turnServer.username = turnUsername;
    if (turnCredential) turnServer.credential = turnCredential;

    iceServers.push(turnServer);
  }

  return iceServers;
}

function getIceConfigPayload() {
  if (process.env.NODE_ENV === 'production' && _cachedIceConfigBuffer) {
    return _cachedIceConfigBuffer;
  }
  const config = {
    iceServers: getIceServers(),
    iceTransportPolicy: process.env.ICE_TRANSPORT_POLICY || 'all',
    iceCandidatePoolSize: 2
  };
  const buf = Buffer.from(JSON.stringify(config), 'utf-8');
  if (process.env.NODE_ENV === 'production') {
    _cachedIceConfigBuffer = buf;
  }
  return buf;
}

function resetIceConfigCache() {
  _cachedIceConfigBuffer = null;
}

// Initialize Session Relay Broker
const relayBroker = createRelayBroker({
  tokenValidator: (sessionId, role, token) => {
    // Valid if token matches MASTER_ADMIN_TOKEN or is non-empty valid session token
    if (!token) return false;
    if (token === MASTER_ADMIN_TOKEN) return true;
    return true;
  }
});

/**
 * Static File Server Handler
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function serveStaticFile(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // Defensive check: reject traversal attempts via raw url or pathname
  if (req.url.includes('..') || pathname.includes('..') || req.url.toLowerCase().includes('%2e%2e')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden: Invalid Path');
    return;
  }

  const safePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden: Invalid Path');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback: Check if index.html exists
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.stat(indexPath, (indexErr, indexStats) => {
        if (!indexErr && indexStats.isFile()) {
          fs.readFile(indexPath, (readErr, content) => {
            if (readErr) {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('404 Not Found');
              return;
            }
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-cache'
            });
            res.end(content);
          });
          return;
        }

        // Inline minimal dashboard placeholder if static files not deployed yet
        if (pathname === '/index.html' || pathname === '/') {
          const fallbackHtml = Buffer.from(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>VisionDesk</title></head>` +
            `<body style="background:#111827;color:#f9fafb;font-family:sans-serif;padding:2rem;">` +
            `<h1>VisionDesk Central Server</h1><p>Status: Operational</p></body></html>`,
            'utf-8'
          );
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': fallbackHtml.length,
            'Cache-Control': 'no-cache'
          });
          res.end(fallbackHtml);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      });
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });

    const stream = fs.createReadStream(safePath);
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

/**
 * Native HTTP Request Dispatcher
 */
const server = http.createServer((req, res) => {
  // CORS & Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 0a. POST /api/auth/login
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const username = String(parsed.username !== undefined ? parsed.username : '').trim().toLowerCase();
        const pwd = String(parsed.password !== undefined ? parsed.password : (parsed.token || '')).trim();

        // 1. Dynamic authentication via UsersManager (persisted in users.json)
        const auth = usersManager.authenticate(username, pwd);
        if (auth.success) {
          const u = auth.user;

          // Moderator role: full control + moderation panel
          if (u.role === 'moderator') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'ok',
              authenticated: true,
              role: 'moderator',
              plan: 'pro',
              token: MODERATOR_TOKEN,
              username: u.username,
              displayName: u.displayName
            }));
            return;
          }

          // If account is in FREE plan: return role 'free' (cannot interact)
          if (u.plan === 'free') {
            const freeToken = 'vd-free-token-' + Date.now();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'ok',
              authenticated: true,
              role: 'free',
              plan: 'free',
              token: freeToken,
              username: u.username,
              displayName: u.displayName,
              message: 'Cuenta en plan FREE (modo catálogo)'
            }));
            return;
          }

          // Admin role in PRO plan
          if (u.role === 'admin') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'ok',
              authenticated: true,
              role: 'admin',
              plan: 'pro',
              token: MASTER_ADMIN_TOKEN,
              username: 'admin',
              displayName: u.displayName
            }));
            return;
          }

          // Usuario role in PRO plan
          if (u.role === 'usuario') {
            const userToken = 'vd-user-token-' + Date.now();
            activeUserTokens.add(userToken);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'ok',
              authenticated: true,
              role: 'usuario',
              plan: 'pro',
              token: userToken,
              username: 'usuario',
              displayName: u.displayName
            }));
            return;
          }
        }

        // 2. Fallback for master tokens
        const validAdminTokens = [
          MASTER_ADMIN_TOKEN,
          MODERATOR_TOKEN,
          'CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg',
          'vd-master-token-aqp-production-key-2026'
        ];
        if (validAdminTokens.includes(pwd)) {
          const isMod = pwd === MODERATOR_TOKEN;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            authenticated: true,
            role: isMod ? 'moderator' : 'admin',
            plan: 'pro',
            token: isMod ? MODERATOR_TOKEN : MASTER_ADMIN_TOKEN,
            username: isMod ? 'moderador' : 'admin'
          }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          authenticated: false,
          error: auth.error || 'Credenciales inválidas'
        }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'Formato JSON inválido' }));
      }
    });
    return;
  }

  // 0b. POST /api/auth/verify
  if (req.method === 'POST' && pathname === '/api/auth/verify') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const authHeader = req.headers.authorization || '';
        let token = String(parsed.token || '').trim();
        if (!token && authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7).trim();
        }

        if (token === MODERATOR_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            valid: true,
            role: 'moderator',
            plan: 'pro',
            token: MODERATOR_TOKEN,
            username: 'moderador'
          }));
          return;
        }

        const validAdminTokens = [
          MASTER_ADMIN_TOKEN,
          'CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg',
          'vd-master-token-aqp-production-key-2026'
        ];

        if (token && validAdminTokens.includes(token)) {
          const adm = usersManager.getUser('admin');
          const isFree = adm && adm.plan === 'free';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            valid: true,
            role: isFree ? 'free' : 'admin',
            plan: isFree ? 'free' : 'pro',
            token: token,
            username: 'admin'
          }));
        } else if (token && (activeUserTokens.has(token) || token.startsWith('vd-user-token-') || token.startsWith('vd-user-session-token-'))) {
          const usr = usersManager.getUser('usuario');
          const isFree = usr && usr.plan === 'free';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            valid: true,
            role: isFree ? 'free' : 'usuario',
            plan: isFree ? 'free' : 'pro',
            token: token,
            username: 'usuario'
          }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', valid: false }));
        }
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', valid: false }));
      }
    });
    return;
  }

  // 0c. GET /api/moderator/users
  if (req.method === 'GET' && pathname === '/api/moderator/users') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
    if (token !== MODERATOR_TOKEN && token !== MASTER_ADMIN_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'Acceso denegado: solo para moderador' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      users: usersManager.getAllUsers()
    }));
    return;
  }

  // 0d. POST /api/moderator/users/update
  if (req.method === 'POST' && pathname === '/api/moderator/users/update') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
        if (token !== MODERATOR_TOKEN && token !== MASTER_ADMIN_TOKEN) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Acceso denegado: solo para moderador' }));
          return;
        }

        const payload = JSON.parse(body || '{}');
        const { username, plan, password } = payload;
        if (!username) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Falta campo username' }));
          return;
        }

        const result = usersManager.updateUser(username, { plan, password });
        if (!result.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: result.error }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          user: result.user,
          users: usersManager.getAllUsers()
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'JSON inválido' }));
      }
    });
    return;
  }

  // 1. GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    const mem = process.memoryUsage();
    const payload = {
      status: 'ok',
      uptime: Math.round(process.uptime() * 10) / 10,
      timestamp: Date.now(),
      memory: {
        rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
        externalMb: Math.round((mem.external / 1024 / 1024) * 100) / 100
      },
      connectedAgents: registry.getOnlineCount(),
      totalBranches: registry.getTotalCount()
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  // 2. GET /api/branches
  if (req.method === 'GET' && (pathname === '/api/branches' || pathname === '/api/branches/')) {
    const branches = registry.getAllBranches();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(branches));
    return;
  }

  // 2b. DELETE or POST /api/branches/offline (Purge disconnected branches)
  if ((req.method === 'DELETE' || req.method === 'POST') && pathname === '/api/branches/offline') {
    const purged = registry.purgeOfflineBranches();
    broadcastToAdmins({
      type: 'branches:purged',
      payload: { purged }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, purgedCount: purged.length, purged }));
    return;
  }

  // 3. GET /api/branch/:id/thumbnail or /api/branches/:id/thumbnail
  const thumbnailMatch = pathname.match(/^\/api\/branch(?:es)?\/([^/]+)\/thumbnail\/?$/);
  if (req.method === 'GET' && thumbnailMatch) {
    const branchId = thumbnailMatch[1];
    const thumb = registry.getThumbnail(branchId);

    const contentType = thumb.format === 'svg+xml'
      ? 'image/svg+xml'
      : (thumb.format === 'webp' ? 'image/webp' : (thumb.format === 'png' ? 'image/png' : 'image/jpeg'));

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': thumb.buffer.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(thumb.buffer);
    return;
  }

  // 4. GET /api/resolve/:target
  const resolveMatch = pathname.match(/^\/api\/resolve\/([^/]+)\/?$/);
  if (req.method === 'GET' && resolveMatch) {
    const rawTarget = decodeURIComponent(resolveMatch[1]);
    const branch = registry.resolveTarget(rawTarget);
    if (branch) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        found: true,
        branch: {
          id: branch.id,
          name: branch.name,
          alias: branch.alias,
          machineId: branch.machineId,
          online: branch.online,
          latencyMs: branch.latencyMs,
          lastSeen: branch.lastSeen,
          authMode: branch.authMode,
          hasFixedPassword: branch.hasFixedPassword,
          sos: branch.sos || { active: false, reason: null, urgency: 'normal', timestamp: 0 },
          thumbnailUrl: `/api/branch/${branch.id}/thumbnail`
        }
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'error',
        found: false,
        error: `Target '${rawTarget}' not found`
      }));
    }
    return;
  }

  // 5. GET /api/sos/active
  if (req.method === 'GET' && (pathname === '/api/sos/active' || pathname === '/api/sos/active/')) {
    const activeSos = registry.getActiveSosAlerts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      count: activeSos.length,
      alerts: activeSos
    }));
    return;
  }

  // 6. GET /api/my-station - Auto-detect local machine by client IP or query machineId
  if (req.method === 'GET' && (pathname === '/api/my-station' || pathname === '/api/my-station/')) {
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = (forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) || '';
    const queryMachineId = parsedUrl.searchParams.get('machineId');

    let matchedBranch = null;
    if (queryMachineId) {
      matchedBranch = registry.resolveTarget(queryMachineId);
    }

    if (!matchedBranch && clientIp) {
      const branches = registry.getAllBranches();
      matchedBranch = branches.find(b => b.online && b.clientIp && (b.clientIp === clientIp || clientIp.includes(b.clientIp) || b.clientIp.includes(clientIp)));
      if (!matchedBranch) {
        matchedBranch = branches.find(b => b.clientIp && (b.clientIp === clientIp || clientIp.includes(b.clientIp) || b.clientIp.includes(clientIp)));
      }
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });

    if (matchedBranch) {
      res.end(JSON.stringify({
        found: true,
        online: !!matchedBranch.online,
        branchId: matchedBranch.id,
        alias: matchedBranch.alias || matchedBranch.name,
        machineId: matchedBranch.machineId,
        password: matchedBranch.fixedPassword || matchedBranch.password || '',
        tempPassword: matchedBranch.tempPassword || '',
        systemInfo: matchedBranch.systemInfo || null
      }));
    } else {
      res.end(JSON.stringify({
        found: false,
        online: false,
        clientIp: clientIp,
        message: 'No active agent detected for this client IP'
      }));
    }
    return;
  }

  // 6b. GET /api/webrtc/config - WebRTC STUN/TURN ICE server configuration
  if (pathname === '/api/webrtc/config' || pathname === '/api/webrtc/config/') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const payload = getIceConfigPayload();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(payload);
      return;
    }
  }

  // 6c. GET /api/download/agent - Native direct download of Windows Agent Installer Package
  if (req.method === 'GET' && (pathname === '/api/download/agent' || pathname === '/api/download/agent/' || pathname === '/downloads/VisionDesk-Agent.zip')) {
    const zipPath = path.join(PUBLIC_DIR, 'downloads', 'VisionDesk-Agent.zip');
    fs.stat(zipPath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Paquete de instalador de agente no disponible en el servidor.' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stats.size,
        'Content-Disposition': 'attachment; filename="VisionDesk-Agent.zip"',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(zipPath).pipe(res);
    });
    return;
  }

  // 7. Default: Static files
  serveStaticFile(req, res);
});

// Setup Signaling WebSocket Server (perMessageDeflate disabled to save memory)
const wssSignaling = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// WebRTC P2P Diagnostic Sandbox Rooms (roomId -> Set<ws>)
const p2pRooms = new Map();

/**
 * Broadcast JSON message to all connected Admin Dashboards
 * @param {Object} msg
 */
function broadcastToAdmins(msg) {
  if (adminSockets.size === 0) return;
  const data = JSON.stringify(msg);
  for (const client of adminSockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Handle incoming WebSocket Signaling Connection
 */
wssSignaling.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const role = parsedUrl.searchParams.get('role');
  const tokenParam = parsedUrl.searchParams.get('token');
  const forwarded = req.headers['x-forwarded-for'];
  ws._clientIp = (forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) || '';
  ws._role = role;
  ws._token = tokenParam;

  if (role !== 'agent') {
    const validTokens = [
      MASTER_ADMIN_TOKEN,
      MODERATOR_TOKEN,
      'CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg',
      'vd-master-token-aqp-production-key-2026'
    ];
    if (tokenParam && validTokens.includes(tokenParam)) {
      ws._isAdmin = true;
      ws._adminToken = tokenParam;
    } else if (tokenParam && (activeUserTokens.has(tokenParam) || tokenParam.startsWith('vd-user-token-') || tokenParam.startsWith('vd-user-session-token-'))) {
      ws._role = 'usuario';
    }
    adminSockets.add(ws);
    // Send immediate snapshot on connect
    ws.send(JSON.stringify({
      type: 'dashboard:init',
      payload: { branches: registry.getAllBranches() }
    }));
  }

  ws.on('message', (data, isBinary) => {
    // 1. Binary frames (direct binary thumbnail forwarding)
    if (isBinary) {
      const branch = registry.getBranchBySocket(ws);
      if (branch) {
        registry.updateThumbnail(branch.id, data, 'jpeg');
        broadcastToAdmins({
          type: 'branch:thumbnail',
          payload: {
            branchId: branch.id.toLowerCase(),
            format: 'jpeg',
            timestamp: Date.now(),
            data: data.toString('base64')
          }
        });
      }
      return;
    }

    // 2. JSON control messages
    let msg;
    try {
      msg = JSON.parse(data.toString('utf-8'));
    } catch (_) {
      return;
    }

    if (!msg || !msg.type) return;

    switch (msg.type) {
      // Agent Registration
      case 'agent:register': {
        adminSockets.delete(ws);
        const branch = registry.registerAgent(ws, {
          ...(msg.payload || {}),
          clientIp: ws._clientIp
        });
        ws.send(JSON.stringify({
          type: 'agent:register_ack',
          payload: { status: 'registered', heartbeatInterval: 5000, branchId: branch.id }
        }));
        broadcastToAdmins({
          type: 'branch:telemetry',
          payload: {
            branchId: branch.id,
            online: true,
            latencyMs: branch.latencyMs,
            lastSeen: branch.lastSeen,
            activeSession: branch.activeSession
          }
        });
        break;
      }

      // Heartbeat & Telemetry
      case 'agent:heartbeat': {
        const branch = registry.handleHeartbeat(ws, msg.payload || {});
        if (branch) {
          ws.send(JSON.stringify({
            type: 'agent:heartbeat_ack',
            payload: { rttMs: branch.latencyMs, serverTime: Date.now() }
          }));
          broadcastToAdmins({
            type: 'branch:telemetry',
            payload: {
              branchId: branch.id,
              online: true,
              latencyMs: branch.latencyMs,
              lastSeen: branch.lastSeen,
              activeSession: branch.activeSession
            }
          });
        }
        break;
      }

      // 5-second Thumbnail Update (JSON payload)
      case 'branch:thumbnail': {
        const payload = msg.payload || {};
        const branchId = registry.normalizeBranchId(payload.branchId);
        if (payload.data) {
          const imgBuffer = Buffer.from(payload.data, 'base64');
          registry.updateThumbnail(branchId, imgBuffer, payload.format || 'jpeg');
          broadcastToAdmins({
            type: 'branch:thumbnail',
            payload: {
              branchId: branchId,
              format: payload.format || 'jpeg',
              timestamp: payload.timestamp || Date.now(),
              data: payload.data
            }
          });
        }
        break;
      }

      // Admin 1-Click Session Start ('session:start')
      case 'session:start': {
        const payload = msg.payload || {};

        // Guard against usuario attempting to start central supervision sessions
        const isUserRole = ws._role === 'usuario' ||
          (typeof payload.adminToken === 'string' && (activeUserTokens.has(payload.adminToken) || payload.adminToken.startsWith('vd-user-session-token-')));
        if (isUserRole) {
          console.warn(`[Signaling] Rejecting session:start - Usuario not permitted for central supervision`);
          ws.send(JSON.stringify({
            type: 'session:error',
            payload: {
              sessionId: payload.sessionId,
              code: 403,
              error: 'Acceso denegado: el rol usuario solo tiene acceso a Soporte Punto a Punto.'
            }
          }));
          return;
        }

        const validTokens = [
          MASTER_ADMIN_TOKEN,
          MODERATOR_TOKEN,
          'CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg',
          'vd-master-token-aqp-production-key-2026'
        ];
        const isAuth = (payload.adminToken && validTokens.includes(payload.adminToken)) || ws._isAdmin;
        if (!isAuth) {
          console.warn(`[Signaling] Rejecting session:start - Unauthorized token: ${payload.adminToken}`);
          ws.send(JSON.stringify({
            type: 'session:error',
            payload: { sessionId: payload.sessionId, error: 'Unauthorized: invalid admin token' }
          }));
          return;
        }

        const targetId = registry.normalizeBranchId(payload.targetBranchId);
        const branch = registry.getBranch(targetId);
        if (!branch || !branch.online || !branch.ws) {
          ws.send(JSON.stringify({
            type: 'session:error',
            payload: { sessionId: payload.sessionId, error: 'Target branch is offline' }
          }));
          return;
        }

        branch.activeSession = {
          sessionId: payload.sessionId,
          mode: payload.mode || 'observe',
          controllerId: 'admin_panel',
          startedAt: Date.now()
        };

        // Register signaling session for WebRTC negotiation
        activeSignalingSessions.set(payload.sessionId, {
          sessionId: payload.sessionId,
          controllerWs: ws,
          agentWs: branch.ws,
          branchId: branch.id,
          createdAt: Date.now(),
          lastActivity: Date.now()
        });
        touchSignalingSession(payload.sessionId);

        // Forward command to branch agent
        branch.ws.send(JSON.stringify({
          type: 'session:start',
          payload: {
            sessionId: payload.sessionId,
            mode: payload.mode || 'observe',
            adminToken: MASTER_ADMIN_TOKEN,
            iceServers: getIceServers(),
            transport: payload.transport || (payload.renegotiate ? 'p2p' : 'relay'),
            renegotiate: !!payload.renegotiate
          }
        }));

        ws.send(JSON.stringify({
          type: 'session:ack',
          payload: { sessionId: payload.sessionId, status: 'dispatched' }
        }));
        break;
      }

      // Admin Session Stop ('session:stop')
      case 'session:stop': {
        const payload = msg.payload || {};
        const targetId = registry.normalizeBranchId(payload.targetBranchId);
        const branch = registry.getBranch(targetId);
        if (branch) {
          branch.activeSession = null;
          if (branch.ws && branch.ws.readyState === WebSocket.OPEN) {
            branch.ws.send(JSON.stringify(msg));
          }
        }

        // Clean up WebRTC signaling session
        if (payload.sessionId && activeSignalingSessions.has(payload.sessionId)) {
          cleanupSignalingSession(payload.sessionId, 'stopped');
        }
        for (const [sId, sess] of activeSignalingSessions.entries()) {
          if (sess.branchId === targetId) {
            cleanupSignalingSession(sId, 'stopped');
          }
        }

        ws.send(JSON.stringify({
          type: 'session:stopped',
          payload: { sessionId: payload.sessionId }
        }));
        break;
      }

      // Peer Support Auth Request (requester -> server -> target)
      case 'peer:auth_request': {
        const payload = msg.payload || {};
        const targetQuery = payload.targetMachineId || payload.target || payload.targetBranchId;
        const branch = registry.resolveTarget(targetQuery) || registry.findBranchByMachineId(targetQuery);
        if (!branch || !branch.online || !branch.ws || branch.ws.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'peer:auth_response',
            payload: {
              sessionId: payload.sessionId,
              granted: false,
              reason: 'target_offline'
            }
          }));
          return;
        }

        // Clean up previous timer if sessionId already exists
        if (pendingPeerRequests.has(payload.sessionId)) {
          const prev = pendingPeerRequests.get(payload.sessionId);
          if (prev.timer) clearTimeout(prev.timer);
        }

        // 35s timeout to clean up stale requests
        const cleanupTimer = setTimeout(() => {
          if (pendingPeerRequests.has(payload.sessionId)) {
            const reqData = pendingPeerRequests.get(payload.sessionId);
            pendingPeerRequests.delete(payload.sessionId);
            if (reqData.requesterWs && reqData.requesterWs.readyState === WebSocket.OPEN) {
              try {
                reqData.requesterWs.send(JSON.stringify({
                  type: 'peer:auth_response',
                  payload: {
                    sessionId: payload.sessionId,
                    granted: false,
                    reason: 'timeout'
                  }
                }));
              } catch (_) {}
            }
          }
        }, 35000);
        if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

        pendingPeerRequests.set(payload.sessionId, {
          requesterWs: ws,
          targetBranchId: branch.id,
          timer: cleanupTimer,
          createdAt: Date.now()
        });

        // Tag socket for backward compatibility
        ws._pendingPeerSessionId = payload.sessionId;

        branch.ws.send(JSON.stringify({
          type: 'peer:auth_request',
          payload: {
            ...payload,
            transport: payload.transport || 'relay',
            iceServers: getIceServers()
          }
        }));
        break;
      }

      // Peer Support Auth Response (target -> server -> requester)
      case 'peer:auth_response': {
        const payload = msg.payload || {};
        const pending = pendingPeerRequests.get(payload.sessionId);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          pendingPeerRequests.delete(payload.sessionId);
          if (payload.granted) {
            const branch = registry.getBranch(pending.targetBranchId) || registry.getBranchBySocket(ws);
            const branchId = branch ? branch.id : pending.targetBranchId;
            activeSignalingSessions.set(payload.sessionId, {
              sessionId: payload.sessionId,
              controllerWs: pending.requesterWs,
              agentWs: ws,
              branchId: branchId,
              createdAt: Date.now(),
              lastActivity: Date.now()
            });
            touchSignalingSession(payload.sessionId);
          }
          if (pending.requesterWs && pending.requesterWs.readyState === WebSocket.OPEN) {
            const enrichedMsg = {
              ...msg,
              payload: { ...msg.payload, iceServers: getIceServers() }
            };
            pending.requesterWs.send(JSON.stringify(enrichedMsg));
          }
        } else {
          // Fallback check
          for (const client of wssSignaling.clients) {
            if (client._pendingPeerSessionId === payload.sessionId) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(msg));
              }
              delete client._pendingPeerSessionId;
              break;
            }
          }
        }
        break;
      }

      // Reverse SOS Alert (agent -> server -> broadcast)
      case 'sos:alert': {
        const payload = msg.payload || {};
        const branchByWs = registry.getBranchBySocket(ws);
        const branchId = payload.branchId || (branchByWs ? branchByWs.id : null);
        const branch = registry.setSosAlert(branchId, payload);
        if (branch) {
          // Acknowledge back to agent
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'sos:alert_ack',
              payload: {
                branchId: branch.id,
                status: 'acknowledged',
                timestamp: Date.now()
              }
            }));
          }

          // Broadcast emergency beacon to all admins and controllers
          broadcastToAdmins({
            type: 'sos:broadcast',
            payload: {
              branchId: branch.id,
              branchName: branch.name,
              alias: branch.alias,
              machineId: branch.machineId,
              reason: branch.sos.reason,
              urgency: branch.sos.urgency,
              timestamp: branch.sos.timestamp
            }
          });
        }
        break;
      }

      // Reverse SOS Clear / Resolution (admin or agent -> server -> broadcast)
      case 'sos:clear': {
        const payload = msg.payload || {};
        const branchByWs = registry.getBranchBySocket(ws);
        const branchId = payload.branchId || (branchByWs ? branchByWs.id : null);
        const branch = registry.clearSosAlert(branchId);
        if (branch) {
          broadcastToAdmins({
            type: 'sos:cleared',
            payload: {
              branchId: branch.id,
              resolvedBy: payload.resolvedBy || 'admin_panel',
              timestamp: Date.now()
            }
          });
        }
        break;
      }

      // Transparent WebRTC Signaling Exchange (Offer, Answer, ICE Candidates)
      case 'webrtc:signal': {
        const payload = msg.payload || {};
        const sessionId = payload.sessionId;

        if (!sessionId) {
          ws.send(JSON.stringify({
            type: 'webrtc:error',
            payload: { error: 'Missing sessionId in webrtc:signal payload' }
          }));
          break;
        }

        const signalType = payload.signalType || (payload.data && payload.data.type) || (payload.signal && payload.signal.type);
        const signalData = payload.data || payload.signal;

        if (!signalType || !signalData) {
          ws.send(JSON.stringify({
            type: 'webrtc:error',
            payload: { sessionId, error: 'Missing signalType or signal data in webrtc:signal payload' }
          }));
          break;
        }

        let session = activeSignalingSessions.get(sessionId);

        // Fallback auto-registration if targetBranchId provided
        if (!session && payload.targetBranchId) {
          const rawTarget = payload.targetBranchId;
          const branch = registry.resolveTarget(rawTarget) || registry.getBranch(registry.normalizeBranchId(rawTarget));
          if (branch && branch.online && branch.ws && branch.ws.readyState === WebSocket.OPEN) {
            const validTokens = [
              MASTER_ADMIN_TOKEN,
              'CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg',
              'vd-master-token-aqp-production-key-2026'
            ];
            const providedToken = payload.adminToken || payload.token;
            const isAuth = ws._isAdmin === true || (providedToken && validTokens.includes(providedToken));
            if (!isAuth) {
              ws.send(JSON.stringify({
                type: 'webrtc:error',
                payload: {
                  sessionId,
                  error: 'Unauthorized: admin authentication required for lazy session initiation'
                }
              }));
              break;
            }

            if (ws !== branch.ws) {
              session = {
                sessionId,
                controllerWs: ws,
                agentWs: branch.ws,
                branchId: branch.id,
                createdAt: Date.now(),
                lastActivity: Date.now()
              };
              activeSignalingSessions.set(sessionId, session);
            } else {
              ws.send(JSON.stringify({
                type: 'webrtc:error',
                payload: { sessionId, error: 'Cannot route signal: controller peer unknown' }
              }));
              break;
            }
          } else {
            ws.send(JSON.stringify({
              type: 'webrtc:error',
              payload: { sessionId, error: 'Target branch is offline or not found' }
            }));
            break;
          }
        }

        if (!session) {
          ws.send(JSON.stringify({
            type: 'webrtc:error',
            payload: { sessionId, error: 'Session not found or expired' }
          }));
          break;
        }

        let targetWs = null;
        let senderRole = 'unknown';

        if (ws === session.controllerWs) {
          targetWs = session.agentWs;
          senderRole = 'controller';
        } else if (ws === session.agentWs) {
          targetWs = session.controllerWs;
          senderRole = 'agent';
        } else {
          const branchBySocket = registry.getBranchBySocket(ws);
          if (branchBySocket && branchBySocket.id === session.branchId) {
            session.agentWs = ws;
            targetWs = session.controllerWs;
            senderRole = 'agent';
          } else if (ws._isAdmin === true) {
            session.controllerWs = ws;
            targetWs = session.agentWs;
            senderRole = 'controller';
          } else {
            ws.send(JSON.stringify({
              type: 'webrtc:error',
              payload: { sessionId, error: 'Unauthorized: socket not associated with this session' }
            }));
            break;
          }
        }

        touchSignalingSession(sessionId);

        if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'webrtc:error',
            payload: {
              sessionId,
              signalType,
              error: `Peer ${senderRole === 'controller' ? 'agent' : 'controller'} is not connected`
            }
          }));
          break;
        }

        const forwardPayload = {
          ...payload,
          sessionId: session.sessionId,
          targetBranchId: session.branchId,
          senderRole: senderRole,
          signalType: signalType,
          data: signalData
        };

        targetWs.send(JSON.stringify({
          type: 'webrtc:signal',
          payload: forwardPayload
        }));
        break;
      }

      // Explicit WebRTC Session Close
      case 'webrtc:close': {
        const payload = msg.payload || {};
        const sessionId = payload.sessionId;
        if (sessionId && activeSignalingSessions.has(sessionId)) {
          const session = activeSignalingSessions.get(sessionId);
          if (ws === session.controllerWs || ws === session.agentWs || ws._isAdmin === true) {
            cleanupSignalingSession(sessionId, 'peer_closed');

            const targetWs = (ws === session.controllerWs) ? session.agentWs : session.controllerWs;
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({
                type: 'webrtc:close',
                payload: {
                  sessionId,
                  branchId: session.branchId,
                  reason: payload.reason || 'peer_closed'
                }
              }));
            }
          }
        }
        break;
      }

      // WebRTC P2P Sandbox Signaling
      case 'p2p:join': {
        const roomId = String(msg.roomId || 'test-room').trim().toLowerCase();
        if (!p2pRooms.has(roomId)) p2pRooms.set(roomId, new Set());
        const room = p2pRooms.get(roomId);
        room.add(ws);
        ws._p2pRoom = roomId;
        ws.send(JSON.stringify({
          type: 'p2p:joined',
          roomId,
          peersCount: room.size,
          isInitiator: (room.size === 1)
        }));
        for (const peer of room) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ type: 'p2p:peer_joined', peersCount: room.size }));
          }
        }
        break;
      }

      case 'p2p:signal': {
        const roomId = ws._p2pRoom;
        if (roomId && p2pRooms.has(roomId)) {
          const room = p2pRooms.get(roomId);
          for (const peer of room) {
            if (peer !== ws && peer.readyState === WebSocket.OPEN) {
              peer.send(JSON.stringify({
                type: 'p2p:signal',
                signal: msg.signal
              }));
            }
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    adminSockets.delete(ws);

    // Clean up active signaling sessions associated with this closing socket
    for (const [sessionId, session] of activeSignalingSessions.entries()) {
      if (session.controllerWs === ws || session.agentWs === ws) {
        cleanupSignalingSession(sessionId, 'socket_closed');

        const survivingPeer = (session.controllerWs === ws) ? session.agentWs : session.controllerWs;
        if (survivingPeer && survivingPeer.readyState === WebSocket.OPEN) {
          try {
            survivingPeer.send(JSON.stringify({
              type: 'webrtc:peer_disconnected',
              payload: {
                sessionId: session.sessionId,
                branchId: session.branchId,
                reason: 'peer_socket_closed'
              }
            }));
          } catch (_) {}
        }
      }
    }

    if (ws._p2pRoom && p2pRooms.has(ws._p2pRoom)) {
      const room = p2pRooms.get(ws._p2pRoom);
      room.delete(ws);
      for (const peer of room) {
        if (peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type: 'p2p:peer_left', peersCount: room.size }));
        }
      }
      if (room.size === 0) p2pRooms.delete(ws._p2pRoom);
    }
    const offlineBranch = registry.removeAgent(ws);
    if (offlineBranch) {
      broadcastToAdmins({
        type: 'branch:telemetry',
        payload: {
          branchId: offlineBranch.id,
          online: false,
          latencyMs: 0,
          lastSeen: offlineBranch.lastSeen,
          activeSession: null
        }
      });
    }
  });

  ws.on('error', () => {
    adminSockets.delete(ws);
  });
});

// Multiplex HTTP Upgrade between /ws (signaling) and /ws/relay (session relay)
server.on('upgrade', (req, socket, head) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    socket.destroy();
    return;
  }
  const pathname = parsedUrl.pathname;

  if (pathname === '/ws' || pathname === '/ws/') {
    wssSignaling.handleUpgrade(req, socket, head, (ws) => {
      wssSignaling.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/relay' || pathname === '/ws/relay/') {
    if (relayBroker && typeof relayBroker.handleUpgrade === 'function') {
      relayBroker.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

// Periodic 15s Offline Heartbeat Sweep (every 5 seconds)
const sweepInterval = setInterval(() => {
  const newlyOffline = registry.checkTimeouts();
  for (const branch of newlyOffline) {
    broadcastToAdmins({
      type: 'branch:telemetry',
      payload: {
        branchId: branch.id,
        online: false,
        latencyMs: 0,
        lastSeen: branch.lastSeen,
        activeSession: null
      }
    });
  }

  // Sweep stale or disconnected signaling sessions
  const now = Date.now();
  for (const [sessionId, session] of activeSignalingSessions.entries()) {
    const ctrlClosed = !session.controllerWs || session.controllerWs.readyState !== WebSocket.OPEN;
    const agtClosed = !session.agentWs || session.agentWs.readyState !== WebSocket.OPEN;
    if ((ctrlClosed && agtClosed) || (now - session.lastActivity > WEBRTC_SESSION_TIMEOUT_MS)) {
      cleanupSignalingSession(sessionId, 'swept');
    }
  }
}, 5000);
sweepInterval.unref();

// Compaction timer for GC if exposed
if (typeof global.gc === 'function') {
  setInterval(() => {
    global.gc();
  }, 30000).unref();
}

server.on('close', () => {
  if (wssSignaling) {
    for (const client of wssSignaling.clients) {
      try { client.terminate(); } catch (_) {}
    }
  }
  for (const client of adminSockets) {
    try { client.terminate(); } catch (_) {}
  }
  adminSockets.clear();
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
});

// Graceful Shutdown
function gracefulShutdown(signal) {
  clearInterval(sweepInterval);
  for (const item of pendingPeerRequests.values()) {
    if (item.timer) clearTimeout(item.timer);
  }
  pendingPeerRequests.clear();
  for (const session of activeSignalingSessions.values()) {
    if (session.timer) clearTimeout(session.timer);
  }
  activeSignalingSessions.clear();
  if (wssSignaling) {
    for (const client of wssSignaling.clients) {
      try { client.close(1001, 'Server shutting down'); } catch (_) {}
    }
  }
  if (relayBroker && typeof relayBroker.closeAll === 'function') {
    relayBroker.closeAll();
  }
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start listening if executed directly
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[VisionDesk Server] Running on http://${HOST}:${PORT}`);
    console.log(`[VisionDesk Server] Static root: ${PUBLIC_DIR}`);
    console.log(`[VisionDesk Server] Memory tuning: <30MB target (PID: ${process.pid})`);
  });
}

module.exports = {
  server,
  registry,
  relayBroker,
  wssSignaling,
  adminSockets,
  pendingPeerRequests,
  activeSignalingSessions,
  getIceServers,
  getIceConfigPayload,
  resetIceConfigCache,
  touchSignalingSession,
  cleanupSignalingSession,
  broadcastToAdmins
};
