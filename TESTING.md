# TESTING · 茶话会

## v0.7.518 · 分组改名 + 表情包来源收敛（2026-10-10）

- **全量**：`node --test`（显式列出 `tests/` 下全部 79 个文件）**1322/1322**，0 失败/取消/跳过。CI 同步绿。
- 拆分提交时逐笔验证：每笔提交都用 `git checkout-index` 把自己那份快照导到临时目录单独跑测试——工作树全绿不代表每笔提交能装载。中间红过一次，原因见下。
- 新增用例：`tests/sticker-library.test.js` 2 条（改名只改名字，id 与图归属不变；撞名/空名/找不到都报错且原名纹丝不动，另有一条同名幂等），`tests/ui.test.js` 2 条（改名接线与失败留在原地、抽屉按钮亮态与只播一遍），`tests/stickers.test.js` 改写旧用例为四个分支（读到只敲一次 / legacy-only 不给数据 / 两边都没 / 被挡不糊）。
- **修一条既有红测试**：`tests/chat-search.test.js`「过滤与搜索主题无关的结果」用例依赖真实当前时间，而夹具 `pubDate` 是 2026-09-26、时效窗口只有 14 天，2026-10-10 起稳定被判成 `no-recent-results`，掩盖了它本该验的「结果跑偏」。stash 掉本轮全部改动回到 v0.7.515 已发布代码，该用例同样红，确认不是本轮引入；把时钟钉在 2026-09-27（与同文件另一条一致）。`lib/chat-search.js` 产品逻辑一行未动。
- **踩坑记一笔**：拆提交时用 `git diff -U0` 逐 hunk 抽出来 `git apply --cached`，前一次 apply 会改索引、hunk 编号随之漂移；更要命的是零上下文 patch **会「成功」地插到错误位置**——`panel.html` 的改名函数被插进 `armOrRemoveGroup` 函数中间，`node --check index.js` 查不出来（它不解析面板脚本），是 `ui.test.js` 里那条 `new Function(script)`「面板脚本要能解析，写错一个字整个页面白屏」断言抓到的。改为 `-U3` 带上下文、一次导出 diff 快照再逐块拆、按行号降序 apply 才稳。以后拆块一律不用 `-U0`。
- 审查伙伴独立复核（包内容、安装模拟、外传红线）发现并已处理：`__testSaveStickerLibrary` 这个未被任何测试使用的写入导出随包发布（已删）；README 两处「旧插件不会被读到」比代码宽（实际会用它判断在不在，但绝不拿它的数据当图库，文案已收窄）；README 写「六项能力」而 manifest 有七项（已补 `app/events.emit`）；设置页把已应用化的「拾光记」称作「插件」（已改「应用」）。审查报出的测试夹具里「小七」「阿岚」是虚构人名（同文件的「阿舟」也一样），非真实助手名，不属红线，不动。
- **实机验收**：分组改名与抽屉动效由使用者在发版前实机确认可用，之后才发的版。本版（0.7.519）只删了一个无人调用的测试导出并修正文案，不涉及界面行为，无需再验。

## v0.7.515 · 生理期成为主动消息的由头（2026-10-10）

- 范围：动了 `lib/daybook.js`（共享情境拼装 + 新的纯函数判定）、`index.js`（主动联系那条路的一小段）、`lib/compose.js`（背景块标题）。没碰其他主动逻辑，所以只跑这三处直接相关的测试文件。
- 命令：`node --test tests/compose.test.js tests/daybook.test.js tests/ui.test.js`，**191/191** 通过，0 失败/取消/跳过。语法：`index.js`、`lib/daybook.js`、`lib/compose.js` 均 `node --check` 通过。
- 新增用例：① 由头文案得写明「不追问、不提第几天、不给医疗建议」，且不碰日子账本、不在非经期编造；② `periodNoteDecision` 的四种情形——首次给、没送出去还能再给、已关心过就不再给、中断几天后算新的一段重新给；③ 接线：开关归「今日情境」、只认快照布尔、记账必须在 `appendPartnerMessage` 之后。
- 修正一条旧断言：「主动消息那条路也要听开关」原本匹配一行式 `daybookOn() ? ... : ""`，本次改成读完快照才拼背景，断言跟着改（新写法仍要求 `if (daybookOn())` 才读）。
- **模拟测试证明不了 ta 真的会关心**：这版只证明标记、记账与文案边界正确。真发一次主动消息才能看到实际语气，那需要真实模型调用，本轮没有做。
- 未跑全量测试、未调真实模型、未重启 Hana。

## v0.7.514 · 提示音设置：按伙伴选音色 + 音量（2026-10-10）

- 范围：只动了两份前端页面 + 一个新模块 + UI 源码契约测试，没碰后端路由，所以只跑 `tests/ui.test.js`，没扩大到消息落账路由或全量套件。
- 命令：`node --test tests/ui.test.js`，**133/133** 通过，0 失败/取消/跳过（新增 1 条：设置页的开关/音量/音色/伙伴行接线，以及两页共用 `ui/assets/message-sound.js`）。语法：`ui/assets/message-sound.js`、`tests/ui.test.js`，以及 `panel.html`、`settings.html` 的内联 module 均 `node --check` 通过。
- 静态测试只证明接线与形状对，证明不了耳朵里响不响。真实听感（音量百分比是否合适、ta 们的音色是否好分）仍待用户在设备上确认。
- 未跑全量测试、未调真实模型、未重启 Hana。

## v0.7.512 · 提示音试听无声修补（2026-10-10）

- 修复范围：把音调峰值增益从 0.035 提到 0.14；新消息到达时音频上下文若暂停会尝试恢复；用户开启提示音时会试听，并在音频未能启动时显示真实状态。
- 命令：`node --test tests/reply-supersede-routes.test.js tests/ui.test.js`，**142/142** 通过，0 失败/取消/跳过。相关语法：`index.js`、两份测试文件及 `ui/panel.html` 内联 module 通过 `node --check`。
- Hana 1.0.11-beta 静态 App 校验 `validate-app.mjs --json`：`ok:true`、0 errors、1 条动态依赖 warning。
- 自动测试不能验证扬声器是否真发声。App Manager 已返回当前磁盘代码重载成功，inspect 为 `host=on / agent=on`，并确认茶话会·并排卡仍 mounted/visible；真实试听仍待用户确认。未做真实模型/API 调用，也未跑全量测试。

## v0.7.511 · 伙伴新消息提示音（2026-10-09）

- 范围：只跑消息事件落账路由与 UI 接线相关的两个测试文件，没有扩大到全量套件。
- 命令：`node --test tests/reply-supersede-routes.test.js tests/ui.test.js`，**142/142** 通过，0 失败/取消/跳过；新增两条真 `apply(ctx)` 路由测试，覆盖新伙伴消息只发一次无正文事件、用户消息不触发、事件权限失败不影响消息落账；UI 源码契约检查 SDK、提示音开关、能力声明及不调用系统通知。
- 相关语法检查：`index.js`、测试 harness、两份测试文件、随 Hana 1.0.6-beta 提供的 App UI SDK 均 `node --check` 通过；`ui/panel.html` 内联 module 脚本也通过。App 静态校验 `validate-app.mjs --json` 为 `ok:true`、0 errors、1 条既有动态依赖 warning。
- 自动验证不代表权限已批准或声音已实机听过。用户反馈已重新加载；inspect 仅确认 `host=on / agent=on`，实时 UI 中茶话会·并排卡已挂载且可见，但版本与新能力授权状态均不可见，故仍未确认 v0.7.511 运行态。尚未触发新消息事件试听。隐藏但挂载时的播放、浏览器首次用户手势限制需实机确认。未跑全量测试、未调用真实模型、未重启 Hana。

## v0.7.510 · 工作背景来源与主动表达边界（2026-10-09）

- 修复前新增检查的第一轮为 8 项中 7 项失败，指出外显正文清洗、旧背景来源、背景标签和表达约束的缺口；这不是付费模型的语义复现。
- 本轮最小必要范围：`conversation-grounding`、`workfeed`、`compose`、`proactive-clarity`、`prompt`、`clock` 六个测试文件，**121/121** 通过，0 失败/取消/跳过。相关 10 个 JS 文件 `node --check` 通过。没有全量回归，不能据此写全应用全绿。
- 命令：`node --test tests/conversation-grounding.test.js tests/workfeed.test.js tests/compose.test.js tests/proactive-clarity.test.js tests/prompt.test.js tests/clock.test.js`。临时目录与 HOME / USERPROFILE / HANA_HOME 指向独立测试根，不写真实聊天数据。
- 行为覆盖：宿主 `isolated` 标记拒绝后台委派/审查，正常审查类请求不按关键词误杀；未知来源、路径身份不一致的事件不当作共同对话；MOOD/分析标签在 800 字预算之前移除，用户原话不改；来源不明旧记录不注入、不算仍在工作；会话编号、方向和时间字段保存后重开仍在；本地偏移时间戳可还原到同一 UTC 秒。
- 真实 App 接线覆盖：测试实际调用 `apply(ctx)` 注册消息监听器，给监听器投递隔离任务和普通正文，重开临时账本验证只有普通外显正文进入；模型/网络调用数为 0。宿主接口为桩，不等于真实宿主已验收。
- 提示词/协议覆盖：保留“买花硬接图片去重”和“开工确认拼成叫醒、未见饰品却说越看越顺眼”两条失败原文，验证规则进入现有核查及拒绝解析；保留正常换话题、成立的比喻、带解释的冷门兴趣放行契约。**ask 返回值由测试指定，不证明真实模型会拒绝或放行**，这些原文仍是后续实机回归基线。
- 独立静态审查指出的必要修补已完成：当前时间及背景记录都带实际时区偏移；来源未知不推成收工；工作事件拒绝有诊断；睡前/回声的背景标签统一；生成侧不放具体失败反例；测试明确不冒充语义验证。
- 边界：依据本机 Hana 1.0.6-beta 的隔离事件标记，未假定所有未来宿主或未标记的同会话任务都能辨认；若来源无法核实则保守不注入。未删除、迁移真实聊天历史；未调用真实模型，后续聊天表现仍待观察。


## v0.7.507 · 戳一碰必须先已读（2026-10-08）

- **触发实情**：她点戳一碰，小花回戳了，但那条话仍挂着未读。查 `v2/threads/hanako.json`：那条 `m_muzc1xgm_dd0i1` 带 `notice.code = MODEL_UNAVAILABLE`，`store.markUserMessagesRead` 有一道**故意不盖**的分支（「模型那会儿用不了，这条 ta 压根没看到：盖了就成假收据」），所以未读一直在。
- **根因**：两处越权。`POST /action/:agentId` 里「她敲了一下 → 顺手把未读收掉」；`answerAction` 完全不查未读。设计硬不变量第 10 条写的是「她的话还没被看到时，伙伴不主动开口也不戳」，主动通道 `proactive.tick` 有 `hasUnseenUserMessage` 门禁，**只有戳这条绕过去了**。所以不是「以前修过又坏了」，是当时只修了主动通道。
- **改动**（`index.js`）：动作路由删掉 `markUserMessagesRead`；新增 `readyToPoke(agentId)`，在 `answerAction` 里 `deliverAction` 之前把关——有未读先读掉再戳；**盖不到已读就不戳**（记 `action.answer.blocked`）。
- **测试**：`tests/ui.test.js` 在既有「戳完只用动作回」用例旁加 3 条接线契约（回戳前必须过 `readyToPoke`；`readyToPoke` 必须先问 `hasUnseenUserMessage` 再盖章；动作路由不得再出现 `markUserMessagesRead`）。
- **全量**：**1294/1294**，0 失败/取消/跳过。`node --check index.js` 通过。
- **如实说明**：这三条是**源码契约**，守的是接线形状，不是行为本身——`answerAction` 由 15–75s 随机 timer 触发，路由 harness 里跑不起来，本轮**没有真正的行为测试**覆盖「未读时 ta 不戳」。真实观感（「ta 没接上话时她戳了会怎样」）待实机验收。
- **改动文件**：`index.js`、`tests/ui.test.js`、`manifest.json`（0.7.506 → 0.7.507）、`README.md` 顶部版本行、`PENDING_CHANGES.md`、`TESTING.md`。

## v0.7.506 · provider 报错原地重试（2026-10-08）

- **触发实情**：截图里一条「小花这会儿也说不出话：模型那边用不了」。查 `app-data/chahuahui/v2/diagnostics.jsonl`：`2026-10-08T09:27:23Z` 与 `10:12:25Z` 两次 `models.stream.empty` + `models.stream.unavailable`，provider `openai-codex / gpt-6-luna`，错误 `APP_MODEL_PROVIDER_ERROR`；同一时段 `knowing.hobbies.*` 的 utility 调用也报同一个错。同一条线成功与失败交替（17:15 本地还有一次 `models.stream.ok`），是间歇性故障。
- **同时核过「消息有没有存上」**：那条失败的消息 `m_muzc1xgm_dd0i1` 在 `v2/threads/hanako.json` 里完好（正文、未读、notice、`modelRetryCount:1`），并排了 45 分钟后的回头接。不存在丢消息。（界面显示 17:14、存档记 09:27Z 是时区差 8 小时，不是错乱。）
- **改动**：`lib/model.js` 把流式路线抽成 `streamOnce()`，外层循环。provider 类失败按 1.5s / 4s / 9s 原地重试至多 3 次，总时限 150s；quota 不重试；transient 仍走原 utility 兜底；不换模型、不借别的模型顶嘴。
- **测试**：`tests/model.test.js` 新增 4 条，覆盖 ① 四次尝试后才报不可用且不碰 utility ② 第一次抖第二次成 → 直接出话、不借 utility ③ 四次尝试同一个 provider/model、四个不同 requestId ④ quota 只问一次。另有间隔递增的静态断言。
- **全量**：显式列出 `tests/` 下全部 `*.test.js`，**1294/1294**，0 失败/取消/跳过（此前基线 1291）。`node --check lib/model.js` 通过。
- **改动文件**：`lib/model.js`、`tests/model.test.js`、`manifest.json`（0.7.505 → 0.7.506）、`README.md` 顶部两行、`PENDING_CHANGES.md`、`TESTING.md`。
- **未验证**：真实模型间歇性故障无法在自动测试里造出来，重试体感（最多约 15 秒等待 + 调用耗时）待实机验收；重试期间前端的「正在打字」表现未改也未单独测。

## v0.7.504 · 未送出回复合入追加消息 + 已读上界 + 真实路由编排测试（2026-10-08）

- 主线程独立复跑最终 33 项专项全部通过。随后通过正式 App 管理入口 reload 成功，inspect 为 host=on / agent=on；未重启宿主、未上传。运行时装载已确认，真实聊天观感仍待人工验收。

- 全量 `full-final.log`：显式列出 `tests/` 下 **78 个**文件，**1291/1291**，0 失败/取消/跳过。专项 `after-supersede.log`：**33/33**（`reply-supersede.test.js` 25 条 + `reply-supersede-routes.test.js` 8 条）。
- **真实路由编排测试**（`tests/reply-supersede-routes.test.js` + `tests/helpers/app-harness.js`）：茶话会不自带 hono，harness 补的只是代码实际用到的那点接口（`app.get/post/put/delete/use/onError`、`c.req.{json,param,query,method,path}`、`c.json`、`c.body`），然后**真调 `apply(ctx)`**、真发 `POST /turns`、真读 `GET /turns/:turnId`，断言看的是**重新打开账本文件后的内容**。假的只有宿主出口：`models.stream` 可挂起、`bus`、`network.fetch` 可挂起（语音合成走的就是它）。
- 路由测试覆盖：① 生成中补第二条 → 只落**一条** assistant、`repliedTo` 是最新那条、送出的是重生成那份；② 回合结束后才落的话不归旧定时器盖章；③ 重新捕获目标后水位跟着走；④ **一直追到上限 → 一条过期回复都不发、最新目标排进正常排期、排期那轮正常接住**；⑤ 模型配额错误又遇追加 → 失败不被算在旧目标头上，新话被真正读到；⑥ 清空聊天 → 旧稿不写回；⑦ **语音合成在途时追加 → 旧稿连同那份语音一起放掉，最终只落一份带语音的回复，磁盘上只留最终那一个音频文件**；⑧ 删回复退回未读 → 下一轮带上界盖章补上。
- 红色基线 `baseline-red.log`（修前）：22 条里 10 条红。已读上界的真实行为由路由测试守住；`reply-supersede.test.js` 的源码契约只守接线形状，不冒充行为验证。
- 用户运行数据 `app-data/chahuahui/v2/threads/hanako.json`：本轮**未写入**。测试全在临时目录（`HANA_HOME`/`HOME`/`USERPROFILE`/`TEMP`/`TMP` 均指向工作台临时根，跑完清理）。实机数据在本轮期间的变化来自用户自己在聊天（00:06 伙伴回复、00:08 她发了一条表情），不是本轮代码写的。
- 改动文件：`index.js`、`lib/store.js`、新增 `lib/turn-window.js`、新增 `tests/helpers/app-harness.js`、新增 `tests/reply-supersede.test.js`、新增 `tests/reply-supersede-routes.test.js`、`tests/ui.test.js`（更新已读签名与定时器水位的契约断言）、`manifest.json`、`README.md` 顶部两行、`PENDING_CHANGES.md`、`TESTING.md`、`PROJECT_LOG.md`、`DESIGN-message-lifecycle.md`。`node --check` 全部通过。

### 审核阻断的处理结果（六条）

