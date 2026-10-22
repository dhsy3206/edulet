// Share dialog: link + QR + visibility, members (admin), export + duplicate.
// One scrolling dialog with three sections; the chips at the top jump between them.
import { h } from '../lib/h.js';
import { api } from '../lib/api.js';
import { modal, toast, icon, avatar, qr, copyText, confirmDialog } from '../lib/ui.js';
import { qrMatrix } from '../../vendor/qrcode.js';
import { LINK_ACCESS, LINK_ACCESS_LABELS, ROLES, ROLE_LABELS } from '../lib/constants.js';
import { shareInfo } from '../lib/share-origin.js';
import { store } from '../lib/store.js';
import { boardUrl, reportError, isMember } from './common.js';
import { requireLogin } from './auth.js';
import { duplicateBoard } from './board-actions.js';

const enc = encodeURIComponent;

/* ───────── QR → PNG (drawn from the module matrix, no image decoding needed) ───────── */
function downloadQrPng(text, slug) {
  const m = qrMatrix(text);
  if (!m) return toast('주소가 너무 길어 QR을 만들지 못했어요.', 'error');
  const quiet = 4;
  const scale = 12;
  const n = m.size + quiet * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  canvas.toBlob((blob) => {
    if (!blob) return toast('이미지를 만들지 못했어요.', 'error');
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `edulet-${slug}-qr.png` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}

/* ───────── section 1: link ───────── */
// Where the "run it on your own server" instructions live (the demo and the localhost warning point here).
const README_SHARE_URL = 'https://github.com/dhsy3206/edulet#다른-pc-와-함께-쓰기';
const readmeLink = () => h('a', { href: README_SHARE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'README 의 ‘다른 PC 와 함께 쓰기’');

/** A short notice under the link: kind 'demo' | 'loopback' (amber) or 'lan' (neutral). Static text only; server values never go in here. */
function shareNote(kind, ...content) {
  return h('p', { class: ['bp-share-note', kind !== 'lan' && 'warn'], role: 'note', dataset: { role: 'share-note', kind } }, content);
}

function notesFor(info) {
  if (info.demo) {
    return [shareNote('demo',
      '이 데모는 이 브라우저 안에서만 동작해요. 다른 PC·휴대폰에서는 이 링크로 이 보드가 열리지 않아요. ',
      '여럿이 함께 쓰려면 서버 모드로 실행해 주세요. 방법은 ', readmeLink(), '에 있어요.')];
  }
  if (info.source === 'lan') {
    return [shareNote('lan', '이 주소는 같은 와이파이·유선망에 있는 다른 PC·휴대폰에서 열려요. 열리지 않으면 Windows 방화벽에서 Node.js 접근을 허용해 주세요.')];
  }
  if (info.source === 'here' && info.loopback) {
    return [shareNote('loopback',
      `지금 열린 주소(${location.host})는 이 PC 에서만 열려요. 다른 PC·휴대폰은 이 링크를 열 수 없어요. `,
      '서버 창에 나온 ‘같은 네트워크’ 주소로 이 보드를 다시 열면 그 주소로 링크를 만들어 드려요. 자세한 방법은 ', readmeLink(), '를 보세요.')];
  }
  return [];
}

function linkSection(ctl, admin) {
  const slug = ctl.slug;
  let pick = null; // the LAN address chosen in THIS dialog (never stored: the next dialog starts from the server's first one)
  let url = boardUrl(slug, pick);
  const urlInput = h('input', { class: 'input', type: 'text', name: 'url', readOnly: true, value: url, 'aria-label': '보드 링크', onFocus: (e) => e.target.select() });
  const copyBtn = h('button', { type: 'button', class: 'btn btn-primary', 'aria-label': '링크 복사' }, icon('copy', { size: 18 }), h('span', null, '복사'));
  let copyTimer;
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(url);
    if (!ok) return toast('복사하지 못했어요. 주소를 직접 선택해 복사해 주세요.', 'error');
    toast('링크를 복사했어요.', 'success');
    copyBtn.querySelector('span').textContent = '복사됨';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copyBtn.querySelector('span').textContent = '복사'), 1800);
  });

  // several network cards → let the teacher pick the address the students' devices can reach (options are text nodes)
  // (rebuilt by paintHosts: the addresses can change while the dialog or the page is open — see refreshAddresses)
  const hostSlot = h('div', { class: 'bp-share-hostslot' });
  function paintHosts() {
    const info = shareInfo(pick);
    if (pick && !info.lan.includes(pick)) pick = null; // the card that was chosen is gone (the network changed)
    if (info.lan.length < 2) return hostSlot.replaceChildren();
    const hostSel = h('select', { class: 'select', name: 'shareHost', 'aria-label': '공유할 주소', dataset: { role: 'share-host' } },
      info.lan.map((a) => h('option', { value: a }, a)));
    hostSel.value = info.base;
    hostSel.addEventListener('change', () => {
      pick = hostSel.value;
      render();
    });
    hostSel.setAttribute('aria-describedby', 'bp-share-host-hint');
    hostSlot.replaceChildren(h('div', { class: 'bp-share-host' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, '공유할 주소'), hostSel),
      h('p', { class: 'hint', id: 'bp-share-host-hint' }, '이 PC 에 네트워크 연결이 여러 개라 주소가 여럿이에요. 함께 쓸 사람과 같은 네트워크의 주소를 골라 주세요.')));
  }
  paintHosts();

  const notesBox = h('div', { class: 'bp-share-notes', 'aria-live': 'polite' });
  const qrBox = h('div', { class: 'bp-share-qr' });
  function render() {
    const info = shareInfo(pick);
    url = boardUrl(slug, pick);
    urlInput.value = url;
    notesBox.replaceChildren(...notesFor(info));
    const qrEl = qr(url);
    qrBox.replaceChildren(
      h('div', { class: 'bp-share-qrbox' }, qrEl || h('p', { class: 'muted' }, '주소가 너무 길어 QR을 만들지 못했어요.')),
      h('div', { class: 'bp-share-qrside' },
        h('p', { class: 'muted' }, info.demo
          ? '스캔하면 데모 사이트가 열려요. 이 보드의 내용은 이 브라우저에만 있어서 다른 기기에서는 보이지 않아요.'
          : '휴대폰 카메라로 스캔하면 바로 열려요. 교실 화면에 띄워 두기에 좋아요.'),
        qrEl ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => downloadQrPng(url, slug) }, icon('download', { size: 16 }), 'QR 저장(PNG)') : null));
  }
  render();

  const visSel = h('select', { class: 'select', name: 'visibility', 'aria-label': '공개 범위' },
    h('option', { value: 'private' }, '비공개 — 구성원만'), h('option', { value: 'link' }, '링크가 있는 누구나'));
  const accSel = h('select', { class: 'select', name: 'linkAccess', 'aria-label': '링크로 들어온 사람의 권한' },
    LINK_ACCESS.map((a) => h('option', { value: a }, LINK_ACCESS_LABELS[a])));
  const note = h('p', { class: 'hint', 'aria-live': 'polite' });

  function sync() {
    const b = ctl.state.board;
    if (!b) return;
    visSel.value = b.visibility;
    accSel.value = b.linkAccess;
    visSel.disabled = !admin;
    accSel.disabled = !admin || b.visibility !== 'link';
    note.textContent = !admin
      ? '공개 범위는 보드 관리자만 바꿀 수 있어요.'
      : b.visibility === 'link'
        ? `링크를 아는 누구나 “${LINK_ACCESS_LABELS[b.linkAccess]}” 권한으로 들어와요.`
        : '비공개예요. 구성원으로 추가한 사람만 열 수 있어요.';
  }
  async function save(patch, okMsg) {
    try {
      await ctl.updateBoard(patch);
      toast(okMsg, 'success');
    } catch (e) {
      reportError(e, '저장하지 못했어요. 다시 시도해 주세요.');
    }
    sync();
  }
  visSel.addEventListener('change', () => save({ visibility: visSel.value }, '공개 범위를 바꿨어요.'));
  accSel.addEventListener('change', () => save({ linkAccess: accSel.value }, '링크 권한을 바꿨어요.'));
  sync();

  const el = h('section', { class: 'bp-share-sec', id: 'bp-share-link', dataset: { section: 'link' } },
    h('h3', null, '링크로 공유'),
    h('div', { class: 'bp-share-linkrow' }, urlInput, copyBtn),
    hostSlot,
    notesBox,
    qrBox,
    h('div', { class: 'bp-share-access' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, '공개 범위'), visSel),
      h('label', { class: 'field' }, h('span', { class: 'label' }, '링크로 들어온 사람의 권한'), accSel),
      note));
  /** Re-read the addresses and rebuild the picker, the link and the QR code (the network address of a Wi-Fi PC can change at any time). */
  function refreshAddresses() {
    paintHosts();
    render();
  }
  return { el, sync, refreshAddresses, destroy: () => clearTimeout(copyTimer) };
}

