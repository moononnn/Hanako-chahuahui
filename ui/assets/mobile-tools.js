/**
 * 茶话会 · 手机页的「小工具」：收藏、待办确认窗、消息动作、戳一下。
 *
 * 为什么单独一个文件：手机页要跟本体用同一套权限、同一套文案，可它又得在
 * 断开、切伙伴、迟到回包这些情形下自己收干净。把这一摊从客户端主文件里拆出来，
 * 主文件只管聊天本身，这儿只负责「按契约搬动作」。
 *
 * 几条定死的规矩（都吃过亏）：
 *   - 每个异步操作先记下 agentId + epoch（必要时再加面板世代/页面寿命）。
 *     回包到了先核对，对不上就整段丢掉：不改 DOM、不 notify、不刷新。
 *   - 发写请求之前，先在当前线程里核一遍「这条还在、没撤回、现在还有这个权限」。
 *     按钮是旧的没关系，手底下的动作必须是新的。
 *   - 面板关掉（含切伙伴、reset）也要作废在飞的结果：同一个伙伴 epoch 不变时，
 *     靠面板世代说话；否则晚回来的收藏会把已经关掉的窗重新画出来。
 *   - 已撤回/已删掉的文案不许留在 DOM 或本地缓存里：写成功一律 refreshThread，
 *     本模块自己不留消息正文的副本。
 *   - 只有拿到后端的成功回包才收窗/收卡；失败就留着让她再点一次，并把原因写在卡上。
 *   - 正文、标题、报错一律走 textContent；这个文件里不拼 innerHTML。
 *   - 长操作有专门的时限：重新生成 190 秒、删除 130 秒（后端 180/120 秒
 *     再加一层余量）。超时只能说「不知道成没成」，不能谎报失败哄她再点一次。
 *   - 同一条消息上的动作用一把锁串起来：双击、连点、弹框后再点都只发一份。
 *   - 表情图库的管理不在这边：手机只管闲聊与看图（发图/选表情/分类同步在聊天那边）。
 *   - 线程内容变了（撤回/改稿/删除）时，开着的收藏要重取、开着的编辑框要收；
 *     这条由核心在每次 commitPage 后调 syncThread({contentChanged}) 推过来。
 *
 * 这个文件只做 UI：不认识 fetch、不认识 token、不认识 store。鉴权、超时、
 * 业务失败抛错都由调用方传进来的 api(path, init, { signal }) 负责——
 * 它成功时给 data，业务失败（ok:false / 网络 / 超时）抛错。
 */

/** 编辑一条回复最多这么多字，跟后端 /refine/:id/edit 的上限对齐。 */
export const EDIT_MAX_CHARS = 4000;
/** 撤回时限：跟着 lib/recall.js 的 RECALL_WINDOW_MS，别各写一份。 */
export const RECALL_WINDOW_MS = 2 * 60 * 1000;
/**
 * 长操作自己的超时：后端给 regenerate 180 秒、delete 120 秒，
 * 手机这边各留 10 秒给网络与收尾。第三个参数就是 api 的 timeoutMs。
 */
export const ACTION_TIMEOUTS = Object.freeze({
  regenerate: 190_000,
  delete: 130_000,
});
/**
 * 超时不能当成「没成功」说出口：她一听「失败了」就会再点一次，而模型那一轮
 * 可能已经真的跑了。超时只能说不知道成没成，让她刷新着看。
 */
export const TIMEOUT_HINT = "结果暂时不确定，先刷新确认，别连续重做";
/** 还没认识完的伙伴：写入口得先回本体走完流程（服务器最后也会拦）。 */
export const ONBOARDING_HINT = "先在本体完成认识";
/** 消息菜单上的按钮字。 */
export const ACTION_LABELS = Object.freeze({
  retract: "撤回",
  edit: "编辑",
  regenerate: "重新生成",
  delete: "删除",
});

const ACTION_TITLES = Object.freeze({
  retract: "撤回这条消息",
  edit: "调整这条回复",
  regenerate: "重新生成这条回复",
  delete: "删除",
});

const DELETE_REPLY_COPY = "这会从茶话会聊天记录中永久删除这一整轮回复，包括全部气泡、关联语音和收藏。"
  + "若它已经进入整理摘要，会先清掉可能含有它的摘要；回复当天的日账也会整份清掉，再从剩余聊天重建，"
  + "重建失败时会暂时缺这一天的日账。话题本里由多条消息综合提炼的主题可能仍留有概括，无法逐条定位到这条回复。"
  + "原始聊天仍保留，剩余内容会按原有节奏继续整理。你发的原消息会保留；删完它下面所有回复后，会回到未读状态，"
  + "ta 会在正常节奏里重新看到你的话，可能接着回。";

const DELETE_POKE_COPY = "这条动作会从茶话会聊天记录里移除。戳一戳不进 ta 的记忆，不会被写进摘要、日账或关系档案，"
  + "所以删掉它只是把屏幕上这行字擦掉，ta 记得的事不受影响。";

const REGENERATE_COPY = "重新生成会用现在的上下文把这条回复重写一遍，覆盖你眼前这一版，并且真的叫一次模型。"
  + "聊天里已经留下的记忆不会跟着改。";

// ── 纯逻辑：给一条消息算它现在有哪些动作 ──────────────────────

/**
 * 手机上的撤回入口跟本体一样一直挂着：能不能撤由服务端那句门禁说，
 * 客户端不拿 canRecall / 时间窗自己藏按钮（turn ready 会被留十分钟，
 * 那段时间 canRecall 是 false，藏起来就成了「没有撤回功能」）。
 */
