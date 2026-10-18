/**
 * VisionDesk - In-Memory Branch & Station Registry
 * File: server/registry.js
 *
 * Ultra-lightweight registry for 6 Arequipa branches with zero memory leaks.
 * Tracks presence, telemetry, RTT latency, cached thumbnails, and machine ID mappings.
 */

'use strict';

// Dynamic Branches Registry (Pre-seeded templates disabled)
const CANONICAL_BRANCHES = [];

// Offline SVG placeholder (rendered when no thumbnail is available)
const PLACEHOLDER_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
  `<rect width="640" height="360" fill="#111827"/>` +
  `<circle cx="320" cy="160" r="40" fill="#1f2937" stroke="#374151" stroke-width="2"/>` +
  `<path d="M305 160h30M320 145v30" stroke="#6b7280" stroke-width="3" stroke-linecap="round"/>` +
  `<text x="320" y="235" fill="#9ca3af" font-family="system-ui, sans-serif" font-size="16" font-weight="600" text-anchor="middle">SIN SEÑAL / EN ESPERA</text>` +
  `<text x="320" y="260" fill="#4b5563" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">Esperando transmisión de miniatura</text>` +
  `</svg>`,
  'utf-8'
);

class BranchRegistry {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 15000; // 15 seconds offline timeout
    this.branches = new Map();
    this.machineIdToBranch = new Map();
    this.aliasToBranch = new Map();
    this.wsToBranch = new Map();

