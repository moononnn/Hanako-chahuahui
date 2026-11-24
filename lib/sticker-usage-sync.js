// 表情用法自动同步：她纠正过某张共享表情的用法，就顺手告诉图库。
//
// 规矩（一条都不能破）：
//   1. 默认关。她在设置里自己打开一次，才开始同步；不改别的任何配置。
//   2. 只处理她刚发的那一条消息，不回头翻旧账：以前的纠正不补同步。
//   3. 只同步共享图库里的表情，而且要「定位到确切那一张 + 新用法说得清楚」。
//      普通照片、说不清的纠正、只有她本地才有的图，都不推。
//   4. 她明说「只留这里」「不要同步」，就当她只想自己记得，不推。
//   5. 不影响回聊：同步在后台做，不等它；失败只记一笔，本地纠正和手动入口都还在。
//
// 推给图库的东西只有两样：表情编号和用法说明。别的什么都不传。

/** 图库那边的接收口（跨应用总线）。 */
export const USAGE_SYNC_TARGET = "app:biaoqingbao-app/sticker/adopt-usage";
/** 单次同步的超时。超时只算这次没成，不算纠正丢了。 */
export const USAGE_SYNC_TIMEOUT_MS = 10000;
/** 用法说明最长多少字（和图库那头一致，超了那边会拒）。 */
export const USAGE_MEANING_MAX = 60;

/**
 * 她明说「只留这里 / 不要同步」：这些说法一出现，这轮就不推。
 * 只认明确的那几种说法，不做同义扩写——宁可漏推一次，也不要把她没说的话当成拒绝。
 */
const LOCAL_ONLY_PATTERNS = [
  /只(?:留|放|管|要|用)(?:在)?(?:这|此)(?:里|儿|边)/u,
  /(?:就|先)?留(?:在)?(?:这|此)(?:里|儿|边)(?:就|先|就行|好了|吧|啊)/u,
  /不(?:要|用|必|想|用得着|需要|会)?(?:再)?(?:同步|传到?|发过去|告诉图库|给图库|给表情包|告诉那边)/u,
  /别(?:自动)?同步|别(?:传|发|往外说)(?:过去|出去|给|到)?/u,
  /(?:咱俩|我们俩|你我)的(?:小秘密|暗号|私用)|(?:仅|只)(?:供|给)(?:你我|咱俩|我们俩)/u,
  /别(?:告诉|给|传到|同步到)(?:图库|表情包|那边)/u,
  /同步(?:就)?(?:不用|别|不需要|算了|吧|就行)/u,
  /只(?:留|要)(?:在)?本地/u,
];

/** 这句话是不是明说了「只留这里」。 */
export function mentionsLocalOnly(text) {
  const body = String(text ?? "");
  if (!body.trim()) return false;
  return LOCAL_ONLY_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * 这条纠正能不能拿去同步：
 *   - 定位到确切那一张共享图（编号在白名单里）；
 *   - 新用法说得清楚（不是空话，也不超出对方能收的长度）。
 */
export function isSyncableCorrection(correction) {
  if (!correction || typeof correction !== "object") return false;
  const id = String(correction.id ?? "").trim();
  if (!/^[\w-]{1,120}$/u.test(id)) return false;
  const meaning = String(correction.meaning ?? "").trim();
  if (meaning.length < 2) return false;
  if (meaning.length > USAGE_MEANING_MAX) return false;
  return true;
}

/**
 * 同步器：一张图同时只跑一趟。
 *
 * 同张并发怎么算：后到的说法不排队等一堆请求，直接记成「待发」，
 * 前一趟跑完再把最新那句送出去——同一条纠正来回改，落地的应该是最后那句。
 * 排队中的那次不算成功也不算失败，它只是还没轮到。
 *
 * @param {object} deps
 * @param {(payload: {stickerId: string, meaning: string}) => Promise<any>} deps.request 真正发出去的那一趟
 * @param {(event: object) => void} [deps.diagnostics] 只记事实，不给自己贴成功标签
 */
export function createUsageSyncer({ request, diagnostics = null } = {}) {
  const inflight = new Map();

  async function sync({ stickerId, meaning } = {}) {
    const id = String(stickerId ?? "").trim();
    const text = String(meaning ?? "").trim();
    if (!id || !text) return { status: "failed", error: "参数不完整" };
    if (typeof request !== "function") return { status: "failed", error: "没有发送通道" };

    const state = inflight.get(id) || { running: false, pending: null };
    inflight.set(id, state);
    if (state.running) {
      // 同一张图已经有一趟在跑：后到的盖住先到的，跑完再送最后那句。
      state.pending = text;
      return { status: "queued" };
    }
    state.running = true;
    let outcome = { status: "failed", error: "没有发出去" };
    try {
      let current = text;
      for (;;) {
        let result;
        try { result = await request({ stickerId: id, meaning: current }); }
        catch (error) { result = { ok: false, error: error?.message || String(error) }; }
        // 对方明确说收到了才算数；说不行就是不行，不替它圆场。
        outcome = result?.ok === true
          ? { status: "synced" }
          : { status: "failed", error: String(result?.error || "对方没有确认") };
        if (outcome.status === "failed") {
          diagnostics?.({ event: "sticker.usage-sync.failed", stickerId: id, error: outcome.error });
        }
        if (!state.pending) break;
        current = state.pending;
        state.pending = null;
      }
    } catch (error) {
      outcome = { status: "failed", error: error?.message || String(error) };
      diagnostics?.({ event: "sticker.usage-sync.error", stickerId: id, error: outcome.error });
    } finally {
      state.running = false;
      inflight.delete(id);
    }
    return outcome;
  }

  /** 现在有几张图正在同步（测试与诊断用）。 */
  function inflightCount() {
    return inflight.size;
  }

  return { sync, inflightCount };
}
