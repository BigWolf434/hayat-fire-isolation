const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = { info: 'ℹ️', danger: '⚠️', success: '✅', error: '⛔' };

function open({ title, message = '', tone = 'info', confirmText = 'OK', cancelText = '', input = null }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'mdl-ov';
    ov.innerHTML = `<div class="mdl ${tone}" role="dialog" aria-modal="true">
      <div class="mdl-ic">${ICON[tone] || ICON.info}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(message).replace(/\n/g, '<br>')}</p>
      ${input ? `<input class="mdl-in" type="${input.type || 'text'}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">` : ''}
      <div class="mdl-btns">
        ${cancelText ? `<button data-k="no">${esc(cancelText)}</button>` : ''}
        <button class="${tone === 'error' ? 'danger' : 'pri'}" data-k="yes">${esc(confirmText)}</button>
      </div></div>`;
    const inp = ov.querySelector('.mdl-in');
    const done = (v) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const yes = () => done(input ? inp.value : true);
    const no = () => done(input ? null : false);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cancelText ? no() : yes(); }
      if (e.key === 'Enter' && document.activeElement?.dataset?.k !== 'no') { e.preventDefault(); yes(); }
    }
    ov.addEventListener('mousedown', (e) => { if (e.target === ov && cancelText) no(); });
    ov.querySelector('[data-k=yes]').onclick = yes;
    const n = ov.querySelector('[data-k=no]'); if (n) n.onclick = no;
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    (inp || ov.querySelector('[data-k=yes]')).focus();
  });
}

export const confirmBox = (o) => open({ cancelText: 'Cancel', ...o });             // -> true / false
export const alertBox = (o) => open({ ...o, cancelText: '' }).then(() => {});
export const promptBox = (o) => open({ cancelText: 'Cancel', input: { type: 'text' }, ...o }); // -> string / null

export function toast(msg, tone = 'success') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + tone;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3500);
}