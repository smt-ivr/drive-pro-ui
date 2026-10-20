/**
 * Drive Pro – application controller.
 * Wires the DOM to the API client and the copy engine. All user content is
 * rendered through `h()` (text nodes only) – never through innerHTML.
 */
import { config } from './config.js';
import { ApiClient, Session } from './api.js';
import { CopyJob } from './copy-job.js';
import { $, brandIcon, h, icon, render } from './lib/dom.js';
import { fileType, formatBytes, formatDate, formatDateTime, formatDuration, joinAnd, plural, sortItems } from './lib/format.js';
import { parseLinks } from './lib/links.js';
import { storage } from './lib/storage.js';
import { toast } from './ui/toast.js';

const session = new Session();
const api = new ApiClient(config.apiBase, session);

const state = {
  /** Navigation stack: [{ id, name, items, link, truncated }] – the last entry is on screen. */
  stack: [],
  loading: false,
  resolving: false,
  /** Selected items by id; persists while navigating between folders. */
  selection: new Map(),
  filter: '',
  sort: storage.get('drivepro.sort', 'name:asc'),
  view: storage.get('drivepro.view', 'list'),
  folderCache: new Map(),
  /** @type {CopyJob | null} */
  job: null,
};

const el = {
  loginView: $('#loginView'),
  loginBtn: $('#loginBtn'),
  loginNote: $('#loginNote'),
  appView: $('#appView'),
  historyBtn: $('#historyBtn'),
  themeBtn: $('#themeBtn'),
  userMenu: $('#userMenu'),
  userBtn: $('#userBtn'),
  userDropdown: $('#userDropdown'),
  userAvatar: $('#userAvatar'),
  userInitial: $('#userInitial'),
  userName: $('#userName'),
  userEmail: $('#userEmail'),
  logoutBtn: $('#logoutBtn'),
  linkForm: $('#linkForm'),
  linkInput: $('#linkInput'),
  clearLinkBtn: $('#clearLinkBtn'),
  resolveBtn: $('#resolveBtn'),
  linkHint: $('#linkHint'),
  browser: $('#browser'),
  breadcrumbs: $('#breadcrumbs'),
  filterInput: $('#filterInput'),
  sortSelect: $('#sortSelect'),
  selectAllBox: $('#selectAllBox'),
  folderStats: $('#folderStats'),
  openSourceLink: $('#openSourceLink'),
  items: $('#items'),
  jobPanel: $('#jobPanel'),
  selectionBar: $('#selectionBar'),
  selCount: $('#selCount'),
  selMeta: $('#selMeta'),
  clearSelBtn: $('#clearSelBtn'),
  copySelBtn: $('#copySelBtn'),
  copyDialog: $('#copyDialog'),
  copyForm: $('#copyForm'),
  copySummary: $('#copySummary'),
  copyCancelBtn: $('#copyCancelBtn'),
  destInput: $('#destInput'),
  keepStructureBox: $('#keepStructureBox'),
  historyDialog: $('#historyDialog'),
  historyList: $('#historyList'),
  historyCloseBtn: $('#historyCloseBtn'),
  historyClearBtn: $('#historyClearBtn'),
};

// =============================================================== theme

const THEMES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'לפי המערכת', light: 'בהיר', dark: 'כהה' };

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  el.themeBtn.title = `מצב תצוגה: ${THEME_LABELS[theme]}`;
}

function cycleTheme() {
  const current = storage.get('drivepro.theme', 'system');
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  storage.set('drivepro.theme', next);
  applyTheme(next);
  toast(`מצב תצוגה: ${THEME_LABELS[next]}`, 'info', { duration: 1500 });
}

// =============================================================== auth

function showLogin(note = '') {
  el.appView.hidden = true;
  el.userMenu.hidden = true;
  el.historyBtn.hidden = true;
  el.selectionBar.hidden = true;
  el.loginView.hidden = false;
  el.loginNote.textContent = note;
  setLoginBusy(false);
}

function showApp() {
  el.loginView.hidden = true;
  el.appView.hidden = false;
  el.historyBtn.hidden = false;
  renderUser(session.user);
  if (!state.stack.length && !state.job) el.linkInput.focus();
}

function setLoginBusy(busy) {
  el.loginBtn.disabled = busy;
  el.loginBtn.querySelector('span').textContent = busy ? 'ממתין לאישור בחלון של גוגל…' : 'התחברות עם Google';
}

