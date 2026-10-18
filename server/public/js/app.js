/**
 * VisionDesk - Central Web Admin Dashboard SPA Controller
 * File: server/public/js/app.js
 *
 * Real-time client state management, signaling integration, double-buffered
 * thumbnail rendering, Veyon passive observation, and RustDesk interactive control.
 * Zero external dependencies. High performance vanilla ES2022+.
 */

'use strict';

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
  MASTER_ADMIN_TOKEN: 'CAhXJFz6HUSC1K8KqPsZ7mKk2QkGHxraVkUOJ0hUeBg',
  RECONNECT: {
    INITIAL_DELAY_MS: 1000,
    MAX_DELAY_MS: 15000,
    BACKOFF_FACTOR: 1.5,
    JITTER_MIN: 0.8,
    JITTER_MAX: 1.2,
  },
  REST_FALLBACK_INTERVAL_MS: 5000,
  LATENCY_THRESHOLDS: {
    GOOD: 50,    // < 50ms: Emerald green
    WARN: 150,   // 50 - 150ms: Amber
    // > 150ms: Red
  },
  CANONICAL_BRANCHES: [],
};

// ============================================================================
// 1b. AUTHENTICATION MANAGER & ACCESS GATE (Multi-Role: admin | usuario | free)
// ============================================================================
const AuthManager = {
  TOKEN_KEY: 'vd_admin_token',

  getToken() {
    try {
      if (typeof sessionStorage !== 'undefined') {
        const token = sessionStorage.getItem(this.TOKEN_KEY) ||
                      localStorage.getItem(this.TOKEN_KEY) ||
                      sessionStorage.getItem('vd_auth_token') ||
                      localStorage.getItem('vd_auth_token');
        return token || null;
      }
    } catch (_) {}
    return null;
  },

  getRole() {
    const token = this.getToken();
    if (!token) return 'free';
    try {
      if (typeof sessionStorage !== 'undefined') {
        const storedRole = sessionStorage.getItem('vd_auth_role') || localStorage.getItem('vd_auth_role');
        if (storedRole === 'admin' || storedRole === 'usuario' || storedRole === 'moderator') return storedRole;
      }
    } catch (_) {}
    if (token === CONFIG.MASTER_ADMIN_TOKEN || token === 'vd-master-token-aqp-production-key-2026') {
      return 'admin';
    }
    if (token.startsWith('vd-user-session-token-')) {
      return 'usuario';
    }
    return 'admin';
  },

  getUsername() {
    try {
      if (typeof sessionStorage !== 'undefined') {
        return sessionStorage.getItem('vd_auth_user') ||
               localStorage.getItem('vd_auth_user') ||
               (this.getRole() === 'usuario' ? 'usuario' : (this.getRole() === 'moderator' ? 'moderador' : 'admin'));
      }
    } catch (_) {}
    return this.getRole() === 'usuario' ? 'usuario' : (this.getRole() === 'moderator' ? 'moderador' : 'admin');
  },

  isAdmin() {
    const role = this.getRole();
    return role === 'admin' || role === 'moderator';
  },

  isUser() {
    return this.getRole() === 'usuario';
  },

  isModerator() {
    return this.getRole() === 'moderator';
  },

  isFree() {
    return this.getRole() === 'free' || !this.isAuthenticated();
  },

  isAuthenticated() {
    const role = this.getRole();
    return role === 'admin' || role === 'usuario' || role === 'moderator';
  },

  setToken(token, role = 'admin', username = 'admin') {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(this.TOKEN_KEY, token);
        localStorage.setItem(this.TOKEN_KEY, token);
        sessionStorage.setItem('vd_auth_token', token);
        localStorage.setItem('vd_auth_token', token);
        sessionStorage.setItem('vd_auth_role', role);
        localStorage.setItem('vd_auth_role', role);
        sessionStorage.setItem('vd_auth_user', username);
        localStorage.setItem('vd_auth_user', username);
      }
    } catch (_) {}
    this.updateUI();
  },

  clearToken() {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.TOKEN_KEY);
        sessionStorage.removeItem('vd_auth_token');
        localStorage.removeItem('vd_auth_token');
        sessionStorage.removeItem('vd_auth_role');
        localStorage.removeItem('vd_auth_role');
        sessionStorage.removeItem('vd_auth_user');
        localStorage.removeItem('vd_auth_user');
      }
    } catch (_) {}
    this.updateUI();
  },

  logout() {
    this.clearToken();
  },

  async login(usernameOrPassword, password) {
    let username = 'admin';
    let pwd = '';
    if (password === undefined) {
      pwd = String(usernameOrPassword || '').trim();
    } else {
      username = String(usernameOrPassword || '').trim().toLowerCase();
      pwd = String(password || '').trim();
    }

    try {
      const loginUrl = (typeof window !== 'undefined' && window.location && window.location.host)
        ? `${window.location.protocol || 'http:'}//${window.location.host}/api/auth/login`
        : '/api/auth/login';
      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pwd })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.token) {
          this.setToken(data.token, data.role || (username === 'usuario' ? 'usuario' : 'admin'), data.username || username);
          return { success: true, token: data.token, role: data.role || 'admin', username: data.username || username };
        }
      }
      const errData = await res.json().catch(() => ({}));
      return { success: false, error: errData.error || 'Credenciales incorrectas' };
    } catch (_) {
      return { success: false, error: 'No se pudo contactar al servidor' };
    }
  },

  promptLogin(customHint = null) {
    const dialog = document.getElementById('admin-login-dialog');
    const userInput = document.getElementById('login-username-input');
    const input = document.getElementById('admin-password-input');
    const errBox = document.getElementById('login-error-msg');
    if (!dialog) return;

    if (errBox) {
      if (customHint) {
        errBox.classList.remove('hidden');
        errBox.textContent = `ℹ️ ${customHint}`;
      } else {
        errBox.classList.add('hidden');
      }
    }
    if (input) input.value = '';
    if (userInput) userInput.value = '';

    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
    } else {
      dialog.setAttribute('open', '');
    }
    setTimeout(() => {
      if (userInput) userInput.focus();
      else if (input) input.focus();
    }, 80);
  },

  closeLogin() {
    const dialog = document.getElementById('admin-login-dialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      try { dialog.close(); } catch (_) { dialog.removeAttribute('open'); }
    } else {
      dialog.removeAttribute('open');
    }
  },

  showProModal() {
    const proModal = document.getElementById('pro-purchase-modal');
    if (!proModal) {
      alert('Compra la versión PRO. Contacta con este número 904625262 o al correo atp1847@gmail.com');
      return;
    }
    if (typeof proModal.showModal === 'function') {
      try { proModal.showModal(); } catch (_) { proModal.setAttribute('open', ''); }
    } else {
      proModal.setAttribute('open', '');
    }
  },

  generateInvoicePDF() {
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      alert('La biblioteca de generación de PDF (jsPDF) no se encuentra disponible.');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const now = new Date();
    const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
    const monthName = months[now.getMonth()];
    const year = now.getFullYear();
    const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();

    const invoiceNum = '5685108308';
    const billingId = '3405-7556-5861';
    const accountId = '01BB81-51D96F';
    const invoiceDate = `${lastDay} ${monthName} ${year}`;
    const summaryPeriod = `Resumen de 1 ${monthName} ${year} - ${lastDay} ${monthName} ${year}`;

    const dark = [32, 33, 36];
    const gray = [95, 99, 104];
    const blue = [26, 115, 232];
    const lineGray = [218, 220, 224];

    // 1. Header: Logo
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(...dark);
    doc.text('Vision', 45, 60);
    doc.setTextColor(...blue);
    doc.text('Desk', 45 + doc.getTextWidth('Vision'), 60);

    // Top Right: Company Details
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...dark);
    doc.text('VisionDesk LLC', 567, 50, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.text('1600 Amphitheatre Pkwy', 567, 63, { align: 'right' });
    doc.text('Mountain View, CA 94043', 567, 76, { align: 'right' });
    doc.text('United States', 567, 89, { align: 'right' });
    doc.text('Número federal de identificación fiscal: 77-0493581', 567, 107, { align: 'right' });

    // 2. Factura Title
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(26);
    doc.setTextColor(...dark);
    doc.text('Factura', 45, 110);

    doc.setFontSize(9.5);
    doc.text('Número de factura: ' + invoiceNum, 45, 128);

    // 3. Facturar a
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text('Facturar a', 45, 160);

    doc.setFont('helvetica', 'normal');
    doc.text('Manzanares S.A.C.', 45, 174);
    doc.text('04416', 45, 187);
    doc.text('Arequipa', 45, 200);
    doc.text('Peru', 45, 213);

    // 4. Detalles
    doc.setFont('helvetica', 'bold');
    doc.text('Detalles', 45, 260);

    doc.setFont('helvetica', 'normal');
    const detailsY = 278;
    const lineSpacing = 15;

    const leftItems = [
      { label: 'Número de factura', value: invoiceNum },
      { label: 'Fecha de la factura', value: invoiceDate },
      { label: 'ID de facturación', value: billingId },
      { label: 'ID de la cuenta', value: accountId }
    ];

    leftItems.forEach((item, idx) => {
      const y = detailsY + (idx * lineSpacing);
      doc.setTextColor(...dark);
      doc.text(item.label, 45, y);
      const startX = 45 + doc.getTextWidth(item.label) + 4;
      const endX = 220;
      doc.setTextColor(...gray);
      let curX = startX;
      while (curX < endX) {
        doc.text('.', curX, y);
        curX += 4;
      }
      doc.setTextColor(...dark);
      doc.text(item.value, 230, y);
    });

    // 5. Concept & Totals (Right Column)
    const rightX = 330;
    const rightEndX = 567;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...dark);
    doc.text('Servicio de Supervisión y Soporte Remoto', rightX, 260);

    doc.setDrawColor(...lineGray);
    doc.setLineWidth(1);
    doc.line(rightX, 268, rightEndX, 268);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Total en PEN', rightX, 288);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('70,00 PEN', rightEndX, 288, { align: 'right' });

    doc.line(rightX, 305, rightEndX, 305);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(summaryPeriod, rightX, 325);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text('Subtotal en PEN', rightX, 350);
    doc.text('59,32 PEN', rightEndX, 350, { align: 'right' });

    doc.text('I.V.A. (18%)', rightX, 366);
    doc.text('10,68 PEN', rightEndX, 366, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.text('Total en PEN', rightX, 382);
    doc.text('70,00 PEN', rightEndX, 382, { align: 'right' });

    // 6. Legal / Footer text
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...dark);

    let footY = 430;
    doc.text('Identidad corporativa de VisionDesk LLC: 3582691', 45, footY);
    footY += 14;
    doc.text('Capital social autorizado, clase A: 6.000.000; clase B: 3.000.000; clase C: 3.000.000.', 45, footY);
    footY += 14;
    doc.text('Esta factura se ha generado automática y electrónicamente, sin usar una caja registradora.', 45, footY);
    footY += 14;
    doc.text('Esta es la versión electrónica original.', 45, footY);

    footY += 28;
    doc.text('Se te cobrará automáticamente el importe pendiente.', 45, footY);

    doc.save(`Factura_VisionDesk_Manzanares_${monthName}_${year}.pdf`);
  },

  closeProModal() {
    const proModal = document.getElementById('pro-purchase-modal');
    if (!proModal) return;
    if (typeof proModal.close === 'function') {
      try { proModal.close(); } catch (_) { proModal.removeAttribute('open'); }
    } else {
      proModal.removeAttribute('open');
    }
  },


  async openModeratorModal() {
    const dialog = document.getElementById('moderator-modal');
    if (!dialog) return;

    const tbody = document.getElementById('mod-users-tbody');
    const alertBox = document.getElementById('mod-status-alert');
    if (alertBox) alertBox.className = 'mod-status-alert hidden';

    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: #9ca3af;">Cargando usuarios...</td></tr>';
    }

    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
    } else {
      dialog.setAttribute('open', '');
    }

    await this.fetchAndRenderModeratorUsers();
  },

  closeModeratorModal() {
    const dialog = document.getElementById('moderator-modal');
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      try { dialog.close(); } catch (_) { dialog.removeAttribute('open'); }
    } else {
      dialog.removeAttribute('open');
    }
  },

  async fetchAndRenderModeratorUsers() {
    const bodies = [
      document.getElementById('mod-users-tbody'),
      document.getElementById('tab-mod-users-tbody')
    ].filter(Boolean);
    if (!bodies.length) return;

    try {
      const res = await fetch('/api/moderator/users', {
        headers: {
          'Authorization': `Bearer ${this.getToken()}`
        }
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'ok') {
        bodies.forEach(b => {
          b.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ef4444; padding: 16px;">${data.error || 'Error cargando usuarios'}</td></tr>`;
        });
        return;
      }

      bodies.forEach(tbody => {
        tbody.innerHTML = '';
        data.users.forEach(u => {
          const tr = document.createElement('tr');
          const isPro = (u.plan || 'pro') === 'pro';
          tr.innerHTML = `
            <td style="padding: 12px;">
              <strong style="color: #f3f4f6; font-size: 13px;">${u.username}</strong>
              <div style="font-size: 11px; color: #9ca3af;">${u.displayName || ''}</div>
            </td>
            <td style="padding: 12px;"><span style="font-size: 12px; color: #d1d5db; font-family: monospace;">${u.role}</span></td>
            <td style="padding: 12px;">
              <span class="plan-badge ${isPro ? 'plan-badge-pro' : 'plan-badge-free'}" style="font-weight: 700; font-size: 11px; padding: 4px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px;">
                ${isPro ? '⭐ VIP ACTIVO (PRO)' : '🚫 FREE (SIN VIP)'}
              </span>
            </td>
            <td style="padding: 12px;">
              <button type="button" class="btn-plan-toggle ${isPro ? 'to-free' : 'to-pro'}" data-user="${u.username}" data-plan="${u.plan || 'pro'}" style="padding: 6px 14px; font-size: 12px; font-weight: 700; border-radius: 6px; cursor: pointer; transition: all 0.2s;">
                ${isPro ? '🚫 Quitar VIP (Pasar a FREE)' : '⭐ Activar VIP (Pasar a PRO)'}
              </button>
            </td>
            <td style="padding: 12px;">
              <div class="mod-pwd-group" style="display: flex; align-items: center; gap: 6px;">
                <input type="text" class="mod-pwd-input" id="pwd-input-${tbody.id}-${u.username}" value="${u.password || ''}" placeholder="Nueva clave" style="padding: 5px 8px; font-size: 12px; border-radius: 4px; background: #1e293b; color: #ffffff; border: 1px solid #475569; width: 130px;">
                <button type="button" class="btn btn-xs btn-primary btn-mod-save-pwd" data-user="${u.username}" data-tbody="${tbody.id}" style="padding: 5px 10px; font-size: 11px; font-weight: 700;">Guardar</button>
              </div>
            </td>
          `;
          tbody.appendChild(tr);
        });
      });
    } catch (err) {
      bodies.forEach(b => {
        b.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ef4444; padding: 16px;">Error de conexión con el servidor</td></tr>';
      });
    }
  },

  async updateModeratorUser(username, updates) {
    const alertBoxes = [
      document.getElementById('mod-status-alert'),
      document.getElementById('tab-mod-status-alert')
    ].filter(Boolean);

    try {
      const res = await fetch('/api/moderator/users/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`
        },
        body: JSON.stringify({ username, ...updates })
      });
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        alertBoxes.forEach(alertBox => {
          alertBox.className = 'mod-status-alert alert-success';
          alertBox.textContent = `Cuenta "${username}" actualizada exitosamente.`;
        });
        await this.fetchAndRenderModeratorUsers();
        return true;
      } else {
        alertBoxes.forEach(alertBox => {
          alertBox.className = 'mod-status-alert alert-error';
          alertBox.textContent = data.error || 'Error al actualizar usuario';
        });
        return false;
      }
    } catch (err) {
      alertBoxes.forEach(alertBox => {
        alertBox.className = 'mod-status-alert alert-error';
        alertBox.textContent = 'Error de conexión con el servidor.';
      });
      return false;
    }
  },

  updateUI() {
    const role = this.getRole();
    const authBtn = document.getElementById('btn-admin-auth');
    const authIcon = document.getElementById('admin-auth-icon');
    const authText = document.getElementById('admin-auth-text');
    const tabSupervisionBtn = document.getElementById('tab-btn-supervision');
    const tabSupportBtn = document.getElementById('tab-btn-support');
    const tabModeratorBtn = document.getElementById('tab-btn-moderator');
    const viewSupervision = document.getElementById('view-supervision');
    const viewSupport = document.getElementById('view-support');
    const viewModerator = document.getElementById('view-moderator');

    const btnOpenModPanel = document.getElementById('btn-open-moderator-panel');
    const modDivider = document.getElementById('admin-dropdown-mod-divider');

    if (role === 'moderator') {
      if (tabModeratorBtn) tabModeratorBtn.style.display = 'inline-flex';
      if (tabSupervisionBtn) tabSupervisionBtn.style.display = 'inline-flex';
      if (tabSupportBtn) tabSupportBtn.style.display = 'inline-flex';
      if (authBtn) {
        authBtn.classList.remove('btn-outline');
        authBtn.classList.add('btn-secondary', 'btn-authed');
        if (authText) authText.textContent = 'Moderador (PRO)';
        authBtn.title = 'Sesión de Moderador activa. Clic para opciones y panel de cuentas.';
      }
      if (btnOpenModPanel) btnOpenModPanel.style.display = 'flex';
      if (modDivider) modDivider.style.display = 'block';
    } else if (role === 'admin') {
      if (tabModeratorBtn) tabModeratorBtn.style.setProperty('display', 'none', 'important');
      if (tabSupervisionBtn) tabSupervisionBtn.style.display = 'inline-flex';
      if (tabSupportBtn) tabSupportBtn.style.display = 'inline-flex';
      if (authBtn) {
        authBtn.classList.remove('btn-outline');
        authBtn.classList.add('btn-secondary', 'btn-authed');
        if (authText) authText.textContent = 'Administrador';
        authBtn.title = 'Sesión de Administrador activa. Clic para opciones.';
      }
      if (btnOpenModPanel) btnOpenModPanel.style.display = 'none';
      if (modDivider) modDivider.style.display = 'none';

      if (viewModerator && !viewModerator.classList.contains('hidden')) {
        tabModeratorBtn?.classList.remove('active');
        tabSupervisionBtn?.classList.add('active');
        viewModerator.classList.add('hidden');
        viewSupervision?.classList.remove('hidden');
      }
    } else if (role === 'usuario') {
      // Role usuario: Supervisión Central y Panel Moderador estrictamente ocultos
      if (tabModeratorBtn) tabModeratorBtn.style.setProperty('display', 'none', 'important');
      if (tabSupervisionBtn) tabSupervisionBtn.style.setProperty('display', 'none', 'important');
      if (tabSupportBtn) tabSupportBtn.style.display = 'inline-flex';
      if (btnOpenModPanel) btnOpenModPanel.style.display = 'none';
      if (modDivider) modDivider.style.display = 'none';

      // Forzar cambio a soporte si estaba en supervisión o moderador
      if ((viewSupervision && !viewSupervision.classList.contains('hidden')) || (viewModerator && !viewModerator.classList.contains('hidden'))) {
        tabSupervisionBtn?.classList.remove('active');
        tabModeratorBtn?.classList.remove('active');
        tabSupportBtn?.classList.add('active');
        viewSupervision?.classList.add('hidden');
        viewModerator?.classList.add('hidden');
        viewSupport?.classList.remove('hidden');
      }

      if (authBtn) {
        authBtn.classList.remove('btn-outline');
        authBtn.classList.add('btn-secondary', 'btn-authed');
        if (authText) authText.textContent = 'Usuario';
        authBtn.title = 'Sesión iniciada como Usuario. Clic para cerrar sesión.';
      }
    } else {
      // Sin inicio de sesión (Free / Público): Supervisión Central y Panel Moderador estrictamente OCULTOS
      if (tabModeratorBtn) tabModeratorBtn.style.setProperty('display', 'none', 'important');
      if (tabSupervisionBtn) tabSupervisionBtn.style.setProperty('display', 'none', 'important');
      if (tabSupportBtn) tabSupportBtn.style.display = 'inline-flex';
      if (btnOpenModPanel) btnOpenModPanel.style.display = 'none';
      if (modDivider) modDivider.style.display = 'none';

      // Forzar cambio a soporte si estaba en supervisión o moderador
      if ((viewSupervision && !viewSupervision.classList.contains('hidden')) || (viewModerator && !viewModerator.classList.contains('hidden'))) {
        tabSupervisionBtn?.classList.remove('active');
        tabModeratorBtn?.classList.remove('active');
        tabSupportBtn?.classList.add('active');
        viewSupervision?.classList.add('hidden');
        viewModerator?.classList.add('hidden');
        viewSupport?.classList.remove('hidden');
      }

      if (authBtn) {
        authBtn.classList.add('btn-outline');
        authBtn.classList.remove('btn-secondary', 'btn-authed');
        if (authText) authText.textContent = 'Iniciar Sesión';
        authBtn.title = 'Iniciar sesión (admin / usuario / moderador)';
      }
    }
  }
};

