/**
 * 戳一戳的**闭环**规矩（文案部分全在 lib/actions.js）。
 *
 * 只用动作回，不出话：她戳一下，伙伴可能还一个、也可能不回；
 * 两边都没话就散，**不许硬找话题**。所以末尾连着三条动作就不再应答 ——
 * 这是硬规矩，不交给模型判断。
 *
 * 这里只看**末尾连续**的动作；中间夹了正经话就重新算一轮。
 */

/** 数末尾连着几条动作（不分方向，戳也是一样）。 */
export function pokeStreak(messages) {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.kind === "poke" || m?.kind === "action") n += 1;
    else break;
  }
  return n;
}

/** 还能不能再接一下。来回两轮（末尾连续 3 条）就收场。 */
export function canAnswerPoke(messages) {
  return pokeStreak(messages) < 3;
}