/* ───────── section 2: members (admin) ───────── */
function membersSection(ctl) {
  const slug = ctl.slug;
  const base = `/boards/${enc(slug)}/members`;
  const list = h('div', { class: 'bp-members', 'aria-live': 'polite' }, h('span', { class: 'spinner' }));
  let seq = 0;
  let timer;
  let destroyed = false;

  function roleSelect(m) {
    const sel = h('select', { class: 'select bp-member-role', 'aria-label': `${m.user.displayName} 권한` },
      ROLES.map((r) => h('option', { value: r }, ROLE_LABELS[r])));
    sel.value = m.role;
    sel.addEventListener('change', async () => {
      try {
        await api.patch(`${base}/${m.user.id}`, { role: sel.value });
        toast('권한을 바꿨어요.', 'success');
      } catch (e) {
        reportError(e);
      }
      load();
    });
    return sel;
  }

  function row(m) {
    const u = m.user;
    return h('div', { class: 'bp-member', dataset: { userId: u.id } },
      avatar(u, 34),
      h('div', { class: 'bp-member-who' }, h('strong', { class: 'truncate' }, u.displayName), h('span', { class: 'muted truncate' }, u.username ? '@' + u.username : '게스트')),
      m.isOwner ? h('span', { class: 'chip ok' }, '소유자') : roleSelect(m),
      m.isOwner ? h('span', { class: 'bp-member-gap' }) : h('button', {
        type: 'button', class: 'btn-icon sm', 'aria-label': `${u.displayName} 구성원에서 빼기`, title: '구성원에서 빼기',
        onClick: async () => {
          if (!(await confirmDialog({ title: '구성원에서 뺄까요?', message: `${u.displayName}님은 더 이상 이 보드에 대한 개별 권한을 갖지 않아요.`, confirmLabel: '빼기', danger: true }))) return;
          try {
            await api.del(`${base}/${u.id}`);
            toast('구성원에서 뺐어요.', 'success');
          } catch (e) {
            reportError(e);
          }
          load();
        },
      }, icon('trash', { size: 16 })));
  }

  async function load() {
    const my = ++seq;
    try {
      const r = await api.get(base);
      if (my !== seq || destroyed) return;
      const items = r.members || [];
      list.replaceChildren(...(items.length > 1 ? items.map(row) : [...items.map(row), h('p', { class: 'hint bp-members-empty' }, '아직 추가한 구성원이 없어요. 아래에서 아이디로 추가해 보세요.')]));
    } catch (e) {
      if (my !== seq || destroyed) return;
      list.replaceChildren(h('p', { class: 'form-error' }, e.message || '구성원을 불러오지 못했어요.'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: load }, '다시 시도'));
    }
  }
  function refreshSoon() {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  }

  const nameIn = h('input', { class: 'input', type: 'text', name: 'username', placeholder: '아이디 (예: kim.teacher)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': '추가할 사용자 아이디' });
  const roleSel = h('select', { class: 'select', name: 'role', 'aria-label': '권한' }, ROLES.map((r) => h('option', { value: r }, ROLE_LABELS[r])));
  roleSel.value = 'write';
  const addBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, '추가');
  const addErr = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'bp-share-add', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    addErr.textContent = '';
    const username = nameIn.value.trim().replace(/^@/, '').toLowerCase();
    if (!username) {
      addErr.textContent = '추가할 사람의 아이디를 입력해 주세요.';
      nameIn.focus();
      return;
    }
    addBtn.disabled = true;
    try {
      await api.post(base, { username, role: roleSel.value });
      nameIn.value = '';
      toast('구성원을 추가했어요.', 'success');
      await load();
    } catch (ex) {
      addErr.textContent = ex.message || '추가하지 못했어요. 다시 시도해 주세요.';
    } finally {
      addBtn.disabled = false;
    }
  } }, nameIn, roleSel, addBtn);

  const el = h('section', { class: 'bp-share-sec', id: 'bp-share-members', dataset: { section: 'members' } },
    h('h3', null, '구성원'),
    h('p', { class: 'muted' }, '링크 권한과 별개로, 사람마다 권한을 정할 수 있어요. 상대가 먼저 가입해 있어야 해요.'),
    list, form, addErr);
  load();
  return { el, refresh: refreshSoon, destroy() { destroyed = true; clearTimeout(timer); } };
}