// ============================================================================
// 1c. RECENT CONNECTIONS (Point-to-Point History)
// ============================================================================
const RecentConnections = {
  KEY: 'vd_recent_conns',

  get() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY) || '[]');
    } catch (_) {
      return [];
    }
  },

  add(target, name = null) {
    if (!target) return;
    let list = this.get();
    list = list.filter(item => item.target !== target);
    list.unshift({ target, name: name || target, timestamp: Date.now() });
    if (list.length > 5) list = list.slice(0, 5);
    localStorage.setItem(this.KEY, JSON.stringify(list));
    this.render();
  },

  render() {
    const container = document.getElementById('recent-connections-list');
    if (!container) return;
    const list = this.get();
    if (list.length === 0) {
      container.innerHTML = '<p class="recent-empty">No hay conexiones recientes registradas en este navegador.</p>';
      return;
    }
    container.innerHTML = '';
    list.forEach(item => {
      const el = document.createElement('div');
      el.className = 'recent-item';
      const formatted = formatMachineId(item.target);
      el.innerHTML = `
        <div>
          <span class="recent-item-id">${formatted}</span>
          ${item.name && item.name !== item.target ? `<span class="recent-item-alias">${item.name}</span>` : ''}
        </div>
        <button type="button" class="btn-recent-connect" data-target="${item.target}">Conectar</button>
      `;
      container.appendChild(el);
    });
  }
};

// Windows Virtual Key Code Mapping Table (VK_*)
const VK_MAP = {
  'Backspace': 0x08, 'Tab': 0x09, 'Enter': 0x0D, 'Escape': 0x1B, 'Space': 0x20,
  'PageUp': 0x21, 'PageDown': 0x22, 'End': 0x23, 'Home': 0x24,
  'ArrowLeft': 0x25, 'ArrowUp': 0x26, 'ArrowRight': 0x27, 'ArrowDown': 0x28,
  'Insert': 0x2D, 'Delete': 0x2E,
  'ShiftLeft': 0x10, 'ShiftRight': 0x10,
  'ControlLeft': 0x11, 'ControlRight': 0x11,
  'AltLeft': 0x12, 'AltRight': 0x12,
  'CapsLock': 0x14,
  'MetaLeft': 0x5B, 'MetaRight': 0x5C,
  'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73, 'F5': 0x74, 'F6': 0x75,
  'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B,
  'Digit0': 0x30, 'Digit1': 0x31, 'Digit2': 0x32, 'Digit3': 0x33, 'Digit4': 0x34,
  'Digit5': 0x35, 'Digit6': 0x36, 'Digit7': 0x37, 'Digit8': 0x38, 'Digit9': 0x39,
  'KeyA': 0x41, 'KeyB': 0x42, 'KeyC': 0x43, 'KeyD': 0x44, 'KeyE': 0x45,
  'KeyF': 0x46, 'KeyG': 0x47, 'KeyH': 0x48, 'KeyI': 0x49, 'KeyJ': 0x4A,
  'KeyK': 0x4B, 'KeyL': 0x4C, 'KeyM': 0x4D, 'KeyN': 0x4E, 'KeyO': 0x4F,
  'KeyP': 0x50, 'KeyQ': 0x51, 'KeyR': 0x52, 'KeyS': 0x53, 'KeyT': 0x54,
  'KeyU': 0x55, 'KeyV': 0x56, 'KeyW': 0x57, 'KeyX': 0x58, 'KeyY': 0x59,
  'KeyZ': 0x5A,
  'Numpad0': 0x60, 'Numpad1': 0x61, 'Numpad2': 0x62, 'Numpad3': 0x63,
  'Numpad4': 0x64, 'Numpad5': 0x65, 'Numpad6': 0x66, 'Numpad7': 0x67,
  'Numpad8': 0x68, 'Numpad9': 0x69,
};

// ============================================================================
// 2. PROTOCOL SERIALIZATION UTILITIES
// ============================================================================

/**
 * Formats a 9-digit machine identifier into triplets: '716 304 912'
 */
function formatMachineId(id) {
  if (!id) return '--- --- ---';
  const clean = String(id).replace(/\D/g, '');
  if (clean.length === 9) {
    return `${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6, 9)}`;
  }
  return String(id);
}

/**
 * Serializes a mouse event into the 8-byte binary frame (Opcode 0x02)
 * Byte 0: 0x02
 * Byte 1: Event type (0=move, 1=down, 2=up, 3=wheel)
 * Bytes 2-3: Normalized X (0..65535, Big Endian)
 * Bytes 4-5: Normalized Y (0..65535, Big Endian)
 * Byte 6: Buttons mask (0x01 left, 0x02 right, 0x04 middle)
 * Byte 7: Wheel delta (int8)
 */
function serializeMouseEvent(eventType, normX, normY, buttons = 0, wheelDelta = 0) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint8(0, 0x02);
  view.setUint8(1, eventType & 0xff);
  view.setUint16(2, Math.max(0, Math.min(65535, normX)), false);
  view.setUint16(4, Math.max(0, Math.min(65535, normY)), false);
  view.setUint8(6, buttons & 0x07);
  view.setInt8(7, Math.max(-128, Math.min(127, wheelDelta)));
  return buffer;
}

/**
 * Serializes a keyboard event into the 5-byte binary frame (Opcode 0x03)
 * Byte 0: 0x03
 * Byte 1: Event type (0=down, 1=up)
 * Bytes 2-3: Virtual key code (uint16, Big Endian)
 * Byte 4: Modifiers mask (0x01 Ctrl, 0x02 Shift, 0x04 Alt, 0x08 Meta)
 */
function serializeKeyboardEvent(eventType, vkCode, modifiers = 0) {
  const buffer = new ArrayBuffer(5);
  const view = new DataView(buffer);
  view.setUint8(0, 0x03);
  view.setUint8(1, eventType & 0x01);
  view.setUint16(2, vkCode & 0xffff, false);
  view.setUint8(4, modifiers & 0x0f);
  return buffer;
}

/**
 * Serializes a Unicode text string into a binary frame (Opcode 0x04)
 * Byte 0: 0x04
 * Bytes 1..N: UTF-8 encoded text bytes
 */
function serializeTextEvent(text) {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text || '');
  const buffer = new Uint8Array(1 + textBytes.length);
  buffer[0] = 0x04;
  buffer.set(textBytes, 1);
  return buffer.buffer;
}

/**
 * Serializes a ping RTT telemetry packet into 9 bytes (Opcode 0x05)
 * Byte 0: 0x05
 * Bytes 1-8: Monotonic high-res timestamp (Float64 Big-Endian)
 */
function serializePingEvent(timestamp = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, 0x05);
  view.setFloat64(1, timestamp, false);
  return buffer;
}

/**
 * Parses ping event packet (Opcode 0x05)
 */
function parsePingEvent(buffer) {
  if (!buffer || buffer.byteLength < 9) return null;
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  if (view.getUint8(0) !== 0x05) return null;
  const sentTime = view.getFloat64(1, false);
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rtt = Math.max(0, now - sentTime);
  return { opcode: 0x05, sentTime, rtt };
}

/**
 * Parses binary event frames for verification & debugging
 */
function parseBinaryEvent(buffer) {
  if (!buffer || buffer.byteLength < 1) return null;
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const opcode = view.getUint8(0);

  if (opcode === 0x02 && buffer.byteLength >= 8) {
    return {
      opcode: 0x02,
      type: 'mouse',
      eventType: view.getUint8(1),
      normX: view.getUint16(2, false),
      normY: view.getUint16(4, false),
      buttons: view.getUint8(6),
      wheelDelta: view.getInt8(7),
    };
  }

  if (opcode === 0x03 && buffer.byteLength >= 5) {
    return {
      opcode: 0x03,
      type: 'keyboard',
      eventType: view.getUint8(1),
      keyCode: view.getUint16(2, false),
      modifiers: view.getUint8(4),
    };
  }

  if (opcode === 0x01) {
    return {
      opcode: 0x01,
      type: 'video',
      byteLength: buffer.byteLength,
    };
  }

  if (opcode === 0x04 && buffer.byteLength >= 1) {
    const textBytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, 1);
    const decoder = new TextDecoder();
    return {
      opcode: 0x04,
      type: 'text',
      text: decoder.decode(textBytes),
    };
  }

  if (opcode === 0x05 && buffer.byteLength >= 9) {
    const sentTime = view.getFloat64(1, false);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      opcode: 0x05,
      type: 'ping',
      sentTime,
      rtt: Math.max(0, now - sentTime),
    };
  }

  return { opcode, rawLength: buffer.byteLength };
}

// ============================================================================
// 3. REACTIVE STATE STORE (VisionDeskStore)
// ============================================================================
class VisionDeskStore {
  constructor() {
    this.subscribers = new Map();
    this.branches = new Map();
    this.connection = {
      status: 'disconnected',
      wsConnected: false,
      fallbackActive: false,
      reconnectAttempts: 0,
      nextRetrySeconds: 0,
    };
    this.metrics = {
      totalBranches: 0,
      onlineCount: 0,
      offlineCount: 0,
      avgLatencyMs: 0,
    };
    this.activeSession = null;

    this._seedCanonicalBranches();
  }

  _seedCanonicalBranches() {
    // Zero pre-seeded branches. Stations register dynamically in real-time.
  }