function login() {
  const url = api.loginUrl();
  const width = 500;
  const height = 640;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  const popup = window.open(url, 'drivepro-auth', `width=${width},height=${height},left=${left},top=${top}`);
  if (!popup) {
    // Popup blocked (common on mobile) – fall back to a full-page redirect.
    location.assign(url);
    return;
  }
  setLoginBusy(true);
  const timer = setInterval(() => {
    if (popup.closed) {
      clearInterval(timer);
      if (!session.isLoggedIn) setLoginBusy(false);
    }
  }, 500);
}

async function completeLogin(tokens) {
  session.setTokens(tokens);
  try {
    const user = await api.me();
    session.setUser(user);
    showApp();
    toast(`ברוך הבא${user.givenName ? `, ${user.givenName}` : ''}!`, 'success');
  } catch (err) {
    showLogin(err.message);
  }
}

function onAuthMessage(event) {
  if (event.origin !== api.origin || !event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'AUTH_SUCCESS') completeLogin(event.data.tokens);
  if (event.data.type === 'AUTH_ERROR') showLogin(event.data.error || 'ההתחברות נכשלה.');
}

/** Redirect flow: the callback page sends us back with "#auth=<base64 json>". */
function consumeAuthFragment() {
  const match = location.hash.match(/^#auth=(.+)$/);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(match[1])))));
  } catch {
    return null;
  }
}

function logout() {
  if (state.job?.isRunning && !confirm('יש העתקה פעילה. להתנתק בכל זאת?')) return;
  state.job?.cancel();
  session.clear('logout');
}

function onSessionEnd(event) {
  resetWorkspace();
  showLogin(event.detail.reason === 'expired' ? 'פג תוקף ההתחברות. יש להתחבר מחדש.' : 'התנתקת בהצלחה.');
}

function renderUser(user) {
  if (!user) return;
  el.userMenu.hidden = false;
  el.userName.textContent = user.name || 'משתמש';
  el.userEmail.textContent = user.email || '';
  el.userInitial.textContent = (user.givenName || user.name || user.email || '?').trim()[0]?.toUpperCase() || '?';
  if (user.picture) {
    el.userAvatar.src = user.picture;
    el.userAvatar.hidden = false;
    el.userInitial.hidden = true;
    el.userAvatar.onerror = () => {
      el.userAvatar.hidden = true;
      el.userInitial.hidden = false;
    };
  }
}

function toggleUserMenu(open = el.userDropdown.hidden) {
  el.userDropdown.hidden = !open;
  el.userBtn.setAttribute('aria-expanded', String(open));
}

// =============================================================== link input

function autoGrow() {
  el.linkInput.style.height = 'auto';
  el.linkInput.style.height = `${Math.min(el.linkInput.scrollHeight, 180)}px`;
}

function updateLinkHint() {
  const text = el.linkInput.value;
  el.clearLinkBtn.hidden = !text;
  autoGrow();
  if (!text.trim()) {
    el.linkHint.textContent = '';
    el.linkHint.className = 'link-hint';
    return;
  }
  const { links, invalid } = parseLinks(text);
  const parts = [];
  if (links.length === 1) parts.push(links[0].hint === 'folder' ? 'זוהתה תיקייה' : 'זוהה קישור');
  else if (links.length > 1) parts.push(`זוהו ${links.length} קישורים`);
  if (invalid.length) parts.push(`${invalid.length} לא מזוהים`);
  el.linkHint.textContent = parts.join(' · ');
  el.linkHint.className = `link-hint ${links.length ? 'ok' : 'bad'}`;
}

function setResolving(busy) {
  el.resolveBtn.disabled = busy;
  el.linkInput.readOnly = busy;
  render(el.resolveBtn, icon(busy ? 'fa-circle-notch fa-spin' : 'fa-magnifying-glass'), h('span', {}, busy ? 'טוען…' : 'המשך'));
}

