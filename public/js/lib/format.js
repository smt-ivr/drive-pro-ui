/**
 * Display formatting helpers. Pure functions (unit tested).
 */

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

export function formatDateTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : dateTimeFmt.format(d);
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} שנ׳`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')} דק׳`;
}

/** Hebrew count phrases: plural(1, 'קובץ אחד', 'קבצים') → "קובץ אחד", plural(3, ...) → "3 קבצים". */
export function plural(n, one, many) {
  return n === 1 ? one : `${n.toLocaleString('he-IL')} ${many}`;
}

/** Joins phrases with the Hebrew "and" prefix: ['2 תיקיות', '6 קבצים'] → "2 תיקיות ו-6 קבצים". */
export function joinAnd(parts) {
  const list = parts.filter(Boolean);
  if (list.length < 2) return list[0] || '';
  const last = list.pop();
  return `${list.join(', ')} ${/^[0-9]/.test(last) ? 'ו-' : 'ו'}${last}`;
}

const TYPES = [
  [(m) => m === FOLDER_MIME, 'fa-folder', 'folder', 'תיקייה'],
  [(m) => m === 'application/vnd.google-apps.document', 'fa-file-lines', 'doc', 'Google Docs'],
  [(m) => m === 'application/vnd.google-apps.spreadsheet', 'fa-table', 'sheet', 'Google Sheets'],
  [(m) => m === 'application/vnd.google-apps.presentation', 'fa-person-chalkboard', 'slides', 'Google Slides'],
  [(m) => m === 'application/vnd.google-apps.form', 'fa-clipboard-list', 'form', 'Google Forms'],
  [(m) => m === 'application/vnd.google-apps.drawing', 'fa-pen-ruler', 'slides', 'Google Drawings'],
  [(m) => m === 'application/pdf', 'fa-file-pdf', 'pdf', 'PDF'],
  [(m) => m.startsWith('image/'), 'fa-file-image', 'image', 'תמונה'],
  [(m) => m.startsWith('video/'), 'fa-file-video', 'video', 'וידאו'],
  [(m) => m.startsWith('audio/'), 'fa-file-audio', 'audio', 'אודיו'],
  [(m) => /zip|rar|7z|tar|gzip|compressed/.test(m), 'fa-file-zipper', 'archive', 'ארכיון'],
  [(m) => /wordprocessingml|msword/.test(m), 'fa-file-word', 'doc', 'Word'],
  [(m) => /spreadsheetml|ms-excel|csv/.test(m), 'fa-file-excel', 'sheet', 'Excel'],
  [(m) => /presentationml|ms-powerpoint/.test(m), 'fa-file-powerpoint', 'slides', 'PowerPoint'],
  [(m) => /javascript|json|xml|html|x-python|x-sh/.test(m), 'fa-file-code', 'code', 'קוד'],
  [(m) => m.startsWith('text/'), 'fa-file-lines', 'text', 'טקסט'],
];

/** @returns {{ icon: string, tone: string, label: string }} */
export function fileType(mimeType) {
  const m = String(mimeType || '');
  for (const [test, icon, tone, label] of TYPES) {
    if (test(m)) return { icon, tone, label };
  }
  return { icon: 'fa-file', tone: 'other', label: 'קובץ' };
}

const COLLATOR = new Intl.Collator(['he', 'en'], { numeric: true, sensitivity: 'base' });

/** Folders first, then by the chosen key. */
export function sortItems(items, key = 'name', dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const by = {
    name: (a, b) => COLLATOR.compare(a.name, b.name),
    size: (a, b) => (a.size ?? -1) - (b.size ?? -1),
    modified: (a, b) => String(a.modifiedTime || '').localeCompare(String(b.modifiedTime || '')),
    type: (a, b) => COLLATOR.compare(fileType(a.targetMimeType).label, fileType(b.targetMimeType).label),
  }[key] || ((a, b) => COLLATOR.compare(a.name, b.name));

  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return sign * by(a, b) || COLLATOR.compare(a.name, b.name);
  });
}