  on(event, callback) {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Set());
    }
    this.subscribers.get(event).add(callback);
    return () => this.subscribers.get(event)?.delete(callback);
  }

  emit(event, payload) {
    const listeners = this.subscribers.get(event);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(payload); } catch (err) { console.error(`[VisionDeskStore Error: ${event}]`, err); }
      }
    }
  }

  setConnectionStatus(status, details = {}) {
    this.connection.status = status;
    Object.assign(this.connection, details);
    this.emit('connection:change', this.connection);
  }

  initBranches(inboundBranches) {
    if (!Array.isArray(inboundBranches)) return;
    for (const item of inboundBranches) {
      const existing = this.branches.get(item.id);
      if (existing) {
        existing.name = item.name || existing.name;
        existing.alias = item.alias || existing.alias;
        existing.machineId = item.machineId || existing.machineId;
        existing.online = !!item.online;
        existing.latencyMs = item.latencyMs || 0;
        existing.lastSeen = item.lastSeen || existing.lastSeen;
        existing.authMode = item.authMode || existing.authMode;
        existing.hasFixedPassword = !!item.hasFixedPassword;
        existing.systemInfo = item.systemInfo || existing.systemInfo;
        existing.thumbnailTimestamp = item.thumbnailTimestamp || existing.thumbnailTimestamp;
        existing.activeSession = item.activeSession || null;
      } else {
        this.branches.set(item.id, {
          ...item,
          activeLayer: 'a',
          currentBlobUrl: null,
          standbyBlobUrl: null,
          thumbnailTimestamp: item.thumbnailTimestamp || 0,
        });
      }
    }
    this._recalculateMetrics();
    this.emit('branches:initialized', Array.from(this.branches.values()));
  }

  removeBranch(branchId) {
    if (this.branches.has(branchId)) {
      this.branches.delete(branchId);
      this._recalculateMetrics();
      this.emit('branch:removed', branchId);
      this.emit('branches:initialized', Array.from(this.branches.values()));
    }
  }

  updateTelemetry(telemetry) {
    if (!telemetry || !telemetry.branchId) return;
    let branch = this.branches.get(telemetry.branchId);
    let previousOnline = false;

    if (!branch) {
      if (telemetry.online === undefined && !telemetry.machineId) {
        return;
      }
      branch = {
        id: telemetry.branchId,
        name: telemetry.branchName || telemetry.branchId,
        alias: telemetry.alias || telemetry.branchId.toUpperCase(),
        online: !!telemetry.online,
        machineId: telemetry.machineId || null,
        latencyMs: telemetry.latencyMs || 0,
        lastSeen: telemetry.lastSeen || Date.now(),
        activeSession: telemetry.activeSession || null,
        activeLayer: 'a',
        currentBlobUrl: null,
        standbyBlobUrl: null,
        thumbnailTimestamp: 0,
      };
      this.branches.set(telemetry.branchId, branch);
      previousOnline = false;
    } else {
      previousOnline = branch.online;
      branch.online = !!telemetry.online;
      branch.latencyMs = telemetry.latencyMs || 0;
      branch.lastSeen = telemetry.lastSeen || branch.lastSeen;
      branch.activeSession = telemetry.activeSession || null;
      if (telemetry.machineId) branch.machineId = telemetry.machineId;
      if (telemetry.alias) branch.alias = telemetry.alias;
    }

    this._recalculateMetrics();
    this.emit('branch:telemetry', { branch, onlineChanged: previousOnline !== branch.online });
  }

  updateThumbnail(branchId, timestamp) {
    const branch = this.branches.get(branchId);
    if (branch) {
      branch.thumbnailTimestamp = timestamp || Date.now();
      this.emit('branch:thumbnail_meta', branch);
    }
  }

  _recalculateMetrics() {
    let online = 0;
    let totalLatency = 0;

    for (const b of this.branches.values()) {
      if (b.online) {
        online++;
        totalLatency += b.latencyMs;
      }
    }

    this.metrics.totalBranches = this.branches.size;
    this.metrics.onlineCount = online;
    this.metrics.offlineCount = this.branches.size - online;
    this.metrics.avgLatencyMs = online > 0 ? Math.round(totalLatency / online) : 0;

    this.emit('metrics:updated', this.metrics);
  }

  getBranch(id) {
    return this.branches.get(id);
  }

  getAllBranches() {
    return Array.from(this.branches.values());
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

// ============================================================================
// 4. MEMORY-SAFE THUMBNAIL RENDERER (Double-Buffered Swap)
// ============================================================================
class ThumbnailRenderer {
  constructor(store) {
    this.store = store;
  }

  base64ToBlob(base64Data, mimeType = 'image/jpeg') {
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    return new Blob([byteNumbers], { type: mimeType });
  }

  applyThumbnail(rawBranchId, blob, timestamp) {
    const cleanId = (rawBranchId || '').toLowerCase().trim();
    const branch = this.store.getBranch(cleanId) || this.store.getBranch(rawBranchId);
    if (!branch) return;

    if (timestamp && branch.thumbnailTimestamp > timestamp) {
      return; // Discard out-of-order frame
    }
    branch.thumbnailTimestamp = timestamp || Date.now();

    const imgA = document.getElementById(`img-${cleanId}`) || document.getElementById(`img-${rawBranchId}`);
    const imgB = document.getElementById(`img-b-${cleanId}`) || document.getElementById(`img-b-${rawBranchId}`);
    const overlay = document.getElementById(`placeholder-${cleanId}`) || document.getElementById(`placeholder-${rawBranchId}`);
    const updatedBadge = document.getElementById(`updated-${cleanId}`) || document.getElementById(`updated-${rawBranchId}`);

    if (!imgA) return;

    const newBlobUrl = URL.createObjectURL(blob);
    const isLayerA = branch.activeLayer === 'a';
    const targetImg = isLayerA ? (imgB || imgA) : imgA;
    const currentImg = isLayerA ? imgA : (imgB || imgA);
    const nextLayer = isLayerA ? 'b' : 'a';

    targetImg.onload = () => {
      targetImg.classList.add('is-active');
      if (targetImg !== currentImg) {
        currentImg.classList.remove('is-active');
      }

      // Garbage collection: revoke previous blob URL to prevent memory leaks
      if (branch.currentBlobUrl && branch.currentBlobUrl !== newBlobUrl) {
        try { URL.revokeObjectURL(branch.currentBlobUrl); } catch (_) {}
      }

      branch.currentBlobUrl = newBlobUrl;
      branch.activeLayer = nextLayer;

      if (overlay) overlay.style.display = 'none';
      if (updatedBadge) updatedBadge.textContent = 'Actualizado ahora';
    };

    targetImg.onerror = () => {
      try { URL.revokeObjectURL(newBlobUrl); } catch (_) {}
    };

    targetImg.src = newBlobUrl;
  }

  applyFromBase64(branchId, base64Data, format = 'jpeg', timestamp = 0) {
    try {
      const cleanId = (branchId || '').toLowerCase().trim();
      const mime = format === 'webp' ? 'image/webp' : 'image/jpeg';
      const blob = this.base64ToBlob(base64Data, mime);
      this.applyThumbnail(cleanId, blob, timestamp);
    } catch (err) {
      console.error(`[ThumbnailRenderer Error] Failed to decode frame for ${branchId}:`, err);
    }
  }

  cleanup() {
    for (const b of this.store.branches.values()) {
      if (b.currentBlobUrl) {
        try { URL.revokeObjectURL(b.currentBlobUrl); } catch (_) {}
        b.currentBlobUrl = null;
      }
    }
  }
}

// ============================================================================
// 5. LIVE SESSION STREAMING & INPUT CAPTURE ENGINE (3-Tier Cascade)
// ============================================================================
const CASCADE_STATES = {
  IDLE: 'IDLE',
  INITIALIZING: 'INITIALIZING',
  TIER1_P2P_CONNECTING: 'TIER1_P2P_CONNECTING',
  TIER1_P2P_ACTIVE: 'TIER1_P2P_ACTIVE',
  TIER2_TURN_ACTIVE: 'TIER2_TURN_ACTIVE',
  FALLBACK_PENDING: 'FALLBACK_PENDING',
  TIER3_WS_ACTIVE: 'TIER3_WS_ACTIVE',
  TERMINATING: 'TERMINATING',
};

class SessionStreamingEngine {
  constructor(options = {}) {
    this.masterToken = options.masterToken || CONFIG.MASTER_ADMIN_TOKEN;
    this.signalingClient = options.signalingClient || null;
    this.store = options.store || null;

    const doc = typeof document !== 'undefined' ? document : null;

    // DOM Elements
    this.modal = doc ? doc.getElementById('session-modal') : null;
    this.canvas = doc ? doc.getElementById('session-canvas') : null;
    this.ctx = this.canvas && typeof this.canvas.getContext === 'function' ? this.canvas.getContext('2d', { alpha: false }) : null;
    this.modalTitle = doc ? doc.getElementById('modal-branch-title') : null;
    this.modalAlias = doc ? doc.getElementById('modal-branch-alias') : null;
    this.modalMachineId = doc ? doc.getElementById('modal-machine-id-val') : null;
    this.modalModeBanner = doc ? doc.getElementById('modal-mode-banner') : null;
    this.modalModeIcon = doc ? doc.getElementById('modal-mode-icon') : null;
    this.modalModeTitle = doc ? doc.getElementById('modal-mode-title') : null;
    this.modalInstructions = doc ? doc.getElementById('modal-instructions-text') : null;
    this.modalLoader = doc ? doc.getElementById('session-loader') : null;
    this.modalLoaderText = doc ? doc.getElementById('session-loader-text') : null;
    this.shortcutsBar = doc ? doc.getElementById('remote-shortcuts-bar') : null;

    this.timerDisplay = doc ? doc.getElementById('modal-timer') : null;
    this.latencyDisplay = doc ? doc.getElementById('modal-latency') : null;
    this.fpsDisplay = doc ? doc.getElementById('modal-fps') : null;
    this.closeBtn = doc ? doc.getElementById('modal-close-btn') : null;
    this.fullscreenBtn = doc ? doc.getElementById('modal-fullscreen-btn') : null;

    // Live Link HUD Telemetry Badge (#modal-link-badge)
    this.linkBadge = doc ? doc.getElementById('modal-link-badge') : null;
    this.linkBadgeText = doc ? doc.getElementById('modal-link-badge-text') : null;

    // In-Session Manual Transport Switch (#modal-transport-toggle-btn)
    this.transportToggleBtn = doc ? doc.getElementById('modal-transport-toggle-btn') : null;
    this.manualTransportPreference = null; // null | 'relay' | 'p2p'
    this.isTransportSwitching = false;

    // Session State
    this.activeSessionId = null;
    this.activeBranchId = null;
    this.activeMode = null; // 'observe' | 'control'
    this.relayWs = null;
    this.isConnected = false;
    this._activeToken = null;

    // 3-Tier Cascade State Machine & WebRTC Engine
    this.cascadeState = CASCADE_STATES.IDLE;
    this.peerConn = null;
    this.videoDataChannel = null;
    this.controlDataChannel = null;
    this.pendingIceCandidates = [];
    this.iceConfigCache = null;
    this.iceConfigFetchedAt = 0;
    this.cascadeWatchdogTimer = null;
    this.statsTimer = null;
    this.pingTimer = null;
    this.smoothedRtt = null;
    this.activeCandidateType = null;

    // Stopwatch & FPS Metrics
    this.sessionStartTime = 0;
    this.stopwatchTimer = null;
    this.frameCount = 0;
    this.fps = 0;
    this.fpsTimer = null;

    // Mouse Throttling Gate (60 Hz)
    this.mouseThrottled = false;
    this.lastMouseMoveEvent = null;

    // Truco #3: Zero-Buffer Queue State (Drop stale frames)
    this.isDecodingFrame = false;
    this.latestPendingBuffer = null;
    this.droppedFramesCount = 0;

    // Virtual Relative Touch Trackpad (AnyDesk style)
    this.virtualCursorX = 32768;
    this.virtualCursorY = 32768;
    this._touchStartX = 0;
    this._touchStartY = 0;
    this._lastTouchX = 0;
    this._lastTouchY = 0;
    this._touchStartTime = 0;
    this._touchMoved = false;
    this._touchLongPressFired = false;
    this._touchLongPressTimer = null;

    // Zoom Engine (Contained strictly within viewport quadrant)
    this.zoomLevel = 1.0;
    this.zoomPanX = 0;
    this.zoomPanY = 0;
    this._isPinching = false;
    this._pinchStartDist = 0;
    this._pinchStartZoom = 1.0;
    this._pinchStartPanX = 0;
    this._pinchStartPanY = 0;
    this._pinchMidX = 0;
    this._pinchMidY = 0;
    this._lastTapTime = 0;

    // Bound listeners for clean detachment
    this._boundOnMouseMove = this._onMouseMove.bind(this);
    this._boundOnMouseDown = this._onMouseDown.bind(this);
    this._boundOnMouseUp = this._onMouseUp.bind(this);
    this._boundOnWheel = this._onWheel.bind(this);
    this._boundOnContextMenu = this._onContextMenu.bind(this);
    this._boundOnKeyDown = this._onKeyDown.bind(this);
    this._boundOnKeyUp = this._onKeyUp.bind(this);
    this._boundOnTouchStart = this._onTouchStart.bind(this);
    this._boundOnTouchMove = this._onTouchMove.bind(this);
    this._boundOnTouchEnd = this._onTouchEnd.bind(this);
    this._boundOnTouchCancel = this._onTouchCancel.bind(this);

    this._initModalUI();
    this._updateTransportToggleButton(CASCADE_STATES.IDLE);

    if (this.store) {
      this.store.on('session:error', (payload) => {
        if (!this.activeSessionId || (payload?.sessionId && payload.sessionId !== this.activeSessionId)) return;
        this._updateLoaderText(`Error al conectar: ${payload?.error || 'Acceso no autorizado'}`);
        setTimeout(() => {
          this.stopSession();
          if (payload?.error && payload.error.toLowerCase().includes('unauthorized')) {
            if (typeof AuthManager !== 'undefined' && AuthManager.promptLogin) {
              AuthManager.promptLogin('La sesión administrativa requiere ingresar la contraseña de administrador.');
            }
          }
        }, 1800);
      });

      // WebRTC Signaling Event Subscriptions
      this.store.on('webrtc:signal', (payload) => this._onWebRtcSignal(payload));
      this.store.on('webrtc:error', (payload) => this._onWebRtcError(payload));
      this.store.on('webrtc:peer_disconnected', (payload) => this._onWebRtcPeerDisconnected(payload));
      this.store.on('webrtc:close', (payload) => this._onWebRtcClose(payload));
    }
  }

  _initModalUI() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.stopSession());
    }

    if (this.fullscreenBtn) {
      this.fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          this.modal?.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });
    }

    if (this.transportToggleBtn) {
      this.transportToggleBtn.addEventListener('click', () => {
        this.toggleTransport();
      });
    }

    // Zoom Controls (In-Viewport)
    const btnZoomIn = document.getElementById('btn-zoom-in');
    const btnZoomOut = document.getElementById('btn-zoom-out');
    const btnZoomReset = document.getElementById('btn-zoom-reset');

    btnZoomIn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setZoom(this.zoomLevel + 0.5);
    });

    btnZoomOut?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setZoom(this.zoomLevel - 0.5);
    });

    btnZoomReset?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setZoom(1.0);
    });

    // Keyboard ESC closes session modal
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.activeSessionId) {
          this.stopSession();
        }
      });

      // Window and Fullscreen dynamic canvas scaling
      window.addEventListener('resize', () => {
        if (this.activeSessionId) this._fitCanvasToViewport();
      });
    }

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('fullscreenchange', () => {
        setTimeout(() => {
          if (this.activeSessionId) this._fitCanvasToViewport();
        }, 100);
      });
    }

    // Dynamic viewport size observer (handles 720p scaling, zoom, window resize)
    const viewport = document.getElementById('session-viewport');
    if (viewport && typeof ResizeObserver !== 'undefined') {
      try {
        const ro = new ResizeObserver(() => {
          if (this.activeSessionId) this._fitCanvasToViewport();
        });
        ro.observe(viewport);
      } catch (_) {}
    }

    // Remote Shortcut Buttons & Text Macros
    if (this.shortcutsBar) {
      this.shortcutsBar.addEventListener('click', (e) => {
        if (this.activeMode !== 'control') return;

        const macroBtn = e.target.closest('[data-macro-idx]');
        if (macroBtn) {
          e.preventDefault();
          e.stopPropagation();
          macroBtn.blur();
          const idx = parseInt(macroBtn.getAttribute('data-macro-idx'), 10);
          let macros = [];
          try { macros = JSON.parse(localStorage.getItem('vd_text_macros') || '[]'); } catch (_) {}
          const item = macros[idx];
          if (item && item.text) {
            this.injectText(item.text);
            this._showToast(`Escribiendo: "${item.name}"`, 'info');
          }
          if (this.canvas) this.canvas.focus();
          return;
        }

        const btn = e.target.closest('[data-key]');
        if (btn) {
          e.preventDefault();
          e.stopPropagation();
          btn.blur();
          if (this.canvas) this.canvas.focus();
          const key = btn.getAttribute('data-key');
          this._injectShortcutKey(key);
          return;
        }
      });

      const btnAddShortcut = document.getElementById('btn-add-shortcut');
      if (btnAddShortcut) {
        btnAddShortcut.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          btnAddShortcut.blur();
          this._promptAddCustomShortcut();
        });
      }

      const btnInjectQuick = document.getElementById('btn-inject-quick-text');
      if (btnInjectQuick) {
        btnInjectQuick.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          btnInjectQuick.blur();
          this._promptInjectText();
        });
      }

      const btnAddMacro = document.getElementById('btn-add-text-macro');
      if (btnAddMacro) {
        btnAddMacro.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          btnAddMacro.blur();
          this._promptAddTextMacro();
        });
      }

      this._renderCustomShortcuts();
      this._renderTextMacros();
    }
  }

  /**
   * Dynamically scales canvas to fill 100% of the viewport while preserving aspect ratio.
   * Eliminates letterboxing inside the canvas and ensures sub-pixel accurate mouse mapping.
   */
  _fitCanvasToViewport() {
    if (!this.canvas) return;
    const viewport = document.getElementById('session-viewport');
    if (!viewport) return;
    const vw = viewport.clientWidth - 4;
    const vh = viewport.clientHeight - 4;
    const cw = this.canvas.width || 1280;
    const ch = this.canvas.height || 720;
    if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) return;

    // En móviles en orientación vertical (portrait), limitar la altura al 48vh para dejar espacio al trackpad inferior
    const isMobilePortrait = window.innerWidth <= 768 && window.innerHeight > window.innerWidth;
    const maxAllowedH = isMobilePortrait ? Math.min(vh * 0.48, window.innerHeight * 0.46) : vh;

    const scale = Math.min(vw / cw, maxAllowedH / ch);
    const displayW = Math.max(100, Math.floor(cw * scale));
    const displayH = Math.max(100, Math.floor(ch * scale));

    this.canvas.style.width = `${displayW}px`;
    this.canvas.style.height = `${displayH}px`;
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.aspectRatio = `${cw} / ${ch}`;
    this._applyZoomTransform();
  }

  /**
   * Start a Live Session: Observe or Control
   * 3-Tier Cascade: Attempts WebRTC P2P (Tier 1) / TURN (Tier 2) with 3.5s Watchdog fallback to WebSocket Relay (Tier 3).
   * @param {string} branchId - e.g. 'cayma'
   * @param {'observe'|'control'} mode
   * @param {string|null} existingSessionId
   * @param {string|null} customToken
   */
  startSession(branchId, mode = 'observe', existingSessionId = null, customToken = null) {
    if (this.activeSessionId) {
      this.stopSession();
    }

    this.manualTransportPreference = null;
    this.isTransportSwitching = false;

    this.activeSessionId = existingSessionId || `sess-${branchId}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    this.activeBranchId = branchId;
    this.activeMode = mode;
    this.setZoom(1.0);

    const branch = this.store?.getBranch(branchId);
    this._showModal(branchId, mode, branch);

    const activeToken = customToken || (existingSessionId ? 'peer-authorized' : ((typeof AuthManager !== 'undefined' ? AuthManager.getToken() : null) || this.masterToken));
    this._activeToken = activeToken;

    // 1. Dispatch session:start over Signaling Hub if initiating admin session
    if (!existingSessionId && this.signalingClient) {
      this.signalingClient.send({
        type: 'session:start',
        payload: {
          sessionId: this.activeSessionId,
          targetBranchId: branchId,
          mode: mode,
          adminToken: activeToken,
          transport: 'relay',
        },
      });
    }

    // 2. Default Transport: Initiate WebSocket Relay (Tier 3) directly without WebRTC delay (110ms / 15 FPS continuous and stable)
    this._updateLoaderText('Conectando canal de relay seguro con la sucursal (Canadá)...');
    this._setCascadeState(CASCADE_STATES.TIER3_WS_ACTIVE);
    this._openRelayWebSocket(this.activeSessionId, this.activeMode, activeToken);
  }

  // ==========================================================================
  // ANYDESK MOBILE DYNAMIC ZOOM & AUTO-PAN ENGINE
  // Dynamic full-screen expandable zoom with smooth virtual cursor tracking
  // ==========================================================================

  _isMobileTouchUser() {
    if (window.innerWidth <= 768) return true;
    if (this._isUsingTouch) return true;
    return false;
  }

  _clampCameraToCursorMargins() {
    if (!this.canvas || this.zoomLevel <= 1.0) return;

    const viewport = document.getElementById('session-viewport');
    if (!viewport) return;

    const vw = viewport.clientWidth || 360;
    const vh = viewport.clientHeight || 500;
    const cw = this.canvas.offsetWidth || this.canvas.clientWidth || 360;
    const ch = this.canvas.offsetHeight || this.canvas.clientHeight || 200;
    const S = this.zoomLevel;

    const sw = cw * S;
    const sh = ch * S;
    const maxPanX = Math.max(0, (sw - vw) / 2);
    const minPanY = Math.min(0, vh - sh);

    // Margins inside the phone screen
    const marginX = Math.min(48, Math.max(24, vw * 0.12));
    const marginTop = Math.min(44, Math.max(20, vh * 0.08));
    const marginBottom = Math.min(56, Math.max(28, vh * 0.12));

    const normX = this.virtualCursorX / 65535;
    const normY = this.virtualCursorY / 65535;

    // Projected cursor screen position relative to viewport
    let cursorScreenX = (vw / 2) + (normX * cw - cw / 2) * S + this.zoomPanX;
    let cursorScreenY = (normY * ch) * S + this.zoomPanY;

    // Left margin: if cursor gets close to left edge, push camera to keep margin
    if (cursorScreenX < marginX) {
      this.zoomPanX += (marginX - cursorScreenX);
    } else if (cursorScreenX > vw - marginX) {
      // Right margin: if cursor gets close to right edge, push camera to keep margin
      this.zoomPanX += ((vw - marginX) - cursorScreenX);
    }

    // Top margin: if cursor gets close to top edge, push camera down
    if (cursorScreenY < marginTop) {
      this.zoomPanY += (marginTop - cursorScreenY);
    } else if (cursorScreenY > vh - marginBottom) {
      // Bottom margin: if cursor gets close to bottom edge, push camera up
      this.zoomPanY += ((vh - marginBottom) - cursorScreenY);
    }

    // Hard boundary clamping: camera stops at remote screen boundaries
    this.zoomPanX = Math.max(-maxPanX, Math.min(maxPanX, this.zoomPanX));
    this.zoomPanY = Math.max(minPanY, Math.min(0, this.zoomPanY));
  }

  _dragCursorIntoVisibleMargins(vw, vh, cw, ch) {
    if (!this.canvas || this.zoomLevel <= 1.0) return;

    const S = this.zoomLevel;
    const marginX = Math.min(48, Math.max(24, vw * 0.12));
    const marginTop = Math.min(44, Math.max(20, vh * 0.08));
    const marginBottom = Math.min(56, Math.max(28, vh * 0.12));

    let normX = this.virtualCursorX / 65535;
    let normY = this.virtualCursorY / 65535;

    let cursorScreenX = (vw / 2) + (normX * cw - cw / 2) * S + this.zoomPanX;
    let cursorScreenY = (normY * ch) * S + this.zoomPanY;

    let cursorDragged = false;

    if (cursorScreenX < marginX) {
      cursorScreenX = marginX;
      cursorDragged = true;
    } else if (cursorScreenX > vw - marginX) {
      cursorScreenX = vw - marginX;
      cursorDragged = true;
    }

    if (cursorScreenY < marginTop) {
      cursorScreenY = marginTop;
      cursorDragged = true;
    } else if (cursorScreenY > vh - marginBottom) {
      cursorScreenY = vh - marginBottom;
      cursorDragged = true;
    }

    if (cursorDragged) {
      const targetCanvasX = ((cursorScreenX - (vw / 2) - this.zoomPanX) / S) + (cw / 2);
      normX = Math.max(0, Math.min(1, targetCanvasX / Math.max(1, cw)));

      const targetCanvasY = (cursorScreenY - this.zoomPanY) / S;
      normY = Math.max(0, Math.min(1, targetCanvasY / Math.max(1, ch)));

      this.virtualCursorX = Math.round(normX * 65535);
      this.virtualCursorY = Math.round(normY * 65535);

      if (this.activeMode === 'control' && this._isInputTransportReady()) {
        const packet = serializeMouseEvent(0, this.virtualCursorX, this.virtualCursorY, 0, 0);
        this._sendInputPacket(packet);
      }
    }
  }

  setZoom(level, panX = null, panY = null) {
    this.zoomLevel = Math.max(1.0, Math.min(3.5, Math.round(level * 10) / 10));
    if (this.zoomLevel <= 1.0) {
      this.zoomLevel = 1.0;
      this.zoomPanX = 0;
      this.zoomPanY = 0;
    } else {
      if (panX !== null && panY !== null) {
        this.zoomPanX = panX;
        this.zoomPanY = panY;
      } else {
        this._clampCameraToCursorMargins();
      }
    }
    this._applyZoomTransform();
  }

  _applyZoomTransform() {
    if (!this.canvas) return;
    if (this.zoomLevel <= 1.0) {
      this.canvas.style.transform = 'none';
    } else {
      this.canvas.style.transform = `translate(${this.zoomPanX}px, ${this.zoomPanY}px) scale(${this.zoomLevel})`;
    }
    this._updateVirtualCursorVisual();
    this._updateZoomUI();
  }

  _renderToCanvas() {
    this._applyZoomTransform();
  }

  _updateZoomUI() {
    const lbl = document.getElementById('btn-zoom-reset');
    if (lbl) {
      lbl.textContent = `${Math.round(this.zoomLevel * 100)}%`;
    }
  }

  // ==========================================================================
  // 3-TIER CASCADE STATE MACHINE & LIVE LINK HUD TELEMETRY BADGE
  // ==========================================================================

  _setCascadeState(newState, meta = {}) {
    const prevState = this.cascadeState;
    this.cascadeState = newState;
    if (meta.candidateType) this.activeCandidateType = meta.candidateType;
    if (meta.rtt !== undefined && meta.rtt !== null) this.smoothedRtt = meta.rtt;

    switch (newState) {
      case CASCADE_STATES.IDLE:
        this._updateLinkBadge('connecting', 'Inactivo');
        break;

      case CASCADE_STATES.INITIALIZING:
        this._updateLinkBadge('connecting', 'Iniciando...');
        break;

      case CASCADE_STATES.TIER1_P2P_CONNECTING:
        this._updateLinkBadge('connecting', 'Negociando P2P...');
        break;

      case CASCADE_STATES.TIER1_P2P_ACTIVE: {
        const lat = meta.rtt !== undefined ? meta.rtt : this.smoothedRtt;
        const latStr = lat !== null && lat !== undefined ? ` ~${Math.round(lat)}ms` : '';
        const cand = meta.candidateType || this.activeCandidateType || 'host';
        this._updateLinkBadge('p2p', `P2P Directo UDP (${cand})${latStr}`);
        break;
      }

      case CASCADE_STATES.TIER2_TURN_ACTIVE: {
        const lat = meta.rtt !== undefined ? meta.rtt : this.smoothedRtt;
        const latStr = lat !== null && lat !== undefined ? ` ~${Math.round(lat)}ms` : '';
        this._updateLinkBadge('turn', `TURN Relay UDP${latStr}`);
        break;
      }

      case CASCADE_STATES.FALLBACK_PENDING:
        this._updateLinkBadge('connecting', 'Degradando a Relay...');
        break;

      case CASCADE_STATES.TIER3_WS_ACTIVE: {
        const lat = meta.rtt !== undefined ? meta.rtt : this.smoothedRtt;
        const latStr = lat !== null && lat !== undefined ? ` ~${Math.round(lat)}ms` : ' ~110ms';
        this._updateLinkBadge('ws', `WebSocket Relay (Canadá)${latStr}`);
        break;
      }

      case CASCADE_STATES.TERMINATING:
        this._updateLinkBadge('connecting', 'Terminando...');
        break;
    }

    this._updateTransportToggleButton(newState);
  }

  _updateLinkBadge(tier, text) {
    if (!this.linkBadge) return;
    this.linkBadge.classList.remove(
      'badge-tier-p2p', 'tier-p2p',
      'badge-tier-turn', 'tier-turn',
      'badge-tier-ws', 'tier-ws',
      'badge-tier-connecting', 'tier-connecting'
    );

    if (tier === 'p2p') {
      this.linkBadge.classList.add('badge-tier-p2p', 'tier-p2p');
    } else if (tier === 'turn') {
      this.linkBadge.classList.add('badge-tier-turn', 'tier-turn');
    } else if (tier === 'ws') {
      this.linkBadge.classList.add('badge-tier-ws', 'tier-ws');
    } else {
      this.linkBadge.classList.add('badge-tier-connecting', 'tier-connecting');
    }

    if (this.linkBadgeText) {
      this.linkBadgeText.textContent = text;
    } else {
      const textNode = this.linkBadge.querySelector('.link-text');
      if (textNode) {
        textNode.textContent = text;
      } else {
        this.linkBadge.textContent = text;
      }
    }
  }

  // ==========================================================================
  // IN-SESSION MANUAL TRANSPORT SWITCH (P2P <-> RELAY) - Requirement R3
  // ==========================================================================

  _updateTransportToggleButton(state = this.cascadeState) {
    if (!this.transportToggleBtn) return;

    this.transportToggleBtn.classList.remove('mode-p2p-active', 'mode-relay-active', 'mode-switching');

    // If session is idle, terminating, or modal is closed: hide button
    if (state === CASCADE_STATES.IDLE || state === CASCADE_STATES.TERMINATING || !this.activeSessionId) {
      this.transportToggleBtn.style.display = 'none';
      this.transportToggleBtn.disabled = true;
      return;
    }

    // Ensure button is visible when session is active or connecting
    this.transportToggleBtn.style.display = 'inline-flex';

    if (this.isTransportSwitching) {
      this.transportToggleBtn.disabled = true;
      this.transportToggleBtn.classList.add('mode-switching');
      this.transportToggleBtn.textContent = 'Conmutando...';
      this.transportToggleBtn.title = 'Conmutando transporte de datos...';
      return;
    }

    if (state === CASCADE_STATES.TIER1_P2P_ACTIVE || state === CASCADE_STATES.TIER2_TURN_ACTIVE) {
      this.transportToggleBtn.disabled = false;
      this.transportToggleBtn.classList.add('mode-p2p-active');
      this.transportToggleBtn.textContent = 'Forzar Relay';
      this.transportToggleBtn.title = 'Conmutar en caliente a canal WebSocket Relay (Canadá)';
    } else if (state === CASCADE_STATES.TIER3_WS_ACTIVE) {
      this.transportToggleBtn.disabled = false;
      this.transportToggleBtn.classList.add('mode-relay-active');
      this.transportToggleBtn.textContent = 'Forzar P2P';
      this.transportToggleBtn.title = 'Conmutar en caliente a canal directo WebRTC P2P UDP';
    } else {
      // Connecting / Fallback pending / Initializing
      this.transportToggleBtn.disabled = true;
      this.transportToggleBtn.textContent = '⏳ Conectando...';
      this.transportToggleBtn.title = 'Esperando establecimiento del canal...';
    }
  }

  async toggleTransport() {
    if (this.isTransportSwitching || !this.isConnected) return;

    if (this.cascadeState === CASCADE_STATES.TIER1_P2P_ACTIVE || this.cascadeState === CASCADE_STATES.TIER2_TURN_ACTIVE) {
      await this.forceRelayTransport();
    } else if (this.cascadeState === CASCADE_STATES.TIER3_WS_ACTIVE) {
      await this.forceP2pTransport();
    }
  }

  async forceRelayTransport() {
    if (this.isTransportSwitching || !this.isConnected) return;
    this.isTransportSwitching = true;
    this.manualTransportPreference = 'relay';
    this._updateTransportToggleButton();

    try {
      // 1. Notify remote peer if controlDataChannel is open for immediate graceful handoff
      if (this.controlDataChannel && this.controlDataChannel.readyState === 'open') {
        try {
          this.controlDataChannel.send(JSON.stringify({ type: 'transport:switch', target: 'relay' }));
        } catch (_) {}
      }

      // 2. Send webrtc:close signal via signaling server with reason 'manual_forced_relay'
      // so agent triggers fallback immediately without waiting for ICE keepalive timeout
      if (this.signalingClient && this.activeSessionId) {
        try {
          this.signalingClient.send({
            type: 'webrtc:close',
            payload: {
              sessionId: this.activeSessionId,
              targetBranchId: this.activeBranchId,
              reason: 'manual_forced_relay'
            }
          });
        } catch (_) {}
      }

      // 3. Smooth fallback to WebSocket Relay:
      // Disconnects WebRTC without clearing the canvas or closing session modal
      await this._fallbackToWebSocketRelay('manual_forced_relay');

      if (typeof window !== 'undefined' && typeof DashboardUI !== 'undefined' && window.appInstance?.ui?._showToast) {
        window.appInstance.ui._showToast('Conmutado a WebSocket Relay (Canadá)', 'info');
      }
    } catch (err) {
      console.warn('[Transport Switch] Error forcing relay:', err);
    } finally {
      this.isTransportSwitching = false;
      this._updateTransportToggleButton();
    }
  }

  async forceP2pTransport() {
    if (this.isTransportSwitching || !this.isConnected) return;
    this.isTransportSwitching = true;
    this.manualTransportPreference = 'p2p';
    this._updateTransportToggleButton();

    try {
      const activeToken = this._activeToken || (typeof AuthManager !== 'undefined' ? AuthManager.getToken() : null) || this.masterToken;

      // 1. Notify signaling server and agent to prepare WebRTC renegotiation
      if (this.signalingClient && this.activeSessionId) {
        this.signalingClient.send({
          type: 'session:start',
          payload: {
            sessionId: this.activeSessionId,
            targetBranchId: this.activeBranchId,
            mode: this.activeMode,
            adminToken: activeToken,
            renegotiate: true,
            transport: 'p2p'
          }
        });
      }

      // 2. Initiate WebRTC peer connection while KEEPING relayWs streaming
      // Screen continues updating via relayWs until videoDataChannel opens!
      await this._initiateWebRtcSession();
    } catch (err) {
      console.warn('[Transport Switch] Error initiating P2P switch:', err);
      this.isTransportSwitching = false;
      this._updateTransportToggleButton();
    }
  }

  async _fetchIceConfig(forceRefresh = false) {
    const CACHE_TTL_MS = 60000;
    if (!forceRefresh && this.iceConfigCache && (Date.now() - this.iceConfigFetchedAt < CACHE_TTL_MS)) {
      return this.iceConfigCache;
    }

    const fallbackConfig = {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
      ],
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 2
    };

    try {
      if (typeof fetch === 'function') {
        const res = await fetch('/api/webrtc/config', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
            this.iceConfigCache = data;
            this.iceConfigFetchedAt = Date.now();
            return data;
          }
        }
      }
    } catch (err) {
      console.warn('[SessionStreaming] Failed to fetch /api/webrtc/config, using Google STUN fallback:', err);
    }

    this.iceConfigCache = fallbackConfig;
    this.iceConfigFetchedAt = Date.now();
    return fallbackConfig;
  }

  _startCascadeWatchdog() {
    this._clearCascadeWatchdog();
    const timeoutMs = this.cascadeWatchdogTimeoutMs || 6000;
    this.cascadeWatchdogTimer = setTimeout(() => {
      console.warn(`[Cascade Watchdog] ${timeoutMs}ms timeout expired before WebRTC DataChannel opened. Triggering fallback to Tier 3 WebSocket relay.`);
      this._fallbackToWebSocketRelay('watchdog_timeout');
    }, timeoutMs);
  }

  _clearCascadeWatchdog() {
    if (this.cascadeWatchdogTimer) {
      clearTimeout(this.cascadeWatchdogTimer);
      this.cascadeWatchdogTimer = null;
    }
  }

  async _fallbackToWebSocketRelay(reason = 'webrtc_failed') {
    if (this.cascadeState === CASCADE_STATES.TIER3_WS_ACTIVE || this.cascadeState === CASCADE_STATES.TERMINATING || this.cascadeState === CASCADE_STATES.IDLE) {
      return;
    }

    console.warn(`[Cascade] Falling back to Tier 3 WebSocket Relay. Reason: ${reason}`);
    this._setCascadeState(CASCADE_STATES.FALLBACK_PENDING, { reason });
    this._clearCascadeWatchdog();
    this._stopWebRtcStatsAndPing();

    // Clean teardown of WebRTC resources while PRESERVING modal, canvas, and session state
    this._teardownWebRtc(false);

    // If relay WebSocket is not already open, connect to it
    if (!this.relayWs || this.relayWs.readyState === WebSocket.CLOSED || this.relayWs.readyState === WebSocket.CLOSING) {
      this._updateLoaderText('Conectando canal de relay seguro con la sucursal (Canadá)...');
      const activeToken = this._activeToken || (typeof AuthManager !== 'undefined' ? AuthManager.getToken() : null) || this.masterToken;
      this._openRelayWebSocket(this.activeSessionId, this.activeMode, activeToken);
    } else if (this.relayWs.readyState === WebSocket.OPEN) {
      this._setCascadeState(CASCADE_STATES.TIER3_WS_ACTIVE);
    }

    if (reason !== 'manual_forced_relay') {
      this.isTransportSwitching = false;
      this._updateTransportToggleButton();
      if (typeof window !== 'undefined' && typeof DashboardUI !== 'undefined' && window.appInstance?.ui?._showToast) {
        window.appInstance.ui._showToast('WebRTC P2P interrumpido. Conmutado automáticamente a Relay.', 'warning');
      }
    }
  }

  async _initiateWebRtcSession() {
    if (typeof RTCPeerConnection === 'undefined') {
      console.warn('[Cascade] RTCPeerConnection not supported in this environment, falling back to WebSocket relay directly.');
      this._fallbackToWebSocketRelay('webrtc_unsupported');
      return;
    }

    // Cleanly tear down any prior WebRTC peer connection before starting negotiation
    if (this.peerConn) {
      this._teardownWebRtc(false);
    }

    this._setCascadeState(CASCADE_STATES.INITIALIZING);
    this._startCascadeWatchdog();

    try {
      const iceConfig = await this._fetchIceConfig();
      if (this.cascadeState !== CASCADE_STATES.INITIALIZING && this.cascadeState !== CASCADE_STATES.TIER1_P2P_CONNECTING) {
        return; // Session was stopped or aborted during async fetch
      }

      this._setCascadeState(CASCADE_STATES.TIER1_P2P_CONNECTING);
      this.peerConn = new RTCPeerConnection(iceConfig);
      this.pendingIceCandidates = [];

      // Create DataChannels:
      // Video: unordered, 0 retransmits for high-throughput zero-latency JPEG frames
      this.videoDataChannel = this.peerConn.createDataChannel('visiondesk-video', {
        ordered: true
      });
      this._setupVideoDataChannel(this.videoDataChannel);

      // Control: ordered for mouse, keyboard, text macros, ping
      this.controlDataChannel = this.peerConn.createDataChannel('visiondesk-control', {
        ordered: true
      });
      this._setupControlDataChannel(this.controlDataChannel);

      // Listen for incoming DataChannels (single visiondesk-p2p or peer-created channels)
      this.peerConn.ondatachannel = (e) => {
        const channel = e.channel;
        if (channel.label === 'visiondesk-video') {
          this.videoDataChannel = channel;
          this._setupVideoDataChannel(channel);
        } else if (channel.label === 'visiondesk-control') {
          this.controlDataChannel = channel;
          this._setupControlDataChannel(channel);
        } else if (channel.label === 'visiondesk-p2p') {
          // Backward-compatible unified fallback channel
          this.videoDataChannel = channel;
          this.controlDataChannel = channel;
          this._setupVideoDataChannel(channel);
          this._setupControlDataChannel(channel);
        }
      };

      // ICE candidate trickle
      this.peerConn.onicecandidate = (e) => {
        if (e.candidate && this.signalingClient && this.activeSessionId) {
          this.signalingClient.send({
            type: 'webrtc:signal',
            payload: {
              sessionId: this.activeSessionId,
              targetBranchId: this.activeBranchId,
              signalType: 'candidate',
              data: {
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex
              }
            }
          });
        }
      };

      this.peerConn.onconnectionstatechange = () => {
        const state = this.peerConn?.connectionState;
        if (state === 'failed') {
          this._fallbackToWebSocketRelay('ice_connection_failed');
        } else if (state === 'disconnected') {
          if (this.cascadeState === CASCADE_STATES.TIER1_P2P_ACTIVE || this.cascadeState === CASCADE_STATES.TIER2_TURN_ACTIVE) {
            this._fallbackToWebSocketRelay('connection_disconnected');
          }
        }
      };

      // Create and send SDP Offer
      const offer = await this.peerConn.createOffer();
      await this.peerConn.setLocalDescription(offer);

      if (this.signalingClient && this.activeSessionId) {
        this.signalingClient.send({
          type: 'webrtc:signal',
          payload: {
            sessionId: this.activeSessionId,
            targetBranchId: this.activeBranchId,
            signalType: 'offer',
            data: {
              type: offer.type,
              sdp: offer.sdp
            }
          }
        });
      }
    } catch (err) {
      console.warn('[WebRTC] Error initiating WebRTC session:', err);
      this._fallbackToWebSocketRelay('init_error');
    }
  }

  _setupVideoDataChannel(channel) {
    if (!channel) return;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      this._onDataChannelReady();
    };
    channel.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this._handleBinaryFrame(e.data);
      }
    };
    channel.onclose = () => {
      if (this.cascadeState === CASCADE_STATES.TIER1_P2P_ACTIVE || this.cascadeState === CASCADE_STATES.TIER2_TURN_ACTIVE) {
        this._fallbackToWebSocketRelay('video_channel_closed');
      }
    };
    channel.onerror = (err) => {
      console.warn('[WebRTC] Video DataChannel error:', err);
    };
  }

  _setupControlDataChannel(channel) {
    if (!channel) return;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      this._onDataChannelReady();
    };
    channel.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const view = new Uint8Array(e.data);
        const opcode = view[0];

        // Opcode 0x05: Ping RTT echo
        if (opcode === 0x05) {
          const parsed = parsePingEvent(e.data);
          if (parsed) {
            this._handlePingEcho(parsed.rtt);
          }
          return;
        }

        // Opcode 0x01: Frame on unified channel
        if (opcode === 0x01) {
          this._handleBinaryFrame(e.data);
          return;
        }
      } else if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          this._handleRelayControlMessage(msg);
        } catch (_) {}
      }
    };
    channel.onclose = () => {
      if (this.cascadeState === CASCADE_STATES.TIER1_P2P_ACTIVE || this.cascadeState === CASCADE_STATES.TIER2_TURN_ACTIVE) {
        this._fallbackToWebSocketRelay('control_channel_closed');
      }
    };
    channel.onerror = (err) => {
      console.warn('[WebRTC] Control DataChannel error:', err);
    };
  }

  _onDataChannelReady() {
    this._clearCascadeWatchdog();
    this.isConnected = true;
    this._hideLoader();
    this._startTimers();

    if (this.activeMode === 'control') {
      this._setupInputCapture();
    } else {
      this._teardownInputCapture();
    }

    if (this.cascadeState !== CASCADE_STATES.TIER1_P2P_ACTIVE && this.cascadeState !== CASCADE_STATES.TIER2_TURN_ACTIVE) {
      this._setCascadeState(CASCADE_STATES.TIER1_P2P_ACTIVE, { candidateType: 'host' });
    }

    this._startWebRtcStatsAndPing();

    const wasSwitching = this.isTransportSwitching;
    this.isTransportSwitching = false;

    // Cleanly close previous relayWs if switching to P2P
    if (this.manualTransportPreference === 'p2p' && this.relayWs) {
      try {
        if (this.relayWs.readyState === WebSocket.OPEN) {
          this.relayWs.close(1000, 'Switched to P2P');
        }
      } catch (_) {}
      this.relayWs = null;
    }

    this._updateTransportToggleButton();

    if (wasSwitching && typeof window !== 'undefined' && typeof DashboardUI !== 'undefined' && window.appInstance?.ui?._showToast) {
      window.appInstance.ui._showToast('Conmutado a WebRTC P2P Directo UDP', 'success');
    }
  }

  async _onWebRtcSignal(payload) {
    if (!payload || !this.activeSessionId || payload.sessionId !== this.activeSessionId) return;
    if (!this.peerConn) return;

    const signalType = payload.signalType || payload.data?.type;
    const data = payload.data || payload.signal;

    try {
      if (signalType === 'answer' || data?.type === 'answer') {
        const sdp = data.sdp || data;
        const answerDesc = new RTCSessionDescription(typeof sdp === 'string' ? { type: 'answer', sdp } : sdp);
        await this.peerConn.setRemoteDescription(answerDesc);

        // Flush queued candidates
        while (this.pendingIceCandidates.length > 0) {
          const cand = this.pendingIceCandidates.shift();
          try {
            if (cand.candidate && !cand.candidate.startsWith('candidate:')) {
              cand.candidate = 'candidate:' + cand.candidate;
            }
            await this.peerConn.addIceCandidate(new RTCIceCandidate(cand));
          } catch (cErr) {
            console.warn('[WebRTC] Error adding queued ICE candidate:', cErr);
          }
        }
      } else if (signalType === 'candidate' || data?.candidate) {
        let rawCand = data;
        if (data && typeof data.candidate === 'object' && data.candidate !== null) {
          rawCand = data.candidate;
        }
        let candidateStr = typeof rawCand === 'string' ? rawCand : rawCand?.candidate;
        if (candidateStr) {
          if (!candidateStr.startsWith('candidate:')) {
            candidateStr = 'candidate:' + candidateStr;
          }
          const candObj = {
            candidate: candidateStr,
            sdpMid: rawCand.sdpMid !== undefined && rawCand.sdpMid !== null ? String(rawCand.sdpMid) : '0',
            sdpMLineIndex: rawCand.sdpMLineIndex !== undefined && rawCand.sdpMLineIndex !== null ? Number(rawCand.sdpMLineIndex) : 0
          };
          if (this.peerConn.remoteDescription) {
            try {
              await this.peerConn.addIceCandidate(new RTCIceCandidate(candObj));
            } catch (candErr) {
              console.warn('[WebRTC] Error adding ICE candidate:', candErr);
            }
          } else {
            this.pendingIceCandidates.push(candObj);
          }
        }
      }
    } catch (err) {
      console.warn('[WebRTC] Error handling signal message:', err);
    }
  }

  _onWebRtcError(payload) {
    if (!payload || !this.activeSessionId || payload.sessionId !== this.activeSessionId) return;
    console.warn('[WebRTC] Received signaling error from server:', payload.error);
    this._fallbackToWebSocketRelay('signaling_error');
  }

  _onWebRtcPeerDisconnected(payload) {
    if (!payload || !this.activeSessionId || payload.sessionId !== this.activeSessionId) return;
    console.warn('[WebRTC] Peer disconnected:', payload.reason);
    this._fallbackToWebSocketRelay('peer_disconnected');
  }

  _onWebRtcClose(payload) {
    if (!payload || !this.activeSessionId || payload.sessionId !== this.activeSessionId) return;
    console.warn('[WebRTC] Peer closed WebRTC session');
    this._fallbackToWebSocketRelay('peer_closed');
  }

  _startWebRtcStatsAndPing() {
    this._stopWebRtcStatsAndPing();

    this.statsTimer = setInterval(() => {
      this._inspectActiveConnection();
    }, 1200);
    this._inspectActiveConnection();

    this.pingTimer = setInterval(() => {
      this._sendPingPacket();
    }, 1000);
    this._sendPingPacket();
  }

  _stopWebRtcStatsAndPing() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _sendPingPacket() {
    if (this.controlDataChannel && this.controlDataChannel.readyState === 'open') {
      try {
        const packet = serializePingEvent();
        this.controlDataChannel.send(packet);
      } catch (_) {}
    }
  }

  _handlePingEcho(rtt) {
    if (this.smoothedRtt === null) {
      this.smoothedRtt = rtt;
    } else {
      this.smoothedRtt = this.smoothedRtt * 0.7 + rtt * 0.3;
    }

    if (this.latencyDisplay) {
      this.latencyDisplay.textContent = `${Math.round(this.smoothedRtt)} ms`;
    }

    if (this.cascadeState === CASCADE_STATES.TIER1_P2P_ACTIVE) {
      this._setCascadeState(CASCADE_STATES.TIER1_P2P_ACTIVE, { candidateType: this.activeCandidateType, rtt: this.smoothedRtt });
    } else if (this.cascadeState === CASCADE_STATES.TIER2_TURN_ACTIVE) {
      this._setCascadeState(CASCADE_STATES.TIER2_TURN_ACTIVE, { candidateType: 'relay', rtt: this.smoothedRtt });
    }
  }

  async _inspectActiveConnection() {
    if (!this.peerConn || typeof this.peerConn.getStats !== 'function') return;

    try {
      const stats = await this.peerConn.getStats();
      let activePair = null;
      let localCandidate = null;
      let remoteCandidate = null;

      let selId = null;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selId = report.selectedCandidatePairId;
        }
      });
      activePair = selId ? stats.get(selId) : null;

      if (activePair) {
        if (activePair.localCandidateId) {
          localCandidate = stats.get(activePair.localCandidateId);
        }
        if (activePair.remoteCandidateId) {
          remoteCandidate = stats.get(activePair.remoteCandidateId);
        }

        const localType = localCandidate?.candidateType || '';
        const remoteType = remoteCandidate?.candidateType || '';
        const isRelay = localType === 'relay' || remoteType === 'relay';

        if (activePair.currentRoundTripTime !== undefined) {
          const rttMs = activePair.currentRoundTripTime * 1000;
          this._handlePingEcho(rttMs);
        }

        if (isRelay) {
          this.activeCandidateType = 'relay';
          if (this.cascadeState !== CASCADE_STATES.TIER2_TURN_ACTIVE) {
            this._setCascadeState(CASCADE_STATES.TIER2_TURN_ACTIVE, { candidateType: 'relay', rtt: this.smoothedRtt });
          }
        } else {
          const typeLabel = (localType === 'host' || remoteType === 'host') ? 'host' : 'srflx';
          this.activeCandidateType = typeLabel;
          if (this.cascadeState !== CASCADE_STATES.TIER1_P2P_ACTIVE) {
            this._setCascadeState(CASCADE_STATES.TIER1_P2P_ACTIVE, { candidateType: typeLabel, rtt: this.smoothedRtt });
          }
        }
      }
    } catch (err) {
      console.warn('[WebRTC] getStats error:', err);
    }
  }

  _teardownWebRtc(sendCloseSignal = true) {
    this._clearCascadeWatchdog();
    this._stopWebRtcStatsAndPing();

    if (sendCloseSignal && this.activeSessionId && this.signalingClient) {
      try {
        this.signalingClient.send({
          type: 'webrtc:close',
          payload: {
            sessionId: this.activeSessionId,
            targetBranchId: this.activeBranchId,
            reason: 'user_closed'
          }
        });
      } catch (_) {}
    }

    if (this.videoDataChannel) {
      try { this.videoDataChannel.close(); } catch (_) {}
      this.videoDataChannel = null;
    }

    if (this.controlDataChannel) {
      try { this.controlDataChannel.close(); } catch (_) {}
      this.controlDataChannel = null;
    }

    if (this.peerConn) {
      try { this.peerConn.close(); } catch (_) {}
      this.peerConn = null;
    }

    this.pendingIceCandidates = [];
    this.smoothedRtt = null;
    this.activeCandidateType = null;
  }

  // ==========================================================================
  // UNIFIED INPUT DISPATCHER & STRICT OBSERVE MODE ISOLATION
  // ==========================================================================

  _isInputTransportReady() {
    if (this.activeMode !== 'control') return false;
    return (this.controlDataChannel && this.controlDataChannel.readyState === 'open') ||
           (this.relayWs && this.relayWs.readyState === WebSocket.OPEN);
  }

  _sendAck() {
    const pkt = new Uint8Array([0x06]);
    if (this.controlDataChannel && this.controlDataChannel.readyState === 'open') {
      try { this.controlDataChannel.send(pkt); return; } catch (_) {}
    }
    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      try { this.relayWs.send(pkt); } catch (_) {}
    }
  }

  _sendInputPacket(packet) {
    if (!packet) return false;

    // Strict Observe Mode Isolation: Inputs are completely detached and dropped
    if (this.activeMode !== 'control') {
      return false;
    }

    // Tier 1 & Tier 2: WebRTC Ordered Control DataChannel
    if (this.controlDataChannel && this.controlDataChannel.readyState === 'open') {
      try {
        this.controlDataChannel.send(packet);
        return true;
      } catch (err) {
        console.warn('[Input] Failed sending via controlDataChannel:', err);
      }
    }

    // Tier 3: WebSocket Relay Fallback
    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      try {
        this.relayWs.send(packet);
        return true;
      } catch (err) {
        console.warn('[Input] Failed sending via relayWs:', err);
      }
    }

    return false;
  }

  _openRelayWebSocket(sessionId, mode, token = null) {
    if (typeof WebSocket === 'undefined') return;
    let protocol = 'ws:';
    let host = '127.0.0.1:8080';
    if (typeof window !== 'undefined' && window.location) {
      protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      host = window.location.host;
    }
    const sessionToken = token || this._activeToken || this.masterToken;
    const relayUrl = `${protocol}//${host}/ws/relay?sessionId=${encodeURIComponent(sessionId)}&role=controller&mode=${mode}&token=${encodeURIComponent(sessionToken)}`;

    this.relayWs = new WebSocket(relayUrl);
    this.relayWs.binaryType = 'arraybuffer';

    this.relayWs.onopen = () => {
      this._updateLoaderText('Conectado al relay. Esperando transmisión de la estación de caja...');
    };

    this.relayWs.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          this._handleRelayControlMessage(msg);
        } catch (_) {}
      } else if (event.data instanceof ArrayBuffer) {
        this._handleBinaryFrame(event.data);
      }
    };

    this.relayWs.onclose = (event) => {
      if (this.cascadeState === CASCADE_STATES.TIER3_WS_ACTIVE) {
        this._teardownInputCapture();
        this.isConnected = false;
        this._updateLoaderText(`Sesión finalizada (código ${event.code})`);
      }
    };

    this.relayWs.onerror = () => {
      if (this.cascadeState === CASCADE_STATES.TIER3_WS_ACTIVE || this.cascadeState === CASCADE_STATES.FALLBACK_PENDING) {
        this._updateLoaderText('Error en canal de relay');
      }
    };
  }

  _handleRelayControlMessage(msg) {
    // Truco #2: Dynamic Cursor Shape Update from remote host
    if ((msg.type === 'cursor:shape' || msg.type === 'cursor_shape') && msg.shape) {
      if (this.canvas && this.activeMode === 'control') {
        this.canvas.style.cursor = msg.shape;
      }
      return;
    }

    if (msg.type === 'relay:status') {
      if (msg.status === 'ready') {
        this.isConnected = true;
        this._hideLoader();
        this._startTimers();

        if (this.activeMode === 'control') {
          this._setupInputCapture();
        } else {
          this._teardownInputCapture();
        }

        this._setCascadeState(CASCADE_STATES.TIER3_WS_ACTIVE);
      } else if (msg.status === 'waiting_peer') {
        this._updateLoaderText('Esperando respuesta de la estación remota en relay...');
      } else if (msg.status === 'peer_disconnected') {
        this._updateLoaderText('La estación remota se ha desconectado');
        setTimeout(() => this.stopSession(), 1200);
      }
    }
  }

  _handleBinaryFrame(buffer) {
    if (buffer.byteLength < 1) return;
    const view = new Uint8Array(buffer);
    const opcode = view[0];

    // Opcode 0x01: Video Frame (JPEG / WebP)
    if (opcode === 0x01) {
      // Truco #3: Zero-Buffer Queue (Drop stale frames)
      // Si el decodificador o la GPU están ocupados pintando el cuadro anterior,
      // nunca encolamos este cuadro. Guardamos el buffer más reciente (reemplazando
      // cualquier cuadro pendiente) y descartamos los cuadros viejos intermedios.
      if (this.isDecodingFrame) {
        this.droppedFramesCount++;
        this.latestPendingBuffer = buffer;
        this._sendAck();
        return;
      }

      this._decodeAndRenderFrame(buffer);
    }
  }

  _storeFrameAndRender(sourceImage, width, height) {
    if (!this.canvas || !this.ctx) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this._fitCanvasToViewport();
    }
    this.ctx.drawImage(sourceImage, 0, 0, width, height);
    this._updateVirtualCursorVisual();
  }

  async _decodeAndRenderFrame(buffer) {
    this.isDecodingFrame = true;
    try {
      this.frameCount++;
      const imageBytes = new Uint8Array(buffer, 1);
      const blob = new Blob([imageBytes], { type: 'image/jpeg' });

      if (window.createImageBitmap) {
        const bitmap = await createImageBitmap(blob);
        this._storeFrameAndRender(bitmap, bitmap.width, bitmap.height);
        bitmap.close();
      } else {
        await new Promise((resolve) => {
          const img = new Image();
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            this._storeFrameAndRender(img, img.width, img.height);
            URL.revokeObjectURL(url);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          img.src = url;
        });
      }
    } catch (_) {}
    finally {
      this.isDecodingFrame = false;
      this._sendAck();
      // Si llegó un cuadro más fresco mientras decodificábamos, lo procesamos de inmediato
      if (this.latestPendingBuffer) {
        const nextBuf = this.latestPendingBuffer;
        this.latestPendingBuffer = null;
        this._decodeAndRenderFrame(nextBuf);
      }
    }
  }

  /**
   * Input Capture: Bound strictly in [ Controlar ] Mode
   */
  _setupInputCapture() {
    if (!this.canvas) return;
    this._teardownInputCapture();

    this.canvas.tabIndex = 0;
    this.canvas.focus();
    this.canvas.style.cursor = 'default';

    this.canvas.addEventListener('mousemove', this._boundOnMouseMove, { passive: false });
    this.canvas.addEventListener('mousedown', this._boundOnMouseDown, { passive: false });
    this.canvas.addEventListener('mouseup', this._boundOnMouseUp, { passive: false });
    this.canvas.addEventListener('wheel', this._boundOnWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._boundOnContextMenu, { passive: false });
    const touchTarget = this.canvas.parentElement || this.canvas;
    touchTarget.addEventListener('touchstart', this._boundOnTouchStart, { passive: false });
    touchTarget.addEventListener('touchmove', this._boundOnTouchMove, { passive: false });
    touchTarget.addEventListener('touchend', this._boundOnTouchEnd, { passive: false });
    touchTarget.addEventListener('touchcancel', this._boundOnTouchCancel, { passive: false });
    if (this._isMobileTouchUser()) {
      setTimeout(() => this._updateVirtualCursorVisual(), 50);
    }

    window.addEventListener('keydown', this._boundOnKeyDown, { passive: false });
    window.addEventListener('keyup', this._boundOnKeyUp, { passive: false });
  }

  /**
   * Detach all inputs: Enforced in [ Observar ] Mode and on teardown
   */
  _teardownInputCapture() {
    if (!this.canvas) return;
    this.canvas.style.cursor = 'default';

    this.canvas.removeEventListener('mousemove', this._boundOnMouseMove);
    this.canvas.removeEventListener('mousedown', this._boundOnMouseDown);
    this.canvas.removeEventListener('mouseup', this._boundOnMouseUp);
    this.canvas.removeEventListener('wheel', this._boundOnWheel);
    this.canvas.removeEventListener('contextmenu', this._boundOnContextMenu);
    const touchTarget = this.canvas.parentElement || this.canvas;
    touchTarget.removeEventListener('touchstart', this._boundOnTouchStart);
    touchTarget.removeEventListener('touchmove', this._boundOnTouchMove);
    touchTarget.removeEventListener('touchend', this._boundOnTouchEnd);
    touchTarget.removeEventListener('touchcancel', this._boundOnTouchCancel);
    this.canvas.removeEventListener('touchstart', this._boundOnTouchStart);
    this.canvas.removeEventListener('touchmove', this._boundOnTouchMove);
    this.canvas.removeEventListener('touchend', this._boundOnTouchEnd);
    this.canvas.removeEventListener('touchcancel', this._boundOnTouchCancel);
    if (this._touchLongPressTimer) {
      clearTimeout(this._touchLongPressTimer);
      this._touchLongPressTimer = null;
    }
    const touchPointer = document.getElementById('virtual-touch-cursor');
    if (touchPointer) touchPointer.remove();

    window.removeEventListener('keydown', this._boundOnKeyDown);
    window.removeEventListener('keyup', this._boundOnKeyUp);
  }

  _onMouseMove(e) {
    if (!this.isConnected || this.activeMode !== 'control') return;
    this._isUsingTouch = false;
    const pointer = document.getElementById('virtual-touch-cursor');
    if (pointer && pointer.style.display !== 'none') {
      pointer.style.display = 'none';
    }
    e.preventDefault();

    const now = performance.now();
    if (!this._lastMouseMoveTime) this._lastMouseMoveTime = 0;

    // Rate-limit to ~30 events/sec (every ~33 ms) to prevent TCP bufferbloat against 15 FPS video
    if (now - this._lastMouseMoveTime < 33) {
      this.lastMouseMoveEvent = e;
      if (!this._mouseThrottleTimer) {
        this._mouseThrottleTimer = setTimeout(() => {
          this._mouseThrottleTimer = null;
          if (this.lastMouseMoveEvent && this.isConnected && this.activeMode === 'control') {
            this._lastMouseMoveTime = performance.now();
            this._sendMouseEventFromDOM(this.lastMouseMoveEvent, 0);
            this.lastMouseMoveEvent = null;
          }
        }, 33 - (now - this._lastMouseMoveTime));
      }
      return;
    }

    this._lastMouseMoveTime = now;
    this._sendMouseEventFromDOM(e, 0);
  }

  _onMouseDown(e) {
    if (!this.isConnected || this.activeMode !== 'control') return;
    e.preventDefault();
    this.canvas?.focus();
    this._showClickFeedback(e.clientX, e.clientY);
    this._sendMouseEventFromDOM(e, 1);
  }

  _showClickFeedback(clientX, clientY) {
    const dot = document.createElement('div');
    dot.className = 'vd-click-ripple';
    dot.style.left = `${clientX}px`;
    dot.style.top = `${clientY}px`;
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 290);
  }

  _onMouseUp(e) {
    if (!this.isConnected || this.activeMode !== 'control') return;
    e.preventDefault();
    this._sendMouseEventFromDOM(e, 2);
  }

  _onWheel(e) {
    if (!this.isConnected || this.activeMode !== 'control') return;
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      this.setZoom(this.zoomLevel + delta);
      return;
    }
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : (e.deltaY > 0 ? -1 : 0);
    this._sendMouseEventFromDOM(e, 3, delta);
  }

  _onContextMenu(e) {
    if (this.activeMode === 'control') {
      e.preventDefault();
    }
  }

  _sendMouseEventFromDOM(e, eventType, wheelDelta = 0) {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const normX = Math.round((Math.max(0, Math.min(clientX, rect.width)) / (rect.width || 1)) * 65535);
    const normY = Math.round((Math.max(0, Math.min(clientY, rect.height)) / (rect.height || 1)) * 65535);

    let buttons = 0;
    if (eventType === 0) {
      buttons = e.buttons & 0x07;
    } else {
      if (e.button === 0) buttons = 0x01;
      else if (e.button === 2) buttons = 0x02;
      else if (e.button === 1) buttons = 0x04;
    }

    const packet = serializeMouseEvent(eventType, normX, normY, buttons, wheelDelta);
    this._sendInputPacket(packet);
  }

  _onKeyDown(e) {
    if (!this.isConnected || this.activeMode !== 'control') return;
    if (document.activeElement !== this.canvas && !this.modal?.contains(document.activeElement)) return;

    if (e.key !== 'F12') {
      e.preventDefault();
    }

    const vkCode = VK_MAP[e.code] || e.keyCode || 0;
    const modifiers = this._computeModifiers(e);

    const packet = serializeKeyboardEvent(0, vkCode, modifiers);
    this._sendInputPacket(packet);
  }

  _onKeyUp(e) {
    if (!this.isConnected || this.activeMode !== 'control') return;
    if (document.activeElement !== this.canvas && !this.modal?.contains(document.activeElement)) return;

    if (e.key !== 'F12') {
      e.preventDefault();
    }

    const vkCode = VK_MAP[e.code] || e.keyCode || 0;
    const modifiers = this._computeModifiers(e);

    const packet = serializeKeyboardEvent(1, vkCode, modifiers);
    this._sendInputPacket(packet);
  }

  
  _onTouchStart(e) {
    if (!this.isConnected) return;
    this._isUsingTouch = true;

    // 2-Finger Touch: Pinch-to-Zoom Gesture (Internal canvas scale)
    if (e.touches.length === 2) {
      e.preventDefault();
      this._isPinching = true;
      if (this._touchLongPressTimer) {
        clearTimeout(this._touchLongPressTimer);
        this._touchLongPressTimer = null;
      }
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      this._pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      this._pinchStartZoom = this.zoomLevel;
      this._pinchStartPanX = this.zoomPanX;
      this._pinchStartPanY = this.zoomPanY;

      const viewport = document.getElementById('session-viewport');
      const vRect = viewport ? viewport.getBoundingClientRect() : { left: 0, top: 0, width: 360, height: 500 };
      const midScreenX = (t1.clientX + t2.clientX) / 2;
      const midScreenY = (t1.clientY + t2.clientY) / 2;

      this._pinchMidViewportX = midScreenX - vRect.left;
      this._pinchMidViewportY = midScreenY - vRect.top;

      const vw = vRect.width || 360;
      const S0 = Math.max(0.1, this._pinchStartZoom);
      // Canvas origin is center top:
      // screenX = (vw / 2) + panX + S * cx => cx = (midX - (vw / 2) - panX) / S
      // screenY = panY + S * cy => cy = (midY - panY) / S
      this._pinchCanvasFocalX = (this._pinchMidViewportX - (vw / 2) - this._pinchStartPanX) / S0;
      this._pinchCanvasFocalY = (this._pinchMidViewportY - this._pinchStartPanY) / S0;

      if (this.canvas) {
        this.canvas.style.transition = 'none';
      }
      return;
    }

    if (e.touches.length !== 1) return;
    e.preventDefault();

    const touch = e.touches[0];
    this._touchStartX = touch.clientX;
    this._touchStartY = touch.clientY;
    this._lastTouchX = touch.clientX;
    this._lastTouchY = touch.clientY;
    this._touchStartTime = performance.now();
    this._touchMoved = false;
    this._touchLongPressFired = false;

    if (this._touchLongPressTimer) {
      clearTimeout(this._touchLongPressTimer);
      this._touchLongPressTimer = null;
    }

    // 500ms Long Press = Right Click (AnyDesk style - only in control mode)
    if (this.activeMode === 'control') {
      this._touchLongPressTimer = setTimeout(() => {
        this._touchLongPressTimer = null;
        if (!this._touchMoved && this.isConnected && this.activeMode === 'control') {
          this._touchLongPressFired = true;
          const pDown = serializeMouseEvent(1, this.virtualCursorX, this.virtualCursorY, 0x02, 0);
          this._sendInputPacket(pDown);
          setTimeout(() => {
            const pUp = serializeMouseEvent(2, this.virtualCursorX, this.virtualCursorY, 0x02, 0);
            this._sendInputPacket(pUp);
          }, 50);

          if (navigator.vibrate) {
            try { navigator.vibrate(50); } catch (_) {}
          }
          if (this.canvas) {
            const rect = this.canvas.getBoundingClientRect();
            const normX = this.virtualCursorX / 65535;
            const normY = this.virtualCursorY / 65535;
            const screenX = rect.left + normX * rect.width;
            const screenY = rect.top + normY * rect.height;
            this._showClickFeedback(screenX, screenY);
          }
        }
      }, 500);
    }
  }

  _onTouchMove(e) {
    if (!this.isConnected) return;

    // Handle 2-Finger Pinch Zoom & Pan centered on touch focal point
    if (e.touches.length === 2 && this._isPinching) {
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const midScreenX = (t1.clientX + t2.clientX) / 2;
      const midScreenY = (t1.clientY + t2.clientY) / 2;

      const viewport = document.getElementById('session-viewport');
      const vRect = viewport ? viewport.getBoundingClientRect() : { left: 0, top: 0, width: 360, height: 500 };
      const curMidViewportX = midScreenX - vRect.left;
      const curMidViewportY = midScreenY - vRect.top;

      const scaleRatio = dist / Math.max(10, this._pinchStartDist);
      const newZoom = Math.max(1.0, Math.min(3.5, Math.round(this._pinchStartZoom * scaleRatio * 100) / 100));

      const vw = vRect.width || 360;
      const vh = vRect.height || 500;
      const cw = this.canvas ? (this.canvas.offsetWidth || 360) : 360;
      const ch = this.canvas ? (this.canvas.offsetHeight || 200) : 200;

      let newPanX = 0;
      let newPanY = 0;

      if (newZoom > 1.0) {
        // Keep initial canvas focal point under current fingers midpoint
        newPanX = curMidViewportX - (vw / 2) - (newZoom * this._pinchCanvasFocalX);
        newPanY = curMidViewportY - (newZoom * this._pinchCanvasFocalY);

        const sw = cw * newZoom;
        const sh = ch * newZoom;
        const maxPanX = Math.max(0, (sw - vw) / 2);
        const minPanY = Math.min(0, vh - sh);

        newPanX = Math.max(-maxPanX, Math.min(maxPanX, newPanX));
        newPanY = Math.max(minPanY, Math.min(0, newPanY));
      }

      this.zoomLevel = newZoom;
      this.zoomPanX = newPanX;
      this.zoomPanY = newPanY;

      // Drag virtual cursor smoothly into safe margins if moved outside
      if (newZoom > 1.0) {
        this._dragCursorIntoVisibleMargins(vw, vh, cw, ch);
      }

      this._applyZoomTransform();
      return;
    }

    if (e.touches.length !== 1) return;
    e.preventDefault();

    const touch = e.touches[0];
    const dx = touch.clientX - this._lastTouchX;
    const dy = touch.clientY - this._lastTouchY;

    const totalDist = Math.hypot(touch.clientX - this._touchStartX, touch.clientY - this._touchStartY);
    if (totalDist > 8) {
      this._touchMoved = true;
      if (this._touchLongPressTimer) {
        clearTimeout(this._touchLongPressTimer);
        this._touchLongPressTimer = null;
      }
    }

    this._lastTouchX = touch.clientX;
    this._lastTouchY = touch.clientY;

    // In observe mode: 1-finger drag allows panning if zoomed in
    if (this.activeMode !== 'control') {
      if (this.zoomLevel > 1.0) {
        const viewport = document.getElementById('session-viewport');
        const vw = viewport?.clientWidth || 360;
        const vh = viewport?.clientHeight || 500;
        const cw = this.canvas ? (this.canvas.offsetWidth || 360) : 360;
        const ch = this.canvas ? (this.canvas.offsetHeight || 200) : 200;
        const maxPanX = Math.max(0, (cw * this.zoomLevel - vw) / 2);
        const minPanY = Math.min(0, vh - ch * this.zoomLevel);
        this.zoomPanX = Math.max(-maxPanX, Math.min(maxPanX, this.zoomPanX + dx));
        this.zoomPanY = Math.max(minPanY, Math.min(0, this.zoomPanY + dy));
        this._applyZoomTransform();
      }
      return;
    }

    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleFactor = 65535 / Math.max(rect.width, 300);

    // AnyDesk relative displacement:
    this.virtualCursorX = Math.round(Math.max(0, Math.min(65535, this.virtualCursorX + (dx * scaleFactor))));
    this.virtualCursorY = Math.round(Math.max(0, Math.min(65535, this.virtualCursorY + (dy * scaleFactor))));

    const packet = serializeMouseEvent(0, this.virtualCursorX, this.virtualCursorY, 0, 0);
    this._sendInputPacket(packet);

    if (this.zoomLevel > 1.0) {
      this._clampCameraToCursorMargins();
      this._applyZoomTransform();
    } else {
      this._updateVirtualCursorVisual(rect);
    }
  }

  _onTouchEnd(e) {
    if (e.touches.length < 2) {
      if (this._isPinching) {
        this._isPinching = false;
        if (this.canvas) {
          this.canvas.style.transition = '';
        }
      }
    }
    if (!this.isConnected) return;
    e.preventDefault();

    if (this._touchLongPressTimer) {
      clearTimeout(this._touchLongPressTimer);
      this._touchLongPressTimer = null;
    }

    if (this._touchLongPressFired) {
      this._touchLongPressFired = false;
      return;
    }

    const now = performance.now();
    const elapsed = now - (this._touchStartTime || 0);
    if (!this._touchMoved && elapsed < 250) {
      if (now - (this._lastTapTime || 0) < 320) {
        // Double-Tap (<320ms): Remote Double-Click (AnyDesk style - zoom is handled via pinch)
        this._lastTapTime = 0;
        if (this.activeMode === 'control') {
          const pDown1 = serializeMouseEvent(1, this.virtualCursorX, this.virtualCursorY, 0x01, 0);
          const pUp1 = serializeMouseEvent(2, this.virtualCursorX, this.virtualCursorY, 0x01, 0);
          const pDown2 = serializeMouseEvent(1, this.virtualCursorX, this.virtualCursorY, 0x01, 0);
          const pUp2 = serializeMouseEvent(2, this.virtualCursorX, this.virtualCursorY, 0x01, 0);

          this._sendInputPacket(pDown1);
          setTimeout(() => this._sendInputPacket(pUp1), 25);
          setTimeout(() => this._sendInputPacket(pDown2), 60);
          setTimeout(() => this._sendInputPacket(pUp2), 85);

          if (navigator.vibrate) {
            try { navigator.vibrate([30, 40, 30]); } catch (_) {}
          }
          if (this.canvas) {
            const rect = this.canvas.getBoundingClientRect();
            const normX = this.virtualCursorX / 65535;
            const normY = this.virtualCursorY / 65535;
            const screenX = rect.left + normX * rect.width;
            const screenY = rect.top + normY * rect.height;
            this._showClickFeedback(screenX, screenY);
            setTimeout(() => this._showClickFeedback(screenX, screenY), 70);
          }
        }
        return;
      }
      this._lastTapTime = now;

      // Single Tap (<250ms) = Left Click (AnyDesk style - only in control mode)
      if (this.activeMode === 'control') {
        const pDown = serializeMouseEvent(1, this.virtualCursorX, this.virtualCursorY, 0x01, 0);
        this._sendInputPacket(pDown);
        setTimeout(() => {
          const pUp = serializeMouseEvent(2, this.virtualCursorX, this.virtualCursorY, 0x01, 0);
          this._sendInputPacket(pUp);
        }, 40);

        if (this.canvas) {
          const rect = this.canvas.getBoundingClientRect();
          const normX = this.virtualCursorX / 65535;
          const normY = this.virtualCursorY / 65535;
          const screenX = rect.left + normX * rect.width;
          const screenY = rect.top + normY * rect.height;
          this._showClickFeedback(screenX, screenY);
        }
      }
    }
  }

  _onTouchCancel() {
    this._isPinching = false;
    if (this.canvas) {
      this.canvas.style.transition = '';
    }
    if (this._touchLongPressTimer) {
      clearTimeout(this._touchLongPressTimer);
      this._touchLongPressTimer = null;
    }
  }

  _updateVirtualCursorVisual(rect) {
    if (!this._isMobileTouchUser()) {
      const pointer = document.getElementById('virtual-touch-cursor');
      if (pointer) pointer.style.display = 'none';
      return;
    }

    let pointer = document.getElementById('virtual-touch-cursor');
    if (!pointer) {
      pointer = document.createElement('div');
      pointer.id = 'virtual-touch-cursor';
      pointer.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="#3b82f6" stroke="#ffffff" stroke-width="1.5" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6)); pointer-events: none;"><polygon points="3 3 10 21 14 13 22 9 3 3"/></svg>';
      this.canvas?.parentElement?.appendChild(pointer);
    }
    if (!this.canvas) return;

    const r = rect || this.canvas.getBoundingClientRect();
    const parent = this.canvas?.parentElement;
    const pRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };

    const normX = this.virtualCursorX / 65535;
    const normY = this.virtualCursorY / 65535;

    const left = (r.left - pRect.left) + normX * r.width;
    const top = (r.top - pRect.top) + normY * r.height;
    pointer.style.left = `${left}px`;
    pointer.style.top = `${top}px`;
    pointer.style.display = 'block';
  }

  _computeModifiers(e) {
    let mask = 0;
    if (e.ctrlKey) mask |= 0x01;
    if (e.shiftKey) mask |= 0x02;
    if (e.altKey) mask |= 0x04;
    if (e.metaKey) mask |= 0x08;
    if (e.getModifierState && e.getModifierState('CapsLock')) mask |= 0x10;
    return mask;
  }

  _injectShortcutKey(keyName) {
    if (!this._isInputTransportReady()) return;

    const finalize = () => {
      setTimeout(() => {
        this._releaseAllModifiers();
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeMouseEvent(2, 32768, 32768, 0, 0));
        }
        if (this.canvas) this.canvas.focus();
      }, 90);
    };

    if (keyName === 'ctrl-alt-del') {
      this._sendInputPacket(serializeKeyboardEvent(0, 0x11, 0x01)); // Ctrl down
      this._sendInputPacket(serializeKeyboardEvent(0, 0x12, 0x05)); // Alt down
      this._sendInputPacket(serializeKeyboardEvent(0, 0x2E, 0x05)); // Del down
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x2E, 0x05));
          this._sendInputPacket(serializeKeyboardEvent(1, 0x12, 0x01));
          this._sendInputPacket(serializeKeyboardEvent(1, 0x11, 0x00));
        }
        finalize();
      }, 70);
    } else if (keyName === 'task-mgr') {
      // Ctrl+Shift+Esc (Task Manager)
      this._sendInputPacket(serializeKeyboardEvent(0, 0x11, 0x01)); // Ctrl down
      this._sendInputPacket(serializeKeyboardEvent(0, 0x10, 0x03)); // Shift down
      this._sendInputPacket(serializeKeyboardEvent(0, 0x1B, 0x03)); // Esc down
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x1B, 0x03));
          this._sendInputPacket(serializeKeyboardEvent(1, 0x10, 0x01));
          this._sendInputPacket(serializeKeyboardEvent(1, 0x11, 0x00));
        }
        finalize();
      }, 70);
    } else if (keyName === 'win-d') {
      // Win+D (Show Desktop)
      this._sendInputPacket(serializeKeyboardEvent(0, 0x5B, 0x08));
      this._sendInputPacket(serializeKeyboardEvent(0, 0x44, 0x08));
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x44, 0x08));
          this._sendInputPacket(serializeKeyboardEvent(1, 0x5B, 0x00));
        }
        finalize();
      }, 70);
    } else if (keyName === 'win-r') {
      // Win+R (Run Dialog)
      this._sendInputPacket(serializeKeyboardEvent(0, 0x5B, 0x08));
      this._sendInputPacket(serializeKeyboardEvent(0, 0x52, 0x08));
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x52, 0x08));
          this._sendInputPacket(serializeKeyboardEvent(1, 0x5B, 0x00));
        }
        finalize();
      }, 70);
    } else if (keyName === 'win') {
      this._sendInputPacket(serializeKeyboardEvent(0, 0x5B, 0x08));
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x5B, 0x00));
        }
        finalize();
      }, 70);
    } else if (keyName === 'alt-tab') {
      this._sendInputPacket(serializeKeyboardEvent(0, 0x12, 0x04)); // Alt down
      this._sendInputPacket(serializeKeyboardEvent(0, 0x09, 0x04)); // Tab down
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x09, 0x04));
          this._sendInputPacket(serializeKeyboardEvent(1, 0x12, 0x00));
        }
        finalize();
      }, 70);
    } else if (keyName === 'esc') {
      this._sendInputPacket(serializeKeyboardEvent(0, 0x1B, 0));
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x1B, 0));
        }
        finalize();
      }, 70);
    } else if (keyName === 'caps-lock') {
      this._sendInputPacket(serializeKeyboardEvent(0, 0x14, 0));
      setTimeout(() => {
        if (this._isInputTransportReady()) {
          this._sendInputPacket(serializeKeyboardEvent(1, 0x14, 0));
        }
        finalize();
      }, 70);
    } else if (keyName && keyName.startsWith('custom:')) {
      const idx = parseInt(keyName.split(':')[1], 10);
      let custom = [];
      try { custom = JSON.parse(localStorage.getItem('vd_custom_shortcuts') || '[]'); } catch (_) {}
      const item = custom[idx];
      if (item && item.keys) {
        this._executeCustomKeyCombo(item.keys);
      }
      finalize();
    }
  }

  _executeCustomKeyCombo(comboStr) {
    if (!this._isInputTransportReady()) return;
    const parts = comboStr.split('+').map(p => p.trim().toUpperCase());
    const vks = [];
    parts.forEach(p => {
      if (p === 'CTRL' || p === 'CONTROL') vks.push(0x11);
      else if (p === 'ALT') vks.push(0x12);
      else if (p === 'SHIFT') vks.push(0x10);
      else if (p === 'WIN' || p === 'WINDOWS') vks.push(0x5B);
      else if (p === 'ESC' || p === 'ESCAPE') vks.push(0x1B);
      else if (p === 'ENTER') vks.push(0x0D);
      else if (p === 'TAB') vks.push(0x09);
      else if (p === 'DEL' || p === 'DELETE' || p === 'SUPR') vks.push(0x2E);
      else if (p.startsWith('F') && p.length <= 3) {
        const fn = parseInt(p.substring(1), 10);
        if (fn >= 1 && fn <= 12) vks.push(0x70 + fn - 1);
      } else if (p.length === 1) {
        vks.push(p.charCodeAt(0));
      }
    });

    // Send KeyDown for all
    vks.forEach(vk => this._sendInputPacket(serializeKeyboardEvent(0, vk, 0)));
    setTimeout(() => {
      if (this._isInputTransportReady()) {
        // Send KeyUp in reverse order
        for (let i = vks.length - 1; i >= 0; i--) {
          this._sendInputPacket(serializeKeyboardEvent(1, vks[i], 0));
        }
      }
      this._releaseAllModifiers();
      if (this.canvas) this.canvas.focus();
    }, 80);
  }

  _releaseAllModifiers() {
    if (!this._isInputTransportReady()) return;
    this._sendInputPacket(serializeKeyboardEvent(1, 0x11, 0));
    this._sendInputPacket(serializeKeyboardEvent(1, 0x12, 0));
    this._sendInputPacket(serializeKeyboardEvent(1, 0x10, 0));
    this._sendInputPacket(serializeKeyboardEvent(1, 0x5B, 0));
    if (this.canvas) this.canvas.focus();
  }

  _renderCustomShortcuts() {
    const slot = document.getElementById('custom-shortcuts-slot');
    if (!slot) return;
    slot.innerHTML = '';
    let custom = [];
    try { custom = JSON.parse(localStorage.getItem('vd_custom_shortcuts') || '[]'); } catch (_) {}
    custom.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-xs btn-shortcut';
      btn.setAttribute('data-key', `custom:${idx}`);
      btn.title = `Atajo: ${item.name} (${item.keys}) - Clic derecho para borrar`;
      btn.textContent = item.name;
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (confirm(`¿Eliminar atajo personalizado "${item.name}"?`)) {
          custom.splice(idx, 1);
          localStorage.setItem('vd_custom_shortcuts', JSON.stringify(custom));
          this._renderCustomShortcuts();
        }
      });
      slot.appendChild(btn);
    });
  }

  _promptAddCustomShortcut() {
    const name = prompt('Nombre o etiqueta del atajo (ej: Explorador, Cerrar, Tareas):');
    if (!name || !name.trim()) return;
    const combo = prompt('Combinación de teclas (ej: Win+E, Alt+F4, Ctrl+C, Ctrl+V, F5):');
    if (!combo || !combo.trim()) return;
    let custom = [];
    try { custom = JSON.parse(localStorage.getItem('vd_custom_shortcuts') || '[]'); } catch (_) {}
    custom.push({ name: name.trim(), keys: combo.trim() });
    localStorage.setItem('vd_custom_shortcuts', JSON.stringify(custom));
    this._renderCustomShortcuts();
    if (this.canvas) this.canvas.focus();
  }

  injectText(text) {
    if (!this._isInputTransportReady()) {
      this._showToast('Sesión no conectada para enviar texto', 'error');
      return;
    }
    if (!text) return;
    this._sendInputPacket(serializeTextEvent(text));
    if (this.canvas) this.canvas.focus();
  }

  _promptInjectText() {
    const text = prompt('Ingrese el texto para escribir en la PC remota:\n(Asegúrese de haber hecho clic primero en el recuadro de texto deseado)');
    if (!text) return;
    this.injectText(text);
    this._showToast('Texto inyectado en la pantalla', 'success');
  }

  _promptAddTextMacro() {
    const name = prompt('Nombre o etiqueta del botón rápido (ej: Clave Admin, Mi Correo, Facturación):');
    if (!name || !name.trim()) return;
    const text = prompt(`Texto exacto que se escribirá al pulsar "${name.trim()}":`);
    if (!text) return;
    let macros = [];
    try { macros = JSON.parse(localStorage.getItem('vd_text_macros') || '[]'); } catch (_) {}
    macros.push({ name: name.trim(), text: text });
    localStorage.setItem('vd_text_macros', JSON.stringify(macros));
    this._renderTextMacros();
    if (this.canvas) this.canvas.focus();
    this._showToast(`Botón de texto "${name.trim()}" agregado`, 'success');
  }

  _renderTextMacros() {
    const slot = document.getElementById('custom-macros-slot');
    if (!slot) return;
    slot.innerHTML = '';
    let macros = [];
    try { macros = JSON.parse(localStorage.getItem('vd_text_macros') || '[]'); } catch (_) {}
    macros.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-xs btn-shortcut';
      btn.style.color = '#a7f3d0';
      btn.style.borderColor = 'rgba(16, 185, 129, 0.45)';
      btn.setAttribute('data-macro-idx', idx);
      btn.title = `Texto: "${item.text.length > 30 ? item.text.substring(0, 30) + '...' : item.text}" - Clic para escribir, clic derecho para eliminar`;
      btn.textContent = item.name;

      // Single-click writes text directly to focused remote input field!
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.blur();
        this.injectText(item.text);
        this._showToast(`Escribiendo: "${item.name}"`, 'success');
      });

      // Right-click deletes the macro
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (confirm(`¿Eliminar macro de texto "${item.name}"?`)) {
          macros.splice(idx, 1);
          localStorage.setItem('vd_text_macros', JSON.stringify(macros));
          this._renderTextMacros();
        }
      });
      slot.appendChild(btn);
    });
  }

  stopSession() {
    this._setCascadeState(CASCADE_STATES.TERMINATING);
    const sessionId = this.activeSessionId;
    const branchId = this.activeBranchId;

    this._teardownInputCapture();
    this.setZoom(1.0);
    this._stopTimers();
    this._clearCascadeWatchdog();
    this._stopWebRtcStatsAndPing();

    if (sessionId && branchId && this.signalingClient) {
      this.signalingClient.send({
        type: 'session:stop',
        payload: {
          sessionId: sessionId,
          targetBranchId: branchId,
        },
      });
    }

    this._teardownWebRtc(true);

    if (this.relayWs) {
      try {
        if (this.relayWs.readyState === WebSocket.OPEN || this.relayWs.readyState === WebSocket.CONNECTING) {
          this.relayWs.close(1000, 'User closed session');
        }
      } catch (_) {}
      this.relayWs = null;
    }

    this.activeSessionId = null;
    this.activeBranchId = null;
    this.activeMode = null;
    this.isConnected = false;
    this._activeToken = null;
    this.manualTransportPreference = null;
    this.isTransportSwitching = false;
    this._setCascadeState(CASCADE_STATES.IDLE);
    this._hideModal();
  }

  _showModal(branchId, mode, branch) {
    if (!this.modal) return;
    this.modal.classList.add('active');
    if (typeof this.modal.showModal === 'function' && !this.modal.open) {
      try { this.modal.showModal(); } catch (_) { this.modal.setAttribute('open', ''); }
    } else {
      this.modal.setAttribute('open', '');
    }
    document.body.style.overflow = 'hidden';

    if (this.modalTitle) {
      this.modalTitle.textContent = branch?.name || branchId;
    }
    if (this.modalAlias) {
      this.modalAlias.textContent = branch?.alias || `AQP-${branchId.toUpperCase()}`;
    }
    if (this.modalMachineId) {
      this.modalMachineId.textContent = formatMachineId(branch?.machineId);
    }

    if (mode === 'observe') {
      this.modal.classList.add('mode-observe');
      this.modal.classList.remove('mode-control');
      if (this.modalModeBanner) {
        this.modalModeBanner.className = 'modal-mode-banner mode-observe';
      }
      if (this.modalModeIcon) // modalModeIcon handled by SVG
      if (this.modalModeTitle) {
        this.modalModeTitle.textContent = 'MODO OBSERVADOR (AUDITORÍA PASIVA - PERIFÉRICOS DESCONECTADOS)';
      }
      if (this.modalInstructions) {
        this.modalInstructions.textContent = 'Auditoría pasiva activa: mouse y teclado deshabilitados para no interrumpir al cajero.';
      }
    } else {
      this.modal.classList.remove('mode-observe');
      this.modal.classList.add('mode-control');
      if (this.modalModeBanner) {
        this.modalModeBanner.className = 'modal-mode-banner mode-control';
      }
      if (this.modalModeIcon) // modalModeIcon handled by SVG
      if (this.modalModeTitle) {
        this.modalModeTitle.textContent = 'MODO CONTROL REMOTO ACTIVO';
      }
      if (this.modalInstructions) {
        this.modalInstructions.textContent = 'Control total activo: interactúe con el mouse y teclado directamente sobre el visor.';
      }
    }

    if (this.latencyDisplay && branch) {
      this.latencyDisplay.textContent = `${branch.latencyMs || 0} ms`;
    }

    this._showLoader('Conectando canal de relay seguro con la sucursal...');
    setTimeout(() => this._fitCanvasToViewport(), 50);
  }

  _hideModal() {
    if (!this.modal) return;
    this.modal.classList.remove('active', 'mode-observe', 'mode-control');
    if (typeof this.modal.close === 'function' && this.modal.open) {
      try { this.modal.close(); } catch (_) { this.modal.removeAttribute('open'); }
    } else {
      this.modal.removeAttribute('open');
    }
    document.body.style.overflow = '';
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (this._offscreenCanvas) {
      const offCtx = this._offscreenCanvas.getContext('2d');
      offCtx?.clearRect(0, 0, this._offscreenCanvas.width, this._offscreenCanvas.height);
    }
    this._currentCrop = null;
  }

  _showLoader(text) {
    if (this.modalLoader) {
      this.modalLoader.classList.remove('hidden');
    }
    if (this.modalLoaderText) {
      this.modalLoaderText.textContent = text;
    }
  }

  _hideLoader() {
    if (this.modalLoader) {
      this.modalLoader.classList.add('hidden');
    }
  }

  _updateLoaderText(text) {
    if (this.modalLoaderText) {
      this.modalLoaderText.textContent = text;
    }
  }

  _startTimers() {
    this._stopTimers();
    this.sessionStartTime = Date.now();

    this.stopwatchTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
      const hours = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      if (this.timerDisplay) {
        this.timerDisplay.textContent = `${hours}:${mins}:${secs}`;
      }
    }, 1000);

    this.frameCount = 0;
    this.fpsTimer = setInterval(() => {
      this.fps = this.frameCount;
      this.frameCount = 0;
      if (this.fpsDisplay) {
        this.fpsDisplay.textContent = `${this.fps} FPS`;
      }
    }, 1000);
  }

  _stopTimers() {
    if (this.stopwatchTimer) {
      clearInterval(this.stopwatchTimer);
      this.stopwatchTimer = null;
    }
    if (this.fpsTimer) {
      clearInterval(this.fpsTimer);
      this.fpsTimer = null;
    }
    if (this.timerDisplay) this.timerDisplay.textContent = '00:00:00';
    if (this.fpsDisplay) this.fpsDisplay.textContent = '0 FPS';
  }
}