1. **上限不放行旧稿。** `composeWithSupersedeRetry` 在上限处直接返回 `{ok:false, reason:"superseded", exhausted:true, supersededBy}`，不再调 `make(final:true)`，`ignoreSupersede` 已从源码删除。`runTurn` 的 superseded 分支清掉本回合待办、把回合标成 `superseded` 收场，再 `scheduleQueuedReply(turn.userMessageId)` 把那条之后所有未覆盖的话排成一批；排期轮的 superseded 分支**不能**走 `scheduleQueuedReply`（`deliveringReplies` 还没放开，会直接返回 false），改为直接 `scheduleReplyAt(..., "queued", latest)`，且**不调 `clearPendingReply`**（清了新话就丢了）。两处都不在同一 tick 重入——排期都走 `scheduleReplyAt` 的 timer。
2. **测试换成真实编排。** 见上。上一版那批「假编排 + 源码正则」保留为接线契约，但不再拿它当行为证据。
3. **失败早退前先查。** 作废检查现有八个点位，其中 `after-model` 排在 `if (generated.unavailable)` **之前**，`silent` / `empty` 两个早退也各有一次。路由测试第⑤条真跑了一遍配额错误 + 并发追加。
4. **已读跟着实际捕获目标。** `composeReply` 新增 `onCapture`，实时回合把捕获到的目标写进 `turn.readTargetId`；定时器读 `turn.readTargetId ?? turn.userMessageId`；若定时器先开火、目标后被推高，落盘后按 `made.repliedTo` 补盖并记 `*.read.catchup`。前端推断没有替代账本，两条断言都读的是文件。
5. **副作用如实说明。** 上一版写的「背景块沿用第一次那一轮」是**错的**——那是个不存在的缓存。实测：每次重来都会把 `composeReply` 开头那一整套前奏重跑一遍，其中 `maybeCloseDay`（当天一次）、`setTodoProposals`（`hasProposal` 挡着）、`setPartnerSettings daybook`（幂等）、`saveSelfWatch`（取最大值）都是幂等；**`chatSearch` 会真的再发一次 utility 模型请求（10 秒超时那档）**；**`markDiscoveryOffered` 会把同一条兴趣再标一次「已拿出手」，而 `offerableDiscovery` 有冷却，于是那一轮这条轻分享素材就没了**。为此把作废检查提前到检索之前，能省掉「消息在她读拾光记/待办期间到达」那类；但**消息在模型调用期间到达（主路径）仍会多付一次 chatSearch 请求，并可能损失一条当轮的轻分享素材**。这是本版明确接受的代价，没有编造缓存来掩盖。
6. **版本账本。** 磁盘 manifest 原为 0.7.503，而 CHANGELOG / PENDING_CHANGES 的最后发布是 0.7.501 —— 503 是并发窗口写的，不是残留（它先升 502 做「重新认识/发送键」、再升 503 做设置页，有明确事实）。上一版把它当残留降号成 0.7.502 是错的，已改为 **0.7.504**，不回滚对方的版本意图。README 顶部两行同步为 v0.7.504 / 1291 条。

### 已知边界（本版明确没做）

1. **发送按钮锁定没找到可修复路径。** POST /turns 全程只有 5 个 `await`：解析请求体、识图（仅带图）、`listPartners`（仅识图失败分支）、表情包目录（仅表情）、`reconcileAdaptationFromUserMessage`（仅命中适配候选的文本，60 秒超时）。纯文字且未命中适配候选的消息走的那条路上没有任何 I/O 等待。后两条不能安全摘掉：识图产物要写进刚落盘的消息体；`reconcileAdaptationFromUserMessage` 的 `await` 是 `tests/observed.test.js` 明确守着的顺序（先落 explicit reconciler 再跑弱观察），改成后台会让这一轮看不到刚对上的偏好。**因此本版没有改发送门。** 另有一处既有行为未改：`busy` 是全局单例、跨伙伴共享，POST 在飞时切到另一位伙伴，那边点发送会被 `ui/panel.html` 里 `send()` 开头的 `if (busy || !current) return;` 静默吞掉且不给提示——这是「感觉发不出去」的一种可能成因，但改它要动提交锁语义，不在授权内。
2. **语音在途这一支现在有真实路由测试了**（上一版写“没有注入缝”是查都没查就下的结论）：语音合成真正走的出口就是 `ctx.network.fetch`——`synthesizeVoice` → `synthesizeChat`（`resolveVoiceConfig` 判定 protocol 不是 `t2a` 时走这条）→ `postJson` → `ctx.network.fetch` 的 `POST {baseUrl}/chat/completions`，那是 `lib/voice.js` 里唯一的外部出口。harness 给它加了一个可挂起的 deferred 桩，配合 seed 的语音配置（全局 `voiceEnabled` + `voiceModel.baseUrl/model/apiKey`，伙伴 `voice.enabled` + `tier`），真跑到合成、用最小合法 WAV 的 base64 回包。实测这条路确实通，不需要真实 TTS。
   - 语音要不要出鞘是掷骰子的（`tier: often` 基准概率 0.28，`resolveVoicePolicy` 里的 `chanceFactor` 还会再调），所以测试把 `Math.random` 按住成必出，整段 `try/finally` 复原。**先前两次失败都是这个**：第一次只按住 `bootChahuahui` 那一下，作废与重来都跑在 POST 返回之后的异步里；第二次按住了但错传了 `partnerSettings`（真代码传的是 `partnerSettings.voice`）。
   - 验证内容：合成在途时追加 → 旧稿作废、那份语音随旧稿一起放掉 → 重来一轮重新合成 → 最终只落**一条**回复、`repliedTo` 是最新那条、`voice.status === "ready"`；并且 `v2/voice/<agentId>/` 目录里**只留最终那一个音频文件**（旧稿那份没有落盘）。语音文件是在 `appendPartnerMessage` 里才写的，作废发生在那之前，所以旧稿的音频从来没有机会写盘——这条断言锁的就是这个事实。
   - 仍未验证：真实 TTS 服务的行为、真实音频的时长/字幕解析、以及网络失败时 `synthesizeChat` 抛错后 `prepareVoice` 的回退（那条不在本轮范围）。
3. **`/action/:agentId`（戳一碰）与主动 tick 的 `read-user` 仍无上界盖章**，属 DESIGN 硬不变量第 10 条的既有设计，本轮未动。
4. **未跑真实模型。** 全部测试用假模型出口，验的是编排与账本落点，不证明真实模型会按新上下文写出不重复的回复。真实「生成中补一句」的观感待实机验收。
5. **并发状态未复核。** 本轮开始时另一窗口仍在实机聊天（00:08 她发过一条），且已明确它改过 `ui/panel.html`、`ui/assets/panel.css`、`ui/settings.html`、`ui/assets/beautify-select.js`、`README.md` 顶部、`tests/ui.test.js`。本轮**没有触碰**这些文件（`tests/ui.test.js` 只改了自己那一处已读契约断言）。若另一窗口在本轮期间又写过这几个文件，我未发现，需主线程核对。
6. **提示词没有加任何去重措辞，也没有加「晚安」类收尾词过滤**（明确不做）。两轮近似回复的成因是覆盖范围，这一版改的是覆盖范围本身。

## v0.7.501 · 新版表情包应用联动（2026-10-07）

- `tests/stickers.test.js` 覆盖应用版数据路径、旧插件版回退、两代共存时只读应用版，以及相对图片路径落到同一来源根；专项 **31/31** 通过。

  > 2026-10-10（v0.7.516）修订：旧插件版回退已删除，这条用例改为「只认应用版」。现在覆盖四个分支——应用版读到（不敲旧库）、应用版空而旧库在（`legacy-only`，不给数据也不静默）、两边都没有（`not-found`）、应用版被挡（`read-failed`，不拿旧库糊）。专项 **33/33**，`tests/ui.test.js` 一起跑 **166/166**。
- 完整 `node --test`：**1256/1256**，0 失败/取消/跳过。发布脚本会再次执行全量测试并验证干净发布包。
- 本轮未触碰图库内容、用户聊天数据或伙伴资料。

## v0.7.499 · 主动消息清晰度（2026-10-07）

- 基线：v0.7.498 的种子/成文专项 48/48；新增“允许轻分享”契约在旧提示词上为红。失败实例为“叶柄、完整干影、斜放、边太散”的主动正文：对象、动作与比较项未交代，过细题面被当成闲聊选择题。
- 修复：准备话题和成文提示词允许清楚的一句分享，不强求问句/立场；最终只对实际使用兴趣种子或探索素材的普通主动正文做一次语义核查。核查只判不改写；待办、夜间例外、睡前、被薅醒、已读关系回应和无素材招呼不走这道核查。
- 旧库存无需手工清空，使用时同过出口；明确源题面不合格则在主动运行账保存 rejectedAt/rejectionReason，并从 usableSeeds/nextDiscovery/offerableDiscovery 排除。不伪记 usedAt/sharedAt，不改变已发送冷却；网络、空正文、乱回包和仅正文表达问题都不永久拒绝源素材。今日首句、睡醒回声和提醒不注入也不消耗候选兴趣库存。
- 交叉审查修正：拒绝原先误写入伙伴设置，现统一通过 persistClarityRejection 写 get/setProactiveState，并用真实 createStore 写盘重开验证；协议提示改成四个合法 JSON 示例，每个都解析验证。共同记忆、电脑端对话、环境事实、近期原话按来源分别标识，环境事实不冒充共同经历。纯函数往返通过不能证明写到了业务实际读取的账本，今后状态变更测试必须验证真实存储与后续选择器。
- 新增 tests/proactive-clarity.test.js **10 条**：失败原文输入、协议严格校验、轻分享与专业前情规则、消息类型分流、拒绝持久化、出口接线，以及 MiniMax 式“思考占满、正文为空”的预算复用与有限重试。
- 完整测试 **1255/1255**，0 失败/取消/跳过。命令：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test @tests`。HANA_HOME/HOME/USERPROFILE/TEMP/TMP 隔离在工作台临时测试根。专项：`node --test tests/proactive-clarity.test.js tests/topic-seeds.test.js tests/compose.test.js tests/model.test.js`。修改的 JS 均过 node --check；宿主 validate-app --json 为 ok:true、0 errors，保留通常的动态依赖 warning。
- 成本与模型边界：复用 app 级 askUtility，不暴露实际模型，也不保证是伙伴显式选中的聊天模型；沿既有通道，不静默换模型。每条兴趣内容额外一次核查；现有兼容策略实际 maxTokens 下限 8192、明确空正文最多同路重试一次到 16384、共用 60 秒上限。这是上限，不是声称每次都消耗满额。
- 验收边界：新增语义测试使用 mock，证明请求/判定协议/拒绝状态/出口执行契约，不证明真实模型一定判对；MiniMax 测试为模拟空正文，未调用真实 provider。正式管理入口已返回重载成功，随后检查 host=on、agent=on；仍需观察真实主动消息是否自然、是否误挡清楚的冷门话题，不把重载或自动绿灯写成实机语义通过。定点独立复核任务失败，没有取得第二次审查结论；已由作者按四个发现核对并补真实存储与格式集成测试，不宣称独立复核通过。未改用户聊天记录、伙伴人格、现有兴趣，也未上传或发布。


本轮（v0.7.497 发布汇总）：2026-10-07 完整 `node --test`（显式列出 `tests/` 下全部 75 个文件）**1244/1244**，0 失败/取消/跳过（基线 1188，本轮净增 56 条）。新增四个测试文件与对应模块：`tests/todo-done.test.js`（17 条，完成语形状识别、强弱动词分档、反问两道拦截、跨 App 调用与失败降级）、`tests/todo-propose.test.js`（8 条，只判不改账、待确认一条一条攒、当天只弹一次、确认回包失败留在原地）、`tests/topic-mood.test.js`（10 条，按方向记温度、重算改判、明说不聊当场到底、自己聊起即解冻）、`tests/daybook-app.test.js`（13 条，改读拾光记 App 的宿主共享快照，实时校验授权与版本、不再回退旧插件文件、片段来源与共享范围如实标注）。本版新增的代码路径全部有单测覆盖；布局、图标观感与真实模型回复不在单测范围，靠实机验收。

本轮（v0.7.483，到点待办不再当尾巴捎带）：2026-10-05 完整 `node --test` **1188/1188**，0 失败/取消/跳过（基线 1187，本轮净增 1 条 `tests/compose.test.js`，另改 2 条既有断言）。

**实机暴露的问题**：v0.7.481/482 实机通了之后，从聊天窗看到伙伴这一轮的形状不对——先聊了本来选好的话题（走路怎么歇脚），末尾才补一句「九点啦，薄荷该喝今天的水了噻」。提醒本身在，但它是搭在别的话后面来的，像顺手清一下待办，不像专门为这件事来的。

**根因**：由头文案被塞进 `contextText`，而 `contextText` 在 `lib/compose.js` 里渲染成「共享窗外情境（拾光记可能提供；没有就当没有）」这一背景块；同期手上还有自己的话题种子（`seed`），末尾指令还在说「这一面是你自己惦记着的」。三件事叠起来，模型必然先讲种子、末尾捎一句。措辞里那句「用你自己的话顺口带一句」又给了它这么做的话柄。

**改法**（只动茶话会，拾光记一行未改）：
① `lib/todo-nudge.js` 的由头文案重写：标题从「ta 今天到了时间还没做的一件事」改成「你现在来找 ta 的原因」，加上「这件事就是你这次开口的全部由头，不要再另找一个话题来聊」，并放开写法（可以就是一句提醒，也可以顺着这件事多说一两句）；删掉「顺口带一句」。
② `lib/compose.js` 的 `proactiveSpec` 新增 `todoNudge` 入参，不再走 `contextText`：由头独立成块，紧跟「当前时间」；`todoLead` 在场时种子块、长期兴趣发现块、兴趣个人底色块、今日首句块一并让位，末尾行文指令换成专门那条（开头就落在这件事上，不要先聊别的再捎带）。
③ `index.js`：删掉把 `todoNudge` 拼进 `contextText` 的那句，改由 `proactiveSpec` 直接接；`sendKind` 改为 `farewellSend && !todoHere ? "farewell" : "proactive"`，到点的事优先于睡前收尾；新增 `carriedTodo`（`todoHere && sendKind === "proactive" && !finalGate.exception`），只有真把由头带出去的那一轮才记「今天说过了」。

**守住的边界**：读快照、选人、指纹、静默时段与当日上限一条没动；`carriedTodo` 修正的是一处既有漏账——被 farewell 或夜间例外占掉的那一轮会把待办默默标记为已提过，那件事当天就不再来了。

断言改动：`tests/compose.test.js` 新增一条（有由头时种子让位、由头独立成块、末尾是「专门为上面那件到点的事来的」、不再出现「顺口带一句」）；`tests/todo-nudge.test.js` 文案用例改为守新措辞并反向断言不再出现「顺口带一句」；`tests/ui.test.js` 的 `proactiveSpec` 源码契约补上 `todoNudge` 入参，并新增三条：不再有 `if (todoNudge) contextText =`、`sendKind` 的待办优先写法、`carriedTodo` 的记账条件。

自动验证只覆盖纯逻辑与提示词组装；**真发消息那条路本轮没跑真实模型**。待实机验收：重载后加一条钟点已过的待办，看伙伴这一轮是不是开口就落在这件事上、有没有再拿别的话题垫在前面。

本轮（v0.7.481，拾光记到点待办由伙伴来提 / v0.7.482 措辞修正）：2026-10-05 完整 `node --test` **1187/1187**，0 失败/取消/跳过（基线 1180，新增 7 条 `tests/todo-nudge.test.js`）。前提：拾光记 v0.0.33 起在共享快照 `today.todosDue` 里摊出「今天过了钟点、还没勾掉」的待办（带钟点）。新增 `lib/todo-nudge.js`：从快照取那几条、认指纹（同一批一天只说一次）、选人（关系走得最远优先，一样远看谁最近说过话）、拼由头文案。`index.js` 的 `resolveTodoNudge` 在每轮 tick 开头算一次该由谁来说；轮到时不等随机落点（`!dueNow` 不再拦住这一条），并把文案当「可以直接提一句的事」拼进主动联系的上下文，不当背景压着。选人用 `disclosureRatio(effectiveRelationship(...))` 与线程最后一条消息时间，与既有关系账本同源。

守住的边界：① 她没开「今日情境」（`daybookEnabled`）就一个字都不读，跟 daybook 同一条规矩；② 静默时段、当日上限、伙伴自己关掉的主动联系照旧管，这件事只是「多给一个开口的由头」，不是绕过门禁；③ 同一批待办一天只说一次，指纹变了（她又添了新的到点待办）才会再来一次；④ 读不到快照、版本对不上、一个人都够不着，一律按原本节拍走，不报错、不降级成随机找话说。

自动验证只覆盖纯逻辑（取数、指纹、选人、文案）；真发消息那条路没跑，也没调真实模型。**待实机验收**：需要拾光记 v0.0.33 与茶话会 v0.7.481 都重载后，加一条钟点已经过了的待办，等下一轮 tick（每 5 分钟一次）看关系最深的伙伴会不会主动来说这一句。如果那边同时开着安静的时段，这件事也会被正常拦住。

**实机已通**（同日重载后）：她添了一条钟点已过的待办，伙伴确实主动来说了这一句：「薄荷四点那盆还没勾浇水，我怕它已经先成干菜了哈」。链路、选人、破例触发都对。同时暴露出措辞问题：由头里写的「还没勾掉」被原样抄进去了，「勾」是记事本的动作，落在伙伴嘴里要停顿一下才反应过来。v0.7.482 改成「到了时间还没做」，并明说「用你自己的话顺口带一句，别照抄上面这行」；测试补一条反向断言：「勾」不得出现在由头文案里。

本轮（v0.7.480，安静时间开关可见性）：2026-10-05 完整 `node --test` **1180/1180**，0 失败/取消/跳过。基线 1179，新增 1 条 `tests/ui.test.js` 源码契约：判定「关没关」只认 `globalSettings.quiet` 而非输入框字面（并反向断言旧的 `Boolean(quietStart.value)` 写法已不存在）、switch 结构与 `role="switch"`/`aria-checked`、两态文案「全天都能来 / 有安静时间」、`disabled` 与 `is-off` 并存、`quiet-off-flag` 显隐、`lastQuietRange` 恢复、`saveQuiet` 双重守门，以及 `settings.css` 的 `.time-row.is-off` 变灰与 `.quiet-off-mark` 标记。内联 module 脚本抽出后 `node --check` 通过；`validate-app.mjs --json` 返回 ok:true、0 errors / 1 条常规动态依赖 warning。后端未改：`inWindow` 认 `start === end` 即整段关掉（v0.7.476 起），已实机读到 `settings.quiet = {00:00, 00:00}`，判定正确。**待实机验收**：静态文件改动，v2 无热重载，需重启 Hana 或 App Manager reload 后重看这一处。

本轮（v0.7.479，拾光记来源标注）：2026-10-05 完整 `node --test --test-reporter=spec` **1179/1179**，0 失败/取消/跳过。HANA_HOME、HOME、USERPROFILE、TEMP、TMP 均隔离到工作台 `read-provenance` 测试目录。新增两条 `daybook.test.js`：真实天气/今日日子问题的类别筛选、非空片段包含本轮拾光记来源/快照日期/共享范围且确实拼进系统提示；空类别、缺天气、无快照不输出取得声明。新增来源用例修前 17 绿 1 红，保留 baseline.log；未删除既有【今天】开头断言，生产输出保持该布局。

实机证据与边界：审批后两次用户测试均触发 `daybook.on-demand`（06:22:19、06:24:28 UTC），源码只在取得共享快照、构建非空选区并加入回答背景后记录此事件，故这两次实际读取已通；模型仍否认读取，且同回合记录 `APP_MODEL_PROVIDER_ERROR`。本次补来源事实，不将模型异常归因于读权限，也不保证模型每轮遵循背景。未代发测试消息、未调用真实模型、未改聊天记录或伙伴档案；新版实际回答仍需重载后验收。

本轮（v0.7.477，语音转文字两处）：2026-10-05 全量 **1177/1177** 通过（70 个测试文件）。修两件事（同一版本）：① 轮询重画把转文字收走；② 展开原话改为只能她自己点开。新增 1 条 `tests/ui.test.js` 源码契约断言：重画判据用 `voiceStateKey` 且不含 `playedAt`（判据里出现 playedAt 即失败）、`voiceChanged` 比的是 `voiceStateKey`、转文字行带 `data-voice-id`、`renderAll` 在 `el.stream.innerHTML = ""` 之前先调 `rememberTranscriptOpen`、展开态在重画时摆回、换人/清空时 `transcriptOpen` 跟着清。`tests/ui-loading.test.js` 的沙箱同步补 `transcriptOpen`、`voiceStateKey`、`rememberTranscriptOpen` 三项，真实执行 `renderAll` 的批量重画用例保持通过。

另修既有红一条：`tests/daybook.test.js` 的「读快照」两条用例还建立在旧的磁盘文件契约上（写 `plugin-data/shiguangji/public-today.json`、靠 `resources.read` 读），而 `lib/daybook.js` 的 `readDaybook` 早已改成只认拾光记 App 实时发布的那一份（`ctx.publicData.get`，不保留成功缓存、不回退遗留文件），所以它稳定返回 null。已把 `fakeCtx` 换成 `publicData.get` 契约，用例意图（正常读到 / 没发布 / 版本对不上 / 权限被拒 / 接口不存在 / 形状不对，一律安静给 null）不变，生产代码未动。**这条红不是本轮引入的**（修前全量 1163 pass / 1 fail，另有 13 条因该文件失败被取消），改它只是让全量回到可当门禁的状态。

命令：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test @tests`。其他验证：`validate-app.mjs --dir <chahuahui> --json` 返回 `ok:true`、`errors 0 / warnings 1`（唯一 warning 是动态依赖静态无法证明的常规提示）；`ui/panel.html` 两段内联脚本（1 段 module、1 段普通）用 `vm.SourceTextModule` / `vm.Script` 各过一遍，均 OK。