async function resolveInput(event) {
  event?.preventDefault();
  if (state.resolving || state.loading) return;
  if (state.job?.isRunning) return toast('יש העתקה פעילה. המתן לסיומה או עצור אותה.', 'warning');

  const { links, invalid } = parseLinks(el.linkInput.value);
  if (!links.length) {
    el.linkForm.classList.remove('shake');
    void el.linkForm.offsetWidth;
    el.linkForm.classList.add('shake');
    return toast(invalid.length ? 'הקישור אינו קישור Google Drive תקין.' : 'הדביקו קישור ל-Google Drive.', 'error');
  }
  if (invalid.length) toast(`${plural(invalid.length, 'קישור אחד', 'קישורים')} לא זוהו ודולגו.`, 'warning');

  setResolving(true);
  state.resolving = true;
  state.selection.clear();
  state.filter = '';
  el.filterInput.value = '';
  el.jobPanel.hidden = true;

  try {
    // A single folder link: open it directly.
    if (links.length === 1 && links[0].hint === 'folder') {
      state.stack = [];
      await openFolder({ id: links[0].raw, name: '' });
      return;
    }

    const results = await Promise.allSettled(links.map((l) => api.fileInfo(l.raw)));
    const items = [];
    const errors = [];
    results.forEach((r, i) => (r.status === 'fulfilled' ? items.push(r.value) : errors.push([i, r.reason])));

    if (errors.length === 1 && !items.length) throw errors[0][1];
    errors.forEach(([index, err]) => toast(links.length > 1 ? `קישור ${index + 1}: ${err.message}` : err.message, 'error'));
    if (!items.length) return;

    if (items.length === 1 && items[0].kind === 'folder') {
      state.stack = [];
      await openFolder({ id: items[0].targetId, name: items[0].name, resourceKey: items[0].resourceKey });
      return;
    }

    state.stack = [{ id: null, name: items.length === 1 ? 'הקובץ שהזנת' : 'הפריטים שהזנת', items, link: null }];
    items.filter(isSelectable).forEach((item) => state.selection.set(item.id, item));
    showBrowser();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.resolving = false;
    setResolving(false);
  }
}

// =============================================================== browser

const isSelectable = (item) => item.canCopy !== false || item.kind === 'folder';
const current = () => state.stack[state.stack.length - 1];