// ============================================================================
// 6. WEBSOCKET SIGNALING & RESILIENCE ENGINE (SignalingClient)
// ============================================================================
class SignalingClient {
  constructor(store, thumbnailRenderer, restFallback) {
    this.store = store;
    this.thumbnailRenderer = thumbnailRenderer;
    this.restFallback = restFallback;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.countdownTimer = null;
    this.isManualClose = false;
  }

  getWsUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const role = AuthManager.getRole();
    const token = AuthManager.getToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    return `${protocol}//${window.location.host}/ws?role=${encodeURIComponent(role)}${tokenParam}`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isManualClose = false;
    this.store.setConnectionStatus('connecting');

    try {
      let WsImpl = (typeof WebSocket !== 'undefined') ? WebSocket : null;
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        try {
          const wsPkg = require('ws');
          if (wsPkg) WsImpl = wsPkg;
        } catch (_) {}
      }
      this.ws = new WsImpl(this.getWsUrl());
      if (this.ws && typeof this.ws.terminate !== 'function') {
        this.ws.terminate = () => {
          try {
            if (typeof this.ws.close === 'function') this.ws.close();
          } catch (_) {}
        };
      }
    } catch (_) {
      this.handleConnectionFailure();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.clearTimers();
      this.store.setConnectionStatus('connected', { wsConnected: true, fallbackActive: false });
      this.restFallback?.stop();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      if (!this.isManualClose) {
        this.handleConnectionFailure();
      }
    };

    this.ws.onerror = () => {
      // onclose handles failure recovery
    };
  }

  handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (_) {
      return;
    }

    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'dashboard:init': {
        const branches = msg.payload?.branches || [];
        this.store.initBranches(branches);
        break;
      }
      case 'branch:telemetry': {
        if (msg.payload) {
          this.store.updateTelemetry(msg.payload);
        }
        break;
      }
      case 'branches:purged': {
        if (msg.payload && Array.isArray(msg.payload.purged)) {
          msg.payload.purged.forEach(id => this.store.removeBranch(id));
        }
        break;
      }
      case 'branch:thumbnail': {
        const payload = msg.payload;
        if (payload && payload.branchId && payload.data) {
          this.thumbnailRenderer.applyFromBase64(
            payload.branchId,
            payload.data,
            payload.format || 'jpeg',
            payload.timestamp || Date.now()
          );
        }
        break;
      }
      default:
        this.store.emit(msg.type, msg.payload);
        break;
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  handleConnectionFailure() {
    this.store.setConnectionStatus('reconnecting', { wsConnected: false });
    this.restFallback?.start();

    this.reconnectAttempts++;
    const delayMs = this.computeBackoffDelay(this.reconnectAttempts);
    let secondsRemaining = Math.ceil(delayMs / 1000);

    this.store.setConnectionStatus('reconnecting', {
      reconnectAttempts: this.reconnectAttempts,
      nextRetrySeconds: secondsRemaining,
    });

    this.clearTimers();

    this.countdownTimer = setInterval(() => {
      secondsRemaining--;
      if (secondsRemaining >= 0) {
        this.store.setConnectionStatus('reconnecting', { nextRetrySeconds: secondsRemaining });
      }
    }, 1000);

    this.reconnectTimer = setTimeout(() => {
      this.clearTimers();
      this.connect();
    }, delayMs);
  }

  computeBackoffDelay(attempt) {
    const { INITIAL_DELAY_MS, MAX_DELAY_MS, BACKOFF_FACTOR, JITTER_MIN, JITTER_MAX } = CONFIG.RECONNECT;
    const exponential = Math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1));
    const jitter = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
    return Math.round(exponential * jitter);
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  retryNow() {
    this.clearTimers();
    this.connect();
  }

  disconnect() {
    this.isManualClose = true;
    this.clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'Normal shutdown'); } catch (_) {}
      this.ws = null;
    }
  }
}

