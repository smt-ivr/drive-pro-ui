/**
 * Minimal DOM builder. Text is always inserted as text nodes, never as HTML,
 * so file names coming from Drive can't inject markup.
 *
 *   h('button', { class: 'btn', onclick: fn, disabled: true }, icon('fa-copy'), 'העתק')
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function icon(name, extra = '') {
  return h('i', { class: `fa-solid ${name} ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function brandIcon(name) {
  return h('i', { class: `fa-brands ${name}`, 'aria-hidden': 'true' });
}

export function render(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

export const $ = (selector, root = document) => root.querySelector(selector);
