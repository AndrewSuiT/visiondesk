const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');

const DEFAULT_USERS = {
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
        this.users = { ...DEFAULT_USERS, ...parsed };
      } else {
        this.users = { ...DEFAULT_USERS };
        this.save();
      }
    } catch (err) {
      console.warn('[UsersManager] Error reading users.json, using defaults:', err.message);
      this.users = { ...DEFAULT_USERS };
      this.save();
    }
  }

  save() {
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[UsersManager] Failed to write users.json:', err.message);
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

const instance = new UsersManager();
module.exports = instance;