// ============================================================================
// 7. REST FALLBACK POLLING SERVICE
// ============================================================================
class RestFallbackService {
  constructor(store, thumbnailRenderer) {
    this.store = store;
    this.thumbnailRenderer = thumbnailRenderer;
    this.pollTimer = null;
    this.isPolling = false;
  }

  start() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.store.setConnectionStatus('fallback_active', { fallbackActive: true });
    this.pollOnce();
    this.pollTimer = setInterval(() => this.pollOnce(), CONFIG.REST_FALLBACK_INTERVAL_MS);
  }

  stop() {
    this.isPolling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce() {
    try {
      const url = (typeof window !== 'undefined' && window.location && window.location.host)
        ? `${window.location.protocol || 'http:'}//${window.location.host}/api/branches`
        : '/api/branches';
      const res = await fetch(url);
      if (res.ok) {
        const branches = await res.json();
        this.store.initBranches(branches);

        for (const b of branches) {
          if (b.online && b.thumbnailTimestamp) {
            const cached = this.store.getBranch(b.id);
            if (cached && cached.thumbnailTimestamp < b.thumbnailTimestamp) {
              this.fetchThumbnailBlob(b.id, b.thumbnailTimestamp);
            }
          }
        }
      }
    } catch (_) {}

    try {
      const healthUrl = (typeof window !== 'undefined' && window.location && window.location.host)
        ? `${window.location.protocol || 'http:'}//${window.location.host}/api/health`
        : '/api/health';
      const healthRes = await fetch(healthUrl);
      if (healthRes.ok) {
        const health = await healthRes.json();
        const ramEl = document.getElementById('hud-server-ram');
        if (ramEl && health.memory?.rssMb) {
          ramEl.innerHTML = `${health.memory.rssMb} MB <small>/ 30 MB</small>`;
        }
      }
    } catch (_) {}
  }

  async fetchThumbnailBlob(branchId, timestamp) {
    try {
      const url = (typeof window !== 'undefined' && window.location && window.location.host)
        ? `${window.location.protocol || 'http:'}//${window.location.host}/api/branch/${branchId}/thumbnail?t=${timestamp}`
        : `/api/branch/${branchId}/thumbnail?t=${timestamp}`;
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        this.thumbnailRenderer.applyThumbnail(branchId, blob, timestamp);
      }
    } catch (_) {}
  }
}