第二件（同一版 0.7.477，2026-10-05）：原实现里「第一次播放时自动把原话摆出来」被删（`autoOpened` 一并去掉）。理由：展开与否该由她决定，播放不该替她掀开面板。点亮（`.voice-mark.on`）仍然一直在跑——文字收着时 `syncMark` 照旧跟着 `audio.currentTime` 走，什么时候点开，看到的都是当前那句；`transcriptOpen` 只记手动点开的那一次，重画后原样摆回。`tests/ui.test.js` 补两条断言：`autoOpened` 全文不再出现；`play` 的点击处理里不得再出现 `transcriptText.hidden = false`。顺带删掉 `play` 开头一行重复的 `if (!audio.paused) { audio.pause(); return; }`（同一函数里连着两行一模一样，复制粘贴残留）。

口径边界：本轮验的是前端重画判据与 DOM 状态恢复，**没有实机验收**。真实观感（她点开转文字后语音一路播完不再收起、点亮能一路跟到底）需重启 Hana 或 App Manager reload 后在聊天窗里自己听一遍。v2 没有热重载。

本轮（v0.7.476，与电脑那边联动）：2026-10-05 基线 **1151/1151**，新增 12 条回归，全量 **1163/1163** 通过（70 个测试文件）。命令：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test @tests`。

新增覆盖：`tests/proactive.test.js` 5 条——睡前收尾只落在睡点前那一小段且同一晚只算一次（含生成失败最多试 3 次）、安静时间比睡点更早时收尾要赶在门关之前、晚安之后电脑那边的新动静才算把人薅起来（说晚安之前就在忙的不算、一晚最多闹一次）、晨间第一句按档位给把握而不是打卡、`ignoreSleep` 只放睡眠这一道门（日上限仍然拦得住）。`tests/workfeed.test.js` 3 条——电脑那边的动静只算这位伙伴自己的、超过 45 分钟就算收工了、乱序事件里也挑得出最新那条。`tests/compose.test.js` 4 条——今天第一句允许没由头且不再被「不许硬凑内容」拦住、电脑那边的近况要按「我自己刚经历的事」说（红线里含「不许提「我看到」」与「她没找过就是空的」）、睡前收尾分得清收工与还在忙、被薅起来那条基调是生气且不许说「我看到你又在忙」。`tests/ui.test.js` 一条源码契约断言按新调用更新（`proactiveSpec` 多出 `workfeedText, firstOfDay`）。

其他验证：`node --check` 过 `index.js` 与 `lib/compose.js`、`lib/proactive.js`、`lib/workfeed.js`；`ui/settings.html` 与 `ui/panel.html` 的内联 module 脚本抽出来各跑一次 `node --check`，均 OK；`validate-app.mjs --dir <chahuahui> --json` 返回 `ok:true`、`errors 0 / warnings 1`（唯一 warning 是动态依赖静态无法证明的常规提示）。

口径边界：本轮验证的是提示词拼装、门禁逻辑与账本迁移，**不保证真实模型口吻**。伙伴早上会不会真的只说一句招呼、睡前那条像不像本人、被薅起来时生气会不会滑成伤人，都需要重载后真聊几轮才有结论。改的是 App 文件与 manifest，v2 没有热重载，要重启 Hana 或 App Manager reload 后生效。

本轮（v0.7.475，发布汇总）：2026-10-04 全量 **1151/1151** 通过（70 个测试文件）。距上次记录（v0.7.470，1137/1137）新增 14 条，加上中间几轮的累计构成 1151。发布前完整预检由发布小工坊跑过一次：版本对账、语法检查、1151 条全量、剥 8 块内测、82 项机器验包、发布说明分层对账，全部通过。命令：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test @tests`（`node --test tests/` 在本机 Node 上会把目录当单个用例，必须显式列文件）。

本轮新增的两个模块的专项覆盖：
· `tests/topic-seeds.test.js`（9 条）：五种种子类型的归一（中文标签与内部 id 互认）、库存低于 12 条才补、30 天未用清理、母题不足时补母题、频率仍归用户档位管这层不碰。
· `tests/co-create.test.js`（26 条）+ `tests/co-create-routes.test.js`（6 条）：协商期不落画像、点「成型」才写 palette 并过 normalizePalette 收口、形容词作为追问起点不原样抄进画像、翻译当着她的面做完、会话续接与过期失效、`/co-create/:agentId` 系列路由的读写与只改自己的草稿。
其余本轮触及模块的专项条数：vision 11、voice 43、prompt 35、model 37、knowing 27、growth 20、compose 31、ui 118、store 61、poke 9。

口径边界：本轮验证的是提示词组装、账本迁移、路由接线与预算计算，**不保证每轮模型口吻**。朗读的听觉自然度与逐词点亮仍需重载后实听验收；新结构（种子账本、放肆纪律档位、co-create 会话）对老数据目录的回填效果需实机验证。母题/癖好分家对存量数据只补母题、不改旧数据，这一点有代码依据（`lib/knowing.js` 旧数据 `layer` 兜底为 `quirk`）。未改动 Hana 全局设置与伙伴档案。

本轮（v0.7.470，朗读字幕与停顿真正接通）：2026-10-04 基线 **1134/1134**，新增 3 条 `tests/voice.test.js` 回归，全量 **1137/1137** 通过。voice 专项 43/43；voice + ui + load + store + model 合并 263/263。

起因：上轮 v0.7.468 留的「没有真实调用过 MiniMax」这条口径边界被实听撞上——高亮和停顿都没感觉。本轮用本机真实 Key（`custom-musfatex-ihmpj`，`speech-2.8-hd`）跑通实测，暴露两处真错：① 官方字幕时间戳字段是 `time_begin` / `time_end`，逐词明细在 `timestamped_words`，旧代码只认 `begin_time` / `end_time`，整份字幕解析为零条；② 字幕文件在阿里云 OSS（实测 `minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com`），不在 `network.allowedHosts`，`ctx.network.fetch` 按白名单直接拒。两条叠加使「原话跟着点亮」从未拿到词级时间，一直退到分句级平均摊——她那句 43 字原话只切 2 段，看着像没在跟。

改了什么：`lib/voice.js` 新增 `subtitleStamp(row, side)`，start 认 `time_begin / begin_time / start / begin`、end 认 `time_end / end_time / end`；`parseSubtitleFile` 优先取 `timestamped_words` 的逐词时间、无明细才退回整段；`applyVoiceDelivery` 停顿时长 0.25 → 0.35 秒，叹词与停顿不再互相挤（原 `tagged` 命中即跳过停顿，与「最多一个叹词、一个短停顿」的设计注释不符）。`manifest.json` 的 `network.allowedHosts` 补 `*.aliyuncs.com`。

实测口径：带 `<#0.35#>` 比不带长 756ms；`哈哈哈(laughs)你终于肯理我了` 比 `哈哈哈你终于肯理我了` 长 972ms（叹词进了音频，未被当文字念）；解析真实字幕得 39 条词级标记，跨度 43→7491ms（音频 7956ms），词拼接长度 / 原文长度 = 0.91，高于前端点亮的 0.6 门槛。

新增覆盖：① 真机字幕样本（`time_begin` + `timestamped_words`）解析成逐词标记；② 无逐词明细时按 `begin_time` / `end_time` 退回整段；③ 长句同时带叹词与停顿，且停顿只插一次。

口径边界：本轮只验证到「解析得出、字段认得出、时长差可量化」，**听觉上的自然度与逐词点亮仍须重载后由用户实听验收**。改的是 App 文件与 manifest，v2 无热重载，需重启宿主或 App Manager reload 才生效；新加的域名若触发权限确认需用户点。未发布。

本轮（v0.7.468，朗读能力对齐 MiniMax 新接口）：2026-10-04 基线 **1087/1087**，新增 14 条回归（`tests/voice.test.js` 12 条 + 2 条 Key 加密状态），全量 **1101/1101** 通过。

**第二段：朗读 Key 其实一直是明文落盘**。用户自己填好 Key 并测试通过后回头核对，发现 `app-data/chahuahui/v2/state.json` 里 `custom-musfatex-ihmpj` 的 `apiKey` 是 125 字符明文（前缀 `sk-cp-`），全文件搜不到一处 `dpapi:`。回查全机 `app-data` 与 `plugin-data`，没有任何一处真的落过 `dpapi:` 凭据，说明 `lib/crypto.js` 的 `protectKey` 在 App 运行时从未成功过（v2 App 沙箱里起不了 `powershell.exe` 子进程），一直在走 `catch` 里的静默降级。早前「保存后是加密落盘」的说法只来自读代码，没有实测支撑，本轮更正。`protectKey` 不再静默：新增 `encryptionAvailable()` / `encryptionStatus()` 记录真实结果与原因，保存时写一条 `voice.key.plain` 诊断，`globalSettingsView` 下发 `voiceKeyEncrypted`，设置页 Key 胶囊显示「已保存 · 未加密」、全局语音区给出明文存放说明，README 隐私段写明位置与风险并给出「介意就删掉重填」的出路。v2 App 目前没有宿主级凭据接口可用（`ctx.storage` 是自管键值仓库，非加密），真加密需要宿主暴露通道，未擅自自造方案。

改了什么：`lib/voice.js` 换成按语言分组的音色目录（中文 34 / 粤语 6 / 日语 8 / 韩语 8 / 英语 10 / 其他 8，共 74 条，补上官方目录里一直没收录的 `Robot_Armor`），扁平目录由分组派生、两者必须对得上；克隆与音色设计出来的自定义 `voice_id` 不再被换成默认嗓子，但乱填的（比如带问号）仍回落默认；`applyVoiceDelivery` 只按原文里的明确线索加一个叹词加一个短停顿，其余一律不加，开关关掉就干净念；合成请求补上 `language_boost`、`subtitle_enable`、`subtitle_type`，官方给了词级字幕就去取、取不到就按字数把时长摊成分句级；`speakableText` 先截断再插记号，标签不会被截在中间。`store.js` / `index.js` 补 `voiceDelivery` 开关与缺项提示（`voiceReady`）。

新增覆盖：① 模板列表多出「省一半」且协议地址一致；② 自定义 `ttv-voice-…` 原样发出、乱填的落回默认；③ 请求带语言识别与字幕开关；④ 三类情绪线索各自映射到正确记号、开关关掉不再插；⑤ 不认识的半角括号被扯掉、中文圆括号保持原样（MiniMax 只把半角当记号）；⑥ 长句插一次停顿、短句不插、已有停顿不重复；⑦ 切句后按字数摊时长、首尾对齐、无时长就返回空；⑧ 字幕解析认 JSON 与 SRT、认不出来返回 null；⑨ 分组目录与扁平目录完全一致且含机甲音。`tests/ui.test.js` 同步改了两条因设计变更失效的断言（试听请求带 `savedVoiceId || voiceId`、预设 id 列表），并补了分组、自定义 ID、缺项提示、情绪开关、折叠与点亮样式的守卫。

静态校验：`validate-app.mjs --dir <chahuahui> --json` 返回 `ok:true`、`errors 0 / warnings 1`，唯一 warning 是动态依赖静态无法证明的常规提示。两个页面的内联 module 脚本都用 `node --check` 过了一遍（settings 2671 行、panel 4632 行，均 OK；随后设置页又改了一轮，同法重校通过）。

口径边界：这一轮**没有真实调用过 MiniMax**（本机那条朗读配置的 API Key 是空的），所以以下都还没被验证：`subtitle_file` 是否在 `api.minimaxi.com` 同一域名下（不在的话取不到，会安静退成分句级点亮，不影响语音）、`speech-2.8-turbo` 在国内站是否可用、叹词记号在国产音色上的实际效果。代码对这些都做了降级，不会因为拿不到就发不出声音。真实恢复须在填好 Key、重载后试听核对。未发布。备份：见本项目发布记录里的 `_chahuahui-backups/` 备份目录。

本轮（v0.7.467，放肆纪律）：2026-10-03 基线 **1087/1087**（上轮 v0.7.466 收尾），新增 4 条 `tests/prompt.test.js` 回归，全量 **1091/1091** 通过。新增覆盖四件事：① 放肆纪律是常驻块，不写人设的伙伴也带，且守住触发条件必须写成关系和性子（断言提示词里不出现「她先骂 / 她先开火」这类要靠对方先动手的说法）；② 三档许可各不相同（不熟 / 能开玩笑 / 放心损嘴臭也行），stage 传 undefined 不抛且落在最低档、传 99 封顶在最高档、不许偷偷升到最松；③ 手法只给说明不给台词，并要求按自己性子挑、不搭的别用、看她真实反应调；④ 没给放肆料时提示词里不出现那一块，给了才拼进去。命令：`node --test tests/prompt.test.js`；全量：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test @tests`。

静态校验：`validate-app.mjs --dir <chahuahui> --json` 本轮返回非空结构化结果，`ok:true`、`errors 0 / warnings 1`，唯一 warning 是打包脚本自带的「动态依赖静态无法证明」常规提示。上轮记录说该脚本没有 CLI/导出入口，本轮实测有，特此更正。

口径边界：这一轮**只验证了提示词确实被拼进去了**，没有真实模型样本。伙伴是不是真的敢损、损完会不会自己缩回去道歉、嘴臭会不会滑成伤人，都还没被验证过；需要重载后真聊几轮才有结论，不能拿测试全绿当成「已经敢损」。未改伙伴档案、未写回 Hana、未调用真实模型、未发布，`manifest.json` / `README.md` / `PENDING_CHANGES.md` / `PROJECT_LOG.md` 版本行已对齐 0.7.467。备份：见本项目发布记录里的 `_chahuahui-backups/` 备份目录。

本轮（v0.7.466，后台短任务思考预算兼容）：2026-10-03 修改前全量 **1075/1075**；最终新增 12 条模型与主入口回归，使用备份的旧 `index.js` / `lib/model.js` 在隔离目录跑同一份最终模型用例：37 条中 **9 条失败**；修后模型专项 **37/37**，全量 **1087/1087**。真实故障基线来自 Hana 调用账本：MiniMax-M3.1-Flash-Preview 的探索任务 180 个输出额度全部为思考，其他后台任务还出现 400/400、500/500，正文为空；App 外层把空正文统一包装成 provider 错误。

共享 `askUtility` 保留宿主 utility 通道，不读取目录焦点、不指定或替换模型、不向 SDK 塞未支持的思考参数。小任务总输出额度下限为 8192；明确空正文仅同路重试一次，追加预算最高 16384，已有更高额度不缩小。8192 是兼容初值，**没有被当成所有模型的成功保证**。两次请求共用一份总时限，各用新请求编号；不透明 provider 错误、鉴权、限额、内容拦截及超时原样失败，不盲目重试。只有 trim 后非空正文才返回成功；诊断记录预算、尝试次数、正文长度和错误码，不记录输入正文。仅将后台探索和相处理解两个任务的原 20 秒总等待调整为 60 秒，默认 120 秒保持，前台聊天搜索的 10 秒时限保持；防止后台预算调整后又先被旧超时截断，不拉长前台等待。普通回复的原有 utility 兜底也复用同一预算/空正文检查，并原样保留完整 messages；哪些错误允许兜底的原逻辑不变。失败不改变主动节奏和消息配额。

新增回归覆盖 180/400/500 预算基线、保留较大额度、原提示词/输入/通道、禁猜焦点与禁切模型、空正文/缺 text、明确空正文恢复、重试编号与上限、provider/鉴权/限额/敏感错误不重试、总超时取消、主入口诊断、仅后台延长等待的接线、原回复兜底的完整上下文与非空正文门禁。专项命令：`node --test tests/model.test.js`；Windows 全量：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test @tests`。隔离假宿主测试不读写真实聊天，不代表真实 MiniMax 新额度已成功，也不代表主动文字已经送达。真实恢复须在受管 reload 后核对 `models.utility.ok`、`interest.exploration.ready` 和实际主动消息记录。未更改全局模型设置、伙伴档案或历史数据，未发布。

