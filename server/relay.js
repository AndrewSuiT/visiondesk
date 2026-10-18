/**
 * VisionDesk - Central Session Relay Broker
 * File: server/relay.js
 *
 * High-throughput, zero-copy WebSocket relay endpoint mounted at /ws/relay.
 * Bidirectionally forwards binary streams (video, mouse, keyboard) and text frames
 * between Controller and Agent sessions while strictly bounding memory under 5 MB.
 */

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('node:url');
const EventEmitter = require('node:events');

// Pre-allocated frozen options to eliminate hot-path object allocations
const BINARY_OPTS = Object.freeze({ binary: true });
const TEXT_OPTS = Object.freeze({ binary: false });

// Operational thresholds
const DEFAULT_CONFIG = {
  pairingTimeoutMs: 30000,          // 30 seconds pairing window
  initTimeoutMs: 5000,              // 5 seconds waiting for relay:init if query params missing
  dropWatermark: 1024 * 1024,       // 1 MB: increased for ACK-based flow control
  pauseWatermark: 1024 * 1024,      // 1 MB: Pause source TCP socket
  criticalWatermark: 2.5 * 1024 * 1024, // 2.5 MB: Abort slow consumer
  maxSessions: 100,
};

/**
 * Encapsulates a paired Controller <-> Agent relay session.
 */
class RelaySession {
  constructor(sessionId, broker, options = {}) {
    this.sessionId = sessionId;
    this.broker = broker;
    this.options = { ...DEFAULT_CONFIG, ...options };

    this.controller = null;
    this.agent = null;
    this.mode = 'control'; // 'control' or 'observe'
    this.state = 'WAITING_PEER'; // WAITING_PEER, PAIRED_ACTIVE, CLOSED
    this.createdAt = Date.now();
    this.pairedAt = null;

    this.pairingTimer = null;
    this.isSourcePaused = false;

    // Real-time telemetry & metrics
    this.stats = {
      bytesRelayed: 0,
      framesForwarded: 0,
      droppedFrames: 0,
      blockedInputs: 0,
    };
  }

  /**
   * Start 30-second handshake countdown waiting for complementary peer.
   */
  startPairingTimer() {
    this.pairingTimer = setTimeout(() => {
      this.handlePairingTimeout();
    }, this.options.pairingTimeoutMs);
  }