function showBrowser() {
  el.browser.hidden = false;
  renderBrowser();
  updateSelectionBar();
  el.browser.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openFolder({ id, name, resourceKey }) {
  if (state.loading) return;
  state.loading = true;
  if (state.stack.length) {
    state.stack.push({ id, name, items: [], link: null, pending: true });
    state.filter = '';
    el.filterInput.value = '';
  }
  el.browser.hidden = false;
  renderBrowser();

  try {
    const listing = state.folderCache.get(id) || (await api.listFolder(id, resourceKey));
    state.folderCache.set(id, listing);
    state.folderCache.set(listing.folderId, listing);
    const entry = { id: listing.folderId, name: listing.folderName, items: listing.files, link: listing.folderLink, truncated: listing.truncated };
    if (current()?.pending) state.stack[state.stack.length - 1] = entry;
    else state.stack.push(entry);
    if (listing.truncated) toast('התיקייה גדולה מאוד – מוצגים 5,000 הפריטים הראשונים.', 'warning');
  } catch (err) {
    if (current()?.pending) state.stack.pop();
    toast(err.message, 'error');
    if (!state.stack.length) el.browser.hidden = true;
  } finally {
    state.loading = false;
    if (state.stack.length) showBrowser();
  }
}

function navigateTo(index) {
  if (state.loading || index === state.stack.length - 1) return;
  state.stack.length = index + 1;
  state.filter = '';
  el.filterInput.value = '';
  renderBrowser();
}

function visibleItems() {
  const entry = current();
  if (!entry) return [];
  const q = state.filter.trim().toLowerCase();
  const filtered = q ? entry.items.filter((i) => i.name.toLowerCase().includes(q)) : entry.items;
  const [key, dir] = state.sort.split(':');
  return sortItems(filtered, key, dir);
}

function renderBreadcrumbs() {
  const crumbs = state.stack.map((entry, i) => {
    const last = i === state.stack.length - 1;
    return [
      i > 0 && icon('fa-chevron-left', 'crumb-sep'),
      h(
        'button',
        { class: 'crumb', type: 'button', disabled: last, 'aria-current': last ? 'location' : null, onclick: () => navigateTo(i) },
        i === 0 && icon(entry.id ? 'fa-folder-open' : 'fa-inbox'),
        entry.pending ? '…' : entry.name,
      ),
    ];
  });
  render(el.breadcrumbs, crumbs);
}

function renderBrowser() {
  renderBreadcrumbs();
  el.items.className = `items view-${state.view}`;
  document.querySelectorAll('.segmented [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  el.sortSelect.value = state.sort;

  const entry = current();
  el.openSourceLink.hidden = !entry?.link;
  if (entry?.link) el.openSourceLink.href = entry.link;

  if (state.loading && (!entry || entry.pending)) {
    el.folderStats.textContent = 'טוען…';
    el.selectAllBox.disabled = true;
    return render(el.items, Array.from({ length: 6 }, () => h('div', { class: 'item skeleton' }, h('span'), h('span'), h('span'))));
  }

  const items = visibleItems();
  const all = entry?.items || [];
  const folders = all.filter((i) => i.kind === 'folder').length;
  const files = all.length - folders;
  const size = all.reduce((s, i) => s + (i.size || 0), 0);
  el.folderStats.textContent = [folders && plural(folders, 'תיקייה אחת', 'תיקיות'), files && plural(files, 'קובץ אחד', 'קבצים'), size && formatBytes(size)]
    .filter(Boolean)
    .join(' · ') || 'ריק';

  updateSelectAllBox(items);

  if (!items.length) {
    return render(
      el.items,
      h(
        'div',
        { class: 'empty-state' },
        icon(state.filter ? 'fa-magnifying-glass' : 'fa-folder-open'),
        h('p', {}, state.filter ? `לא נמצאו פריטים התואמים ל"${state.filter}"` : 'התיקייה ריקה'),
      ),
    );
  }

  const header =
    state.view === 'list' &&
    h(
      'div',
      { class: 'items-header', 'aria-hidden': 'true' },
      h('span'),
      h('span'),
      h('span', {}, 'שם'),
      h('span', { class: 'col-type' }, 'סוג'),
      h('span', { class: 'col-size' }, 'גודל'),
      h('span', { class: 'col-date' }, 'עודכן'),
      h('span'),
    );

  render(el.items, header, items.map(renderItem));
}

function updateSelectAllBox(items = visibleItems()) {
  const selectable = items.filter(isSelectable);
  const selectedCount = selectable.filter((i) => state.selection.has(i.id)).length;
  el.selectAllBox.disabled = !selectable.length;
  el.selectAllBox.checked = selectable.length > 0 && selectedCount === selectable.length;
  el.selectAllBox.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
}

function renderItem(item) {
  const type = fileType(item.targetMimeType || item.mimeType);
  const selected = state.selection.has(item.id);
  const selectable = isSelectable(item);
  const isFolder = item.kind === 'folder';

  const toggle = () => selectable && toggleSelection(item);
  const open = () => openFolder({ id: item.targetId, name: item.name, resourceKey: item.resourceKey });

  const thumb =
    state.view === 'grid' && item.thumbnailLink
      ? h('img', { class: 'item-thumb', src: item.thumbnailLink, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
      : null;

  const meta = [type.label, !isFolder && formatBytes(item.size), item.modifiedTime && formatDate(item.modifiedTime)].filter((x) => x && x !== '—');

  return h(
    'div',
    {
      class: `item${selected ? ' selected' : ''}${selectable ? '' : ' disabled'}`,
      role: 'listitem',
      tabindex: '0',
      dataset: { id: item.id },
      'aria-selected': String(selected),
      onclick: (e) => {
        if (e.target.closest('a, button, input, label')) return;
        toggle();
      },
      ondblclick: (e) => {
        if (isFolder && !e.target.closest('a, input')) open();
      },
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === ' ') {
          e.preventDefault();
          toggle();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          isFolder ? open() : toggle();
        }
      },
    },
    h('label', { class: 'item-check', title: selectable ? 'בחירה' : 'בעל הקובץ חסם העתקה' },
      h('input', { type: 'checkbox', checked: selected, disabled: !selectable, 'aria-label': `בחירת ${item.name}`, onchange: toggle })),
    h('span', { class: `item-icon tone-${type.tone}` }, thumb, icon(type.icon)),
    h(
      'div',
      { class: 'item-main' },
      isFolder
        ? h('button', { class: 'item-name link-like', type: 'button', title: `פתח את ${item.name}`, onclick: open }, item.name)
        : h('span', { class: 'item-name', title: item.name }, item.name),
      h(
        'span',
        { class: 'item-sub' },
        h('span', { class: 'item-meta' }, meta.join(' · ')),
        item.isShortcut && h('span', { class: 'tag' }, icon('fa-share'), 'קיצור דרך'),
        !selectable && h('span', { class: 'tag tag-warn' }, icon('fa-lock'), 'העתקה חסומה'),
        item.owner?.name && h('span', { class: 'tag' }, icon('fa-user'), item.owner.name),
      ),
    ),
    h('span', { class: 'col-type' }, type.label),
    h('span', { class: 'col-size', dir: 'ltr' }, isFolder ? '—' : formatBytes(item.size)),
    h('span', { class: 'col-date' }, formatDate(item.modifiedTime)),
    h(
      'span',
      { class: 'item-actions' },
      item.webViewLink && h('a', { class: 'icon-btn icon-btn-sm', href: item.webViewLink, target: '_blank', rel: 'noopener', title: 'פתח במקור', 'aria-label': `פתח את ${item.name} בדרייב` }, icon('fa-arrow-up-right-from-square')),
      isFolder && h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: 'כניסה לתיקייה', 'aria-label': `כניסה לתיקייה ${item.name}`, onclick: open }, icon('fa-chevron-left')),
    ),
  );
}

