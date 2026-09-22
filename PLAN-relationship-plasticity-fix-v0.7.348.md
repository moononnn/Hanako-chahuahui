# 茶话会关系可塑性修复与续建计划

> 施工基线：`v0.7.348`
>
> 适用目录：`C:\Users\laotv\.hanako\apps\chahuahui\`
>
> 本文用于新窗口直接接手施工。当前只完成计划，不代表下列改动已经实现。

## 0. 当前结论

`v0.7.348` 已完成：

- adaptation/user-adaptation 账本结构与耐久读写；
- 明确偏好候选预筛和模型 reconciler；
- guide 归一、有效期、覆盖的部分纯逻辑；
- 普通回复、主动消息、等回音、小动作、体感测试的 adaptation block 注入；
- 睡眠、语音、表情包的部分策略接线。

尚不能验收的原因：

1. canonical guide 使用 `guide.claims[]`，语音和表情包适配器仍混用扁平测试形状；
2. 语音明确 deny 仍可能生成语音；more/less 没有真正改变行为；
3. 表情包 specific allow/deny 没有从正式账本进入候选过滤；
4. 睡眠 `normal / exception / deferred / later-notice` 的生成语义与两阶段提交没有闭环；
5. exception、feedback、habit 只有数据结构，没有业务写入链；
6. 消息撤回不会撤销 guide，也不会取消未提交行为；
7. current-turn/life-day 临时 guide 在真实调用链中无法生效；
8. 原有 facts 未迁移，查看/纠错/忘掉和 observed 尚未施工；
9. `TESTING.md` 的显式“全量”命令只跑 761 条，真实全量是 796 条。

修复原则：**先建立失败基线，再修运行时边界；先保证一次行为正确提交，再建设反馈沉淀；先完成明确表达闭环，最后接 observed。**

---

## 1. 施工纪律

### 1.1 开工前必须读取

- `plugin-dev-guide/SKILL.md`
- `references/09-common-pitfalls.md`
- `references/10-success-patterns.md`
- `L:\哈娜的工作台\知识卡片\插件开发调试检查清单.md`
- 本项目 `PENDING_CHANGES.md`
- 本项目 `TESTING.md`
- `DESIGN-relationship-plasticity.md`
- 本文

### 1.2 修改与版本

- 直接修改正式目录，不走 dev slot；
- 每个“逻辑完整、测试全绿”的节点：
  1. `manifest.json` patch +1；
  2. `PENDING_CHANGES.md` 记一笔；
  3. 更新 `TESTING.md` 的覆盖范围与真实命令；
- 半成品不升版本；
- 按逻辑边界拆提交，不能把全部改动塞成一个巨型提交；
- 本轮只修和续建，不发布、不 push，除非另行明确要求；
- 不主动重启 Hana，完成后只提醒需要重启验证。

### 1.3 每个节点固定门禁

```powershell
node --check index.js
node --check lib/adaptation.js
node --check lib/plasticity.js
node --check lib/voice.js
node --check lib/stickers.js
node --test tests/*.test.js
node "C:\Users\laotv\.hanako\artifacts\server\0.1013.1-win32-x64-f1747f74c1cbfb03-gb5cc47f9c3ef2da2\scripts\validate-app.mjs" --dir "C:\Users\laotv\.hanako\apps\chahuahui" --json
```

当前基线：

- `node --test tests/*.test.js`：796 条通过；
- 静态校验：0 error、1 个动态资源不可静态证明 warning；
- 正式目录不是 Git 工作树，不能依赖 `git diff` 获取基线。

---

## 2. 推荐施工顺序总览

严格按依赖顺序执行：

1. **失败基线与 canonical 测试夹具**
2. **统一 guide/claim 的正式数据协议**
3. **语音 deny / more / less 修复**
4. **表情包 specific allow / deny 修复**
5. **睡眠状态机与两阶段事务重做**
6. **撤回、取消与异步失效令牌**
7. **统一 exception 落账 API**
8. **feedback 归因与 habit 沉淀**
9. **临时 guide 的 life-day/current-turn/until 修复**
10. **proactive/awaiting 策略接入**
11. **旧 facts 幂等迁移**
12. **查看、忘掉与对话式纠错**
13. **observed 弱观察**
14. **全量自动测试与实机验收**
15. **文档、账本和版本收口**

阶段 1～6 是当前运行时阻断，必须先完成；阶段 7～8 才让“多次破例形成偏爱”成为真实能力；阶段 11～13 负责旧数据、用户纠错与长期观察。

---

# 第一部分：先修运行时阻断

## 3. 节点一：建立失败基线与 canonical 测试夹具

### 3.1 目标

在改实现前，用当前正式数据形状稳定复现所有已确认问题。失败测试必须先红，修完后用同一场景转绿。

### 3.2 新增统一测试工厂

建议在测试辅助文件中提供：

```js
canonicalGuide({
  id,
  meaning,
  kind,
  scope,
  duration,
  origin,
  sourceMessageIds,
  claims,
})
```

所有适配器测试只能传 `normalizeGuide()` 能存回磁盘的正式结构，禁止继续使用：

```js
{ target, effect, value, stickerId }
{ claim: { ... } }
```

### 3.3 必须先红的最小复现

#### 语音

- canonical `voice.frequency deny/none` 后，任意随机值都不得生成；
- canonical `more` 与无 guide 相比，软空间必须单调增加；
- canonical `less` 与无 guide 相比，常规和破例空间必须单调减少；
- 测试真实 relationship 形状：`familiarity + intimacy`，不再传假的 `closeness`。

#### 表情包

- guide 经 `savePartnerAdaptation()` → `getPartnerAdaptation()` 后仍能过滤到特定图；
- canonical deny 能排除对应对象；
- specific claim 缺稳定身份时必须安全失败，不能把空 `allowedIds` 当整库放行；
- 测试至少覆盖 `store → normalize → policy → catalog filter → pickSticker`。

#### 睡眠

- 实时回复先完成、readTimer 后触发时，最终仍能完成事务；
- readAt 先发生、回复后落盘时，也能完成事务；
- 两个事件重复触发不重复 wakeCount、不重复 exception；
- 生成失败、五分钟重试、进程恢复不重复提交；
- deferred 到点后 prompt 明确是“后来看到”，不得出现“被吵醒”。

#### 撤回

- 撤回来源消息后，伙伴级和 user-wide guide 都失效；
- 撤回后未完成的 TTS 即使返回，也不能写 ready、不能递增 runtime；
- 已提交历史保留，未来策略不再读取被撤回 guide。

### 3.4 完成标准

- 新测试在旧实现上稳定失败；
- 每个失败都记录“输入、预期、实际、版本 v0.7.348”；
- 不通过修改测试夹具迁就旧实现。

---

## 4. 节点二：统一 guide/claim 正式协议

### 4.1 单一事实源

正式协议固定为：

```js
Guide {
  id,
  meaning,
  kind,
  scope,
  duration,
  origin,
  sourceMessageIds,
  claims: Claim[]
}
```

所有适配器只能通过统一 helper 读取 `claims[]`，删除业务代码中的兼容读取：

```js
guide.target
guide.effect
guide.claim
guide.stickerId
guide.valueId
```

旧扁平形状如果从未进入正式持久化，不为测试夹具保留兼容层。

### 4.2 增加统一查询 helper

建议在 `lib/adaptation.js` 提供：

```js
effectiveClaimEntries({
  capability,
  userGuides,
  partnerGuides,
  now,
  currentTurnId,
  lifeDay,
})
```

返回：

```js
[
  { guide, claim }
]
```

语音、睡眠、表情包、主动联系全部调用它，不再各自解析 guide 形状。

### 4.3 修复多 claim guide 的覆盖错误

当前 `effectiveGuides()` 按 claim 决胜，却按整个 guide 返回，旧 guide 的失败 claim 会跟着其他有效 claim 一起复活。

修复方向：

- 冲突覆盖结果精确到 claim；
- 文本 adaptation block 仍可以按 guide 去重展示 meaning；
- 代码适配器读取的是“决胜后的 claim entries”，不得重新遍历整份旧 guide；
- 同 target + subject 只保留优先级最高的一条；
- deny/boundary 在真正冲突时优先，但旧 deny 被更新声明 supersede 后不得复活。

### 4.4 表情包 subject 的稳定身份

不要让模型凭标签猜图片 ID。canonical subject 采用可持久化的稳定字符串：

- 茶话会本地图：`local:<localStickerId>:<sha256>`；
- 外部快照图：`source:<sourceId>`；若有 sha256，可追加指纹；
- 文本标签只作展示和候选匹配，不作唯一身份。

建立 subject 的解析、归一和 catalog 匹配 helper。无法唯一匹配时：

- 保留开放式 `meaning`；
- 不创建 `sticker.permission specific` 机器 claim；
- 绝不能退化成整库许可。

如果用户消息本身发送了某张表情包，再表达“这张可以”，直接从消息实体取得稳定 ID，不调用模型猜。

---

## 5. 节点三：语音策略修复

### 5.1 文件范围

- `lib/voice.js`
- `lib/plasticity.js`
- `index.js`
- `tests/voice.test.js`
- 新增真实链路测试文件时同步更新 `TESTING.md`

### 5.2 deny 修复

`resolveVoicePolicy()` 的最终阻断必须来自统一 resolver：

```js
hardBlocked = resolved.allowed === false
```

`shouldGenerateVoice()` 双保险检查：

```js
if (voicePolicy?.allowed === false || voicePolicy?.hardBlocked) {
  return { ok: false, reason: "policy-denied", layer: "hard" };
}
```

这里的“hard”是执行门语义，不得把用户可修改的关系 boundary 写成平台不可修改的永久 hard 数据。

### 5.3 more / less 的真实行为

保持用户设置 tier 是 baseline，不回写设置。resolved policy 只生成本轮 effective 值：

- `more`
  - 提高 normal chance；
  - 保留 normalMax，开放最多 1 条 exception extra；
  - 缩短 exception 冷却，但不得低于 hardCooldownFloor；
- `less`
  - 降低 normal chance；
  - 不开放 exception extra；
  - 延长或保持 normal cooldown；
- `none/deny`
  - 完全阻断。

具体初始系数放在一个常量表中，测试只锁：

- 单调关系；
- 上下限；
- more > baseline > less；
- hardMax、长度、连续发送、全局开关仍优先。

不要让“关系深”在没有偏好或没有正常额度对照时自动伪造“为你多发”的 exception。

### 5.4 成功提交点

语音 actionCommitPoint 固定为：

1. 合成成功；
2. 音频文件写盘成功；
3. 目标消息仍有效；
4. 消息 voice 状态成功写为 `ready`；
5. 才递增 runtime；
6. 若 `decision.layer === "exception"`，按 `voice.frequency + resultMessageId` 幂等写 exception。

任一步失败：

- 不递增 runtime；
- 不写 exception；
- 清理本次临时音频；
- 保留文字回复。

---

## 6. 节点四：表情包策略修复

### 6.1 目标

关系许可只改变本轮伙伴候选池，不改原图库、不改表情包插件账本、不影响用户主动发送。

### 6.2 执行顺序

```text
原图库与伙伴白名单
→ 原图库 veto
→ canonical relationship claim 过滤
→ 性格/关系/语境门禁
→ 最近发送去重
→ 本地关键词选图
```

任何关系许可都不能越过原图库 veto。

### 6.3 specific allow

- 只把命中的稳定 subject 对应图片加入“关系许可候选”；
- 不扩张到同标签、同分组或全部损友图；
- subject 无法解析时安全关闭该许可，不退回整库放行；
- 敏感/损友图需要 explicit permission；observed 永远不能建立。

### 6.4 deny

- canonical claim 精确过滤 subject；
- 若用户明确禁止整个损友类，可使用明确的类别 subject，但类别必须来自本地已知标签，不由模型自由造；
- deny/boundary 优先于 allow/preference；
- 撤回 deny 后重新按当前 active claims 计算，不保留旧缓存。

### 6.5 破例判定

只有“超出伙伴 normal 候选池、因关系许可进入并最终发送成功”的图，才算 sticker exception。普通图库里的正常表情不记 exception。

提交点：结果消息已落盘且其中包含真实 sticker bubble。

---

## 7. 节点五：睡眠状态机与两阶段事务重做

### 7.1 核心原则

“看到消息”和“回复落盘”是两个可能乱序发生的事件。不要假设 readAt 一定先于 composeReply，也不要在两个调用点各写一套提交逻辑。

### 7.2 pendingReply 建议字段

```js
{
  dueAt,
  mode,
  triggerMessageId,
  wakeDecision: "normal" | "exception" | "deferred" | "later-notice",
  wakeNight,
  wakeKind,
  wakeReadAt,
  wakeCountCommittedAt,
  resultMessageId,
  replyReadyAt,
  wakeOutcome: "pending" | "woken" | "committed" | "later-notice" | "cancelled",
  exceptionId,
  guideIds
}
```

字段命名最终可微调，但必须表达：触发消息、读到、回复 ready、计数已提交、最终 outcome。

### 7.3 交换律提交 helper

新增一个唯一事务推进函数，例如：

```js
advanceWakeTransaction(pending, event)
```

支持事件：

- `{ type: "read", at }`
- `{ type: "reply-ready", resultMessageId, at }`
- `{ type: "cancel", at }`
- `{ type: "deferred-resolved", at }`

要求：

- read 先来和 reply-ready 先来，最终结果一致；
- 重复事件幂等；
- `normal` 只提交一次 wakeCount，不写 exception；
- `exception` 在 read 时记真实醒来，但只有 reply-ready 也到达后才写 committed exception；
- `deferred/later-notice` 不增加 wakeCount、不写 wake exception；
- stable key 固定为 `sleep.wake + triggerMessageId`；后补 resultMessageId 不参与唯一键。

### 7.4 readAt 幂等

`markUserMessagesRead()` 需要能确认目标 triggerMessageId 是否由未读变为已读。可以：

- 返回 touched IDs；或
- 提交前读取目标消息的 readAt，提交后再次确认。

只有第一次真正写入 triggerMessageId.readAt 才允许递增 wakeCount。

### 7.5 重试与恢复

`scheduleReplyAt()` 合并或重排时必须保留整个 wake transaction，不得只重建 wakeDecision/wakeNight/wakeKind。

恢复规则：

- resultMessage 已存在：补 `reply-ready`，不得再生成；
- readAt 已存在：补 `read`，不得重复计数；
- 两者都存在：幂等完成 transaction；
- deferred 到点：单向转 later-notice；
- cancelled：不得复活。

### 7.6 later-notice 生成语义

`composeReply()` 显式接收 wake context，不能只靠当前 `dozingNow()` 重算。

- `normal/exception`：允许 `wakeBlockFor()` 生成被吵醒语义；
- `later-notice`：生成“后来才看到这条消息”的上下文；
- later-notice 即使到点仍处于睡眠窗口，也不得说“这条消息把你弄醒”；
- deferred 延迟仍受 hardDelayCap 兜底。

### 7.7 wake-sooner / wake-later

- `wake-sooner`：提高 effectiveWakeChance，但不突破 0.95；
- `wake-later`：降低 effectiveWakeChance，允许降到 baseline 以下，但保留产品定义的最小响应兜底；
- `deny/none`：本轮固定 deferred/later-notice，不进入被吵醒路径；
- 没有 guide 时只使用关系、性格和 baseline；
- 相同输入下：`wake-sooner > baseline > wake-later`。

---

## 8. 节点六：撤回、取消与异步失效令牌

### 8.1 guide 撤回

消息撤回时，无论 UI 最终显示硬撤回还是已读占位，未来行为都不能继续使用该来源形成的 active guide。

同时处理：

- 当前伙伴 adaptation；
- user-wide adaptation；
- 以该 guide 为唯一来源的 emerging habit；
- 以该消息为 sourceMessageId 的 feedback；
- 未提交的 wake/voice/sticker 计划。

已发送历史和已 committed exception 保留，但标记其来源 guide 已失效，不再参与沉淀。

### 8.2 语音生成令牌

每个后台 TTS 任务绑定：

```js
{
  agentId,
  resultMessageId,
  triggerMessageId,
  generationToken,
  guideIds
}
```

写文件、patch ready、递增 runtime 前都复查：

- 目标消息仍存在且未被替换；
- generationToken 仍为当前；
- trigger/source 未撤回；
- guide 仍 active；
- voice pending 文本仍匹配。

失效后即使网络请求返回，也只清理临时文件，不得提交 ready/runtime/exception。

### 8.3 pending 行为取消

不要只按 agentId 粗暴清空。pending 记录必须保存 `triggerMessageId + guideIds`，撤回时只取消相关动作，避免误伤同伙伴后来产生的新任务。

---

# 第二部分：建立真实破例与沉淀闭环

## 9. 节点七：统一 exception 落账 API

### 9.1 单一写入口

在 store 或 adaptation service 增加同步、幂等的更新入口，例如：

```js
updatePartnerAdaptation(agentId, updater)
commitException(agentId, exception)
finalizeException(agentId, exceptionId, patch)
```

所有适配器不得直接手写 `book.exceptions.push()`。

### 9.2 exception 必填字段

```js
{
  id,
  behavior,
  description,
  normalRule,
  chosenAction,
  guideIds,
  sourceMessageIds,
  triggerMessageId,
  resultMessageId,
  outcome,
  committedAt,
  consolidated
}
```

稳定幂等键：

- 睡眠：`sleep.wake + triggerMessageId`；
- 语音：`voice.frequency + resultMessageId`；
- 表情包：`sticker.permission + resultMessageId`；
- 后续文本行为：`behavior + resultMessageId`。

### 9.3 三个首批适配器

- 睡眠：由 wake transaction 同时满足 read + reply-ready 后提交；
- 语音：音频 ready 后提交；
- 表情包：结果消息包含关系许可图片后提交。

普通行为不记 exception，只有越过 normal baseline 且真实执行成功才记。

### 9.4 容量与并发

- 最多保留最近 64 条；
- 去重后再裁剪；
- 多个异步行为完成时不能互相覆盖；
- 增加并发回归：两个不同 exception 近同时提交，最终两条都在。

---

## 10. 节点八：feedback 归因与 habit 沉淀

### 10.1 feedback 来源

只允许后续用户消息创建 feedback。模型只能分类，不能凭伙伴消息或沉默自行奖励。

合法类型：

- 正向：`explicit-like`、`repeat-request`、`explicit-continue`；
- 负向：`explicit-dislike`、`stop-request`、`correction`。

### 10.2 reconciler 输入

给 reconciler 的材料增加最近 24 小时、尚可归因的 committed exceptions 摘要：

- exceptionId；
- behavior；
- result 时间；
- 简短行为描述；
- 不放内部概率和关系分数。

模型输出可以同时包含：

- guide operation；
- 可选 feedback operation。

本地严格校验：

- feedback 只能绑定一个最近且未被同源占用的 exception；
- sourceMessageId 必须是当前用户消息；
- 去重键：`behavior + lifeDay + sourceMessageId + polarity`；
- 超过 24 小时或指代不清时不绑定。

### 10.3 负反馈即时生效

负反馈成功写入后立即：

- 阻断同类后续破例；
- 将相关 emerging habit 改为 reverted；
- 若用户表达了新边界，同时建立 deny/boundary guide；
- 不等待日终沉淀任务。

### 10.4 consolidation 纯函数

新增纯函数并使用固定阈值：

#### emerging

- 有 explicit preference 或可靠 observed guide；
- 同方向 committed exception ≥ 3；
- 跨生活日 ≥ 3；
- 正向 feedback ≥ 1；
- 无负反馈、撤回、相反偏好；
- 不触碰 hard/identity。

#### settled

- emerging 后再有 committed exception ≥ 2；
- 再跨生活日 ≥ 2；
- 正向 feedback 累计 ≥ 2；
- 两条反馈来自不同生活日、不同 exceptionId、不同用户消息；
- 期间没有负向证据。

### 10.5 反哺行为

- `emerging`：只轻微改变 effective policy；
- `settled`：改变茶话会内部 effective normal；
- 永不回写用户设置 tier、作息配置、Hana 人格或全局记忆；
- habit 变化进入 adaptation block，但不能把阈值、次数或进度说给用户。

---

# 第三部分：补齐有效期、主动行为与旧数据

## 11. 节点九：临时 guide 修复

### 11.1 解析时由系统补上下文

`parseGuideReconcileResult()` 增加参数：

```js
{
  sourceMessageId,
  currentTurnId,
  lifeDay,
  now
}
```

规则：

- current-turn：自动绑定 currentTurnId/sourceMessageId；
- life-day：自动写当前生活日；
- until：必须有合法 expiresAt；缺失时安全降级为 life-day，不能永久化；
- persistent：只有明确长期表达才能建立。

不要让模型负责填写当前日期和消息 ID。

### 11.2 全调用链传递 currentContext

以下路径统一传：

```js
{
  currentTurnId,
  lifeDay
}
```

- 普通回复 adaptation block；
- 主动、等回音、小动作；
- 睡眠、语音、表情包 resolver；
- 体感测试；
- 后续新增行为。

### 11.3 过期维护

读取时继续动态判定，写盘维护任务可把过期项标记为 expired，但不能物理删除历史。

---

## 12. 节点十：proactive/awaiting 策略接入

### 12.1 范围

使用已有 claims：

- `proactive.frequency more/less/none`
- 文本层 `reply.advice-style`
- `reply.self-disclosure`
- `reply.teasing`

### 12.2 主动联系

- 全局主动开关、静默时段、日上限仍是 hard/runtime 门；
- more/less 只调有效间隔和软频率；
- deny/none 禁止该关系主动联系，但不改设置页；
- 等回音与主动联系共用统一 resolver，不另造亲密算法；
- 主动破例必须有真实来处，继续遵守“有来处的主动”和“错过不消失、等用户得空”。

### 12.3 文本行为

开放式 meaning 可直接影响提示词。只有实现了 `observeResult(output, context)` 的注册文本行为才能写 exception。

第一轮可先实现一个最容易验证的 `reply.advice-style`：

- baseline 明确；
- 输出观察器能判断“先陪伴后建议”是否真实发生；
- 结果消息落盘后才记 exception；
- 无法可靠判断时宁可不记。

不要仅因提示词里写过要求，就假定模型做到了。

---

## 13. 节点十一：旧 facts 幂等迁移

### 13.1 目标

让已有 memory facts 中明确记录的偏好/边界进入 adaptation，解决当前真实数据“记得但不会做”的断层。

### 13.2 迁移边界

只迁移：

- 来源可追溯到用户消息；
- fact 明确属于 preference/boundary/permission；
- 文义足够明确；
- 没有被撤回；
- 没有同源 guide。

不迁移：

- 伙伴自己的推测；
- 一次情绪；
- 模糊总结；
- 无来源文本；
- 敏感许可但无法确认用户明确表达。

### 13.3 claim 生成

- voice 多/少/禁止可用本地确定规则生成 claim；
- sleep 早点/晚点可生成 claim；
- 表情包许可只有能唯一解析稳定图片身份时生成 specific claim；
- 无法确定机器 claim 时只迁移 meaning。

### 13.4 幂等标记

adaptation book 增加 migration 状态，例如：

```js
migration: {
  factsV1CompletedAt,
  sourceIds
}
```

重复启动、崩溃重试、多人伙伴并行迁移都不得重复导入。

优先为真实旧数据建立测试副本，不能直接拿正式用户数据做破坏性试验。

---

# 第四部分：用户纠错与长期观察

## 14. 节点十二：查看、忘掉与对话式纠错

### 14.1 界面位置

在现有设置/记忆查看内部跳转解决，不新增独立卡片。

展示轻量内容：

```text
我们相处出来的理解
- 你喜欢我多发一点语音
- 你难过时希望先陪着，别急着分析
```

不展示：

- 关系分数；
- 概率；
- exception 次数；
- emerging/settled 阈值；
- 内部 schema。

### 14.2 操作

- 忘掉：确认后 revoke，不物理删除历史；
- 纠错：采用“对话式修订 + 建议应用”；
- 修改建议先预览，用户确认后才写盘；
- 确认修改失败时停留在原界面，保留聊天历史、建议和确认按钮；
- user-wide 与 relationship 范围说清楚；
- 敏感许可纠错必须明确，不做自动扩大。

### 14.3 路由与测试

增加只读列表、revoke、建议生成、确认应用接口。测试覆盖：

- 只读展示不泄露内部数值；
- revoke 后下一轮立即失效；
- 网络/模型/写盘失败不关闭确认界面；
- 旧建议不能覆盖新版本账本；
- user-wide 不误改其他伙伴级 guide。

---

## 15. 节点十三：observed 弱观察

此节点必须最后施工。在明确表达、代码适配器、exception、feedback、habit、纠错全部稳定前，不接 observed。

### 15.1 建立条件

- 至少跨 3 个生活日；
- 多条用户行为证据；
- 有明确、可解释的重复模式；
- 与 explicit guide 不冲突；
- 不从沉默或“没有反对”推断喜欢。

### 15.2 永不自动观察的内容

- 辱骂与羞辱许可；
- 性与身体接触；
- 隐私分享；
- 安全边界；
- 支付、联网、外部发送等能力许可。

### 15.3 置信度与回退

- observed confidence < 1；
- 只柔和影响文本和软倾向；
- 不得突破 permission-required adapter；
- 遇到 explicit 声明立即让位；
- 用户纠错后回退并避免同证据再次生成。

---

# 第五部分：测试与验收

## 16. 自动测试矩阵

### 16.1 adaptation

- canonical schema 往返；
- claim 级冲突覆盖；
- current-turn/life-day/until；
- user-wide/relationship 隔离；
- 撤回与 supersede；
- 临时 guide 不永久化；
- 多 claim guide 不夹带旧 claim。

### 16.2 voice

- deny 任意随机值阻断；
- more > baseline > less；
- tier 不被回写；
- hardMax、冷却、连续、长度；
- ready 后一次提交；
- synthesis/file/patch/stale 任一失败不消费 runtime；
- 撤回或 generation token 失效不提交；
- exception 幂等。

### 16.3 sticker

- store 往返后的 canonical allow/deny；
- local/source subject；
- 缺 ID 安全失败；
- specific 不扩张；
- veto 永远优先；
- 用户主动发送不受影响；
- 结果落盘后 exception 一次提交。

### 16.4 sleep

- normal/exception/deferred/later-notice；
- wake-sooner/baseline/wake-later 单调；
- read/reply 两种乱序；
- 重复事件幂等；
- 失败重试、重启恢复；
- wakeCount 只增一次；
- later-notice 文案不写被吵醒；
- exception 只有 committed 才参与沉淀。

### 16.5 feedback/habit

- 24 小时归因窗；
- 同源去重；
- 一条反馈只绑定一个 exception；
- 3 次/3 日/1 正反馈进入 emerging；
- 再 2 次/2 日/累计 2 条独立反馈进入 settled；
- 负反馈立即 reverted；
- guide 撤回后 emerging 回退；
- settled 可被新的明确偏好推翻。

### 16.6 migration/UI

- facts 迁移幂等；
- 无来源不迁；
- 敏感许可不猜；
- 查看不泄露内部数值；
- 忘掉立即生效；
- 确认失败保留界面；
- observed 不越过 explicit 和敏感许可边界。

---

## 17. 实机验收脚本

自动测试全绿后，由用户重启 Hana 再验收。小花不主动重启。

### 场景 A：语音

1. 对伙伴说“以后别给我发语音”；
2. 连续聊足够多轮，确认任何随机结果都没有语音；
3. 改口“以后可以多发一点语音”；
4. 确认设置 tier 没变，但有效概率/软额度变化；
5. 人为制造一次合成失败，确认 runtime 与 exception 不增加；
6. 成功 exception 后检查 adaptation 账本只记一条。

### 场景 B：睡眠

1. 在伙伴睡眠窗口发普通消息；
2. 分别覆盖 normal、exception、deferred；
3. exception 检查 readAt、wakeCount、resultMessageId、committed exception；
4. deferred 检查“后来看到”，不得写被吵醒；
5. 在 read 与 reply 之间重启，确认不重复 wakeCount、不重复回复；
6. 模拟生成失败重试，确认同一 trigger 只提交一次。

### 场景 C：表情包

1. 明确允许某一张损友图；
2. 轻松语境下该图可以进入候选；
3. 认真难过语境下仍可因性格/语境不使用；
4. 其他损友图不能因该许可一起放开；
5. 明确禁止或撤回后，该图立即从伙伴候选中消失；
6. 原图库 veto 始终有效。

### 场景 D：撤回与异步任务

1. 发出偏好消息并确认 guide 已落盘；
2. 在 TTS pending 时撤回来源消息；
3. 等请求返回，确认没有 ready、runtime、exception；
4. 检查 guide 已 revoked；
5. 已发送历史仍保留。

### 场景 E：沉淀

用测试时钟或专用测试数据跨生活日构造：

- 3 次真实破例 + 3 日 + 1 条正反馈 → emerging；
- 再 2 次 + 再 2 日 + 第二条独立正反馈 → settled；
- 明确负反馈 → 立即 reverted；
- 过程不显示可刷进度。

### 场景 F：旧数据

1. 准备包含“喜欢多听语音”的旧 fact；
2. 首次迁移生成一个 guide；
3. 重启多次仍只有一个；
4. 无法唯一识别图片的旧表情许可只迁 meaning，不开放整库；
5. 在设置里能查看、忘掉、对话修订。

---

## 18. 推荐逻辑提交边界

不要按文件机械拆，按可独立审查和回滚的能力拆：

1. `test: add canonical relationship-plasticity failure baselines`
2. `fix: unify canonical guide claim resolution`
3. `fix: enforce voice deny and preference directions`
4. `fix: enforce sticker-specific relationship permissions`
5. `fix: make wake transaction order-independent and durable`
6. `fix: revoke guides and invalidate pending behaviors`
7. `feat: commit adapter exceptions idempotently`
8. `feat: attribute feedback and consolidate habits`
9. `fix: activate temporary guide lifetimes`
10. `feat: apply relational policy to proactive and awaiting behavior`
11. `feat: migrate explicit legacy facts into adaptation`
12. `feat: add adaptation view forget and conversational correction`
13. `feat: add guarded observed guides`
14. `test: complete end-to-end relationship plasticity regression suite`
15. `docs: reconcile design testing and pending ledgers`

每个提交都应能单独通过对应专项测试；最终完整节点再跑全量。

---

## 19. 最终完成定义

只有同时满足以下条件，才能称为“关系可塑性完成”：

1. 明确偏好能影响所有伙伴文本生成；
2. 语音、睡眠、表情包、主动联系读取同一 canonical policy；
3. 明确禁止在运行时可靠阻断；
4. current-turn/life-day/until 正确生效和过期；
5. normal 行为不记 exception，真实破例成功后才记；
6. exception 有稳定来源、触发消息、结果消息和幂等键；
7. 反馈只能来自后续用户消息；
8. 多次破例与正反馈可跨日形成 emerging/settled；
9. 负反馈、改口和撤回立即影响未来行为；
10. 原有 facts 幂等迁移，不要求用户重新说一遍；
11. 用户能查看、忘掉和对话纠错；
12. observed 不推断敏感许可，不覆盖 explicit；
13. 不写回 Hana 人格、主对话、全局记忆或其他伙伴数据；
14. `node --test tests/*.test.js` 全绿；
15. Hana v2 静态校验通过；
16. 完成语音、睡眠、表情包、撤回、沉淀、迁移六组实机验收；
17. `manifest.json`、`PENDING_CHANGES.md`、`TESTING.md` 与设计文档版本事实一致。

在以上条件未全部满足前，文案应准确写“阶段性接入”或“部分闭环”，不能写成完整关系可塑性已经完成。
