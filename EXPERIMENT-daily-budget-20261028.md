# 实验：主动消息配比（2026-10-28）

> 这份文件是给**换窗口之后的自己**看的。看不懂的时候先读「怎么回滚」，那个随时能退。
> 实验性质：临时改动，不是定稿。观察够了一周，要么转正写进 CHANGELOG，要么按下面的步骤撤掉。

## 一句话

视频 5→2、新闻 4→1、兴趣 1→2，并且当天兴趣还没发够时让种子先挑这一轮。

## 为什么做

视频分享（2026-10-17）和新闻（2026-10-20）是后加进来的两条通道，各自带着「有货就发、发到上限为止」的配额。兴趣种子只有一个「每天最多 1 条」的天花板。**一个是保底的量，一个是封顶的闸**，跑满八天：

| 日期段 | B站视频 | 新闻 | 兴趣种子 | 关系式主动（没事找她） |
|---|---|---|---|---|
| 2026-10-21 ~ 10-28（8 天） | 34 | 23 | 1 | 5 |
| 2026-10-16 ~ 10-18（3 天，视频刚开、新闻还没上线） | 3 | 0 | 0 | 28 |

视频 5 加新闻 4 等于 9，而实际每天主动消息平均 8.25 条。也就是说主动消息的产能天花板，现在是这两条后加通道的配额和决定的，别的通道全在缝里插。

关系式由头那条更好说明问题：`reasonEligible` 里写着 `!video && !news`，手上有素材就不抽关系式由头。素材配额一降，它自己就回来了，不用改它。

## 改了什么

只动一个文件：`index.js`。四处改动，都带 `__LAB_BUDGET_20261028__` 标记，`grep __LAB_BUDGET_20261028__ index.js` 能一次全找出来。

1. **新增常量块 `LAB_BUDGET`**（约 478 行，`const PERSONA_TTL_MS` 之前）。四类配额和优先级全在这一块里，改配比只改这里。
2. **`videoQuota()`**：取「用户设置里的 videoShareMaxPerDay」与 `LAB_BUDGET.video` 的较小值。她自己把设置调低，实验不会把上限抬回去。
3. **`newsQuota()`**：同上，对着 `LAB_BUDGET.news`。新闻那个 4 条/天写死在 `lib/news-feed.js` 的 `NEWS_MAX_PER_DAY`，设置页没有入口，所以这一条只能从代码里压。
4. **`OBSERVATION_MAX_PER_DAY`**：从硬写的 1 改成读 `LAB_BUDGET.interest`。
5. **候选顺序**：原来 `candidateSeed` 的条件里挂着 `candidateVideo`，有视频就轮不到种子。现在拆成 `seedCandidate`（手上的种子）和 `seedFirst`（当天兴趣配额还有余量时，这一轮先给种子），视频退到下一个落点。
6. **`candidateNews`**：多加一个 `|| candidateSeed`。种子占住这一轮时，新闻不挤进来，保持「一轮只带一份外部素材」。

没碰的：取材逻辑、提示词、锚点门、睡前收尾、待办提醒、公共事件、门禁条件。视频和新闻怎么抓、怎么写，一个字没改。

## 配比表

| 类别 | 改前 | 改后 |
|---|---|---|
| B站视频 | 5 | 2 |
| 新闻 | 4 | 1 |
| 兴趣种子 / 探索发现 | 上限 1 | 目标 2（配额内优先，不再是能发就发的天花板） |
| 关系式主动（没事找她） | 被素材挤到 0~1 | 不改它，素材配额降了自然会回来 |
| 机动（待办、睡前收尾、节日天气、被薅起来） | 不占额 | 不占额 |

## 怎么回滚

**第一种，一行开关（最快，推荐）**

`index.js` 第 489 行附近：

```js
export const LAB_BUDGET = Object.freeze({
  enabled: true,   // ← 改成 false
  ...
```

改成 `false` 之后重载 App，下一个 tick 就回到原来的 5 / 4 / 1 和原来的候选顺序。其余代码一行都不用动，留着不影响。

**第二种，用备份覆盖**

改动前的原文件整份放在：

