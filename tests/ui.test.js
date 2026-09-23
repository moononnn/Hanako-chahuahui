import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_GLOBAL_GATE, GATE_MAX_CHOICES } from "../lib/proactive.js";

const panel = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
const navigation = fs.readFileSync(new URL("../ui/navigation.html", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("伙伴列表支持拖动排序，并通过后端持久化", () => {
  assert.match(app, /app\.post\("\/partner-order"/);
  assert.match(app, /store\.setPartnerOrder\(ids\)/);
  assert.match(app, /const rank = new Map\(store\.partnerOrder\(\)/);
  assert.match(panel, /li\.draggable = true/);
  assert.match(panel, /api\("POST", "partner-order", \{ ids: partners\.map/);
  assert.match(panel, /addEventListener\("drop", async/);
  assert.match(panel, /setDragImage\(ghost/);
  assert.match(panel, /li\.style\.opacity = "0\.04"/);
  assert.match(panel, /dragOriginIds/);
  assert.match(panel, /insertBefore\(draggedPartnerNode/);
  assert.match(navigation, /item\.draggable = true/);
  assert.match(navigation, /api\("partner-order", "POST", \{ ids: partners\.map/);
  assert.match(navigation, /setDragImage\(ghost/);
  assert.match(navigation, /item\.style\.opacity = "0\.04"/);
  assert.match(navigation, /insertBefore\(draggedPartnerNode/);
});

test("表情包先放进待发送区，与文字共用一条发送链", () => {
  assert.match(panel, /function selectSticker\(row\) \{[\s\S]*?pendingSticker =/);
  assert.doesNotMatch(panel, /let stickerBusy =/);
  assert.match(panel, /const sticker = pendingSticker;/);
  assert.match(panel, /\.\.\.\(sticker \? \{ stickerId: sticker\.id \} : \{\}\)/);
  assert.match(panel, /if \(pendingSticker === sticker\) clearPendingSticker\(\);/);
  assert.match(panel, /for \(const optimisticRow of optimisticRows\) optimisticRow\.remove\(\)/);
  assert.match(panel, /if \(!manageMode\) selectSticker\(row\)/);
});

test("聊天流打开到底部、上翻后可一键回到底部", () => {
  assert.match(panel, /id="jump-bottom"[^>]*title="回到底部"/, "要有明确的回到底部入口");
  assert.match(panel, /function isAtBottom\(\)/, "要能判断当前是否已经在底部");
  assert.match(panel, /const shouldShow = el\.stream\.scrollHeight > el\.stream\.clientHeight && !isAtBottom\(\)/, "只在确实离开底部时显示按钮");
  assert.match(panel, /el\.jumpBottom\.addEventListener\("click"[\s\S]*?scrollDown\(true\)/, "点击后直接回到底部");
  assert.match(panel, /el\.stream\.addEventListener\("wheel"[\s\S]*?event\.deltaY > 0 && isAtBottom\(\)[\s\S]*?playBottomFeedback\(event\.deltaY\)/, "到底后继续向下滚轮要触发反馈");
  assert.match(panel, /const maxPull = Math\.max\(1, Math\.round\(el\.stream\.clientHeight \/ 3\)\)/, "底部拉伸上限跟随聊天区域高度的三分之一");
  assert.match(panel, /Math\.min\(maxPull[\s\S]*?bottomPull/, "连续向下滚轮会累积底部拉伸且有上限");
  assert.match(panelCss, /\.stream\.bottom-feedback \{[\s\S]*?transform: translateY\(calc\(var\(--bottom-pull, 0px\) \* -1\)\)/, "到底反馈会随滚轮拉伸聊天流");
  assert.match(panelCss, /\.stream\.bottom-feedback, \.stream:not\(\.bottom-feedback\) \{ transition: none; \}/, "减少动态效果时不强行拉伸");
  assert.match(panel, /const stickToBottom = isAtBottom\(\)/, "增量消息先记住用户是否在底部");
  assert.match(panel, /autoScrollAllowed = stickToBottom/, "用户上翻时不被新消息拽回去");
  assert.match(panel, /async function stickerBubble\([\s\S]*?img\.classList\.remove\("loading"\);\s*\/\/ 表情包是异步插入的：[\s\S]*?scrollDown\(\);/, "异步表情包加载后仍会补到底部定位");
  assert.match(panelCss, /\.jump-bottom \{[\s\S]*?position: absolute;[\s\S]*?border-radius: 50%;/, "按钮是聊天区里的轻量悬浮圆按钮");
});

test("回复只有一条路能画：正在演的那轮归演出，剩下的归轮询", () => {
  assert.match(app, /replyMessageId: turn\.replyMessageId \?\? null/);
  assert.match(panel, /async function appendNewOnce\(agentId, viewSeq\)/);
  assert.match(panel, /if \(paintedWithAvatars !== showMessageAvatars\)/);
  assert.match(panel, /seenIds\.has\(m\.id\)/);
  assert.match(panel, /generation !== renderGeneration/);
  // 面对面那轮（后端给了 turnId）由 playLiveTurn 按读写节奏一条条摆出来，
  // 轮询见着它在演就绕开；她切走或换了伙伴就停，不往别人的窗口里塞气泡。
  assert.match(panel, /if \(started\.turnId\) void playLiveTurn\(agentId, turnSeq, started, tickEl\);/);
  assert.match(panel, /async function playLiveTurn\(agentId, viewSeq, started, tickEl\)/);
  assert.match(panel, /const state = await api\("GET", `turns\/\$\{encodeURIComponent\(started\.turnId\)\}`\)/);
  assert.match(panel, /await sleep\(Math\.max\(120, Number\(item\.gapMs\) \|\| 700\)\)/);
  assert.match(panel, /const liveSkipRepliedTo = new Set\(\)/);
  assert.match(panel, /liveSkipRepliedTo\.has\(m\.repliedTo\)\) continue;/);
  assert.match(panel, /liveSkipRepliedTo\.delete\(repliedTo\)/);
  assert.match(panel, /if \(payload\.replyMessageId\) seenIds\.add\(payload\.replyMessageId\)/);
  // 三个点要跟着最新一条走，不能跑到新消息头上去
  assert.match(panel, /el\.stream\.appendChild\(dots\);/);
  assert.match(panel, /const alive = \(\) => current === agentId && viewSeq === threadViewSeq/);
});

test("茶话会在场心跳不被取数轮询冒充", () => {
  assert.match(panel, /async function loadPartners\(\)\s*\{[\s\S]*?api\("GET", "partners"\)/);
  assert.doesNotMatch(app, /app\.get\("\/partners"[\s\S]{0,500}panelSeenAt = Date\.now\(\)/);
  assert.match(app, /app\.post\("\/presence"/);
  assert.match(panel, /document\.hasFocus\(\)/);
  assert.match(panel, /postPresence\(false\)/);
  assert.match(panel, /presenceToken/);
  assert.match(panel, /presenceSeq\+\+/);
  assert.match(panel, /window\.addEventListener\("blur", stopPresence\)/);
  assert.match(panel, /window\.addEventListener\("pagehide", stopPresence\)/);
});

test("聊天头部不暴露人格读取来源", () => {
  assert.doesNotMatch(panel, /人格读于|人格没读到|chat-meta/, "人格读取状态属于内部信息，不放在聊天现场");
  assert.doesNotMatch(panelCss, /\.chat-head \.meta/, "移除对应的无意义占位样式");
});

test("消息操作与投喂入口分开：操作悬停，投喂右键", () => {
  assert.match(panel, /event\.preventDefault\(\);[\s\S]{0,220}?openMessageFeed\(row, message, agentId, row\.__feedText\)/, "右键伙伴消息只打开投喂浮层");
  assert.match(panel, /const FEED_EMOJIS = \["☕", "🍵", "🍭", "🧋", "🍪", "🍰", "🍓", "🍫"\]/);
  assert.match(panel, /messageFeedMenu\.className = "message-feed-menu"/);
  assert.match(panel, /messageFeedMenu\.append\(emojiRow, divider, actionRow\)/, "投喂在上、消息操作在下");
  assert.match(panel, /menuActionButton\("复制"/);
  assert.match(panel, /menuActionButton\("引用"/);
  assert.match(panel, /menuActionButton\("收藏"/);
  assert.match(panel, /thread\/\$\{encodeURIComponent\(agentId\)\}\/feed\/\$\{encodeURIComponent\(messageId\)\}/, "投喂走独立消息接口");
  assert.match(panel, /thread\/\$\{encodeURIComponent\(agentId\)\}\/favorite\/\$\{encodeURIComponent\(messageId\)\}/, "收藏走独立消息接口");
  assert.match(panel, /renderMessageFeed\(lastRow\.querySelector\("\.msg-col"\), m\)/, "投喂挂在原消息下面");
  assert.match(panel, /pendingQuote: document\.getElementById\("pending-quote"\)/);
  assert.match(panel, /function quoteMessage\(message, selectedText = ""\)/);
  assert.match(panel, /pendingQuote = \{ messageId: message\.id, text \}/);
  assert.doesNotMatch(panel, /el\.input\.value = existing \? `\$\{quote\}/, "引用不能把原文塞进输入框");
  assert.match(panel, /bindMessageFeed\(rendered\.row, m, current, piece\)/, "每个伙伴气泡都要绑定具体引用文本");
  assert.match(panel, /favorites-view/);
  assert.match(panel, /GET", "favorites"/);
  assert.match(app, /app\.get\("\/favorites"/);
  assert.match(app, /app\.get\("\/favorites\/:favoriteId\/voice"/);
  assert.match(panel, /pointerenter/);
  assert.match(panel, /撤回消息/);
  assert.match(panel, /重新生成/);
  assert.match(panel, /调整这条回复/);
  assert.match(panel, /function placeMessageActions\([\s\S]*?getBoundingClientRect\(\)[\s\S]*?messageActions\.style\.left/);
  assert.match(panel, /row\.classList\.add\("actions-open"\)/, "悬停中的消息要有轻微反馈");
  assert.match(panel, /actionRow\?\.classList\.remove\("actions-open"\)/, "收起来要还原");
  assert.match(panel, /event\.key === "Escape"/);
  assert.match(panel, /isLatestUserMessage\(m\).*bindMessageActions\(row, m\)/s, "撤回入口只挂最新一条用户消息");
  assert.match(panel, /function isLatestUserMessage\(message, agentId = current\)/);
  assert.match(panel, /function isLatestAssistantMessage\(message, agentId = current\)/);
  assert.match(panel, /messageRefineEnabled && isLatestAssistantMessage\(message, agentId\)/, "修整入口只给最后一条伙伴回复");
  assert.match(panel, /lastRow && opts\.bindAssistantActions !== false[\s\S]*isLatestAssistantMessage\(m\)/, "历史伙伴回复不挂修整入口");
  assert.match(panel, /thread\/\$\{encodeURIComponent\(agentId\)\}\/refine\/\$\{encodeURIComponent\(messageId\)\}\/regenerate/);
  assert.match(panel, /thread\/\$\{encodeURIComponent\(agentId\)\}\/refine\/\$\{encodeURIComponent\(message\.id\)\}\/edit/);
  assert.match(panelCss, /\.msg-actions\[hidden\] \{ display: none; \}/);
  assert.match(panelCss, /\.msg-actions \{[^}]*position: fixed;/s);
  assert.match(panelCss, /\.row\.actions-open \.bubble \{/);
  assert.match(settings, /id="msg-refine-switch"/);
  assert.match(settings, /messageRefine/);
  assert.match(app, /messageRefine: Boolean\(store\.getGlobalSettings\(\)\.messageRefine\)/);
  assert.match(app, /lastAssistant\?\.id !== messageId[\s\S]*只能调整最后一条伙伴回复/, "后端也要挡住旧回复编辑");
});

test("表情包导入：点击添加后立即进入导入页，来源读不到要讲明白并给重试", () => {
  assert.match(panel, /async function openStickerImport\(\)\s*\{[\s\S]*?el\.stickerImport\.hidden = false;/);
  assert.match(panel, /el\.stickerSourceGrid\.appendChild\(note\)/);
  assert.match(panel, /sourceProblemText\(\)/);
  assert.match(panel, /el\.stickerImportRetry\.hidden = false;/);
  assert.doesNotMatch(panel, /请确认表情包插件已启动/, "别再把锅甩给「插件没启动」，快照不在跟插件开着没是两回事");
  assert.doesNotMatch(panel, /el\.stickerTab\.hidden/, "来源没了也不能把整个表情包栏藏掉");
});

test("认识 ta：场景建议沿用页面按钮语言，保存回执不完整时不冒进", () => {
  assert.match(panel, /obNode\("button", "ob-suggest"/);
  assert.match(panel, /给我几个具体场景/);
  assert.doesNotMatch(panel, /想不到？给我几个方向/);
  assert.match(panel, /obNode\("strong", "ob-custom-title", "写一点只属于 ta 的东西"/);
  assert.match(panel, /suggest\.setAttribute\("aria-busy"/);
  assert.match(panel, /Array\.isArray\(draft\.selected\) \? draft\.selected : \[\]/);
  assert.match(panel, /if \(!result\?\.recognition\) throw new Error/);
  assert.match(panel, /下面是设想的情境，不是真实经历过的事/);
  assert.match(panel, /ob-suggestion-reaction/);
  assert.ok(panel.indexOf('obNode("button", "ob-suggest"') < panel.indexOf('const text = document.createElement("textarea")'), "场景建议要出现在输入框之前");
  assert.match(panelCss, /\.ob-suggestions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(panelCss, /\.ob-suggestion:hover \{[^}]*transform: translateY\(-1px\)/s);
});

test("输入框：空着就一行，写多了自己长，长到头就在框里滚", () => {
  assert.match(panel, /<textarea id="input" rows="1" placeholder="说点什么…"/, "提示语别长到自己换行");
  assert.match(panel, /<textarea id="input"[^>]*maxlength="12000"/, "前端输入框也要有长度提示");
  assert.match(panel, /title="Enter 发送，Shift\+Enter 换行"/, "Enter 的说明挪到悬停提示上");
  assert.match(panelCss, /textarea \{[^}]*min-height: 42px;/s, "空着也要有稳定的单行底高");
  assert.match(panelCss, /textarea \{[^}]*padding: 8px 12px;[^}]*line-height: 24px;/s, "单行提示和光标要在输入框视觉中线附近");
  assert.match(panelCss, /textarea\.is-multiline \{ padding: 8px 12px; line-height: 1\.5; \}/, "多行输入恢复正常的上边距");
  assert.match(panel, /classList\.toggle\("is-multiline", el\.input\.value\.includes\("\\n"\)\)/, "输入行数变化时切换对应排版");
  assert.match(panelCss, /textarea \{[^}]*max-height: 88px;/s, "封顶以后框里滚，不把输入区抻大");
  assert.match(panelCss, /\.composer-row \{[^}]*align-items: center;[^}]*\}/s, "发送按钮要在输入框旁垂直居中");
  assert.match(panelCss, /button\.send \{[^}]*width: 38px;[^}]*height: 38px;[^}]*border-radius: var\(--r-sm\);/s, "发送按钮要和左侧工具按钮统一成精致的小方件");
  assert.match(panel, /class="send-icon"[\s\S]*class="send-confirm"/, "发送按钮要有发送与已送达两种图标状态");
  assert.match(panel, /function autosizeInput\(\)/, "长高这套只写一处");
  assert.match(panel, /el\.input\.addEventListener\("input", \(\) => \{[\s\S]{0,220}?autosizeInput\(\);/, "输入时要继续自动调整高度并记录代次");
  assert.doesNotMatch(panel, /Math\.min\(120,/, "上限交给 CSS，别在 JS 里再写一份数字");
});

test("聊天入口拒绝超长消息和非法伙伴 ID", () => {
  assert.match(app, /code: "INVALID_PARTNER_ID", message: "伙伴 ID 不合法"/);
  assert.match(app, /text\.length > 12000/);
  assert.match(app, /code: "MESSAGE_TOO_LONG"/);
  assert.match(app, /\}, 413\)/);
});

test("设置接口只接受用户设置字段", () => {
  assert.match(app, /app\.use\("\*", async \(c, next\) =>/);
  assert.match(app, /INVALID_PARTNER_ID/);
  assert.match(app, /const GLOBAL_SETTING_KEYS = new Set\(\[/);
  assert.match(app, /const PARTNER_SETTING_KEYS = new Set\(\["tier", "proactiveEnabled", "model", "vision", "voice"\]\)/);
  assert.match(app, /code = "UNKNOWN_SETTING"/);
  assert.match(app, /pickSettingsPatch\(body, PARTNER_SETTING_KEYS, "伙伴设置"\)/);
  assert.doesNotMatch(app, /function normalizePartnerSettingsPatch\(body\) \{\n\s*const patch = \{ \.\.\.\(body/);
});

test("输入提示：浮在输入框上方并自动收起，颜色跟背景适配但和发送按钮错开", () => {
  assert.match(panel, /<div class="status-line" id="status" role="status" aria-live="polite"><\/div>/);
  assert.match(panel, /<div class="pending-quote" id="pending-quote" hidden>/);
  assert.match(panel, /<div class="composer-row">/);
  assert.match(panel, /function setStatus\(text\) \{[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?3200/);
  assert.match(panelCss, /\.status-line \{[\s\S]*?position: absolute;[\s\S]*?left: 50%;[\s\S]*?bottom: calc\(100% - 2px\);[\s\S]*?transform: translateX\(-50%\);/);
  assert.doesNotMatch(panelCss, /\.status-line::after/, "提示就是干净的气泡，不画弹出尖角");
  assert.match(panel, /--status-bg/);
  assert.match(panel, /theme\.noticeBackground/);
});

test("发送时间：气泡保留悬停精确时间，长间隔在消息流中显示刻度", () => {
  assert.match(panel, /function bubbleTimeText\(at\)/, "时间要按今天 / 昨天 / 更早分档说");
  assert.match(panel, /sameDay\(d, new Date\(now\.getTime\(\) - 86400000\)\)/, "昨天得认出来");
  assert.match(panel, /function messageTime\(at\)/);
  assert.match(panel, /function timeDividerText\(at\)/);
  assert.match(panel, /const TIME_DIVIDER_GAP_MS = 10 \* 60 \* 1000/);
  assert.match(panel, /let lastRenderedConversationAt = null/);
  assert.match(panel, /parsedAt - lastRenderedConversationAt >= TIME_DIVIDER_GAP_MS/);
  assert.match(panelCss, /\.time-divider::before,[\s\S]*?background: var\(--line-soft\)/, "时间刻度用极浅实线，不用虚框");
  assert.match(panel, /line\.className = "msg-line"/, "时间跟气泡并排站一层");
  assert.match(panel, /line\.append\(b, time\)/, "时间贴在气泡外侧，不叠在别的消息上");
  assert.match(panel, /bubble\("user", m\.text, null, m\.at\)/, "画历史消息时把 at 递进去");
  assert.match(panel, /bubble\("assistant", piece, null, m\.at\)/);
  assert.match(panelCss, /\.row:hover \.msg-time \{ opacity: 1; \}/, "平时不显示，hover 才出");
  assert.match(panelCss, /\.msg-time \{[^}]*opacity: 0;/s, "平时是隐的但仍占位，hover 不跳");
  assert.doesNotMatch(panelCss, /@media \(max-width: 600px\)[\s\S]*?\.msg-time \{ display: none; \}/, "窄窗也保留时间，不能整块隐藏");
  assert.match(panelCss, /\.row\.me \.msg-line \{ flex-direction: row-reverse; \}/, "她那条时间在气泡左边");
  assert.match(panelCss, /\.msg-line \{ display: flex; align-items: flex-end;/, "跟气泡底部对齐，不是跟「已读」那行");
  assert.doesNotMatch(panel, /data-time/, "不再用浮层那套");
  assert.doesNotMatch(panelCss, /bottom: calc\(100% \+ 6px\)/, "不再浮在上方挡消息");
});

test("戳一下只留伙伴头像双击入口，自己的头像与按钮都不会触发", () => {
  assert.match(panel, /el\.chatAvatar\.addEventListener\("dblclick",[\s\S]*?doAction\(current\)/);
  assert.match(
    panel,
    /if \(role === "user"\) return messageAvatar\("__user", "我"\);[\s\S]*?box\.classList\.add\("poke-target"\);[\s\S]*?box\.addEventListener\("dblclick",[\s\S]*?doAction\(current\)/,
  );
  assert.doesNotMatch(panel, /btn-actions|poke-back|戳回去|还回去/);
});

test("设置从聊天卡内部打开，不再占一个独立卡片入口", () => {
  assert.match(panel, /id="settings-view"/);
  assert.match(panel, /settings\.html\?embedded=1/);
  assert.match(panel, /chahuahui:close-settings/);
  assert.doesNotMatch(panel, /hana\.cards\.open\("settings"\)/);
  assert.equal(manifest.contributes.cards.some((card) => card.id === "settings"), false);
});

test("设置页跳转认识流程时保留宿主会话，不把 iframe 票据弄丢", () => {
  assert.match(settings, /chahuahui:open-panel-action/);
  assert.match(settings, /window\.parent !== window/);
  assert.match(settings, /appSurfaceSession/);
  assert.match(panel, /event\.data\?\.type !== "chahuahui:open-panel-action"/);
  assert.match(panel, /void obPick\(partner\)/);
});

test("设置页小动作改成好友固定前缀加填空，并随叫法换动作词", () => {
  assert.match(settings, /好友[\s\S]*class="action-emoji"[^>]*>👉[\s\S]*id="action-preview-verb"[\s\S]*>我的/);
  assert.match(settings, /emojiHost[\s\S]*?selectedStyle\?\.emoji/, "填空行前面的表情要跟着叫法换");
  assert.match(settings, /style\.emoji[\s\S]*?style\.label/, "叫法胶囊各自带自己的表情");
  assert.match(app, /emoji: s\.emoji/, "叫法表要把 emoji 传给设置页");
  assert.match(app, /actionStyles: ACTION_STYLES\.map/, "聊天窗的表情要跟叫法表同源");
  assert.match(panel, /actionEmoji\.get\(m\.actionId\)/, "聊天窗的动作也要带上自己的表情");
  assert.doesNotMatch(panel, /actionLabel/, "聊天窗不能把「拍一拍」这种叫法当正文");
  assert.match(app, /renderActionLine\(styleId, readTemplateEntry\(settings\)\?\.text, USER_NAME\)/, "存进聊天的正文是动词句");
  assert.match(settings, /myActionTail/);
  assert.match(settings, /maxlength="34"/);
  assert.doesNotMatch(settings, /\{name\}|\{verb\}/);
  assert.match(settings, /selectedStyle\?\.verb/);
  assert.match(settings, /myActionTail: text/);
  assert.match(app, /actionTemplateFromTail/);
  assert.match(app, /actionTailFromTemplate/);
  assert.match(app, /verb: s\.verb/);
});

test("左侧点当前伙伴不重载聊天现场", () => {
  assert.match(panel, /async function openPartner\(agentId\) \{[\s\S]*?if \(current === agentId\) \{[\s\S]*?foldAfterPick\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?rememberComposerDraft\(\);/);
  assert.match(panel, /当前伙伴只收起列表，不重拉线程、不清输入框/);
});

test("认识 ta：完成后回到刚认识的伙伴，不被上次伙伴覆盖", () => {
  assert.match(panel, /const preferredPartnerId = obState\.partner\?\.id;[\s\S]*?void bootChat\(preferredPartnerId\)/);
  assert.match(panel, /async function bootChat\(preferredPartnerId = null\)/);
  assert.match(panel, /preferredPartnerId && partners\.some\(\(p\) => p\.id === preferredPartnerId && !obPending\.has\(p\.id\)\)/);
  assert.match(panel, /const preferredPartnerId = obState\.partner\?\.id;[\s\S]*?await bootChat\(preferredPartnerId\)/);
});

test("认识 ta：快速路线和认真采访都能进，认真路线支持多选与自由输入", () => {
  assert.match(panel, /先聊个大概/);
  assert.match(panel, /认真认识 ta/);
  assert.match(panel, /recognition\/\$\{encodeURIComponent\(partnerId\)\}\/answer/);
  assert.match(panel, /recognition\/\$\{encodeURIComponent\(partnerId\)\}\/suggestions/);
  assert.match(panel, /给我几个具体场景/);
  assert.doesNotMatch(panel, /想不到？给我几个方向/);
  assert.match(panel, /recognitionSuggestSeq/);
  assert.match(panel, /recognitionSaveSeq/);
  assert.match(panel, /const firstUnanswered = questions\.findIndex\(\(question\) => !recognition\.answers\?\.\[question\.id\]\)/);
  assert.match(panel, /const savedIndex = questions\.findIndex\(\(question\) => question\.id === recognition\.current\)/);
  assert.match(panel, /const draftIndex = questions\.findIndex\(\(question\) => recognition\.answers\?\.\[question\.id\]\?\.draft === true\)/);
  assert.match(panel, /const legacyResumeIndex = savedIndex >= 0/);
  assert.match(panel, /const index = draftIndex >= 0 \? draftIndex : legacyResumeIndex >= 0 \? legacyResumeIndex : firstUnanswered >= 0 \? firstUnanswered : 0/);
  assert.match(panel, /draft\.selected/);
  assert.match(panel, /写一点只属于 ta 的东西/);
  assert.match(panel, /可以补充一点自己的话，也可以留空/);
  assert.match(panel, /下面是设想的情境，不是真实经历过的事/);
  assert.match(panel, /recognitionDraft\.origin = scenarios\.length \? "scenario" : "user"/);
  assert.match(panel, /recognitionDraft\.scenarios = scenarios/);
  assert.match(panel, /一个场景挑一条就行/);
  assert.match(panel, /question\.id === "boundaries"/);
  assert.match(panel, /question\.intent === "avoid"/);
  assert.match(panel, /要避开的方向/);
  assert.match(panel, /ob-suggestion-reaction\$\{selected \? " is-selected" : ""\}/);
  assert.match(app, /app\.get\("\/recognition\/:agentId"/);
  assert.match(app, /app\.post\("\/recognition\/:agentId\/answer"/);
  assert.match(app, /scenarios: body\?\.scenarios/);
  assert.match(
    app,
    /isPaletteDone\(knowing\.palette\)[\s\S]{0,180}?hasPersonality\(knowing\.personality\)[\s\S]{0,120}?knowing\.recognition\?\.status === "complete"/,
    "认真认识完成后不能再被快速路线门禁拦回去",
  );
  assert.match(panel, /新增角色/);
  assert.doesNotMatch(panel, /btn-recognize|chat-recognize/, "聊天栏不放建档入口");
  assert.match(panel, /local-partners/);
  assert.match(settings, /新增茶话会角色/);
  assert.match(settings, /action: "create", value: "1"/);
  assert.match(panel, /launchAction/);
  assert.match(panel, /history\.replaceState/);
  assert.match(panel, /searchParams\.delete\("create"\)/);
  assert.match(panel, /searchParams\.delete\("recognize"\)/);
  assert.match(panel, /searchParams\.delete\("reshape"\)/);
  assert.match(panel, /action\?\.recognize/);
  assert.match(panel, /action\?\.reshape/);
  assert.match(app, /store\.clearPaletteDraft\(agentId\)/);
});

test("没入住的伙伴不被主动联系，也不进后台补全", () => {
  assert.match(app, /if \(!isSettled\(agentId\)\) continue;/, "主动与等回音两条巡逻都要先过入住门禁");
  assert.match(app, /if \(!isSettled\(partner\.id\)\) continue;/, "后台补动作文案、作息、性格草稿也要过入住门禁");
  assert.match(app, /hasPersonality\(knowing\.personality\)/, "已有旧性格档案的伙伴不能被新版采访门禁拦住");
  assert.match(app, /\.filter\(\(row\) => !isSettled\(row\.id\)\)/, "/onboarding 的门禁跟后台用同一把尺");
});

test("设置页完全不展示伙伴爱好", () => {
  const executableSettings = settings.replace(/\/\/.*$/gmu, "");
  assert.doesNotMatch(executableSettings, /爱好|hobbies/, "伙伴爱好只能从聊天里慢慢了解");
  assert.match(app, /app\.get\("\/knowing\/:agentId"/);
  assert.doesNotMatch(app, /return c\.json\(\{[\s\S]{0,1200}hobbies:/, "用户可见的 knowing 回包不能带爱好");
});

test("伙伴语音设置分成表达方式与全局朗读模型", () => {
  assert.match(settings, /id="voice-model-host"/, "通用设置要有朗读模型配置入口");
  assert.match(settings, /id="voice-model-test"/, "通用设置要有模型连通测试");
  assert.match(settings, /id="voice-model-test-note"/, "模型测试要有单独的结果提示");
  assert.match(settings, /试听这位伙伴的声音/, "伙伴联系页要有针对当前音色的试听");
  assert.match(settings, /voicePresets = data\.voicePresets/, "朗读模板要从后端读取");
  assert.match(settings, /已保存的朗读模型/, "朗读设置要能选择已保存的条目");
  assert.match(settings, /＋ 新建一条朗读模型/, "朗读设置要能新建条目");
  assert.match(settings, /voice-model-presets/, "新建时要给出开箱模板按钮");
  assert.match(settings, /custom-\$\{Date\.now\(\)/, "新建条目要拿得到自己的编号");
  assert.match(settings, /list\.addEventListener\("change", async/, "切换已保存朗读模型要等保存回包再重画表单");
  assert.match(settings, /保存这条朗读模型/, "新建态和编辑态的保存按钮要分开");
  assert.match(settings, /voiceFormReader/, "测试模型连接要能读还没保存的草稿");
  assert.match(settings, /keyBadge\.className = "field-state saved"/, "存过 Key 要明确标出来");
  assert.match(settings, /keyBadge\.className = "field-state missing"/, "没填 Key 也要明确标出来");
  assert.match(settingsCss, /input\[type="password"\]/, "API Key 输入框要跟其它字段同一套样式");
  assert.match(settingsCss, /\.field-state\.saved/, "状态胶囊要有自己的配色");
  assert.match(settingsCss, /\.voice-model-presets button/, "模板按钮要有自己的轻量样式，不能是原生按钮");
  assert.match(settings, /remove\.className = "remove-link"/, "删除按钮跟随设置页已有的轻量危险样式");
  assert.doesNotMatch(settings, /选择已配置朗读模型|voiceModelCatalog|hana-\$\{/, "分享版不再从 Hana 目录拉朗读模型");
  assert.match(app, /voicePresets: VOICE_PRESETS/, "后端回包要给朗读模板");
  assert.doesNotMatch(app, /listConfiguredVoices/, "后端不再拉 Hana 朗读目录");
  assert.doesNotMatch(app, /GLOBAL_SETTING_KEYS[\s\S]{0,400}?"voiceModel"/, "全局设置不再单独收 voiceModel");
  assert.match(settings, /const pickedVoice = voiceChoices\.some/, "试听要使用当前模型下的合法音色");
  assert.match(settings, /这条朗读模型还没给 ta 选过声音/, "没给这条模型选过音色时要说明白");
  assert.match(settings, /body: JSON\.stringify\(\{ voiceId: voiceId, modelConfig: globalSettings\.voiceModel/, "试听请求要带当前合法音色");
});

test("语音消息采用播放胶囊，转文字独立成普通气泡", () => {
  assert.match(panel, /main\.className = "voice-main"/);
  assert.match(panel, /wave\.className = "voice-wave"/);
  assert.match(panel, /transcriptLine\.className = "msg-line voice-transcript-line"/);
  assert.match(panel, /messageLine\.insertBefore\(transcript, messageLine\.querySelector\("\.msg-time"\)\)/);
  assert.match(panel, /rendered\.col\.appendChild\(transcriptLine\)/);
  assert.match(panel, /function formatVoiceDuration/);
  assert.match(panel, /voice-unplayed-dot/);
  assert.match(panel, /playedAt/);
  assert.match(panel, /voice\/[\s\S]*\/played/);
  assert.match(panel, /el\.chat\.style\.setProperty\("--voice-bg", theme\.background\)/);
  assert.match(panelCss, /background: var\(--voice-bg, var\(--primary-ink\)\)/);
  assert.match(panelCss, /\.voice-play:hover \{[^}]*background: var\(--voice-bg/);
  assert.match(panelCss, /\.voice-play \{[\s\S]*border-radius: 50%/);
  assert.match(panelCss, /\.voice-wave \{/);
  assert.match(panelCss, /\.voice-transcript-line \{ margin-top: 6px; \}/);
  assert.doesNotMatch(panel, /main\.append\(play, wave, duration, transcript\)/, "转文字按钮不能继续塞进语音胶囊");
});

test("判定发语音时先在后台合成，实时回合直接摆最终语音条", () => {
  assert.match(app, /async function prepareVoice\(/, "语音要有独立的后台准备阶段");
  assert.match(app, /let preparedVoice = await prepareVoice\(agentId, cleanedText/, "普通回复要在落消息前准备语音");
  assert.match(app, /let preparedVoice = await prepareVoice\(agentId, text, \{ kind: "proactive" \}\)/, "主动联系也要先准备语音");
  assert.match(app, /let preparedVoice = await prepareVoice\(agentId, bubbles\.join\("\\n"\), \{ kind: "awaiting" \}\)/, "等回音也要先准备语音");
  assert.match(app, /const stored = appendPartnerMessage\(agentId, reply, preparedVoice, replaceMessageId\)/, "消息和语音要走同一提交点");
  assert.doesNotMatch(app, /void maybeGenerateVoice\(/, "不能再先落文字再异步补语音");
  assert.match(app, /turn\.message = made\.message/, "实时回合要把最终消息带给前端");
  assert.match(app, /app\.post\("\/thread\/:agentId\/clear"[\s\S]{0,500}voiceGenerations/, "清空聊天时要取消尚未落消息的语音合成");
  assert.match(panel, /payload\.message\?\.voice\?\.status === "ready"/, "实时回合识别已准备好的语音消息");
  assert.match(panel, /renderMessage\(payload\.message, \{ bindAssistantActions: true \}\)/, "实时回合直接渲染语音消息");
  assert.match(app, /voice: null,\s*editedAt: new Date\(\)\.toISOString\(\),\s*userRefined: true/, "手动编辑文字时要清掉旧语音");
  assert.match(app, /event: "voice\.commit\.failed"/, "语音已送出后账本异常不能触发整轮重试");
});

test("茶话会用户名称有明确保存按钮，清空后可恢复跟随 Hana", () => {
  assert.match(settings, /id="user-name-override"/);
  assert.match(settings, /id="user-name-override-save"/);
  assert.match(settings, /userNameOverride/);
  assert.match(settings, /effectiveUserName/);
  assert.match(app, /effectiveUserName: USER_NAME/);
  assert.doesNotMatch(settings, /user-name-override\"\)\.addEventListener\(\"change\"/);
});

test("设置页操作按钮和上方控件之间保留呼吸感", () => {
  assert.match(settingsCss, /\.detail-actions \{[^}]*margin-top: 12px;/s);
  assert.match(settingsCss, /\.user-name-field \.soft-button \{[^}]*margin-top: 12px;/s);
});

test("设置页分成通用设置与伙伴管理，并提供移出和放回入口", () => {
  assert.match(settings, /data-tab="global"[^>]*>通用设置/);
  assert.match(settings, /data-tab="partners"[^>]*>伙伴管理/);
  // 分类得有 tab 语义，屏幕阅读器才知道当前在哪一栏
  assert.match(settings, /role="tablist"/);
  assert.match(settings, /aria-selected="true"/);
  assert.match(settings, /id="removed-entry"/);
  assert.match(settings, /确认移出/);
  assert.match(settings, /放回列表/);
  assert.match(settings, /settings\/partner\/\$\{encodeURIComponent\(agentId\)\}\/hide/);
  assert.match(settings, /settings\/partner\/\$\{encodeURIComponent\(partner\.id\)\}\/unhide/);
  assert.match(app, /filter\(\(row\) => !store\.isPartnerHidden\(row\.id\)\)/);
  assert.match(app, /hiddenPartners: hidden/);
  assert.match(app, /unavailable = false/);
  assert.match(app, /app\.post\("\/settings\/partner\/:agentId\/hide"/);
  assert.match(app, /app\.post\("\/settings\/partner\/:agentId\/unhide"/);
  assert.match(panel, /currentWasRemoved[\s\S]*?partners\[0\]\?\.id[\s\S]*?showNoPartner\(\)/, "聊天窗开着时移出当前伙伴，也要立刻切走");
  assert.match(settings, /globalSaveChain[\s\S]*?patch\.globalGate[\s\S]*?globalSettings\.globalGate/, "全局设置要串行保存并在执行时合并嵌套字段");
  assert.match(settings, /if \(currentId === agentId\) openPartner\(agentId, "contact"\)/, "旧伙伴的保存回包不能切走当前选择");
  assert.match(settings, /partner\.unavailable \? "已解除隐藏，等伙伴恢复活动后会出现"/, "不活跃伙伴解除隐藏后不能假报已回到列表");
});

test("作息不摆上页面了：ta是伙伴的内在状态，跟隐性爱好一个待遇", () => {
  assert.doesNotMatch(settings, /s\.sleep\?\.start \?\?/, "设置页不能再出现作息输入框");
  assert.doesNotMatch(settings, /请 ta 重新定/, "也不再摆那个重定按钮");
  assert.doesNotMatch(settings, /sleep\/\$\{encodeURIComponent/, "设置页不再碰作息那条路");
  assert.doesNotMatch(settings, /sleep-readout|sleep-hours|sleep-why|sleep-empty/, "那些展示作息的小组件也不留");
  assert.doesNotMatch(settings, /ta 自己的作息|ta 的作息/, "正文里不再提");
  assert.doesNotMatch(settings, /["“`]作息/, "不放引号里当文案");
  assert.doesNotMatch(app, /app\.post\("\/sleep\/:agentId\/rewrite"/, "连路由也拆了");
  // ta自己还是得有一份，只是不上页面：没定过的要能补上
  assert.match(app, /async function rollSleep/);
  assert.match(app, /isSleepSet/);
});

test("设置页内联脚本语法可解析，关键元素 id 都存在", () => {
  const match = settings.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "应有 module 脚本");
  const script = match[1].replace(/^\s*import[^\n]*\n/gm, "");
  assert.doesNotThrow(() => new Function(script));
  for (const id of ["status", "partner-list", "partner-body", "removed-list", "remove-modal", "removed-modal"]) {
    assert.match(settings, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(settings, /data-close-modal="(?:recognize-modal|history-modal|remove-modal|removed-modal|workfeed-modal)"[^>]*>[^<]*(?:先不重来|先看看，不回退|先不移出|关闭)/, "弹窗不再同时摆底部关闭按钮");
  assert.doesNotMatch(settings, /const (?:cancel|back) = rNode\("button", "remove-link", "(?:先不聊了|先回设置)"\)/, "聊聊弹窗只保留右上角叉关闭");
  assert.doesNotMatch(panel, /class="message-editor-cancel"/, "调整回复弹窗只保留右上角叉关闭");
});

/** 从设置页的某个选项常量里抠出数字档位。 */
function readChoiceValues(name) {
  const block = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(settings);
  assert.ok(block, `设置页应有 ${name}`);
  return [...block[1].matchAll(/\[\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
}

test("设置页的档位数字跟主动那层保持一份", () => {
  // 两边各存一份就容易走散，这里钉住。
  assert.deepEqual(readChoiceValues("MAX_CHOICES"), GATE_MAX_CHOICES);
  assert.deepEqual(readChoiceValues("GAP_CHOICES"), [15, 30, 60]);
});

test("设置页的日上限兜底值跟主动那层的默认一致", () => {
  const match = /globalGate\?\.maxPerDay \?\? (\d+)/.exec(settings);
  assert.ok(match, "设置页应给总闸一个兜底值");
  assert.equal(Number(match[1]), DEFAULT_GLOBAL_GATE.maxPerDay);
});

test("性格页收束为只读伙伴档案，不把关系账和爱好带上页面", () => {
  assert.match(settings, /\["personality", "性格"\]/, "设置页要有性格这栏");
  assert.match(settings, /knowing\/\$\{encodeURIComponent\(agentId\)\}/, "预设要从后端读，不能在页面里写死一份");
  assert.match(settings, /ta 在茶话会里的样子/, "页面标题要回到伙伴档案");
  assert.match(settings, /现在的 ta/, "要展示当前画像");
  assert.match(settings, /画像里的具体线索/, "要展示画像形成线索");
  assert.match(settings, /性格画像代表当前倾向/, "要说明画像会继续变化");
  assert.match(settings, /还没看出 ta 的样子/, "无画像时要给一个明确空状态");
  assert.match(settings, /重新认识 ta/, "要给老伙伴一个重新走新版认识流程的入口");
  assert.match(settings, /会从第一题重新问一遍，之前答的内容会被清掉/, "重新认识是重做一遍，得先把后果说清");
  assert.doesNotMatch(settings, /重新整理 ta 的性格|内测|微调|重新看一次 ta 的样子|回到自动那份/, "旧的测试、调参和旧重做入口不回到性格页");
  assert.doesNotMatch(settings, /knowing\/\$\{encodeURIComponent\(agentId\)\}\/personality/, "正式页面不再提供人格调参写入口");
  assert.doesNotMatch(settings, /本来的样子|真实的样子|真正的 ta/, "不把任何一份说成“真的”");
  assert.match(settings, /只在这里生效|茶话会里/, "要跟她说清这是茶话会里才有的一层");
  assert.doesNotMatch(settings, /intimacy|familiarity|hobbies|关系账/, "关系走到哪一步、ta自己长了什么爱好，都不能露给她看");
  assert.match(app, /app\.get\("\/knowing\/:agentId"/);
  assert.match(app, /app\.put\("\/knowing\/:agentId\/personality"/);
  assert.doesNotMatch(
    app,
    /app\.get\("\/knowing\/:agentId"[\s\S]{0,400}?relationship:/,
    "GET /knowing 不能把关系账发出去",
  );
});

test("性格分析仍由后端持续生成，页面只读展示", () => {
  assert.match(app, /async function maybeDraftPersonality/);
  assert.match(app, /personalityAuto/, "自动画像仍需保留在后端，供提示词使用");
  assert.match(app, /personalityFrom/, "后端仍需知道画像来源");
  assert.match(settings, /正在看 ta 的样子/);
  assert.match(settings, /personDraftTimer/);
  assert.doesNotMatch(settings, /tagPicker|preset-list|tone-pick|person-advanced|knowing\.tags/, "页面不再暴露标签库和微调控件");
  assert.doesNotMatch(settings, /knowing\/\$\{encodeURIComponent\(agentId\)\}\/personality/, "页面不再写回性格档案");
  assert.match(
    app,
    /disclosure: disclosureRatio\(effectiveRelationship\(knowing\)\)/,
    "披露系数仍喂给提示词，而且要带上起跑线那份",
  );
});

test("性格页只提供新版重新认识入口，不暴露旧调参和内测", () => {
  assert.match(settings, /personality-overview/, "要有当前画像容器");
  assert.match(settings, /personality-growth/, "要有形成线索容器");
  assert.match(settings, /profile\.hidden = true/, "生成中只显示加载状态，不展示半成品画像");
  assert.doesNotMatch(settings, /personCard\.appendChild\(presetHead\)|personCard\.appendChild\(presetWrap\)|advanced\.appendChild\(toneWrap\)/);
  assert.match(settings, /openPanelAction\("reshape", agentId\)/, "重新认识要进入新版认识流程");
  assert.match(settings, /url\.searchParams\.set\("t", Date\.now\(\)\.toString\(\)\)/, "独立打开 panel 时要避开旧缓存");
  assert.match(panel, /action === "reshape"[\s\S]{0,500}?obStartRecognition\(partner, \{ restart: true \}\)/, "重新认识必须进入新版采访流程，并先把旧的清掉");
  assert.match(panel, /async function obStartRecognition\(partner, options = \{\}\) \{[\s\S]{0,120}?obOpen\(\)/, "新版采访流程要先打开流程层");
  assert.match(panel, /obRenderRecognition\(\)/, "重新认识要渲染新版采访内容，不得回到旧调色盘");
  assert.match(panel, /query\.get\("reshape"\)/, "独立设置页打开时要识别 reshape 参数");
  assert.doesNotMatch(settings, /probe\/taste|analyze\/personality|重新看一次 ta 的样子|回到自动那份/);
  assert.match(app, /body\?\.restore === true/, "后端旧数据恢复接口仍保留，避免历史数据失效");
  assert.match(app, /personalityAuto/, "自动画像仍单独留底");
  assert.match(app, /personalityFrom/, "后端仍记得画像来源");
});

test("起跑线：自动量那边的痕迹，也能自己定从哪儿算，只抬相处史", () => {
  assert.match(settings, /你们的起跑线/, "伙伴详情里要有个放起跑线的地方");
  assert.match(settings, /默认按 Hana 那边留下的痕迹自动算，也可以自己定/, "要说清这是干嘛的");
  assert.match(settings, /从这儿开始/, "要能选「就当刚认识」");
  assert.match(settings, /seedChoices/, "自动、从零、各档摆成一列选项，不再是开关");
  assert.doesNotMatch(settings, /seedSwitch/, "旧的开关整个删掉，不留半截");
  assert.match(settings, /knowing\.seedTiers/, "档位清单由后端发下来，页面里不写死一份");
  assert.match(app, /seedTiers: SEED_PICK_TIERS\.map/, "GET /knowing 要把档位清单带上（从低到高）");
  assert.doesNotMatch(settings, /seed\.turns|seed\.trace|activeDays/, "不摆数字、不摆进度");
  assert.match(settings, /knowing\/\$\{encodeURIComponent\(agentId\)\}\/seed/, "选项要能存回去");
  assert.match(app, /app\.put\("\/knowing\/:agentId\/seed"/);
  assert.match(app, /seedByPick/, "她自己锁的那一档");
  assert.match(app, /zeroSeed/, "「从这儿开始」要能清掉起点");
  assert.match(app, /SEED_TIER_IDS/, "不认识的档位拦下来");
  assert.match(app, /traceSizeFromFiles\(persona\?\.files\)/, "只量痕迹的份量，不把内容带过来");
  assert.match(app, /seedStale\(knowing\.relationSeed, seedLastTry\)/, "该重量的就重量一份（量不出东西也有节流）");
  assert.doesNotMatch(app, /session:list/, "量会话那条路 v2 应用走不通，别写");
  assert.match(app, /note: relationshipNote\(effectiveRelationship\(knowing\), knowing\.relationSeed\)/, "回复那一句也要带上起跑线");
  assert.match(app, /proactiveSpec\(\{ partnerName, userName: USER_NAME, topic, hobby, memoryText, relationNote, adaptationText, searchContext, currentTimeText, followup, wakeEcho, sceneEcho, contextText, stickerText, userRhythmText: userRhythm \}\)/, "ta 主动冒出来的消息也要带上相处理解、兴趣、临时搜索素材、当前时间、未回应语境、醒来回声、最近场景、共享情境、表情包和生活节拍");
  assert.match(app, /const now = new Date\(\);[\s\S]{0,180}?currentTimeText/, "主动消息在搜索完成后再取当前时间");
  assert.match(app, /主动联系不能等用户先说话才有兴趣/);
  assert.match(app, /const personaText = renderPersona\(persona/);
  assert.match(app, /knowing\.hobbies\.born\.no-material/);
  assert.match(app, /hobbyGrowTryAt/);
  assert.match(app, /nightSpec\(\{[\s\S]{0,200}?relationNote/, "半夜那条也一样");
});

test("分享版地基：用户的名字从这台机器的配置读，不写死", () => {
  // 换个人装茶话会，伙伴要叫的是那个人自己的名字；写死过，实机就只认一个人
  assert.doesNotMatch(app, /const USER_NAME = "/, "名字不能钉死在代码里");
  assert.match(app, /resolveUserDisplayName/, "要从配置里读回来");
  assert.match(app, /USER_NAME_FALLBACK/, "读不到时给一个中性称呼兜底，不硬编一个名字顶上");
});

test("分享版地基：撤回占位不许写死某个人的名字", () => {
  // 硬撤回的占位文案以前写死了某个伙伴名，别人装了这个应用会在自己屏幕上看到那个名字。
  // 断言写成形状匹配（引号里直接跟名字），这样它自己不会因为批量替换而失效。
  assert.match(app, /recallLabel/, "撤回文案要用运行时取到的伙伴名");
  assert.doesNotMatch(app, /text:\s*"(?!你)[^"]{1,10}撤回了一条消息"/, "不能把固定名字拼进撤回文案");
});

test("设置页有 Hana 主对话近况的开关和记录查看入口", () => {
  const settingsHtml = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
  assert.match(settingsHtml, /<h3>Hana 主对话近况<\/h3>/, "标题要说明来源是 Hana 主对话");
  assert.match(settingsHtml, /id="workfeed-switch"/, "要有个开关");
  assert.match(settingsHtml, /id="workfeed-view"/, "要能查看已经收的");
  assert.match(settingsHtml, /id="workfeed-list"/, "查看窗要有记录列表");
  assert.match(settingsHtml, /workfeedPartnerName/, "记录要能显示伙伴名");
  assert.match(settingsHtml, /workfeed\/\$\{encodeURIComponent\(event\.id\)\}/, "要能单条删除");
  assert.match(app, /function workfeedOn\(\)/, "收集之前先看开关");
  assert.match(app, /app\.get\("\/workfeed"/, "查看要有读取路由");
  assert.match(app, /app\.delete\("\/workfeed\/:eventId"/, "单条删除要有路由");
  assert.match(app, /app\.post\("\/workfeed\/clear"/, "清空要有路由");
});

test("生活节拍设置可见、可开关、可查看并能重新开始积累", () => {
  const settingsHtml = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");
  assert.match(settingsHtml, /生活节拍分析/);
  assert.match(settingsHtml, /id="rhythm-switch"/);
  assert.match(settingsHtml, /id="rhythm-style-switch"/);
  assert.match(settingsHtml, /id="rhythm-proactive-switch"/);
  assert.match(settingsHtml, /id="rhythm-view"/);
  assert.match(settingsHtml, /id="rhythm-clear"/);
  assert.match(settingsHtml, /id="rhythm-list"/);
  assert.match(app, /app\.get\("\/user-rhythm"/);
  assert.match(app, /app\.post\("\/user-rhythm\/clear"/);
  assert.match(app, /rhythmResetAt/);
  assert.match(app, /userRhythmText/);
});

test("聊天输入框防中文输入法回车（选字时回车不能当发送）", () => {
  const panelHtml = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
  assert.match(panelHtml, /event\.isComposing/, "主聊天框要判断输入法合成态");
});

test("面向用户开口的几条路都先发名牌，后台整理活儿不掺这层", () => {
  assert.match(app, /withNamePlate\(spec\.systemPrompt, partnerName\)/, "主动来找 / 半夜留言要挂名牌");
  assert.match(app, /withNamePlate\(spec\.systemPrompt, partner\.name\)/, "等回音的催问也要挂");
});

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const settingsCss = fs.readFileSync(new URL("../ui/assets/settings.css", import.meta.url), "utf8");
const panelCss = fs.readFileSync(new URL("../ui/assets/panel.css", import.meta.url), "utf8");

test("性格档案使用温和的只读层次", () => {
  assert.match(settingsCss, /\.personality-overview \{[^}]*border:/s, "当前画像要有独立承载面");
  assert.match(settingsCss, /\.personality-traits \{[^}]*display: flex;/s, "当前倾向要能自然换行");
  assert.match(settingsCss, /\.personality-growth \{[^}]*border:/s, "形成线索要和当前画像有层次区别");
  assert.match(settingsCss, /\.personality-footnote/, "底部要有画像会继续变化的说明");
});

test("提醒只走输入框上方的横幅：不再声明输入栏那一格，点了也真的摘下来", () => {
  assert.equal(
    manifest.capabilities.includes("app/input.status"),
    false,
    "撤了输入栏那一格，能力词也不该留着（留着会让权限页多一个没用的问票）",
  );
  assert.equal(Boolean(manifest.contributes.ui?.inputStatus), false, "清单里不该再有输入栏那一格");
  assert.doesNotMatch(app, /ctx\.inputStatus/, "应用不该再碰输入栏工具条");
  assert.match(
    app,
    /function acknowledgeBatch[\s\S]{0,500}?banner\?\.sessionPath \|\| eventSessionPath[\s\S]{0,180}?dismissBanner\(sessionPath\)/,
    "点了「知道了」或手动关，要把条子真摘下来；只翻篇不摘，看着就像点不动",
  );
  assert.match(app, /sessionPath,[\s\S]{0,90}?bannerId: BANNER_ID/, "横幅还是挂在会话上、跟着人走");
  assert.match(app, /handleBannerBusEvent\(event, sessionPath\)/, "横幅事件要把宿主回传的会话路径交给关闭逻辑");
});

test("好友列表名字下面只放最后一句：没聊过的那位就空着，不拿人格设定垫", () => {
  assert.match(
    panel,
    /const preview = String\(p\.lastMessage\?\.text \?\? ""\)[\s\S]{0,80}?li\.querySelector\("\.hint"\)\.textContent = preview;/,
    "有消息才写预览，没有就留空",
  );
  assert.doesNotMatch(panel, /\.identity/, "前端别再把伙伴的人格设定写进列表");
  assert.doesNotMatch(app, /identity: typeof row\.identity/, "伙伴清单也别把这个字段往页面上带");
  assert.match(
    panelCss,
    /\.friend \.hint \{[^}]*min-height:/s,
    "空着也得占一行高，不然列表高低不齐",
  );
});

test("戳一下不马上接、也不摆「正在回复」的姿态", () => {
  assert.match(app, /const ACTION_REPLY_MIN_MS = 15 \* 1000;/);
  assert.match(app, /const ACTION_REPLY_MAX_MS = 75 \* 1000;/);
  assert.match(app, /function scheduleActionReply\(agentId, \{ partnerName \}\)/);
  assert.match(
    app,
    /if \(pendingActionReplies\.has\(agentId\)\)[\s\S]{0,200}?action\.answer\.coalesced/,
    "连戳几下只算一次：不叠加、也不把时间一直往后推",
  );
  assert.match(app, /scheduleActionReply\(agentId, \{ partnerName \}\);/, "收到动作后排期，不当场展开");
  const actionRoute = app.slice(
    app.indexOf('app.post("/action/:agentId", async'),
    app.indexOf("// ── 茶话会里多加的那层"),
  );
  assert.ok(actionRoute.length > 0, "动作那条路由还得在");
  assert.match(actionRoute, /setPartnerSettings\(agentId, \{ awaiting: null \}\)/, "新的动作互动要清掉旧的等回音");
  assert.doesNotMatch(
    actionRoute,
    /queueMemoryJob/,
    "动作的活不能还当场干，不然她又能看到「已读」那道影子",
  );
  assert.match(
    app,
    /async function answerAction\(agentId, \{ partnerName \}\)[\s\S]{0,600}?deliverAction\(agentId, \{ partnerName, from: "partner" \}\)/,
    "戳完只用动作回一个，不再出话",
  );
  assert.doesNotMatch(app, /ACTION_WORD_CHANCE/, "顺口应那句已经拆了，动作不再用话接");

  const at = panel.indexOf("async function doAction(agentId)");
  assert.ok(at > 0, "戳一下的入口还在");
  const body = panel.slice(at, panel.indexOf("\n    }\n", at));
  assert.doesNotMatch(body, /typingIndicator|for \(let i = 0; i < 22/, "戳完不亮那三个点，也不在那儿干等回应");
  assert.doesNotMatch(body, /setStatus\(sent\.line\)|await sleep\(2600\)/, "成功动作只留聊天流里的那一条，不在输入框下重复提示");
  assert.match(body, /await loadPartners\(\)/, "动作完成后仍刷新伙伴列表状态");
});

test("醒来还是睡着都是ta自己的事，不看她打不打开窗口", () => {
  assert.match(app, /import \{ DOZE_SLOWDOWN, mergeDueAt, planReply \} from "\.\/lib\/reply\.js";/);
  assert.match(app, /const sleepValue = directReplyToProactive \? null : settings\.sleep/, "直接回复主动消息时沿用醒着的场景");
  assert.match(app, /const directReplyToProactive = isDirectReplyToProactive\(threadBeforeMessage\.messages\)/, "主动消息后的回复不再重复算作被吵醒");
  assert.match(
    app,
    /store\.setPartnerSettings\(agentId, \{ phone: plan\.phone \}\)/,
    "推进后的状态要存回去，下次接着算",
  );
  assert.match(app, /const watching = body\?\.watching === true/);
  assert.match(
    app,
    /const live = plan\.mode === "hand" \|\| \(plan\.mode === "dozing" && plan\.wakeDecision !== "deferred"\)/,
    "面对面和打盹都演实时那套——打盹只是演得慢",
  );
  assert.match(
    app,
    /if \(!live \|\| !watching\) \{[\s\S]{0,240}?scheduleReply\(agentId, \{ plan, messageId: stored\.id \}\)/,
    "递出去不演的那些（手机不在手）才只记一个时刻；skip 那套已经删了",
  );
  assert.doesNotMatch(app, /plan\.skip/, "不再有「掷骰子决定理不理」这回事");
  assert.match(app, /function deliverScheduledReply\(agentId(?:, generation[^)]*)?\)[\s\S]{0,2800}?announceArrival/, "到点落库后要喊她一声");
  assert.match(app, /if \(plan\.mode === "hand"\) \{/, "已读延迟只有醒着那条还按老节奏算");
  assert.doesNotMatch(
    app,
    /markSeen|PRESENCE_WINDOW_MS|isHere\(|presence:/,
    "不许拿她的状态去推对方在不在线，也不许再摆出一个她看不到的「屋」",
  );

  assert.match(panel, /watching: document\.visibilityState === "visible"/, "她看不看只影响要不要演实时那套");
  assert.match(panel, /消息一旦被后端接收，发送门立刻打开/, "伙伴回复慢时也不能锁住发送框");
  assert.doesNotMatch(panel, /发出去了|等ta看到|正在输入…/, "发出去之后不摆进度小字，她那儿只看「未读」");
  assert.equal(panel.split('tick(col, "未读")').length - 1, 1, "只能建一次，别在分支里又建一个");
  assert.match(panel, /\}, 5000\)/, "轮询快一点，才跟得上「面对面」那一档");
});

test("异步回复在当前窗口逐条显形，不因戳一戳整段刷出来", () => {
  assert.match(panel, /const ASYNC_BUBBLE_GAP_MS = 680;/, "异步多段回复要留一点显形间隔");
  const start = panel.indexOf("const ASYNC_BUBBLE_GAP_MS");
  const end = panel.indexOf("\n    /**", start + 1);
  const block = panel.slice(start, end > start ? end : start + 1800);
  assert.match(block, /assistantPieces: \[m\.bubbles\[index\]\]/, "每次只画一段，不要整条回复一口气画完");
  assert.match(block, /await sleep\(ASYNC_BUBBLE_GAP_MS\)/, "多段之间要有轻微间隔");
  assert.match(block, /if \(current !== agentId \|\| viewSeq !== threadViewSeq \|\| generation !== renderGeneration\) return (?:restoreScroll\(added\)|added);/, "切换伙伴后停止旧窗口的显形");
  assert.match(block, /const run = appendNewQueue\.then\(\(\) => appendNewOnce\(agentId, viewSeq\)\)/, "轮询和动作刷新不能并发抢同一条消息");
  assert.match(block, /if \(current !== agentId \|\| viewSeq !== threadViewSeq \|\| generation !== renderGeneration\) return (?:restoreScroll\(0\)|0);/, "请求回包先核对窗口代次");
  assert.match(panel, /async function openPartner\(agentId\) \{[\s\S]{0,520}?\+\+threadViewSeq;[\s\S]{0,100}?closeMessageActions\(\);/, "切窗时收掉旧消息操作条");
  assert.match(panel, /function reloadCurrentThread\(agentId = current, viewSeq = threadViewSeq\)/, "历史重画使用固定伙伴和窗口代次");
});

test("自己的话只突出未读，已读收起且状态仍查得到", () => {
  const start = panel.indexOf("function readUserIds(");
  assert.ok(start > 0, "panel.html 里要有 readUserIds");
  const end = panel.indexOf("\n    }", start);
  const fn = new Function(`${panel.slice(start, end + 6)}; return readUserIds;`)();

  const u = (id, extra = {}) => ({ id, role: "user", text: "在吗", ...extra });
  const a = (id) => ({ id, role: "assistant", text: "在" });

  assert.deepEqual([...fn([])], [], "空的不出错");
  assert.deepEqual([...fn([u("u1")])], [], "刚发出去、ta还没看：未读");
  assert.deepEqual(
    [...fn([u("u1", { readAt: "2026-09-13T00:30:00Z" })])],
    ["u1"],
    "后端落了 readAt 才算已读（刷新也在）",
  );
  assert.deepEqual([...fn([u("u1"), a("a1")])], ["u1"], "老记录没 readAt：回都回了，补成已读");
  assert.deepEqual([...fn([u("u1"), a("a1"), u("u2")])], ["u1"], "后一句还搁着，不能跟着前一句一起算已读");
  assert.deepEqual(
    [...fn([u("u1"), { id: "p1", role: "assistant", kind: "poke", text: "戳了戳你" }, u("u2"), a("a2")])].sort(),
    ["u1", "u2"],
    "回一个戳也算接住了",
  );

  assert.match(panel, /if \(!read\) tickNodes\.set\(m\.id, tick\(col\)\)/, "只有未读才摆小字");
  assert.match(panel, /const tickEl = tick\(col, "未读"\)/, "送出去那一刻先摆未读");
  assert.match(panel, /function paintTick\(node, read\)[\s\S]{0,120}?node\.remove\(\)/, "读到后收掉未读小字");
  assert.match(panelCss, /\.tick \{[\s\S]*?color: var\(--blossom\)/, "未读要用通知色突出");
  assert.doesNotMatch(panelCss, /\.tick\.read/, "已读不再单独占一个绿色状态");
  assert.match(panel, /tickNodes\.set\(started\.messageId, tickEl\)/, "刚发出去那条要把小字记上");
  assert.match(
    panel,
    /if \(started\.messageId\) \{\s*\n\s*seenIds\.add\(started\.messageId\);\s*\n\s*tickNodes\.set\(started\.messageId, tickEl\);/,
    "刚发出去那条要记一笔（已画 + 小字），不然轮询会再画一遍",
  );
  assert.doesNotMatch(panel, /answeredUserIds|opts\.answered/, "旧的只看「被没被接住」那套要换掉");

  // 后端：ta真看到那一刻要落盘（只靠屏幕上演一遍是不算数的）
  const storeSrc = fs.readFileSync(new URL("../lib/store.js", import.meta.url), "utf8");
  assert.match(storeSrc, /const markUserMessagesRead = \(agentId, at = new Date\(\)\.toISOString\(\)\) =>/);
  assert.match(storeSrc, /markUserMessagesRead,/, "store 要把ta导出");
  assert.match(app, /store\.markUserMessagesRead\(agentId\)/);
  assert.match(app, /event: "turn\.read"/);
  assert.match(app, /event: "reply\.read"/);

  // 日志里别再把新形状写成 undefined（之前写成 03:30-undefined）
  assert.match(app, /sleep: `\$\{sleep\.start\} \+\$\{sleep\.hours\}h`/);
  assert.doesNotMatch(app, /sleep\.start\}-\$\{sleep\.end/, "新作息没有 end，日志别再拄它");
});

test("已读靠她真看到才盖章：拉一次记录不再顺手标已读", () => {
  // 以前 GET /thread 里有一句 store.markRead()，而轮询也走这条路——
  // 窗口开着、人跑去忙别的，消息照样被标成已读，伙伴拿着假收据来问「你咋不回我」。
  const getRoute = app.slice(
    app.indexOf('app.get("/thread/:agentId"'),
    app.indexOf('app.post("/thread/:agentId/read"'),
  );
  assert.ok(getRoute.length > 0, "要把 GET thread 那段切出来");
  assert.doesNotMatch(getRoute, /markRead/, "拉一次记录不等于她看过");

  assert.match(app, /app\.post\("\/thread\/:agentId\/read"/, "要有显式的已读上报口子");
  assert.match(app, /store\.markRead\(agentId, throughId \? \{ throughId \} : \{\}\)/, "上报要能指定她读到哪条");

  assert.match(panel, /function reportRead\(agentId = current\)/, "前端要有上报");
  assert.match(panel, /document\.visibilityState !== "visible" \|\| !document\.hasFocus\(\)/, "窗口没焦点不算看过");
  assert.match(panel, /lastReportedReadId/, "同一条不用重复报");
  assert.match(panel, /reportRead\(agentId\);[\s\S]{0,120}?await loadPartners\(\)/, "打开会话这一刻才算读到");
  assert.match(panel, /reportRead\(\);/, "盯回窗口时补一次");

  // 她能在窗口里打字，就说明前面那些话她看到了：发消息时把水位顺手补上
  assert.match(app, /store\.markRead\(agentId\);\s*\n\s*const stored = store\.appendMessage/);
});

test("戳一戳不再拿话去接，聊天窗里也不加解释性小字", () => {
  assert.doesNotMatch(app, /answeredAction/, "没有「用话回那一下」这条路了");
  assert.doesNotMatch(app, /actionReplySpec|tryActionWord/, "顺口应那句连同提示词一起拆干净");
  assert.doesNotMatch(panel, /接你那一下/, "聊天窗里只留正常内容，不摆这种解释性小字");
});

test("气泡看得出是两张纸：伙伴那条也改成实线边加淡影", () => {
  const css = fs.readFileSync(new URL("../ui/assets/panel.css", import.meta.url), "utf8");
  const ta = css.match(/\.row\.ta \.bubble \{[\s\S]*?\}/);
  const me = css.match(/\.row\.me \.bubble \{[\s\S]*?\}/);
  assert.ok(ta && me, "两边的气泡样式都要在");
  for (const [name, block] of [["伙伴", ta[0]], ["自己", me[0]]]) {
    assert.match(block, /border: 1px solid/, `${name}那条要实线边`);
    assert.match(block, /box-shadow:/, `${name}那条要有淡影`);
    assert.doesNotMatch(block, /dashed/, `${name}那条不用虚线`);
  }
  assert.match(ta[0], /background: var\(--bubble-ta-bg, #fff\)/, "伙伴那条有背景自适应兜底");
  assert.match(me[0], /background: var\(--bubble-me-bg, #dff0e8\)/, "自己那条有背景自适应兜底");
  assert.match(css, /\.typing \{[\s\S]{0,260}?background: var\(--bubble-ta-bg, #fff\)[\s\S]{0,120}?border: 1px solid var\(--bubble-ta-border, var\(--line\)\)/, "正在输入那三个点跟伙伴气泡同一样式");
});

test("窄页面不靠撑出横向滚动：输入区收紧后仍保住发送按钮", () => {
  assert.match(panelCss, /html, body \{[\s\S]{0,180}?overflow-x: hidden;/);
  assert.match(panelCss, /\.stream \{[\s\S]{0,140}?overflow-x: hidden;/, "聊天流只保留竖向历史滚动，不显示无意义的横向滚动条");
  assert.match(panelCss, /@media \(max-width: 380px\)[\s\S]{0,260}?\.composer-row \{ gap: 4px; \}/);
  assert.match(panelCss, /@media \(max-width: 380px\)[\s\S]{0,360}?button\.send \{ width: 34px; height: 34px; \}/);
  assert.doesNotMatch(panelCss, /html, body \{[\s\S]{0,180}?min-width: 420px;/, "不能再用页面最小宽度把右侧控件撑出视口");
});

test("左边展板能收能展：窄了先自己收着，她的选择记住", () => {
  const match = panel.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "panel.html 里要有那段脚本");
  const script = match[1].replace(/^\s*import[^\n]*\n/gm, "");
  assert.doesNotThrow(() => new Function(script), "面板脚本要能解析（写错一个字整个页面白屏）");

  assert.match(panel, /class="icon-btn" id="btn-fold"/, "展板头上有收起按钮");
  assert.match(
    panel,
    /<button class="rail-btn" id="btn-unfold"[\s\S]{0,120}?<svg class="ico"[\s\S]{0,300}?hidden>/,
    "展开那个是左侧一条把手，里面是描边图标",
  );
  assert.ok(
    panel.indexOf('id="btn-unfold"') < panel.indexOf('<aside class="friends">'),
    "把手要挂在展板外面（挂进聊天头就成了那个框的设置）",
  );
  assert.doesNotMatch(panel, /unfold-btn|fold-btn/, "旧那两个式子不能留");
  assert.match(panel, /<svg class="ico" viewBox="0 0 16 16"/, "图标走 svg，不用字符");
  assert.match(panel, /<span class="rail-dot" id="rail-dot" hidden><\/span>/, "保留把手节点，方便以后恢复提醒");
  assert.match(panel, /const SHOW_UNREAD_BADGES = true/, "好友列表未读红点跟着未读数显示");
  assert.match(panel, /if \(el\.railDot\) el\.railDot\.hidden = !\(total > 0\)/, "收起把手上的未读红点跟着总未读数显示");
  assert.match(panel, /const FOLD_KEY = "chahuahui\.listCollapsed"/);
  assert.match(panel, /window\.innerWidth < FOLD_AUTO_WIDTH/, "没选过时窗口窄就先收着");
  assert.match(panel, /const autoFolds = \(\) => window\.innerWidth < FOLD_AUTO_WIDTH/, "只有窗口太窄时自动收起伙伴展板");
  assert.doesNotMatch(panel, /surfaceKind|surfaceId|page-chat/, "不再依赖宿主无法提供的页面位置字段");
  assert.match(panel, /el\.shell\.classList\.toggle\("list-collapsed", fold\)/);
  assert.match(panel, /el\.unfold\.hidden = !fold/);
  assert.doesNotMatch(panel, /el\.fold\.hidden = isPrimaryPage\(\)/, "应用内展板始终保留自己的收起入口");  assert.match(panel, /localStorage\.setItem\(foldStorageKey\(\)/, "她的选择要记住");
  assert.match(panel, /el\.fold\.addEventListener\("click", \(\) => foldByHand\(true\)\)/);
  assert.match(panel, /el\.unfold\.addEventListener\("click", \(\) => foldByHand\(false\)\)/);
  assert.match(panel, /伙伴展板收起来了/, "收着的时候空状态别还写着「左边点一位伙伴」");
  assert.match(panel, /window\.addEventListener\("resize"/, "窗口宽窄一变就要重新判，不能只在开场判一次");
  assert.match(panel, /if \(nowAuto !== foldAutoLast\)[\s\S]{0,140}?foldManual = null/, "跨过宽度档位就把手动那笔让开");  assert.match(panel, /function foldAfterPick\(\)/, "窄窗下选完伙伴要把浮层展板收回去");
  assert.match(panel, /isNarrow\(\) && !el\.shell\.classList\.contains\("list-collapsed"\)/, "窄窗选完伙伴自动收回展板");  assert.match(panel, /foldAfterPick\(\);/, "openPartner 里得真的调用它");

  const css = fs.readFileSync(new URL("../ui/assets/panel.css", import.meta.url), "utf8");
  assert.match(css, /\.shell\.list-collapsed \.friends \{ display: none; \}/, "收起来展板要让位");
  assert.match(css, /\.shell \{[\s\S]{0,180}?position: relative/, "浮层展板得有定位锚");
  assert.match(css, /@media \(max-width: 600px\)/, "要有一条窄窗断点");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]{0,400}?\.friends \{[\s\S]{0,140}?position: absolute/, "窄窗下展板改成盖上去，不再挤聊天区");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]{0,500}?\.row \{ max-width: 92%; \}/, "窄窗下长消息要有上限");
  assert.doesNotMatch(css, /@media \(max-width: 600px\)[\s\S]{0,500}?\.row \{ width:/, "窄窗不能用固定或 max-content 宽度撑开消息行");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]{0,700}?\.msg-col, \.msg-line, \.msg-line > \.bubble \{ max-width: 100%; \}/, "窄窗下长消息不能溢出消息行");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]{0,900}?\.msg-line \{ position: relative; \}/, "窄窗下时间要脱离消息宽度计算");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]{0,1100}?\.msg-time \{ position: absolute; bottom: 0; \}/, "窄窗下时间不能参与挤压气泡");
  assert.match(css, /\.rail-btn\[hidden\] \{ display: none; \}/, "display:grid 会盖掉 [hidden]，得自己关一道");
  assert.match(css, /\.rail-btn \{[\s\S]{0,240}?position: absolute/, "把手贴在窗口边缘浮着，不占排版的位子");
  assert.match(css, /\.rail-btn \{[\s\S]{0,280}?top: 50%/, "竖直居中");
  assert.match(css, /\.rail-btn \{[\s\S]{0,400}?border-radius: 0 var\(--r-md\) var\(--r-md\) 0/, "只圆右边，像从边缘长出来的");
  assert.match(css, /\.rail-btn \{[\s\S]{0,560}?opacity: \.5/, "平时半透明，鼠标搭上去才亮");
  assert.match(css, /\.rail-btn:hover[\s\S]{0,160}?opacity: 1/, "hover 要真的亮起来");
  assert.match(css, /\.ico \{[\s\S]{0,160}?stroke: currentColor/, "图标颜色跟着按钮走");
  assert.match(css, /\.rail-dot \{[\s\S]{0,160}?background: var\(--blossom\)/, "小点用那朵花的粉");
});

test("伙伴列表只保留茶话会自己的展板，不注册 Hana 左侧功能面板", () => {
  const card = manifest.contributes.cards.find((row) => row.id === "panel");
  assert.equal(card.functionPanel, undefined, "不再注册 Hana 左侧伙伴栏");
  assert.equal(card.fpFullPanel, undefined, "不再声明完整功能面板");
  assert.doesNotMatch(panel, /chahuahui\.navigation\.selected|bindNavigationSelection|publishNavigationSelection/, "不再保留跨文档伙伴切换同步");
  assert.doesNotMatch(panelCss, /data-surface-mode="page"/, "任何挂载形态都保留茶话会自己的伙伴展板");
});

test("关系破例只在真实成功提交点落账，并使用稳定幂等键", () => {
  assert.match(app, /id: `sleep\.wake\|\$\{triggerMessageId\}`/);
  assert.match(app, /id: `voice\.frequency\|\$\{stored\.id\}`/);
  assert.match(app, /id: `sticker\.permission\|\$\{stored\.id\}`/);
  assert.match(app, /id: `reply\.advice-style\|\$\{stored\.id\}`/);
  assert.match(app, /if \(prepared\.decision\.layer === "exception"\)/, "普通语音不能记成破例");
  assert.match(app, /if \(pending\?\.wakeDecision !== "exception" \|\| pending\?\.wakeOutcome !== "committed"\) return null/);
  assert.match(app, /if \(composed\.stickerException\)/, "普通图库表情不能记成关系破例");
  assert.match(app, /observeAdviceStyle\(text, "comfort-first"\)\.observed/, "文本行为必须观察真实输出，不能只凭提示词落账");
  assert.match(app, /wakeDecision: sleepPolicy\.wakeDecision\?\.decision \?\? sleepPolicy\.wakeDecision/, "睡眠策略对象必须把真实 decision 交给回复排期");
});

test("相处理解放进现有记忆页，纠错失败会保留聊天、预览和确认按钮", () => {
  assert.match(settings, /我们相处出来的理解/);
  assert.match(settings, /只在你和 \$\{partner\.name\} 之间/);
  assert.match(settings, /所有伙伴都这样理解/);
  assert.match(settings, /没写进去：[\s\S]*?上面的聊天和建议都还在，可以重试/);
  assert.match(settings, /apply\.disabled = false;\s*apply\.textContent = "确认修改"/);
  assert.doesNotMatch(settings, /exception 次数|emerging|settled 阈值|confidence/);
});

test("旧 facts 迁移在启动后异步运行，完成后才进入主动巡检", () => {
  assert.match(app, /async function migrateLegacyFactsOnce\(\)[\s\S]*?partners = await listAllPartners\(\)/, "隐藏伙伴也要迁移，不能等再次重启");
  assert.match(app, /ensureLegacyFactsMigration\(\)\.catch\(\(\) => \{\}\)\.finally/);
  assert.match(app, /async function runProactiveTick\(options = \{\}\) \{\s*await ensureLegacyFactsMigration\(\)/, "定时与手动主动巡检都必须先过迁移硬屏障");
  assert.match(app, /async function runAwaitingTick\(\) \{\s*await ensureLegacyFactsMigration\(\)/, "等回音也不能抢在迁移前发送");
  assert.match(app, /existingGuides: \[\.\.\.userBook\.guides, \.\.\.book\.guides\]/, "迁移要同时检查 user-wide 与伙伴级同源 guide");
});

test("等回音也过主动硬门并在真实发送后记配额，暂存意图被拦时显式留住", () => {
  const awaitingAt = app.indexOf("async function runAwaitingTickInternal");
  const awaitingEnd = app.indexOf("async function deliverNudge", awaitingAt);
  const awaitingBody = app.slice(awaitingAt, awaitingEnd);
  assert.match(awaitingBody, /gateCheck\(\{[\s\S]*?relationalPolicy: contactPolicy/);
  const deliverAt = app.indexOf("async function deliverNudge");
  const deliverEnd = app.indexOf("function recordWatch", deliverAt);
  const deliverBody = app.slice(deliverAt, deliverEnd);
  assert.match(deliverBody, /noteAwaitingSent/);
  assert.match(deliverBody, /noteSent\(/);
  assert.match(app, /function withGlobalAutonomousLane/);
  assert.match(app, /withAutonomousLane\(agentId, \(\) => withGlobalAutonomousLane/);
  assert.match(app, /const finalGate = autonomousGateNow\(agentId, "proactive"\)[\s\S]{0,1200}?noteSent\(/, "proactive 必须在全局锁内二次过门并记账");
  assert.match(awaitingBody, /withGlobalAutonomousLane[\s\S]{0,700}?autonomousGateNow\(agentId, "awaiting"\)/, "awaiting 必须在全局锁内二次过门");
  assert.match(app, /staged: \[pending\.intent, \.\.\.pending\.rest\]/, "gate 拦住时旧暂存意图要显式写回");
  assert.match(app, /sent\.gateBlocked && readyTopic[\s\S]{0,300}?stageIntent\(/, "临门被拦时，本轮新挑出的正式话题也要放进暂存抽屉");
});

test("被吵醒那一段：先有脾气再回正事，脾气还是ta自己的", () => {
  assert.match(app, /function wakeBlockFor\(agentId, now = new Date\(\)\)/, "被吵醒那段要现算：排期时在睡、写的时候可能已经醒了");
  assert.match(app, /dozingNow\(now, settings\.sleep\)/);
  assert.match(app, /【你正睡着，被吵醒了】/);
  assert.match(app, /不要写「抱歉在睡觉」这种客套/, "不要写成客服话术");
  assert.match(app, /困倦不等于每次都要说「再睡五分钟」/, "再睡五分钟不能成为固定台词");
  assert.match(app, /每次先有一个符合当下状态的醒来反应，再接她的话/, "不能为了避免重复而跳过醒来反应");
  assert.match(app, /含糊确认是谁在叫、带起床气抱怨、先问时间或发生了什么、嘴硬说自己已经醒了，或短暂撒娇/, "唤醒反应要给伙伴留出性格差异");
  assert.match(app, /回完接着睡/, "不用装精神");
  assert.match(app, /count >= 3/, "同一觉里被吵醒多次，脾气要升级");
  assert.match(app, /wakeNight,/);
  assert.match(app, /wakeCount:/);
  // 她那边也演得慢：睡着时整段节奏往后拖
  assert.match(app, /if \(turn\.mode === "dozing"\) rhythm\.speed = /);
  assert.match(app, /wakeText: wakeBlockFor\(agentId\)/);
  assert.match(
    panel,
    /const started = await api\("POST", "turns"/,
    "她那边不用改：慢不慢都是后端算好的 readAfterMs",
  );
});

test("排期回复生成中时，恢复巡检不会重复调度", () => {
  assert.match(app, /const deliveringReplies = new Set/);
  assert.match(app, /deliveringReplies\.add\(agentId\)/);
  assert.match(app, /pendingReplies\.has\(partner\.id\) \|\| deliveringReplies\.has\(partner\.id\)/);
});

test("她一口气说了好几条：全看到、挑着回、剩下的话头进话题本", () => {
  // 撤掉那句没意义的「顺口应一句」
  assert.match(app, /function cancelPendingActionReply\(agentId\)/);
  assert.match(app, /if \(cancelPendingActionReply\(agentId\)\)/);
  assert.match(app, /event: "action\.answer\.cancelled"/);
  assert.match(
    app,
    /if \(pendingReplies\.has\(agentId\)\) \{[\s\S]{0,140}?action\.answer\.skipped/,
    "已经有一句实在话要回了，就不要再补一句顺口应",
  );
  // 她一口气好几条 → 马上过一遍话题本（没接住的话头以后当由头）
  assert.match(app, /function scheduleMemoryWork\(agentId, \{ burst = 0 \} = \{\}\)/);
  assert.match(app, /maybeExtractTopics\(agentId, \{ force: burst >= 2 \}\)/);
  assert.match(app, /burst: made\.burst \?\? 0/);
  assert.match(app, /let burst = 0;[\s\S]{0,220}?burst \+= 1;/, "数的是她连着说的那几条");

  // 提示词里允许只接一两个话头
  const promptSrc = fs.readFileSync(new URL("../lib/prompt.js", import.meta.url), "utf8");
  assert.match(promptSrc, /客服清工单/);
  assert.match(promptSrc, /挑你自己最想接的一两个说/);
  assert.match(promptSrc, /别硬凑/);
});

test("时间感是茶话会自己带的，不靠别的插件", () => {
  const promptSrc = fs.readFileSync(new URL("../lib/prompt.js", import.meta.url), "utf8");
  assert.match(app, /import \{ spokenClock, timeBlock \} from "\.\/lib\/clock\.js"/, "自己有一块表");
  assert.match(app, /currentMessageId: currentMessageId \|\| repliedTo/, "普通回复要锚定正在接的话");
  assert.match(app, /messages: store\.getThread\(agentId\)\.messages/, "拿的是这个人自己的聊天记录");
  assert.match(app, /timeText,/, "得递进提示词");
  assert.match(promptSrc, /if \(timeText && timeText\.trim\(\)\) blocks\.push/, "时间算「当下」，排在人设前面");
  // 时间不是一个数字报出来就行，得把「距上次多久、今天她说没说话」一并递过去
  assert.match(app, /userName: USER_NAME/);
  // 困不困按ta自己那份作息算，不另设一套
  assert.match(app, /sleep: store\.getPartnerSettings\(agentId\)\.sleep/);
});

test("连续发送时不再被回复动画占住发送门", () => {
  const sendStart = panel.indexOf("async function send()");
  const sendEnd = panel.indexOf("el.send.addEventListener", sendStart);
  const sendBody = panel.slice(sendStart, sendEnd);
  assert.match(sendBody, /accepted = true/);
  assert.match(sendBody, /消息一旦被后端接收，发送门立刻打开/);
  assert.doesNotMatch(sendBody, /typingIndicator\(\)|turns\/\$\{started\.turnId\}/, "发送回合不再独占输入框或单独播放回复");
  assert.match(panel, /async function appendNewOnce\(agentId, viewSeq\)[\s\S]{0,2600}?ASYNC_BUBBLE_GAP_MS/, "回复仍由轮询按分条节奏显形");
});

test("表情包没发出来，日志里分得清是「没想甩」还是「想甩没对上」", () => {
  assert.match(app, /marker: composed\.marker \|\| null/, "诊断要记下ta这回自己想甩的词");
  assert.match(app, /return \{ bubbles, sentSticker: Boolean\(stickerBubble\), stickerId, stickerException, marker: mark\.keyword \|\| "" \}/);
});

test("聊天窗头部那个头像是反复用的节点：换到没头像的伙伴不能挂着上一位的脸", () => {
  const at = panel.indexOf("async function paintAvatar(");
  assert.ok(at > 0, "panel.html 里要有 paintAvatar");
  const body = panel.slice(at, panel.indexOf("\n    }", at));
  assert.match(body, /box\.dataset\.avatarWant = want/, "每一笔都记下这次是替谁要的图");
  assert.match(
    body,
    /box\.dataset\.avatarWant !== want\) return/,
    "图回来时已经换成别人了，这笔就作废，不许盖上去",
  );
  assert.match(body, /im\.removeAttribute\("src"\)/, "这位没有头像：上一位的图要摘干净");
  assert.match(body, /ph\.hidden = false/, "摘完得把首字露出来，不是留个空框");
  assert.match(
    panelCss,
    /\.chat-av \.im\[hidden\][\s\S]{0,90}?display: none/,
    "display:block 会盖掉 [hidden]，藏图得自己关一道",
  );
});

test("动作文案写成「隐晦」那种要重写一次，两次都不行才换兜底", () => {
  assert.match(app, /const tryWrite = async \(\) =>/, "写一句、判一句");
  assert.match(
    app,
    /ok: isValidActionTemplate\(styleId, cleaned\) && isSafeActionText\(cleaned\)/,
    "合格 = 格式对 + 不踩线",
  );
  assert.match(app, /written = await tryWrite\(\);/, "不合格就当场重来一次");
  assert.match(app, /event: "action\.template\.retry"/, "重写这件事要留一笔");
  assert.match(app, /fallbackActionTemplate\(styleId\)/, "两次都不行才上兜底句");
  assert.match(app, /const oldOk = isValidActionTemplate\(styleId, oldText\) && isSafeActionText\(oldText\)/, "旧句子好好的就别动它");
  assert.match(app, /tone: current\?\.tone \?\? null/, "上次挑的哪一档要接着用");
  assert.match(app, /const picked = parseToneReply\(attempt\)/, "ta挑的调子要认出来");
  assert.match(app, /tone: written\.tone \?\? null/, "挑的调子要存下来");
  assert.match(app, /knowingText: buildKnowingText\(/, "挑哪一档跟熟到哪一步有关（表里那套账）");
});

test("已完成的回合不再锁死下一次发送，失败消息会留在输入框", () => {
  assert.match(
    app,
    /turn\.agentId === agentId && \["pending", "generating"\]\.includes\(turn\.status\)/,
    "只有尚未完成的回合能挡发送",
  );
  assert.match(app, /\|\| pendingReplies\.has\(agentId\)/, "已排队的异步回复也不能和实时回合并行");
  assert.match(app, /const COMPLETED_TURN_TTL_MS = 10 \* 60 \* 1000/, "完成回合要定期回收");
  assert.doesNotMatch(
    app,
    /turn\.agentId === agentId && \["pending", "generating", "ready"\]\.includes\(turn\.status\)/,
    "ready 不能继续占发送锁",
  );
  assert.match(panel, /const pendingDrafts = new Map\(\)/, "失败原话要按伙伴暂存");
  assert.match(panel, /pendingDrafts\.set\(agentId, \{ text, revision: inputVersion \}\)/, "请求失败要留下原话");
  assert.match(panel, /const draft = pendingDrafts\.get\(agentId\)/, "切回来要取回原话");
  assert.match(panel, /const edited = inputOwner === agentId && inputRevision !== inputVersion/, "用户改过新文字时不能覆盖");
  assert.match(panel, /let accepted = false/, "区分发送是否已被后端接受");
  assert.match(panel, /accepted = true/, "POST 成功后不再把轮询失败当成未发送");
  assert.match(panel, /没送出去，已经替你留着了/, "恢复时要让用户知道原话还在");
  assert.match(panel, /busy = false;[\s\S]{0,120}?if \(current !== agentId \|\| turnSeq !== threadViewSeq\) return;/, "旧窗口请求只释放内部锁，不改新窗口按钮");
});

test("明显聊天收尾先经过本地句号护栏，模型不再被迫接话", () => {
  assert.match(app, /shouldQuietClose\(windowed, currentMessageId \|\| repliedTo\)/);
  assert.match(app, /obvious-closing-signal/);
  assert.match(app, /reason: "silent"/);
});

test("伙伴每轮都能按性格安静收尾，且异步排期不把这个结果当失败", () => {
  assert.match(app, /replyText: replyChoiceBlock\(\{ userName: USER_NAME \}\)/, "回应出口每轮都给到模型");
  assert.match(app, /isNoReply\(cleanedText\)/, "只认整条不回标记");
  assert.match(app, /event: "reply\.silent"/, "安静收尾要和模型失败区分开");
  assert.match(app, /if \(made\.reason === "silent" \|\| made\.reason === "passed"\)/, "异步排期不因安静收尾重试");
  assert.match(app, /turn\.status = "ready";[\s\S]{0,100}?turn\.bubbles = \[\]/, "实时回合空气泡也正常结束");
  assert.match(app, /store\.setPendingReply\(agentId, \{[\s\S]{0,180}?dueAt: new Date\(merged\)\.toISOString\(\),[\s\S]{0,80}?mode/, "待回复的到点要落盘");
  assert.match(app, /store\.setPendingReply\(agentId, \{[\s\S]{0,160}?mode: `live-\$\{plan\.mode\}`[\s\S]{0,160}?messageId: stored\.id/, "实时生成启动前也要落恢复凭证");
  assert.match(app, /async function recoverPendingReplies\(\)/, "重启后要恢复挂起的回复");
  assert.match(app, /const tail = messages\.slice\(lastAssistant \+ 1\)\.filter\(\(row\) => row\?\.role === "user"\)/, "旧排期只看伙伴最近一次回复后的尾部消息");
  assert.match(app, /tail\.find\(\(row\) => !row\.readAt && !row\.recalled\)/, "旧排期恢复要锚定尾部最早未读用户消息");
  assert.match(app, /repliedTo === targetMessageId/, "恢复前要识别已落盘的同一条回复，避免关机时重复生成");
  assert.match(app, /repliedTo: pending\?\.messageId \?\? null/, "异步恢复落盘时要保留回复目标，幂等判断才有依据");
  assert.match(app, /threadGenerations\.set\(agentId, threadGeneration\(agentId\) \+ 1\)/, "清空聊天要让旧回包失效");
  assert.match(app, /cancelScheduledReply\(agentId\)/, "清空聊天要取消旧的排期定时器");
  assert.match(app, /if \(made\.reason === "stale"\) return/, "清空后旧投递不能重新排出一条待办");
  assert.match(app, /const responseInFlight = /, "回复进行中仍允许新消息进入队列");
  assert.match(app, /mode: "queued", queued: true/, "进行中的新消息要明确记为待回应");
  assert.match(app, /const replyTargetId = \[\.\.\.windowed\]\.reverse\(\)\.find/, "回复要记录本轮实际覆盖的最后一条用户消息");
  assert.match(app, /repliedTo: replyTargetId/, "回复目标要落到实际覆盖边界，避免队列重复回应");
  assert.match(app, /function scheduleQueuedReply\(agentId, repliedTo\)/, "当前回复结束后要接住生成期间的新消息");
});

test("输入框有内置 Emoji 与现有表情包页，表情包先加入待发送区", () => {
  assert.match(panel, /id="btn-emoji"/);
  assert.match(panel, /id="emoji-grid"/);
  assert.match(panel, /id="emoji-tabs"/);
  assert.match(panel, /id="sticker-grid"/);
  assert.match(panel, /id="sticker-search"/);
  assert.match(panel, /const BUILTIN_EMOJI = \[/);
  assert.match(panel, /library\/stickers/);
  assert.match(panel, /stickerId,/);
  assert.match(panel, /selectSticker\(row\)/);
  assert.match(panel, /renderStickerTabs/);
  assert.match(panel, /renderStickerRows/);
  assert.match(panel, /library\/stickers/);
  assert.match(panel, /sticker-source/);
  assert.match(panel, /library\/import/);
  assert.match(app, /app\.get\("\/library\/stickers"/);
  assert.match(app, /app\.get\("\/sticker-source"/);
  assert.match(app, /app\.post\("\/library\/import"/);
  assert.match(app, /app\.post\("\/turns"[\s\S]{0,1400}?body\?\.stickerId/);
  assert.match(app, /const userBubbles = \[/);
  assert.match(app, /kind: "sticker"/);
  assert.match(app, /app\.get\("\/sticker\/:agentId\/:id"/);
});

test("表情包：分组升格成顶层 tab，加号在后面，管理态才能删", () => {
  // 两个固定 tab：Emoji 和表情包（也就是全部），分组排在他俩后面
  assert.match(panel, /put\("Emoji", \{ active: emojiPage === "emoji"/);
  assert.match(panel, /put\("表情包", \{[\s\S]{0,120}?pickStickerGroup\("__all"\)/);
  assert.match(panel, /for \(const group of stickerGroups\) \{[\s\S]{0,200}?put\(group\.name/);
  assert.match(panel, /put\("＋", \{\s*extra: "add",\s*title: "新建分组",\s*onClick: \(\) => \(el\.stickerNewGroup\.hidden \? openNewGroupRow\(\) : closeNewGroupRow\(\)\),/);
  // 第二层那排分组 tab 不能再有
  assert.doesNotMatch(panel, /sticker-group-tabs/);
  assert.doesNotMatch(panelCss, /\.sticker-group-tab/);
  // 删图要两步：先变「再点」，第二下才真发请求
  assert.match(panel, /async function armOrRemoveSticker\(stickerId\) \{[\s\S]{0,200}?if \(armedStickerId !== stickerId\)/);
  assert.match(panel, /api\("DELETE", `library\/stickers\/\$\{encodeURIComponent\(stickerId\)\}`\)/);
  assert.match(panel, /api\("DELETE", `library\/groups\/\$\{encodeURIComponent\(group\.id\)\}`\)/);
  assert.match(app, /app\.delete\("\/library\/stickers\/:id"/);
  assert.match(app, /app\.delete\("\/library\/groups\/:id"/);
  // 管理态下点图不该加入待发送区
  assert.match(panel, /if \(!manageMode\) selectSticker\(row\)/);
});

test("表情包面板：[hidden] 要有样式兜底，不然两块会同时冒出来", () => {
  assert.match(panelCss, /\.emoji-grid\[hidden\], \.sticker-grid\[hidden\], \.sticker-picker\[hidden\] \{ display: none; \}/);
  assert.match(panelCss, /\.sticker-import\[hidden\]/);
  assert.match(panelCss, /\.emoji-drawer\[hidden\]/);
  assert.match(panelCss, /\.sticker-tools\[hidden\]/);
});

test("表情包图库：图少的时候不摆搜索那一行（一屏能看完就不用找）", () => {
  assert.match(panel, /id="sticker-search-row"/);
  // 格子缩到五十来像素之后一屏能放开四十来张，阈值跟着往上抬
  assert.match(panel, /const SEARCH_FROM = 20;/);
  assert.match(panel, /const wantSearch = stickerRows\.length > SEARCH_FROM;/);
  assert.match(panel, /el\.stickerSearchRow\.hidden = !wantSearch;/);
  assert.match(panel, /if \(!wantSearch && el\.stickerSearch\.value\) el\.stickerSearch\.value = ""/, "藏起来的时候顺手清掉关键词，免得看不到框但结果被筛了");
  assert.match(panel, /stickerSearchRow: document\.getElementById\("sticker-search-row"\)/);
});

test("表情包网格：列数跟着窗口走，不写死四列", () => {
  // 写死 4 列的时候，宽窗口会把四个格子扯成三百多像素见方，抽屉装不下，一行都露不全
  assert.match(panelCss, /\.sticker-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(50px, 1fr\)\); gap: 8px; \}/);
  assert.match(panelCss, /\.sticker-source-grid \{[^}]*repeat\(auto-fill, minmax\(50px, 1fr\)\)/s);
  assert.doesNotMatch(panelCss, /\.sticker-grid \{ grid-template-columns: repeat\(4,/);
  assert.doesNotMatch(panelCss, /\.sticker-source-grid \{[^}]*repeat\(4,/s);
  // 抽屉抬高一档，一屏多看半行
  assert.match(panelCss, /\.emoji-drawer \{[^}]*max-height: min\(460px, 58vh\);/s);
});

test("表情包悬浮预览：节点挂在 body 上，才躲得开滚动容器的裁剪", () => {
  assert.match(panel, /hoverPreview\.className = "sticker-hover-preview"/);
  assert.match(panel, /document\.body\.appendChild\(hoverPreview\)/, "挂 body，不能挂抽屉里：抽屉和网格两层都 overflow，放大出来的部分会被裁");
  assert.match(panelCss, /\.sticker-hover-preview \{[^}]*position: fixed;/s);
  assert.match(panel, /\.sticker-pick, \.sticker-source-choice/, "两个网格共用一套委托");
  assert.match(panel, /function hideStickerPreview\(\)/);
  // 抽屉收起、切页、滚动都要收掉，不能留在屏幕上
  assert.match(panel, /function closeEmojiDrawer\(\) \{[\s\S]{0,160}?hideStickerPreview\(\);/);
  assert.match(panel, /if \(!stickers\) imageJobs\.length = 0;\s*clearSourceSentinel\(\);\s*hideStickerPreview\(\);/);
  assert.match(panel, /grid\.addEventListener\("scroll", hideStickerPreview/);
});

test("表情包抽屉：头尾不许被挤扁，中间那块自己滚（flex + min-height:0）", () => {
  assert.match(panelCss, /\.emoji-tabs, \.sticker-picker-head, \.sticker-tools, \.sticker-note, \.sticker-import-foot \{ flex: none; \}/);
  assert.match(panelCss, /\.emoji-grid, \.sticker-grid, \.sticker-source-grid \{ flex: 1 1 auto; min-height: 0; \}/);
  assert.match(panelCss, /\.sticker-picker \{ flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; \}/);
  assert.match(panelCss, /\.sticker-import \{ flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; \}/);
});

// 踩过的坑：Hana 页面跑在 webview 里，Electron 不实现 window.prompt，
// 调下去既没窗口也不报错，名字永远是空的——表现就是「点了＋没反应」。
// 所以整页不许出现原生弹窗，建分组改成就地摊开一行输入。
test("表情包图库：建分组就地起名，不许用原生弹窗（webview 里 prompt 根本不弹）", () => {
  assert.doesNotMatch(panel, /window\.(prompt|alert|confirm)\(/, "Hana 页面里不许调原生弹窗");
  assert.match(panel, /id="sticker-new-group"/);
  assert.match(panel, /id="sticker-new-group-name"/);
  assert.match(panel, /function openNewGroupRow\(\)/);
  assert.match(panel, /async function submitNewGroup\(\)/);
  assert.match(panel, /el\.stickerNewGroupName\.addEventListener\("keydown"/, "回车也能交");
  assert.match(panel, /stickerNewGroup: document\.getElementById\("sticker-new-group"\)/);
  assert.match(panel, /closeNewGroupRow\(\);/, "关抽屉顺手把这一行收掉");
});

test("表情包抽屉：点外面就收，不再挂「收起」按钮", () => {
  assert.doesNotMatch(panel, /put\("收起"/, "那个按钮去掉了");
  assert.doesNotMatch(panelCss, /\.emoji-close/, "样式也别留半截死代码");
  assert.match(panel, /el\.emojiButton\.addEventListener\("click", \(\) => \{\s*if \(el\.emojiDrawer\.hidden\) openEmojiDrawer\(\);\s*else closeEmojiDrawer\(\);/, "那个按钮改成开关");
  assert.match(panel, /document\.addEventListener\("click", \(event\) => \{\s*if \(el\.emojiDrawer\.hidden\) return;/);
  assert.match(panel, /if \(el\.input\.contains\(target\)\) return;/, "点输入框不算走开，只是想打字");
  assert.match(panel, /const inDrawer = path\.length \? path\.includes\(el\.emojiDrawer\) : el\.emojiDrawer\.contains\(target\);/, "在不在抽屉里看事件路径");
  assert.match(panel, /const inButton = path\.length \? path\.includes\(el\.emojiButton\) : el\.emojiButton\.contains\(target\);/);
  assert.match(panel, /if \(inDrawer \|\| inButton\) return;\s*\n\s*closeEmojiDrawer\(\);/, "开抽屉那颗要排掉，不然一关一开像闪了一下");
});

// 她实机撞的：点「添加到图库」后要等好一会，界面没任何动静，她就怀疑卡死、连点好几下。
// 两层都要有：一层锁住按钮（挡重复提交），一层报数字（等待看得见）。
test("表情包导入：添加时要锁按钮、报进度，不许让她干等还连点", () => {
  assert.match(panel, /let importing = false;/);
  assert.match(panel, /async function confirmStickerImport\(\) \{\s*if \(importing\) return;/, "连点不能再进一次");
  assert.match(panel, /el\.stickerImportConfirm\.disabled = true;/);
  assert.match(panel, /el\.stickerImportConfirm\.textContent = "正在添加…";/);
  assert.match(panel, /const IMPORT_CHUNK = 8;/);
  assert.match(panel, /for \(let at = 0; at < ids\.length; at \+= IMPORT_CHUNK\)/, "分趟送才报得出数字");
  assert.match(panel, /正在添加 \$\{Math\.min\(at \+ slice\.length, ids\.length\)\}\/\$\{ids\.length\}…/);
  assert.match(panel, /finally \{[\s\S]*?importing = false;[\s\S]*?el\.stickerImportConfirm\.disabled = false;[\s\S]*?el\.stickerImportConfirm\.textContent = "添加到图库";/);
  assert.match(panelCss, /\.sticker-import-foot button\[disabled\] \{ opacity: \.55;/);
});

// 一张一张读是一张一次宿主往返（实测 160~190ms），一百张排着队就是十几秒。
test("表情包导入：取字节要并行分批，不能让她的等待排成一条长队", () => {
  assert.match(app, /const IMPORT_READ_CONCURRENCY = 6;/);
  assert.match(app, /for \(let at = 0; at < ids\.length; at \+= IMPORT_READ_CONCURRENCY\) \{\s*\n\s*const batch = await Promise\.all\(/);
  assert.doesNotMatch(app, /for \(const id of ids\) \{\s*\n\s*const row = rows\.get\(id\);/);
});

// 踩过的坑：把「切到表情包这一页就拉图库」去掉之后，点 tab 进去的是空数据，
// 添加页拿初始值把「还没拉」当成了「拉不到」。
test("表情包图库：进这一页必须先拉一次，不能拿初始值当成「读不到」", () => {
  assert.match(panel, /let stickerLoadedFor = null;/);
  assert.match(panel, /async function ensureStickerLibrary\(\) \{\s*if \(stickerLoadedFor === current\) return;\s*await loadStickerLibrary\(\);/);
  assert.match(panel, /function openEmojiDrawer\(page = "emoji"\) \{[\s\S]{0,260}?void loadStickerLibrary\(\);/, "打开抽屉就得拉：那排 tab 里装着她建的分组，等点了 tab 才拉就晚了");
  assert.match(panel, /function renderStickerRows\(\) \{[\s\S]{0,220}?if \(el\.emojiDrawer\.hidden \|\| el\.stickerPicker\.hidden\) return;/, "图库页没露脸别画，不然会顺带把整库的图都拉一遍");
  assert.match(panel, /stickerLoadedFor = agentId;/);
  assert.match(panel, /await ensureStickerLibrary\(\);\s*if \(!sourceAvailable\)/, "添加页要先拉再判");
  assert.match(panel, /void ensureStickerLibrary\(\);/, "点分组 tab 也把图库拉起来");
  assert.match(panel, /stickerLoadedFor = null;\n\s*manageMode = false;/, "换伙伴要重拉");
  assert.match(panel, /if \(!sourceReason\) return "表情包图库没读到/, "没拿到原因不能糊成一句笼统话");
});

test("表情包来源：导入页看全库，不受伙伴白名单影响；没标签的不给选", () => {
  assert.match(app, /app\.get\("\/source-sticker\/:id"/);
  assert.match(app, /const row = sourceRowById\(index, id\)/);
  assert.match(app, /const usable = rows\.filter\(\(row\) => hasUsableTags\(row\)\)/);
  assert.match(app, /hiddenUntagged: rows\.length - usable\.length/);
  assert.match(app, /readCatalogWithReason\(ctx\)/);
  assert.match(app, /available: false, reason/);
  assert.match(panel, /source: true/);
});

test("表情包来源：批次留着，但不用再点「再看」——滑到底自己补", () => {
  // 每张图都是一次请求加一次解码，一次铺三百张卡的是宿主；
  // 但格子小了之后一屏能放开八九十张，只画一批她得滑到半路发现底下是空的。
  assert.match(panel, /const SOURCE_BATCH = 40;/);
  assert.doesNotMatch(panel, /SOURCE_QUERY_LIMIT/, "搜索别再一次铺两百张，走同一条自动续");
  assert.match(panel, /new IntersectionObserver\(/, "哨兵进视野就补下一批");
  assert.match(panel, /root: el\.stickerSourceGrid/);
  assert.match(panel, /function clearSourceSentinel\(\)/);
  assert.match(panel, /clearSourceSentinel\(\);\s*el\.stickerSourceGrid\.innerHTML = "";/, "重画前先断开旧的观察，不然会盯看一个已经不在页面上的节点");
  assert.match(panel, /if \(!stickers\) imageJobs\.length = 0;\s*clearSourceSentinel\(\);/);
  assert.doesNotMatch(panel, /sticker-source-more/, "那个要点一下的按钮拿掉了");
  assert.match(panelCss, /\.sticker-source-sentinel \{ grid-column: 1 \/ -1;/);
});

test("表情包进上下文：靠本地标签翻成人话，不靠看图", () => {
  assert.match(app, /stickerLabelMap\(\{/);
  assert.match(app, /describeSticker: \(id\) => stickerLabels\.get\(id\) \?\? null/);
});

test("图片发送门禁：附件校验、伙伴归属和识图协议都在服务端", () => {
  assert.match(app, /isStrictBase64\(raw\)/);
  assert.match(app, /imageBytesMatchMime\(bytes, cleanType\)/);
  assert.match(app, /saveAttachment\(\{ \.\.\.imageInput, agentId \}\)/);
  assert.match(app, /app\.get\("\/attachment\/:agentId\/:id"/);
  assert.match(app, /readAttachment\(c\.req\.param\("id"\), agentId\)/);
  assert.match(app, /VISION_TEST_UNCONFIRMED/);
});

test("图片选择不会跨伙伴或发送回包误清新图片", () => {
  assert.match(panel, /let imageChoiceSeq = 0/);
  assert.match(panel, /const owner = current;[\s\S]*?const choice = \+\+imageChoiceSeq/);
  assert.match(panel, /if \(current !== owner \|\| choice !== imageChoiceSeq\) return/);
  assert.match(panel, /el\.imageButton\.disabled = true;/);
  assert.match(panel, /pendingImage === image\) clearPendingImage\(\)/);
});

test("发送成功后只清理本次图片，不误删发送期间换上的新图片", () => {
  assert.match(panel, /if \(pendingImage === image\) clearPendingImage\(\);/);
  assert.doesNotMatch(panel, /imageChoiceVersion/);
});

test("聊天输入框可把剪贴板图片送进待发送图片链路", () => {
  assert.match(panel, /async function chooseImageFile\(file\)/);
  assert.match(panel, /el\.input\.addEventListener\("paste", \(event\) =>/);
  assert.match(panel, /entry\.kind === "file" && entry\.type\.startsWith\("image\/"\)/);
  assert.match(panel, /event\.preventDefault\(\);[\s\S]*?void chooseImageFile\(file\);/);
  assert.match(panel, /name: file\.name \|\| "剪贴板图片\.png"/);
});

test("待发送图片有缩略图、放大预览和取消入口", () => {
  assert.match(panel, /id="pending-image"/);
  assert.match(panel, /id="pending-image-view"/);
  assert.match(panel, /showImageLightbox\(pendingImage\?\.data/);
  assert.match(panel, /id="image-lightbox"/);
  assert.match(panel, /el\.pendingImageRemove\.addEventListener/);
});

test("历史图片渲染使用当前伙伴，进视口才去取（不再一次性全抓）", () => {
  assert.match(panel, /mountAttachmentImage\(imageNode, m\.attachment\.id, current, Boolean\(opts\.keepBottom\)\)/);
  assert.match(panel, /imageNode\.loading = "lazy"/);
  assert.match(panel, /new IntersectionObserver/, "历史图交给观察器排队，进了视口才去拉");
  assert.match(panel, /if \(keepBottom\) imageNode\.addEventListener\("load", \(\) => \{[\s\S]*?scrollDown\(\);/);
  assert.doesNotMatch(panel, /m\.attachment\.id\).*encodeURIComponent\(agentId\)/);
  assert.match(panel, /hana\.api\.fetch\(`attachment\//);
});

test("每位伙伴一间房：设置页挑图，聊天窗按浓度铺上去", () => {
  // 后端：图落盘 + 设置归一化 + 三条路由 + 元数据跟着轮询下发
  assert.match(app, /import \{ listBackgrounds,[\s\S]*?normalizeOpacity,[\s\S]*?isBackgroundFile,[\s\S]*?fileTypeOf \} from "\.\/lib\/background\.js"/);
  assert.match(app, /writeBackground\(ctx\.dataDir, bytes\)/, "背景写入共享图库，不再按伙伴分目录");
  assert.match(app, /app\.get\("\/background\/:agentId"/);
  assert.match(app, /app\.post\("\/background\/:agentId"/);
  assert.match(app, /app\.delete\("\/background\/:agentId"/);
  assert.match(app, /removeBackgroundFile\(ctx\.dataDir, file\)/);
  assert.match(app, /affectedPartners/);
  assert.doesNotMatch(app, /这张背景还被其他伙伴使用，先换掉再删/);
  assert.match(app, /app\.get\("\/backgrounds\/:agentId"/);
  assert.match(app, /background: store\.getPartnerSettings\(row\.id\)\.background/, "背景元数据跟着轮询下发：设置页换完图，聊天窗自己跟上");
  assert.match(app, /const bytes = base64\s*\n\s*\? Buffer\.from\(base64, "base64"\)/, "图直接收字节；本地路径那条留着备用");

  // 设置页：房间 tab；选图走浏览器自带的文件选择框（不欠宿主一个能力声明）
  assert.match(settings, /\["room", "场景"\]/);
  assert.match(settings, /id="back-to-chat"[^>]*>← 返回聊天/);
  assert.match(settings, /hana\.cards\.open\("panel"\)/, "设置页要能回聊天页");
  assert.match(settings, /roomFileInput\.type = "file";/);
  assert.match(settings, /reader\.readAsDataURL\(file\)/);
  assert.match(settings, /\/\/ 选完就清空[^\n]*\n\s*roomFileInput\.value = "";/, "选完清空：同一张图连着挑两次也得能再触发 change");
  assert.doesNotMatch(settings, /hana\.resources\.pick\(/, "别再去绕宿主的选图器：拿回来的东西没有能用的路径，而且是静默失败");
  assert.match(settings, /detailPanels\.room\.appendChild\(roomCard\)/);
  assert.match(settings, /roomOpacityInput\.type|type="range"|className = "room-opacity"/, "透明度用滑块，允许即时视觉微调");
  assert.match(settings, /backgrounds\/\$\{encodeURIComponent\(agentId\)\}/, "设置页沿用伙伴入口读取共享背景图库");
  assert.match(settings, /roomPreview\.style\.setProperty\("--room-veil"/, "透明度滑动时要同步更新预览遮罩");
  assert.match(settingsCss, /\.room-preview\.has-bg::before/, "设置页预览要有和聊天页一致的遮罩");
  assert.match(settings, /applyRoomFile\(item\.file\)/, "点缩略图能切换保留的背景");
  assert.match(settings, /api\("DELETE", `background\/\$\{encodeURIComponent\(agentId\)\}`\)/);
  assert.match(settings, /roomImage\.style\.cssText = .*object-fit:cover/, "示例聊天预览要铺满背景");

  // 聊天窗：背景入口与当前伙伴的背景不串
  assert.match(panel, /id="btn-settings"/);
  assert.match(panel, /settings\.html\?embedded=1/);
  assert.match(panel, /id="btn-appearance"[^>]*title="聊天背景"/);
  assert.match(panel, /<strong>聊天背景<\/strong>/);
  assert.doesNotMatch(panel, /更多茶话会设置/);
  assert.match(panel, /id="appearance-gallery"/);
  assert.match(panel, /className = "appearance-remove"/);
  assert.match(panel, /background-delete-layer/);
  assert.match(panel, /确认删除/);
  assert.doesNotMatch(panel, /再点一次，才会从背景图库里删除这张图/);
  assert.match(panel, /background\/\$\{encodeURIComponent\(pending\.agentId\)\}\?file=\$\{encodeURIComponent\(pending\.file\)\}&remove=1/);
  assert.match(panel, /id="appearance-opacity"/);
  assert.match(panel, /if \(el\.appearancePopover\.hidden\) return;[\s\S]*?if \(!inPopover && !inButton\) closeAppearance\(\)/, "点聊天背景面板外要自动收起");
  assert.match(panel, /if \(event\.key !== "Escape"\) return;[\s\S]*?closeAppearance\(\)/, "Escape 也能收起聊天背景");
  assert.match(panel, /function clearChatBackground\(\)/);
  assert.match(panel, /async function syncChatBackground\(agentId, background\)/);
  assert.match(panel, /if \(chatBgFor === agentId && chatBgStamp === stamp && chatBgUrl\) \{/, "背景还在下载时，重复同步不能提前返回");
  assert.match(panel, /background\/\$\{encodeURIComponent\(agentId\)\}\?file=\$\{encodeURIComponent\(background\.file\)\}/, "重启后按已保存的文件名取图，不依赖当前设置的隐式回读");
  assert.match(panel, /let chatBackgroundSyncSeq = 0;/, "背景请求要有自己的代次");
  assert.match(panel, /if \(syncSeq !== chatBackgroundSyncSeq \|\| chatBgFor !== agentId \|\| chatBgStamp !== stamp\) return/, "回来时已经换人换图，就别把上一张贴上去");
  assert.match(panel, /if \(syncSeq !== chatBackgroundSyncSeq \|\| chatBgFor !== agentId \|\| chatBgStamp !== stamp\) return;\s*el\.chat\.classList\.remove\("has-bg"\)/, "旧背景失败也不能清掉新房间");
  assert.match(panel, /let appearanceLoadSeq = 0;/, "背景面板读取也要有代次");
  assert.match(panel, /let partnersLoadSeq = 0;[\s\S]*?const loadSeq = \+\+partnersLoadSeq;[\s\S]*?if \(loadSeq !== partnersLoadSeq\) return;/, "切换伙伴时旧的伙伴列表回包不能把新房间背景清掉");
  assert.match(panel, /if \(loadSeq !== appearanceLoadSeq \|\| current !== agentId\) return;/, "旧伙伴的图库回包不能覆盖当前面板");
  assert.match(panel, /const currentPartner = partners\.find\(\(p\) => p\.id === current\);[\s\S]*?if \(currentPartner\?\.background\) void syncChatBackground\(current, currentPartner\.background\)/, "旧列表没有背景时不能把当前房间清成默认");
  assert.doesNotMatch(panel, /void syncChatBackground\(current, partners\.find\(\(p\) => p\.id === current\)\?\.background \?\? null\)/, "轮询不能用缺失背景的旧回包清房间");
  assert.match(panelCss, /background: var\(--bubble-ta-fg, var\(--primary\)\);\s*opacity: \.65;/, "深色背景下正在输入的小点也要跟着主题");

  // 样式：背景铺满整扇聊天窗，头尾两条工具栏是半透磨砂玻璃，硬缝靠向外化开的雾消掉
  assert.match(panelCss, /\.chat\.has-bg \{ background-size: cover; background-position: center; background-repeat: no-repeat; \}/, "图得铺在整个聊天窗上，不是只铺中间那条滚动带");
  assert.match(panelCss, /\.chat\.has-bg \.chat-head,\s*\n\.chat\.has-bg \.composer \{[\s\S]*?backdrop-filter: blur\(16px\)/, "头尾两条工具栏要磨砂：透出背景的颜色，又压住底下的图");
  assert.match(panelCss, /\.chat\.has-bg \.chat-head \{ box-shadow: 0 14px 20px -12px/, "伙伴栏向下化开一层雾");
  assert.match(panelCss, /\.chat\.has-bg \.composer \{ box-shadow: 0 -14px 20px -12px/, "输入区向上化开一层雾");
  assert.match(panelCss, /background: rgba\(255, 253, 249, var\(--mc-veil, \.5\)\)/, "磨砂条的白度要跟着她的背景明暗走：写死 72% 会把整张图冲成一片纯白");
  assert.match(panel, /el\.chat\.style\.setProperty\("--mc-veil"/, "铺背景时把浓度也传给两条玻璃条");
  assert.match(panel, /el\.chat\.style\.removeProperty\("--mc-veil"\)/, "清背景时连浓度变量一起扫干净，不留半截样式");
  assert.doesNotMatch(panelCss, /\.stream\.has-bg/, "背景已经不在聊天流上了，别留旧伪元素那套");
  assert.match(panel, /el\.chat\.style\.setProperty\("background-image"/, "内联背景铺到聊天窗那层，不赌伪元素");
  assert.match(panel, /el\.chat\.classList\.add\("has-bg"\)/, "磨砂玻璃的开关挂在聊天窗上");
  assert.match(panel, /adaptSendButtonColor\(chatBgUrl\)/, "背景换了以后要重新配发送按钮颜色");
  assert.match(panel, /buttonThemeFromSample/, "发送按钮颜色要从背景主色生成");
  assert.match(panelCss, /--send-bg, var\(--primary-ink\)/, "没有背景时保留默认发送按钮颜色");
});

test("认识 ta：重新认识是从头再来，入口先说清楚再动", () => {
  assert.match(app, /app\.post\("\/recognition\/:agentId\/restart"/, "服务端有一条清空重来的入口");
  assert.match(app, /const recognition = \{\s*\n\s*\.\.\.emptyRecognition\(\),/, "清空重做，同时把「认识过」的痕留着");
  assert.match(panel, /async function obStartRecognition\(partner, options = \{\}\)/);
  assert.match(panel, /if \(options\.restart\) \{[\s\S]{0,240}?recognition\/\$\{encodeURIComponent\(partner\.id\)\}\/restart`\)/, "敢重启就先把旧的草稿掉再去清空");
  assert.match(panel, /void obStartRecognition\(partner, \{ restart: true \}\)/);
  assert.match(panel, /void obStartRecognition\(target, \{ restart: true \}\)/);
  assert.match(panel, /await obStartRecognition\(target, \{ restart: true \}\)/);
  assert.match(settings, /id="recognize-modal"/);
  assert.match(settings, /id="confirm-recognize"/);
  assert.match(settings, /closeModal\("recognize-modal"\); openPanelAction\("reshape", agentId\)/, "确认后才真的走");
  assert.doesNotMatch(settings, /之前的回答可以继续改/, "旧的说法得换掉：重新认识是重做，不是回看");
});

test("认识 ta：审查后补上的几道防护", () => {
  assert.match(app, /everCompleted === true/, "重做后靠这条痕保住入住资格");
  assert.match(app, /everCompleted: knowing\.recognition\?\.everCompleted === true \|\| Boolean\(knowing\.recognition\?\.completedAt\)/, "重做时把痕留下");
  assert.match(panel, /const filled = \(Array\.isArray\(draft\.selected\) && draft\.selected\.length\)/, "空白草稿不发请求");
  assert.match(panel, /if \(!filled\) return;/, "空白草稿直接跳过");
  assert.match(panel, /let notice = ""/, "场景超限的提示不能被后面那行洗掉");
  assert.match(panel, /obState\.recognitionSuggestionError = notice;/, "只有真加上/取消了才清旧提示");
  assert.match(panel, /clearTimeout\(obState\.recognitionDraftSaveTimer\)/, "重做前先掉还在等的那笔旧草稿");
  assert.match(panel, /从头再来一遍，之前答的已经清掉了/, "重做路径不能再说「接着看」");
  assert.match(panel, /if \(stateRef\.recognitionDraftSavePromise === pending\) stateRef\.recognitionDraftSavePromise = null;/, "旧请求不能把还在飞的标记抹掉");
  assert.match(app, /origin: body\?\.origin/, "answer 路由要接住前端传的 origin");
});
test("认识 ta：挑最像的、方向有上限，而且能贴原话", () => {
  assert.match(app, /sanitizeSuggestions\(question, parseRecognitionSuggestions\(raw\)\)/, "候选先过质检再给用户");
  assert.match(app, /async function askRecognition\(/, "认识那条链有单独的模型入口");
  assert.match(app, /recognitionModel = normalizeModelRef\(patch\.recognitionModel\)/, "设置里那一格存得住");
  assert.match(settings, /id="global-recognition-model-host"/);
  assert.match(settings, /function paintGlobalRecognitionModel\(\)/);
  assert.match(panel, /const limit = Number\(question\.maxSelect\) > 0/, "选项上限由后端发下来");
  assert.match(panel, /next = next\.slice\(next\.length - limit\)/, "选满了就把最早那条挤出去");
  assert.match(panel, /ob-rec-count/, "界面上要说清楚最多选几个");
  assert.match(panel, /这个场景已经有一条了，帮你换成了这条/, "同场景换一条得说一声，不能默默丢掉她刚点的");
  assert.match(panel, /原样贴一两句进来/, "打字那题给了一个贴原话的口子");
});
test("和小花聊聊：档案长出来才能点，改前留一版，旧版能退回来", () => {
  assert.match(settings, /id="review-modal"/);
  assert.match(settings, /id="history-modal"/);
  assert.match(settings, /textContent = "和小花聊聊"/);
  assert.match(settings, /reviewButton\.disabled = true/, "档案还没长出来时不能点");
  assert.match(settings, /AbortSignal\.timeout\(120000\)/, "体检和聊天要等模型，不能沿用 8 秒超时");
  assert.match(settings, /"确认修改"/, "要有一个点一下就应用的地方");
  assert.match(settings, /确定换回/, "回退要轻确认，不能点一下就直接换");
  assert.match(settings, /reviewTime\(row\.at\)/, "历史只显示时间和一句摘要，不摆版本号");
  assert.match(app, /app\.get\("\/persona-review\/:agentId"/);
  assert.match(app, /app\.post\("\/persona-review\/:agentId\/start"/);
  assert.match(app, /app\.post\("\/persona-review\/:agentId\/chat"/);
  assert.match(app, /app\.post\("\/persona-review\/:agentId\/apply"/);
  assert.match(app, /app\.post\("\/persona-review\/:agentId\/revert"/);
  assert.match(app, /code: "revision-changed"/, "版本对不上不硬盖");
  assert.match(app, /commitChange\(knowing, after/, "应用前先把旧版存进历史");
  assert.match(app, /store\.clearReviewSession\(agentId\)/, "应用完要把会话消费掉");
  // 这一屏得像个聊天框：小花开场先说、明细退到折叠里、输入框跟发送键贴在一起。
  assert.match(settings, /reviewOpenings\(diagnosis\)/, "开场是气泡，不是一张报告卡");
  assert.match(settings, /classList\.add\("stacked"\)/, "输入框要跟发送键搂到一块");
  assert.match(settings, /classList\.remove\("stacked"\)/, "别的屏得把聊天那套版式退回普通弹窗");
  assert.match(settings, /review-detail/, "体检明细要收进折叠里，不抢聊天的位子");
  assert.match(settings, /event\.isComposing/, "中文输入法敲回车不能把话发出去");
  assert.doesNotMatch(settings, /哪儿不对就说/, "占位文案不能再是审阅腔");
  assert.match(settings, /composer\.appendChild\(send\)/, "发送键要跟输入框同一个块");
  // 建议不另开一屏：就长在对话流里，点「确认修改」才落。
  assert.match(settings, /reviewSuggestionCard\(state\)/, "建议卡要内联进对话流");
  assert.match(settings, /stream\.appendChild\(reviewSuggestionCard/, "建议卡的位置在消息流里");
  assert.doesNotMatch(settings, /看看要改的地方/, "不再拿一个按钮把对话切出去");
  assert.doesNotMatch(settings, /state\.view === "preview"/, "不再有单独的预览屏");
  assert.match(settings, /state\.skipped = Array\.isArray\(error\.skipped\)/, "落不上的哪几条要带回界面");
});

test("拾光记今日情境：装了拾光记才有得开，默认关，没装按钮打不开", () => {
  assert.match(settings, /<h3>拾光记今日情境<\/h3>/, "标题要说明来源是拾光记");
  assert.match(settings, /id="daybook-switch"/);
  assert.match(settings, /id="daybook-copy"/);
  assert.match(settings, /daybookSwitch\.disabled = !daybookInstalled/, "没装时开关要禁用");
  assert.match(settings, /daybookInstalled = Boolean\(data\.daybookInstalled\)/);
  assert.match(app, /daybookInstalled: await shiguangjiInstalled\(\)/);
  assert.match(app, /async function shiguangjiInstalled\(\)/);
  assert.match(app, /function daybookOn\(\)/);
  assert.match(app, /const snapshot = daybookOn\(\) \? await readDaybook\(ctx\) : null/, "没开就不读快照");
  assert.match(app, /contextText = daybookOn\(\) \? buildAmbientContextText/, "主动消息那条路也要听开关");
  assert.match(app, /patch\.daybookEnabled = patch\.daybookEnabled === true/);
  assert.match(settingsCss, /\.switch:disabled/);
});

test("拾光记今日情境从关到开要当场生效：清掉当天露过的记账", () => {
  assert.match(app, /store\.clearDaybookMarks\(\)/);
  assert.match(app, /const wasDaybookOn = daybookOn\(\)/);
  assert.match(app, /if \(!wasDaybookOn && daybookOn\(\)\)/);
});

test("居中浮层按内容定宽，别被 left:50% 砍成半屏", () => {
  assert.match(settingsCss, /\.toast \{[^}]*width: max-content;/s, "toast 要按内容定宽");
  assert.match(settingsCss, /\.toast \{[^}]*max-width: min\(420px, calc\(100vw - 32px\)\);/s);
  assert.match(settingsCss, /\.toast \{[^}]*text-wrap: balance;/s, "多行时不要让末行只剩一个字");
  assert.match(panelCss, /\.status-line \{[^}]*width: max-content;/s, "聊天窗状态条同一个坑，一起治");
});
