export function adminHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trapic Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h3 { font-size: 0.95rem; margin-bottom: 12px; }
  .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .login-card { max-width: 400px; margin: 80px auto; }
  label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px; color: #555; }
  input, select { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.9rem; margin-bottom: 12px; }
  input:focus, select:focus { outline: none; border-color: #7c3aed; box-shadow: 0 0 0 2px rgba(124,58,237,0.15); }
  button { padding: 8px 16px; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer; font-weight: 500; }
  .btn-primary { background: #7c3aed; color: #fff; }
  .btn-primary:hover { background: #6d28d9; }
  .btn-danger { background: #ef4444; color: #fff; }
  .btn-danger:hover { background: #dc2626; }
  .btn-sm { padding: 4px 10px; font-size: 0.8rem; }
  .btn-ghost { background: transparent; color: #7c3aed; border: 1px solid #e5e7eb; }
  .btn-ghost:hover { background: #f3f4f6; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #eee; color: #888; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  td { padding: 10px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  .key-cell { font-family: monospace; font-size: 0.8rem; color: #666; }
  .role-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
  .role-admin { background: #fef3c7; color: #92400e; }
  .role-user { background: #e0e7ff; color: #3730a3; }
  .actions { display: flex; gap: 6px; }
  .form-row { display: flex; gap: 12px; align-items: flex-end; }
  .form-row > div { flex: 1; }
  .form-row > div:last-child { flex: 0; }
  .empty { text-align: center; padding: 24px; color: #aaa; }
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: #fff; font-size: 0.85rem; z-index: 100; animation: fadeIn 0.2s; }
  .toast-ok { background: #22c55e; }
  .toast-err { background: #ef4444; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .logout-btn { font-size: 0.8rem; color: #888; cursor: pointer; background: none; border: none; text-decoration: underline; }
  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 2px solid #eee; }
  .tab { padding: 10px 20px; cursor: pointer; font-size: 0.9rem; font-weight: 500; color: #888; border-bottom: 2px solid transparent; margin-bottom: -2px; background: none; border-top: none; border-left: none; border-right: none; }
  .tab.active { color: #7c3aed; border-bottom-color: #7c3aed; }
  .tab:hover { color: #6d28d9; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .member-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .member-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: #f3f4f6; border-radius: 16px; font-size: 0.82rem; }
  .member-chip .remove { cursor: pointer; color: #999; font-size: 1rem; line-height: 1; }
  .member-chip .remove:hover { color: #ef4444; }
  .team-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .team-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .team-name { font-weight: 600; font-size: 0.95rem; }
  .add-member-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .add-member-row select { margin-bottom: 0; width: auto; min-width: 160px; }
  .add-member-row button { white-space: nowrap; }
</style>
</head>
<body>

<div id="app-login" class="container" style="display:none">
  <div class="card login-card">
    <h1>Trapic Admin</h1>
    <p class="subtitle">Enter admin password to continue</p>
    <label for="pwd">Admin Password</label>
    <input type="password" id="pwd" placeholder="TRAPIC_ADMIN_PASSWORD" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn-primary" style="width:100%" onclick="doLogin()">Login</button>
  </div>
</div>

<div id="app-main" class="container" style="display:none">
  <div class="header">
    <div>
      <h1>Trapic Admin</h1>
      <p class="subtitle">Manage users, teams, and API keys</p>
    </div>
    <button class="logout-btn" onclick="doLogout()">Logout</button>
  </div>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('users')">Users</button>
    <button class="tab" onclick="switchTab('teams')">Teams</button>
  </div>

  <!-- ── Users Tab ── -->
  <div id="tab-users" class="tab-content active">
    <div class="card">
      <h3>Create User</h3>
      <div class="form-row">
        <div>
          <label for="u-name">Name</label>
          <input type="text" id="u-name" placeholder="e.g. alice" style="margin-bottom:0">
        </div>
        <div>
          <label for="u-role">Role</label>
          <select id="u-role" style="margin-bottom:0">
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div>
          <button class="btn-primary" onclick="createUser()" style="margin-bottom:0;white-space:nowrap">Create</button>
        </div>
      </div>
    </div>

    <div class="card" style="padding:0; overflow-x:auto;">
      <table>
        <thead>
          <tr><th>Name</th><th>Role</th><th>API Key</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody id="user-table"><tr><td colspan="5" class="empty">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- ── Teams Tab ── -->
  <div id="tab-teams" class="tab-content">
    <div class="card">
      <h3>Create Team</h3>
      <div class="form-row">
        <div>
          <label for="t-name">Team Name</label>
          <input type="text" id="t-name" placeholder="e.g. backend-team" style="margin-bottom:0">
        </div>
        <div>
          <button class="btn-primary" onclick="createTeam()" style="margin-bottom:0;white-space:nowrap">Create</button>
        </div>
      </div>
    </div>

    <div id="teams-list"></div>
  </div>
</div>

<script>
const USERS_API = '/admin/api/users';
const TEAMS_API = '/admin/api/teams';
let token = '';
let allUsers = [];

function init() {
  token = sessionStorage.getItem('trapic_admin') || '';
  if (token) { showMain(); loadAll(); }
  else { document.getElementById('app-login').style.display = ''; }
}

function showMain() {
  document.getElementById('app-login').style.display = 'none';
  document.getElementById('app-main').style.display = '';
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[onclick*="' + name + '"]').classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function toast(msg, ok) {
  const d = document.createElement('div');
  d.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3000);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function doLogin() {
  token = document.getElementById('pwd').value.trim();
  if (!token) return;
  try {
    await api('GET', USERS_API);
    sessionStorage.setItem('trapic_admin', token);
    showMain();
    loadAll();
  } catch(e) {
    token = '';
    toast('Invalid admin password', false);
  }
}

function doLogout() {
  token = '';
  sessionStorage.removeItem('trapic_admin');
  document.getElementById('app-main').style.display = 'none';
  document.getElementById('app-login').style.display = '';
  document.getElementById('pwd').value = '';
}

function loadAll() { loadUsers(); loadTeams(); }

// ── Users ──

function maskKey(key) {
  if (!key || key.length < 12) return key;
  return key.slice(0, 6) + '\\u2022'.repeat(16) + key.slice(-4);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function renderUsers(users) {
  allUsers = users;
  const tbody = document.getElementById('user-table');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No users yet. Create one above.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => {
    const rc = u.role === 'admin' ? 'role-admin' : 'role-user';
    const created = new Date(u.created_at).toLocaleDateString();
    return '<tr>' +
      '<td><strong>' + esc(u.name) + '</strong></td>' +
      '<td><span class="role-badge ' + rc + '">' + esc(u.role) + '</span></td>' +
      '<td class="key-cell"><span id="key-' + u.id + '">' + maskKey(u.api_key) + '</span> ' +
        '<button class="btn-ghost btn-sm" onclick="toggleKey(this,\\'' + esc(u.api_key) + '\\',\\'' + u.id + '\\')">Show</button></td>' +
      '<td>' + created + '</td>' +
      '<td class="actions">' +
        '<button class="btn-ghost btn-sm" onclick="regenKey(\\'' + u.id + '\\')">Regenerate</button>' +
        '<button class="btn-danger btn-sm" onclick="deleteUser(\\'' + u.id + '\\',\\'' + esc(u.name) + '\\')">Delete</button>' +
      '</td></tr>';
  }).join('');
}

function toggleKey(btn, key, id) {
  const span = document.getElementById('key-' + id);
  if (btn.textContent === 'Show') { span.textContent = key; btn.textContent = 'Hide'; }
  else { span.textContent = maskKey(key); btn.textContent = 'Show'; }
}

async function loadUsers() {
  try { const data = await api('GET', USERS_API); renderUsers(data.users); }
  catch(e) { toast(e.message, false); }
}

async function createUser() {
  const name = document.getElementById('u-name').value.trim();
  const role = document.getElementById('u-role').value;
  if (!name) { toast('Name is required', false); return; }
  try {
    const data = await api('POST', USERS_API, { name, role });
    document.getElementById('u-name').value = '';
    toast('User created', true);
    loadAll();
  } catch(e) { toast(e.message, false); }
}

async function deleteUser(id, name) {
  if (!confirm('Delete user "' + name + '"?')) return;
  try { await api('DELETE', USERS_API + '/' + id); toast('User deleted', true); loadAll(); }
  catch(e) { toast(e.message, false); }
}

async function regenKey(id) {
  if (!confirm('Regenerate API key? The old key will stop working immediately.')) return;
  try {
    const data = await api('POST', USERS_API + '/' + id + '/regenerate');
    toast('New key: ' + data.user.api_key, true);
    loadUsers();
  } catch(e) { toast(e.message, false); }
}

// ── Teams ──

async function loadTeams() {
  try {
    const data = await api('GET', TEAMS_API);
    renderTeams(data.teams);
  } catch(e) { toast(e.message, false); }
}

async function renderTeams(teams) {
  const container = document.getElementById('teams-list');
  if (!teams.length) {
    container.innerHTML = '<div class="card"><p class="empty">No teams yet. Create one above.</p></div>';
    return;
  }

  let html = '';
  for (const team of teams) {
    let membersData;
    try { membersData = await api('GET', TEAMS_API + '/' + team.id + '/members'); }
    catch(e) { membersData = { members: [] }; }
    const members = membersData.members;

    const memberChips = members.map(m =>
      '<span class="member-chip">' + esc(m.user_name || m.user_id) +
      ' <span class="remove" onclick="removeMember(\\'' + team.id + '\\',\\'' + m.user_id + '\\')">&times;</span></span>'
    ).join('');

    const userOptions = allUsers
      .filter(u => !members.some(m => m.user_id === u.id))
      .map(u => '<option value="' + u.id + '">' + esc(u.name) + '</option>')
      .join('');

    html += '<div class="card team-card">' +
      '<div class="team-header">' +
        '<span class="team-name">' + esc(team.name) + '</span>' +
        '<button class="btn-danger btn-sm" onclick="deleteTeam(\\'' + team.id + '\\',\\'' + esc(team.name) + '\\')">Delete Team</button>' +
      '</div>' +
      '<div style="font-size:0.82rem;color:#888;margin-bottom:8px;">Members (' + members.length + ')</div>' +
      '<div class="member-list">' + (memberChips || '<span style="color:#bbb;font-size:0.82rem;">No members</span>') + '</div>' +
      (userOptions ? '<div class="add-member-row">' +
        '<select id="add-user-' + team.id + '">' + userOptions + '</select>' +
        '<button class="btn-ghost btn-sm" onclick="addMember(\\'' + team.id + '\\')">Add</button>' +
      '</div>' : '') +
    '</div>';
  }
  container.innerHTML = html;
}

async function createTeam() {
  const name = document.getElementById('t-name').value.trim();
  if (!name) { toast('Team name is required', false); return; }
  try {
    await api('POST', TEAMS_API, { name });
    document.getElementById('t-name').value = '';
    toast('Team created', true);
    loadTeams();
  } catch(e) { toast(e.message, false); }
}

async function deleteTeam(id, name) {
  if (!confirm('Delete team "' + name + '" and all its memberships?')) return;
  try { await api('DELETE', TEAMS_API + '/' + id); toast('Team deleted', true); loadTeams(); }
  catch(e) { toast(e.message, false); }
}

async function addMember(teamId) {
  const sel = document.getElementById('add-user-' + teamId);
  if (!sel || !sel.value) return;
  try {
    await api('POST', TEAMS_API + '/' + teamId + '/members', { user_id: sel.value });
    toast('Member added', true);
    loadTeams();
  } catch(e) { toast(e.message, false); }
}

async function removeMember(teamId, userId) {
  try {
    await api('DELETE', TEAMS_API + '/' + teamId + '/members/' + userId);
    toast('Member removed', true);
    loadTeams();
  } catch(e) { toast(e.message, false); }
}

init();
</script>
</body>
</html>`;
}
