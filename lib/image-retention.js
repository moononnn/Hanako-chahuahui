/**
 * 图片留多久，以及现在占了多少。
 *
 * 期限是她自己定的：三十天、四十五、六十、九十，或者永久不删。
 * 但**期限只负责标出哪些过了年头，不负责动手**。真要清哪些、什么时候清，
 * 是她在设置页里按的按钮。所以这里全是纯算账，没有一处会去删文件。
 *
 * 「永久」不是 0 张可清：它只是让 isExpired 永远为假，
 * 设置页那行占用还是会照实报数，涨得她受不了了她自己会来按。
 *
 * 2026-10-27 改口径：清理不再为了「删之前先留句话」去叫识图模型。
 * 那段描述本来就写在消息的 visionNote 上，不在附件元数据里；界面读的也是消息上那份。
 * 为一份工具才用的副本去叫几十次模型，不值。
 */

/** 设置页给的那几个选项。0 表示永久不删。 */
export const RETENTION_CHOICES = [30, 45, 60, 90, 0];

export const DEFAULT_RETENTION_DAYS = 30;

export function normalizeRetentionDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return DEFAULT_RETENTION_DAYS;
  if (RETENTION_CHOICES.includes(days)) return days;
  // 老数据里可能存着别的数：能读成一个正数就认它，读不懂就回默认。
  return days > 0 ? Math.round(days) : (days === 0 ? 0 : DEFAULT_RETENTION_DAYS);
}

/**
 * 这张图是不是该进清理名单了。
 *
 * 看的是最后一次被发送的时间（lastSeenAt），不是第一次。
 * 她隔两个月又把同一张图发上来，那这张图对她就还是活的，不该按第一次收到那天算老。
 * 已经被清过的（purgedAt）不再进名单，免得她点两次清理时看到同一张又被算一遍。
 */
export function isExpired(meta, days, now = Date.now()) {
  const limit = normalizeRetentionDays(days);
  if (!limit) return false;
  if (!meta || meta.purgedAt) return false;
  const last = Date.parse(meta.lastSeenAt ?? meta.at ?? "");
  if (!Number.isFinite(last)) return false;
  return now - last > limit * 24 * 60 * 60 * 1000;
}

/**
 * 这张图还挂在某条聊天消息上吗。
 *
 * 聊天账每本最多留 2000 条（store.js 的 MAX_MESSAGES_PER_THREAD），老消息被挤出去之后，
 * 附件文件还留在盘上，只是再没有任何一条消息认它。这类孤儿不看期限——它们早就没人认了，
 * 再等三十天没有任何意义，而且只要继续聊就会一直长。
 */
export function isOrphan(meta, referencedIds) {
  if (!meta || meta.purgedAt) return false;
  if (!meta.id) return false;
  const set = referencedIds instanceof Set ? referencedIds : new Set(referencedIds ?? []);
  return !set.has(String(meta.id));
}

/**
 * 这次该清哪些。
 *
 * 两类都收：过了她定期限的，和已经没有任何消息认领的孤儿。
 * 孤儿不看期限，但**永久模式下一个都不清**——那是她明确说过不删的意思，
 * 只有「孤儿」这件事不足以推翻它，设置页会把占用量如实报给她看。
 *
 * @returns {{ rows: object[], expiredBytes: number, orphanCount: number, orphanBytes: number }}
 */
export function planCleanup(metas, { days, referencedIds } = {}, now = Date.now()) {
  const limit = normalizeRetentionDays(days);
  const rows = (Array.isArray(metas) ? metas : []).filter((meta) => meta && typeof meta === "object");
  if (!limit) return { rows: [], expiredBytes: 0, orphanCount: 0, orphanBytes: 0 };
  const picked = [];
  let expiredBytes = 0;
  let orphanCount = 0;
  let orphanBytes = 0;
  for (const meta of rows) {
    if (meta.purgedAt) continue;
    const size = Number(meta.size) || 0;
    if (isOrphan(meta, referencedIds)) {
      picked.push(meta);
      orphanCount += 1;
      orphanBytes += size;
      continue;
    }
    if (isExpired(meta, limit, now)) {
      picked.push(meta);
      expiredBytes += size;
    }
  }
  return { rows: picked, expiredBytes, orphanCount, orphanBytes };
}

/**
 * 现在到底用了多少。
 *
 * bytes 只算还在盘上的原图：清掉的那部分已经还给硬盘了，
 * 还把它算进去，她就会觉得「清了半天怎么没少」。
 * 孤儿那一份单独报：它不受期限管，但也确实占着地方。
 */
export function summarizeStorage(metas, days, now = Date.now(), referencedIds = null) {
  const rows = (Array.isArray(metas) ? metas : []).filter((meta) => meta && typeof meta === "object");
  const limit = normalizeRetentionDays(days);
  let count = 0;
  let bytes = 0;
  let oldestAt = null;
  let expiredCount = 0;
  let expiredBytes = 0;
  let orphanCount = 0;
  let orphanBytes = 0;
  const hasRefs = referencedIds instanceof Set;
  for (const meta of rows) {
    const size = Number(meta.size) || 0;
    const at = Date.parse(meta.at ?? "");
    if (Number.isFinite(at) && (oldestAt === null || at < oldestAt)) oldestAt = at;
    if (meta.purgedAt) continue;
    count += 1;
    bytes += size;
    if (hasRefs && isOrphan(meta, referencedIds)) {
      orphanCount += 1;
      orphanBytes += size;
      continue;
    }
    if (isExpired(meta, limit, now)) {
      expiredCount += 1;
      expiredBytes += size;
    }
  }
  return {
    count,
    bytes,
    oldestAt,
    expiredCount,
    expiredBytes,
    orphanCount,
    orphanBytes,
    /** 这一轮按钮会清掉几张、能腾多少。永久模式下是 0。 */
    cleanupCount: limit ? expiredCount + orphanCount : 0,
    cleanupBytes: limit ? expiredBytes + orphanBytes : 0,
    retentionDays: limit,
    // 永久模式下永远没有"过期"这回事，设置页那行字也就不该提清理。
    keepsForever: limit === 0,
  };
}
