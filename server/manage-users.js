#!/usr/bin/env node
/**
 * VisionDesk CLI - Administrador de Cuentas, Planes y Contraseñas
 * 
 * Uso:
 *   node server/manage-users.js --list
 *   node server/manage-users.js --set-plan <usuario> <pro|free>
 *   node server/manage-users.js --set-password <usuario> <nueva-contraseña>
 */

const usersManager = require('./users-manager');

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
======================================================
  VisionDesk — Gestor de Cuentas y Licencias (CLI)
======================================================

Comandos disponibles:
  --list
      Muestra todas las cuentas, sus contraseñas, roles y planes actuales.

  --set-plan <usuario> <pro|free>
      Cambia el plan de una cuenta entre PRO y FREE.
      Ejemplo: node server/manage-users.js --set-plan admin free
               node server/manage-users.js --set-plan usuario pro

  --set-password <usuario> <nueva-contraseña>
      Cambia la contraseña de una cuenta.
      Ejemplo: node server/manage-users.js --set-password admin Manz-601$
               node server/manage-users.js --set-password usuario M20120752601
               node server/manage-users.js --set-password moderador Odisea_11$
======================================================
`);
}

function listUsers() {
  const users = usersManager.getAllUsers();
  console.log('\n--- CUENTAS REGISTRADAS EN VISIONDESK ---');
  console.table(users.map(u => ({
    Usuario: u.username,
    Nombre: u.displayName,
    Rol: u.role,
    Plan: u.plan.toUpperCase(),
    Contraseña: u.password,
    Actualizado: u.updatedAt
  })));
  console.log('Total cuentas:', users.length, '\n');
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printHelp();
  listUsers();
  process.exit(0);
}

if (args.includes('--list') || args.includes('-l')) {
  listUsers();
  process.exit(0);
}

const setPlanIdx = args.indexOf('--set-plan');
if (setPlanIdx !== -1) {
  const user = args[setPlanIdx + 1];
  const plan = args[setPlanIdx + 2];
  if (!user || !plan) {
    console.error('Error: Debe especificar el usuario y el plan. Ejemplo: --set-plan admin free');
    process.exit(1);
  }
  const result = usersManager.setPlan(user, plan);
  if (result.success) {
    console.log(`\nÉXITO: Plan de "${user}" actualizado a [${plan.toUpperCase()}].`);
    listUsers();
  } else {
    console.error(`\nERROR: ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

const setPwdIdx = args.indexOf('--set-password');
if (setPwdIdx !== -1) {
  const user = args[setPwdIdx + 1];
  const pwd = args[setPwdIdx + 2];
  if (!user || !pwd) {
    console.error('Error: Debe especificar el usuario y la nueva contraseña. Ejemplo: --set-password admin MiNuevaClave');
    process.exit(1);
  }
  const result = usersManager.setPassword(user, pwd);
  if (result.success) {
    console.log(`\nÉXITO: Contraseña de "${user}" actualizada.`);
    listUsers();
  } else {
    console.error(`\nERROR: ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

console.error('Comando desconocido.');
printHelp();
process.exit(1);
