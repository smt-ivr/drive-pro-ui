/**
 * Parsing of Google Drive links typed or pasted by the user. Pure functions (unit tested).
 */

const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const FOLDER_RE = /\/folders\/([A-Za-z0-9_-]{10,})/;
const FILE_RES = [
  /\/(?:file|document|spreadsheets|presentation|forms|drawings)\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{10,})/,
  /\/d\/([A-Za-z0-9_-]{10,})/,
  /[?&#]id=([A-Za-z0-9_-]{10,})/,
];

/**
 * @typedef {{ raw: string, id: string, hint: 'folder' | 'file' | 'unknown' }} ParsedLink
 */

/** @returns {ParsedLink | null} */
export function parseLink(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (ID_RE.test(value)) return { raw: value, id: value, hint: 'unknown' };

  const folder = value.match(FOLDER_RE);
  if (folder) return { raw: value, id: folder[1], hint: 'folder' };

  for (const re of FILE_RES) {
    const m = value.match(re);
    if (m) return { raw: value, id: m[1], hint: 'file' };
  }
  return null;
}

/**
 * Splits free text (one or many links, separated by whitespace or commas) into unique Drive links.
 * @returns {{ links: ParsedLink[], invalid: string[] }}
 */
export function parseLinks(text) {
  const tokens = String(text || '')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const links = [];
  const invalid = [];
  const seen = new Set();
  for (const token of tokens) {
    const parsed = parseLink(token);
    if (!parsed) {
      invalid.push(token);
    } else if (!seen.has(parsed.id)) {
      seen.add(parsed.id);
      links.push(parsed);
    }
  }
  return { links, invalid };
}
