(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const nameEl = $('name');
  const messageEl = $('message');
  const countEl = $('count');
  const errorEl = $('error');
  const submitEl = $('submit');
  const doneEl = $('done');
  const MAX_MESSAGE = 700;

  function showError(text, focusEl) {
    errorEl.textContent = text;
    errorEl.hidden = false;
    if (focusEl) focusEl.focus();
  }

  function updateCount() {
    const n = [...messageEl.value].length;
    countEl.textContent = `${n} / ${MAX_MESSAGE}`;
    countEl.classList.toggle('near', n > MAX_MESSAGE - 60);
  }
  messageEl.addEventListener('input', updateCount);

  // Personalise the page with the portrait and name, if the administrator has set them.
  fetch('/api/state', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return;
      const { displayName, portraitVersion } = data.settings || {};
      if (displayName) {
        document.querySelector('.eyebrow').textContent = 'In loving memory of';
        $('title').textContent = displayName;
        document.title = `Share a message · ${displayName}`;
      }
      if (portraitVersion) {
        $('avatarImg').addEventListener('load', () => ($('avatar').hidden = false));
        $('avatarImg').src = `/portrait?v=${encodeURIComponent(portraitVersion)}`;
      }
    })
    .catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const name = nameEl.value.trim();
    const message = messageEl.value.trim();
    if (!name) return showError('Please enter your name.', nameEl);
    if (!message) return showError('Please write a message.', messageEl);
    if ([...message].length > MAX_MESSAGE) return showError(`Please keep your message under ${MAX_MESSAGE} characters.`, messageEl);

    submitEl.disabled = true;
    submitEl.textContent = 'Sending…';
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message, website: $('website').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const field = data.field === 'name' ? nameEl : data.field === 'message' ? messageEl : null;
        showError(data.error || 'Sorry, your message could not be sent. Please try again.', field);
        return;
      }
      form.hidden = true;
      doneEl.hidden = false;
      messageEl.value = '';
      updateCount();
      doneEl.scrollIntoView({ block: 'start' });
    } catch {
      showError('We could not reach the server. Please check your connection and try again — your message is still here.');
    } finally {
      submitEl.disabled = false;
      submitEl.textContent = 'Share message';
    }
  });

  $('again').addEventListener('click', () => {
    doneEl.hidden = true;
    form.hidden = false;
    messageEl.focus();
  });

  updateCount();
})();
