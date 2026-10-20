/**
 * Lightweight accessible toasts (no external dependency).
 */
import { h, icon } from '../lib/dom.js';

const ICONS = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };

let container;

/**
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} [type]
 * @param {{ duration?: number, action?: { label: string, onClick: () => void } }} [opts]
 */
export function toast(message, type = 'info', { duration = type === 'error' ? 7000 : 4000, action } = {}) {
  container ||= document.getElementById('toasts');
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  const el = h(
    'div',
    { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(ICONS[type] || ICONS.info, 'toast-icon'),
    h('span', { class: 'toast-text' }, message),
    action && h('button', { class: 'toast-action', type: 'button', onclick: () => { action.onClick(); close(); } }, action.label),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'סגור', onclick: close }, icon('fa-xmark')),
  );
  container.append(el);
  while (container.children.length > 4) container.firstElementChild.remove();
  if (duration) setTimeout(close, duration);
  return close;
}