function retractableNow(message) {
  if (!message?.id) return false;
  if (message.recalled || message.kind === "recalled") return false;
  // 还在飞的本地那条不给撤回（它还没成为聊天记录里的一条）
  if (message.pending === true || message.status === "pending") return false;
  return message.role === "user";
}

/**
 * 按钮上那句提示：canRecall 只用来「先提个醒」，不让按钮消失。
 * 空串 = 没什么好提醒的。
 */
export function retractHintOf(message) {
  const maybeBlocked = "现在可能撤不回来（ta 可能正在接，或已经过了两分钟），点一下让服务器判";
  if (message?.canRecall === true) return "";
  if (message?.canRecall === false) return maybeBlocked;
  const verdict = message?.recall;
  if (verdict && typeof verdict === "object" && verdict.ok === false) return maybeBlocked;
  // 没给结论时才看本地时间，仍然只影响提示
  if (!message?.readAt) return "";
  const at = Date.parse(message?.at ?? "");
  if (!Number.isFinite(at)) return "";
  return Date.now() > at + RECALL_WINDOW_MS ? "已经过了两分钟，服务器可能不让撤回" : "";
}

/**
 * 这条消息现在该出现哪几个动作。纯函数，方便把权限矩阵单独钉住。
 *
 * 本体（panel.html openMessageActions）的规矩：
 *   - 撤回只给「我自己发的」，伙伴的话没有撤回；入口一直在，能不能撤由服务端回流。
 *   - 伙伴的话要「回复修整」开着，并且只对最后一条未撤回的伙伴回复给编辑/重新生成/删除。
 *   - 戳一戳/动作没有正文可改，也没有「重新生成」这回事，只给删掉它。
 *   - 撤回过的、还在飞的、已经不在这条线程里的，一个动作都不给。
 *
 * @param {object} message 线程里的那条消息
 * @param {{messageRefine?:boolean, latestAssistantId?:string}} context
 * @returns {string[]} retract | edit | regenerate | delete
 */
export function messageActionsFor(message, context = {}) {
  if (!message?.id) return [];
  if (message.recalled || message.kind === "recalled") return [];
  const refine = context?.messageRefine === true;
  const latestAssistantId = String(context?.latestAssistantId ?? "");
  const isAction = message.kind === "poke" || message.kind === "action";
  if (message.role === "assistant") {
    // 删除/编辑/重新生成三条都挂在本体的「修正伙伴回复」开关后面（后端也这么拦）
    if (!refine) return [];
    if (isAction) return ["delete"];
    if (!latestAssistantId || message.id !== latestAssistantId) return [];
    return ["regenerate", "edit", "delete"];
  }
  if (message.role === "user") {
    if (!retractableNow(message)) return [];
    return ["retract"];
  }
  return [];
}