    this._initializeBranches();
  }

  /**
   * Pre-seed the 6 Arequipa branches
   * @private
   */
  _initializeBranches() {
    for (const item of CANONICAL_BRANCHES) {
      if (item.alias) {
        const cleanAlias = item.alias.toLowerCase().trim().replace(/[\s_]+/g, '-');
        this.aliasToBranch.set(cleanAlias, item.id);
        this.aliasToBranch.set(item.alias.toLowerCase().trim(), item.id);
      }
      this.branches.set(item.id, {
        id: item.id,
        name: item.name,
        alias: item.alias,
        online: false,
        machineId: null,
        authMode: 'both',
        hasFixedPassword: false,
        systemInfo: null,
        latencyMs: 0,
        lastSeen: null,
        activeSession: null,
        sos: {
          active: false,
          reason: null,
          urgency: 'normal',
          timestamp: 0
        },
        thumbnail: {
          buffer: null,
          format: 'jpeg',
          timestamp: 0
        },
        ws: null
      });
    }
  }

  /**
   * Normalizes branch ID strings (e.g. 'arequipa-cayma' -> 'cayma', 'cerro_colorado' -> 'cerro-colorado')
   * @param {string} branchId
   * @returns {string}
   */
  normalizeBranchId(branchId) {
    if (!branchId || typeof branchId !== 'string') return '';
    let clean = branchId.trim().toLowerCase();
    if (clean.startsWith('arequipa-')) {
      clean = clean.replace('arequipa-', '');
    }
    if (clean.startsWith('aqp-')) {
      clean = clean.replace('aqp-', '');
    }
    clean = clean.replace(/_/g, '-');
    if (clean === 'jlbr' || clean === 'jl-bustamante' || clean === 'bustamante-y-rivero') {
      clean = 'bustamante';
    }
    if (clean === 'centro-historico') {
      clean = 'centro';
    }
    return clean;
  }

  /**
   * Register or update an agent connection
   * @param {WebSocket} ws
   * @param {Object} payload
   * @returns {Object}
   */
  registerAgent(ws, payload) {
    const branchId = this.normalizeBranchId(payload.branchId);
    let branch = this.branches.get(branchId);

    const rawMachineId = payload.machineId ? String(payload.machineId).replace(/\s+/g, '') : null;
    if (rawMachineId && this.machineIdToBranch.has(rawMachineId)) {
      const oldBranchId = this.machineIdToBranch.get(rawMachineId);
      if (oldBranchId && oldBranchId !== branchId) {
        // La misma PC física cambió de branchId en el instalador: limpiar la sucursal huérfana anterior
        const oldBranch = this.branches.get(oldBranchId);
        if (oldBranch) {
          if (oldBranch.ws && oldBranch.ws !== ws) {
            try { oldBranch.ws.close(1000, 'Replaced by new branch ID'); } catch (_) {}
            this.wsToBranch.delete(oldBranch.ws);
          }
          this.branches.delete(oldBranchId);
        }
        this.machineIdToBranch.delete(rawMachineId);
      }
    }

    if (!branch) {
      // Dynamic fallback if unknown branch
      branch = {
        id: branchId,
        name: payload.branchName || branchId,
        alias: payload.alias || branchId.toUpperCase(),
        online: true,
        machineId: null,
        authMode: payload.authMode || 'both',
        hasFixedPassword: !!payload.hasFixedPassword,
        systemInfo: payload.systemInfo || null,
        latencyMs: 10,
        lastSeen: Date.now(),
        activeSession: null,
        sos: { active: false, reason: null, urgency: 'normal', timestamp: 0 },
        thumbnail: { buffer: null, format: 'jpeg', timestamp: 0 },
        ws: ws
      };
      this.branches.set(branchId, branch);
    }

    // Clean up previous socket if reconnected
    if (branch.ws && branch.ws !== ws) {
      this.wsToBranch.delete(branch.ws);
      try { branch.ws.close(1000, 'Replaced by new connection'); } catch (_) {}
    }

    branch.online = true;
    branch.ws = ws;
    branch.lastSeen = Date.now();
    if (payload.branchName) branch.name = payload.branchName;
    if (payload.machineId) branch.machineId = String(payload.machineId).replace(/\s+/g, '');
    if (payload.alias) {
      branch.alias = payload.alias;
      const cleanAlias = payload.alias.toLowerCase().trim().replace(/[\s_]+/g, '-');
      this.aliasToBranch.set(cleanAlias, branch.id);
      this.aliasToBranch.set(payload.alias.toLowerCase().trim(), branch.id);
    }
    if (payload.authMode) branch.authMode = payload.authMode;
    if (typeof payload.hasFixedPassword === 'boolean') branch.hasFixedPassword = payload.hasFixedPassword;
    if (payload.clientIp) branch.clientIp = payload.clientIp;
    if (payload.fixedPassword) branch.fixedPassword = payload.fixedPassword;
    if (payload.password) branch.fixedPassword = payload.password;
    if (payload.tempPassword) branch.tempPassword = payload.tempPassword;
    if (payload.systemInfo) branch.systemInfo = payload.systemInfo;
    if (!branch.sos) {
      branch.sos = { active: false, reason: null, urgency: 'normal', timestamp: 0 };
    }

    // Update index maps
    this.wsToBranch.set(ws, branchId);
    if (branch.machineId) {
      this.machineIdToBranch.set(branch.machineId, branchId);
    }

    return branch;
  }

  /**
   * Record heartbeat from agent
   * @param {WebSocket} ws
   * @param {Object} payload
   * @returns {Object|null}
   */
  handleHeartbeat(ws, payload = {}) {
    const branchId = this.wsToBranch.get(ws) || this.normalizeBranchId(payload.branchId);
    const branch = this.branches.get(branchId);
    if (!branch) return null;

    const now = Date.now();
    branch.lastSeen = now;
    branch.online = true;

    const clientTs = payload.timestamp || payload.clientTimestamp;
    if (clientTs && typeof clientTs === 'number') {
      branch.latencyMs = Math.max(1, Math.min(9999, now - clientTs));
    }

    return branch;
  }

  /**
   * Update cached thumbnail buffer for a branch
   * @param {string} branchId
   * @param {Buffer} buffer
   * @param {string} format
   * @returns {boolean}
   */
  updateThumbnail(branchId, buffer, format = 'jpeg') {
    const cleanId = this.normalizeBranchId(branchId);
    const branch = this.branches.get(cleanId);
    if (!branch || !Buffer.isBuffer(buffer)) return false;

    branch.thumbnail.buffer = buffer;
    branch.thumbnail.format = format;
    branch.thumbnail.timestamp = Date.now();
    return true;
  }

  /**
   * Retrieve cached thumbnail for HTTP REST serving
   * @param {string} branchId
   * @returns {{ buffer: Buffer, format: string, isPlaceholder: boolean }}
   */
  getThumbnail(branchId) {
    const cleanId = this.normalizeBranchId(branchId);
    const branch = this.branches.get(cleanId);
    if (branch && branch.thumbnail.buffer) {
      return {
        buffer: branch.thumbnail.buffer,
        format: branch.thumbnail.format,
        isPlaceholder: false
      };
    }
    return {
      buffer: PLACEHOLDER_SVG,
      format: 'svg+xml',
      isPlaceholder: true
    };
  }

  /**
   * Find branch by 9-digit machineId
   * @param {string} machineId
   * @returns {Object|null}
   */
  findBranchByMachineId(machineId) {
    if (!machineId) return null;
    const cleanId = String(machineId).replace(/\D/g, '');
    const branchId = this.machineIdToBranch.get(cleanId);
    if (branchId) {
      const b = this.branches.get(branchId);
      if (b) return b;
    }
    return this.resolveTarget(String(machineId));
  }

  /**
   * Unified target resolution supporting 9-digit ID, canonical branchId, alias, and fuzzy match
   * @param {string} query
   * @returns {Object|null}
   */
  resolveTarget(query) {
    if (!query || typeof query !== 'string') return null;
    const trimmed = query.trim();
    if (!trimmed) return null;

    // 1. Check if 9-digit Machine ID (ignoring spaces and dashes)
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (digitsOnly.length === 9) {
      const branchId = this.machineIdToBranch.get(digitsOnly);
      if (branchId) {
        const b = this.branches.get(branchId);
        if (b) return b;
      }
    }

    // 2. Check canonical branch ID normalization
    const cleanBranchId = this.normalizeBranchId(trimmed);
    if (cleanBranchId && this.branches.has(cleanBranchId)) {
      return this.branches.get(cleanBranchId);
    }

    // 3. Check alias map (case-insensitive, normalized spaces/dashes)
    const lowerTrimmed = trimmed.toLowerCase();
    const cleanAlias = lowerTrimmed.replace(/[\s_]+/g, '-');
    const byAlias = this.aliasToBranch.get(cleanAlias) || this.aliasToBranch.get(lowerTrimmed);
    if (byAlias) {
      const b = this.branches.get(byAlias);
      if (b) return b;
    }

    // 4. Case-insensitive / fuzzy match against branch alias, name, or stored machineId
    for (const branch of this.branches.values()) {
      if (branch.alias && (branch.alias.toLowerCase() === lowerTrimmed || branch.alias.toLowerCase().replace(/[\s_]+/g, '-') === cleanAlias)) {
        return branch;
      }
      if (branch.name && branch.name.toLowerCase() === lowerTrimmed) {
        return branch;
      }
      if (branch.machineId && digitsOnly.length > 0 && branch.machineId === digitsOnly) {
        return branch;
      }
    }

    return null;
  }

  /**
   * Retrieve branch by WebSocket socket reference
   * @param {WebSocket} ws
   * @returns {Object|null}
   */
  getBranchBySocket(ws) {
    const branchId = this.wsToBranch.get(ws);
    return branchId ? this.branches.get(branchId) || null : null;
  }

  /**
   * Retrieve branch by ID
   * @param {string} branchId
   * @returns {Object|null}
   */
  getBranch(branchId) {
    const cleanId = this.normalizeBranchId(branchId);
    return this.branches.get(cleanId) || null;
  }

  /**
   * Handle socket disconnection
   * @param {WebSocket} ws
   * @returns {Object|null}
   */
  removeAgent(ws) {
    const branchId = this.wsToBranch.get(ws);
    if (!branchId) return null;

    this.wsToBranch.delete(ws);
    const branch = this.branches.get(branchId);
    if (branch && branch.ws === ws) {
      branch.online = false;
      branch.latencyMs = 0;
      branch.ws = null;
      branch.activeSession = null;
      return branch;
    }
    return null;
  }

  /**
   * Check for timed out agents (missing heartbeats > timeoutMs)
   * @returns {Array<Object>} List of newly offline branches
   */
  checkTimeouts() {
    const now = Date.now();
    const offlineList = [];

    for (const branch of this.branches.values()) {
      if (branch.online) {
        const timeSinceLast = branch.lastSeen ? (now - branch.lastSeen) : Infinity;
        if (timeSinceLast > this.timeoutMs) {
          branch.online = false;
          branch.latencyMs = 0;
          branch.activeSession = null;
          if (branch.ws) {
            this.wsToBranch.delete(branch.ws);
            try { branch.ws.close(4008, 'Heartbeat timeout'); } catch (_) {}
            branch.ws = null;
          }
          offlineList.push(branch);
        }
      }
    }

    return offlineList;
  }

  /**
   * Set SOS Alert state for a branch
   * @param {string} branchId
   * @param {Object} alertData
   * @returns {Object|null}
   */
  setSosAlert(branchId, alertData = {}) {
    if (!branchId) return null;
    const cleanId = this.normalizeBranchId(branchId);
    const branch = this.branches.get(cleanId) || this.resolveTarget(branchId);
    if (!branch) return null;

    branch.sos = {
      active: true,
      reason: alertData.reason || 'Alerta de emergencia SOS',
      urgency: alertData.urgency || 'high',
      timestamp: alertData.timestamp || Date.now()
    };
    return branch;
  }

  /**
   * Clear SOS Alert state for a branch
   * @param {string} branchId
   * @returns {Object|null}
   */
  clearSosAlert(branchId) {
    if (!branchId) return null;
    const cleanId = this.normalizeBranchId(branchId);
    const branch = this.branches.get(cleanId) || this.resolveTarget(branchId);
    if (!branch) return null;

    branch.sos = {
      active: false,
      reason: null,
      urgency: 'normal',
      timestamp: 0
    };
    return branch;
  }

  /**
   * Retrieve all currently active SOS alerts
   * @returns {Array<Object>}
   */
  getActiveSosAlerts() {
    const list = [];
    for (const b of this.branches.values()) {
      if (b.sos && b.sos.active) {
        list.push({
          branchId: b.id,
          branchName: b.name,
          alias: b.alias,
          machineId: b.machineId,
          reason: b.sos.reason,
          urgency: b.sos.urgency,
          timestamp: b.sos.timestamp
        });
      }
    }
    return list;
  }

  /**
   * Get all branches formatted for public REST & Dashboard consumers
   * @returns {Array<Object>}
   */
  getAllBranches() {
    const result = [];
    for (const b of this.branches.values()) {
      result.push({
        id: b.id,
        name: b.name,
        alias: b.alias,
        online: b.online,
        latencyMs: b.latencyMs,
        lastSeen: b.lastSeen,
        machineId: b.machineId,
        authMode: b.authMode,
        hasFixedPassword: b.hasFixedPassword,
        systemInfo: b.systemInfo,
        sos: b.sos || { active: false, reason: null, urgency: 'normal', timestamp: 0 },
        thumbnailTimestamp: b.thumbnail.timestamp,
        thumbnailUrl: `/api/branch/${b.id}/thumbnail`,
        activeSession: b.activeSession
      });
    }
    return result;
  }

  /**
   * Number of online agents
   * @returns {number}
   */
  getOnlineCount() {
    let count = 0;
    for (const b of this.branches.values()) {
      if (b.online) count++;
    }
    return count;
  }

  /**
   * Purge all branches that are currently offline
   * @returns {string[]} IDs of purged branches
   */
  purgeOfflineBranches() {
    const purged = [];
    for (const [id, b] of this.branches.entries()) {
      if (!b.online) {
        purged.push(id);
        this.branches.delete(id);
        if (b.machineId) this.machineIdToBranch.delete(b.machineId);
      }
    }
    return purged;
  }

  /**
   * Total registered branches
   * @returns {number}
   */
  getTotalCount() {
    return this.branches.size;
  }
}

module.exports = {
  BranchRegistry,
  CANONICAL_BRANCHES,
  PLACEHOLDER_SVG
};
