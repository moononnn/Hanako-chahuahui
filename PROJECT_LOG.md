# 茶话会开发日志

## 项目缘起
让茶话会里的伙伴在长期相处中形成属于这段关系的理解与习惯，在保留自身性格、边界和生活节奏的前提下，偶尔愿意为关系弯曲软规则，并让真实发生过的破例经过反馈后慢慢沉淀。

## 想要的效果
伙伴记住的不只是聊过什么，也逐渐理解玥儿喜欢怎样被回应。关系变化只发生在茶话会自己的数据里，不写回 Hana 人格、主对话、全局记忆或其他伙伴的数据。

## 当前版本
以 `manifest.json` 为准：v0.7.365

## 当前进度
2026-09-22 完成关系可塑性阶段 A 的第一个纯逻辑节点：
- `lib/adaptation.js`：guide 归一、有效期、作用域、claim 校验、冲突覆盖、撤回与通用提示词块。
- `lib/plasticity.js`：限制分类、统一关系因子、疲劳因子、硬边界、明确拒绝、破例概率与幂等例外记录。
- `tests/adaptation.test.js`、`tests/plasticity.test.js`：14 条专项测试全绿。

随后完成 adaptation 持久化节点：全局 `user-adaptation.json` 与伙伴级 `adaptation.json` 已接入 store，支持重启恢复、伙伴隔离、脏数据归一和来源撤回后的习惯回退；专项存储测试 56 条全绿。

随后完成明确偏好候选预筛：普通聊天不触发额外模型，候选消息在落盘后绑定真实 sourceMessageId 并写诊断，专项与全量回归均通过。

随后完成明确偏好结构化 reconciler：候选消息调用一次 20 秒超时的 utility 模型，经过本地协议校验后写入全局或伙伴 adaptation 账本；失败与脏回包不挡聊天，专项与全量回归通过。

随后完成 adaptation block 的通用文本接线：普通回复、主动/夜间留言、等回音和小动作文案都读取同一份归一化相处理解，并补断链测试。

随后完成睡眠/回复适配器纯逻辑：关系只提高额外醒来机会，保留困意和硬延迟上限；deferred 只转 later-notice，normal/exception 采用两阶段提交契约。全量回归通过，尚未替换真实 `planReply()` 执行链。

随后将 wakeDecision 接入 `planReply()` 与真实排期：deferred 不进入实时回合，保存 pending 后恢复为 later-notice；normal/exception dozing 暂保留实时路径。

本轮完成 wakeCount/readAt 收拢：实时与排期共用真实已读提交点，exception 按 woken → 回复成功落盘后 committed 两阶段完成，失败重试不重新抽签。随后完成语音 normal/exception/hard 适配与表情包关系许可适配。

2026-09-22 v0.7.349～v0.7.350 继续修复正式运行时阻断：canonical claim 改为 claim 级决胜；语音 deny/more/less 与表情包稳定 subject 读取正式持久化结构；睡眠 read/reply-ready 改成交换律事务，失败重试和重启恢复保留事务；later-notice 使用“后来看到”语义；撤回同步失效伙伴级/user-wide guide、相关排期与 TTS 令牌；临时 guide 的 current-turn/life-day 由系统补齐。v0.7.351 按交叉审查补严 deny 决胜、表情包临时上下文和 TTS claim 内容指纹。全量 806 条通过，静态校验 0 error、1 warning。

## 当前工作卡
- 目标：完成关系可塑性与偏爱机制的全链路施工。
- 当前节点：计划节点 1～13 与最终交叉审查已完成；自动化链路闭环，下一步由玥儿重启 Hana 做实机验收。
- 成功证据：改动前 v0.7.348 全量 796 条通过；失败基线稳定复现 7 个 canonical 断点；交叉审查持续补齐 feedback/habit 与 proactive/awaiting 边界；节点十完成统一主动策略，节点十一接通旧 facts 幂等迁移；修复后 v0.7.365 全量 840 条通过；静态校验 0 error、1 warning；关键模块 `node --check` 通过。
- 本次不做：不接真实模型、不改 Hana 外部人格、不发布；语音、睡眠与表情包只接入茶话会自己的行为链，不向宿主人格或全局记忆外溢。
- 影响的 owner / 事实源：关系账唯一使用 `lib/relationship.js`；数据仍只属于茶话会自己的 dataDir。
- 停止条件：发现 hard/identity 边界被关系覆盖，或测试无法证明来源、有效期、撤回和幂等语义。
- 未知 / 未验证范围：当前新模块尚未接入 `index.js`、`store.js`、`prompt.js`、`reply.js`、`voice.js` 与 UI。

## 已知问题 / TODO
- [x] canonical guide/claim、语音 deny/more/less、表情包 stable subject。
- [x] 睡眠 normal/exception/deferred/later-notice 交换律事务与恢复。
- [x] 撤回 guide 与相关未提交行为失效；临时 guide 上下文补齐。
- [x] 统一 exception 落账 API，并接睡眠/语音/表情包成功提交点。
- [x] feedback 归因与 emerging/settled/reverted 沉淀。
- [x] proactive/awaiting 统一关系策略与首个可观察文本行为。
- [x] 旧 facts 幂等迁移。
- [x] 查看/忘掉/对话式纠错。
- [x] observed 弱观察。
- [ ] 完成六组实机验收。

## 自动测试
- 命令：`node --test <tests/*.test.js 显式文件列表>`
- 覆盖：关系 guide 归一/有效期/冲突/撤回、提示词脱敏、hard 边界、关系单调因子、疲劳衰减、破例幂等。
- 最近结果：2026-09-23，v0.7.365 全量 840/840 通过；Hana v2 静态校验 0 error、1 warning。

## 备份记录
- 2026-09-22 12:41：`L:\哈娜的工作台\_插件备份\茶话会_2026-09-22_124130_关系可塑性修复前`，133 个文件，3,319,119 字节。

## 审查记录
- 2026-09-22 — 设计稿与本地纯逻辑自审 — 已核对 hard/soft-limit/habit/identity、来源与有效期边界；代码仍未接入运行链。