function stampText(at) {
  if (!at) return "";
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return String(at).slice(0, 24);
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function textOf(error, fallback) {
  const message = String(error?.message ?? "").trim();
  if (message) return message;
  const raw = String(error ?? "").trim();
  // fetch 被 abort 时 reject 出来的可能只是个字符串；这种没内容的不往屏幕上摆
  if (raw && raw !== "canceled" && raw !== "aborted") return raw;
  return fallback;
}

const canceled = (error) => error?.code === "canceled";
const timedOut = (error) => error?.code === "timeout";

// ── 工厂 ─────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {Document} options.doc 页面 document（测试里可注入最小 fake）
 * @param {(path:string, init?:object, opts?:{signal?:AbortSignal, timeoutMs?:number}) => Promise<any>} options.api
 *        统一带鉴权；成功 resolve data，业务失败抛错
 * @param {() => {agentId:string, epoch:any, messages:object[], messageRefine:boolean, latestAssistantId:string, needsOnboarding?:boolean}} options.getContext
 * @param {() => (void|Promise<void>)} [options.refreshThread] 写成功后重拉线程
 * @param {(text:string) => void} [options.notify] 给用户看一句结果
 * @param {() => void} [options.closeMessageMenu] 开面板前先把消息菜单收掉
 * @param {() => void} [options.stopPlayback] 停掉核心那条还在放的语音（收藏里的语音开播时用）
 */
export function createMobileTools({
  doc,
  api,
  getContext,
  refreshThread = null,
  notify = null,
  closeMessageMenu = null,
  stopPlayback = null,
} = {}) {
  if (!doc || typeof doc.createElement !== "function") {
    throw new TypeError("createMobileTools 需要 doc");
  }
  if (typeof api !== "function") {
    throw new TypeError("createMobileTools 需要 api(path, init, { signal })");
  }
  if (typeof getContext !== "function") {
    throw new TypeError("createMobileTools 需要 getContext()");
  }

  // 页面寿命：reset 一次就换一代，晚回来的写请求一律不算数
  let life = 0;
  let panelGen = 0;
  let proposalGen = 0;
  let pokeBusy = false;

  // ── 小工具：DOM 与请求收纳 ──
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };

  const textButton = (label, className, onClick) => {
    const node = el("button", className, label);
    node.type = "button";
    if (typeof onClick === "function") node.addEventListener("click", onClick);
    return node;
  };

  const clear = (node) => {
    if (node) node.textContent = "";
  };

  const say = (text) => {
    const line = String(text ?? "").trim();
    if (!line) return;
    try {
      notify?.(line);
    } catch {
      /* 提示渠道自己出问题不该连累动作 */
    }
  };

  const reload = async () => {
    try {
      await refreshThread?.();
    } catch {
      /* 刷新失败不谎报成功：调用方那一句已经说了结果 */
    }
  };

  const dismissMenu = () => {
    try {
      closeMessageMenu?.();
    } catch {
      /* 菜单收不掉不算错 */
    }
  };

  /** 一组在飞请求：关面板/切伙伴/reset 时一起 abort。 */
  function bag() {
    const rows = new Set();
    return {
      begin() {
        const controller = new AbortController();
        rows.add(controller);
        return {
          signal: controller.signal,
          done() {
            rows.delete(controller);
          },
        };
      },
      abortAll() {
        for (const controller of rows) {
          try {
            controller.abort("reset");
          } catch {
            /* 已经结束了 */
          }
        }
        rows.clear();
      },
      get size() {
        return rows.size;
      },
    };
  }

  const panelBag = bag();
  const proposalBag = bag();
  const writeBag = bag();
  // 同一张待办卡只能有一个动作在飞：连点两次不该发两份确认
  const busyCards = new WeakSet();
  // 同一条消息上的动作也只能有一个在飞：双击撤回/重生成不该发两份
  const busyMessages = new Set();

  function lockMessage(agentId, messageId) {
    const key = `${agentId}:${messageId}`;
    if (!agentId || !messageId || busyMessages.has(key)) return "";
    busyMessages.add(key);
    return key;
  }

  function unlockMessage(key) {
    if (key) busyMessages.delete(key);
  }

  function snapshot() {
    let raw = null;
    try {
      raw = getContext();
    } catch {
      raw = null;
    }
    const ctx = raw && typeof raw === "object" ? raw : {};
    const epoch = ctx.epoch;
    return {
      agentId: String(ctx.agentId ?? ""),
      epoch: epoch,
      messages: Array.isArray(ctx.messages) ? ctx.messages : [],
      messageRefine: ctx.messageRefine === true,
      latestAssistantId: String(ctx.latestAssistantId ?? ""),
      // 还没走完认识流程：手机上的写入口只提示回去走完，不自己开工
      needsOnboarding: ctx.needsOnboarding === true,
      life,
    };
  }

  /** 这一份上下文还算不算数：伙伴与世代都没变，页面也没被 reset 过。 */
  function alive(taken) {
    if (!taken?.agentId) return false;
    const now = snapshot();
    return now.agentId === taken.agentId && now.epoch === taken.epoch && now.life === taken.life;
  }

  function findLive(taken, messageId) {
    const id = String(messageId ?? "");
    if (!id) return null;
    return taken.messages.find((row) => row?.id === id) ?? null;
  }

  const postInit = (payload) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

  async function call(taken, path, init, vault, options = {}) {
    const ticket = vault.begin();
    const request = { signal: ticket.signal };
    const timeoutMs = Number(options?.timeoutMs);
    // 长操作（重生成/删除/导入）要单独报自己的时限；其它走 api 的默认值
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) request.timeoutMs = timeoutMs;
    try {
      const data = await api(path, init, request);
      return { ok: true, data, stale: !alive(taken) };
    } catch (error) {
      return { ok: false, error, stale: !alive(taken) };
    } finally {
      ticket.done();
    }
  }

  const write = (taken, path, payload, vault = writeBag, options = {}) =>
    call(taken, path, postInit(payload), vault, options);

  /** 超时：只说「不知道成没成」，先刷新；不自动重试、也不诱导她再点。 */
  async function settleTimeout(close) {
    if (typeof close === "function") close();
    say(TIMEOUT_HINT);
    await reload();
  }

  // ── 挂载点 ──
  //
  // 挂到 body：手机页的 #chat 自己是 z-index:50 的层叠上下文，挂在它里面的浮层
  // 再怎么调 z-index 也翻不出 50，表情包抽屉(55)、大图(70)会把面板盖住。
  // 挂到 body 上，面板才是真的在聊天窗上面，而不是在它「里面」。
  function host() {
    return doc.body || doc.documentElement
      || (typeof doc.getElementById === "function" ? doc.getElementById("chat") : null);
  }

  let layer = null;
  let sheet = null;
  let sheetTitle = null;
  let sheetBody = null;
  let proposalsEl = null;
  let panelKind = "";
  /** 收藏面板每次重取的序号：先发的那份晚回来也不许盖掉新的 */
  let favoritesSeq = 0;
  /** 收藏列表现任的包装节点：最后一行被拿掉时空态要靠它认出来 */
  let favoritesList = null;
  /** 面板里那几条原生 audio：关面板/重取/reset 都要停干净 */
  const panelAudios = new Set();

  function ensureLayer() {
    if (layer && layer.parentNode) return layer;
    const hostEl = host();
    if (!hostEl) return null;
    layer = el("div", "mt-layer");
    layer.hidden = true;
    sheet = el("div", "mt-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "小工具");
    const head = el("div", "mt-sheet-head");
    sheetTitle = el("b", "mt-sheet-title");
    const close = textButton("×", "mt-sheet-close", () => closePanel());
    close.setAttribute("aria-label", "关上");
    head.append(sheetTitle, close);
    sheetBody = el("div", "mt-sheet-body");
    sheet.append(head, sheetBody);
    layer.append(sheet);
    // 点窗外那片灰就收：只认落在层本身上的那一下，别把窗里的点击当关窗
    layer.addEventListener("click", (event) => {
      if (event?.target === layer) closePanel();
    });
    hostEl.append(layer);
    return layer;
  }

  function panelStale(gen, taken) {
    return panelGen !== gen || !alive(taken) || !layer || layer.hidden !== false;
  }

  function panelOpen(kind) {
    return Boolean(layer && layer.hidden === false && panelKind === kind);
  }

  function startPanel(kind, title) {
    ensureLayer();
    if (!layer) return 0;
    panelGen += 1;
    const gen = panelGen;
    panelKind = String(kind ?? "");
    layer.hidden = false;
    sheetTitle.textContent = String(title ?? "");
    clear(sheetBody);
    return gen;
  }

  function closePanel() {
    panelGen += 1;
    panelKind = "";
    favoritesSeq += 1;
    favoritesList = null;
    panelBag.abortAll();
    // 面板一关，里面的声音就停：撤回/删除之后不让她从后台还在播的那条里听见旧话
    stopPanelAudio();
    if (layer) layer.hidden = true;
    clear(sheetBody);
    if (sheetTitle) sheetTitle.textContent = "";
  }

  function panelNote(text, className = "mt-note") {
    if (!sheetBody) return null;
    clear(sheetBody);
    const note = el("div", className, text);
    sheetBody.append(note);
    return note;
  }

  // ── 收藏 ──

  function favoriteMeta(item) {
    const parts = [];
    const stamp = stampText(item?.at);
    if (stamp) parts.push(stamp);
    if (item?.kind === "voice" || item?.voice) parts.push("语音");
    return parts.join(" · ");
  }

  // ── 面板里的原生 audio ──

  const isAudioNode = (node) => String(node?.tagName ?? node?.tag ?? "").toLowerCase() === "audio";

  function audiosWithin(node, out = []) {
    if (!node) return out;
    if (isAudioNode(node)) out.push(node);
    for (const child of node.children ?? []) audiosWithin(child, out);
    return out;
  }

  /** 停一条：pause → 清 src → load，半年后也不该自己续上。 */
  function stopAudio(audio) {
    if (!audio) return;
    try {
      audio.pause?.();
    } catch {
      /* 已经停了 */
    }
    try {
      audio.src = "";
    } catch {
      /* 不给改就不改 */
    }
    try {
      audio.load?.();
    } catch {
      /* 不支持 load */
    }
    panelAudios.delete(audio);
  }

  /** 面板关了/要重取了：里面所有声一律停干净，不让已撤回的那句继续放。 */
  function stopPanelAudio() {
    for (const audio of [...panelAudios]) stopAudio(audio);
    panelAudios.clear();
  }

  function mountFavoriteAudio(audio) {
    panelAudios.add(audio);
    audio.addEventListener("play", () => {
      // 同一块面板只放一条；核心那边正放着的语音也一起停
      for (const other of panelAudios) {
        if (other === audio) continue;
        try {
          other.pause?.();
        } catch {
          /* 已经停了 */
        }
      }
      try {
        stopPlayback?.();
      } catch {
        /* 核心播放器出问题不该连累这里 */
      }
    });
    return audio;
  }

  function renderFavorites(gen, taken, items) {
    clear(sheetBody);
    favoritesList = null;
    if (!items.length) {
      sheetBody.append(el("div", "mt-empty", "还没有收藏的话。"));
      return;
    }
    const list = el("div", "mt-list");
    for (const item of items) list.append(favoriteRow(gen, taken, item));
    favoritesList = list;
    sheetBody.append(list);
  }

  function favoriteRow(gen, taken, item) {
    const row = el("div", "mt-card");
    const body = el("div", "mt-card-body");
    body.append(
      el("div", "mt-card-text", String(item?.text ?? "").trim() || "[这条没有正文]"),
      el("div", "mt-card-meta", favoriteMeta(item)),
    );
    // 语音：只用现有那条 /voice（它自己按「当前源还在不在」核），不走桌面收藏专用的语音路
    const messageId = String(item?.messageId ?? "");
    if (messageId && (item?.kind === "voice" || item?.voice)) {
      const audio = el("audio", "mt-audio");
      audio.controls = true;
      audio.preload = "none";
      audio.src = `/voice?agentId=${encodeURIComponent(taken.agentId)}&messageId=${encodeURIComponent(messageId)}`;
      body.append(mountFavoriteAudio(audio));
    }
    const remove = textButton("取消收藏", "mt-chip", () => void removeFavorite(gen, taken, item, row, remove));
    row.append(body, remove);
    return row;
  }

  async function removeFavorite(gen, taken, item, row, button) {
    const id = String(item?.id ?? "");
    if (!id) return;
    if (panelStale(gen, taken)) {
      closePanel();
      return;
    }
    button.disabled = true;
    // 写请求只带 agentId + 收藏编号：正文与消息号都是后端自己核的
    const result = await call(taken, "favorite.remove", postInit({ agentId: taken.agentId, id }), panelBag);
    if (result.stale || canceled(result.error) || panelStale(gen, taken)) return;
    if (!result.ok) {
      button.disabled = false;
      say(textOf(result.error, "这条没取消掉"));
      return;
    }
    // 这一行自己可能正在放音：先把它停掉再拿掉，别让旧声音跟出去
    for (const audio of audiosWithin(row)) stopAudio(audio);
    row.remove?.();
    // 空态要看列表现任的包装节点（外壳还在，不能拿 sheetBody 的子节点数当空）
    if (favoritesList && !(favoritesList.children?.length)) {
      clear(sheetBody);
      favoritesList = null;
      sheetBody.append(el("div", "mt-empty", "还没有收藏的话。"));
    }
    say("取消了这条收藏");
  }

  async function fetchFavorites(gen, taken, seq) {
    const result = await call(
      taken,
      `favorites.list?agentId=${encodeURIComponent(taken.agentId)}`,
      {},
      panelBag,
    );
    // 晚回来的：重开/再刷/关面板都算旧，只认最新那一次
    if (seq !== favoritesSeq || !panelOpen("favorites")) return;
    if (panelStale(gen, taken)) return;
    if (!result.ok) {
      panelNote(textOf(result.error, "收藏没翻出来"), "mt-note mt-note-error");
      return;
    }
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    renderFavorites(gen, taken, items);
  }

  async function openFavorites() {
    dismissMenu();
    const taken = snapshot();
    if (!taken.agentId) {
      say("先选一位伙伴");
      return;
    }
    const gen = startPanel("favorites", "收藏的话");
    if (!gen) return;
    favoritesSeq += 1;
    panelNote("正在翻收藏…");
    await fetchFavorites(gen, taken, favoritesSeq);
  }

  /**
   * 线程内容真的变了（撤回/改稿/删除）时，正看着的收藏得跟着重取：
   * 旧条目先清掉，绝不把已经撤回的那句原文留在屏上。
   */
  async function refreshFavoritesPanel() {
    if (!panelOpen("favorites")) return;
    const taken = snapshot();
    if (!taken.agentId) return;
    const gen = panelGen;
    favoritesSeq += 1;
    const seq = favoritesSeq;
    // 先把旧条目和正在放的声音一并收掉，再重取
    stopPanelAudio();
    clear(sheetBody);
    favoritesList = null;
    sheetBody.append(el("div", "mt-note", "正在对一下收藏…"));
    await fetchFavorites(gen, taken, seq);
  }

  // ── 待办确认窗 ──

  function ensureProposals() {
    if (proposalsEl && proposalsEl.parentNode) return proposalsEl;
    const hostEl = host();
    if (!hostEl) return null;
    proposalsEl = el("div", "mt-proposals");
    proposalsEl.hidden = true;
    hostEl.append(proposalsEl);
    return proposalsEl;
  }

  function clearProposals() {
    proposalGen += 1;
    proposalBag.abortAll();
    if (!proposalsEl) return;
    clear(proposalsEl);
    proposalsEl.hidden = true;
  }

  function pruneProposals() {
    if (!proposalsEl) return;
    if (proposalsEl.children?.length) return;
    proposalsEl.hidden = true;
  }

  function proposalStale(gen, taken) {
    return proposalGen !== gen || !alive(taken);
  }

  function proposalTitle(row) {
    const when = String(row?.at ?? "").trim();
    const title = String(row?.title ?? "").trim();
    return when ? `${when} · ${title}` : title;
  }

  function proposalCard(gen, taken, row) {
    const card = el("div", "todo-proposal");
    card.setAttribute("data-key", String(row?.key ?? ""));
    const body = el("div", "todo-proposal-body");
    body.append(
      el("div", "todo-proposal-label", "刚说的那件，要记上吗"),
      el("div", "todo-proposal-title", proposalTitle(row)),
    );
    const actions = el("div", "todo-proposal-actions");
    const confirm = textButton("就打上完成", "todo-proposal-btn primary", () => void confirmProposal(gen, taken, row, card));
    const dismiss = textButton("先不用", "todo-proposal-btn ghost", () => void dismissProposal(gen, taken, row, card));
    actions.append(confirm, dismiss);
    card.append(body, actions);
    return card;
  }

  function renderProposals(items) {
    const box = ensureProposals();
    if (!box) return;
    clear(box);
    const rows = Array.isArray(items) ? items : [];
    box.hidden = rows.length === 0;
    const gen = proposalGen;
    const taken = snapshot();
    for (const row of rows) box.append(proposalCard(gen, taken, row));
  }

  /** 确认失败：窗留在原地，原因写在卡上，按钮还能再点（本体硬规矩）。 */
  function proposalError(card, text, titleText, retry) {
    clear(card);
    card.classList.remove("is-busy");
    card.classList.add("is-error");
    const body = el("div", "todo-proposal-body");
    body.append(
      el("div", "todo-proposal-label todo-proposal-warn", text),
      el("div", "todo-proposal-title", titleText),
    );
    const actions = el("div", "todo-proposal-actions");
    actions.append(textButton("再试一次", "todo-proposal-btn primary", retry));
    card.append(body, actions);
  }

  async function confirmProposal(gen, taken, row, card) {
    const key = String(row?.key ?? "");
    if (!key || busyCards.has(card)) return;
    if (proposalStale(gen, taken)) {
      clearProposals();
      return;
    }
    busyCards.add(card);
    card.classList.add("is-busy");
    const result = await call(taken, "todos.confirm", postInit({ agentId: taken.agentId, key }), proposalBag);
    busyCards.delete(card);
    if (proposalStale(gen, taken)) return;
    card.classList.remove("is-busy");
    if (result.ok) {
      // 只有拿到成功回包才收窗；收窗之后屏上不留这条的任何副本
      card.remove?.();
      pruneProposals();
      say("这条记上了");
      return;
    }
    if (canceled(result.error)) return;
    const why = textOf(result.error, "这次没记上，窗还给你留着，再点一次试试");
    // 卡上写原因是为了让她不用猜；提示里再说一句是因为卡可能滚出屏幕了
    say(why);
    // 唯一能收窗的情况：这条提议确实没了（过了当天、或已经处理过），留着只会一直失败
    if (/已经不在了|刚处理过/.test(why)) {
      card.remove?.();
      pruneProposals();
      return;
    }
    proposalError(card, why, proposalTitle(row), () => void confirmProposal(gen, taken, row, card));
  }

  async function dismissProposal(gen, taken, row, card) {
    const key = String(row?.key ?? "");
    if (!key || busyCards.has(card)) return;
    if (proposalStale(gen, taken)) {
      clearProposals();
      return;
    }
    busyCards.add(card);
    card.classList.add("is-busy");
    const result = await call(taken, "todos.dismiss", postInit({ agentId: taken.agentId, key }), proposalBag);
    busyCards.delete(card);
    if (proposalStale(gen, taken)) return;
    card.classList.remove("is-busy");
    if (!result.ok) {
      if (canceled(result.error)) return;
      // 收不掉就原样留着，别假装已经处理过
      say(textOf(result.error, "这条窗暂时收不掉，再点一次"));
      return;
    }
    card.remove?.();
    pruneProposals();
  }

  async function refreshProposals() {
    const taken = snapshot();
    if (!taken.agentId) {
      clearProposals();
      return;
    }
    proposalGen += 1;
    const gen = proposalGen;
    const result = await call(
      taken,
      `todos.list?agentId=${encodeURIComponent(taken.agentId)}`,
      {},
      proposalBag,
    );
    if (proposalStale(gen, taken)) return;
    // 读不到就别动现有的：宁可这轮不更新，也不能把还挂着的窗误收掉
    if (!result.ok) return;
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    renderProposals(items);
  }

  // ── 确认框 / 编辑框 ──

  let editor = null;

  function closeEditor() {
    const current = editor;
    editor = null;
    if (!current) return;
    current.close();
  }

  /**
   * 一块确认/编辑浮层。正文只用 textContent 拼，不接受 HTML 字符串。
   * @param {object} options
   * @param {() => Promise<void>} [options.onConfirm]
   */
  function openDialog({ label, title, confirmLabel, confirmCopy = "", danger = false, withTextarea = false, initialText = "", target = null, onConfirm }) {
    closeEditor();
    const hostEl = host();
    if (!hostEl) return null;
    const node = el("div", "message-editor-layer mt-dialog-layer");
    const box = el("div", "message-editor");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", String(label || title));
    const head = el("div", "message-editor-head");
    const closeBtn = textButton("×", "message-editor-close", () => handle.close());
    closeBtn.setAttribute("aria-label", "关上");
    head.append(el("b", null, title), closeBtn);
    const bodySlot = el("div", "mt-dialog-body");
    const foot = el("div", "message-editor-foot");
    // 每块浮层自带一袋请求：关掉它只作废它自己的，不影响别人
    const vault = bag();
    let onKey = null;
    const handle = {
      node,
      box,
      bag: vault,
      textarea: null,
      original: "",
      // 这块浮层认的是哪条消息：线程一变就要重新对它（不能只认开框那一刻）
      messageId: String(target?.messageId ?? ""),
      kind: String(target?.kind ?? ""),
      agentId: String(target?.agentId ?? ""),
      sourceText: String(target?.sourceText ?? ""),
      confirmBtn: null,
      close() {
        vault.abortAll();
        if (editor === handle) editor = null;
        if (onKey) {
          try {
            doc.removeEventListener?.("keydown", onKey);
          } catch {
            /* 已经没了 */
          }
          onKey = null;
        }
        node.remove?.();
        if (handle.textarea) {
          handle.textarea.value = "";
          handle.original = "";
        }
        // 开框时那一版原话也不跟着留在内存里
        handle.sourceText = "";
      },
      setBusy(text) {
        if (!handle.confirmBtn) return;
        handle.confirmBtn.disabled = true;
        handle.confirmBtn.textContent = String(text ?? "");
      },
      settle(text) {
        if (!handle.confirmBtn) return;
        handle.confirmBtn.disabled = false;
        handle.confirmBtn.textContent = String(text ?? "");
      },
    };
    handle.run = async () => {
      if (typeof onConfirm === "function") await onConfirm(handle);
    };
    const cancelBtn = textButton("取消", "message-editor-cancel", () => handle.close());
    const confirmBtn = textButton(
      confirmLabel,
      danger ? "message-editor-delete" : "message-editor-save",
      () => void handle.run(),
    );
    handle.confirmBtn = confirmBtn;
    foot.append(cancelBtn, confirmBtn);
    box.append(head, bodySlot, foot);
    node.append(box);
    if (withTextarea) {
      const area = el("textarea");
      area.setAttribute("maxlength", String(EDIT_MAX_CHARS));
      area.value = String(initialText ?? "");
      handle.textarea = area;
      handle.original = String(initialText ?? "");
      bodySlot.append(area);
    } else if (confirmCopy) {
      bodySlot.append(el("p", "message-delete-copy", confirmCopy));
    }
    node.addEventListener("click", (event) => {
      if (event?.target === node) handle.close();
    });
    hostEl.append(node);
    editor = handle;
    // ESC 也能收（手机上外接键盘/系统返回键偶尔会发这个）
    onKey = (event) => {
      if (String(event?.key ?? "") !== "Escape") return;
      event?.preventDefault?.();
      handle.close();
    };
    doc.addEventListener?.("keydown", onKey);
    return handle;
  }

  /**
   * 这块浮层对应的那条消息，现在还配不配得上「刚才那样」。
   * 返回一句能读的理由；空串 = 还能接着用。
   * textToo=false 是「提交前」用的：正文比不比交给后端的 expectedText 管。
   */
  function dialogLossReason(current, handle, now, { textToo = true } = {}) {
    if (!current) return "这条已经不在聊天记录里了";
    if (current.recalled || current.kind === "recalled") return "这条已经撤回了";
    if (!messageActionsFor(current, now).includes(handle.kind)) {
      return handle.kind === "edit"
        ? "这条回复已经不是最后一轮了，这条稿子没采用"
        : "这条现在不能这么动了";
    }
    // 只比「源」：她自己在 textarea 里改的稿在 handle.textarea 里，两者不混
    if (textToo && handle.kind === "edit" && String(current.text ?? "") !== handle.sourceText) {
      return "桌面那边已经改过这条回复了，这条稿子没采用，刷新看新版";
    }
    return "";
  }

  /** 线程那边一有动静就核一次：源变了就收框；无关的新消息不动她的稿子。 */
  function checkDialogAgainstThread() {
    const handle = editor;
    if (!handle?.messageId) return;
    const now = snapshot();
    if (!handle.agentId || now.agentId !== handle.agentId) {
      // 换伙伴了：这块属于旧窗，安静收掉
      handle.close();
      return;
    }
    const why = dialogLossReason(findLive(now, handle.messageId), handle, now);
    if (!why) return;
    handle.close();
    say(why);
  }

  /** 提交前再核一遍归属与权限：开框时对，不代表现在还对。 */
  function ensureDialogTarget(taken, handle) {
    if (!alive(taken)) {
      handle.close();
      return null;
    }
    const now = snapshot();
    const why = dialogLossReason(findLive(now, handle.messageId), handle, now, { textToo: false });
    if (why) {
      handle.close();
      say(why);
      return null;
    }
    return findLive(now, handle.messageId);
  }

  // ── 消息动作 ──

  async function retractMessage(taken, message) {
    const lock = lockMessage(taken.agentId, message.id);
    if (!lock) return;
    try {
      const result = await write(taken, "message.retract", { agentId: taken.agentId, messageId: message.id });
      if (result.stale) return;
      // 失败也把线程拉回来：屏幕上可能正摆着没对齐的气泡
      await reload();
      if (result.ok) say("消息撤回了");
      else if (timedOut(result.error)) say(TIMEOUT_HINT);
      else say(textOf(result.error, "这条消息现在不能撤回"));
    } finally {
      unlockMessage(lock);
    }
  }

  function openEditorFor(taken, message) {
    openDialog({
      label: "调整伙伴回复",
      title: "调整这条回复",
      confirmLabel: "采用这版回复",
      withTextarea: true,
      initialText: message.text ?? "",
      target: {
        messageId: message.id,
        kind: "edit",
        agentId: taken.agentId,
        sourceText: String(message.text ?? ""),
      },
      onConfirm: async (handle) => {
        // 提交前先核归属与权限（开框时对不代表现在还对）
        if (!ensureDialogTarget(taken, handle)) return;
        const text = String(handle.textarea?.value ?? "").trim();
        if (!text) {
          say("回复不能改成空白");
          return;
        }
        if (text.length > EDIT_MAX_CHARS) {
          say(`一条最多 ${EDIT_MAX_CHARS} 字`);
          return;
        }
        const lock = lockMessage(taken.agentId, message.id);
        if (!lock) return;
        handle.setBusy("正在保存…");
        try {
          const result = await write(taken, "message.edit", {
            agentId: taken.agentId,
            messageId: message.id,
            text,
            // 开框时的那一版原话：后端在 patch 前原子校对，桌面那边改过的稿子不覆盖
            expectedText: handle.sourceText,
          });
          if (result.stale) {
            handle.close();
            return;
          }
          if (!result.ok) {
            if (timedOut(result.error)) {
              await settleTimeout(() => handle.close());
              return;
            }
            handle.settle("采用这版回复");
            say(textOf(result.error, "没保存上"));
            return;
          }
          handle.close();
          say("这条回复换好了");
          await reload();
        } finally {
          unlockMessage(lock);
        }
      },
    });
  }

  function openRegenerateFor(taken, message) {
    openDialog({
      label: "重新生成这条回复",
      title: "重新生成这条回复？",
      confirmLabel: "重新生成",
      confirmCopy: REGENERATE_COPY,
      target: { messageId: message.id, kind: "regenerate", agentId: taken.agentId },
      onConfirm: async (handle) => {
        if (!ensureDialogTarget(taken, handle)) return;
        const lock = lockMessage(taken.agentId, message.id);
        if (!lock) return;
        handle.setBusy("正在重新生成…");
        try {
          // 重新生成要真的跑一次模型：后端给 180 秒，这里留 190 秒等它
          const result = await write(taken, "message.regenerate", {
            agentId: taken.agentId,
            messageId: message.id,
          }, writeBag, { timeoutMs: ACTION_TIMEOUTS.regenerate });
          if (result.stale) {
            handle.close();
            return;
          }
          if (!result.ok) {
            // 超时的时候那一轮可能已经跑了：不说「没生成」，先刷新让她看
            if (timedOut(result.error)) {
              await settleTimeout(() => handle.close());
              return;
            }
            handle.settle("重新生成");
            say(textOf(result.error, "这次没生成出新的回复"));
            return;
          }
          handle.close();
          say("这条回复换好了");
          // 重新生成真的叫了模型，回来的是新的一版：整段重拉，不留旧文案
          await reload();
        } finally {
          unlockMessage(lock);
        }
      },
    });
  }

  function openDeleteFor(taken, message) {
    const isAction = message.kind === "poke" || message.kind === "action";
    openDialog({
      label: isAction ? "删除这条戳一戳" : "删除这条伙伴回复",
      title: isAction ? "删掉这条戳一戳？" : "彻底删除这条回复？",
      confirmLabel: isAction ? "删掉" : "彻底删除",
      confirmCopy: isAction ? DELETE_POKE_COPY : DELETE_REPLY_COPY,
      danger: true,
      target: { messageId: message.id, kind: "delete", agentId: taken.agentId },
      onConfirm: async (handle) => {
        if (!ensureDialogTarget(taken, handle)) return;
        const lock = lockMessage(taken.agentId, message.id);
        if (!lock) return;
        handle.setBusy("正在删除…");
        try {
          // 删除连带清摘要/日账/语音：后端给 120 秒，这里留 130 秒
          const result = await write(taken, "message.delete", {
            agentId: taken.agentId,
            messageId: message.id,
          }, writeBag, { timeoutMs: ACTION_TIMEOUTS.delete });
          if (result.stale) {
            handle.close();
            return;
          }
          if (!result.ok) {
            if (timedOut(result.error)) {
              await settleTimeout(() => handle.close());
              return;
            }
            handle.settle(isAction ? "删掉" : "彻底删除");
            say(textOf(result.error, "没删掉，聊天记录还在"));
            return;
          }
          handle.close();
          const restored = result.data?.restoredUnread === true;
          if (isAction) say("这条戳一戳已删除");
          else if (restored) say("这轮回复已删除，你的原话回到未读，ta 会重新看到");
          else say("这条回复已删除");
          await reload();
        } finally {
          unlockMessage(lock);
        }
      },
    });
  }

  function onMessageAction(name, taken, message) {
    dismissMenu();
    if (!alive(taken)) {
      say("已经翻篇了，刷新看看");
      return;
    }
    // 手底下这一下要按「现在」核一遍：按钮是旧的没关系，动作不能是旧的
    const now = snapshot();
    const current = findLive(now, message.id);
    if (!current || current.recalled || current.kind === "recalled") {
      say("这条已经撤回了");
      void reload();
      return;
    }
    if (!messageActionsFor(current, now).includes(name)) {
      say("这条现在不能这么动");
      void reload();
      return;
    }
    // 还没认识完的伙伴：重新生成先回本体走完认识（服务器最后也会拦）
    if (name === "regenerate" && now.needsOnboarding) {
      say(ONBOARDING_HINT);
      return;
    }
    if (name === "retract") void retractMessage(taken, current);
    else if (name === "edit") openEditorFor(taken, current);
    else if (name === "regenerate") openRegenerateFor(taken, current);
    else if (name === "delete") openDeleteFor(taken, current);
  }

  /**
   * 把这条消息现在的动作挂进容器（消息菜单的那一行）。
   * 容器与文案都由调用方给，这里只按权限产出按钮。
   * @returns {HTMLElement[]} 挂上去的按钮
   */
  function appendMessageActions(container, message) {
    if (!container || typeof container.append !== "function" || !message?.id) return [];
    const taken = snapshot();
    const actions = messageActionsFor(message, taken);
    const made = [];
    for (const name of actions) {
      const button = textButton(ACTION_LABELS[name] ?? name, "message-menu-action", () =>
        onMessageAction(name, taken, message));
      // 撤回入口一直在；canRecall 只值一句提示，不让按钮消失
      const hint = name === "retract" ? retractHintOf(message) : "";
      button.setAttribute("title", hint || ACTION_TITLES[name] || "");
      if (name === "delete") button.classList.add("is-danger");
      container.append(button);
      made.push(button);
    }
    return made;
  }

  // ── 戳一下 ──

  async function poke() {
    if (pokeBusy) return false;
    const taken = snapshot();
    if (!taken.agentId) {
      say("先选一位伙伴");
      return false;
    }
    // 还没认识完的伙伴：手机不自己发，先让她回本体走完认识
    if (taken.needsOnboarding) {
      say(ONBOARDING_HINT);
      return false;
    }
    pokeBusy = true;
    const result = await write(taken, "action.send", { agentId: taken.agentId });
    pokeBusy = false;
    if (result.stale) return false;
    if (!result.ok) {
      if (timedOut(result.error)) {
        say(TIMEOUT_HINT);
        await reload();
        return false;
      }
      say(textOf(result.error, "这一下没戳出去"));
      return false;
    }
    const line = String(result.data?.line ?? "").trim();
    say(line || "戳了一下");
    await reload();
    return true;
  }

  // ── 跟线程同步 ──

  /**
   * 核心每次 commitPage 都叫一下。只校「正在显示、且跟线程内容绑在一起」的那几块：
   *   - 开着收藏面板且内容真的变了：清旧条目重取（只改已读/playedAt 不刷）；
   *   - 开着的编辑/重生/删除确认框，那条消息被删/撤回/改稿/失去最后一轮资格：收框清稿。
   * 不主动重开面板、不主动刷线程、不动无关的新消息与她的草稿。
   *
   * revalidate：主聊天只加载了一页，收藏完全可能指着更早、当前窗口里根本没有的那条。
   * 他端撤回它时 contentChanged 看不到，所以核心每次真的补拉成功后传 revalidate:true，
   * 让收藏自己再对一次源。只在收藏面板开着时多一次本地 HTTP 读取，不跑模型。
   */
  function syncThread({ contentChanged = false, revalidate = false } = {}) {
    checkDialogAgainstThread();
    if ((contentChanged === true || revalidate === true) && panelOpen("favorites")) {
      void refreshFavoritesPanel();
    }
  }

  // ── 收尾 ──

  function reset() {
    life += 1;
    panelGen += 1;
    proposalGen += 1;
    panelKind = "";
    favoritesSeq += 1;
    favoritesList = null;
    panelBag.abortAll();
    proposalBag.abortAll();
    writeBag.abortAll();
    closeEditor();
    stopPanelAudio();
    if (layer) layer.hidden = true;
    clear(sheetBody);
    if (sheetTitle) sheetTitle.textContent = "";
    if (proposalsEl) {
      clear(proposalsEl);
      proposalsEl.hidden = true;
    }
    pokeBusy = false;
  }

  return {
    appendMessageActions,
    openFavorites,
    refreshProposals,
    poke,
    reset,
    syncThread,
  };
}