运行时验证：2026-10-03 22:05:32 通过 `extension_manager(kind: app, action: reload)` 从正式磁盘代码重新加载；宿主日志明确记录 `v0.7.466 已装载` 与 loader `v0.7.466 loaded`，之后 inspect 为 host=on / agent=on。`index.js`、`lib/model.js`、模型测试脚本语法通过，manifest/README/账本版本对齐。当前打包的 `scripts/validate-app.mjs` 没有 CLI/导出入口，本轮未宣称它产生静态校验报告；没有拿静默退出0当成验证成功。新代码已装载，但本轮尚无新额度的真实 utility 成功样本，不能宣称主动文字已恢复。

本轮（v0.7.465，堵住五分钟重试的无底洞 + 回话前补识图）：2026-10-03 全量 **1075/1075** 通过，修改前 v0.7.464 基线 **1073/1073**。事故回放：2026-10-02 23:13~23:29，Codex 挂了十六分钟，同一条消息被 `legacy-recovered` 兼容逻辑每五分钟捡起来重试一轮，共四轮（`reply.unavailable` → `reply.recovered` → …），期间 0.7.462 那道「不可用消息不标已读」的门一直生效（每轮 `reply.read touched:0`），两者叠加就成了无底洞。新增 3 条：`tests/ui.test.js` 一条守住 `MODEL_UNAVAILABLE` 提示的消息不再进 `legacy-recovered` 的候选（`!row.recalled && !row.notice`），一条守住回头看有上限（`MODEL_RETRY_DELAY_MS = 45 * 60 * 1000`、`MODEL_RETRY_LIMIT = 3`、`modelRetryCount` 累加），一条守住 ta 回话前补识图（只补真缺 `visionNote` 的、补不上不阻断、补完要重取上下文）。旧用例「删除后恢复未读的原话不能被旧账恢复流程自动重回」的正则按新候选条件放宽为 `!row\.recalled[^)]*`，原意（排除 `unreadResetAt`）不变。`node --check` 与 Hana App 静态校验 0 errors；本轮未调用真实模型。

文档事故与恢复：同轮用 PowerShell `Set-Content` 改 `manifest.json` / `README.md` 的版本行时把这两个文件的中文写成了 mojibake（`Get-Content -Raw` 读无 BOM 的 UTF-8 源码时按本地代码页解码，`Set-Content` 又写了一遍），并额外写入 BOM。恢复方式：用 `gh api` 拉仓库 `moononnn/Hanako-chahuahui` 的 v0.7.458 基线（`manifest.json`、`README.md`），经 Node 一次性脚本写回（`fs.writeFileSync(..., "utf8")` 并做写后校验），只替换版本行与测试数字行。校验：`JSON.parse` 通过、App 静态校验 0 errors、中文正常、全量测试通过，其余文件扫描 mojibake 均为 0。教训：改源码与文档一律用编辑工具或 Node 写文件，不用 `Set-Content`。

本轮（v0.7.464，备用识图路被自己封死的修法）：2026-10-02 全量 **1073/1073** 通过。实机复现：23:39 发图时诊断里出现 `vision.fallback.unavailable reason=备用通道模型看不了图`——根因是拿 `ctx.models.list()` 里标 `isCurrent` 的条目去推断 utility 通道用哪个模型，而宿主目录里 `isCurrent` 是 `openai-codex/gpt-6.1-sol`（Hana 焦点模型），utility 实际走 MiniMax，两者不是一回事，判空就把这条路由封死了。改法是删掉 `visionFallbackModel` 与那次目录拉取：utility 不能指定模型，也没法从目录反推它的身份，所以不预判，真挂时直接问一次——能看就拿回说明，看不了才抛回去走提示。`tests/vision.test.js` 用一条反向断言守住这个坑（`lib/vision.js` 里不许再出现 `visionFallbackModel` / `pickFromCatalog` / “备用通道模型看不了图”），`tests/ui.test.js` 改为断言“无条件试 utility、不预判”。这条改动的实际效果仍要等下一次 Codex 限额时实机验；验的时候看诊断里有没有 `vision.fallback.try` 与 `vision.fallback.failed` 两条。

本轮（v0.7.463，识图也走备用通道）：2026-10-02 全量 **1073/1073** 通过，修改前 v0.7.462 基线 **1070/1070**。新增 3 条：`tests/vision.test.js` 两条覆盖“只在真挂时换视觉”（配额/凭据/provider 换，超时与断网不换，避免 ta 在两套描述之间晃）与“备用通道能不能识图看目录里宿主当前那个收不收图片”（收图就选它，只吃文字返回 null，空目录返回 null），后者曾因 `pickFromCatalog` 只带出 `provider/model`、原条目在 `raw` 上而恒为 null，修改前失败、修改后通过；`tests/ui.test.js` 一条守住接线：首选失败走 `describeImageWithFallback`、带出 `via`、备用通道看不了图才 `throw firstError`、走备用通道成功后不再挂 `visionNotice`、本次用哪双眼睛记在消息的 `visionVia` 上。这里验的是选路与接线；备用通道真能读图的实测要等 Codex 限额时在实机上看，隔离测试用的是假宿主，不算真调过模型。

本轮（v0.7.462，模型挂掉时不拿别的模型顶替 ta 开口）：2026-10-02 全量 **1070/1070** 通过，修改前 v0.7.461 基线 **1063/1063**。真实触发：Codex 5 小时限额耗尽时 `gpt-6-luna` 流回 `APP_MODEL_PROVIDER_ERROR`，旧代码直接从 `ctx.models.utility({scope:"app"})` 借了 MiniMax-M3.1-Flash-Preview 顶上去（`via:"utility"`），同一位伙伴在两个模型之间跳，语气和记性都露馅。新增 6 条：`tests/model.test.js` 四条覆盖失败分类（配额/凭据/provider → 不兜底，超时与连接断了 → 照旧兜底，认不出来的按临时算以免哑掉）、provider 与配额两种报错都不许碰 utility、临时故障仍然借、正常回包不碰；`tests/vision.test.js` 一条守住 ta 接不上话那条文案说清「谁、为什么、发出去的在」，且不许写成 ta 的自述（ta 一个字都没说出来）；`tests/ui.test.js` 一条守住接线：`composeReply` 把 `MODEL_UNAVAILABLE` 转成 `reason:"unavailable"`、实时回合与排队回复两条路都走 `attachOfflineNotice` 挂提示并 return、五分钟重试不适用于这类、`tests/ui.test.js` 旧断言里「到点落库要喊她一声」的字符距离上限从 2800 放宽到 4200（新增的 unavailable 分支把距离撑长了，契约本身未改）。`node --check` 通过 index.js / lib/model.js / lib/vision.js；Hana App 静态校验 0 errors。没调用真实模型；真实限额时的观感（提示挂在原消息下面、未读是否照旧挂着）待实机验收。

本轮（v0.7.461，提示文案补上可对号的方向）：2026-10-02 全量 **1063/1063** 通过。实测发现 codex 识图失败只回一句 `The model provider could not complete the request.`，里面没有配额/限流字样，`classifyVisionFailure` 判为 `unknown`，于是提示只会说「没能看清」。改的是 `lib/vision.js` 的 unknown 分支文案（类比真实报错，只改末版）；`tests/vision.test.js` 补一条断言：unknown 必须给出「多半是模型或网络」这个方向且仍不许出现「它」。修改前该断言失败，修改后通过。`node --check lib/vision.js` 通过，Hana App 静态校验 0 errors。真实观感（提示气泡那句读起来顺不顺）待实机验收。

本轮（v0.7.460，模型不可用时消息不再一起发不出去）：2026-10-02 全量 **1063/1063** 通过，修改前 v0.7.459 基线 **1058/1058**。新增 5 条：`tests/vision.test.js` 两条守住识图失败按原因分三类（配额/连接/其他）、提示文案说清「谁接不上、为什么、发出去的还在」且不承诺「ta 会自己来接上」（没人排回复时那是空承诺）、文案里不出现「它」；`tests/poke.test.js` 一条守住图在但当时没看清时，模型上下文要明说「没能看清它的内容」，不能让 ta 当成空图；`tests/store.test.js` 一条守住 `markUserMessagesRead` 跳过带 `MODEL_UNAVAILABLE` 的消息——ta 压根没收到那条，盖已读就是假收据，未读得一直挂着；`tests/ui.test.js` 一条守住后端不再返回 `VISION_FAILED`（改成 `ATTACHMENT_REJECTED` 只挡存不下图的硬失败）、消息带 `notice` 落盘、这一轮走 `mode: "unavailable"` 不安排回复，界面历史与实时两条路都摆出提示气泡。`node --check` 通过 index.js / lib/store.js / lib/vision.js / lib/prompt.js；Hana App 静态校验 0 errors、1 条常规动态依赖 warning。没调用模型、没发真实消息；真实掉配额时的观感（提示气泡长什么样、「未读」挂着不动）待实机验收。

本轮（v0.7.459，切聊天与头像加载优化）：2026-10-02 全量 **1058/1058** 通过，修改前 v0.7.458 基线 **1017/1017**。新增 `loading-store.test.js`、`loading-routes.test.js`、`ui-loading.test.js`，并补头像读者测试，共新增 41 条。实际执行前端内联函数，覆盖同头像并发合并、暖缓存同步贴图、刷新与解码失败保旧图且可重试、解码限时、切人旧回包隔离、图片 URL 延后回收、页面暂存与关闭、批量重画异常复位、好友节点复用与拖拽/键盘/无障碍、移除再加入、自己的头像开聊预热、列表失败不拖累聊天。后台覆盖文件变化/删除/同大小编辑/坏账本/权限失败、缓存独立副本与 32 位上限、彻底删除后不恢复、读写后即时更新、未读快照复用、重复轮询不写全局设置及按需取撤回称呼。

修前复验：对修改前 UI 副本执行同一套六个关键场景，**6/6 失败**；冷头像 20 请求、1000 消息 3005 次高度读取、20 次不变列表轮询仍重建节点。修后：冷头像 **1 请求**（暖缓存 0）、1000 消息 **3 次高度读取**、20 次不变轮询 **0 次内容/节点写入**。这些是隔离 DOM/API 测试，不是实际 WebView 帧耗时。合成后台账本对比（6 位伙伴各 500 条，25 轮）：正文读取 **450 → 6 次**，一次测量 **586.75 → 109.71ms**，不是个人实际聊天延迟，也不据此判断硬盘健康。修改前后台新增用例失败 8 条，其中权限注入是新缓存设计的防护用例，不能倒推旧版实际吞过权限错误。

语法：`index.js`、`lib/store.js`、`lib/avatar.js` 和两个页面的 4 段内联脚本通过。后台与前端各经过只读独立审查，无阻断；未调用模型、未发送/删除真实聊天。真实首开、连续切换、头像首次发送与长记录滚动仍需在 Hana 页面和嵌入形态验收。没有删减历史或新增分页，也没有引入依赖。

