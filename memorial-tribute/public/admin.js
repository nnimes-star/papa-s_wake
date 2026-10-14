(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const state = { messages: [], filter: 'all', query: '', settings: null };
  let events = null;
  let refreshTimer = null;

  // ───────────── API ─────────────
  class AuthError extends Error {}

  async function api(method, url, body, headers = {}) {
    const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'memorial', ...headers } };
    if (body instanceof Blob) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/admin/login') {
      showLogin();
      throw new AuthError('Signed out');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ───────────── views ─────────────
  function showLogin() {
    if (events) {
      events.close();
      events = null;
    }
    $('adminView').hidden = true;
    $('loginView').hidden = false;
    $('password').value = '';
    $('password').focus();
  }

  async function showAdmin() {
    $('loginView').hidden = true;
    $('adminView').hidden = false;
    await Promise.all([loadMessages(), loadSettings()]);
    connectEvents();
  }

  let toastTimer;
  function toast(text, isError = false) {
    const t = $('toast');
    t.textContent = text;
    t.classList.toggle('error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2600);
  }
  const fail = (err) => {
    if (!(err instanceof AuthError)) toast(err.message || 'Something went wrong.', true);
  };

  // ───────────── sign in / out ─────────────
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('loginError');
    err.hidden = true;
    $('loginBtn').disabled = true;
    try {
      await api('POST', '/api/admin/login', { password: $('password').value });
      await showAdmin();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      $('loginBtn').disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/admin/logout', {});
    } catch {}
    showLogin();
  });

  // ───────────── messages ─────────────
  async function loadMessages() {
    const data = await api('GET', '/api/admin/messages');
    state.messages = data.messages;
    renderMessages();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadMessages().catch(() => {}), 150);
  }

  function connectEvents() {
    if (events) events.close();
    events = new EventSource('/api/events');
    events.addEventListener('sync', scheduleRefresh);
    events.addEventListener('hello', scheduleRefresh); // also refreshes after a reconnect
  }

  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function renderMessages() {
    const all = state.messages;
    const published = all.filter((m) => m.status === 'published').length;
    const hidden = all.filter((m) => m.status === 'hidden').length;
    $('summary').textContent = `${all.length} total · ${published} published · ${hidden} hidden`;

    const q = state.query.trim().toLowerCase();
    const rows = all.filter(
      (m) =>
        (state.filter === 'all' || m.status === state.filter) &&
        (!q || m.name.toLowerCase().includes(q) || m.message.toLowerCase().includes(q))
    );

    const list = $('list');
    list.replaceChildren(...rows.map(messageItem));
    $('empty').hidden = rows.length > 0;
    $('empty').textContent = all.length
      ? 'No messages match this filter.'
      : 'No messages yet. New submissions appear here the moment they arrive.';
  }

  function messageItem(m) {
    const li = document.createElement('li');
    li.className = 'msg' + (m.status === 'hidden' ? ' is-hidden' : '');

    const head = document.createElement('div');
    head.className = 'msg-head';
    const name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = m.name;
    const time = document.createElement('time');
    time.className = 'msg-time';
    time.dateTime = m.createdAt;
    time.textContent = fmt.format(new Date(m.createdAt));
    const badge = document.createElement('span');
    badge.className = `badge badge-${m.status}`;
    badge.textContent = m.status;
    head.append(name, time, badge);

    const body = document.createElement('p');
    body.className = 'msg-body';
    body.textContent = m.message;

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (m.status === 'hidden') {
      actions.append(button('Restore', 'btn btn-small', () => act(m.id, 'restore')));
    } else {
      actions.append(button('Hide', 'btn btn-small', () => act(m.id, 'hide')));
    }
    actions.append(button('Delete…', 'btn btn-small btn-danger', () => remove(m)));

    li.append(head, body, actions);
    return li;
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  async function act(id, action) {
    try {
      await api('POST', `/api/admin/messages/${id}/${action}`, {});
      toast(action === 'hide' ? 'Hidden — removed from the TV display.' : 'Restored — it will return to the rotation.');
      await loadMessages();
    } catch (err) {
      fail(err);
    }
  }

  async function remove(m) {
    if (!window.confirm(`Permanently delete the message from ${m.name}? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/admin/messages/${m.id}`);
      toast('Message deleted.');
      await loadMessages();
    } catch (err) {
      fail(err);
    }
  }

  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      state.filter = tab.dataset.filter;
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-pressed', String(t === tab)));
      renderMessages();
    })
  );
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderMessages();
  });

  // ───────────── settings ─────────────
  async function loadSettings() {
    const s = await api('GET', '/api/admin/settings');
    state.settings = s;
    $('displayName').value = s.displayName || '';
    $('dates').value = s.dates || '';
    $('rotationSeconds').value = s.rotationSeconds;
    $('focusY').value = s.portraitFocusY;
    $('focusOut').textContent = s.portraitFocusY;
    $('guestUrl').value = s.guestUrl || '';
    $('guestUrl').placeholder = `Automatic: ${s.effectiveGuestUrl}`;
    $('guestUrlHelp').textContent =
      `The QR code currently points to ${s.effectiveGuestUrl}. ` +
      'Set this if the address shown is not the one guests’ phones can reach (for example a public web address).';
    showPortrait(s.portraitVersion);
    $('portraitPreviewImg').style.objectPosition = `50% ${s.portraitFocusY}%`;
  }

  function showPortrait(version) {
    const img = $('portraitPreviewImg');
    if (version) {
      img.src = `/portrait?v=${encodeURIComponent(version)}`;
      img.hidden = false;
      $('portraitPreviewEmpty').hidden = true;
      $('portraitRemove').hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      $('portraitPreviewEmpty').hidden = false;
      $('portraitRemove').hidden = true;
    }
  }

  $('focusY').addEventListener('input', (e) => {
    $('focusOut').textContent = e.target.value;
    $('portraitPreviewImg').style.objectPosition = `50% ${e.target.value}%`;
  });

  $('saveSettings').addEventListener('click', async () => {
    try {
      const s = await api('PUT', '/api/admin/settings', {
        displayName: $('displayName').value,
        dates: $('dates').value,
        rotationSeconds: Number($('rotationSeconds').value),
        portraitFocusY: Number($('focusY').value),
        guestUrl: $('guestUrl').value,
      });
      toast('Settings saved — the display updates automatically.');
      await loadSettings();
      return s;
    } catch (err) {
      fail(err);
    }
  });

  // Large photographs are scaled down in the browser (also normalises phone-camera rotation).
  async function prepareImage(file) {
    const MAX_EDGE = 3000;
    const needsResize = file.size > 6 * 1024 * 1024;
    if (!needsResize || typeof createImageBitmap !== 'function') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      return blob || file;
    } catch {
      return file;
    }
  }

  $('portraitFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast('Please choose a JPEG, PNG or WebP photograph.', true);
      return;
    }
    try {
      toast('Uploading portrait…');
      const blob = await prepareImage(file);
      if (blob.size > 15 * 1024 * 1024) throw new Error('That photograph is too large (15 MB maximum).');
      const result = await api('PUT', '/api/admin/portrait', blob, { 'Content-Type': blob.type || file.type });
      showPortrait(result.portraitVersion);
      toast('Portrait updated — the display swaps it in automatically.');
    } catch (err) {
      fail(err);
    }
  });

  $('portraitRemove').addEventListener('click', async () => {
    if (!window.confirm('Remove the portrait from the display?')) return;
    try {
      await api('DELETE', '/api/admin/portrait');
      showPortrait(null);
      toast('Portrait removed.');
    } catch (err) {
      fail(err);
    }
  });

  // ───────────── start ─────────────
  fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => r.json())
    .then((s) => (s.authenticated ? showAdmin() : showLogin()))
    .catch(showLogin);
})();