// ============================================================================
// 8. DASHBOARD UI BINDER & DOM CONTROLLER
// ============================================================================
class DashboardUI {
  constructor(store, streamingEngine, signalingClient) {
    this.store = store;
    this.streaming = streamingEngine;
    this.signaling = signalingClient;
    this.currentFilter = 'online';

    this._bindDOM();
    this._bindStoreEvents();
    this._startClock();
  }

  _bindDOM() {
    // 0. Tab Switching: Supervisión Central vs Soporte Punto a Punto vs Panel Moderador
    const tabSupervisionBtn = document.getElementById('tab-btn-supervision');
    const tabSupportBtn = document.getElementById('tab-btn-support');
    const tabModeratorBtn = document.getElementById('tab-btn-moderator');
    const viewSupervision = document.getElementById('view-supervision');
    const viewSupport = document.getElementById('view-support');
    const viewModerator = document.getElementById('view-moderator');

    const switchTab = (tab) => {
      tabSupervisionBtn?.classList.remove('active');
      tabSupportBtn?.classList.remove('active');
      tabModeratorBtn?.classList.remove('active');
      viewSupervision?.classList.add('hidden');
      viewSupport?.classList.add('hidden');
      viewModerator?.classList.add('hidden');

      if (tab === 'supervision') {
        tabSupervisionBtn?.classList.add('active');
        viewSupervision?.classList.remove('hidden');
      } else if (tab === 'moderator') {
        tabModeratorBtn?.classList.add('active');
        viewModerator?.classList.remove('hidden');
        AuthManager.fetchAndRenderModeratorUsers();
      } else {
        tabSupportBtn?.classList.add('active');
        viewSupport?.classList.remove('hidden');
        RecentConnections.render();
      }
    };

    tabSupervisionBtn?.addEventListener('click', () => switchTab('supervision'));
    tabSupportBtn?.addEventListener('click', () => switchTab('support'));
    tabModeratorBtn?.addEventListener('click', () => switchTab('moderator'));

    // 0b. Admin Login Modal & Auth Button
    const btnAdminAuth = document.getElementById('btn-admin-auth');
    const loginCloseBtn = document.getElementById('login-close-btn');
    const loginCancelBtn = document.getElementById('login-cancel-btn');
    const loginForm = document.getElementById('admin-login-form');
    const adminPasswordInput = document.getElementById('admin-password-input');
    const btnToggleAdminPwd = document.getElementById('btn-toggle-admin-pwd');
    const loginErrorMsg = document.getElementById('login-error-msg');

    AuthManager.updateUI();

    btnAdminAuth?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (AuthManager.isAuthenticated()) {
        const dropdown = document.getElementById('admin-dropdown-menu');
        if (dropdown) {
          dropdown.classList.toggle('hidden');
        }
      } else {
        AuthManager.promptLogin();
      }
    });

    // Close admin dropdown when clicking outside
    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('admin-user-menu-wrapper');
      const dropdown = document.getElementById('admin-dropdown-menu');
      if (dropdown && !dropdown.classList.contains('hidden')) {
        if (!wrapper || !wrapper.contains(e.target)) {
          dropdown.classList.add('hidden');
        }
      }
    });

    // Moderator Panel Button & Actions
    const btnOpenMod = document.getElementById('btn-open-moderator-panel');
    btnOpenMod?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('admin-dropdown-menu');
      if (dropdown) dropdown.classList.add('hidden');
      switchTab('moderator');
    });

    const modCloseBtn = document.getElementById('mod-close-btn');
    modCloseBtn?.addEventListener('click', () => AuthManager.closeModeratorModal());

    const modDoneBtn = document.getElementById('mod-done-btn');
    modDoneBtn?.addEventListener('click', () => AuthManager.closeModeratorModal());

    const modRefreshBtn = document.getElementById('mod-refresh-btn');
    modRefreshBtn?.addEventListener('click', () => AuthManager.fetchAndRenderModeratorUsers());

    const tabModRefreshBtn = document.getElementById('tab-mod-refresh-btn');
    tabModRefreshBtn?.addEventListener('click', () => AuthManager.fetchAndRenderModeratorUsers());

    // Delegation for Moderator Table Actions (Plan toggle & Password save)
    const handleModeratorTableClick = async (e) => {
      const toggleBtn = e.target.closest('.btn-plan-toggle');
      if (toggleBtn) {
        const username = toggleBtn.getAttribute('data-user');
        const currentPlan = toggleBtn.getAttribute('data-plan');
        const newPlan = currentPlan === 'pro' ? 'free' : 'pro';
        toggleBtn.disabled = true;
        toggleBtn.textContent = 'Guardando...';
        await AuthManager.updateModeratorUser(username, { plan: newPlan });
        return;
      }

      const savePwdBtn = e.target.closest('.btn-mod-save-pwd');
      if (savePwdBtn) {
        const username = savePwdBtn.getAttribute('data-user');
        const pwdInput = savePwdBtn.closest('.mod-pwd-group')?.querySelector('.mod-pwd-input');
        const newPwd = pwdInput?.value?.trim();
        if (!newPwd || newPwd.length < 3) {
          alert('La contraseña debe tener al menos 3 caracteres.');
          return;
        }
        savePwdBtn.disabled = true;
        savePwdBtn.textContent = '...';
        await AuthManager.updateModeratorUser(username, { password: newPwd });
        savePwdBtn.disabled = false;
        savePwdBtn.textContent = 'Guardar';
        return;
      }
    };

    const modUsersTbody = document.getElementById('mod-users-tbody');
    modUsersTbody?.addEventListener('click', handleModeratorTableClick);

    const tabModUsersTbody = document.getElementById('tab-mod-users-tbody');
    tabModUsersTbody?.addEventListener('click', handleModeratorTableClick);

    const btnDownloadInvoice = document.getElementById('btn-download-invoice');
    btnDownloadInvoice?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('admin-dropdown-menu');
      if (dropdown) dropdown.classList.add('hidden');
      AuthManager.generateInvoicePDF();
    });

    const btnDownloadAgent = document.getElementById('btn-download-agent');
    btnDownloadAgent?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('admin-dropdown-menu');
      if (dropdown) dropdown.classList.add('hidden');
      window.location.href = '/api/download/agent';
    });

    const btnLogout = document.getElementById('btn-logout');
    btnLogout?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('admin-dropdown-menu');
      if (dropdown) dropdown.classList.add('hidden');
      AuthManager.logout();
      switchTab('support');
      this.signaling.disconnect();
      this.signaling.connect();
      this._showToast('Sesión cerrada correctamente', 'info');
    });

    loginCloseBtn?.addEventListener('click', () => AuthManager.closeLogin());
    loginCancelBtn?.addEventListener('click', () => AuthManager.closeLogin());

    const btnProOpenLogin = document.getElementById('btn-pro-open-login');
    btnProOpenLogin?.addEventListener('click', () => {
      AuthManager.closeProModal();
      AuthManager.promptLogin();
    });

    const proCloseBtn = document.getElementById('pro-close-btn');
    proCloseBtn?.addEventListener('click', () => {
      AuthManager.closeProModal();
    });

    btnToggleAdminPwd?.addEventListener('click', () => {
      if (!adminPasswordInput) return;
      const isPwd = adminPasswordInput.type === 'password';
      adminPasswordInput.type = isPwd ? 'text' : 'password';
      // toggle handled by SVG/title
    });

    loginForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const loginUsernameInput = document.getElementById('login-username-input');
      const username = loginUsernameInput?.value?.trim() || '';
      const pwd = adminPasswordInput?.value?.trim() || '';
      if (!username) {
        if (loginErrorMsg) {
          loginErrorMsg.classList.remove('hidden');
          loginErrorMsg.textContent = 'Ingresa tu usuario (admin, usuario, moderador)';
        }
        loginUsernameInput?.focus();
        return;
      }
      if (!pwd) {
        if (loginErrorMsg) {
          loginErrorMsg.classList.remove('hidden');
          loginErrorMsg.textContent = 'Ingresa tu contraseña';
        }
        adminPasswordInput?.focus();
        return;
      }

      const result = await AuthManager.login(username, pwd);
      if (result.success) {
        AuthManager.closeLogin();
        if (result.role === 'moderator') {
          switchTab('moderator');
        } else if (result.role === 'admin') {
          switchTab('supervision');
        } else {
          switchTab('support');
        }
        // Reconnect signaling socket with authenticated token
        this.signaling.disconnect();
        this.signaling.connect();
        const roleLabel = result.role === 'admin' ? 'Administrador' : (result.role === 'moderator' ? 'Moderador' : 'Usuario');
        this._showToast(`Sesión iniciada como ${roleLabel}`, 'success');
      } else {
        if (loginErrorMsg) {
          loginErrorMsg.classList.remove('hidden');
          loginErrorMsg.textContent = result.error || 'Credenciales incorrectas';
        }
      }
    });

    // 1. Action Buttons on Branch Cards (Observar / Controlar)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-action');
      if (!btn || btn.disabled) return;

      const action = btn.getAttribute('data-action');
      const branchId = btn.getAttribute('data-branch') || btn.closest('.branch-card')?.getAttribute('data-branch-id');
      if (action && branchId) {
        if (AuthManager.isFree()) {
          AuthManager.showProModal();
          return;
        }
        if (!AuthManager.isAdmin()) {
          this._showToast('Acceso restringido: solo Administradores pueden supervisar estaciones', 'error');
          return;
        }
        this.streaming.startSession(branchId, action);
      }
    });

    // 2. Filter Buttons in Workspace Toolbar
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = btn.getAttribute('data-filter') || 'all';
        this._applyCardFilter();
      });
    });

    // 2b. Purge Offline Machines Button
    const btnPurgeOffline = document.getElementById('btn-purge-offline');
    if (btnPurgeOffline) {
      btnPurgeOffline.addEventListener('click', async () => {
        try {
          const token = AuthManager.getToken();
          const resp = await fetch('/api/branches/offline', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }
          });
          const res = await resp.json();
          const cards = document.querySelectorAll('.branch-card:not(.online)');
          cards.forEach(c => c.remove());
          if (res && res.purged) {
            res.purged.forEach(id => this.store.removeBranch(id));
          }
          this._applyCardFilter();
          this._showToast(`Se limpiaron ${res?.purgedCount || 0} estaciones desconectadas`, 'info');
        } catch (e) {
          const cards = document.querySelectorAll('.branch-card:not(.online)');
          cards.forEach(c => c.remove());
          this._applyCardFilter();
          this._showToast('Estaciones desconectadas ocultadas de la vista', 'info');
        }
      });
    }

    // 3. Banner Reconnect Button
    const bannerRetryBtn = document.getElementById('banner-reconnect-btn');
    if (bannerRetryBtn) {
      bannerRetryBtn.addEventListener('click', () => {
        this.signaling.retryNow();
      });
    }

    // 4. Header Refresh Button
    const refreshBtn = document.getElementById('btn-refresh-all');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        for (const b of this.store.getAllBranches()) {
          const img = document.getElementById(`img-${b.id}`);
          if (img) img.src = `/api/branch/${b.id}/thumbnail?t=${Date.now()}`;
        }
      });
    }

    // 5. Point-to-Point Support Tab Form Controls
    const supportForm = document.getElementById('support-connect-form');
    const supportTargetInput = document.getElementById('support-target-input');
    const supportPasswordInput = document.getElementById('support-password-input');
    const supportResolveBadge = document.getElementById('support-resolve-badge');
    const supportStatusBox = document.getElementById('support-status-box');
    const supportStatusMsg = document.getElementById('support-status-msg');
    const supportStatusSpinner = document.getElementById('support-status-spinner');
    const supportPasswordGroup = document.getElementById('support-password-group');
    const supportPasswordLabel = document.getElementById('support-password-label');
    const authToggleBtns = document.querySelectorAll('.auth-toggle-btn');
    const btnToggleSupportPwd = document.getElementById('btn-toggle-support-pwd');

    btnToggleSupportPwd?.addEventListener('click', () => {
      if (!supportPasswordInput) return;
      const isPwd = supportPasswordInput.type === 'password';
      supportPasswordInput.type = isPwd ? 'text' : 'password';
      // toggle handled by SVG/title
    });

    authToggleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        authToggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const method = btn.dataset.auth;
        if (method === 'prompt') {
          if (supportPasswordGroup) supportPasswordGroup.style.display = 'none';
        } else {
          if (supportPasswordGroup) supportPasswordGroup.style.display = '';
          if (supportPasswordLabel) {
            supportPasswordLabel.textContent = method === 'otp'
              ? 'Clave Temporal (OTP de 6 dígitos):'
              : 'Contraseña de la Máquina Remota:';
          }
        }
      });
    });

    if (supportTargetInput) {
      let resolveDebounce = null;
      const checkSupportTarget = async () => {
        const val = supportTargetInput.value.trim();
        if (!val || val.length < 3) {
          if (supportResolveBadge) supportResolveBadge.className = 'resolve-badge hidden';
          return;
        }
        try {
          const res = await fetch(`/api/resolve/${encodeURIComponent(val)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.found && data.branch) {
              if (supportResolveBadge) {
                supportResolveBadge.className = 'resolve-badge badge-success';
                supportResolveBadge.textContent = `${data.branch.name || data.branch.id} (${data.branch.online ? 'En Línea' : 'Desconectada'})`;
              }
              if (this._pendingSupportConnect) {
                this._pendingSupportConnect.resolvedBranchId = data.branch.id;
              }
              return;
            }
          }
        } catch (_) {}
        if (supportResolveBadge) {
          supportResolveBadge.className = 'resolve-badge badge-error';
          supportResolveBadge.textContent = 'No encontrada';
        }
      };

      supportTargetInput.addEventListener('input', () => {
        clearTimeout(resolveDebounce);
        resolveDebounce = setTimeout(checkSupportTarget, 300);
      });
      supportTargetInput.addEventListener('blur', checkSupportTarget);
    }

    if (supportForm) {
      supportForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (AuthManager.isFree()) {
          AuthManager.showProModal();
          return;
        }
        const targetVal = supportTargetInput?.value.trim() || '';
        if (!targetVal) return;

        const activeAuthBtn = document.querySelector('.auth-toggle-btn.active');
        const authMethod = activeAuthBtn ? activeAuthBtn.dataset.auth : 'password';
        const passwordVal = supportPasswordInput?.value || '';

        if (authMethod !== 'prompt' && !passwordVal) {
          if (supportStatusBox && supportStatusMsg) {
            supportStatusBox.className = 'support-status-box status-error';
            if (supportStatusSpinner) supportStatusSpinner.style.display = 'none';
            supportStatusMsg.textContent = 'Ingrese la contraseña de la máquina para continuar';
          }
          return;
        }

        const sessionId = `peer-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        this._pendingSupportConnect = {
          sessionId,
          target: targetVal,
          resolvedBranchId: targetVal,
          authMethod
        };

        if (supportStatusBox && supportStatusMsg) {
          supportStatusBox.className = 'support-status-box';
          if (supportStatusSpinner) supportStatusSpinner.style.display = 'block';
          supportStatusMsg.textContent = authMethod === 'prompt'
            ? 'Esperando autorización en pantalla del operador remoto (30s)...'
            : 'Verificando contraseña con la máquina remota...';
        }

        this.signaling.send({
          type: 'peer:auth_request',
          payload: {
            sessionId: sessionId,
            requesterId: 'support_panel',
            requesterName: 'Punto a Punto (Soporte)',
            targetMachineId: targetVal,
            authMethod: authMethod,
            password: passwordVal,
            transport: 'relay'
          }
        });
      });
    }

    // Recent connection clicks
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-recent-connect');
      if (!btn) return;
      const target = btn.dataset.target;
      if (target && supportTargetInput) {
        supportTargetInput.value = target;
        supportTargetInput.dispatchEvent(new Event('input'));
        supportPasswordInput?.focus();
      }
    });

    RecentConnections.render();

    // SOS Emergency Banner actions
    const btnSosTakeover = document.getElementById('btn-sos-takeover');
    if (btnSosTakeover) {
      btnSosTakeover.addEventListener('click', () => {
        if (this.activeSosBranch) {
          this.streaming.startSession(this.activeSosBranch, 'control');
        }
      });
    }

    const btnSosClear = document.getElementById('btn-sos-clear');
    if (btnSosClear) {
      btnSosClear.addEventListener('click', () => {
        if (this.activeSosBranch) {
          this.signaling.send({
            type: 'sos:clear',
            payload: { branchId: this.activeSosBranch, resolvedBy: 'admin_panel' }
          });
        }
      });
    }

    this._bindMyStationCard();
  }

  _bindMyStationCard() {
    const detectedBanner = document.getElementById('my-station-detected-banner');
    const notFoundBox = document.getElementById('my-station-not-found-box');
    const aliasDisplay = document.getElementById('my-station-alias');
    const retryBtn = document.getElementById('btn-retry-detect-station');
    const idDisplay = document.getElementById('my-station-id');
    const pwdDisplay = document.getElementById('my-station-pwd-display');
    const statusPill = document.getElementById('my-station-status-pill');
    const statusText = document.getElementById('my-station-status-text');
    const toggleIcon = document.getElementById('toggle-my-pwd-icon');
    const toggleText = document.getElementById('toggle-my-pwd-text');
    const btnCopyId = document.getElementById('btn-copy-my-id');
    const btnTogglePwd = document.getElementById('btn-toggle-my-pwd');
    const btnCopyPwd = document.getElementById('btn-copy-my-pwd');
    const btnShareInvite = document.getElementById('btn-share-invite');
    const credentialsGroup = document.querySelector('.station-credential-group');

    let pwdVisible = false;
    let localDetectedAgent = null;

    const renderLocalStation = (info) => {
      if (detectedBanner) detectedBanner.style.display = 'flex';
      if (notFoundBox) notFoundBox.style.display = 'none';
      if (credentialsGroup) credentialsGroup.style.display = 'block';
      if (btnShareInvite) btnShareInvite.style.display = 'flex';

      if (aliasDisplay) aliasDisplay.textContent = info.alias || info.branchId || 'Esta PC';
      if (idDisplay) idDisplay.textContent = formatMachineId(info.machineId);

      const pwd = info.password || info.tempPassword || '';
      if (pwdDisplay) {
        pwdDisplay.textContent = pwdVisible ? (pwd || '••••••••') : '••••••••';
      }

      if (statusPill) {
        statusPill.className = 'station-badge-live';
        if (statusText) statusText.textContent = 'En Línea';
      }
    };

    const renderNotFound = () => {
      if (detectedBanner) detectedBanner.style.display = 'none';
      if (notFoundBox) notFoundBox.style.display = 'block';
      if (credentialsGroup) credentialsGroup.style.display = 'none';
      if (btnShareInvite) btnShareInvite.style.display = 'none';

      if (idDisplay) idDisplay.textContent = '--- --- ---';
      if (pwdDisplay) pwdDisplay.textContent = '••••••••';

      if (statusPill) {
        statusPill.className = 'station-badge-offline';
        if (statusText) statusText.textContent = 'Estación No Creada';
      }
    };

    const detectLocalAgent = async (isManual = false) => {
      // 1. Check local cache first for instant display
      try {
        const cached = localStorage.getItem('vd_my_station');
        if (cached && !localDetectedAgent) {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.machineId) {
            localDetectedAgent = parsed;
            renderLocalStation(parsed);
          }
        }
      } catch (_) {}

      // 2. Try direct loopback discovery (127.0.0.1:18999)
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch('http://127.0.0.1:18999/info', {
          signal: ctrl.signal,
          mode: 'cors',
          cache: 'no-store'
        });
        clearTimeout(tid);
        if (res.ok) {
          const info = await res.json();
          if (info && info.found && info.machineId) {
            localDetectedAgent = info;
            try { localStorage.setItem('vd_my_station', JSON.stringify(info)); } catch (_) {}
            renderLocalStation(info);
            if (isManual) this._showToast('Agente detectado en esta PC', 'success');
            return info;
          }
        }
      } catch (err) {
        console.warn('[VisionDesk] Loopback 127.0.0.1:18999 check bypassed:', err?.message || err);
      }

      // 3. Fallback: Server-assisted detection (/api/my-station by IP)
      try {
        const sRes = await fetch('/api/my-station', { cache: 'no-store' });
        if (sRes.ok) {
          const sInfo = await sRes.json();
          if (sInfo && sInfo.found && sInfo.machineId) {
            localDetectedAgent = sInfo;
            try { localStorage.setItem('vd_my_station', JSON.stringify(sInfo)); } catch (_) {}
            renderLocalStation(sInfo);
            if (isManual) this._showToast('Estación vinculada por red del servidor', 'success');
            return sInfo;
          }
        }
      } catch (sErr) {
        console.warn('[VisionDesk] Server-assisted /api/my-station check warning:', sErr?.message || sErr);
      }

      // 4. If no agent was found and no cache exists, show not found
      if (!localDetectedAgent) {
        renderNotFound();
        if (isManual) this._showToast('No se detectó agente activo en esta máquina', 'warning');
      }
      return localDetectedAgent;
    };

    retryBtn?.addEventListener('click', () => {
      this._showToast('Verificando agente en esta PC...', 'info');
      detectLocalAgent(true);
    });

    btnCopyId?.addEventListener('click', () => {
      const rawId = localDetectedAgent?.machineId || '';
      if (!rawId) {
        this._showToast('No hay ID disponible en este equipo', 'error');
        return;
      }
      navigator.clipboard.writeText(rawId).then(() => {
        this._showToast('ID copiado al portapapeles: ' + formatMachineId(rawId), 'info');
      }).catch(() => {
        this._showToast('ID: ' + formatMachineId(rawId), 'info');
      });
    });

    btnTogglePwd?.addEventListener('click', () => {
      pwdVisible = !pwdVisible;
      if (toggleIcon) // toggle handled by text
      if (toggleText) toggleText.textContent = pwdVisible ? 'Ocultar' : 'Ver';
      if (localDetectedAgent) {
        renderLocalStation(localDetectedAgent);
      }
    });

    btnCopyPwd?.addEventListener('click', () => {
      const pwd = localDetectedAgent?.password || localDetectedAgent?.tempPassword || '';
      if (!pwd) {
        this._showToast('No hay contraseña configurada en este equipo', 'error');
        return;
      }
      navigator.clipboard.writeText(pwd).then(() => {
        this._showToast('Contraseña copiada al portapapeles', 'info');
      }).catch(() => {
        this._showToast('Clave: ' + pwd, 'info');
      });
    });

    btnShareInvite?.addEventListener('click', () => {
      if (!localDetectedAgent) {
        this._showToast('Agente no detectado en este equipo', 'error');
        return;
      }
      const rawId = localDetectedAgent.machineId || '';
      const pwd = localDetectedAgent.password || localDetectedAgent.tempPassword || '';
      const formatted = formatMachineId(rawId);
      const host = window.location.origin;
      const text = `Para conectarte a mi PC con VisionDesk:\nID: ${formatted}\nContraseña: ${pwd}\nEnlace: ${host}`;
      navigator.clipboard.writeText(text).then(() => {
        this._showToast('Invitación copiada para enviar por WhatsApp o Teams', 'success');
      }).catch(() => {
        prompt('Copie esta invitación para soporte:', text);
      });
    });

    // Detect local agent immediately and on window focus
    detectLocalAgent();
    window.addEventListener('focus', () => detectLocalAgent());
  }

  _bindStoreEvents() {
    // Branches Initialized / Updated
    this.store.on('branches:initialized', (branches) => {
      branches.forEach(b => this._updateBranchCard(b));
      const emptyState = document.getElementById('empty-branches-state');
      if (emptyState) {
        emptyState.style.display = (branches.length === 0) ? 'flex' : 'none';
      }
    });

    // Branch Removed / Purged
    this.store.on('branch:removed', (branchId) => {
      const card = document.getElementById(`branch-${branchId}`);
      if (card) card.remove();
      this._applyCardFilter();
    });

    // Telemetry Update
    this.store.on('branch:telemetry', ({ branch }) => {
      this._updateBranchCard(branch);
    });

    // Peer Auth Response Listener (Supports both Support Tab and legacy Quick Connect)
    this.store.on('peer:auth_response', (payload) => {
      const pending = this._pendingSupportConnect || this._pendingQuickConnect;
      if (!pending || pending.sessionId !== payload.sessionId) return;
      const statusBox = document.getElementById('support-status-box') || document.getElementById('qc-status-box');
      const statusMsg = document.getElementById('support-status-msg') || document.getElementById('qc-status-msg');
      const statusSpinner = document.getElementById('support-status-spinner') || document.getElementById('qc-status-spinner');
      const modal = document.getElementById('quick-connect-modal');

      if (payload.granted) {
        if (statusBox && statusMsg) {
          statusBox.className = statusBox.id.includes('support') ? 'support-status-box status-success' : 'qc-status-box status-success';
          if (statusSpinner) statusSpinner.style.display = 'none';
          statusMsg.textContent = 'Conexión autorizada. Iniciando control interactivo...';
        }
        const targetId = pending.resolvedBranchId || pending.target;
        RecentConnections.add(targetId, targetId);
        setTimeout(() => {
          if (modal && typeof modal.close === 'function' && modal.open) modal.close();
          this.streaming.startSession(targetId, 'control', payload.sessionId, 'peer-authorized');
          this._pendingSupportConnect = null;
          this._pendingQuickConnect = null;
        }, 500);
      } else {
        let reason = 'Acceso denegado por la máquina remota';
        if (payload.reason === 'invalid_password') reason = 'Contraseña fija incorrecta';
        else if (payload.reason === 'invalid_otp') reason = 'Clave temporal (OTP) inválida';
        else if (payload.reason === 'user_declined') reason = 'El operador de caja rechazó la solicitud';
        else if (payload.reason === 'timeout') reason = 'Tiempo de espera agotado (sin respuesta del operador)';
        else if (payload.reason === 'target_offline') reason = 'La máquina remota se encuentra fuera de línea';
        else if (payload.reason === 'busy') reason = 'La máquina remota ya tiene una sesión activa';

        if (statusBox && statusMsg) {
          statusBox.className = statusBox.id.includes('support') ? 'support-status-box status-error' : 'qc-status-box status-error';
          if (statusSpinner) statusSpinner.style.display = 'none';
          statusMsg.textContent = reason;
        }
      }
    });

    // SOS Alerts Listeners
    this.store.on('sos:broadcast', (payload) => {
      this.activeSosBranch = payload.branchId;
      const banner = document.getElementById('sos-global-banner');
      const bannerMsg = document.getElementById('sos-banner-msg');
      if (banner) {
        banner.classList.remove('hidden');
        if (bannerMsg) {
          bannerMsg.textContent = `${payload.branchName || payload.branchId} (${payload.alias || ''}): ${payload.reason || 'Alerta de emergencia'}`;
        }
      }
      const card = document.getElementById(`card-${payload.branchId}`);
      if (card) {
        card.classList.add('card-sos-active');
      }
    });

    this.store.on('sos:cleared', (payload) => {
      const card = document.getElementById(`card-${payload.branchId}`);
      if (card) {
        card.classList.remove('card-sos-active');
      }
      if (this.activeSosBranch === payload.branchId) {
        this.activeSosBranch = null;
        const banner = document.getElementById('sos-global-banner');
        if (banner) banner.classList.add('hidden');
      }
    });

    // Metrics Bar
    this.store.on('metrics:updated', (metrics) => {
      const onlineEl = document.getElementById('hud-online-count');
      if (onlineEl) {
        onlineEl.innerHTML = `<span class="count-online">${metrics.onlineCount}</span> En Línea`;
      }
      const filterAll = document.getElementById('filter-all-badge');
      if (filterAll) filterAll.textContent = metrics.totalBranches;
      const filterOnline = document.getElementById('filter-online-badge');
      if (filterOnline) filterOnline.textContent = metrics.onlineCount;
      const filterOffline = document.getElementById('filter-offline-badge');
      if (filterOffline) filterOffline.textContent = metrics.offlineCount;
      const tabSuperBadge = document.getElementById('tab-supervision-badge');
      if (tabSuperBadge) tabSuperBadge.textContent = metrics.onlineCount;

      const emptyState = document.getElementById('empty-branches-state');
      if (emptyState) {
        emptyState.style.display = (metrics.totalBranches === 0) ? 'flex' : 'none';
      }
    });

    // Connection Status Changes
    this.store.on('connection:change', (conn) => {
      const banner = document.getElementById('network-banner');
      const bannerMsg = document.getElementById('network-banner-msg');
      const wsStatusPill = document.getElementById('hud-ws-status');

      if (conn.status === 'connected') {
        if (banner) {
          banner.classList.add('is-reconnected');
          if (bannerMsg) bannerMsg.textContent = 'Conexión restablecida con el servidor central';
          setTimeout(() => banner.classList.add('hidden'), 2000);
        }
        if (wsStatusPill) {
          wsStatusPill.className = 'hud-pill pill-connected';
          wsStatusPill.textContent = 'En Línea';
        }
      } else if (conn.status === 'reconnecting' || conn.status === 'fallback_active') {
        if (banner) {
          banner.classList.remove('hidden', 'is-reconnected');
          if (bannerMsg) {
            bannerMsg.textContent = `Conexión interrumpida con el servidor. Reintentando en ${conn.nextRetrySeconds || 1}s... (Intento #${conn.reconnectAttempts || 1})`;
          }
        }
        if (wsStatusPill) {
          wsStatusPill.className = 'hud-pill pill-disconnected';
          wsStatusPill.textContent = conn.fallbackActive ? 'REST Fallback' : 'Reconectando...';
        }
      } else {
        if (wsStatusPill) {
          wsStatusPill.className = 'hud-pill pill-connecting';
          wsStatusPill.textContent = 'Conectando...';
        }
      }
    });
  }

  _createDynamicBranchCard(branch) {
    const grid = document.getElementById('branches-grid');
    if (!grid) return null;

    const article = document.createElement('article');
    article.className = 'branch-card offline';
    article.id = `card-${branch.id}`;
    article.setAttribute('data-branch-id', branch.id);

    const safeName = (branch.name || branch.id).replace(/</g, '&lt;');
    const safeAlias = (branch.alias || branch.id.toUpperCase()).replace(/</g, '&lt;');

    article.innerHTML = `
      <header class="card-header">
        <div class="branch-identity">
          <h3 class="branch-name" id="name-${branch.id}">${safeName}</h3>
          <span class="branch-alias" id="alias-${branch.id}">${safeAlias}</span>
        </div>
        <div class="card-status-badge status-offline" id="status-${branch.id}">
          <span class="status-dot"></span>
          <span class="status-text">DESCONECTADO</span>
        </div>
      </header>

      <div class="card-meta-row">
        <div class="meta-item machine-id-item font-mono" title="Identificador de Máquina">
          <span class="meta-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></span>
          <span class="machine-id-value" id="machineid-${branch.id}">--- --- ---</span>
        </div>
        <div class="meta-item latency-item font-mono" title="Latencia RTT">
          <span class="latency-pill latency-offline" id="latency-${branch.id}">-- ms</span>
        </div>
      </div>

      <div class="thumbnail-wrapper" id="thumb-container-${branch.id}">
        <div class="thumbnail-16x9">
          <img class="thumbnail-img thumb-layer thumb-layer-a is-active" id="img-${branch.id}" src="/api/branch/${branch.id}/thumbnail" alt="Captura de ${safeName} (Capa A)" loading="lazy">
          <img class="thumbnail-img thumb-layer thumb-layer-b" id="img-b-${branch.id}" alt="Captura de ${safeName} (Capa B)" loading="lazy">
          <div class="thumbnail-overlay">
            <span class="overlay-badge" id="updated-${branch.id}">En espera</span>
          </div>
          <div class="offline-placeholder" id="placeholder-${branch.id}">
            <div class="placeholder-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M4.93 19.07A10 10 0 0 1 12 16a10 10 0 0 1 7.07 3.07"></path><path d="M7.76 16.24A6 6 0 0 1 12 14a6 6 0 0 1 4.24 2.24"></path><circle cx="12" cy="11" r="2"></circle><line x1="12" y1="13" x2="12" y2="21"></line></svg></div>
            <div class="placeholder-title">SIN SEÑAL / EN ESPERA</div>
            <div class="placeholder-subtitle">Esperando transmisión de miniatura</div>
          </div>
        </div>
      </div>

      <footer class="card-actions">
        <button class="btn btn-observe btn-action" id="btn-observe-${branch.id}" data-action="observe" data-branch="${branch.id}" title="Auditoría pasiva continua - Periféricos bloqueados" disabled>
          <span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></span>
          <span>Observar</span>
        </button>
        <button class="btn btn-control btn-action" id="btn-control-${branch.id}" data-action="control" data-branch="${branch.id}" title="Control interactivo total - 1 clic con token maestro" disabled>
          <span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="2" y="6" width="20" height="12" rx="6"></rect><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line></svg></span>
          <span>Controlar</span>
        </button>
      </footer>
    `;

    grid.appendChild(article);
    return article;
  }

  _updateBranchCard(branch) {
    let card = document.getElementById(`card-${branch.id}`);
    if (!card) {
      card = this._createDynamicBranchCard(branch);
      if (!card) return;
    }

    // Actualizar nombre o alias si cambiaron
    const nameEl = document.getElementById(`name-${branch.id}`);
    if (nameEl && branch.name && nameEl.textContent !== branch.name) {
      nameEl.textContent = branch.name;
    }
    const aliasEl = document.getElementById(`alias-${branch.id}`);
    if (aliasEl && branch.alias && aliasEl.textContent !== branch.alias) {
      aliasEl.textContent = branch.alias;
    }

    // Online / Offline card class
    if (branch.online) {
      card.classList.add('online');
      card.classList.remove('offline');
    } else {
      card.classList.remove('online');
      card.classList.add('offline');
    }

    // Status Badge
    const statusBadge = document.getElementById(`status-${branch.id}`);
    if (statusBadge) {
      const textEl = statusBadge.querySelector('.status-text');
      if (textEl) {
        textEl.textContent = branch.online ? 'EN LÍNEA' : 'DESCONECTADO';
      }
    }

    // Machine ID
    const machineIdEl = document.getElementById(`machineid-${branch.id}`);
    if (machineIdEl) {
      machineIdEl.textContent = formatMachineId(branch.machineId);
    }

    // Latency Pill
    const latencyEl = document.getElementById(`latency-${branch.id}`);
    if (latencyEl) {
      if (!branch.online) {
        latencyEl.className = 'latency-pill latency-offline';
        latencyEl.textContent = '-- ms';
      } else {
        const ms = branch.latencyMs || 0;
        latencyEl.textContent = `${ms} ms`;
        if (ms < CONFIG.LATENCY_THRESHOLDS.GOOD) {
          latencyEl.className = 'latency-pill latency-green';
        } else if (ms <= CONFIG.LATENCY_THRESHOLDS.WARN) {
          latencyEl.className = 'latency-pill latency-amber';
        } else {
          latencyEl.className = 'latency-pill latency-red';
        }
      }
    }

    // Action Buttons
    const btnObserve = document.getElementById(`btn-observe-${branch.id}`);
    const btnControl = document.getElementById(`btn-control-${branch.id}`);
    if (btnObserve) btnObserve.disabled = !branch.online;
    if (btnControl) btnControl.disabled = !branch.online;

    // Placeholder Overlay
    const placeholder = document.getElementById(`placeholder-${branch.id}`);
    if (placeholder) {
      placeholder.style.display = branch.online ? 'none' : 'flex';
    }

    // SOS emergency alert styling on branch card
    if (branch.sos && branch.sos.active) {
      card.classList.add('card-sos-active');
    } else {
      card.classList.remove('card-sos-active');
    }

    this._applyCardFilter();
  }

  _applyCardFilter() {
    const cards = document.querySelectorAll('.branch-card');
    const emptyState = document.getElementById('empty-branches-state');
    let visibleCount = 0;
    let onlineCount = 0;
    let offlineCount = 0;

    cards.forEach((card) => {
      const isOnline = card.classList.contains('online');
      if (isOnline) onlineCount++;
      else offlineCount++;

      let show = false;
      if (this.currentFilter === 'all') {
        show = true;
      } else if (this.currentFilter === 'online') {
        show = isOnline;
      } else if (this.currentFilter === 'offline') {
        show = !isOnline;
      }
      card.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });

    if (emptyState) {
      emptyState.style.display = (cards.length === 0 || visibleCount === 0) ? 'flex' : 'none';
    }

    const badgeAll = document.getElementById('filter-all-badge');
    if (badgeAll) badgeAll.textContent = cards.length;
    const badgeOnline = document.getElementById('filter-online-badge');
    if (badgeOnline) badgeOnline.textContent = onlineCount;
    const badgeOffline = document.getElementById('filter-offline-badge');
    if (badgeOffline) badgeOffline.textContent = offlineCount;
  }

  _showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-fade');
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }

  _startClock() {
    const clock = document.getElementById('live-clock');
    if (!clock) return;
    const update = () => {
      const d = new Date();
      clock.textContent = d.toLocaleTimeString('es-PE', { hour12: false });
    };
    update();
    setInterval(update, 1000);
  }
}