// =============================================================== selection

function toggleSelection(item) {
  const selected = !state.selection.has(item.id);
  if (selected) state.selection.set(item.id, item);
  else state.selection.delete(item.id);

  // Update just this row (keeps focus and stays fast in folders with thousands of items).
  const row = el.items.querySelector(`.item[data-id="${CSS.escape(item.id)}"]`);
  if (row) {
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
    row.querySelector('input[type=checkbox]').checked = selected;
  }
  updateSelectAllBox();
  updateSelectionBar();
}

function setVisibleSelection(selected) {
  for (const item of visibleItems().filter(isSelectable)) {
    if (selected) state.selection.set(item.id, item);
    else state.selection.delete(item.id);
  }
  renderBrowser();
  updateSelectionBar();
}

function clearSelection() {
  state.selection.clear();
  renderBrowser();
  updateSelectionBar();
}

function selectionSummary() {
  const items = [...state.selection.values()];
  const folders = items.filter((i) => i.kind === 'folder').length;
  const files = items.length - folders;
  const size = items.reduce((s, i) => s + (i.size || 0), 0);
  return { items, folders, files, size };
}

function describeSelection({ folders, files, size }) {
  const parts = [folders && plural(folders, 'תיקייה אחת', 'תיקיות'), files && plural(files, 'קובץ אחד', 'קבצים')];
  return joinAnd(parts) + (size ? ` (${formatBytes(size)}${folders ? '+' : ''})` : '');
}

function updateSelectionBar() {
  const summary = selectionSummary();
  const show = summary.items.length > 0 && !state.job && !el.appView.hidden;
  el.selectionBar.hidden = !show;
  document.body.classList.toggle('has-selection-bar', show);
  if (!show) return;
  el.selCount.textContent = summary.items.length.toLocaleString('he-IL');
  el.selMeta.textContent = `נבחרו · ${describeSelection(summary)}`;
}

// =============================================================== copy

function openCopyDialog() {
  const summary = selectionSummary();
  if (!summary.items.length) return;
  const entry = current();
  // Default: mirror the source folder's name; loose files go straight into "Drive Pro".
  el.destInput.value = entry?.id ? entry.name : '';
  el.keepStructureBox.checked = storage.get('drivepro.keepStructure', true);
  el.keepStructureBox.closest('.toggle').hidden = summary.folders === 0;
  el.copySummary.textContent = `${describeSelection(summary)} יועתקו לדרייב שלך.`;
  el.copyDialog.showModal();
  el.destInput.select();
}

function onCopyDialogSubmit(event) {
  event.preventDefault();
  const destinationPath = el.destInput.value.trim();
  const keepStructure = el.keepStructureBox.checked;
  storage.set('drivepro.keepStructure', keepStructure);
  el.copyDialog.close();
  startJob(new CopyJob(api, { items: selectionSummary().items, destinationPath, keepStructure, concurrency: config.concurrency }), destinationPath);
}

let jobFrame = 0;
let tickTimer = 0;

async function startJob(job, label) {
  state.job = job;
  job.label = label || config.rootFolderName;
  job.addEventListener('change', () => {
    if (!jobFrame) jobFrame = requestAnimationFrame(() => ((jobFrame = 0), renderJob()));
  });
  el.browser.hidden = true;
  el.jobPanel.hidden = false;
  updateSelectionBar();
  el.jobPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  tickTimer = setInterval(renderJob, 1000);

  await job.run();

  clearInterval(tickTimer);
  renderJob();
  onJobFinished(job);
}