/* ───────── section 3: export + duplicate ───────── */
function exportSection(ctl, closeDialog) {
  const slug = ctl.slug;
  const withPosts = h('input', { type: 'checkbox', name: 'withPosts', checked: true });
  const dupBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('copy', { size: 18 }), '내 보드로 복제');
  dupBtn.addEventListener('click', async () => {
    const user = await requireLogin({ message: '보드를 복제하려면 로그인이 필요해요.', tab: 'register' });
    if (!user || !isMember(user)) return;
    dupBtn.disabled = true;
    try {
      await duplicateBoard(slug, withPosts.checked);
      closeDialog();
    } catch (e) {
      reportError(e, '복제하지 못했어요. 다시 시도해 주세요.');
    } finally {
      dupBtn.disabled = false;
    }
  });
  // downloaded through fetch (not a bare link) so it also works where the session is not a cookie (static demo)
  const dl = (format, label) => h('a', {
    class: 'btn btn-secondary', href: `/api/boards/${enc(slug)}/export?format=${format}`, download: '',
    onClick: async (e) => {
      e.preventDefault();
      try {
        await api.download(`/boards/${enc(slug)}/export?format=${format}`, `${slug}.${format}`);
      } catch (err) {
        toast(err.message || '내려받지 못했어요.', 'error');
      }
    },
  }, icon('download', { size: 18 }), label);
  const el = h('section', { class: 'bp-share-sec', id: 'bp-share-export', dataset: { section: 'export' } },
    h('h3', null, '내보내기'),
    h('p', { class: 'muted' }, '보드의 글을 파일로 내려받아요. CSV는 엑셀에서 열 수 있어요.'),
    h('div', { class: 'row bp-share-wrap' }, dl('json', 'JSON 파일'), dl('csv', 'CSV 파일 (엑셀)')),
    h('h3', { class: 'bp-share-h3-gap' }, '복제'),
    h('p', { class: 'muted' }, '이 보드를 내 보드로 복사해서 이어서 쓸 수 있어요.'),
    h('label', { class: 'checkbox bp-share-check' }, withPosts, h('span', null, '글도 함께 복사')),
    h('div', { class: 'row' }, dupBtn));
  return { el, destroy() {} };
}