// ============================================================================
// 9. BOOTSTRAPPER & INITIALIZATION
// ============================================================================
let appInstance = null;

function initApp() {
  const store = new VisionDeskStore();
  const thumbnailRenderer = new ThumbnailRenderer(store);
  const restFallback = new RestFallbackService(store, thumbnailRenderer);
  const signalingClient = new SignalingClient(store, thumbnailRenderer, restFallback);
  const streamingEngine = new SessionStreamingEngine({
    signalingClient,
    store,
    masterToken: AuthManager.getToken(),
  });
  const ui = new DashboardUI(store, streamingEngine, signalingClient);

  // Connect to Signaling Hub
  signalingClient.connect();

  appInstance = {
    store,
    thumbnailRenderer,
    restFallback,
    signalingClient,
    streamingEngine,
    ui,
  };

  return appInstance;
}

// Auto-run in browser environment when DOM is ready
if (typeof window !== 'undefined') {
  window.VisionDeskStore = VisionDeskStore;
  window.ThumbnailRenderer = ThumbnailRenderer;
  window.SessionStreamingEngine = SessionStreamingEngine;
  window.SignalingClient = SignalingClient;
  window.RestFallbackService = RestFallbackService;
  window.formatMachineId = formatMachineId;
  window.serializeMouseEvent = serializeMouseEvent;
  window.serializeKeyboardEvent = serializeKeyboardEvent;
  window.serializeTextEvent = serializeTextEvent;
  window.serializePingEvent = serializePingEvent;
  window.parsePingEvent = parsePingEvent;
  window.parseBinaryEvent = parseBinaryEvent;
  window.CASCADE_STATES = CASCADE_STATES;
  window.initVisionDeskApp = initApp;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initApp());
  } else {
    initApp();
  }
}

// Export for Node.js test harness
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG,
    AuthManager,
    VK_MAP,
    formatMachineId,
    serializeMouseEvent,
    serializeKeyboardEvent,
    serializeTextEvent,
    serializePingEvent,
    parsePingEvent,
    parseBinaryEvent,
    CASCADE_STATES,
    VisionDeskStore,
    ThumbnailRenderer,
    SessionStreamingEngine,
    SignalingClient,
    RestFallbackService,
    DashboardUI,
    initApp,
  };
}