function onJobFinished(job) {
  document.title = 'Drive Pro';
  if (job.status === 'failed' && !job.destination) return toast(job.error?.message || 'ההעתקה נכשלה.', 'error');

  const { copied } = job.stats;
  const failed = job.failures.length;
  saveHistory(job);
  if (job.status === 'cancelled') toast('ההעתקה נעצרה.', 'warning');
  else if (job.error) toast(job.error.message, 'error');
  else if (failed) toast(`הועתקו ${copied} קבצים, ${failed} נכשלו.`, 'warning');
  else toast(`${plural(copied, 'קובץ אחד', 'קבצים')} הועתקו בהצלחה!`, 'success');
  job.warnings.forEach((w) => toast(w, 'warning'));

  if (!failed && job.status === 'done') state.selection.clear();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Drive Pro', { body: `ההעתקה הסתיימה: ${copied} הועתקו${failed ? `, ${failed} נכשלו` : ''}.` });
  }
}

function renderJob() {
  const job = state.job;
  if (!job) return;
  const s = job.stats;
  const pct = Math.round(job.progress * 100);
  const running = job.isRunning;
  const elapsed = (job.finishedAt || Date.now()) - (job.startedAt || Date.now());
  const failed = job.failures.length;
  if (running) document.title = `(${pct}%) Drive Pro`;

  const status = {
    running: ['fa-circle-notch fa-spin', 'מעתיק לדרייב שלך…', 'running'],
    done: failed ? ['fa-triangle-exclamation', 'ההעתקה הסתיימה עם שגיאות', 'warn'] : ['fa-circle-check', 'ההעתקה הושלמה!', 'ok'],
    cancelled: ['fa-circle-stop', 'ההעתקה נעצרה', 'warn'],
    failed: ['fa-circle-xmark', 'ההעתקה נכשלה', 'bad'],
    idle: ['fa-hourglass', 'מתכונן…', 'running'],
  }[job.status];

  const destLink = job.destination?.link;
  const scanning = running && s.foldersDone < s.folders;

  const entries = [...job.log.values()];
  const failures = entries.filter((e) => e.status === 'failed');
  const recent = entries.filter((e) => e.status !== 'failed').slice(-40).reverse();
  const shown = running ? [...entries.filter((e) => e.status === 'running'), ...recent.filter((e) => e.status !== 'running')].slice(0, 40) : recent;

  render(
    el.jobPanel,
    h(
      'div',
      { class: `job-head status-${status[2]}` },
      h('span', { class: 'job-status-icon' }, icon(status[0])),
      h(
        'div',
        { class: 'job-title' },
        h('h2', {}, status[1]),
        h(
          'p',
          { class: 'muted' },
          'יעד: ',
          destLink
            ? h('a', { href: destLink, target: '_blank', rel: 'noopener', dir: 'auto' }, `${config.rootFolderName}${job.label && job.label !== config.rootFolderName ? ` / ${job.label}` : ''}`)
            : job.label,
          scanning ? ' · סורק תיקיות…' : '',
        ),
      ),
      h('span', { class: 'job-pct', dir: 'ltr' }, `${pct}%`),
    ),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('div', { class: `progress-fill status-${status[2]}`, style: { width: `${pct}%` } })),
    h(
      'div',
      { class: 'job-stats' },
      stat('fa-file-circle-check', 'הועתקו', `${s.copied.toLocaleString('he-IL')} / ${s.files.toLocaleString('he-IL')}`),
      stat('fa-folder-tree', 'תיקיות', `${s.foldersDone.toLocaleString('he-IL')} / ${s.folders.toLocaleString('he-IL')}`),
      stat('fa-weight-hanging', 'נפח', formatBytes(s.bytesCopied)),
      stat('fa-stopwatch', 'זמן', formatDuration(elapsed)),
      failed > 0 && stat('fa-circle-exclamation', 'נכשלו', failed.toLocaleString('he-IL'), 'bad'),
    ),
    h(
      'div',
      { class: 'job-actions' },
      running
        ? h('button', { class: 'btn btn-danger-soft', type: 'button', onclick: () => job.cancel(), disabled: job.pool.cancelled }, icon('fa-stop'), job.pool.cancelled ? 'עוצר…' : 'עצור')
        : [
            destLink && h('a', { class: 'btn btn-primary', href: destLink, target: '_blank', rel: 'noopener' }, brandIcon('fa-google-drive'), 'פתח בדרייב'),
            failed > 0 && h('button', { class: 'btn btn-secondary', type: 'button', onclick: retryFailed }, icon('fa-rotate-right'), `נסה שוב (${failed})`),
            state.stack.length > 0 && h('button', { class: 'btn btn-quiet', type: 'button', onclick: backToBrowser }, icon('fa-arrow-right'), 'חזרה לבחירה'),
            h('button', { class: 'btn btn-quiet', type: 'button', onclick: newCopy }, icon('fa-plus'), 'העתקה חדשה'),
          ],
    ),
    failures.length > 0 && h('div', { class: 'job-log' }, h('h3', {}, 'פריטים שנכשלו'), h('ul', {}, failures.map(logRow))),
    shown.length > 0 && h('details', { class: 'job-log', open: running || !failures.length }, h('summary', {}, running ? 'פעילות אחרונה' : 'פריטים שהועתקו'), h('ul', {}, shown.map(logRow))),
  );
}