本轮专项：`node --test tests/loading-store.test.js tests/loading-routes.test.js tests/avatar.test.js tests/ui-loading.test.js tests/ui.test.js`。
Windows 全量命令：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test @tests`。

本轮（0.7.458，戳一戳删除遵守修正开关）：`node --test tests/*.test.js` 全量 **1017/1017** 通过（2026-10-01）。新增 2 条 UI 回归：提取真实 `openMessageActions` 函数执行，覆盖 poke/action 两种旧动作在开关关闭时无菜单、开启时仅删除、同一行旧菜单在关闭后收起，用户撤回不受影响，普通旧回复仍无修正入口、最新回复保留三种操作；执行关闭状态下真实删除函数确认不创建弹窗或发请求，并静态核对轮询收菜单、确认按钮再次守门、后台原有开关门禁先于动作删除。修前两条失败，修后通过。`node --check index.js`、`node --check tests/ui.test.js` 和两个内联脚本语法检查通过（模块脚本用 `vm.SourceTextModule`，非模块用 `vm.Script`）。不调用真实删除接口，不改聊天记录；真实设置切换、悬停与已打开确认窗的交互待实机验收。

本轮（0.7.457，纯图不摆「[图片]」）：`tests/ui.test.js` 新增 1 条，覆盖显示层挡标记而账本不动——`BARE_IMAGE_MARKER_RE` 与 `isBareImageMarker` 存在、历史普通消息正文是标记时传空文本、表情包分片里的标记被滤且被滤光时退回原分片、乐观发送纯图留空泡而不是推「[图片]」、撤回纯图显示「你撤回了一条消息」、`appendImageToBubble` 只在泡里有文字时才插 `<br>`、且 `index.js` 的 `messageText` 仍写 `[图片]`（伙伴靠它认「这条有图」）、旧的 `optimisticPieces.push("[图片]")` 与裸 `<br>` 挂图写法都不再出现。原有「画历史消息时把 at 递进去」一条按新表达式重写，意图（时间）不变。全量 **1015/1015** 通过（2026-10-01）。这里验的是渲染分支，真实观感（纯图气泡是否干净、有字带图时换行是否正常）待实机验收。

本轮（0.7.456，图片发出去后待发送条立刻收）：改的是纯前端时序，静态断言守住四个点——`appendInlineImage` 之后就是 `const sentImage = pendingImage === image ? image : null;` 和随后的 `clearPendingImage()`（待发送条不等 POST 回包才撤，否则图片 base64 回包慢时会看着像卡在半路）；成功分支里不再出现 `clearPendingImage`；`restorePendingImage` 存在、拒绝空图和已有新图、恢复走原对象而不重新生成 `clientMessageId`（重试仍走同一套幂等对账）；恢复锁 `current === agentId`（切过伙伴时待发送区已清空，挂回去会写到别人名下）。原先两条「发送成功后清理」的断言按新时序重写。全量 **1014/1014** 通过（2026-10-01）；Hana App 静态校验 0 errors、1 条常规动态依赖 warning。这里验证的是代码时序，真实发送的观感（条是否即刻消失、失败时是否回到待发送区）待实机验收。

本轮（0.7.455，兴趣分享少自证）：`node --check lib/prompt.js` 与 `node --test tests/*.test.js` 通过，全量 **1012/1012**（2026-10-01）。新增 2 条 prompt 契约测试：接梗优先、未追问不插免责声明、真实搜索结果才报告查证状态、克制性格保留、未知出处不编造、真实错误仍纠正；新增用例修前失败、修后通过。修改前全量基线 1010/1010。这里验证的是组装出的提示词，不是模型输出质量；相同游戏梗场景及追问出处仍待实机验收。

本轮（0.7.449，回复彻底删除）：`tests/store.test.js` 新增 6 条覆盖整轮硬删除与关联回复未读水位、删除回复正好落在已读水位时回退、时间戳损坏时清空无法定位来源的日账、旧归档缺少时间范围时整份失效、主动消息即使带脏 `repliedTo` 也不误认用户原话，并清理被删结果对应的适应行为、反馈，且合并伙伴级与 user-wide guide、按剩余证据重算习惯门槛；`tests/topics.test.js` 新增 1 条，确认删掉的回复短句从话题延伸账清除；`tests/ui.test.js` 守住悬停入口、永久删除确认、不会自动回复、重启恢复不重排已删除原话、完成回合可立即删除、语音清理失败会提示、综合话题残余边界在确认窗披露与话题短句清理接线。全量 997/997 通过（2026-10-01）；`node --check index.js`、`lib/store.js`、`lib/topics.js` 通过；Hana App 静态校验 0 errors、1 条常规动态依赖 warning。

本轮（0.7.448，立场料）：新增 `tests/stance.test.js` 6 条覆盖「什么算纯顺着对方接」（附和与极短算、带自己判断与反问不算）、连续计数断一条归零、立场锚只认 ta 自己发的带判断词整句并丢掉太短太长与带标记的、正聊到哪个兴趣优先认上一条自己挂的 interestId 再退回词面命中与两种都认不出就不给、三段立场料各自只在有料时出现且没到门槛不提；`tests/selfwatch.test.js` 新增 2 条覆盖 `tone` 单独一栏记高水位不倒退且不塞进主动那本账的笔记、坏值丢掉、自省时说得出现象。全量 990/990 通过（2026-09-30），`node --check` 与 manifest JSON 解析通过，Hana App 静态校验 0 errors、1 条动态依赖常规 warning。注意：提示词那层只能降概率，真实效果要在聊天里实机验收。

本轮（0.7.447，喜好纪律）：`tests/prompt.test.js` 新增 4 条覆盖喜好纪律是常驻块且排在人格之前、把「不懂」和「不喜欢」分开并禁掉自我归因（「我说错了」「我串题了」「我不该提」）、护法按性格分岔（温柔多讲两句 / 随和说少提但不认错 / 性子强顶回去）、与查证和立场同层相邻且不带内部机制；`tests/analyze.test.js` 新增 2 条覆盖捏人草稿与补候选两个入口都要求池子里留一条护着自己喜好的行为（只改一个入口会出现新伙伴有、老伙伴点再来几条却没有的断层）。全量 982/982 通过（2026-09-30）。

本轮（0.7.446，GIF 动图读动作）：新增 `tests/gif-frames.test.js` 6 条，覆盖帧数不超上限时全取、超上限时沿时间轴均匀取样并保留首尾、静态图原样透传不改字节不改类型、多帧 GIF 抽成按时间顺序的 PNG、单帧 GIF 走静态路径但统一转 PNG、取帧上限生效、假 GIF 头与空数据直接报错不静默通过。全量 976/976 通过（2026-09-30），`node --check index.js` 通过，Hana App 静态校验 0 errors。


当前版本与测试状态以 `manifest.json` 为准；最新全量：**1058/1058 条通过**（2026-10-02，v0.7.459）。以下为 v0.7.449 的历史校验记录，`node --check index.js`、`lib/store.js`、`lib/topics.js` 通过。Hana App 静态校验 0 errors、1 条动态依赖无法由静态检查证明的常规 warning。

本轮（v0.7.443，移出 / 彻底删除）：`tests/store.test.js` 覆盖 purgePartner 删干净记忆目录、聊天文件、收藏、隐藏名单、lastPartnerId 与酒馆本地角色本体，并挡住非法 id；`tests/ui.test.js` 守住两层弹窗、两种方式的并列选择、确认窗里「Hana 本体不动 / 不能撤回 / 再请等于重新认识」三句关键文案，以及两层窗不叠着开；`tests/sticker-usage.test.js` 守住表情使用记录按伙伴剪除。全量 961/961 通过（2026-09-30）。

本轮（v0.7.442，酒馆角色世界书人格档案）：被邀请的角色能带上 `character_book` 里的基础信息 / 性格 / 二次解释 / 扮演准则，不再只剩一句简介。邀请包 schemaVersion 提到 2，茶话会收 `personaNotes`（最多 8 条 / 单条 2000 字 / 合计 6000 字），与卡面资料同样进不可信 JSON 隔离，伪造分隔符与 `</system>` 仍只是原文；旧邀请包没有该字段时静默为空。`tests/character-import.test.js` 新增 2 条（收口与坏结构、世界书档案进 persona 编译）；全量 959/959 通过（2026-09-30）。

本轮（v0.7.441，伙伴投喂回复边界）：伙伴回复过的消息不再保留为“没有要接话”的投喂候选；回复之后的新分享仍可成为候选。前端和模型上下文按回复与投喂的时间先后过滤旧账中“先回复、后投喂”的矛盾挂件；已经先递、之后才回复的记录仍保留。`tests/partner-feed.test.js` 覆盖单条多气泡回复和回复后新消息；`tests/ui.test.js`、`tests/prompt.test.js` 守住历史过滤。投喂专项 25/25、UI 专项 106/106、提示词专项 23/23、全量 957/957 通过（2026-09-30）。

本轮新增 `tests/character-import.test.js` 与 `tests/store.test.js` 回归：覆盖调用方身份、字段长度与来源卡校验、系统提示/世界书隔离、头像 PNG 元数据清理与尺寸限制、本地头像落盘、同源幂等更新、不同来源同名不合并、聊天/记忆/旧头像保留，以及初见问候不重复写入。补充验证导入资料以 JSON 字符串边界传入、伪造分隔符不能关闭边界、用户宏不被茶话会二次替换；角色卡初见问候仍在聊天记录中展示，但会从聊天上下文裁剪、等回音/等回音判定、拾光记追问、关系学习、记忆整理和主动回声选材中排除。跨 App service 只在 Hana 实机上确认权限批准与运行态握手，自动化使用假 service 上下文。

本轮（v0.7.432，伙伴排序与点击修复）：拖动排序或保存期间，列表轮询的旧回包不再覆盖刚调整的顺序；移除拖拽后遗留的点击拦截，避免下一次打开伙伴对话框的点击被吞。`tests/ui.test.js` 新增两种列表形态的回归断言；全量 941 条通过。

本轮（v0.7.430，拾光记情境按需取用）：保留每天首次情境注入；用户明确询问天气、今日安排、身体状况或近期共同经历时，绕过当日去重，只注入对应类别。设置关闭仍完全不读。新增 `tests/daybook.test.js` 回归。

本轮（v0.7.427，伙伴投喂）：ta 也能给你递小东西，只表达“我看到了”。新增 `lib/partner-feed.js`（纯逻辑）与 `runFeedTick`（每 5 分钟随主动巡检一起跑，不调模型）。硬约束三条：只挂在 ta 真的读过的那条上（`isFeedableTarget` 要求 `readAt`，落盘前再核一遍，前端也挡一道）、一天最多两次且两次隔九十分钟（`gateFeed`）、不做“该不该递”的模型判断。触发只认三个信号（冷处理 / 兴趣命中 / 你分享了东西），刻意不做定时投递。递什么从她自己的兴趣、爱好、调过的盘、话题本里挑（`feedAssetText` + `pickFeedAsset`），一个都没命中才按伙伴 id 稳定轮转兜底池；最近递过的不重复。上下文里对称写明「你让她知道你看到了，但没有要接话的意思」，避免被当成对方的回应。挂件只读、无右键菜单，轮询只补挂件不重画气泡；设置页按伙伴单独开关。

测试覆盖：投喂账本累加与合并、已读硬门槛（未读/撤回/动作消息/`readAt` 不可解析一律不挂）、一天上限与间隔、换日重置、ta 手上有活或睡着时不递、关键词不泛化、选品表无重复、同一条不重复投、连发多条往前回溯且不跨伙伴回复、冷处理信号的三小时下限、兴趣优先于分享、上下文注入方向正确且撤回后不再注入、前端未读/撤回不画与轮询补挂件、撤回时清掉挂件、三层巡检串行、设置开关默认开。

本轮经交叉审查补强六处：撤回消息不再显示挂件也不再进模型上下文（撤回时直接清 `partnerFeed`）；选品关键词去掉单字与泛化词（“甜/喝/糖/面/看/鱼”一律不再拖候选）；同一条消息不重复投；主动/等回音/投喂三层巡检串行执行，避免同一分钟两个动作叠着出站；连发多条用户消息时从末尾往前回溯候选；`readAt` 必须可解析才算读过。

本轮（v0.7.426，宽泛新闻搜索兜底）：记录显示“普通新闻？”在规划模型失败时没有产生查询词、也没发出必应请求。把“普通新闻／随便看看新闻”等宽泛请求识别为实时热榜场景，使规划模型失败时仍能拉取公开热榜，不会构造空泛必应查询；新增对应失败路径回归测试。专项 22 条、全量 903 条通过。

本轮（v0.7.422，八卦/热搜热榜兜底）：实测必应网页 RSS 对“最近有什么瓜/热搜”这类中文时效问题只回知乎、百度百科这类汇总页，搜到了也过不了日期与相关性过滤，于是新增 `lib/hot-board.js` 接百度热搜与今日头条热榜（两个源并行，一个挂掉不影响另一个）；规划模型空手或跑偏时用本地公开话题词再试一次；诊断日志补记实际搜索词。测试覆盖：榜单解析与去重、坏 JSON 静默降级、两个源全挂与全空的分型、热榜上下文来源性质、私人词不外发、泛词不直接外发而改用本地领域词。宿主 `ctx.network.fetch` 对新增域名的放行须在她重启后实机验收。

本轮（v0.7.421，跨领域时效搜索与续接修复）：搜索候选扩展到穿搭、美妆、数码、软件游戏、汽车、旅行、美食、价格、新品与版本变化；公开主题续接延长至 12 小时，续问链没有具体主题时不构造查询；增加查询主题相关性过滤，并把没生成查询词、未发请求、网络失败、结果跑题分别报告。新增真实 13:11 场景复现、跨领域查询、相关性与失败分型测试。专项 11 条、全量 885 条通过。

上一轮（v0.7.419，延迟后续搜上下文续接）：第一次把续搜上下文延长到两小时，但只取最近一条候选，连续纯“再找找”会把原主题挤掉；专项 9 条、全量 883 条通过。

上一轮（v0.7.418，补齐口语搜索请求与延迟追问）：识别“再找找/翻翻”等自然请求；“找到了吗”可借用不超过一小时内的前一条公开搜索话题继续查，只有前文明确是公开搜索候选才延长上下文。专项 8 条、全量 882 条通过。

上一轮（v0.7.417，减少搜索回复的过度保守）：有具体近期公开线索时，提示伙伴先轻松转述并点明来源/未证实状态，不因缺少官方确认默认拒答；无具体线索、泛汇总或严重未证实指控仍不编造、不扩散。专项 8 条、全量 882 条通过。

上一轮（v0.7.416，搜索结果闲聊口吻）：具体娱乐报道可用轻松吃瓜话术，但需区分报道、传言与确认事实；内容只能来自标题和摘要，不补剧情，泛汇总不硬编，严重指控/健康/私生活的无可靠来源传言不复述。聊天搜索专项 8 条、全量 882 条通过。

上一轮（v0.7.415，时效搜索相关性与闲聊追问）：搜索规划提示词要求将宽泛口语转成尽可能具体的近期公开主题，不臆造人物或事件；有临近公开话题时，短的相关疑问可继续触发搜索，普通应和不触发。新增追问回归测试。专项 8 条、全量 882 条通过。

上一轮（v0.7.414，回到底部按钮随输入行上移）：回到底部按钮移入输入行作为定位锚点，输入框增高时按钮随行上移，不再挤到发送按钮旁；增加 UI 回归断言。专项 101 条、全量 881 条通过。

上一轮（v0.7.412，复制图片发送状态对账）：图片消息加入稳定请求编号；成功回包丢失或延迟时，轮询按编号核对已落盘消息并清理待发送状态，重试不会重复创建已落盘消息。新增 UI 回归，全量 874 条通过。

本轮（v0.7.408，发布流程收束与包内文档修复）：发布预检新增契约一致性、发布副本语法、manifest 资源、ZIP 重复/路径穿越和机器证据清单检查；README 测试说明改为公开仓库链接，清理分享版源码内部注释。

本轮（v0.7.407，发布门禁修正与实时新消息右键菜单修复）：实时演出改为复用统一消息渲染入口，覆盖新伙伴气泡的右键投喂绑定；专项 UI 回归新增实时路径断言。

本轮（v0.7.405，发布边界与仓库安全修复）：公开仓库关闭 `DEV_TOOLS`，发布契约与打包排除规则对齐；全量 858 条通过，`node --check index.js` 通过。

上一轮（v0.7.404，投喂、排序、状态与交互体验收束）：完成消息投喂累加、伙伴拖动排序、状态徽章、右键消息菜单、背景与布局修复，并收紧主动消息和普通聊天表达；全量 858 条通过，`node --check index.js` 通过。

本轮（v0.7.390，等回音误判修复与主体性边界）：空 awaiting 不再显示为等回音；茶话会设计必读新增去用户中心化原则，伙伴保有自己的兴趣、节奏、判断和话题来源；新增对应回归测试。

上一轮（v0.7.389，状态徽章视觉层级）：参考 QQ 将状态叠到头像右下角，列表中把徽章移到名字下方并加入状态色与符号，聊天头部同步增强对比度；UI 回归通过。

上一轮（v0.7.388，伙伴自主状态徽章）：新增 `tests/badges.test.js`，覆盖常见状态白名单、自定义徽章归一化、隐藏标记剥离和真实运行状态只读兜底；UI 回归覆盖徽章不提供用户编辑入口。

上一轮（v0.7.385，精确引用）：引用只显示在输入框上方，不再把原文写入输入框；复制与引用使用右键点中的具体气泡；发送时将引用作为 metadata 进入伙伴上下文。全量 847 条通过，`node --check index.js` 通过。

上一轮（v0.7.384，右键事件兜底）：为投喂右键增加 contextmenu 与右键抬起双路径，并保留聊天流委托，避免 Hana webview 吞掉单一路径事件。全量 846 条通过，`node --check index.js` 通过。

上一轮（v0.7.383，右键消息菜单与收藏）：右键伙伴消息的上方保留投喂小物，下方加入复制、引用、收藏；收藏支持文字和语音快照，并在茶话会内部提供收藏查看页。新增收藏存储、上下文和 UI 回归。全量 846 条通过，专项 162 条通过，`node --check index.js` 通过。

上一轮（v0.7.382，向下跳转按钮主题适配）：复用背景主色自适应逻辑，让回到底部按钮同步调整底色、箭头与悬停色；无背景时保留原薄荷色回退。全量 845 条通过，`node --check index.js` 通过。

本轮（v0.7.381，背景图删除确认）：背景图删除改为确认小窗；共享背景即使被多个伙伴使用也允许删除，并同步清除受影响伙伴的背景引用。全量 845 条通过，`node --check index.js` 通过。

本轮（v0.7.380，统一伙伴展板）：移除 Hana 左侧伙伴功能面板注册与跨文档同步，所有挂载形态统一保留茶话会自己的伙伴展板；撤回 surfaceKind 识别实验。

上一轮（v0.7.378，主动消息不再强制承接上一轮）：最近场景只作为背景，普通闲聊、玩笑和已收住的话题直接进入新内容；未完情绪、照顾事项或约定仍允许自然回接。

上一轮（v0.7.377，整页默认折叠与入口隐藏）：整页继续按 `hana.lifecycle` 的 `page` 识别，并强制折叠应用内伙伴展板、隐藏收起/展开入口；嵌入形态仍保留应用内展板。

上一轮（v0.7.376，整页/嵌入形态识别修复）：实机证明 envelope 的 flexible/fixed 不能可靠代表整页/卡片。布局分流改为优先读取宿主 `hana.lifecycle` 的明确 `slot`：`page` 隐藏应用内伙伴展板，`card/widget/settings/function-panel` 保留可收展展板；envelope 只给旧宿主兜底。UI 回归增加 lifecycle page/card 与订阅契约。

上一轮（v0.7.375，伙伴列表移入 Hana 左侧栏）：整页主卡声明认证功能面板路由，左栏显示伙伴头像、末句预览与未读数；左栏点击与主聊天窗通过 App 全局存储双向同步；整页隐藏重复的应用内展板，独立窗口与嵌入位置继续保留原展板。`tests/ui.test.js` 新增 manifest、侧栏脚本、双向同步与分模式布局回归。

本轮（v0.7.369，消息投喂）：伙伴消息支持右键打开专用投喂栏，提供咖啡、茶、棒棒糖等吃喝小物；投喂作为消息 metadata 保存并进入后续上下文，不生成聊天气泡、不触发即时回复。专项 112 条、全量 842 条通过，语法检查通过。

上一轮（v0.7.368，主动消息表达优化）：主动消息提示词要求具体细节带出伙伴自己的感受、偏好、判断或玩笑，减少观察报告式尬聊；新增对应提示词契约断言。全量 841 条通过，语法检查通过。

上一轮（v0.7.366，语音体验修复）：新增 WAV/MP3 时长解析测试；UI 回归覆盖语音背景色悬停、持久化时长、未播放红点与播放状态落盘。全量 841 条通过，语法检查通过。

本轮（v0.7.365，恢复账枚举失败守门）：伙伴 adaptation 目录枚举失败会返回失败并保留 pending invalidation，下一次启动继续重试，不再把 I/O/权限错误误当作“零伙伴”。新增 1 条自动测试，全量 840 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.364，终审恢复护栏）：user-wide 跨伙伴回退增加持久恢复账与启动重试，runtime habit 增加 active guide 二次校验；显式 guide ID 按 scope 命名并保护旧撞 ID 数据；observationLocks 独立于 guide 容量长期保留；敏感表情许可改向同时校验用户原话与预览文义；语音配额测试固定检查日期。新增 1 条自动测试，全量 839 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.363，observed 弱观察 + user-wide 回退修复）：只从用户主动发送的两类安全、可解释模式建立低置信度 observed guide，要求至少 3 条证据且跨 3 个生活日；明确声明永远胜出，敏感许可永不观察，被纠错/忘掉后不复活。另补 user-wide guide 失效后的跨伙伴 exception/habit 回退。新增 5 条自动测试，全量 838 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.362，相处理解查看/忘掉/对话式纠错）：新增脱敏只读列表、按 guide revoke、自然语言协商建议、前后预览与确认应用；关系账引入 revision，服务端短存机器 proposal，旧建议不可覆盖新账；确认失败时前端保留聊天、预览和按钮；user-wide 与 relationship 分账操作，表情许可 subject 不可扩张。新增 6 条自动测试，全量 833 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.361，迁移审查修复）：补测旧 `permission` fact；收紧 meaning-only 迁移边界，防止普通兴趣因“分析”等泛词误迁；所有 proactive/awaiting 入口增加迁移完成硬屏障，迁移失败会阻止自主发送并在下轮重试；隐藏伙伴也纳入迁移。新增 1 条自动测试，全量 827 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.360，旧 facts 幂等迁移）：新增纯函数迁移器与每伙伴 migration 水位；仅迁移可追溯到未撤回用户消息的明确互动 preference/boundary，同源 guide 去重；可确定的语音/睡眠/主动/回复风格 claim 本地生成，表情许可必须解析稳定 subject；无来源、伙伴推测、普通兴趣和模糊许可不迁移；保留原事实时间。新增 4 条自动测试，全量 826 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.359，临门新话题暂存）：proactive 已选出 readyTopic 后若在全局锁内二次 gate 被拦，会用 stageIntent 将该正式话题暂存；旧 pending intent 仍原样归还，模型失败及无稳定 topicId 的 hobby/场景不误暂存。扩展集成回归，全量 822 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.358，全局自主出站竞态）：proactive/awaiting 在伙伴级 lane 外再共用一条全局自主出站 lane；进入 lane 后重新读取最新 gate，模型生成、真实发送与 noteSent 记账保持在同一临界区，避免跨伙伴或两套 tick 并发突破全局间隔/日上限。扩展集成回归，全量 822 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.357，awaiting 硬门与暂存契约）：awaiting 在发送前完整经过主动开关、伙伴/全局日上限、全局间隔、静默与关系 deny；成功发出戳或文字后调用统一 noteSent 更新伙伴及全局配额，[等] 不计数。proactive 被 gate 拦截时显式写回 takeIntent 返回的活跃暂存意图。新增 1 条集成回归，全量 822 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.356，proactive/awaiting 与首个文本观察器）：主动联系和等回音共用 `proactive.frequency` resolver，none 阻断、more/less 单调调整软间隔，硬设置/静默/日上限/全局间隔保持优先；两条链传 life-day 上下文。`reply.advice-style` 只有结果消息真实出现“先陪伴后建议”才提交 exception。新增 4 条自动测试，全量 821 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.355，短反馈形态补全）：feedback 预筛补齐省略宾语的独立短句“停/别发了/不用了/再来/继续/这不对”等，并用长度、整句锚定与反例保证长句中的普通“继续”不被误当作反馈。专项与全量 817 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.354，feedback/habit 交叉审查修复）：补齐“停一下/再来一次/不是这样”等短反馈入口；负反馈改为持续锁定，普通正反馈不可解锁，只有负反馈之后建立的新 explicit preference 才能重新开始沉淀；consolidation 校验 guide 元数据，仅 explicit preference 或 confidence≥0.8 的 observed preference 可形成 habit，permission/boundary 被排除。新增 3 条失败基线与回归，全量 817 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.353，feedback 与 habit 沉淀）：reconciler 可把后续明确喜欢/继续/叫停/纠正归因到 24 小时内具体 committed exception，同一消息不可重复占用，沉默不推断；按跨日破例与独立正反馈形成 emerging/settled，负反馈立即 reverted 并阻断同类后续破例；语音、睡眠与具体表情策略已接入反馈和习惯状态。专项回归 233 条、全量 814 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.352，统一 exception 落账）：store 增加同步幂等的 update/commit/finalize 入口；睡眠仅 exception+committed、语音仅 exception+ready、表情包仅关系 specific permission 真正发送成功后落账；恢复重放沿用稳定键去重；修正 resolveSleepPolicy 的 decision 对象未传给 planReply。专项回归 168 条、全量 808 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.351，交叉审查补严）：新增 deny claim 独立优先规则与 claim 内容指纹；表情包和 TTS 异步复核补齐 current-turn/life-day 上下文；同 guide id 内改口或移除 voice claim 会让旧 TTS 任务失效。专项 132 条、全量 806 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

本轮（v0.7.350，关系可塑性事务与撤回修复）：睡眠 read/reply-ready 改为交换律事务，覆盖重复事件、later-notice、失败重试与恢复；撤回同时失效伙伴级/user-wide guide、相关排期及 TTS generation token；临时 guide 由系统补 current-turn/life-day，坏 until 降级为当前生活日。全量 804 条通过；Hana v2 静态校验 0 error、1 条动态资源不可静态证明 warning。

上一轮（v0.7.349，关系可塑性 canonical 运行时修复）：新增统一 canonical 测试工厂与 claim 级决胜查询；语音 deny/more/less、真实关系形状和表情包稳定 subject 均改用正式持久化协议；补 store 往返过滤。专项 111 条通过。

本轮（v0.7.348，关系可塑性阶段 C · 表情包许可适配）：伙伴选图接入 `sticker.permission` 的具体 allow/deny；适配器只过滤本轮选图，不改图库；快照白名单、本地 veto 与最近发送去重继续生效；用户主动发送不受影响；新增 2 条测试，全量 796 条通过。

本轮（v0.7.347，关系可塑性阶段 C · 语音适配）：新增 `resolveVoicePolicy()` 与 normal/exception/hard 三层决策；关系只增加软额度和缩短冷却，不突破 hardMax；明确 voice deny 硬拦截；语音 runtime 延后到音频写盘、消息 ready 后提交，合成失败保持原账本；新增 3 条策略测试，全量 794 条通过。

本轮（v0.7.346，关系可塑性阶段 C · 睡眠提交点收拢）：normal/exception 的 wakeCount 统一移到真实 readAt 提交点；实时 `readTimer` 与排期 `deliverScheduledReply()` 共用提交逻辑；exception 回复落库后完成 woken → committed，失败重试保留 wake 元数据；全量 791 条通过。

本轮（v0.7.345，关系可塑性阶段 C · 睡眠策略接入排期）：`planReply()` 接收 `wakeDecision`；deferred 回复不进入实时回合，pending 保存策略并在恢复/到点时单向转为 `later-notice`；normal/exception dozing 保留现有实时路径；新增回复与 UI 契约测试，全量 791 条通过。

本轮（v0.7.344，关系可塑性阶段 C · 睡眠/回复纯逻辑适配器）：新增 `sleepWakeDecision()`、`resolveSleepPolicy()`、`resolveDeferredWake()`、`commitWakeOutcome()` 与 `finalizeWakeReply()`；覆盖 baseline/exception/deferred、关系单调性、硬上限、later-notice 单向转换及两阶段提交；全量 790 条通过。当前尚未替换现有 `planReply()` 与 index 执行链。

本轮（v0.7.343，关系可塑性阶段 B · 通用 adaptation block）：将归一化的相处理解接入普通回复、主动联系/夜间留言、等回音和小动作文案；不注入来源消息、claims、关系分数或概率；新增 5 条提示词断链测试，全量 786 条通过。当前尚未接入睡眠、语音或表情包执行链。

本轮（v0.7.342，关系可塑性阶段 A · 明确偏好结构化 reconciler）：候选消息调用一次 20 秒超时的 utility 模型，严格解析 `add/update/revoke/temporary/none`；本地校验来源、user-wide 普遍范围、claims 白名单和 supersede/revoke，模型失败、空回包与脏 JSON 都不挡正常聊天；新增 4 条协议测试，全量 781 条通过。当前尚未接入睡眠、语音或表情包执行链。

本轮（v0.7.341，关系可塑性阶段 A · 明确偏好候选预筛）：新增本地 `adaptationCandidate()`，覆盖第一人称偏好、指令、临时要求、行为落点与提问排除；普通聊天不触发额外模型调用，`/turns` 在用户消息落盘后记录候选及真实 sourceMessageId；专项 55 条、全量 777 条通过。当前尚未接入结构化 reconciler、睡眠、语音或表情包执行链。

本轮（v0.7.340，关系可塑性阶段 A · adaptation 持久化）：新增全局 `user-adaptation.json` 与伙伴级 `partners/<agentId>/adaptation.json`，覆盖重启恢复、全局/伙伴隔离、来源撤回后的习惯回退与脏数据归一；`tests/store.test.js` 新增 2 条存储回归。前一节点的 `adaptation/plasticity` 专项 14 条继续通过。当前尚未接入真实消息入口、睡眠、语音或表情包执行链。

本轮（v0.7.339，关系可塑性阶段 A · 纯逻辑核心）：新增 `tests/adaptation.test.js` 与 `tests/plasticity.test.js`，覆盖 guide 归一、明确/观察来源、有效期、作用域、claim 白名单、冲突覆盖、撤回、通用提示词脱敏、hard 边界、关系单调因子、疲劳衰减、明确拒绝、破例幂等记录；专项 14 条通过。当前尚未接入真实消息入口、睡眠、语音或表情包执行链。

本轮（v0.7.336–338，朗读模型配置重做、UI 收口与音色回归修复）：分享版不再有「从 Hana 已配置模型中选择」这条路（Hanako 没有朗读模型，拉不到东西），朗读侧只留用户自己保存的多条自定义模型：新建时可套 MiniMax / MiMo / OpenAI 兼容模板，保存后可切换、编辑、删除，当前使用项独立记住。旧数据里带 Key 的 MiniMax / MiMo 固定档位自动迁成 `custom-*` 普通条目，空壳和 hana-* 条目丢弃；更早的单条全局朗读配置只在从没存过多条结构时救一次，用户删光条目后不会把旧配置复活。UI 上：password 输入框纳入统一字段样式、API Key 旁加「已保存 / 还没填」状态胶囊、删除与模板按钮改用设置页已有的轻量款式。音色修复：合成前归一化会把 voiceId 洗掉，导致所有伙伴都发同一条默认音色（MiniMax 表首位是「可靠高管」，听上去是男声）；现在音色跟着配置一起传下去，旧档位 id 存的音色也会自动跟到迁移后的条目上，没给某条模型选过音色时会在伙伴页说明白。`tests/voice.test.js` 覆盖迁移、选中项、音色透传与目录回退；`tests/store.test.js` 覆盖音色键名迁移；`tests/ui.test.js` 同步朗读设置的新交互断言。

本轮（v0.7.307，伙伴展板自适应布局）：独立茶话会主页默认展开左侧伙伴列表，嵌入其他位置继续沿用原有收起/展开方式；两种布局分别记忆状态。`tests/ui.test.js` 补充宿主挂载环境、分模式状态键和主页不自动收起的静态回归检查。

本轮修订（v0.7.306，生活节拍设置与分析查看）：设置页新增生活节拍开关、表达习惯与主动关心分项控制、分析内容查看窗和重新开始积累入口；伙伴可见摘要与用户可见详情分开。

本轮修订（v0.7.305，生活节拍统计护栏）：新增跨日期样本、单日限额、离散峰值和全局提醒去重回归；全量 724 条通过。

本轮（v0.7.304，生活节拍后台分析初版）：新增 `tests/user-rhythm.test.js`，覆盖数据不足降级、个人常用时段、工作日分组、表达习惯弱信号与早间偏离检测；生活节拍摘要已接入普通回复和主动消息提示词，明确禁止把统计说出口。

本轮（v0.7.303，图片发送成功后清理待发送状态）：修正图片发送成功后待发送预览残留；新增 UI 静态回归断言，守住不误删发送期间新换图片。

本轮（v0.7.302，剪贴板图片预发送）：聊天输入框支持直接粘贴剪贴板图片，复用待发送图片预览与现有发送链路；新增 UI 静态回归断言。

本轮（v0.7.301，弹窗关闭入口统一）：设置页和调整回复弹窗删除与右上角叉重复的底部关闭/取消按钮，保留真正的确认与提交动作；UI 静态回归断言同步更新。

本轮（v0.7.300，生活记录查看点击修复）：修正查看按钮引用嵌套作用域工具函数导致点击无响应的问题；专项回归 136 条通过。

上一轮（v0.7.299，生活记录查看）：设置页新增已收集生活记录查看窗，按生活日和伙伴分组展示，并支持二次确认后单条删除；新增存储与界面回归测试。

本轮（v0.7.298，安全与可靠性护栏）：新增伙伴 ID 严格拒绝与原型键防护、durable JSON 读写及坏图库隔离、模型 deadline/cancel、搜索材料隔离、输入长度与设置字段边界测试；修正 workfeed 路径留存、diagnostics 轮转计数和 avatar WebP 检测。

本轮（v0.7.297，设置来源名称澄清）：设置页将「今日情境」改为「拾光记今日情境」，将「电脑端生活联动」改为「Hana 主对话近况」，并补来源文案与 UI 断言。

本轮（v0.7.296，跨模块状态编排修复）：补测 Workfeed 关闭后的注入边界、跨天日账入口、硬撤回关系信号、否定句关系识别、用户事实来源和后来兴趣证据；并修复主动/等回音出站仲裁与动作发送遗漏 await。

本轮（v0.7.295，主动消息回声边界修复）：补测并修复用户回复、主动消息和动作消息对旧困意回声的截断；最近场景回声与睡醒回声仍保持优先级。

上一轮（v0.7.294，主动消息场景回声）：新增最近一轮面对面聊天的场景回声，覆盖普通场景接续、睡醒回声优先与主动消息边界。

上一轮（v0.7.293，茶话会表情包来源账本修复）：补充 Hana 标准 dataDir 路径契约测试，并覆盖并发写入保护与时间字段校验。

上一轮（v0.7.292，茶话会表情包来源记录）：`tests/sticker-usage.test.js` 新增 3 条，覆盖发送记录写入、坏记录静默降级和数量上限；茶话会实际发出的表情包写入自己的 `v2/sticker-usage.json`，不回写表情包插件账本。

上一轮（v0.7.291，聊天流回到底部）：`tests/ui.test.js` 新增聊天流滚动回归，覆盖打开/切换伙伴落到底部、上翻后显示回底按钮、点击回底，以及增量消息不打断旧记录阅读。

上一轮（v0.7.290，兴趣池改成取景形状）：`tests/growth.test.js` 再补 1 条——池子里每条都得留空位（「某个器物」「某一类 X」），退化成可抄的成品清单就红；同时守住两档合起来 ≥ 30 条。

上一轮（v0.7.289，原生兴趣分出层次）：`tests/growth.test.js` 再补 3 条——一组里要有「能撑起聊天的爱好 + 小细节癣好」、俗雅都收、反例不再是「不要写宏大领域」；抽样两档各出半（不再清一色微物）；两档池子不重叠。字段名「具体对象」改「落点」后，`tests/compose.test.js` 与 `tests/growth.test.js` 相应断言同步。

上一轮（v0.7.288，兴趣不再撞衫 + 话题抽取只算她说的事）：`tests/growth.test.js` 补 4 条——尺度示例只给一小把且不许照用（含反向断言：提示词里不得再出现旧版那句「可以从这些对象里挑」）、抽样不放回且条数受控、别家占过的落点会进提示词且被门禁拦下、撞车判定认近似说法不认不相干；`tests/topics.test.js` 补 1 条——抽取提示词只认用户那几行、伙伴自己抛的不许抽。

上一轮（v0.7.287，主动消息不再把来处写在脸上）改动的测试：`tests/compose.test.js` 的「主动消息先确认来由链」补 4 条断言——守住「来处是心里的筛子，不在嘴上」「来处要像你本来就带着它」「不必每条末尾都加邀请」，并加一条反向断言：提示词里不得再出现「突然想到」这类前摇例句。

上一轮（v0.7.282，发布前交叉审查整改）新增/改动的测试：`tests/store-durability.test.js` 新增「读坏账本会留一条提示给界面，取走即空」并守住新建账本不带旧提示；`tests/ui.test.js` 的「设置页分类」断言改成新结构，并守住 `role="tablist"` 与 `aria-selected`（分类无障碍语义）。

## 怎么跑

```sh
node --test tests/actions.test.js tests/adaptation-correction.test.js tests/adaptation.test.js tests/analyze.test.js tests/avatar.test.js tests/awaiting.test.js tests/background-adaptive.test.js tests/background.test.js tests/badges.test.js tests/chat-search.test.js tests/clock.test.js tests/compose.test.js tests/daybook.test.js tests/days.test.js tests/fact-migration.test.js tests/facts.test.js tests/feed.test.js tests/growth.test.js tests/host-user.test.js tests/interest-exploration.test.js tests/knowing.test.js tests/load.test.js tests/memory.test.js tests/model.test.js tests/notify.test.js tests/observed.test.js tests/palette.test.js tests/partner-id.test.js tests/pass.test.js tests/persona-review.test.js tests/persona-standard.test.js tests/persona.test.js tests/phone.test.js tests/plasticity.test.js tests/poke.test.js tests/proactive.test.js tests/prompt.test.js tests/recall.test.js tests/recognition.test.js tests/relationship.test.js tests/reply.test.js tests/rhythm.test.js tests/selfwatch.test.js tests/sleep.test.js tests/split.test.js tests/sticker-library.test.js tests/sticker-usage.test.js tests/stickers.test.js tests/store-durability.test.js tests/store.test.js tests/summarize.test.js tests/topic-search.test.js tests/topics.test.js tests/ui.test.js tests/user-rhythm.test.js tests/vision.test.js tests/voice.test.js tests/workfeed.test.js
```

零额外依赖，用 Node 内置 `node:test`。

本轮（v0.7.454）：新增「伙伴的戳一戳也能删」。`tests/store.test.js` 新增两条：删戳只动聊天账（日账与摘要不许被一条戳牵连、已读水位退回前一条）、删戳不认非动作消息也不要求是最后一条；`tests/ui.test.js` 新增 5 处断言守住动作行的删除入口与确认窗文案（戳只给删除、不给重新生成与调整）。全量 1010/1010 通过（2026-10-01）。提醒：动作消息不进记忆是设计约束不是巧合，改这里时先把这句话读一遍。

本轮（v0.7.453）：收「戳得动、话却还挂着未读」。上一版只让主动通道绕开“她有未读的话”，却没安排谁去读，那条未读就永远悬着；而戳与回戳走动作通道，不认未读，于是矛盾。`tests/ui.test.js` 两处断言改成守新契约：伙伴上场时 `hasUnseenUserMessage(store.getThread(agentId).messages)` 要先读掉并留 `proactive.saw-user` 记录。全量 1008/1008 通过（2026-10-01）。提醒：“读到”与“要不要开口”是两件事，别又棩成一件事。

本轮（v0.7.452）：收「删除时弹出 Internal Server Error」。删除请求此前跑在伙伴的记忆重建队列里，而上一次删除刚排了一个带模型调用的重建（几十秒），后一次删除就排在它后面等超时，界面上只剩一句英文。改动：删除后的重建延后 45 秒并合并（抽到 `lib/rebuild-queue.js`，新增 `tests/rebuild-queue.test.js` 4 条：连续删除只留一个排期、日子合并、不同伙伴互不影响、取消不跑）；删除路由加耗时与异常记录；App 路由加统一 `app.onError` 把未接住的异常写进账本。全量 1008/1008 通过（2026-10-01）。提醒：这次靠日志时间线推断根因（服务端删除已落盘、响应没等到），已有耗时观测，复现时能直接看到等待了多久。

本轮（v0.7.451）：收「删掉回复后账没走完」——撤回窗口、未读出口、主动让路三处。`tests/recall.test.js` 新增「没被看过的消息不受两分钟窗口约束：删完回复退回未读后随时能撤」「看过的消息过了两分钟还是不能撤」「没被看过的消息时间戳坏了也能收回」；`tests/proactive.test.js` 新增「她的话还没被看到时，主动开场要让路」「看过了、或者这轮已经接过了，就不挡主动开场」；`tests/ui.test.js` 两处断言换成守新契约（确认窗文案改成「回到未读、正常节奏里重新看到」，删除路由不得当场调用 `composeReply`/`deliverScheduledReply`，改为要求 `scheduleReply` 排期与 `hasUnseenUserMessage` 门禁）。全量 1004/1004 通过（2026-10-01）。提示：主动让路与重排节奏属行为层，得在聊天里实机验收。

本轮（v0.7.450）：收「主动开口顶着人设套通用口吻」和「谁在等谁说反」两条实机问题。新增用例：`tests/compose.test.js` 的「已读未回三个窗口共用一份口径」——`readFollowupStage` 三档切分、时间拿不准（null/undefined）归“看很久”、姿态/手法菜单/末尾收口三处必须同调（看过很久不得再摆「打趣找人」「拿自己开涮」「嘴硬收场」，也不得再写「先把『她看了还没回』这件事接住」）；同名旧用例改两条断言——示例里的现成句子（「你人嘞」「溜哪儿去了嘛」）不得再进提示词，改为要求写明「不许照抄」；刚看到/看过很久两个窗口都不得再出现整套催场手法。`tests/prompt.test.js` 新增「标签主动消息」——主动那条带［这条是你主动找她说的，她没先开口］，她的回话和普通回复都不带。全量 999/999 通过（2026-10-01）。提醒：提示词只能压低概率，实际口吻得在聊天里实机验收。

本轮（v0.7.439）：修复窄页面里发送图片超出气泡框的问题，消息图片最大宽度改为受气泡可用宽度限制；`tests/ui.test.js` 增加对应 CSS 契约断言。UI 专项 106/106、全量 956/956 通过（2026-09-30）。

（注意：`node --test tests/` 在这个 Node 版本上会把目录当单个用例跑失败，要显式列文件。）

本轮（v0.7.433）给常驻「立场纪律」补用例，写在 `tests/prompt.test.js`：覆盖纪律不分性格、不分有没有写过人设都对每个伙伴生效；纪律要摆在人格前面不被盖过；禁姿态句（「我认」「算我的」「对不起呀」），授权直讲自己的版本且有底气，禁「可能是我不对」这类两头堵，禁因对方不高兴就改口，以及「把事实弄对才是目的，顶回去本身不是」。单测跑 `node --test tests/prompt.test.js`。2026-09-29 全量 `node --test <tests/*.test.js>` 944/944 通过；Hana App 静态校验 0 error、1 条动态依赖提醒。注意：这一层只能降低概率，纪律对模型行为的实际影响要在聊天里实机验收，提示词保证不了行为归零。

本轮（v0.7.413）新增 `tests/chat-search.test.js`：聊天时效触发与普通闲聊零额外调用、临近公开话题指代、私人哀伤不触发和私人词不外发、中文日期新鲜度及前五条过期后补查、网络失败不冒充核实、当轮提示词隔离，以及同步/异步共用接线。原有 `tests/topic-search.test.js` 验证必应 RSS 地址与搜索边界。2026-09-26 全量 `node --test <tests/*.test.js>` 881/881 通过；本机 Node fetch 必应 RSS 真实查询拿到 10 条近期结果，提示词保留 3 条完整来源；Hana App 静态校验 0 error、1 条动态依赖提醒。宿主 `ctx.network.fetch` 须在用户自行重启后实机验收。

本轮新增 `tests/interest-exploration.test.js` 与搜索边界用例：覆盖好奇心阈值、长期兴趣轮换、60 条角度索引、发现过期/已分享、夜间例外不消耗发现、用户对话不进入搜索计划、外发查询拦截及 8 秒/1 MiB 网络边界。既有背景自适应与旧回包隔离测试继续保留。

背景切换固定回归场景：伙伴甲 → 伙伴乙 → 伙伴甲；第二次同步发生在背景图片仍下载中时，最终仍必须自动铺回伙伴甲的那张背景。`tests/ui.test.js` 会检查“只有 `chatBgUrl` 已存在才允许同图短路”，防止重复同步把唯一下载请求判过期后页面停在默认背景。

本轮新增 `tests/workfeed.test.js`：覆盖 Hana 会话事件清洗、伙伴映射、茶话会回流过滤、生活日、去重、按伙伴取数与电脑端背景提示词边界。

本轮新增原生兴趣测试：覆盖 InterestV2 具体字段、原生兴趣与共同兴趣分层、旧 born 数据识别与替换、宏大兴趣/缺字段/用户称呼的生成结果拦截，以及主动消息消费具体兴趣包。

回复修整、异步回复显形、切窗竞态、重启恢复、连续发送、回复覆盖边界、发送失败保留输入、草稿代次护栏、认识 ta 场景候选与窄页面气泡布局改动后全量：620 条通过（2026-09-18）。本轮新增具体场景/反应候选和假设场景标记检查，并完成消息生命周期稳定化。

认识 ta 的候选质检、限选与语料口子（2026-09-19）：`tests/recognition.test.js` 覆盖反向题里混入的推荐做法被筛掉、正向题不受影响、同场景写成一条、一条题最多两个选项、场景方向一个场景最多两条且总数封顶六条、打字题贴进来的原话渲染成语料样本；`tests/store.test.js` 守住「认识伙伴」那条模型设置重启不丢；`tests/ui.test.js` 守住设置页那一格与前端的限选提示。全量 637 条通过（2026-09-19）。

认识进度分两种人（2026-09-19，`v0.7.260`）：没答完的继续留断点、接着答；已经认识好一遍的档案不再留断点（重开从第一题看起），回看时改的内容照存，但不打草稿标记、不把完成态打回「没做完」、完成时间也不重刷。`tests/recognition.test.js` 三条测试守着这条分界。

「重新认识 ta」是重做不是回看（2026-09-19，`v0.7.261`）：设置页点它先弹确认，确认后走 `POST /recognition/:agentId/restart` 把旧回答清掉，再从第一题问起。`tests/ui.test.js` 守住确认弹窗、清空路由和入口文案。

交叉审查补的防护（2026-09-19，`v0.7.262`）：空白草稿不落盘（`applyRecognitionDraft` 遇空白直接返回原样）、`everCompleted` 让重做后仍算入住、重做前掐掉在防抖里等的草稿、草稿在飞标记只清自己那一笔、answer 路由透传 `origin`、反向题候选不再强制关键词。`tests/recognition.test.js` 四条新测试守着前两项与候选筛选，`tests/ui.test.js` 一条守着前端那几道。全量 643 条通过（2026-09-19）。

材料减重（2026-09-19，`v0.7.263`）：同场景只留一条（`MAX_SCENARIOS_PER_SCENE` = 1）、场景上限 50 字与反应上限 70 字、标签声明收到段首一次。`tests/recognition.test.js` 守着同场景一条、总数六条与两个长度上限，`tests/ui.test.js` 守着界面上的替换提示和说明文案。实测材料 4874 → 2457 字。全量 644 条通过（2026-09-19）。

假已读、已读未回反应库与手打文字表情（2026-09-19，`v0.7.265`）：`tests/store.test.js` 守着已读水位（前端指定读到哪条、只往前挪、认不出的 id 不写账、撤回读到的那条时水位与时刻一起回退）；`tests/proactive.test.js` 守着「已读带上看了多久」，未读没有时长、时间读不出来就给空；`tests/compose.test.js` 守着反应库（打趣优先、不把沉默当拒绝的红线、按看到多久分档：刚看到不催／看一阵可打趣／看很久就放下）和手打图名不被当成外文残片；`tests/prompt.test.js` 守着风格里的手打文字表情；`tests/ui.test.js` 守着 `GET /thread` 不再盖章已读、显式上报口子存在、前端只在页面可见加窗口有焦点时上报。全量 670 条通过（2026-09-19）。

面对面「一句一句发」的演出回来了（2026-09-19，`v0.7.271`）：后端一直在算真人节奏（`readAfterMs` 多久看到、`items[].gapMs` 每条之间隔多久），但前端在后来重做聊天窗时把消费 `turnId` 那一整段丢了，只剩 5 秒轮询兜底，回复常常像整条一次刷上来。现在恢复 `playLiveTurn`：等 ta 看到（未读小字收起）→ 正在输入三点 → 按 `gapMs` 一条条蹦；演出期间轮询见着这一轮就绕开（`liveSkipRepliedTo` 按 `repliedTo` 认），演完把 `replyMessageId` 记进 `seenIds` 不重复绘制，她切走或换伙伴立刻停。`tests/ui.test.js` 那条旧断言（发送请求不许独自轮询回复）改成新契约：正在演的那轮归演出，其余归轮询。全量 678 条通过（2026-09-19）。

认识 ta 的纯逻辑覆盖在 `tests/recognition.test.js`：多选、自由修正、原话保留、回头修改、完成判定、坏数据归一化，以及具体场景/反应候选的结构约束、假设场景标记、JSON 解析和空回包降级。

## 覆盖范围（556 条，2026-09-17 全量通过）

聊天流时间刻度由 `tests/ui.test.js` 守住：相邻对话消息间隔达到 10 分钟才显示分隔时间，跨生活日使用日期，动作消息不制造额外时间刻度；气泡悬停时间仍保留。

| 文件 | 覆盖 |
|---|---|
| `tests/compose.test.js` | 回复清洗：去掉模型偶尔套上的 HTML 段落壳、Markdown 围栏、常见前缀和完整 JSON 外壳；`[不回]` 整条标记识别；主动消息带入伙伴兴趣且不传未经验证的解释；睡醒回声优先于普通话题，共享窗外情境只作可选背景 |
| `tests/facts.test.js` | 重要事实提取提示词、引用边界、来源校验、来源时间覆盖模型时间、重复事实去重与记忆块展示 |
| `tests/rebuild-queue.test.js` | 删除后的记忆重建排程：同一伙伴连着删只留一个定时器、延后合并日子、不同伙伴互不影响、取消后不跑、排期时会报等待时长 |
| `tests/recall.test.js` | 撤回窗口只管已经被对方看到的话（看过的超时拦下并留占位，没看过的随时能无痕收回、不挂倒计时）；用户消息限制、处理中/已回复保护、已读与未读分流、排期回复取消判定 |
| `tests/ui.test.js`（聊天头部） | 聊天现场不显示人格读取来源等内部开发状态；面对面那轮由 `playLiveTurn` 按后端给的节奏演出（等 ta 看到 → 未读收起 → 正在输入 → 按 `items[].gapMs` 一条条蹦），剩下的交给轮询补画，两边不重复画同一条；连续发送不被回复动画占住发送门，旧窗口请求只释放内部锁而不改新窗口按钮 | 
| `tests/split.test.js` | 分条器：按标点切、末尾无标点残句不丢、成对符号内部不断、代码块整体不拆、句末逗号句号被吃掉而问号叹号保留、连续标点不拆散、一字回复可单独成条、条数上限并尾巴、空输入 |
| `tests/rhythm.test.js` | 节奏器：对数时长随字数递增且增速递减、showAfterMs 严格递增、第一条不短于打字下限、未读时长落在区间、忙时更久、speed 缩放、空气泡列表 |
| `tests/model.test.js` | 模型层纯函数：NDJSON 只取正文而丢掉思考通道、done 回落 assistant 内容、error 被记录、provider 报错后丢弃后续协议片段、报错前完整英文保留、普通 error 不触发截断、非 JSON 行当纯文本、选模型优先 current 且缺字段返回 null |
| `tests/vision.test.js` | 识图配置归一、伙伴覆盖全局、未验证模型不放行、图片真实文件头与严格 base64 校验、模型目录图片能力判断 |
| `tests/days.test.js` | 一天从凌晨四点切：三点半算前一天、四点整新的一天、通宵一场不被劈成两天、跨月跨年、起点小时可覆盖、非法输入不炸、日子标签与日差 |
| `tests/memory.test.js` | 分层记忆纯逻辑：近处按条数与字数双上限切且至少留一条、热身后约每 10 轮整理、溢出批次从最老开始、动作/硬撤回不进入记忆整理、重要事实与关系档案分层、日账取名新在后、空白条目被丢掉、摘要取材与条目字段、摘要按当前伙伴实名标记避免第一人称串位 |
| `tests/store.test.js` | 落盘：消息追加重启不丢、持久化序号跨 500 条截断仍能过滤水位、摘要批次幂等、清聊天不清记忆、重要事实按真实来源和时间去重、未读只数伙伴发的且读完归零、新消息重新计未读、压过的消息不再待压、同日账是覆盖、日账可单天删、档案可写可读、摘要段数有上限、分伙伴设置互不干扰且有默认、动作文案与作息能存、全局静默与总闸默认、聊天窗头像开关默认关且重启不丢、伙伴移出/放回幂等且只隐藏不删数据、伙伴 id 带奇怪字符不会写到别处、关系账／性格／爱好各存一本重启还在、**自动那份与ta的来历各躺一格（没判过就是空、不详就不编）**、**起跑线单独躺一格（跟账本分开，撤了不影响真实聊出来的）**、knowing 文件坏了当没调过、清聊天不清这一层 |
| `tests/topic-search.test.js` | 时效话题搜索：必应 RSS 地址编码、标题/摘要解析与清洗、外部素材不确定性提示、网络不可用/HTTP 失败/空结果静默降级 |
| `tests/topics.test.js` | 话题本：刚提到的不马上够格、发酵期不规律且心事比八卦久、到点才进 ready、同一件事只留一条且保留最早时间、标题比对能认同一件但不把"猫"和"猫粮"混成一件、说过进冷却、冷却过后可以再提而聊过的面（四次）用光才放下、擞太久被清、超量先丢没用的、等得越久越靠前、空本子不出事；模型输出：抠 JSON（含代码块）、空/垃圾输入返回空、非法 kind 归 other、最多三条、无标题条目丢掉；**常青/时效标记与搜索词，旧话题读取归一**；**返回形状钉住**；**角度账本：聊过的面记在话题上（最近在前）、同一个面换个说法不重复记、只留最近四条、没带角度就不编一个、自省说缺由头时冷却过半能提前放回来、老话题本没有那一栏也不炸** |
| `tests/selfwatch.test.js` | 自省小本子（内部，用户看不见）：原因归类与说人话、一笔一笔往上加且动作认不出来当 skip、窗口内计数并挑出最常出问题的那一类（other/off 不算）、一类不够三次就什么都不改、太勤/挨太近就把落点往后挪、总撞睡觉就避开睡觉那段、总缺由头就把冷却过半的话题放回来、记录不够不跑且隔够一天才跑、小结写回去时清空待看那一叠且修正只留这一轮、小结只留最近五条、模型没写出来也照常往前走、自省提示词带上次数与人话且不露机制词、坏数据当空本子 |
| `tests/proactive.test.js` | 主动那层：档位间隔低的比高的稀、落点在区间内随机、窗口判断支持跨零点、跨零点的静默之夜算前一天、全局静默与自己作息任一生效就算在睡、醒着时门开着、关掉主动就什么都不发、自家日上限到了就停、全局日上限到了都停、相邻两条最小间隔、睡觉只放一次破例且换一晚又能一次、由头优先（有话题带话、没话题才看档位允不允许戳）、到点才动手、暂存最多两条丢最老的、过期作废、最老先兑现、送出两边记账、同日累加、日上限三档与默认、老档位归一到最近一档；**睡醒状态回声：困着消息在有效时间内只回一次，已消费、过期或被更新状态拦住；** **说法去重（车轱辘话兑底）：标点空白与大小写归一、相似度 LCS 口径（一样＝1、不相干≈0、改几个字介于中间）、同一句换个说法算重复而新的一件事放行、过了窗口不算、时间戳认不得的不参与、空话不比** |
| `tests/actions.test.js` | 小动作（只有一个动作）：叫法表 id 不重、每个叫法带不重样的 emoji、每个叫法的例子自身合格（自查）、正文里用动词而不是叫法名、踩线词一律挡掉并排进重写、提示词画清了能落笔的地方且不留暗喻当示范、不认识的叫法回到默认、`{name}` 与 `{verb}` 两个槽位都换、**换叫法不换文案**、两边渲染都是同一个句式、谁都没写用兜底、占位符多处全换、缺槽位补上、太短/太长/缺槽位/没「你」/没这个叫法一律挡掉、洗文案、扳回写歪的口径（我的→你的、句首你X→{name}X）、换文案间隔 7~21 天、旧数据迁移（`actions.poke` 与 `pokeTemplate` 两代都认）、叫法认不出用默认、prompt 带上叫法与两个占位符、设置页填空与旧模板互转；**顺口应一句的提示词（只一句话、不写动作本身、不用占位符、没料也拼得出）** |
| `tests/poke.test.js` | 闭环：末尾连着几条动作的计数（新旧两种记号都算）、中间夹了正经话重新算一轮、来回两轮后不再接；**表情包进上下文靠本地标签翻人话（不靠看图），查不到标签就退回原样不编，没传查标签的口子时行为跟以前一样** |
| `tests/avatar.test.js` | 头像：认 PNG/JPEG/GIF/WebP 图片头而别的都不认、资源回包形状（Uint8Array / ArrayBuffer / base64 / {content}）、按 png→jpg→… 顺序找、一张都没有就返回 null、读到的不像图就当没读到、读了就缓存且 ttl 过了重读、她自己的头像走 user 目录 |
| `tests/ui.test.js` | 戳一戳入口：只保留伙伴消息头像与聊天头部头像的双击发送；自己的消息头像不误触；设置页固定前缀、随叫法变的 emoji 与动态动作词；通用/伙伴两级结构、移出/放回前后端入口、内联脚本语法与关键 DOM id；**设置页的档位数字与兜底值跟 `lib/proactive.js` 同源**；**好友列表名字下面只放最后一句（没聊过的就空着，不拿人格设定垫、那一行留白高度一致）**；**戳一下不马上接：前端不亮那三个点也不干等回应，后端收到后排一个不规律的时刻（连戳合并），没话题时也可能顺口应一句**；**她不在场的那些：投递出去就完了（不摆已读也不摆正在输入）、快慢跟着ta手里有没有手机与ta自己的作息走（不拿她的活跃状态判对方在不在线）、连发只排一个待办**；**性格栏可调而关系账与爱好一个字都不上页面**；**性格初稿的料只用 Hana 那边的人格与钉选、还没长好有中间态**；**性格改成两层各挑标签、能多选，披露跟着坡走不看台阶，标签库由后端发下来**；**性格栏照闲不住分层：只读那份在上、档位跟在后、标签折进 details，自己写那一块整个删掉；标签两列等宽格（名字在上说明在下），窄屏退回一列**；**先摆出现在生效那份（标签 + 判词原文），调过才多一行来源与「回到自动那份」；不把任何一份叫“本来的样子”**；**起跑线从开关改成选项组：自动／从这儿开始／各档摆成一列，自动那项写着现在量到哪，档位清单由后端发下来**；**表情包面板：分组升格成顶层 tab（Emoji｜表情包＝全部｜分组…｜＋），管理态才能删且要两步确认，[hidden] 必须有样式兜底（不然两块会同时冒出来），来源读不到时不许把整个表情包栏藏掉、不许用「请确认插件已启动」冤枉人，图少时不摆搜索那一行（≤ 12 张收起、按整库算、藏起来顺手清关键词），进这一页必须先拉一次（不能拿初始值当成「读不到」）、换伙伴重拉、没拿到原因不许糊成笼统话，抽屉里网格要 flex + min-height:0 自己滚（不然溢出去盖住输入框且划不动）** |
| `tests/notify.test.js` | 提醒那层纯判定：新消息起一批、同人连发只挪那位而条数照加、两人不并成一条、搁过 TTL 不跟旧账并、横幅只说人不说内容（单人/多人/三人以上）、没有活跃窗口不冒、卡片开着不冒、静默时段不冒、该冒时冒、静默判断跨零点 |
| `tests/sleep.test.js` | 作息：时间归一（一位小时补零、越界与垃圾拒掉）、一条作息两头都要合法且首尾不能一样、老数据里她设的 `{start,end}` 也算已定、展示成一行、从模型输出抠 JSON（含代码块）与退而找正文两个时间、不合格一律 null、理由洗手与截断、提示词带上人格并要求只吐 JSON |
| `tests/relationship.test.js` | 关系账本（双轨）：闲聊不算信号但算回合、四类信号认得准也不乱认、一天最多涨四分且同类只算一次、跨日额度重算、凌晨四点前算前一天、单日猛聊跨不过台阶、跨够日子攒够证据才升阶、分数封顶、坏数据不炸、给模型的是人话不带分数；**披露系数（坡不台阶）：全空为零、两轨都满近乎到头、多聊一天多攒一分都单调不回退、坡上有大量中间值、老台阶的两个门槛在坡上落在附近、每天聊一点比堆在同一天算数**；**起跑线：只量痕迹份量（截断过的认“原文 N 字”、人格不算）、分三档、只抬相处史不碰親近度、台阶也不跟着跳、账本本身不被写脏、没起点就原样**；**自己锁一档（跟自动量出来的三档同一套词，认不出的档不硬造）与「从这儿开始」的零点存得住、跟「没量出来」分得开；老数据没有 pick 按来历回推成 close**；**开口那句：有起跑线就不装初次见面、但也不说成熟透了；在这儿真聊熟了也说一声；还在初识且没起跑线就什么也不添** |
| `tests/knowing.test.js` | 性格与爱好：四个预设各有两层初稿、标签库每档都有说明且打架组合都在库里、一层最多两个（重了／满了／打架都说得出为什么）、整层一次校验并翻成人话、坏数据收得住、**老数据（一层一个 tag）读出来就是一个标签、超量的存盘数据收到两个**、爱好封顶（生来三条／后来两条／共五条）、重名空名不算数、盘上读回去重并截断、表层马上生效而里层按披露的坡一点点渗（里层 0.25／爱好 0.7）、**披露是坡：同一条里层越熟露得越多**、没调过一个字都不加、拼出来的话不带机制词与系数、性格初稿只收 Hana 那边的人格与钉选、两行回包能拆成两层、**自动那份单独留底（改回原样也算没改、基准是空的就不算她改过）** |
| `tests/growth.test.js` | 爱好生长：一行拆成名字／理由／由头、多行拆分并去重、生来那条该不该补、关系没到不长、关系够了才长且两次要隔几天、后来那份长满就不再长 |
| `tests/phone.test.js` | ta自己的手机节奏：头一回见ta正拿着手机（不是被她叫出来的）、拿着到点就放下、放到点就摸起来、隔很久才问也能把中间翻的那些次补上、没到翻面时状态原样不动、每段落在区间里且放下那阵可以很久、现在拿没拿着与多久拿起来 |
| `tests/reply.test.js` | 她发出去的东西什么时候被接住：手机在手就是几秒到二十秒且绝不跳过、手机不在手要等ta拿起来再缓一下、这时低概率不提这条（随机、不成规律）、ta在睡就等醒来（拿没拿着都拦）、离醒来还有多久（跨零点与不跨零点的作息都算得对）、连发几条取更早的那个时刻（不往后推） |
| `tests/load.test.js` | **装载守卫**：`index.js` 能被真的加载且导出齐全；用假 ctx 跑一次 `apply`，路由注册得上。改完 `index.js` 必跑这条 |
| `tests/stickers.test.js` | **表情包联动（只借不给）**：标记只认独占一行的 `[表情:x]`、夹在句子里或出现两次都不乱动、摘掉后前后分开；气泡哨兵编解码、普通文本不会误认；候选集排掉白名单外与被否掉的图、快照里没有的伙伴按全集；命中情绪标签高于场景、一个都没命中就不发；同档随机且优先避开最近发过的；频率兜底（连着两条不都甩、刚甩过不急着再来、她中间插过话就不算连着）；最近用过的表情新的在前去重截断；参考词按出现次数排；图库为空就不往提示词里塞这一段；相对路径拼接不允许穿越；**标签判定（情绪/场景/关键词有一个就算有，全空不让进图库）、标签翻人话（先情绪再场景，都没才退画面描述）、本地图库盖过快照的标签表、全库取源图不看伙伴白名单、读快照的失败原因（not-found / bad-json / schema-mismatch / empty / read-failed / no-data-dir）与缓存语义**；纯表情回复会在清洗后保留标记交给本地挑图 |
| `tests/sticker-library.test.js` | 茶话会自有图库：图片复制到自己的 dataDir、分组保存、读取、重复导入按指纹去重；**删图只拿掉图库记录而图片文件留着（老消息还看得见）且幂等，删分组不删组里的图、那些图退回「全部」** |
| `tests/daybook.test.js` | **拾光记日子账本联动（只借不给）**：今天这一段（节日／纪念日／调休／待办／身体不适／天气）都写到了且带收口句；做册**只取本伙伴那一份**、别人的日子一个字都不带进来；主动消息只读取共享天气，不重复搬日子账本；没装拾光记／版本对不上／坏 JSON／没有 dataDir 一律安静降级；天气为空时不生成情境块；指纹稳定；露不露（没记过就露、同天同内容不再露、跨天或内容变了要重露）；系统提示里日子那段跟在时间后面、人格前面，没料时不占位 |
| `tests/ui.test.js`（第三块） | **自己那条「已读」不是装饰**：只有这条之后真出现过伙伴的话才算接住（ta没回、正睡着搁着那条都不摆）；后一句还搁着不能跟着前一句一起挂上；回一个戳也算接住；刚发出去那条要记一笔不被轮询重画 |
| `tests/ui.test.js`（第四块） | **左边展板能收能展**：面板脚本能解析（写错一个字整个页面白屏）、那两个按钮都是描边 SVG 而不是字符、展开那个必须挂在展板外面（挂进聊天头就成了「那个框的设置」）、把手上那个未读小点跟着未读数走、没选过时窗口窄就先自己收着、她的选择存在本地、收起来展板整块让位、`display:grid` 会盖掉 `[hidden]` 得自己关一道、收着时空状态文案跟着换 |
| `tests/sleep.test.js` | **ta自己的作息**：时间归一与分钟换算（跨天绕回来）；老形状（end）换得成小时、新形状直接用 hours、离谱的收到 4.5~7.5 之间；午觉写 end 也认、超过一小时收到一小时；老形状不再算"定过"（要重定一次）；**一天一个盐给一个数**（同一天不翻来翻去、跨天换一个）；**今天睡多久在基准上下浮但不越界**、四十天里得有多种时长；午觉七成日子睡且同一天稳定、没定午觉就永远没有；窗口按当天时长摆、跨零点绕得对；这会儿在不在睡（主睡、午觉、坏数据）与晨觉不算午觉；抠模型输出（新形状、老形状、代码块、正文兜底、不合格一律 null）；理由洗一洗；提示词不许拿一条真作息当范例、要写时长区间与午觉 |
| `tests/reply.test.js`（补充） | **打盹不是关机**：睡着时拿没拿着手机都算 dozing、给的是一段两分半以内"摸到手机"的时间（得明显比醒着慢）；午觉也走这一档并把睡的那一觉带出去（好记"这一觉被吵醒几次"）；睡醒了照旧面对面；**全局静默不再是回复的门**（那是她给主动来找设的底线，她自个儿发消息不算被打扰） |
| `tests/ui.test.js`（第五块） | **被吵醒那一段**：唤醒块要现算（排期时在睡、写的时候可能已醒）、先有脾气再回正事、明说不写成「抱歉在睡觉」那种客套、同一觉里被弄醒多次脾气要升级、睡着时整段节奏往后拖、作息彻底不上页面（连展示组件也不留） |
| `tests/store.test.js`（补充） | **ta看到过她的话要盖 readAt**：刚发出去都是未读、盖一次全部盖上、再盖不重复计、她读ta的话是另一本账（readThroughId）不混 |
| `tests/sleep.test.js`（补充） | **睡多久按伙伴摊开**：一人一档（5~7 小时，偏向 5~6.5 那一段，日常再浮动 ±0.75）、同一个人每次都一样、八位伙伴至少用出四种且最短最长差 ≥1.5 小时；数据代次（`shape`）不是当代的一律算"没定过"（老形状与 0.7.19 那版的 6.5 小时都要重定） |
| `tests/actions.test.js`（补充） | **顺口应一句不许写成客服问候**：提示词里明写"不要写成客服那种问候"、把「在忙什么呢」当反例点名、不再教ta写那句问候、人格从"只作参考"改成"这就是你说话的样子" |
| `tests/ui.test.js`（第六块） | **未读突出、已读收起**：后端落了 readAt 才算已读（刷新也在）、老记录没 readAt 但被回过就补成已读、后一句还搁着不跟着前一句算已读、回一个戳也算接住；送出去那一刻先摆樱花色未读小字和圆点，读到后收起；后端那两处落盘（turn.read / reply.read）要在 |
| `tests/ui.test.js`（第七块） | **气泡看得出是两张纸**：两边都是实线边 + 淡影（伙伴那条不再用虚线、不再白底贴米白）、自己那边还是薄荷、正在输入那三个点跟伙伴气泡同一样式 |
| `tests/ui.test.js`（第八块） | **她一口气说了好几条**：撤掉那句没意义的顺口应（已有实在话要回时不再另排）、一口气好几条就立即过一遍话题本（不靠攒够十条那个阀）、提示词里允许只接一两个话头；**skip 那套彻底删了**（不再有"掷骰子决定理不理"） | **气泡看得出是两张纸**：两边都是实线边 + 淡影（伙伴那条不再用虚线、不再白底贴米白）、自己那边还是薄荷、正在输入那三个点跟伙伴气泡同一样式 |
| `tests/persona.test.js` | 人格取料：`identity.md` 是正主，没有就往下退到自我介绍、对外那份、钉选；对话用的参考段落只拼那四样，不受取料回退影响 |
| `tests/pass.test.js` | 「可以不回」那一段：给了退路也把退路收窄；只在非面对面那条路上出现；每天最多一次，隔天翻篇 |
| `tests/background.test.js` | **每位伙伴一间房（聊天背景）**：认 PNG/JPEG/GIF/WebP 图片头而别的都不认、浓度只认三档其余归默认、文件名由 agentId 派生（不带原 id，免得斜杠点号爬出目录）、换图覆盖不留孤儿、非图片与超大拒收且不落半张、清掉背景后读不到、只认自己的文件名（别人的／爬目录的／格式不对的全挡）、设置里指向一张不在了的图就当没设过、浓度脏值读出来归默认 |

## 为什么只测这两块

ta 们是纯函数，且是整个「活人感」里回归风险最高的部分（分错了会丢内容或切碎，节奏算错了会一顿一顿或憋半天）。
网络/存储/UI 不做单元测试，靠实机验收。

> `tests/load.test.js` 属于例外，ta不是纯逻辑，而是**装载门禁**。只跑 `node --check` 加上对源码的文本断言，拦不住「同一作用域重复声明」这类错：ta不报语法错，却会让整个模块加载失败，宿主回滚安装记录，应用直接从列表里消失（2026-09-12 真实阵过）。

## 「和小花聊聊」的测试覆盖

- `tests/persona-standard.test.js`：体检标准的四组结构与 id 契约、机械检查四档（空档案一律报空着不猜、色与行为挂接、反向题只选词不算过关、语料纯度）、渲染覆盖提示、档案摊开的文本不重标点。
- `tests/persona-review.test.js`：建议白名单与形状校验（含拿标题当 questionId、加色缺位置/位置乱来）、模型回包容错解析（```json 包裹、外围文字、纯废话）、**开场句（`openings` 数组、老形状单句 `opening`、最多三句、模型漏写时的兜底）**、八种改动能落地与落不上时记 skipped 且带原因、色名当 id 填也能认、其实没动的不算落下、同目标后说的算、历史存「改前那版」与来回切换与裁剪到 2、会话过期、提示词组装、变化摘要。
- `tests/persona-standard.test.js`：档案摊给模型时要带上 colorId / derivativeId / questionId。
- `tests/ui.test.js`：「和小花聊聊」入口只在档案长出来后可用、体检与聊天走 120 秒超时、版本对不上不硬盖、应用前先存旧版、应用完消费掉会话；**这一屏得像个聊天框：开场走气泡、明细收进折叠、输入框跟发送键同一个块、中文输入法敲回车不误发、占位文案不再是审阅腔**；**建议卡得长在对话流里，不再有独立的预览屏和「看看要改的地方」按钮**。

「和小花聊聊」改成聊天形态（2026-09-19，`v0.7.268`）：开场由小花说 2~3 句（`openings`）、体检明细折起来、输入框跟发送键搂成一行。全量 675 条通过（2026-09-19）。

「和小花聊聊」两处修正（2026-09-19，`v0.7.269`）：改动落不上的三个根因（材料没给 id、白名单缺 `color_add`、`after === before` 永远为假把没动报成已应用）全部收掉，落不上要逐条说原因；建议卡改成内联在对话流里，不再有独立预览屏。全量 678 条通过（2026-09-19）。

这三份里风险最高的是历史版本（存反了就会把改完那版当后悔药）和版本守卫（漏了会让旧建议盖掉新档案），改动这两处必须重跑。

```sh
node --test tests/persona-standard.test.js tests/persona-review.test.js
```

用户明确点播语音（`tests/voice.test.js`）：覆盖即时点播识别与长期偏好区分、点播绕过主动开关/关系限制/概率/额度/冷却/连续发送限制，以及点播不改动主动语音账本。运行单测：`node --test tests/voice.test.js`；全量测试仍用上面的显式文件清单。

## 不测什么

- 模型调用、宿主 RPC、路由 HTTP —— 需要真实宿主，单元测试里没有意义。
- 样式与布局 —— 靠肉眼验收。

## 发布前

测试必须全绿；另外跑一次静态校验：

```sh
node <HANA_ROOT>/scripts/validate-app.mjs --dir . --json
```

（`--smoke` 在 Windows 上当前会因宿主脚本的路径转 URL 缺陷失败，不影响静态校验。）

---

## v0.7.487：说「浇完啦」勾不掉浇水那条（实机报障驱动）

**现场证据**：`app-data/chahuahui/v2/diagnostics.jsonl` 里 2026-10-06T07:12:23Z（北京时间 15:12，正是她发这句的时间）记的是 `todo-done.not-a-done-statement`，`textChars: 3`。既不是 `no-snapshot` 也不是 `no-match`——快照读到了，跨 App 权限没挡，卡在第一道门：这句话压根没被认成「做完了」。

**根因两处，都得修，只修一处还是勾不上**：

1. `looksDone` 认的是一张写死的动词表（吃了吗 / 做完了 / 喝完 / 吃啦…）。「浇」不在表里，「浇完啦」「浇水啦」「浇过水了」全部判成不是完成汇报。词表穷举动作，注定永远差一个。
2. 就算过了这道门，`matchPendingTodo` 拿纯字符去对「给薄荷浇水」：她句子里只有「浇」，最长公共子序列比例 0.33，够不着 0.6 的线；手头又挂着两条待办，「只有一条就认」的兜底也用不上。

**改法**：

- `looksDone` 增加形状识别 `/[一-龥](?:完|妥)(?:了|啦|咯|嘞|哟|过的?)?/`——认「任意动作 + 完」的形状，不枚举动作。「好」故意不进这一条：`好看`「好喝」会把无关句子拖进来，`洗好了`「买好了」交给下面那条动作路径认。
- `matchPendingTodo` 新增第 4 级：由**这条待办自己的动作**来认，省掉的主语宾语由待办补上。动作分强弱两档——强指向（浇、喂、剪、种、贴、还、付…）说出口就锁定一件事，光说动作就认；泛动词（吃、喝、看、洗、买…）光说动作不算数，必须连待办里那个东西一起提。这一档之分就是「浇完啦」能勾、「哎妈我吃完了」不勾的全部理由。
- 反证词表补疑问与虚拟语气（吗、没有、了没、了不…），且**反证在动作路径上要再拦一遍**——只在 `looksDone` 里拦的话，反问句会从动作路径绕进来。这条是实测踩出来的：中途一版 `浇完了吗` 真的被勾掉了。

**本轮自动测试**：全量 `node --test`（显式列出 tests/ 下全部文件）**1206/1206**，0 失败/取消/跳过。基线 1180，新增 7 个测试：`looksDone` 形状识别（含「好看」反向断言）、省主语宾语认领、强弱动词分档、反问两道都挡、动作路径自带反证、端到端「浇完啦」走到跨 App 调用、端到端「拿不准的一次都不调」。

**已知边界**（有意留白，不是漏）：一句话里连报两件事（「浇完啦顺便把衣服收了」）不认——单句挂不住两件事，宁漏勿错；同义说法（待办写「吃维生素d」而她说「药吃了」）不认，要认得扩同义词表，那是另一件事。

**待实机验收**：重载茶话会后，在茶话会里对任一伙伴说「浇完啦」，看拾光记那条待办是否真的被划掉、伙伴是否顺口带一句（而不是报「已为你勾选」这种系统话）。当前自动测试覆盖的是判定与调用，全程真机链路仍需这一次实跑。