  /**
   * Cancel pairing countdown when both peers are present.
   */
  clearPairingTimer() {
    if (this.pairingTimer) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = null;
    }
  }

  handlePairingTimeout() {
    this.pairingTimer = null;
    const timeoutMsg = JSON.stringify({
      type: 'relay:error',
      code: 'SESSION_TIMEOUT',
      message: 'Complementary peer did not connect within 30 seconds',
    });

    const activePeer = this.controller || this.agent;
    if (activePeer && activePeer.readyState === WebSocket.OPEN) {
      try {
        activePeer.send(timeoutMsg, TEXT_OPTS);
        activePeer.close(4008, 'Session timeout waiting for peer');
      } catch (_) {}
    }
    this.teardown(4008, 'Session pairing timeout');
  }

  /**
   * Attach a peer with role 'controller' or 'agent'.
   */
  attachPeer(role, ws, mode = 'control') {
    if (role === 'controller') {
      this.controller = ws;
      if (mode) this.mode = mode;
    } else if (role === 'agent') {
      this.agent = ws;
    }

    ws.sessionId = this.sessionId;
    ws.role = role;

    // If both peers are attached, transition to active
    if (this.controller && this.agent) {
      this.clearPairingTimer();
      this.state = 'PAIRED_ACTIVE';
      this.pairedAt = Date.now();

      // Notify both peers
      const readyMsg = JSON.stringify({
        type: 'relay:status',
        status: 'ready',
        sessionId: this.sessionId,
        mode: this.mode,
      });

      this.safeSend(this.controller, readyMsg, TEXT_OPTS);
      this.safeSend(this.agent, readyMsg, TEXT_OPTS);

      this.broker.emit('session_paired', {
        sessionId: this.sessionId,
        mode: this.mode,
      });
    } else {
      // First peer waiting
      this.state = 'WAITING_PEER';
      this.startPairingTimer();

      const waitMsg = JSON.stringify({
        type: 'relay:status',
        status: 'waiting_peer',
        sessionId: this.sessionId,
        role: role,
      });
      this.safeSend(ws, waitMsg, TEXT_OPTS);
    }
  }

  /**
   * Forward incoming packet to target peer with zero-copy and backpressure checks.
   */
  forwardPacket(srcRole, data, isBinary) {
    if (this.state !== 'PAIRED_ACTIVE') {
      return; // Cannot forward until paired
    }

    const isFromController = (srcRole === 'controller');
    const dstWs = isFromController ? this.agent : this.controller;
    const srcWs = isFromController ? this.controller : this.agent;

    if (!dstWs || dstWs.readyState !== WebSocket.OPEN) {
      return;
    }

    // 1. INPUT FIREWALL CHECK for 'observe' mode
    if (isFromController && isBinary && data.length > 0) {
      const opcode = data[0];
      if (opcode === 0x02 || opcode === 0x03) {
        if (this.mode === 'observe') {
          this.stats.blockedInputs++;
          return; // Drop input packet immediately!
        }
      }
    }

    // 2. TIER 3: CRITICAL BUFFER LIMIT (3.5 MB)
    if (dstWs.bufferedAmount > this.options.criticalWatermark) {
      this.teardown(4008, 'Slow consumer exceeded 3.5MB critical buffer limit');
      return;
    }

    // 3. TIER 2: TCP FLOW PAUSE (2.0 MB)
    if (dstWs.bufferedAmount > this.options.pauseWatermark && !this.isSourcePaused) {
      if (srcWs._socket && typeof srcWs._socket.pause === 'function') {
        srcWs._socket.pause();
        this.isSourcePaused = true;
        if (dstWs._socket) {
          dstWs._socket.once('drain', () => {
            if (srcWs._socket && this.isSourcePaused) {
              srcWs._socket.resume();
              this.isSourcePaused = false;
            }
          });
        }
      }
    }

    // 4. TIER 1: LOSS-TOLERANT VIDEO FRAME DROPPING (1.0 MB)
    // Video opcode 0x01 from Agent -> Controller
    if (!isFromController && isBinary && data.length > 0 && data[0] === 0x01) {
      if (dstWs.bufferedAmount > this.options.dropWatermark) {
        this.stats.droppedFrames++;
        return; // Drop stale video frame
      }
    }

    // 5. ZERO-COPY PASSTHROUGH
    try {
      dstWs.send(data, isBinary ? BINARY_OPTS : TEXT_OPTS);
      this.stats.bytesRelayed += data.length;
      this.stats.framesForwarded++;
    } catch (_) {
      this.teardown(1011, 'Socket write failure');
    }
  }

  safeSend(ws, data, opts) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data, opts);
      } catch (_) {}
    }
  }

  teardown(reasonCode = 1000, reasonText = 'Session closed') {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';

    this.clearPairingTimer();

    // Sanitize reasonCode against RFC 6455 reserved codes (1005, 1006, 1015) and invalid ranges
    const safeCode = (typeof reasonCode === 'number' && reasonCode >= 1000 && reasonCode <= 4999 && reasonCode !== 1005 && reasonCode !== 1006 && reasonCode !== 1015)
      ? reasonCode
      : 1000;

    const notifyFrame = JSON.stringify({
      type: 'relay:status',
      status: 'peer_disconnected',
      sessionId: this.sessionId,
      reason: reasonText,
    });

    [this.controller, this.agent].forEach((peer) => {
      if (peer) {
        try {
          if (peer.readyState === WebSocket.OPEN) {
            peer.send(notifyFrame, TEXT_OPTS);
            peer.close(safeCode, reasonText);
          }
        } catch (_) {}
      }
    });

    this.controller = null;
    this.agent = null;

    this.broker.sessions.delete(this.sessionId);
    this.broker.emit('session_closed', {
      sessionId: this.sessionId,
      stats: this.stats,
      reason: reasonText,
    });
  }
}

/**
 * Session Relay Broker manages /ws/relay endpoint, sessions map,
 * parameter validation, and connection upgrades.
 */