/** Open the share dialog. Returns the modal handle ({ close }). opts.section: 'link' | 'members' | 'export'. */
export function openSharePanel(ctl, { section = 'link' } = {}) {
  const admin = ctl.can('admin');
  const link = linkSection(ctl, admin);
  const members = admin ? membersSection(ctl) : null;
  let m;
  const exp = exportSection(ctl, () => m && m.close());
  const parts = [
    { id: 'link', label: '링크', part: link },
    members && { id: 'members', label: '구성원', part: members },
    { id: 'export', label: '내보내기·복제', part: exp },
  ].filter(Boolean);

  const navBtns = {};
  const nav = h('nav', { class: 'bp-share-nav', 'aria-label': '공유 메뉴' }, parts.map((p) => (navBtns[p.id] = h('button', {
    type: 'button', class: 'bp-share-chip', dataset: { tab: p.id }, onClick: () => go(p.id),
  }, p.label))));
  const body = h('div', { class: 'bp-share' }, nav, parts.map((p) => p.part.el));

  const setActive = (id) => parts.forEach((p) => {
    navBtns[p.id].classList.toggle('on', p.id === id);
    navBtns[p.id].setAttribute('aria-current', String(p.id === id));
  });
  function go(id) {
    const p = parts.find((x) => x.id === id);
    if (!p) return;
    setActive(id);
    p.part.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const unsub = ctl.subscribe((ev) => {
    if (ev.type === 'board' || ev.type === 'snapshot') link.sync();
    if (members && ev.type === 'snapshot') members.refresh();
  });

  // A teacher's Wi-Fi address can change while the page stays open (reconnect, sleep, a new router lease). The dialog was just painted
  // from the config loaded earlier, so read it again now and, if the addresses differ, rebuild the link and QR code with the current ones.
  let closed = false;
  const addressesNow = () => JSON.stringify((store.config && store.config.share) || null);
  const seen = addressesNow();
  store.refreshConfig().then(() => {
    if (closed || addressesNow() === seen) return;
    link.refreshAddresses();
    toast('이 PC 의 네트워크 주소가 바뀌어서 링크와 QR 을 새 주소로 다시 만들었어요.');
  });

  m = modal({
    title: '공유', size: 'md', body,
    onClose: () => {
      closed = true;
      unsub();
      parts.forEach((p) => p.part.destroy && p.part.destroy());
    },
  });
  m.el.dataset.role = 'share';
  const scroller = m.el.querySelector('.modal-body');
  scroller.addEventListener('scroll', () => {
    let cur = parts[0].id;
    for (const p of parts) if (p.part.el.offsetTop - scroller.scrollTop <= 110) cur = p.id;
    // at the very bottom the last section wins even if it is too short to reach the top
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) cur = parts[parts.length - 1].id;
    setActive(cur);
  }, { passive: true });
  setActive(section);
  if (section !== 'link') requestAnimationFrame(() => go(section));
  return m;
}
