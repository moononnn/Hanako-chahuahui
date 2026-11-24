import { detectMemeExplanation } from './meme-capture.js';
import { stickerIdFromBubble } from './stickers.js';

export function normalizeStickerCorrections(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id ?? '').trim();
    const meaning = String(row?.meaning ?? '').trim().slice(0, 60);
    const messageId = String(row?.messageId ?? '').trim().slice(0, 120);
    if (/^[\w-]{1,120}$/u.test(id) && meaning && messageId) {
      byId.delete(id);
      byId.set(id, { id, meaning, messageId });
    }
  }
  return [...byId.values()].slice(-100);
}

export function stickerCorrectionFrom(message, history, { aliases = new Map(), allowedIds = new Set() } = {}) {
  if (message?.role !== 'user' || message.recalled || !message.id) return null;
  const text = String(message.text ?? '');
  const cue = text.match(/理解错|用错|发错|搞错|弄错|误会|别把.{0,16}当/u);
  if (!cue || (!message.quote?.messageId && !/表情|这张|那张|这个梗/u.test(text))) return null;
  const tail = text.slice(cue.index + cue[0].length);
  const meaning = detectMemeExplanation(tail) || tail.match(/(?:它是|用来|表达的是)([^，。！？\n]{2,40})/u)?.[1]?.trim();
  if (!meaning || /^(?:不是|不该|别|不能|不要|我|你|她|他)/u.test(meaning)) return null;
  const rows = Array.isArray(history) ? history : [];
  let targets;
  if (message.quote?.messageId) {
    targets = [rows.find(row => row.id === message.quote.messageId && Date.parse(row.at) <= Date.parse(message.at))];
  } else {
    // 只看上一句她的话及其后的紧邻回复，不跨过另一个话头找图。
    targets = [];
    const now = Date.parse(message.at);
    for (let i = rows.length - 1; i >= 0 && targets.length < 3; i -= 1) {
      const row = rows[i];
      const gap = now - Date.parse(row.at);
      if (!Number.isFinite(gap) || gap < 0 || gap > 10 * 60_000) break;
      targets.push(row);
      if (row.role === 'user') break;
    }
  }
  const ids = new Set();
  for (const row of targets) {
    if (!row || row.recalled || !['assistant', 'user'].includes(row.role)) continue;
    for (const bubble of row.bubbles ?? []) {
      const raw = stickerIdFromBubble(bubble);
      if (raw) ids.add(aliases.get(raw) || raw);
    }
  }
  if (ids.size !== 1) return null;
  const [id] = ids;
  return allowedIds.has(id) ? { id, meaning, messageId: message.id } : null;
}

export function correctedSticker(row, meaning) {
  if (!row || !meaning) return row;
  return { ...row, description: meaning, emotion: [], scene: [], keywords: [], correctedMeaning: meaning };
}

export function applyStickerCorrections(catalog, corrections) {
  if (!catalog || !corrections.length) return catalog;
  const meanings = new Map(corrections.map(row => [row.id, row.meaning]));
  const stickers = catalog.stickers.map(row => correctedSticker(row, meanings.get(String(row.id))));
  return { ...catalog, stickers, byId: new Map(stickers.map(row => [String(row.id), row])) };
}