```
L:\哈娜的工作台\茶话会实验\2026-10-28-主动消息配比\before\index.js
```

覆盖回去：

```powershell
Copy-Item 'L:\哈娜的工作台\茶话会实验\2026-10-28-主动消息配比\before\index.js' 'C:\Users\laotv\.hanako\apps\chahuahui\index.js' -Force
```

（`D:\HanaHome\.hanako\apps\chahuahui\index.js` 跟上面是同一份内容，改一边另一边就跟着变。）

**第三种，git（不推荐）**

`git checkout -- index.js` 能退，但工作树里还压着气泡装扮那批没提交的改动，这条命令会把它们一起冲掉。除非先确认那些改动已经落盘或存档，否则别用。

**回滚之后要做的**：重载 App，然后把两个测试文件也一起退回去（`before\tests\` 里存着原版）：

```powershell
Copy-Item 'L:\哈娜的工作台\茶话会实验\2026-10-28-主动消息配比\before\tests\ui.test.js' 'C:\Users\laotv\.hanako\apps\chahuahui\tests\ui.test.js' -Force
Copy-Item 'L:\哈娜的工作台\茶话会实验\2026-10-28-主动消息配比\before\tests\proactive-reasons.test.js' 'C:\Users\laotv\.hanako\apps\chahuahui\tests\proactive-reasons.test.js' -Force
# lab-budget.test.js 可留可删：留着也全绿，删了更干净
# Remove-Item 'C:\Users\laotv\.hanako\apps\chahuahui\tests\lab-budget.test.js' -Force
```

不改也行：`ui.test.js` 那两条断言改成 `seedCandidate` 在回滚后依然成立（变量名就是那个），`proactive-reasons.test.js` 那条用例在两种上限下都过，`lab-budget.test.js` 断的是接线形状不是开关状态，关掉开关也照样绿。也就是说回滚只需要把 `enabled` 改成 `false`，测试那边什么都不用动。

## 实验目录里都有些什么

```
L:\哈娜的工作台\茶话会实验\2026-10-28-主动消息配比\
├─ stats.mjs         统计脚本，随时跑
├─ index.js.patch    相对 git HEAD 的 diff（注意：里面混着气泡装扮那批未提交的改动）
├─ before\            动手前的原样：index.js、PENDING_CHANGES.md、TESTING.md、tests\ 里两个被改过的文件
└─ after\             改完的版本，同上一套
```

## 怎么验证生效

1. `node --check index.js` 通过。
2. `node --test tests/lab-budget.test.js tests/ui.test.js tests/proactive-news.test.js tests/video-share-routes.test.js` 全绿。
3. 重载 App 之后，看茶话会「设置 → 视频分享」那一栏，每天的实际上限应该是 2 而不是 5（配额是代码里压的，设置页显示的数字还是 5，别拿那个当证据）。真正的证据看下面的统计。

## 观察指标（一周后跑这个）

统计脚本在同目录 `stats.mjs`：

```powershell
node 'L:\哈娜的工作台\茶话会实验\2026-10-28-主动消息配比\stats.mjs'
```

它会按天打印各类型条数。判断标准：

- 兴趣种子 / 探索发现：每天 ≥ 1，理想 2。**这是这次实验的主要内容，达不到说明种子优先那段没接上。**
- 视频：每天 ≤ 2。
- 新闻：每天 ≤ 1。
- 关系式主动：应该从 0~1 回到 1~2。要是还是 0，说明配额不是唯一的原因，得回头看 `reasonEligible`。
- 总量：跟改前差不多（8 条左右），这次不是要把话说少，是换内容来源。

## 已知未修

`maybeExploreInterest` 里，`videoEnabled` 为真时整条探索通道都走视频取材分支，纯兴趣探索（产出 discovery 的那段）根本到不了。所以就算配比调完，discovery 仍然不会新增，短期能发的只有库里那 30 条种子。种子用完之前看不出来，用完就会见底。

修法是让两条路轮流（比如一次探索视频、下一次探索兴趣，或者按当天配额决定），但那是**另一件事**，涉及取材节拍的改动，不放在这次实验里。等这轮结果出来再决定。