function stat(iconName, label, value, tone = '') {
  return h('div', { class: `stat ${tone}` }, icon(iconName), h('span', { class: 'stat-label' }, label), h('strong', { class: 'stat-value' }, value));
}

function logRow(entry) {
  const type = fileType(entry.item.targetMimeType || entry.item.mimeType);
  const statusIcon = { running: 'fa-circle-notch fa-spin', done: 'fa-check', failed: 'fa-xmark', skipped: 'fa-forward' }[entry.status];
  return h(
    'li',
    { class: `log-row log-${entry.status}` },
    h('span', { class: `item-icon tone-${type.tone} sm` }, icon(type.icon)),
    h('span', { class: 'log-name', title: entry.item.name }, entry.link ? h('a', { href: entry.link, target: '_blank', rel: 'noopener' }, entry.item.name) : entry.item.name),
    entry.message && h('span', { class: 'log-msg' }, entry.message),
    icon(statusIcon, 'log-status'),
  );
}

function retryFailed() {
  const job = state.job;
  if (!job?.failures.length) return;
  startJob(job.retryFailed(), job.label);
}

function backToBrowser() {
  el.jobPanel.hidden = true;
  state.job = null;
  showBrowser();
}

function newCopy() {
  resetWorkspace();
  el.linkInput.value = '';
  updateLinkHint();
  el.linkInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetWorkspace() {
  state.stack = [];
  state.selection.clear();
  state.folderCache.clear();
  state.job = null;
  el.browser.hidden = true;
  el.jobPanel.hidden = true;
  updateSelectionBar();
}

// =============================================================== history

function saveHistory(job) {
  const list = storage.get('drivepro.history', []);
  list.unshift({
    at: Date.now(),
    label: job.label,
    link: job.destination?.link,
    copied: job.stats.copied,
    failed: job.failures.length,
    bytes: job.stats.bytesCopied,
    status: job.status,
  });
  storage.set('drivepro.history', list.slice(0, config.historyLimit));
}

function openHistory() {
  const list = storage.get('drivepro.history', []);
  render(
    el.historyList,
    list.length
      ? h(
          'ul',
          {},
          list.map((entry) =>
            h(
              'li',
              { class: 'history-row' },
              h('span', { class: `history-icon ${entry.failed ? 'warn' : 'ok'}` }, icon(entry.failed ? 'fa-triangle-exclamation' : 'fa-check')),
              h(
                'div',
                { class: 'history-main' },
                h('strong', {}, entry.label || config.rootFolderName),
                h('span', { class: 'muted' }, [formatDateTime(entry.at), plural(entry.copied, 'קובץ אחד', 'קבצים'), entry.failed && `${entry.failed} נכשלו`, entry.bytes && formatBytes(entry.bytes)].filter(Boolean).join(' · ')),
              ),
              entry.link && h('a', { class: 'icon-btn icon-btn-sm', href: entry.link, target: '_blank', rel: 'noopener', 'aria-label': 'פתח בדרייב' }, icon('fa-arrow-up-right-from-square')),
            ),
          ),
        )
      : h('div', { class: 'empty-state' }, icon('fa-clock-rotate-left'), h('p', {}, 'עוד לא בוצעו העתקות')),
  );
  el.historyClearBtn.hidden = !list.length;
  el.historyDialog.showModal();
}

// =============================================================== keyboard

function isTyping(target) {
  return target.closest('input, textarea, select, [contenteditable="true"]');
}

function onKeyDown(e) {
  if (el.appView.hidden || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    el.linkInput.focus();
    el.linkInput.select();
  } else if (mod && e.key.toLowerCase() === 'a' && !isTyping(e.target) && !el.browser.hidden) {
    e.preventDefault();
    setVisibleSelection(true);
  } else if (e.key === 'Escape' && state.selection.size && !isTyping(e.target)) {
    clearSelection();
  } else if (e.key === 'Backspace' && !isTyping(e.target) && state.stack.length > 1) {
    e.preventDefault();
    navigateTo(state.stack.length - 2);
  }
}

// =============================================================== boot

function bindEvents() {
  el.loginBtn.addEventListener('click', login);
  el.logoutBtn.addEventListener('click', logout);
  el.themeBtn.addEventListener('click', cycleTheme);
  el.historyBtn.addEventListener('click', openHistory);
  el.historyCloseBtn.addEventListener('click', () => el.historyDialog.close());
  el.historyClearBtn.addEventListener('click', () => {
    storage.remove('drivepro.history');
    openHistory();
  });
  el.userBtn.addEventListener('click', () => toggleUserMenu());
  document.addEventListener('click', (e) => {
    if (!el.userMenu.contains(e.target)) toggleUserMenu(false);
  });

  el.linkForm.addEventListener('submit', resolveInput);
  el.linkInput.addEventListener('input', updateLinkHint);
  el.linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) resolveInput(e);
  });
  el.linkInput.addEventListener('paste', () => {
    // Resolve right away when a single link is pasted into an empty field.
    if (el.linkInput.value.trim()) return;
    setTimeout(() => {
      updateLinkHint();
      const { links } = parseLinks(el.linkInput.value);
      if (links.length === 1 && !el.linkInput.value.includes('\n')) resolveInput();
    });
  });
  el.clearLinkBtn.addEventListener('click', () => {
    el.linkInput.value = '';
    updateLinkHint();
    el.linkInput.focus();
  });

  el.filterInput.addEventListener('input', () => {
    state.filter = el.filterInput.value;
    renderBrowser();
  });
  el.sortSelect.addEventListener('change', () => {
    state.sort = el.sortSelect.value;
    storage.set('drivepro.sort', state.sort);
    renderBrowser();
  });
  document.querySelectorAll('.segmented [data-view]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      storage.set('drivepro.view', state.view);
      renderBrowser();
    }),
  );
  el.selectAllBox.addEventListener('change', () => setVisibleSelection(el.selectAllBox.checked));

  el.clearSelBtn.addEventListener('click', clearSelection);
  el.copySelBtn.addEventListener('click', openCopyDialog);
  el.copyForm.addEventListener('submit', onCopyDialogSubmit);
  el.copyCancelBtn.addEventListener('click', () => el.copyDialog.close());
  for (const dialog of [el.copyDialog, el.historyDialog]) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // backdrop click
    });
  }

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', autoGrow);
  window.addEventListener('message', onAuthMessage);
  window.addEventListener('storage', (e) => {
    if (e.key !== 'drivepro.session') return;
    // Logged in/out in another tab (or in the auth popup in redirect mode) → follow it.
    if (Boolean(e.newValue) !== session.isLoggedIn) return location.reload();
    // Another tab refreshed the token → reuse it.
    try {
      if (e.newValue) session.data = JSON.parse(e.newValue);
    } catch {
      /* ignore malformed value */
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.job?.isRunning) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  session.addEventListener('end', onSessionEnd);
}

async function boot() {
  applyTheme(storage.get('drivepro.theme', 'system'));
  bindEvents();

  const fragment = consumeAuthFragment();
  if (fragment?.type === 'AUTH_SUCCESS') {
    await completeLogin(fragment.tokens);
    if (window.name === 'drivepro-auth' && window.opener) window.close();
    return;
  }
  if (fragment?.type === 'AUTH_ERROR') return showLogin(fragment.error);

  if (!session.isLoggedIn) return showLogin();

  showApp();
  try {
    const user = await api.me();
    session.setUser(user);
    renderUser(user);
  } catch (err) {
    if (session.isLoggedIn) toast(err.message, 'error');
  }

  if ('Notification' in window && Notification.permission === 'default') {
    // Ask lazily: only once the user starts a long copy.
    el.copyForm.addEventListener('submit', () => Notification.requestPermission().catch(() => {}), { once: true });
  }
}

boot();