class SessionRelayBroker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_CONFIG, ...options };
    this.sessions = new Map();

    // Create standalone WebSocketServer with noServer: true for manual HTTP upgrade handling
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 8 * 1024 * 1024, // 8 MB frame max
      perMessageDeflate: false,    // Disabled to eliminate memory & CPU compression overhead
    });

    this.setupWssEvents();
  }

  /**
   * Handle incoming HTTP Upgrade at /ws/relay.
   */
  handleUpgrade(request, socket, head) {
    let parsedUrl;
    try {
      parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch (_) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const sessionId = parsedUrl.searchParams.get('sessionId');
    const role = parsedUrl.searchParams.get('role');
    const token = parsedUrl.searchParams.get('token');
    const mode = parsedUrl.searchParams.get('mode') || 'control';

    // If query parameters are present, validate immediately
    if (sessionId && role) {
      if (role !== 'controller' && role !== 'agent') {
        socket.write('HTTP/1.1 400 Bad Request: Invalid Role\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!this.validateToken(sessionId, role, token)) {
        socket.write('HTTP/1.1 401 Unauthorized: Invalid Token\r\n\r\n');
        socket.destroy();
        return;
      }

      // Check for role collision before completing upgrade
      const existingSession = this.sessions.get(sessionId);
      if (existingSession) {
        if ((role === 'controller' && existingSession.controller) ||
            (role === 'agent' && existingSession.agent)) {
          socket.write('HTTP/1.1 409 Conflict: Role Already Connected\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // Upgrade socket
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.initializeConnectedSocket(ws, { sessionId, role, mode, token });
      });
      return;
    }

    // If query params are missing, allow connection but enforce 5s relay:init timeout
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.waitForInitMessage(ws);
    });
  }

  /**
   * Token validator callback hook
   */
  validateToken(sessionId, role, token) {
    if (typeof this.options.tokenValidator === 'function') {
      return this.options.tokenValidator(sessionId, role, token);
    }
    // Default: allow if validator is not explicitly set
    return true;
  }

  /**
   * Fallback: Wait up to 5s for initial JSON 'relay:init' message.
   */
  waitForInitMessage(ws) {
    const initTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4002, 'Handshake timeout: Missing relay:init');
      }
    }, this.options.initTimeoutMs);

    ws.once('message', (data, isBinary) => {
      clearTimeout(initTimer);
      if (isBinary) {
        ws.close(4002, 'Expected text JSON relay:init');
        return;
      }

      try {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type !== 'relay:init' || !msg.sessionId || !msg.role) {
          ws.close(4002, 'Malformed relay:init');
          return;
        }

        if (msg.role !== 'controller' && msg.role !== 'agent') {
          ws.close(4002, 'Invalid role');
          return;
        }

        if (!this.validateToken(msg.sessionId, msg.role, msg.token)) {
          ws.close(4001, 'Unauthorized');
          return;
        }

        this.initializeConnectedSocket(ws, {
          sessionId: msg.sessionId,
          role: msg.role,
          mode: msg.mode || 'control',
          token: msg.token,
        });
      } catch (_) {
        ws.close(4002, 'JSON parse error on relay:init');
      }
    });
  }

  /**
   * Bind WebSocket to a RelaySession instance and wire event handlers.
   */
  initializeConnectedSocket(ws, { sessionId, role, mode }) {
    let session = this.sessions.get(sessionId);

    if (!session) {
      if (this.sessions.size >= this.options.maxSessions) {
        ws.close(1013, 'Server session capacity reached');
        return;
      }
      session = new RelaySession(sessionId, this, this.options);
      this.sessions.set(sessionId, session);
    }

    session.attachPeer(role, ws, mode);

    // Fast-path message listener
    ws.on('message', (data, isBinary) => {
      session.forwardPacket(role, data, isBinary);
    });

    ws.on('close', (code, reason) => {
      const reasonStr = typeof reason === 'string' ? reason : (reason ? reason.toString() : '');
      session.teardown(code, `Peer ${role} closed: ${reasonStr || 'normal'}`);
    });

    ws.on('error', (err) => {
      session.teardown(1011, `Peer ${role} socket error: ${err.message}`);
    });
  }

  setupWssEvents() {
    this.wss.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * Terminate a session by ID (e.g. from admin panel session:stop).
   */
  terminateSession(sessionId, reason = 'Terminated by server') {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.teardown(1000, reason);
      return true;
    }
    return false;
  }

  /**
   * Query status of an active session.
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      state: session.state,
      mode: session.mode,
      createdAt: session.createdAt,
      pairedAt: session.pairedAt,
      hasController: Boolean(session.controller),
      hasAgent: Boolean(session.agent),
      stats: { ...session.stats },
    };
  }

  /**
   * Gracefully close all relay sessions.
   */
  closeAll() {
    for (const session of this.sessions.values()) {
      session.teardown(1001, 'Server shutting down');
    }
    this.sessions.clear();
  }
}

/**
 * Factory helper function to mount the broker.
 */
function createRelayBroker(options = {}) {
  return new SessionRelayBroker(options);
}

module.exports = {
  SessionRelayBroker,
  RelaySession,
  createRelayBroker,
  DEFAULT_CONFIG,
};
