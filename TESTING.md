# TESTING · 茶话会

## 气泡装扮两侧拆开（2026-10-28 晚）

- 起因：玥儿要「我只能选我自己的气泡，伙伴的气泡由 ta 自己决定、按性格心情自己换，频率不要高，以后还会加更多样式」。
- 做法：CSS 属性从一枚 `data-bubble-skin`（挂在 `.chat` 上，一套管两个人）拆成两枚 `data-me-skin` / `data-ta-skin`，变量块按 `--skin-me-*` / `--skin-ta-*` 前缀劈成两块。两枚属性都挂在同一个容器（聊天窗 `.chat`、预览 `.skin-sample`）上，靠继承各管一侧；缺哪枚哪侧就回落原来的取色。
- 原味不再算一种皮肤：它是「没打扮」，所以 `me`/`ta` 是 `plain` 或空时直接 `delete dataset`，不靠一份什么都不定义的皮肤块假装。
- 伙伴挑选（`lib/bubble-skin-mood.js`，纯逻辑）：三条护栏写在代码里——① 现在这套本来就搭今天的心情就不换；② 一天只看一次（按凌晨四点切生活日，记在 `bubble-skin.json`）；③ 当天心情没任何皮肤认领（比如「委屈」「生气」）就保住上一套，不硬塞。挑哪套用 `daySeed` 算，同一天同一伙伴重启也不变。`SWITCH_CHANCE = 0.55` 是「换日子时有一半机会换」。
- 心情来源直接用现成的心情日盘（`lib/mood-daily.js` 那十三格），不新开一套状态。每套皮肤在 `BUBBLE_SKINS` 里用 `moods` 声明自己在哪些心情下成立；没写 `moods` 的不进伙伴池（原味就是这样）。
- 接口：`/partners` 多回一个 `partnerSkins`（伙伴可选池）与原有的 `bubbleSkin`（我这一侧）；`/thread/:agentId` 多回一个 `partnerSkin`（ta 那一侧，可能为 null）；`/settings` 的每位伙伴多回一个只读 `bubbleSkin`；新增只读 `GET /bubble-skin/partner/:agentId`。
- 前端：`applyBubbleSkin(me, ta)` 分两枚属性各写各的；`lastPartnerSkin` 单独存一份，因为好友轮询（`loadPartners`）只知道自己那侧，拿它去覆盖会把 ta 的壳冲掉。换人时先摘掉上一位的壳，新人的头几条消息不会顶着别人的颜色。
- 设置页只画「我」那一枚预览（画两枚会让人以为 ta 那侧也能设），底下用一句只读的「ta 那边现在戴着 xx」。
- 迁移：老的 `bubbleSkin` 配置原样保留当「我」这侧，不丢设置；伙伴那侧的账是新建的，第一次拉到线程时才开始挑。
- 以后加样式：`lib/bubble-skins.js` 加一行（带 `label` / `hint` / `moods`），`ui/assets/bubble-skins.css` 补 `[data-me-skin="新id"]` 与 `[data-ta-skin="新id"]` 两组变量，再按需补 `.row.me` / `.row.ta` 的具名规则。伙伴那边不用改逻辑。
- 测试：`tests/bubble-skins.test.js` 从 12 项扩到 20 项，新增两侧拆分、伙伴池、心情映射、`moods` 只能是真心情、皮肤账单独存这几组。另外补了三个隔舱测试的桩（`tests/loading-routes.test.js` 的 `partnerSkinFor` / `PARTNER_SKIN_IDS`、`tests/ui-loading.test.js` 的 `lastPartnerSkin` / `applyPartnerSkin`、`tests/video-settings-ui.test.js` 的 `paintPartnerSkinNote`）——那三处用 `vm` 把源码切片单独跑，新加的模块级名字不在切片里。
- 已知未验：真实 App 里的观感（两侧同时挂不同皮肤时，小熊耳朵、像素字体这类改轮廓的规则会不会互相影响）；伙伴那侧一天一次的翻页没有实际跑过一整天；预览里只看得到自己那侧，看不出「两个人不同套」的实际效果。

## 主动消息配比实验（2026-10-28，临时可回滚）

- 背景：2026-10-21 到 10-28 八天里，主动消息中 B站视频 34 条、新闻 23 条、兴趣种子 1 条、关系式主动 5 条。视频分享（10-17）和新闻（10-20）是后加的通道，各自带着「有货就发到上限」的配额；兴趣种子只有一个「每天最多 1 条」的天花板。视频 5 加新闻 4 等于 9，而实际每天主动消息平均 8.25 条，等于产能天花板由这两条后加通道定。
- 范围：只改 `index.js`，四处，全带 `__LAB_BUDGET_20261028__` 标记。新增 `LAB_BUDGET` 常量块；`videoQuota()` 与 `newsQuota()` 取用户设置与配比表的较小值；`OBSERVATION_MAX_PER_DAY` 改读配比表；候选层把 `seedCandidate` 与 `seedFirst` 拆开，当天兴趣没发够时种子先挑这一轮；`candidateNews` 加一个 `cappedSeed` 排除项（用闸后的值，不是候选本身）。没碰取材、提示词、锚点门、门禁。
- 配比：视频 5→2，新闻 4→1，兴趣上限 1→目标 2。关系式由头不改，素材配额降下来它自己会回来。
- 测试：`node --test --test-timeout=120000 "tests/*.test.js"` → **2468 条，2464 通过，0 失败**（其余 skip/todo）。比上一轮多的几条来自新增的 `tests/lab-budget.test.js`。
- 跟着改的两处旧断言：`tests/ui.test.js` 两条源码形状断言把 `candidateSeed` 换成 `seedCandidate`；`tests/proactive-reasons.test.js` 的「观察式用满新闻照样轮得到」把已发种子从 1 条改成 2 条（实验期上限是 2，回滚后 2 条同样算用满，两边都过）。
- 已知未验：没在真实 App 里跑满一天看效果；`maybeExploreInterest` 里视频开着时纯兴趣探索仍产不出 discovery，这轮没动，种子库存 30 条用完会见底。
- 回滚：`index.js` 的 `LAB_BUDGET.enabled` 改 `false` 即可，详细步骤与备份路径见 `EXPERIMENT-daily-budget-20261028.md`。

## 气泡动效：被顶的那一下有惯性，没事自己会动（2026-10-28）

- 起因：玥儿说气泡本来就是个装饰物，希望它自己偶尔动一下；发消息把旧消息顶上去的时候，那一下要有点惯性。
- 滚动那一半（`ui/panel.html` 的 `scrollDown`）：从 `scrollTop = scrollHeight` 硬跳改成缓动，easeOutCubic，130～300ms 按距离给；一次跳超过 1200px、批量渲染（`renderAll` 末尾传 `smooth=false`）、系统开了减动效、或者环境里没有 `requestAnimationFrame` 时仍然瞬移。缓动期间 scroll 事件不重算 `autoScrollAllowed`（否则自己滚到一半就被当成“用户往上翻了”而停车），`updateJumpBottom` 也不报那个小按钮（中间几帧本来就不在底部，一闪像卡了）；用户一动 `wheel` / `touchstart` 就交还控制权。
- 耳朵那一半（`ui/assets/bubble-skins.css` 的「小熊会动」）：被顶时 `is-shoving` 给最后 4 条挂动画，耳朵被横向甩一下再弹回；没事时由 JS 隔 5～13 秒随机挑一条在视口里的气泡加 `ear-flick`，抖完就拆。
- 第一版用 `scale` / `rotate` 做，被玥儿一眼看出穿帮：耳朵根部露出到气泡框外面。原因是变换是绕原点整体变形，绕耳根（`transform-origin: 50% 100%`）转或压时，元素框的底边两端会一抬一压，和气泡那条边框线错开。
- 现在只动三个不改底边的属性：① `aspect-ratio`（高度随之变化，而 `translateY(-100%)` 用的是元素自身高度，高度变多少就上移多少，底边永远钉在气泡顶边）；② `translate` 做水平惯性（平移不改变高度，底边仍在同一条水平线上）；③ `border-radius` 的水平分量做「歪」（只改形状）。整条动画里没有任何 `transform` 和 `scale`。
- 第二个坑：`--ear-w` 里带百分比，写成 `height: calc(var(--ear-w) * .55)` 是不对的——CSS 变量是文本替换，那里的 `100%` 会跑到 height 语境按父元素高度解。所以高度只能用 `aspect-ratio` 从宽度派生，`--ear-w` 只用在 width / right / left 这三个横向属性上。
- 左右两只耳朵分居两侧，用 `--ear-dir`（me 为 1、ta 为 -1）分开方向，不分开会出现“一边往外甩、一边往里扭”。
- 随机那一半故意不认皮肤 id：JS 只发 `ear-flick` 这个信号，哪套皮肤响应交给 CSS（目前只有小熊有规则）。面板里也就不必再拄一份皮肤名单。
- 测试：`node --test tests/bubble-skins.test.js tests/ui.test.js tests/ui-loading.test.js` → **196 条全通过**（新增一条守动画的：两个 keyframes 不能出现 `transform` / `scale` / `rotate`，必须有 `aspect-ratio`、分左右方向的 `translate` 与 `border-radius`，只给 `nth-last-child(-n+4)` 挂，减动效要关）。
- 可调参数：缓动时长在 `scrollDown` 的 `duration`，压扁幅度在 `@keyframes bear-ear-shove`，随机间隔在 `scheduleIdleFlick` 的 `5000 + Math.random() * 8000`。
- 已知未验：手感（时长、幅度、间隔）无法自动测，只能人眼；没在真实 App 里连发几十条试探重叠情况；打字气泡、茶杯那几条路径也会调 `scrollDown`，所以“她开始打字”时耳朵也会被顶一下，目前当彩蛋留着。

## 气泡装扮：可爱组补两套，14 套（2026-10-28）

- 起因：删掉十二套以后可爱组只剩奶糖、樱花两套，九宫格摆不满一行。玥儿要求补两套，且「差别大点、可爱一点」。
- 新增：小熊（`bear`）、棉花糖（`marshmallow`）。两套走的是完全不同的路子——小熊改**轮廓**（气泡上沿探出一对耳朵，全套里唯一靠剪影就能认出来的一套），棉花糖改**软度**（26px 圆角、雾状自影、1px 糖粉底纹，没有一处硬边）。
- 小熊的耳朵：`::before` 画一只、`::after` 画另一只（`::after` 那条规则得摆在文件后半「小尖尾」之后，因为那条公用规则同权重且排得更后）。形状是压扁的半椭圆，`translateY(-100%)` 让底边正好落在气泡顶边上，底部那道 1px 描边和气泡的上边框线重合，所以看起来是气泡自己的轮廓起了两个包，不是贴上去的两片。内耳偏上，顶上一道高光，布点纹理跟气泡同一套（11px 的格）。
  - 尺寸跟着气泡宽度走：`width: min(36px, max(0px, calc((100% - 32px) / 2)))`，两只相邻、离角 16px（正好让过 16px 的圆角）。分母里那个 2 是两只耳朵，32px 是两边让的角；所以「嗯」这种几十像素宽的气泡里耳朵自己缩到看不见，不会悬在角外面。
  - 踩过的坑，记一下：① `radial-gradient(circle at 50% 46%, …)` 不写尺寸时默认 `farthest-corner`，半径撑到格子四角，视觉上就是一整块方色块，必须 `circle closest-side`；② 用「只有十几像素高的窗口去裁半圆」的写法，窄气泡上窗口一收窄，两只耳朵被裁成一根竖条；③ `border-bottom: 0` 配底部小圆角，会在两个下角漏出两道白缝，就是「贴纸感」的主要来源；④ 用 `border` 画耳朵轮廓，侧边框到底边收尾处会留两个 1px 竖线头，换成 `inset 0 0 0 1px` 的阴影环就没了；⑤ 耳朵底边和气泡边框线错开几个像素时会出现两条平行线，那才是最像「拼接」的东西，对齐后消失。
- 棉花糖的奶黄侧故意不选薄荷：青瓷已经是青绿，两套摆一起会像同一家的。
- 对比度实测（14 套 × 3 种底色 × 两侧 = 84 样本，方法同上：固定格子 + 截图采样 + WCAG 相对亮度）：小熊 `ta` 7.64 / `me` 7.40，棉花糖 `ta` 7.42 / `me` 7.78。全局最差仍是星夜的 4.57（那颗 1.4px 星点落在采样格里），`ta` 侧 5.74（波点），水位没被这两套拉低。
- 测试：`node --test tests/bubble-skins.test.js tests/ui.test.js` → 160 条全通过（其中气泡装扮 12 条，含一条守耳朵的：半椭圆形状 + 描边环 + 宽度让过圆角）。
- 只改 `ui/assets/bubble-skins.css`、`lib/bubble-skins.js`、`tests/bubble-skins.test.js` 三处；没碰消息渲染、存储、接口。
- 已知未验：没在真实 App 里点一遍；设置页小预览里的耳朵缩到 15px 一带，只有个轮廓，看不出内耳；首页气泡宽度不到一百像素时耳朵几乎看不见（公式自己收窄的结果，不是漏画）。

## 气泡装扮：下架十二套，只剩十二套（2026-10-28）

- 玥儿点名删掉：便签、宣纸、亚麻、缎带、糖果、奶油泡芙、猫爪、云朵、液态金属、星球、极光、烈焰。
- 范围：`lib/bubble-skins.js`（目录 24 → 12）、`ui/assets/bubble-skins.css`（变量、尾巴、圆角、动画、深底名单一起擦干净，重写成 12 套的干净版本）、`tests/bubble-skins.test.js`（白名单改成 12 条，并新增一条「下架的皮肤不再留变量」的守卫）。没碰消息渲染、存储、请求。
- 顺手清掉的：几处早期编辑留下的重复注释；删掉的十二套里有两套带小尖尾的规则写了半截，这次一并收。
- 删掉的变量原文整份留在 `C:\Users\laotv\AppData\Local\Temp\bubble-preview\bubble-skins-24-full-20261028.css`（临时目录，重启不保证还在）。要捡回来：把对应 `[data-bubble-skin="xxx"]` 块贴回样式表，再在目录里加一行就行。
- 老配置不会报错：`normalizeBubbleSkin` 认不出就回原味。存过 abovelisted 任一皮肤的，设置里会显示成「原味」。
- 剩余分组：淡雅 3（原味、青瓷、描边）、可爱 2（奶糖、樱花）、花哨 7（彩虹糖、波点、镭射、星夜、赛博、霓虹雨、像素）。
- 对比度重测（12 套 × 3 种底色 × 两侧 = 72 样本）：`ta` 侧最差 **5.74**（波点），`me` 侧最差 **4.57**（星夜的 1.4px 星点落在采样格里，不是字压不住底）；其余中位在 6.08～16.81。
- 测试：`node --test tests/bubble-skins.test.js tests/ui.test.js tests/ui-loading.test.js tests/load.test.js` → **200 条全通过**（比上一轮多一条，新加的那条守卫）。
- 已知未验：没在真实 App 里点一遍；临时目录里的备份文件不保证长期存在，真当资产的话得另存。

## 气泡装扮：旧版九套按材质重做（2026-10-28）

- 范围：只动 `ui/assets/bubble-skins.css`（缎带、描边、糖果、星夜、波点、星球、烈焰、像素、奶油泡芙）与 `lib/bubble-skins.js` 里对应几条 hint。没碰结构、存储、消息渲染。
- 起因：这九套是第一轮做的，多半只有一层渐变加一条边，跟后加的那九套（纸 / 布 / 釉 / 果冻 / 爪印 / 镭射 / 金属 / 霓虹雨）摆一起显得单薄。改法统一成「每套一个能认出来的材质」。
- 逐套：
  - 缎带：底色压深半档（#c8e9d8 → #bde2cf、奶白 → 米黄），斜 150° 的白光才照得出来；光的宽度靠 stop 缓缓没收。试过用 `background-size` 单独圈 48% 宽的一层，右侧会留一道硬切边，已回退。
  - 描边：2px 外线套一圈内亮线，像双线信封。
  - 糖果：糖纸扭纹从 .34 收到 .19（2px / 12px 一格），之前蓝底上直接变成了警戒线。
  - 星夜：三层碎星（大小不一、错开排）加紫 / 蓝两团星云。原来星星太淡，远看就是块深紫卡纸。
  - 波点：一大一小两档点错开排。单档是印刷网点纸，两档才像印在布上的波点。
  - 星球：加「地平线」一道 2px 亮线（从边框内缩 1px，贴最底会被 1px 边框完全盖住，试过看不见）+ 右上角明暗交界。
  - 烈焰：渐变末端 #c9451c → #dd5f1a、文字压到 #2b0e02，对比度从 5.08 升到 8.06（me）/ 9.85（ta）；补了竖向热浪条；**撤掉小尖尾**，平色尾巴接在竖向渐变上会露一个深色三角。
  - 像素：底边压 4px 的 45° 斜纹当八位机抖动过渡。
  - 奶油泡芙：加糖粒底纹与右下暖芯影，底色拉回奶白（上一版偏焦糖）。
- 对比度实测（还是那套固定 274×62 格子的量尺）：24 套 × 3 种底色 × 两侧共 144 个样本，中位 5.29～16.83。`ta` 侧最差 **5.74**（波点），`me` 侧最差 **4.57**。
  - 4.57 这个数是星夜里 1.4px 的星点正好落在采样格里，不是字压不住底；把星夜除外，其余最差 5.13（缎带）。星点亮度已从 .46 收到 .37，再压就看不出星了。
- 测试：`node --test tests/bubble-skins.test.js tests/ui.test.js tests/ui-loading.test.js tests/load.test.js` → **199 条全通过**。
- 已知未验：没在真实 App 里逐套点一遍（需要宿主与已安装的 App 实例）；多层 `background` 与内联 SVG 在宿主 WebView 里的合成开销仍只做静态判断。

## 气泡装扮：扩到 24 套、删磨砂（2026-10-28）

- 范围：`lib/bubble-skins.js`（重写目录，加 `group` 与 `BUBBLE_SKIN_GROUPS`）、`ui/assets/bubble-skins.css`（删磨砂、重做樱花、加九套）、`ui/settings.html` + `ui/assets/settings.css`（设置页按组分段）、`index.js`（多给一个 `bubbleSkinGroups`）、`tests/bubble-skins.test.js`。没碰消息渲染、存储、请求。
- 设计参照：QQ 空间装扮平台的气泡规范（300×80 九宫格切图 + 每套自带一个文字色），它的分类词是唯美/简约/炫酷/可爱/潮流/鲜明。本项目对应成淡雅/可爱/花哨三组，文字色仍然写在每套自己的变量里。
- 渲染核对：24 套 × 两侧 × 3 种底色用 Edge headless 直接加载 App 的 `panel.css` + `bubble-skins.css` 逐套看；预览页与量尺页的皮肤名单由脚本从 `lib/bubble-skins.js` 读出来生成，不在脚本里另抄一份。设置页的预览用一份静态 mock（同一份 `settings.css` + `bubble-skins.css`）看分组标题和栅格。
- 对比度实测（不只靠眼看）：每套皮肤做成固定 274×62 的格子、里面只放全角空格，截图后用 `System.Drawing` 采样中间带（内缩 24/20，避开通写两头与圆角），按 WCAG 相对亮度算「文字 vs 底色」，每种底色取最差一档。
  - 修前：磨砂在深底 3.65（就是这轮被删的原因之一）、星球 1.98（星环横穿文字）。
  - 现在：24 套 × 3 种底色，`ta` 侧全局最差 **5.66**，`me` 侧全局最差 **5.08**（烈焰），其余绝大多数在 7 以上。
- 顺手修的：宣纸的纤维从等距斜线换成十几根长短不一的短线（等距斜线看着像条纹纸）；猫爪的爪印放大一档才看得见；云朵从拉长的白斑换成画出来的云形（椭圆一拉长就是一道斜光）。
- `node --check index.js`、`node --check lib/bubble-skins.js` 通过；`node --test --test-timeout=30000 tests/bubble-skins.test.js tests/ui.test.js tests/ui-loading.test.js tests/load.test.js` → **199 条全通过**。不是全应用回归。
- 已知未验：没在真实 App 里逐套点一遍（需要宿主与已安装的 App 实例）；新套的纹理都靠 `background` 多层渐变与内联 SVG，宿主 WebView 的实际合成开销只做了静态判断，没量过四百条以上的会话。

## 气泡装扮：文字可读性与六套重做（2026-10-28）

- 范围：`ui/assets/bubble-skins.css`（重做描边、磨砂、星夜、星球、烈焰、像素、波点、樱花、便签的变量与纹理，加磨砂的 `backdrop-filter`，收尾已改成跟渐变末端同色）、`lib/bubble-skins.js`（三条 hint 跟着改）、`ui/panel.html`（删掉前端那份皮肤白名单抄本）、`tests/bubble-skins.test.js`（换成「不该出现皮肤 id」用例）。只动样式与这一处校验，没碰消息渲染、存储、请求。
- 渲染核对：16 套 × 3 种底色（素纸 / 照片感图案 / 接近纯黑）× 两侧，用 Edge headless 直接加载 `panel.css` + `bubble-skins.css` 截图逐套看。截图必须关掉 `.bubble` 的入场动画（`pop` 起始 `opacity:0`，headless 恰好截在那一帧，整页会看着像蒙了一层雾）——第一轮就是被这个假象误导的。
- 对比度实测：把每套皮肤的气泡做成固定 274×62 的格子、里面只放全角空格，截图后用 `System.Drawing` 采样中间带（避开圆角和描边），按 WCAG 相对亮度算「文字色 vs 底色」的对比度，取最差一档。修前最低是磨砂在深底上的 3.65、星球的 1.98（星环横穿文字）。现在两侧 16 套 × 3 种底色里最差一档：磨砂 4.00（纯黑壁纸、遮罩 0% 的极端情形），其余全部 ≥4.64，多数 ≥5.5。磨砂那个数已经抬到极限：再抬白就彻底不透光了。
- `node --check index.js` 通过；`node --test --test-timeout=30000 tests/bubble-skins.test.js tests/ui.test.js tests/ui-loading.test.js tests/load.test.js` → **198 条全通过**。不是全应用回归。
- 已知未验：没在真实 App 里逐套点一遍（需要宿主与已安装的 App 实例）；`backdrop-filter` 在宿主 WebView 里的实际开销只做了静态判断（只对可见气泡生效），没量过几百条消息长的会话。

## 发链接看视频工具：补接画面（2026-10-24）

- 修前基线：实际聊天工具执行器只有collectInboundVideo→packMaterials，没有enhance；同模型缓存中存在画面事实，工具仍回标题档。真路由回归先失败、接入后通过，未用修后成功倒推修前情况。
- 修复：原始文字缓存与模型隔离的视觉缓存分开；伙伴自行调用时才增强；同一回复的多工具调用及正文重试最多一次新视觉尝试，缓存不占额度；识图未验证或失败回原文字，不换模型；signal中断及时退出旧工具，后续不发新识图或回喂。
- `node --test --test-timeout=15000 tests/video-tool-visual-routes.test.js`：5/5。覆盖缓存事实进入实际toolResult且零新增识图/取流、未验证配置保留标题、伙伴不调用则零视频网络、同轮A缓存→B新失败→C因预算不取流、正式/turns插话在旧view仍挂起时4秒内重开且旧请求放行后无额外回喂/取流。测试使用临时目录、假网络与假模型，退出统一清理。
- `node --test --test-timeout=20000 tests/video-tool.test.js tests/video-inbound.test.js tests/video-understanding.test.js tests/load.test.js tests/reply-cancel-model.test.js`：63项，59通过、4既有短链用例跳过、0失败。`node --test --test-name-pattern='公开源码' tests/reply-rules-compact.test.js`：1/1。三组共65通过、4跳过，不重复累加复跑；不是全应用回归。
- index.js、video-tool.js、本地诊断模块语法及git diff --check通过。独立只读复核本轮接线、预算与中断，无阻断；未声称完整重审旧取帧器。
- 真实App验收：通过仅本机诊断钩子直接调用实际createReadVideoTool，目标BV1VthX6XE2E，当前伙伴配置，8413ms返回hasVisual=true；工具文本含【她刚给你发了一个视频】、【画面记录】及局部观看/无音轨边界。08:46:02.736后台同时记录video.visual.cache-hit和chat.tool.video：hasVisual=true、visualReason=cache、visualAttempted=false。本次复用早些时候已验证的视觉缓存，没有新增付费识图，也未让模型生成一段真实聊天来验证自然度。
- 插话测试观测说明：假宿主保存了messages数组引用，后续工具循环追加会反映在首轮记录上；是否回喂以真正发出的模型请求次数及新回合输入为准。断言共两轮、新回合无旧toolResult，不能把旧引用变化误报为多发请求。
- 已正式reload并完成上述真实工具调用；不改变伙伴是否选择点开的自主权，不扩大短链/番剧支持范围。版本/README/简介未动，未上传。下节“未补链接”是此前取帧修复阶段的范围记录，本节已续修。

## 视频画面理解：宿主可执行候选上限（2026-10-24）

- 修复前基线：App v0.11.0；同一失败视频 `BV1VthX6XE2E` 在真实App首阶段返回 `APP_EXECUTABLE_REQUEST_INVALID`，原文 `resolveExecutable requires 1 to 64 command names or absolute paths.`。当前App环境候选91项，本机普通进程可算出136项，不能混称实测数字。旧日志在模型request前只剩笼统失败码。
- 修复：候选去重后按不超过64项分批，命中即停，不截断后面的安装位置；各批共用原取帧60秒截止。定位失败保留安全错误码，去掉一律归咎授权的文案；正式编排增加白名单阶段日志，不落原异常、地址、帧字节或凭据。
- 局部命令：`node --test tests/video-frame-resolver.test.js tests/video-frame-reader.test.js tests/video-understanding.test.js tests/load.test.js` → **54/54**；`node --test --test-name-pattern='公开源码' tests/reply-rules-compact.test.js` → **1/1**；语法与diff检查通过，非全量。新增5例覆盖真实超64候选、第三批才命中、去重/命中即停、共享时限、权限错误不吞。入口最后调整后再次load **6/6**与源码守卫 **1/1**通过，不重复累加。
- 中途自检：诊断钩子位置一度影响仅关闭DEV的源码守卫；一次临时移动又把await放进同步apply，装载检查立即失败，未重载该错误版本。已将顶层导入放回既有钩子区并加文件存在性检查，最终语法、装载和源码守卫均通过。没有用失败命令后面的退出0冒充通过。
- 修复后同场景：真实App取帧 **3658ms**，9图（1封面+8正片）共 **125317B**；正片采样 **13.5 / 26 / 26.5 / 27 / 27.5 / 28 / 28.5 / 40.5秒**；局部连续clip **26～28.5秒、2fps**。未把跨片采样混进连续段。
- 真实识图只发1笔，沿用当前已验证的 **minimax / MiniMax-M3.1-Flash-Preview**，9图，maxTokens3600，不换模型不重试。08:13:46.857 request → 08:14:30.314 `video.visual.ready`，事实说明 **597字**；以正式缓存文件回查确认status=ok、model/图数/采样/clip一致。同步诊断调用30秒RPC先超时，不能因此断言后台识图失败或再次重发。
- 缓存复验：同视频同模型 **127ms**，`attempted:false`、`reason:cache`，复用08:14:30.312的同一visual，没有新识图请求。没有伪造`cached:true`字段（正式结果以reason表达）。
- 独立只读复核无阻断。正式reload已执行；本次只证明该视频的真App解码→识图→缓存闭环，不证明全天自动分享自然度，也**未补发链接/看视频工具漏接画面增强**。不全量、不发布，版本/README/简介不动。

## 公共事件：节日祝福与天气提醒主动开口（2026-10-24）

- 范围：新增 `lib/public-events.js`（读拾光记 `alerts` 契约、认节日、挑天气事件、按亲密度加权分配负责人、当天账本）；`proactiveSpec` 加节日/天气两条成文引导；`gateCheck` 加 `freeOfQuota`；主循环把公共事件插在到点待办/回声/跟进/晚安/新闻视频之后。**只跑假宿主与假模型，未调用真实模型，不声称这两个功能在实机聊天里的自然度已验收。**
- 语法：`node --check index.js lib/public-events.js lib/compose.js lib/proactive.js lib/proactive-reasons.js lib/daybook.js`，6 份通过。
- 定向：`tests/public-events.test.js` **17/17 通过**（读快照的失败路径、节日一人一条与跳日重算、天气挑件与过点不报、抽签定死与换事重抽、亲密度加权 600 轮分布、别人记账记不上）；`tests/compose.test.js` **46/46 通过**（新增 4 条：节日不追问不套贺词、清晨首条不降级成可选背景、天气不念预报不客服腔、公共事件占位时种子让位）；`tests/load.test.js` 装载守卫通过。
- 全量：`node --test --test-concurrency=1 "tests/*.test.js"` → **2308 条，2295 通过，9 失败，4 跳过**。
- 这 9 条与本版无关，逐条核实过：
  - **7 条是上一个提交（6731fc5, 2026-10-23）留下的测试债**：`dev-thread-range.test.js` 4 条（含 `公开包不声明本机模型工具权限`——个性工具改成不走剥离后，manifest 能力断言未同步）、`longterm-routes.test.js` 2 条、`search-tool.test.js` 1 条（仍断言旧写法 `tools: offerSearchTool ? [SEARCH_TOOL] : null`，而源码早已改成 `chatTools.push`）。
  - **1 条**是 `ui.test.js` 的 `ta 回话前先把上次没看清的图补上`，断言窗口里多了 `signal?.throwIfAborted()`，也是上一提交带来的。
  - **1 条** `reply-rules-compact.test.js` 的 `公开源码即使只关闭DEV_TOOLS` 是**另一个工作窗口正在改的视频诊断钩子**引起的：`if (DEV_TOOLS) videoDiagnosisHooks = await import(...)` 是顶层 await，不能交给 `new Function`。那个块不是本版改的，归视频那条线自己收。
- 本版顺带修的时间炸弹：`tests/video-sharing.test.js` 3 处 `selectVideoShares` 没传 `now`，用真实当前时间对抗 2026-10-16 的账本，隔八天就滑出保留窗口。已改为显式传入。
- 未做：**未重载**。工作树里同时躺着另一个窗口正在改的视频理解链，现在重载会把半成品带进运行时；等那条线收尾后一起重载，再做实机验收。
- 未做：设置页还没有这三个开关（`publicEventsEnabled` / `festivalGreetingEnabled` / `weatherAlertEnabled`）的界面，后端已经接受写入。

## 近期上下文与连续插话（2026-10-23）

- 范围：近期上下文选择/连续用户消息合并、取消与持续插话、实时/排期/恢复防重、后台摘要与日账退避。只使用假宿主及假模型跑真实App路由，不改生产聊天，不声称真实模型理解效果已验收。
- 命令：`node --check index.js`；`node --test --test-timeout=30000 tests/reply-context-window.test.js tests/reply-interrupt.test.js tests/reply-cancel-model.test.js tests/reply-memory-latency.test.js tests/reply-supersede.test.js tests/reply-supersede-routes.test.js tests/memory.test.js tests/model.test.js tests/prompt.test.js tests/memory-pipeline.test.js tests/reply-action-target.test.js tests/thread-recovery.test.js tests/load.test.js`；`git diff --check`。
- 最终相关13文件 **204/204通过，0失败、取消、跳过**，非全量。覆盖六次真实路由插话/七次协调器插话、突发合并、迟到废稿、取消确认失败不重开/不切模型、真实异常不吞、长消息首尾/12组往来/48行与12000字预算、硬撤回、小动作、摘要水位不遮原话、装载恢复不并发重启实时回复、旧日账慢/失败不挡眼前两轮且不逐条重试；既有图像/语音、目标存活、清空与未读回归。
- 首轮203项202通过/1撤回用例30秒取消：定位为撤回队列前的假后台画像未释放，只在该用例按PROFILE_SYSTEM自动返回画像；产品断言保留，复跑及最后防重修正后204项通过。普通宿主abort仍快速返回；仅连续插话内部取消标记要求最多1秒确认释放，未知取消不冒充成功，也不继续开新生成。
- 正式reload成功，inspect确认host=on/agent=on。代码已加载；未调用真实模型，纠正关系理解与聊天连贯自然度待实际聊天观察。后台原始渠道错误未查明，存量积压不宣称已清空；本次只隔离阻塞及失败热重试。版本、README、简介未改，未上传。

## Hana 对话修订性格工具（2026-10-23）

- 正式 `chahuahui_personality` 的 read / preview / apply 不调用模型，只开放本App调色盘的色、行为、自画像与语料。省略区段保留、提供数组替换整个区段；先读版本、预览不落盘，具体修改获同意后应用。复用 commitChange/saveKnowing 历史，回读验证，原token重试幂等；未确认成功不宣称保存。token仅在本次进程内保留30分钟，重载后明确失效。
- 严格校验未知字段、路径型编号、未知伙伴、引用、重复色/编号、角色数量、长度与活行为上限；不接受隐藏兴趣/采访/聊天/Hana身份。颜色按底/主/点归一；旧档超量活行为、空壳色及既有捏人草稿显式提示，不删除旧草稿。宿主附加context在注册包装层分离，不回显，不放宽业务白名单。
- 命令：`node --check index.js`；`node --check lib/personality-tool.js`；`node --test tests/personality-tool.test.js tests/persona-review.test.js tests/palette.test.js tests/load.test.js`；`git diff --check`。最终相关4文件 **77/77通过，0失败、取消、跳过**；语法与diff通过。未全量。
- 覆盖读/预览零写入、局部修改、保护其他字段与其他伙伴、历史快照、重复/并发apply、版本与同版本指纹冲突、后台无关写盘推进版本后的幂等、过期/跨伙伴/无确认、静默截断拒绝、任意色序、写失败保留token、已写后抛错重查、回读不一致和宿主context分离。真实云构建stripDevOnly仅在临时副本运行，证明正式注册与工具暴露声明保留、调试入口及外部备份写权限仍剥离；不冒称完整打包/发布验收。
- 交叉审查后补齐幂等版本口径、色序和生效提示。正式reload成功，宿主目录tool_help可发现完整工具名；实机初读曾因宿主附加context被拒，针对该原因修复并复跑上述77项，重新reload后read→preview→apply成功。指定伙伴性格按已确认范围保存，回包verified=true；同token再次apply返回alreadyApplied=true且版本不增加。未调用真实模型，聊天自然度待观察。版本、README、简介未变，未上传。

## 后台只读用量查询（2026-10-22）

- 新增 `chahuahui_usage_query`，只在显式调用时经 `ctx.bus.request("usage:list", filter)` 查公开宿主账本。默认最近1小时、`attributionKind=plugin`、最多100条，可按带时区时间、宿主归因伙伴、provider/model、状态筛选；范围最多7天、单次最多200条。没有分页入参契约，不伪造翻页；有游标或达到上限均标部分统计。
- 范围边界：公开契约没有 App 身份字段，结果明确是宿主插件调用，可能含其他 App；伙伴字段属于宿主账本归因，不保证是茶话会业务聊天对象。未实现视频关联或按业务用途拆分，不冒称茶话会专属总账。金额单位未核不展示，不额外调用模型，也不读底层账本/正文/密钥。
- 用量规则：逐字段保留已知部分合计、已知请求数、未知请求数；无已知数据为null，真零保留0；各字段按宿主原值独立展示，思考和缓存不再自行加到总量。失败、usage_missing、无效回包、授权失败和成功空列表均不能当零消耗；任何结果都不承诺整个时间段完整。成功与错误输出均走字段白名单，排除会话标识、原始API、元数据、金额及宿主原始错误文本。
- 验证命令：`node --check index.js`；`node --check lib/usage-query.js`；`node --test tests/usage-query.test.js tests/load.test.js`。
- 结果：初验17/17通过；独立复核后补空列表含义、完整性声明、注册失败不阻断装载、错误文本白名单，最终相关两文件19/19通过（查询14项、装载5项），0失败/取消/跳过；两份JS语法与git diff --check通过。未全量、未发真实模型请求。
- 运行时：已尝试正式reload，宿主要求审阅新增 `app/usage.read` 权限，尚未放行；代码已保存，真实账本接口与工具可见性须授权后再验。版本、README与简介未改，未上传。

## 通用立场准则（2026-10-22，CHF-20261022-04）

- 最终补齐：独立复核发现专注陪读的独立生成路径漏接，在 `focusReminderSpec.system` 复用同一CORE，新增start/reply/distracted/end四种接线断言；不改专注行为。上列7文件命令追加 `tests/focus-companion.test.js tests/focus-routes.test.js`，最终9文件166/166通过，0失败/取消/跳过；focus-companion语法通过、git diff --check通过。补齐后再次正式reload成功，inspect为host=on/agent=on。以下138项为补齐前阶段结果，保留追溯。

- 范围：legacy/compact普通回复、主动/晨间/夜间/睡前/睡后被叫起/催话共用 `STANCE_CORE`，各路径只注入一次。构造验收题覆盖随口质疑、事实纠错/误解、情绪与明确边界、真心赞同和温柔性格；仅验证规则文本与接线，不冒充真实模型行为验证。
- 命令：`node --test tests/prompt.test.js tests/reply-rules-compact.test.js tests/compose.test.js tests/familiar-tease.test.js tests/proactive-expression.test.js tests/stance.test.js tests/awaiting.test.js`；`node --check` 检查 `lib/prompt.js`、`lib/reply-rules-compact.js`、`lib/compose.js`、`lib/stance.js`、`lib/awaiting.js`。
- 结果：相关7文件138/138通过，0失败/取消/跳过，5份JS语法通过。首轮5文件117/118通过，唯一失败为legacy两项旧字面断言，按新语义改为已确认事实/记录缺失/新信息/直接道歉边界后通过；后续diff检查发现两行行尾空格，已仅去除空格。
- 已通过正式入口reload，随后inspect为host=on/agent=on。此结果证明本地代码已加载，真实聊天效果仍待观察；未调用真实模型、未全量、未改版本/README/简介、未提交上传。

## 她说「没玩过」，伙伴不再光速滑跪（2026-10-22）

- 她的要求：茶话会里她说「第五人格？没玩过」，伙伴回「啊我串台了…那两条平衡调整我先撤下，不拿它烦你了哈」。她问：这类滑跪之前修过，为什么这次还是。
- **她的本意（第二轮澄清）**：她要的不是「我不喜欢的就别推送给我」，而是**回应时的姿态**——她说没玩过/不喜欢时，伙伴可以嘲讽、可以耐心解释、可以拉她入坑，而不是光速道歉自我否定。第一轮我误读成「别再给我看这类内容」，往温度账与选材侧加了一整套降频（温度账 `drop` 档、`isDirectionPaused()`、视频候选过温度账），她否掉后已整块撤回，源文件与测试全部还原。
- 现场证据：`app-data/chahuahui/v2/threads/hanako.json` 消息 491/497（02:53、07:43 两条第五人格平衡调整视频）、498（她那句）、499（滑跪那条）；`diagnostics.jsonl` 08:25:33 记 `reply.prompt.profile = compact-v1`、`systemChars 23308` → 纪律块都在场上，不是缺规则。
- 改了什么（只改回应层与分享侧，不碰选材/频率）：
  1. `lib/reply-rules-compact.js`（运行时真正生效的那块）、`lib/prompt.js`（旧版全量）：给活法——不懂就耐心用白话补上好玩在哪、讲到她也想试（可以把她拽进坑）；或者顶回去、损一句、抖机灵，把自己那份喜欢守住；实在没兴致才收着不提。「收着」定死为「不再往下讲」，不是撤回、不是道歉、不是认错。点名禁「我串台了」「我发错了」「我先撤下」「不拿它烦你了」这类撤回式收场；也禁拿「那我以后不说了」换她一句好话。对象从「你刚讲过的话」扩到「链接、视频、推荐的圈子」。
  2. `lib/stance.js`：立场料同一层意思（想讲就讲到她自己也想试；收着不是撤回）。
  3. `lib/compose.js` 视频分支：讲具体游戏/剧/圈子时先用一句白话说清那是什么，别用只有玩过的人才懂的行话——她可能压根没玩过。
- 命令：`node --test tests/prompt.test.js tests/reply-rules-compact.test.js tests/compose.test.js tests/stance.test.js tests/familiar-tease.test.js tests/proactive.test.js tests/proactive-expression.test.js tests/topic-mood.test.js tests/video-sharing.test.js`；4 个源文件 `node --check`。
- 结果：定向 9 文件 204/204 通过、0 失败；4 份 JS 语法通过。新增用例 2 项（compact 与 legacy 各一：活法在位、「收着」有定义、撤回式收场与讨好式承诺被点名禁、对象覆盖到链接/视频）。
- 真机对照（用**旧**提示词，compact-v1，openai-codex/gpt-6-luna，体感台 5 个关系档 × 3 次 = 15 条，同一场景「第五人格？没玩过」）：15 条里 0 条滑跪；最好的一条是「我刚才直接默认你玩过第五人格了，没玩过很正常哈…下次我先把游戏名说清楚」。结论：纪律块本身大体拦得住，这一回的触发另有条件（真实那轮系统提示 23308 字，是体感台 14639 字的 1.6 倍；真实关系深过体感台最深档；真实那轮前面挂着两条同方向分享）。
- 未全量、未改版本号、未改 README/简介；**reload 未生效**（宿主要求她审阅新权限后重载）。新提示词的真机复验待重载后再跑；重载后若体感台仍拉不到数组参数，就在茶话会里直接发一句「第五人格？没玩过」看回复。

## 等回复茶杯分「在写 / 在说」两档（2026-10-21）

- 她的要求：语音回复时等待态要跟文字回复不一样；她先想过整杯晃，最后定成「热气收起 + 茶面荡波 + 杯身轻颤」。
- 选档依据：`POST /thread/:id/message` 的 turn 回包新增 `voiceRequested: isExplicitVoiceRequest(stored.text)`，前端 `typingIndicator(mode)` 据此选档。概率触发的语音算不出来，仍走文字档；语音到了气泡自带声波。
- 改动：`cupOnTheTable(mode)` 给 `.wait-cup-slot` 加 `voice` 类；`waitingCupSvg` 补第三圈 `w-r3`（默认 display:none）；CSS 新增 `wQuiver`（0.4px / 0.42s）、`wTeaPulse`、`wRippleFast`（0.95s，三圈错开 0.32）；`resetWaitCup` 同时清掉 voice 类。
- 命令：`node --test tests/ui.test.js tests/ui-loading.test.js`；`node --check index.js`、`node --check lib/voice.js`。
- 结果：173/173 通过；两份 JS 语法通过。vm 沙箱里跑过 `typingIndicator("voice")`：slot 带到 `wait-cup-slot voice`、`w-r3` 在；`resetWaitCup` 后类名回到 `wait-cup-slot`、内容清空。
- 未全量、未调真实模型；真机切换待发一句「发条语音给我」验证。

## 消息「复制」真进剪贴板（2026-10-21）

**她指出的问题（原话要点）**：点消息旁边的「复制」，文字进不了她的剪贴板。

**查清的链路**：

- 宿主 SDK 文档里写明过这一条（`📚 HanaAgent 知识库/05-插件系统/sdk-源码解析-v0.446.6/plugin-sdk-api.md`）：「iframe 受浏览器剪贴板权限策略限制，直接调 `navigator.clipboard` 常被拒，此方法绕到宿主进程侧执行」——`hana.clipboard.writeText()` 走宿主进程，才绕得开。
- 旧 `copyMessage` 的写法是：`if (navigator.clipboard?.writeText) { await ... } else { textarea + execCommand }`。只要 `navigator.clipboard` 存在就走它，一旦被拒（正是 iframe 里的常态）就直接跳进 `catch` 收工，**execCommand 那层从没被试过**。
- 宿主确实提供了这条能力：App UI SDK 里有 `hana.clipboard.writeText`（`ui/assets/hana-app-sdk-ui.js`，运行时能力名 `clipboard.writeText`），但要在 manifest 声明对应能力，官方市场里的 App 用的就是 `app/ui.clipboard-write`。茶话会 manifest 原先没声明。

**改了什么**：

- 新增 `writeClipboard(text)`：按可靠度逐层退——① 宿主进程侧 `hana.clipboard.writeText`；② 浏览器原生 `navigator.clipboard.writeText`；③ 老办法 textarea + `execCommand("copy")`（补上 `focus()` / `select()` / `setSelectionRange()`，并把 helper 缩到 1px 定位在左上而不是完全透明）。一层失败就记一笔继续下一层，全退完才算失败。
- `copyMessage` 改成走 `writeClipboard`，只有真写进去才提示「复制好了」；全失败时提示改成「剪贴板没接住，长按选中文字自己复制吧」（给一个真能用的出路）。
- `manifest.json` 的 `capabilities` 新增 `app/ui.clipboard-write`。

**权限状态**：宿主对新增能力要求本人审阅——`extension_manager reload` 返回「needs the user's review for newly declared authority」，重载被拦在审阅前，新增能力要等她在宿主里点同意才生效。不点也能用（走 ②③ 两层老路），但 iframe 里被拦的概率仍在。**她已审阅通过并重载，能力生效。**

**本轮自动测试**：

- `tests/ui.test.js` 新增 1 项（静态契约）：manifest 声明了 `app/ui.clipboard-write`；三层依次出现；一层失败要记账继续退；只有真写进去才提示「复制好了」。
- 相关三个文件（界面渲染 / 界面静态契约 / 上下文构建）**218/218 通过，0 失败**。
- 范围说明：只跑直接受影响的三个文件，未跑全量。

**实机确认（2026-10-21 晚）**：她审阅权限、重载后自己点了一次复制，粘出来有东西；引用块也确认好了。

## 消息引用：引用的那句话得看得见（2026-10-21）

**她指出的问题（原话要点）**：她在茶话会里引用伙伴发的那条新闻，想让 ta 再联网搜一遍；发出去以后屏幕上只有她自己那句话，引用的那条完全没显示。

**查清的链路**：

- 后端一直通：右键消息 →「引用」把原文放进输入框上方的待引用条 → 发送时随 `quote` 一起 POST → `index.js` 落库时 `...(quote ? { quote } : {})` 存进这条用户消息 → `lib/prompt.js` 的 `threadToMessages` 把引用注进伙伴上下文（「［对方引用了你之前的一条消息：…］」，原文上限 4000 字）。
- 断的是界面这一层：`ui/panel.html` 里从头到尾没有任何一处读 `message.quote`（搜 `quote` 只有输入框上方那条待引用条），引用块从来没被画出来过。发出去后待引用条清掉，这条消息就彻底看不出引用过谁——她那头是「空引用」，ta 那头其实收到了。

**改了什么**：

- `ui/panel.html` 新增 `quoteBlock()`（左侧竖线 +「引用」标签 + 原文，最多三行，悬停看全文）与 `attachQuote()`（把引用块摆进消息列第一格，也就是气泡上方）。
- 历史重画（`renderMessage`）和刚发出去那一刻（`send()` 里的乐观气泡）都摆：不能等回包才补上，那几秒里她也得看得见自己指的是哪条。
- `ui/assets/panel.css` 加 `.message-quote` 样式：宽度收在气泡同一条 78% 线内，长新闻只露三行。

**本轮自动测试**：

- `tests/ui-loading.test.js` 新增 2 项（渲染级断言，跑的是 panel.html 里的真函数）：引用块跟着消息出现并站在气泡上方；没有引用的消息不多出引用块、空引用不画空壳。
- `tests/ui.test.js` 新增 2 项（静态契约）：两处都画引用块、后端存 quote、历史接口把 quote 带回来；引用原文进伙伴上下文且有长度上限。
- `tests/prompt.test.js` 新增 2 项（运行时断言）：被引用的原文真的进模型上下文；没有引用的消息不多出引用壳子。
- 相关三个文件 **217/217 通过，0 失败/0 取消/0 跳过**；`ui/panel.html` 两段内联脚本 `node --check` 通过。
- 范围说明：只跑了直接受影响的三个文件（界面渲染 + 界面静态契约 + 上下文构建），未跑全量。

**实机确认（2026-10-21 晚）**：重载后她重开茶话会引用了一条新闻，引用块出现在自己气泡上方。

## 伙伴自己发起的联网搜索：从「应用代搜」到「它自己动手」（2026-10-21）

**她指出的问题（原话要点）**：她在茶话会里说「好好，你去找找，然后我们吃瓜」，伙伴上一句刚说「我去查」，下一句就改口「我这边现在没法直接搜网页，你把链接甩我嘛」。她要的是「联网功能得能让伙伴主动搜索，而不是现在这种后台搜了给她提供消息」。

**查清的链路**（证据在 `app-data/chahuahui/v2/threads/hanako.json` 与 `diagnostics.jsonl`）：

- 那一轮（2026-10-21 08:58 本地）应用侧的「回复前代搜」压根没触发：`isChatSearchCandidate` 要求出现「新闻/热搜/最新/帮我查/查一下」这类说法，「你去找找，然后我们吃瓜」一句都不沾（`瓜` 不在公开话题词表里），于是 `chat.search` 这条诊断整段不存在——不是搜了没结果，是压根没搜。
- 搜索一直是「应用在回复前代为搜」：关键词规则先判定这句要不要查 → 规划模型出搜索词 → 应用去搜 → 结论塞进提示词的「这轮临时查到的公开消息」块。伙伴全程没有发起权，只能被动接收材料。
- 它说「我去查」是句空话，下一轮被真实能力打脸，只能自己拆台。`DESIGN-topic-followup.md` 里那句「这仍是应用在回复前代为搜索，不是模型获得任意时刻可调用的自由联网工具」就是这条设计的自白。

**改了什么**（机制改动，不是文案改动）：

- 宿主模型契约本来就支持工具（`app-contract/models.d.ts`：`tools` 声明、`tool-call` 事件、`toolResult` 消息、`stopReason: "toolUse"`），宿主自己执行工具，App 只负责把工具声明交上去、把结果接回来。
- `lib/model.js`：`parseNdjson` 认 `tool-call` 事件与 `done.assistant.content` 里的 `toolCall` 部件（正文空但有工具调用＝这一回合正常完成）；`generateReply` 增加工具回合——模型调工具 → 应用执行 → 结果作为 `toolResult` 消息回喂 → 模型再开口；一轮最多 2 次工具调用、2 个工具回合；最后一轮不给工具，逼出一句人话而不是停在工具调用上；provider 明说不接工具声明时，退回不带工具的普通回复（不换模型、不换嗓子）。
- 新增 `lib/search-tool.js`：工具声明、搜索词处理（长度、私聊线索、联系方式、平台账号一律拦在门外）、结果排版（只给标题/摘要/来源，明说不是网页正文）。
- `lib/chat-search.js` 导出 `containsPrivateStory`（私事出门那道门，工具这条新路沿用同一道）。
- `lib/prompt.js` + `lib/reply-rules-compact.js`：新增「你能自己上网查」这一块（精简档位有对应短版）——想查就查、别先说「我去查」再改口、材料只是标题摘要、没查到照实说、搜索词里不许有私事。
- `index.js`：聊天回复这一路，当应用侧这一轮**没拿到材料**时把 `web_search` 工具给伙伴（已经拿到材料的那一轮不给：一份材料够了，别两边各搜一次）；工具执行走既有引擎链（必应/各家付费层/熔断/记账/隐私门），`createWebSearchTool` 里记 `chat.tool.*` 诊断。
- 内测面：新增 `/probe/tool` 路由与 `chahuahui_tool_probe` 工具（真机验一次宿主到底会不会发 `tool-call` 事件，工具结果是假的、不打真实搜索）；两处都在 `DEV_TOOLS` 哨兵内，发布副本照旧剥掉。

**本轮自动测试**：

- 全量 `node --test --test-concurrency=1 --test-reporter=tap`（tests/ 下全部文件）**2074/2074 通过，0 失败／0 取消／0 跳过**（最后一轮改动后再跑一遍，结果相同）。
- 新增 `tests/search-tool.test.js`（8 项）：工具声明形状、正常查询放行、空词/过长词、名字与私事与联系方式与平台账号拦下、结果排版与长度上限、没查到/被拦下给的是人话不是内部状态码、接线静态契约。
- `tests/model.test.js` 新增 6 项并改了 1 项：工具回合（模型自己发起 → 工具结果回喂 → 才给正文，含回喂消息形状断言）、工具 id 规整、assistant 与 toolResult 用同一个合法 id、搜索次数上限与最后一轮不给工具、provider 不接工具时退回普通回复、没有工具时不多花一次往返；`parseNdjson` 返回值多了 `toolCalls/assistantContent/stopReason`，空输入那条断言同步更新。
- 改了 2 处既有契约测试（都是本轮改动直接引起的，意图不变）：`tests/load.test.js` 内测工具清单从 3 个变 4 个（新增的 `chahuahui_tool_probe` 必须包在 `DEV_TOOLS` 里）；`tests/proactive-news.test.js` 「用了 searchWeb 就得真 import」那条从 2 处调用变 3 处（取料、兴趣探索、工具）。
- 过程中修掉两个自己造的问题：新增哨兵块时只加了 START 没加 END，发布剥离会报「哨兵不配对」（`tests/dev-thread-range.test.js` 抓住），已补齐；utility 兜底那条路不收工具结果消息（实机报 “Utility message content only accepts text entries”），退过去前先把对话洗成纯文字，且一条都不用动时原样交回原数组。

**实机验证（真模型，openai-codex/gpt-6-luna）**：

- 宿主**确实**会把工具调用发出来：模型自己发起了 `web_search`，查询词是它自己写的（「最近 科技新闻 …」），应用执行了工具，材料回到了它手里，它拿着材料开口讲话——不是「我这边没法搜，你把链接甩我嘛」。
- 真实搜索那一轮（`real=1`，真打网络、真花额度）：`chat.tool.search` 记到 `ok:true, engine:tavily, results:8`（她自己的 Tavily Key 通的），模型拿到 1459 字材料后讲了**两条真新闻**（新华网的模拟计算芯片进展、印度 AI 与云基建投资），带来源链接，并自己加了一句「这些是搜索摘要里的信息，细节还得看原文和论文才能确认」——材料只是标题摘要、不能装成读过全文这条纪律，实机上是守住的。
- 途中踩到并修掉的真问题（都是实机报的，不是推演）：
  1. `APP_MODEL_INVALID_REQUEST: assistant.toolCall.id must be 1-128 ASCII identifier characters.`——宿主给的 toolCall id 不合法，回喂被拒。回放前把 id 规整成合法标识符，assistant 那条与 toolResult 那条用同一个。
  2. openai-codex/gpt-6-luna 吃不下「带工具结果的那一轮」：`The model provider could not complete the request.`。于是加了三级降级：① 不带工具声明但保留工具结果 → ② 材料当一段文本块交给它 → ③ 都没有才退回没材料的普通回复；并且记住哪家 provider 吃不下这个形状，以后直接走 ②。
  3. 降级链拖太长会把调用窗口耗光：工具调用有 30 秒上限，超了就报 `APP_CALL_TOKEN_INVALID`（后续模型调用发不出去）。所以带工具结果的那一轮不重试（一次就退），降级步骤也不重试。
  4. 探针本身：把模型调用放到后台跑会被掐掉凭据（同一个 `APP_CALL_TOKEN_INVALID`），必须在调用期内同步跑完、结果先落盘。

**未验证 / 待实机**：

- 聊天里真实的那一路（应用侧代搜 + 伙伴自己动手）还**没有由她本人触发过一次**：本轮的真机验证走的是探针（同一条 `generateReply` + 同一个真实搜索工具），不是她那句「你去找找」。她试一句才知道自然度与等待时间。
- 主动消息那条路（世界领域 → 应用拼词 → 池子 → 伙伴讲）本轮**没动**：它本来就是「应用替 ta 搜好」，跟这次说的「自己动手」是两种东西，要不要一起改见本轮交付里的问题。
- 版本未改（按版本号纪律，开发中不碰 `manifest.version`），未提交、未发布。

**回退**：`lib/model.js` 的工具回合、`lib/search-tool.js`、`index.js` 的接线与提示词块各自独立，回退即去掉 `tools/executeTool` 两个入参；聊天回复行为回到今天的「应用代搜」。


## 等回复的茶杯搬出消息流（2026-10-21）

- 她的反馈：等待时左边头像、右边茶杯，看着像「伙伴发来一条茶杯消息」。
- 诊断：茶杯原来还是 `div.row.ta`，跟消息共用「头像 + 内容」的行骨架；去气泡壳救不回来，读成消息的是行结构，不是壳。
- 改动：`cup` 形态不再进 stream，改住 stream 与 composer 之间的 `.wait-cup-layer`（高 0→30 过渡），无头像无气泡；杯口三个小点承担「正在输入」，蒸汽拿掉（和点讲同一件事）；`typingIndicator()` 两种形态统一返回 raise/remove 手柄，`playLiveTurn` 里 `el.stream.appendChild(dots)` 改成 `dots?.raise?.()`；重画、清空、换人三处补 `resetWaitCup()`——桌子在 stream 外，清空流不会顺手带走它。
- 命令：`node --test tests/ui.test.js tests/ui-loading.test.js tests/load.test.js`。
- 结果：`ui.test.js` 与 `ui-loading.test.js` 全通过（同步改了两处：raise 契约断言、测试桩补 `resetWaitCup`）。`load.test.js` 里「内测入口必须包在 DEV_TOOLS 开关里」失败：实际 4 个工具、期望 3 个（多出 `chahuahui_tool_probe`），属工作树既有状态，本次未碰 `index.js` 的工具注册。
- 未全量、未调真实模型、未投递测试消息；动画实际手感待实机看一眼。

## 视频双路取材：兴趣近期热度 + 兴趣外热门（2026-10-21）

- 基线：0.10.2，HEAD 8e870c7，保留既有工作树；主链与数据层分别专项备份并核SHA-256，未复制生产聊天/凭据。
- 最终命令：`node --test --test-concurrency=1 tests/video-source.test.js tests/video-selection.test.js tests/video-share-routes.test.js tests/video-sharing.test.js tests/proactive-context-history.test.js tests/proactive-reasons.test.js tests/video-share-voice.test.js tests/video-materials.test.js tests/interest-exploration.test.js`。
- 最终结果：9文件196/196通过，0失败/取消/跳过；6份相关JS语法与定向diff空白检查通过。未全量、未调真实模型、未向生产聊天投递测试消息。
- 覆盖：公开热门读取不带cookie、只读/坏回包/空结果、搜索日期参数、新旧来源兼容、近30天与热度排序、拒绝未知/无效/未来日期、重复与时长预筛、两路互相回退、无兴趣可取热门、陈年搜索结果补最新页、线程变化不存旧候选、总材料尝试<=10以及取材不扣发送额度。复核发现未知日期能混作近期，已收紧并补用例；旧搜索桩补真实pubdate以符合近期契约。
- 真实匿名网络：热门接口code0，20条中13条<=15分钟；生产数据层适配器也返回20条。最初错误参数pubtime_begin/end被忽略（20条全旧），查SearXNG实现改用pubtime_begin_s/pubtime_end_s，最终经同一searchVideos WBI签名请求“游戏更新”返回20/20均近30天，本地选5条，样本播放约243万/146万/105万；只证明该词该次取列表与排序，不证明所有领域质量。
- 普通未签名搜索尝试被HTTP412拒绝，未绕过风控；最终沿原签名搜索路线成功。无账号凭据外传，热门请求不带cookie。自动浏览保留原登录门禁与设置授权，公开列表可匿名不等于本次要开放未登录自动分享。
- 独立只读复核：主链未知日期问题已修；数据层复核指出的无_s测试是较早快照，最终断言与调用均使用_s。未采纳解除自动登录门禁建议，因本次没有更改既有登录/分享边界。实际素材可读率、伙伴选择/口吻与最终发送来源比例仍待自然触发观察。
- 版本/简介/README不改；未提交、上传或发布。

## 视频分享：直接拿来聊，撤掉摘句点评提纲（2026-10-21）

- 同问题账本：CHF-20261017-01；最新实机基线和原文只留本机证据，不入项目。
- 新增 `tests/video-share-voice.test.js` 3项：视频拼装不再包含摘点再点评、首次介绍及兴趣system提纲；普通兴趣/关系由头隔离；人格、近期聊天、安静出口、系统附链接及字幕/弹幕边界仍在。旧码1通过/2失败，仅证明提示契约差异。
- 命令：`node --test --test-concurrency=1 tests/video-share-voice.test.js tests/compose.test.js tests/video-materials.test.js tests/video-share-routes.test.js tests/proactive-context-history.test.js tests/proactive-clarity.test.js`。
- 结果：123/123通过，0失败/取消/跳过；`node --check lib/compose.js`、`node --check lib/video-materials.js`及定向diff空白检查通过。未全量、未调真实模型、未投递测试消息；自然口吻和原素材的新输出待实机观察。

## 主动消息配比调优：让新闻与视频真正占到位置（2026-10-21）

**她的要求**：频率已经开到最大（小花 clingy，全局 30 条/天、相邻 30 分钟），但收到的主动消息里新闻和 B 站分享太少，希望多利用搜索。

**查实时账本找到的四个阻塞点**：

1. **素材被关系式由头吞掉**。每轮只要过了门，先抽“兴趣/共同经历/吐槽/搭话/想念”，抽中非兴趣的那几个时，后面的“非兴趣不带兴趣素材”会把新闻、视频整条丢掉。历史上最近 25 条主动消息里，contact/affection/shared 占了绝大多数，新闻 0 条。
2. **新闻要过锚点门**。锚点门本来拦的是“ta 自己的观察写成小作文”（需要她那边有动静才算有资格开口），新闻和视频是外面真实存在的东西，被同一道门卡着，结果是一天不聊天就一条都收不到。
3. **补给量不够**。新闻每 6~14 小时才取一趟、一次最多 3 条、池子封顶 6 条、每天封顶 2 条；视频补货间隔 6 小时，且要等 B 站字幕校验过。看完账本：视频候选池当时是 0 条（最新一次取料有 5 个候选被字幕校验筛掉，只成 1 条）。
4. 上述三条叠在一起，即使有货也排不上。

**改了什么**：

- `index.js` 的 `reasonEligible` 加上 `!video && !news`：有新闻或视频时先把它们发出去，不再抽关系式由头（抽中会把素材吞掉）。素材发完、配额用完后，想念、搭话、共同经历、吐槽照旧。
- 新闻与视频不再受锚点门限制（种子与探索发现仍受）。
- `lib/news-feed.js`：每天封顶 2 → **4**，取料间隔 6/14 小时 → **3/8 小时**，一次收 3 → **4** 条，池子 6 → **10** 条。
- `lib/interest-exploration.js`：视频补货间隔 6 → **3** 小时。

**测试**：定向（新闻/由头/界面/探索/视频素材）**212/212**；**全量 2041/2041 通过，0 失败**。两条旧契约随新数值更新（取料节奏、配额封顶），意图不变。

**未验证**：这些只改了配比与补给节拍，真实效果要等一天看账本（新闻发了几条、视频发了几条、她接不接）；另外视频能不能供得上仍取决于 B 站字幕校验的通过率，那是另一层的瓶颈。

## 主动消息改造：世界领域 + 新闻那条路 + 小作文刹车（2026-10-20）


**出发点（她的原话）**：最近的主动消息又是“小作文”——观察点太细，她完全不知道要回什么；想更多用上刚做的搜索，让伙伴分享自己感兴趣的新闻。

**查下来的五处病根**（不是提示词一处）：

1. 最近几条主动消息只有“我看见了什么 + 我的联想”，落点全在伙伴自己身上，对面没有可接的东西。
2. 11 条兴趣点清一色是“我怎么注意世界”（attention style），一条“我爱聊哪片世界”都没有，从这种兴趣长出来的必然是“我注意到 XX”。
3. 60 条种子里 19 条 stand、10 条 ask、10 条 exchange，题面是“A 还是 B”“先保动作还是先保构图”，模型拿到问句钩子只能写成“我选 A，因为 B”。
4. 搜索在主动消息里一次都没用上：只挂在兴趣探索上，18~36 小时跑一次，产出的是冷门考据；当天 discoveries 已发、已拒或过期，为 0 条。
5. 清晰度核查只判“说不说得清”，自洽但没人接得住的观察照样放行。

**改了什么**：

- 新增 `lib/world-interests.js`：每伙伴 2~4 片世界领域（追什么 + 从哪儿看），id 由名字派生，重复养护不会长出两条；同批伙伴已占的领域会避开（不全员八卦号）；太泛的领域名（“科技”“娱乐”这种）直接拦掉。
- 新增 `lib/news-feed.js`：短期新闻池（最多 6 条、5 天过期）、取料间隔（空池 6 小时／有货 14 小时）、讲过冷却（6 小时）、每日上限 2 条与视频分开计、标题去重、被拒理由入账、领域轮换与降权。`newsText()` 给伙伴的材料块里写明“这是外面真在发生的事”、外部内容边界、以及“不要写成新闻播报或摘要”。
- `index.js`：`maybeTendWorldInterests()`（领域不够才长，失败 24 小时后再试，绝不写空）、`maybeFetchNews()`（查询词由领域确定性拼，不让模型现编）、主动那轮把 news 当成与 seed／discovery／video 并列的一路素材，三选一；发出去才记 `markNewsShared`，配额走 GlobalRuntime。新增的诊断事件：`knowing.world.ready`、`news.fetch.ready`、`news.fetch.failed`、`news.share.ok`、`news.share.stale`、`proactive.observation-capped`。
- 三道刹车：`OBSERVATION_MAX_PER_DAY = 1`（种子／发现这类观察式一天最多一条，关系式由头、想念、搭话、共同经历不受限）；`SEED_ASK_CAP`／`SEED_EXCHANGE_CAP` 各 1（提示词说配额，解析层再硬卡一道，超了就丢）；`CLARITY_SYSTEM` 新增一条“接不接得住也是判据”，并给 scope 加了 `news`。
- `lib/store.js`：knowing 新增 `worldInterests`（与母题／癖好分开存放，互不顶替）；`normalizeWorldInterests` 处理旧数据为空。**不动任何旧字段、不迁移旧数据、不碰人格。**

**改前基线**：本轮开工前只跑过定向（373/373、142/142、108/108 那一批），没有留全量基线数字；就不事后凑一个。

**改后全量**：`node --test --test-concurrency=1 --test-reporter=tap`（tests/ 下全部文件）**2041/2041 通过，0 失败／0 取消／0 跳过**（实机修复与语言筛之后又跑了一遍）。新增 `tests/proactive-news.test.js` 28 项（取料节奏、去重、过期、领域轮换与被拒降权、写材料块的口径、配额与按天重置、语言筛、摘要截短、`searchWeb` 必须被 import 的静态契约），`tests/proactive-reasons.test.js` 新增一条真装载跑巡检的用例（观察式用满后新闻照样能发），并在 `tests/proactive-clarity.test.js`、`tests/ui.test.js`、`tests/model.test.js` 里跟着实现改了契约断言。未改动模型调用、宿主 RPC、路由这类需要真实宿主的边界。

**验收前自查又抓出两个接线漏洞（已修，各补了用例）**：

1. `candidateNews` 多挂了一个 `observationLeft === 0`：当天发过一条观察式之后，新闻整天都死了，跟“一天两条”直接打架。改为只受新闻自己的配额和“未回跟进/视频”的互斥约束。端到端用例「观察式今天已经用满，新闻照样轮得到」钉住。
2. `form` 和关系式那边的 `interestAvailable` 只认 seed／discovery／video：新闻单独在场时会被当成“没料”，要么落到戳一下，要么按“非兴趣不带兴趣素材”整条丢掉。两处补上 news，`greetingOnly` 的排除表也补上。

这两个都是“模块单测全绿、接线处才露”的问题——光看函数层过不了，所以新加的用例走的是真装载跑一轮巡检。

**顺手查出来的三处测试账目问题（不是实现 bug）**：
- `tests/video-share-routes.test.js` 与 `tests/reply-supersede-routes.test.js` 数的是“总共发了几次模型请求”，但第一轮对话后后台会顺手跑一次关系档案，把 1 数成 2、2 数成 3。这是之前误判成“多话／旧稿没丢”的那条长期红灯，真因是计数口径。测试桩新增 `models.replyCalls()`（按 `PROFILE_SYSTEM`／`DAILY_SYSTEM`／`SEGMENT_SYSTEM` 排除记忆维护），两条用例改用它；`tests/proactive-reasons.test.js` 里“第一条非核查调用就是生成”的取法同样改成按凭据原文认领。
- `tests/model.test.js` 一条静态契约仍钉着探索问句预算 `videoEnabled ? 1000 : 180`，而实现已在今天早些时候改成 `800`（180 被思考吃干净、整趟取不到料）。按现实现更新契约。
- 两处代码被挤在同一行（`lib/topic-seeds.js` 的空回复判断、`lib/store.js` 的 `messageRefine` 注释），只是格式，已分开。

**实机第一跑（2026-10-21 早上，重载后）**：

- 不需要新的权限弹窗，重载就直接生效了。后台账本里能看到 `knowing.world.ready`：小花长出 4 片领域（数码新工具、热梗与社区吵什么、书影剧讨论、游戏改动与考据）。
- **第一轮取料全挂**：`news.fetch.failed（ReferenceError: searchWeb is not defined）`。`index.js` 用了 `searchWeb`，但没写进那份 import。语法检查、全量单测都拦不住，因为没有任何用例真的走到取料那一步。补上 import，并加了一条静态契约（`searchWeb` 必须在那份 import 块里、两处调用都在），此种“用了没 import”的错下次会被测试拦住。
- **第一次搜回来什么**：“数码新工具”那一片 3 条里两条是日语和意大利语，“Perplexity”这种只有一个词的标题也混进来了；“热梗与社区吵什么”那一片 3 条全是中文（山姆风波、热搜争议、Token 算力之争），明显能用。同一个搜索层，不同领域词的命中质量差很远。
- 因此补了两条硬筛（不只靠提示词劝）：标题必须有中文、不能带假名，否则不进池；摘要从 600 字收到 300 字，别把搜回来的全文往提示词里塞。库里已有的旧条目在读取时也走同一道筛，之前那两条外语不会被端出去。
- 当前状态：池子里 3 条都是中文，新闻那条路已经走到“有货待讲”，**但还没真的发出去过一条**。到点开口时的语气与结构依然未验收。
- 本轮为了看到真实取料，手动把 `state.json` 里这位伙伴的 `newsBook.lastFetchAt` 往前推了 8 小时（只改了这一个时间戳，没改别的账）；验证完已停手。下次真取料仍按 6~14 小时的节拍自然发生。

**未验证 / 风险**：

- **真实搜索质量只看到一小面**：默认搜索链真的能返回东西（上面那次成功取料 10 条、入池 3 条），但同一个引擎对“数码新工具”搜回外语、“微博热搜里的争议话题”搜回中文，说明命中不稳定；现在靠语言筛兜底，不是靠查询词变好。换成别的引擎或填了 Key 之后的质量仍然未知。
- **真实模型成文没验过**：提示词在场不等于模型会照做；新闻那条路能不能真写成“一句事实 + 自己那一下”，要等实机第一条。
- **节奏没验过**：一天两条新闻 + 一条观察 + 视频，总量会不会反而变多、会不会变成刷屏，只能实机看。
- **没有界面（这是有意的）**：领域怎么长出来的、长了哪几片，界面上不展示也不给改。她 2026-10-21 把它定成茶话会的设计理念：能随手改的偏好不叫偏好，叫参数。已写进 `DESIGN-精神内核.md` 第 6 条与 `DESIGN-product-definition.md` 第九节，以后新功能先过这一条。
- App 正式 reload 仍停在上游那轮的域名权限确认上（新增 `api.tavily.com`），本轮没碰权限。

## 搜索增强：可自选的搜索服务（2026-10-20，三轮：Tavily → 多引擎）

- 目标：把宿主 web_search 里的 t 开头那家（Tavily，专为 AI 准备的搜索）接进茶话会，让伙伴找内容时能走更准的那条路。默认不变：用户不填 Key 就仍然是原来的必应 + 热榜，行为一模一样。
- 新增 `lib/search-engine.js`：Tavily 适配（POST api.tavily.com/search，Bearer Key，body 带 include_published_date）、字段归一（title/snippet/url/publishedAt）、`searchWeb` 统一出口（先 Tavily，401/超时/空结果一律静默退回必应）、按自然月记用量。隐私门复用 `topic-search.js` 的 `isSafeSearchQuery`，在换引擎之前先过，不让私聊线索跟着新引擎出门。
- 改动落点：`lib/chat-search.js`（searchForChat 接受 enhancement、改走 searchWeb；新增 isFreshEnough，必应老规矩“日期解析不出就丢”保持，Tavily 允许无日期；上下文不再写死“必应”）、`lib/store.js`（全局设置新增 searchEnhancement）、`index.js`（POST /settings/search-engine 保存、POST /settings/search-engine/test 真发一次查询、globalSettingsView 只回 hasKey/status/usageThisMonth、聊天搜索与兴趣探索两处接入并记账）、`ui/settings.html`（新增「搜索」栏：引擎下拉、Key 输入、保存、测试一下、状态与本月用量）、`manifest.json`（allowedHosts 加 api.tavily.com）。
- Key 生命周期：存盘前 `protectKey` 加密（DPAPI 优先、退回本机锁），页面与回包只给 hasKey 状态；使用时 `unprotectKey` 解开。诊断日志不记 Key。
- 契约变动一条：`tests/ui.test.js` 里“探索由稳定兴趣生成新角度；已知称呼外发前过滤”的静态断言，原先钉的是 `searchTimelyTopic(...)`，改为钉 `searchWeb(... privateTerms: [USER_NAME, partnerName] )`——意图（外发前过滤称呼）不变，只是搜索改走统一层。
- 改前基线：`node --test --test-concurrency=1 --test-reporter=tap tests/chat-search.test.js tests/topic-search.test.js tests/interest-exploration.test.js tests/store.test.js` **108/108 通过**。改后新增用例 16 + 路由用例 6，合计 22 项均通过。
- 最终定向命令：`node --test --test-concurrency=1 --test-reporter=tap tests/search-engine.test.js tests/search-engine-routes.test.js tests/chat-search.test.js tests/topic-search.test.js tests/interest-exploration.test.js tests/store.test.js tests/ui.test.js tests/ui-loading.test.js tests/load.test.js tests/proactive.test.js tests/proactive-reasons.test.js tests/reply.test.js`，**397/397 通过，0 失败/取消/跳过**。未跑全量。
- 覆盖到：引擎归一、坏用量不认、Tavily 请求真的打到了 api.tavily.com 且带 Key、没有 Key 不发请求、配了 Tavily 就不碰必应、Tavily 挂了静默回退必应、私聊线索不外发、无日期结果的两种规矩、聊天链路里拿到的是 Tavily 的料且上下文不写死引擎名、用量按月记；路由层：Key 落盘是密文、回包无明文、留空保持已保存的那把、换回默认搜索仍留着 Key、测试连通记已验证并计一次额度、Key 不通如实报失败、没填 Key 先拦住。
- 中途两次失败都是我自己写错，已改测试不是改实现：用例一“私聊线索”原本选的句子不在拦截名单里（改用带微信号的句子）；用例二误以为跨月会抹掉上月用量（跨月是另起一格，旧月份保留）。另有一条失败是既有的 `tests/ui.test.js` 静态契约随实现变更而更新，见上。
- 未做 / 待验证：**没有真实 Tavily Key，全程没发过一次真实 Tavily 请求**（用的是假 fetcher 与 harness 网络桩）；因此「Key 有效时返回结构与实际字段」「额度真实扣减」「中英文与时效内容的实际质量」均未实机验证。App 正式 reload 因新增 `api.tavily.com` 属新增对外域名，停在宿主权限确认，未加载。设置页新栏的实机外观待人工看一眼。版本仍 0.10.2，README 与简介未动，未提交未发布。

### 交叉审查与修补（同一轮，2026-10-20）

交叉审查（只读复核）提出 5 条必须修、6 条建议，均已处理：

- **必须修 1（真 bug，最严重）**：`PUT /settings/global` 这条路会把 Tavily Key **明文写进数据文件**。`normalizeGlobalSettingsPatch` 里直接用了明文 `nextKey`，而 `unprotectKey` 对没前缀的字符串原样返回——明文落盘后一切照常工作、测试全绿，问题彻底静默。修法：在该路由的 handler 里照 voiceProfiles 的做法 `await protectKey`，加密失败拒绝落盘。
- **必须修 2**：`GET /proactive` 把整个 global 包原样回给页面，绕过了 `globalSettingsView()` 的投影（里面有凭据）。改为只把 `searchEnhancement` 换成状态投影，其余字段不动。
- **必须修 3（漏记）**：一次聊天最多 3 个候选，每个候选各发一次 Tavily，原来只记 1 次，账面会比 Tavily 后台少记。改为 `searchWeb` 返回 `enhancedCalls`（真发出去才计 1）、`searchForChat` 累加、调用方按次数记账。
- **必须修 4（状态不同步）**：用输入框里那把**没保存**的新 Key 测试，却把 `status=verified` 写进已保存的配置——页面显示「测试通过」，聊天其实还在用那把旧的、可能已失效的 Key。改为：测已保存的 Key 才更新它的状态；测新 Key 只回包提示，不改已保存配置。
- **必须修 5（体感坏）**：Key 被吊销/过期后，每条要搜的消息都先白吃一次 Tavily 超时（8s），候选循环最坏 24s 挂在回复前面。改为：上次的失败原因属鉴权/额度类（401/403/429/quota）时直接跳过 Tavily 走必应；单次搜索内 Tavily 试过一次不顺，后面的候选不再重复付这次超时。
- **建议项**：跨 await 的读-改-写会覆盖别人刚记的计数（保存与测试两处都在写回前重读一次）；没真发出包的请求也记账（`searchTavily` 早退分支带 `sent:false`，只有真调了 fetcher 才算）；必应也失败时报的是 Tavily 的原因（主 reason 改用必应的，Tavily 的留在 `fallbackReason`）；页面测试失败时不刷新状态与用量（`apiWith` 把回包挂到 error 上，catch 里接住 `error.data.global`）；页面没告诉她 Key 到底加密了没有（投影加 `keyEncrypted`，如实区分系统锁与本机锁）；文案补一句「换过去之后搜的词会发给 Tavily 这家第三方」。
- 修补后新增用例 18 条（`tests/search-engine.test.js` 16 → 24，`tests/search-engine-routes.test.js` 6 → 10），覆盖：全局设置那条路不落明文、主动那页响应不带出 Key、传「********」保持已保存的那把、用未保存的 Key 测不改已保存状态、三个候选各发一次记三笔、没发出去的请求不记额度、Key 失效直接走必应、必应也失败时报必应的原因、配了 Tavily 但没填 Key 时两条路逐字段相同。
- 修补后最终定向命令（同上 13 个文件）：**434/435 通过**。唯一失败项 `tests/video-share-routes.test.js` 「实际普通回复召回视频…删反馈来源失效」断言模型调用次数 2!==1：**不是本轮引入**——把本轮接线（`enhancement: await searchEnhancementConfig()`）摘掉后同样失败。诊断显示第 2 次调用是「我认识的她」画像重建，属 2026-10-20 上午那轮记忆跟模型改动的遗留（那轮本身还在模型通道排查中），本轮未触碰、未修复，如实留待那一轮收尾。
- 本轮仍**没有真实 Tavily Key**，未发过一次真实请求；App 正式 reload 仍停在宿主的域名权限确认上。


### 第二轮复核与再修补（2026-10-20）

交叉审查复核确认：明文落盘、`/proactive` 绕过投影、记账次数、测试状态不同步四条**已修到位**；**熔断只修了一半**——同轮内的重复超时解决了，跨轮熔断没上膛：全仓唯一写 `status=failed` 的地方是「测试一下」路由，运行中撞上 401 照样每轮先白吃一次 8 秒超时（候选循环最坏 24s）。根因是 `fallbackReason` 断在半路：搜索层生成了它，但 `searchForChat` 的三个 return 没往上带，调用方既看不见原因、也没东西据此写状态。

- 修：① `lib/chat-search.js` 把 `fallbackReason` 从循环带到三个 return；② `index.js` 新增 `markSearchEngineFailed(reason)`，聊天与兴趣探索两处遇到鉴权/额度类失败就写一次 `status=failed`（只改状态、不碰 Key），诊断里也带上 `fallbackReason`；③ 熔断分长期与瞬时——401/402/433（额度用尽 Tavily 实际常回这两个码）与缺 Key 长期拦，429（限流）拦十分钟放行重试；④ 降级判断从「结果来自哪」改成「失败原因命中故障类」，`no-results` 不再被误当成 Tavily 挂了；⑤ `PUT /settings/global` 的跨 await 覆盖补上（protectKey 后重读 usage）；⑥ 页面失败路径也提示「已保存的配置没动」；⑦ `/proactive` 那句注释改准（搜索 Key 走投影，语音 Key 仍是密文原样带着，属既有行为）。
- 补测试：`tavilyBlocked` 直接单测（verified/untested 不拦、401 长期拦、429 冷却后放行）；**降级分支**新增一条锁「Tavily 恒不通时三个候选只试它一次，bing 走三次，enhancedCalls=1」——这是「不会三个候选各等 8 秒」的唯一保障；删掉一条名不副实的重复用例；「回包里给的 Key 是掩码」改名为「投影里没有 apiKey 字段」（搜索这条没有 `********` 掩码，断言与名字要对得上）；新增静态契约钉住「运行中 401 要写状态」。
- 最终定向命令（12 个文件）：**411/411 通过，0 失败/取消/跳过**。`tests/video-share-routes.test.js` 那条历史失败按前一轮的结论排除在本轮范围外（摘掉本轮接线仍红，属上一轮记忆画像改动的遗留）。未跑全量。
- 仍未验证：没有真实 Tavily Key，未发过一次真实请求；设置页新栏的实机外观待人工看；新增对外域名的权限确认仍需用户点。

### 第三轮：多引擎（2026-10-20，要求「对标 Hana」并试试 DeepSeek 的搜索）

- 反馈三条：① 选了 Tavily 但**没出现填 Key 的地方**（实为我的疏忽：Key 框的显隐只绑在初始化那次渲染上，下拉换了值没触发重绘）——已绑 `change` 事件，切换即显隐并改提示文案；② 多加几个搜索商，对标 Hana；③ 「听说 DS 也推出搜索了」，想试试。
- 引擎清单：`bing`（默认，必应 RSS 那条老路）/ `anysearch`（免 Key 匿名层，填了走付费层）/ `tavily` / `serper`（Google）/ `brave` / `deepseek`。对标 Hana 内置 web_search 的 provider（anysearch / tavily / brave / serper），再加 DeepSeek 新开的 Search API。
- DeepSeek 官方文档核实（2026-10-19 开放）：`POST https://api.deepseek.com/v1/tools/search`，`Authorization: Bearer`，body `{query, count(1-50), need_content}`，返回 `results[].title/url/snippet/summary/content/site_name/date(RFC3339)/authority/rerank_score`；Search 5 元/千次成功请求，**只有 200 且 results 非空才计费**，Search QPS 100，错误码含 401/402（余额不足）/429/433。取 `summary`（给模型读的长摘要）优先、`date` 当发布日期。`ori_question` 字段故意不传——那是用户原话，传出去等于外发聊天内容。
- 架构变化：配置从「一把 Key」改成「**每家一把**」——`searchEnhancement = { engine, keys:{引擎:密文}, states:{引擎:{status,testedAt,error}}, usage, usageByEngine }`。换引擎不清别家的 Key；熔断状态按引擎隔离（不会因 Tavily 401 把 DeepSeek 也拦掉）；用量总数与按引擎分开记。旧数据（单数 `apiKey`）自动搬进 `keys.tavily`。
- 另外把「通用设置那条路能改搜索 Key」的口子直接堵上：`PUT /settings/global` 现在遇到 `searchEnhancement` 字段就 400 拒绝，搜索设置只走自己那两条路由。（上一轮靠给通用路补加密，这次改成**不给第二条路**。）
- 测试重写为 39 项（`tests/search-engine.test.js` 24 + `tests/search-engine-routes.test.js` 15），新增覆盖：五家适配器的请求形状（URL/方法/认证头/body/返回字段映射）、免 Key 的 AnySearch、每家一把 Key 的隔离、旧数据迁移、按引擎的熔断与冷却、通用路拒绝改搜索设置。
- 修 UI 反馈：下拉换了引擎不弹 Key 框（已修，见上）。
- 最终定向命令（12 个文件）：**414/414 通过，0 失败/取消/跳过**。未跑全量。
- 仍待：宿主对新增 4 个域名（api.deepseek.com / google.serper.dev / api.search.brave.com / api.anysearch.com）的权限确认未点，App 正式 reload 停在确认上；仍**没有真 Key**，未发过一次真实请求；设置页新栏的实机外观仍待人工看。

### 第四轮：交叉审查后的修补（2026-10-20）

交叉审查复核确认：五家适配器的请求形状逐字段对得上（DeepSeek 与 AnySearch 拉了官方文档核）、Key 隔离没串、通用路由封口无副作用、隐私面没扩大。指出四条必须修，均已处理：

- **必须修 1（明文搬家）**：旧数据迁移那行「把单数 `apiKey` 搬进 `keys.tavily`」是纯同步函数里做的，而 `protectKey` 是 async——**等于把可能还是明文的旧 Key 复制到新字段，然后再也不加密**。改为：归一只把旧值原样带出（`legacyApiKey`），加密与搬迁交给 `index.js` 的 `migrateLegacySearchKey()`（async，聊天/保存/测试三条路都会经过它），搬完丢掉旧字段。新增路由层回归锁：seed 阶段写旧结构 → 保存一次 → 落盘必须是密文且 `legacyApiKey` 清空。
- **必须修 2（402 一刀切）**：AnySearch 匿名层的 402 是「今天的免费额度用完了」，第二天就回来；付费 Key 的 402 才是余额耗尽。原先一律当长期故障 → 匿名层用满后当天全被拦、第二天还拦。改为：付费 402 长期拦；匿名 402 当天拦（20 小时窗口）；429 限流拦十分钟放行。
- **必须修 3（文案骗人）**：页面写「这个月这家用了 N 次」，但 `usageByEngine` 是**按引擎的累计值**（`usage` 才是按自然月）。改为「这一家累计用了 N 次」，两个维度不再混说。
- **必须修 4（默认引擎下要你填 Key）**：默认那档不需要 Key，界面把 Key 框藏了，但「测试一下」按钮没跟着藏——什么都不动点一下就被要求填 Key。改为默认那档禁用测试按钮。
- 建议项一并处理：切下拉不刷新状态文案（现在连同 Key 框一起重刷）；`keyEncrypted` 字段这轮重写时丢了（补回，每家各自标）；DeepSeek 查询词按文档裁到 128 字、AnySearch 条数裁到 10（各有各的上限，超了 400）；Brave 的 `page_age` 没用上（现在用上，别把老文章当今天的）；429 在运行中不写状态导致冷却形同虚设（现在写状态、且只刷新冷却时钟不覆盖原因）。
- 测试补到 43 项：新增 402 两态、每家查询长度上限、旧数据迁移的落盘回归锁；顺手修掉一条「其实没测到」的用例（harness 的 seed 是对象属性，我一开始按位置参数传，那条迁移测试等于没跑——已纠正，现在真的在跑）。
- 最终定向命令（12 个文件）：**418/418 通过，0 失败/取消/跳过**。未跑全量。
- 仍待：权限确认未点、reload 未完成、仍无真 Key、设置页实机外观待人工看。

### 第五轮：实机反馈（保存无效）· 三个 UI bug（2026-10-20）

实机反馈：选了 Tavily、填了 Key，点「保存」后直接跳回默认搜索，Key 也没存上；先点「测试一下」能通（搜到 3 条）。

- 证据链（宿主诊断 `v2/diagnostics.jsonl`）：同一秒内 `search.engine.test` 收到 `engine:"tavily"` 且 `ok:true results:3`（body 完整），而紧跟着的 `search.engine.save` 收到 `engine:"bing" hadKey:false`（body 是空的）；账本 `state.json` 被写成 `{engine:"bing", keys:{}, usageByEngine:{tavily:1}}`。
- 根因（两个 UI bug 叠加，顺序刚好对上她的操作）：
  1. **测试成功后清空了输入框里的 Key**（`keyInput.value = ""`）——测试并不改变已保存的 Key，这一步多余。已删。
  2. **每次重绘都把引擎下拉整个重建**（`host.replaceChildren()` + 新建 select），用户刚选的那家被重置回「默认搜索」。已改为**只建一次、后续复用同一个 select**（beautify-select 的壳也不会重复套：它靠 `dataset.ddReady` 自我保护）。
- 顺带修：保存请求超时从 8 秒放宽到 30 秒（实测本机加密只要 0.5 秒，超时不是主因，但留余量）；保存前自检（没选引擎/该填 Key 却没填 → 当场提示，不发空请求）；后端保存诊断（记收到的字段名、引擎、有没有 Key、加密成没成、耗时）；设置页自报版本号（后端算 `settings.html` 的 sha1 前 8 位，页面显示在左上角，附「重新载入这一页」链接）——宿主给静态文件挂了长缓存，这一行能一眼看出页面是不是旧的。
- 注意：宿主给静态文件挂了长缓存（页面自己代码注释里就写了），但**设置页在聊天页里是 iframe 加载的，带 `?t=${Date.now()}`，所以不是缓存问题**——别再往那个方向猜。
- 测试：211/211 通过（search-engine 43 + ui 88 + ui-loading）。未跑全量。
- 仍待：这一版的实机复验（她再走一遍：选 Tavily → 填 Key → 可先测试 → 保存）；DeepSeek 的 Fetch 接口未接。

### 第六轮：存好的 Key 切回来显示成「没填」（2026-10-20 实机反馈）

反馈：保存了 Tavily 的 Key，切到别的引擎再切回来，看着跟没填一样；但直接点「测试一下」能通。

- 先核真实状态：`state.json` 里 `engine:"tavily"`、`keys.tavily` 有密文（`local1:` 本机锁），`states.tavily=verified`；诊断 `search.engine.test` 最后一次带 `usedSavedKey:true` 且 `ok:true`。**后端一直是对的，Key 早存好了。**
- 根因（真 bug）：下拉的 `change` 处理器只挂一次，而它是在 `paintSearchEngine` 内部声明的函数，**闭包攥住了「第一次绘制」那版 `engines`**——那时候她还没存 Key，`hasKey` 是 false。保存后重绘只换了外层数据，监听器还指着第一版：切走再切回来，Key 框的占位与状态行都按旧账说「还没填」，而状态行那句「现在其实还是走默认搜索」正是她看到的「跟没填一样」。
- 修法：把「这一家是谁 / Key 存没存 / 测得怎么样 / 用了多少次」收进模块级 `searchEngineSnapshot`，`searchEngineSpecOf`、`paintSearchNote`、`refreshSearchKeyField` 全部提到模块级、每次读最新快照；重绘只更新快照。`change` 处理器与输入框的 `input` 都指向这一个函数，闭包陷阱消失。
- 顺带：清单没变就不再重建 `<option>`（每画一次都重建会让自定义下拉的触发栏抖一下）；新增「上面选的这家还没保存」，选了没点保存时明说。
- 显示（她要的那句）：Key 标题右边加一枚常驻小胶囊，复用语音那套 `field-state` 样式——`已保存` / `已保存 · 未加密` / `还没填` / `待保存` / `会覆盖已保存的`；状态行补上「Key 已经存好，只存在这台电脑上、页面不回显」；已存的那家把输入框描边和占位文字染成薄荷色，空框也不再像没填。不再只靠两秒就散的 toast。
- 顺手修掉上一轮遗留：`tests/video-settings-ui.test.js` 里那条按切片跑的 apiWith 超时用例，被上一轮加的「重新载入这一页」顶层 `document` 接线撞红了（上一轮只跑了三份测试，没覆盖到）。给它补上空 `document`/`window` 桩，用例恢复。
- 已知残留（未处理，等她决定）：`keys.bing` 里躺着一把 11:40 那次 bug 误存的 Key（当时下拉已跳回默认搜索）。默认那档从不使用 Key，功能上无害。
- 验证：`node --test --test-concurrency=1 --test-reporter=tap tests/search-engine.test.js tests/search-engine-routes.test.js tests/ui.test.js tests/ui-loading.test.js tests/video-settings-ui.test.js tests/dev-thread-range.test.js tests/load.test.js` → **267/267 通过，0 失败/取消/跳过**。新增回归锁：`refreshSearchKeyField` 必须在 `paintSearchEngine` 之前声明（防止处理器再被钉在画那一刻的快照上）、重绘要推快照、状态行要有「Key 已经存好」、要有常驻胶囊。未跑全量。
- 待实机复验：她再走一遍「选 Tavily → 填 Key → 保存 → 切别家 → 切回来」，应看到胶囊一直是「已保存」、状态行写着 Key 已经存好；页面若还是旧的，点左上角「重新载入这一页」。

### 第七轮：按顺序降级（2026-10-20，拍板「只做降级那一层」）

她提的是「像 Hana 一样按顺序搜」，讨论后把两件事拆开：失败/额度/冷却时按她排的顺序往下试（纯收益，失败本来就不计费），与「结果不够优质就换别家再搜」（要花钱、要有人判“优质”）。**这一轮只做前者**，判定门槛是“真的不通”，不是“我觉得不够好”。

- 配置：`searchEnhancement` 新增 `backups: [id...]`（有序，最多四家）。默认搜索不占位——它永远由代码兜在最后；首选就是默认搜索时链为空，她没让排就不自作主张。旧数据无这一项 = 空链，行为跟以前一模一样。
- 执行：`searchWeb` 改走 `searchChain`（首选 → 备选）逐家试。只有在“真不通”（http-4xx/5xx、request-failed、bad-response、network-unavailable）时才往下走；**`no-results` 不算故障**，不拿别家付费重问一遍（那就是为了质量多掏钱，本轮不做）。冷却中或本轮已确定不通的直接跳级。没填 Key 的备选只跳过，不写入 failures（不会给人家记一笔冤枉账）。
- 预算与时长：新增 `createSearchSession`（总 16 秒 / 付费 3 次）。一条回复里三个候选共用同一份预，链再长也拖不死回复；到顶了剩下的候选直接走免费的。每次单家超时取 `min(8s, 剩余-300ms)`，不会再逐家各等 8 秒。
- 记账与熔断：`searchWeb` 返回 `calls`（真发出去的包，按引擎分）与 `failures`（按顺序每家的原因）。`index.js` 新增 `bookSearchOutcome(search)` 统一做两件事：按 call 逐引擎记用量、按 failure 逐引擎写熔断状态；探索与聊天两条路都走它，不再只能记一家。
- 降级记忆：从“改一份 enhancement.engine=bing”改成会话里的 `markDown`，聊天层不再自己拿正则判故障，两处口径合一（`isEngineFault`）。
- `chat-search` 的 `lastFallbackReason` 不再被 “engine-disabled” 覆盖：跳级不是新事实，第一次真原因（如 http-401）得留住，熔断才上得了膛。
- 设置页：搜索卡片新增“备选顺序”列表，参与的那几家排前面（带 ↑↓），没参与的排在后面（虚线行、点“加入”）；每行自带 Key 状态胶囊（已存 Key / 没 Key / 免 Key）；改了没保存会写一句“顺序改过了，点上面的保存才生效”；首选切回默认搜索时整块隐起来。
- 文案：卡片说明改成“排了备选的话，首选不通时也会发给备选那几家”，隐私上不能骗人。
- 新增用例 11 条：顺序回退到第二家、没 Key 的备选不发请求也不算故障、冷却中跳级、no-results 不换付费家、付费预算到顶、总时长用尽、首选为默认搜索时链为空、备选归一（去首选/去重/上限）、一条回复三个候选共用预算。路由层两条：备选能存能回且归一后落盘、换首选时它从备选退出但不弄丢其他家。UI 一条：设置页有这块且保存带 backups。
- 验证：`node --test --test-concurrency=1 --test-reporter=tap tests/search-engine.test.js tests/search-engine-routes.test.js tests/chat-search.test.js tests/topic-search.test.js tests/interest-exploration.test.js tests/store.test.js tests/ui.test.js tests/ui-loading.test.js tests/video-settings-ui.test.js tests/load.test.js tests/proactive.test.js` → **427/427 通过，0 失败/取消/跳过**。未跑全量。
- 未做（按她拍板）：结果“不够优质”就换家再搜的第二层；合并多家结果去重；Fetch 接口。
- 实机反馈修正（同一轮）：换首选时整个备选列表都跟着变。原因是 `others` 把“当前选中的那家”直接掉了，那一行消失后剩下的跟着上提，看着像顺序自己变了。改为：名单只排除默认搜索，选中的那家留在原位、胶囊改成「现在是首选」、不给箭头和开关；“参与 N 家”与“顺序改过了”都把它剔开再算（只换首选、没动顺序不喊改过了）；保存时也不把它发上去（后端本来就剔）。
- 新增回归锁：不再按 `sel.value` 筛名单、名单只排除默认搜索、选中的那家要标成「现在是首选」、算数时把首选剔开。
- 旧页面识别：实机反馈后才发现旧的“设置页版本”哈希戳是后端算的，页面旧了它照样显示新值，根本证明不了她眼前是哪一版（第二轮裁在此）。现改为页面里写死 `UI_BUILD`，后端从同一个 `settings.html` 里读同一个值，对不上就在版本那行直接写「这一页是旧版本，关掉设置页再进来一次」。自本版起才生效（旧页面里没这个检测代码）。
- 仍待：实机复验（先给 Tavily 排一家备选，把首选 Key 故意改坏看是否自动接到下一家）；没有真 Key，真实额度扣减未验。

### 第八轮：改成“一条顺序”（2026-10-20 拍板推翻上一版模型）

反馈：“不能是首选不能当备选，这样会很绕；统一改成使用搜索商的顺序，按用户选择的顺序依次尝试”。上一版用“首选下拉 + 备选名单”两个概念表达同一件事，还得额外解释“首选为什么不能当备选”——那是设计在让她学规则，不是她想表达的东西。

- 数据模型：只剩一份 `searchEnhancement.order`（含默认搜索）。`engine` 降为兼容字段，恒等于 `order[0]`，不再单独赋值（`normalizeSearchEnhancement` 里由 order 推出，所以永不漂）。旧数据 `engine + backups` 自动搬成一条顺序：engine 打头、backups 后缀、默认搜索兜尾；搬过之后只认 order。
- 执行：链子就是 order，逐格试。轮到“默认搜索”那一格就真走它——她可以把默认搜索排第一（那就只用它），也可以排中间（两家付费都不行才用）。仍然只在“真不通”时往下走，`no-results` 不拿别家付费重问（上一轮的范围不变）；名单里没排到默认搜索、或者轮到它时时间不够，最后还是会走它，聊天不能断。
- 接口：`order` 与 `keyEngine` 分开传。调顺序不碰任何 Key、也不重置别家的测试状态；老客户端（只传 engine）仍按“把它当顺序第一位”处理，行为跟以前一致。
- 设置页：下拉框退了（两处控制同一件事只会绕），改成一条列表：序号 + 名字（只摆名字，不挂长描述）+ Key 胶囊 + ↑↓ + 加入/移除；默认搜索那行移不掉（标“兜底”）。点某一行 = 切到那一家填 Key / 测它（不是改变顺序）；顺序摘要单独一行写清“现在依次尝试：A → B → C”；状态行只讲正在填的那一家。
- `UI_BUILD` 升到 `20261020.4`。规矩：以后每次动 settings.html 都升一位，不然旧页面会误判成新的。
- 测试改写：顺序归一（认不得的剔掉、去重、没排默认搜索就兜尾、她真把默认搜索排第一就听她的）、老数据搬迁、order 优先于旧 engine、默认搜索排第一时不去问下一家、存顺序不动 Key 也不重置别家状态。路由里原来那两条“备选”用例已随模型下线。
- 验证：`node --test --test-concurrency=1 --test-reporter=tap tests/search-engine.test.js tests/search-engine-routes.test.js tests/chat-search.test.js tests/topic-search.test.js tests/interest-exploration.test.js tests/store.test.js tests/ui.test.js tests/ui-loading.test.js tests/video-settings-ui.test.js tests/load.test.js tests/proactive.test.js` → **429/429 通过，0 失败/取消/跳过**。未跑全量。
- 实机反馈修正（同轮）：一打开搜索栏，“填 Key” 那块整块不见了。原因是 `searchEditId` 初值写死成 `bing`，而默认搜索本来就不需要 Key，于是 Key 栏一上来就是 `hidden`。改为初值为空、每次重画时指向顺序第一行（只有那家不在了才回退到 `bing`）。同时把行改成可换行 + 工具区 `flex: 0 0 auto`，窄面板下 `移除` 不会再被擅出卡片右边。`UI_BUILD` → `20261020.5`。
- 仍待：实机复验（把顺序排成 Tavily → DeepSeek → 默认搜索，把 Tavily 的 Key 改错，看是否自己接到第二家）；真实额度扣减仍无真 Key 可验。

## 记忆跟随伙伴模型与删除后重建（2026-10-20）

- 仅记忆路径新增窄入口，复用既有伙伴→应用默认→伙伴在宿主的默认→目录当前模型解析；固定本任务模型，`allowUtilityFallback:false`、单次无内部重试、`strictOutput:true`。整理包含日账、摘要/长期条目、关系档案和话题；其他utility用途及普通聊天默认行为不变。短正文仍留8192总输出预算，避免思考占完正文额度。
- 严格流需正常done(stop)，拒绝任何error、无done、length/toolUse/deferred；不提交半截画像、日账或摘要，不推进对应水位。画像、日账、话题等待期间若原文或来源状态改变，旧结果不落盘；滚动摘要继续使用逐条来源校验。
- 重建状态保存pending/running/failed/succeeded、日期、代际、尝试数与错误；默认延后45秒合并，失败最多追加60秒/300秒两次重试，重载不重置预算。业务队列吞异常时也必须返回明确失败，不能由undefined兼容逻辑误判成功。删除与重建分别报告；私有维护接线与测试继续Git忽略、双发布排除，不新增公开页面。
- 删除重建画像只取剩余有效聊天，不引用旧画像、宿主事实或无逐条来源的旧判断；空材料清空旧画像和刷新时间。未知日账范围先取消旧排程，再保留新代际failed与人工核对阻断；普通重建和后续正常删除都不能解除该阻断。无逐条来源的综合话题及累计关系仍不承诺精准回滚。
- 修前基线：严格流新增用例45项中43通过/2失败；原队列新增契约11项中4通过/7失败；修前入口暂存副本上的新记忆集成6项全失败，未回滚正式源码。队列二次复核新增3项在旧实现13通过/3失败后修正。交叉审查发现的两项P1补丁有新增回归，未单独实跑其旧码基线。中途191项中189通过/2失败为测试用旧store设置快照等待App内部落盘状态导致，改用磁盘新实例读取后恢复。
- 首轮相关9文件211/211通过。补正式自服务与取消后，最终定向命令：`node --test --test-concurrency=1 --test-reporter=tap tests/model.test.js tests/rebuild-queue.test.js tests/memory-pipeline.test.js tests/memory.test.js tests/topics.test.js tests/dev-thread-range.test.js tests/loading-store.test.js tests/compose.test.js tests/longterm-routes.test.js tests/load.test.js`，**222/222通过，0失败/取消/跳过**。相关8份JS语法与定向diff空白检查通过；私有测试含真实DEV_ONLY剥离装载检查。全树diff另有既有panel.css末尾空行，未动无关文件。未全量。
- 测试宿主的成功流补真实done(stop)事件，并提供可选entryUrl以测试备份入口；长期记忆路由用例改拦记忆stream，普通聊天/utility观测独立，原证据与水位断言保留。独立复核两项P1修补后无源码阻断，不替代实机验证。
- 首次实机选模正确，但延后任务继承失效工具调用凭证，立即遇`APP_CALL_TOKEN_INVALID`，日账与画像没有假报成功。当前1.1.35-beta官方APPS.md及实际源码确认无token的App自有推理、正式self RPC入口；stream不支持scope字段，未手拼令牌。只将记忆模型调用包进本App的memory-generate服务，业务队列不重复进入，RPC超时180秒，服务内传取消信号。模拟宿主用独立AsyncResource覆盖旧上下文隔离，另测外部调用身份拒绝。取消新用例在旧模型层4项失败；另有旧静态测试截取范围把服务注册带进VM的问题，收紧边界且保留原断言；最终模型文件50/50通过，包含在222项内。
- 第二次正式reload成功且inspect开启。真实self RPC已进入App作用域模型推理，usage ledger确认仍为既有伙伴选定模型；不再是调用凭证错误，但提供方返回`APP_MODEL_PROVIDER_ERROR`，usage为空，无有效正文。同时间宿主对chatgpt.com记录HTTP/2 Extended CONNECT不支持告警，未获逐请求底层原因，不能据此说模型本体损坏。画像仍0字、失效日账未补回；线程及性格关系文件与验证前SHA-256相同。**生产重建成功路径仍未验收，当前被模型通道错误阻塞**；最终读回generation2、failed、attempt3，已停止本轮自动重试；线程及性格关系文件最终hash仍与验证前相同。不换模型、不回退utility。
- 2026-10-20午后Luna单变量诊断：原生、App最小带0.4/省略温度、self RPC最小、工具返回后后台最小、中文输入以及正式日账提示词+虚构材料均有成功；真实剩余日账材料通过同探针/self RPC仍失败。只能定位材料或其请求表达相关触发，不能认定具体敏感词/审核/鉴权/网络为根因。宿主将原始errorMessage丢弃后统一APP_MODEL_PROVIDER_ERROR；HTTP2 Extended CONNECT存在HTTP1.1回退，时间邻近不足归因。
- 本轮仅改Git忽略且双发布排除的local-dev.js及私有测试；探针fixture改按真实顶层done.stopReason，生产解析原本正确。最终`node --test --test-reporter=tap tests/dev-thread-range.test.js`为19/19通过，0失败/取消/跳过，包含发布剥离；语法通过，未重跑上午222项或全量。真实重建generation3最终failed/attempt3，画像仍0字、目标日账缺失，线程/knowing哈希与复验前相同。真实最小成功不等于生产恢复。详见工作台《CHF-20261020-04-Luna调用链排查.md》及同目录runtime.json、probe-tests.tap。
- 未新增删除、未回灌备份画像；版本仍0.10.2、README/简介及Hana共享模型配置未动、未提交上传。成功生成后的自然度、真实取消与真实reload中断恢复尚未实机覆盖；模拟覆盖不能替代这些边界。

## 通用接话选择与本机探针（2026-10-19）

- 延续 CHF-20261019-02，仅联动替换 `replyChoiceBlock` 与 `buildStickerHint` 既有文字。先判断自然收尾和回应价值，再针对具体内容选择表达；泛笑/收到/附和不足的约束仅限话头仍需回应。保留单图独立接招、认真求助与不适边界、纯温柔性格，不强制文字、互怼、提问或续聊。未再改互损性格块。
- 先保留工作台专项备份并核 SHA-256；新增两条文字契约在旧实现0/2通过，仅证明旧文字契约不符。首轮定向173项172通过1失败：既有试点测试把含 import.meta/顶层 await 的本机钩子交给 Function；修改前备份同样复现该错误。测试缩到实际待验开关与赋值，ESM由装载测试覆盖；随后173项通过。审查补强后最终结果如下，不抹去中间失败。
- 最终命令：`node --test --test-reporter=spec --test-concurrency=1 tests/prompt.test.js tests/stickers.test.js tests/familiar-tease.test.js tests/reply-rules-compact.test.js tests/reply-rule-probe.test.js tests/taste-probe-context.test.js tests/compose.test.js tests/proactive-context-history.test.js tests/proactive-expression.test.js tests/load.test.js`，**174/174通过，0失败/取消/跳过**。相关三份源码语法、定向diff空白、DEV_ONLY剥离后的模块语法通过；全树diff空白另有既有panel.css末尾空行，未改无关文件。未跑全量。
- 为实测最小扩展现有私有taste探针：显式legacy/compact-v1、最多24条role/text历史，校验后投影；记录实际profile/history/stickerHintIncluded。模拟用例验证两规则实际进入请求、额外quote/visionNote等不透传、坏参数零调用、不写聊天关系。仍在既有DEV_ONLY段；新增私有测试Git忽略并双发布排除，未新增公开入口。独立只读复核修补后无阻断。
- 正式reload回执成功，inspect为host=on/agent=on。计划4个固定情境、每个单档一次；实际仅发起第1次即失败，未继续或换模型。usage-ledger原错误为当前opencode-go/deepseek-v4.1-flash通道缺少x-opencode-session，非空正文/思考预算问题；与今天早些时候原样本的openai-codex/gpt-6-luna不同，未强行沿用过时模型假设。失败结果没有profile和提示标志，不能确认成功请求中的这两项，不能称真实效果通过。
- 详细证据见本机工作台《CHF-20261019-02-通用接话实施验证.md》。当前仅完成实现、相关模拟验证与正式重载；固定情境真实回复、旧新配对、其他性格/模型自然度仍未验收。版本0.10.2、README/简介未动，未commit/push/release。

## 熟悉后的互损偏好（2026-10-19）

- 对应 CHF-20261019-02。只改普通回复两版现有互损纪律、关系档位与主动tease分支成文句，不改性格档案、关系计算或主动频率。陌生轻、熟悉后更偏爱互损；纯温柔保留，温柔又爱打趣不排除；认真纠错先核对、确错就改。
- 先留基线：相关原文件专项目录备份并核SHA-256；新增3条静态契约在旧码3/3失败，仅证明文字契约未满足。中途测试断言问题及过宽主动断言撤回见反馈账本，不冒充历史产品故障。
- 最终定向：`node --test --test-reporter=spec --test-concurrency=1 tests/familiar-tease.test.js tests/prompt.test.js tests/reply-rules-compact.test.js tests/reply-rule-probe.test.js tests/compose.test.js tests/proactive-context-history.test.js tests/proactive-expression.test.js tests/proactive-reasons.test.js`，**159/159通过，0失败/取消/跳过**，4.36秒。相关5份JS语法检查、3份源码diff空白检查通过；未跑全量。
- 新增4条规则/拼装用例：两版偏好及认真纠错、三档与完整性格、主动tease与其他由头隔离。affection/contact/shared为有效隔离对照；interest在现有分流中不成关系式reason，仅为常规非tease输入对照，不冒称独立兴趣分支已验。既有App harness同时验证普通回复两伙伴与主动utility/视频请求历史接线。配对探针字符差由写死780改成逐份实际构造长度核对，避免合法文案更新导致无关失败。
- 独立只读交叉复核无阻断，未替代真实模型自然度验收。未找到本会话可调用且能固定当前profile/原场景的正式模型测试入口；未绕过宿主直接请求Provider，未调真实/付费模型。原样本旧新配对、认真纠错不乱怼、纯温柔/陌生真实表现均待实机观察；不得凭静态规则推断模型行为已解决。
- 正式reload成功，随后inspect为host=on/agent=on。源码已加载，不等于真实聊天效果已验收。版本仍0.10.2，README/简介未改，未提交或发布；既有杯中动效等工作树改动保留。

## 等回复的动效可选「杯中有话」（2026-10-19）

- 来处：她想要把等待回复时那三个点换成一盏茶的动效（参考 Hana 新版 thinking-bloom 的“永远有东西在动”那套）。明确要求：原版三个点不能丢，不喜欢要能退回。
- 实现：新全局设置 `typingIndicator`，`"dots"`（默认，原样）/ `"cup"`。三
  个点那段代码一字未动，只在 `typingIndicator()` 里加一条分支；关掉开关就是完全原来的行为。设置页「聊天显示」加一个开关，按轮询生效，不用重开窗。
- 杯子几何来自一个独立的 120×120 候选图（她认为好看的版本），一个形状没重画。颜色全部改成 `color-mix(--cup-ink, --cup-paper)` 插值，浅色主题重现原版的绿阶，深色主题自动翻成暗杯身亮描边。
- 动效按「永不空白」重新排相位：杯身 7.3s、茶面 6.1s、涟漪 2.9/3.1/3.35s 三圈错开、叶子 5.6s、蒸汽 3.3/3.7s、金光 4.3s。公共周期几十秒，任取一帧都有东西在动。原版那条 9.6s 单时间线后半段完全静止，不能直接用。
- 踩到的坑（已修）：`getGlobalSettings` 里值归一写在了 `...state.settings` 展开**之前**，展开把它原样盖回去，导致不认识的值得能穿到前端。已把 `typingIndicator` 的归一移到展开之后，并把原因写进注释。
- 测试：新增 2 条（默认是三个点、改成 cup 后重启记得住且能改回 dots；不认识的值得退回 dots，不能让聊天窗空着）。全量 `node --test --test-concurrency=1 <tests/*.test.js>` **1873/1873 通过**（109 个文件，111 秒）。两个页面的内联 module 用 `vm.SourceTextModule` 语法检查通过。
- 未做：真实聊天里挂一整个回复回合的实际观感（蒸汽快慢、杯子在真实气泡里是否过大）没亲眼验过，只验了静态渲染和参数。未跑真实/付费模型。未改 manifest 版本/简介/README，未提交或发布。

## 专注联动用例改按场景认领模型调用（2026-10-19）

- 来处：v0.10.2 定版后 CI（run 39196529662，提交 `dc620f0`）在 windows-latest 上挂 1 项：`tests/focus-routes.test.js` 的「真apply联动」。全量 1859 项，1858 过 1 失败，同一提交的云构建成功。
- 现象：失败断言是「走神提醒不能带私聊正文」，可它拿到的请求明显是「另一个伙伴」自己的某次对话生成（系统提示里写着「你就是「另一个伙伴」本人」，私聊原文也在 messages 里）。
- 根因：这条用例靠「第几次模型调用」定位每一步。而陪读有个 1.5 秒的发言防抖，慢响应或 CPU 抢占下走神提醒会先派出去，之后每次 `waitForCall(n)` 都整体错位一格。本地连跑 6 次不复现，说明不是稳定失败，是顺序竞态。
- 复现方法（可重复）：把「另一个伙伴」的首条请求人为拖慢 2 秒，让 1.5 秒防抖先触发。旧写法当场以与 CI 完全相同的断言失败（`doesNotMatch /私聊机密关键词测试|另一个伙伴/`）。
- 修法三层，都在测试侧，产品代码未动：① harness 新增 `waitForCallWhere(match, what)`，按请求内容认领，谁先谁后都不影响；② harness 新增 `answer(match, text)`，同类请求一到就自动回同一段话——慢响应下同一轮会被重来一次，靠一次性 release 会让重来的那条永远挂着，同伙伴的下一轮生成就排不进来；③ 用例里「不多发」的断言从「总调用数」改成「专注侧场景话本数」（开场/走神/收尾/陪读回应四种 system 标记），这样「另一个伙伴」那边因慢响应重来一轮，不会把专注协作的断言一起拖下水。
- 对照结果：同样 2 秒延迟下，旧定位失败、新写法 2/2 通过；无延迟时新旧都通过。
- 全量 **1871/1871 通过**（101 个测试文件，38.6 秒）。`node --check` 通过 tests/focus-routes.test.js 与 tests/helpers/app-harness.js。
- 未做：真实/付费模型调用；未验证 CI 上那条竞态的发源地到底是哪段同步代码变慢，只确认了「调用顺序会错位」这一层和修复后的稳定性。

## 独立审包后的加固（2026-10-19）

- 来处：v0.10.2 候选包独立只读审查（无阻断项）指出 JPEG 解码器的段边界没跟段长比对。核实后发现比反馈更宽：DQT 逐项读、DHT 读计数与值、SOF 读帧头与分量、DRI 读重启间隔，四处都没用 `end` 卡。
- 真实后果：路由那条有 try/catch，只坏一张图；但后台预热是 `void` 丢弃返回值，一张截断的 JPEG 抛 RangeError 就打断循环，`warming.delete(slot)` 跟着跳掉，预热槽位永久卡死——以后新加的图再也不补缩略图，而且不报错。这与上轮修的「空队列让槽位卡死」是同一根病根换个马甲。
- 修法两层，各自独立成立：① 解码器四处读取前用 `end` 挡住，截断就返回 null；② 预热循环内层包 try（单张失败只跳这张）+ `finally` 里必放槽位；③ `buildStickerThumb` 也包一层 catch 兜底，`saveThumb` 改先写临时文件再 rename（避免半张 PNG 被 `hasThumb` 当成命中而永不自愈）；④ `inflateSync` 加 `maxOutputLength`（像素上限只管位图大小，不管压缩比）。
- 取证方法：两处都做了修前/修后对照。真·修前（两个文件都回退到 HEAD）新用例失败、修后通过；单回退 `sticker-thumb.js` 时用例仍通过——说明第一个版本夹具没真正触发异常，改错了两轮才定位到必须让 DQT 的 precision=1 走 16 位读分支。实测旧码抛 `RangeError: offset 15 > 13`。
- 定向：`node --test --test-concurrency=1 tests/jpeg-codec.test.js tests/sticker-thumb.test.js tests/gif-frames.test.js tests/ui.test.js tests/ui-loading.test.js tests/sticker-library.test.js tests/stickers.test.js tests/sticker-usage.test.js tests/vision.test.js`，**248/248 通过**。
- 第二轮复审（新包）无阻断项，但指出 SOS 扫描头也没卡段尾：`Ns` 只占 1 字节、读 255 也不崩，但 Buffer 越界索引会给 undefined，`dataStart` 跟着跳到文件外，后面一整段熵解码拿到空数据。虽然最坏只是退回原图，与前两处同一类，经确认后一并补上：SOS 头在 `Ns` 与 `Ns+2×分量数+3` 两处都卡 `end`。
- SOS 取证同样做了修前/修后对照：真·修前新用例失败，修后通过；合法夹具仍能解开（确认守卫没误杀）。全量 **1858/1858 通过**。
- 第三轮复审（终审包）无阻断项，并确认五处段头（DQT/DHT/DRI/SOF/SOS）全部卡上了段尾，没有第六处；又点了两处：① png-codec 的 IHDR 读 UInt32 没查长度；② index.js 的 `/memory/:agentId/reset` 里 `rmSync` 直接用裸 param。
- 第①项确实存在（段长 0–7 会抛 ERR_OUT_OF_RANGE），已加 `if (length < 13) return null`，修前/修后对照同样成立。
- 第②项待了两轮相反结论（上轮「不可利用」、这轮「未校验」），本轮实跑核清：`store.resetPartnerMemory` 第一步是 `getKnowing` → `partnerPathId` → `requirePartnerId`，实测 `..`、`../../etc`、`__proto__`、`a/b` 四个值全部抛 `INVALID_PARTNER_ID`，`rmSync` 到不了。所以上轮判断对，功能上不可利用；但形式上确实破了 partner-id.js 「新文件路径一律使用 requirePartnerId」的约定，已补一层自己校验，不靠调用顺序保平安。
- 全量 **1859/1859 通过**（1858 为补 IHDR 用例前的数）。
- 这轮三个同类问题（DQT 会抛异常、inflate 无上限、SOS 越界读）都出在同一份手写解码器上，根源是逐个分支各自实现段尾判断。下次动这个文件应按「每个读了几个字节、够不够」统一过一遍，而不是等审包指出。
- 此修改发生在候选包导入之后，所以既有 ZIP/entry 证据失效；full verify、云候选、导入、副本测试、独立审包全部重跑。

## 发布 v0.10.2 前的完整验证（2026-10-19）

- 定版：manifest 0.10.1 → 0.10.2，`.cloud-build/config.json` 同步；CHANGELOG 把从未发出去过的 0.10.1 条目并入本版，不再留一个空版本号。
- 开发源码全量：`release.ps1 -Project chahuahui -Phase verify`，100 个测试文件，**1855/1855 通过，0 失败/取消/跳过**，36.3 秒（不含本地专用的 `tests/reply-rule-probe.test.js`）。1854 为补语音新断言前的数；提交拆分阶段的全量是 1854，定版并补上那条断言后为 1855。
- 提交按逻辑边界拆三笔，每笔都用 `git checkout-index` 导出真实快照再跑测试，不是拿最终工作树冒充：
  - `perf: 表情包网格改走缩略图，图库按新到旧摆` → 导出版 9 文件 **245/245 通过**。
  - `fix: 语音中途按停看得出停过` → 导出版 6 文件 **199/199 通过**；本条新增 1 项断言（暂停态类名、图标、波形 done、CSS 两处）。
  - `feat: 主动开口带上真聊天历史，晨间第一条不再非得有料` → 导出版 9 文件 **311/311 通过**。
- 踩到的坑：先按 hunk 分批暂存时，把 `tests/ui.test.js` 里主动消息那条旧断言也带进了语音那笔。该断言期望 `morningFirst: morningFirstScene`，而那一笔的 index.js 还没这行，导出版当场失败。按索引重看 hunk 后只取语音那条，重跑通过才提交。教训：hunk 分批必须验提交快照，不能验工作树。
- 未做：真实/付费模型调用，Release 安装、升级与真实旧数据迁移；独立交叉审包在打包后单独进行。

## 主动消息复用近期聊天与晨间场景（2026-10-19）

- 基线与范围：本轮始于 manifest 0.10.1（该版本未发布，已并入 0.10.2）；此前图库性能/加载优化保留。本轮只改主动消息上下文接线、晨间场景与已读跟进引导，不改伙伴人格/普通归属规则。
- `tests/proactive-context-history.test.js` 12项：独立历史含角色与时间、最多24条、排除动作/硬撤回/别的伙伴；自己图库标签在模拟实际请求中出现；字符污染重试保留历史；视频流式请求同样带历史；有种子的晨间首次场景及同生活日已联系后的非首次；共同经历不预设回味，空对象不能冒充来源，已读尾部不再指定围绕没回创作。纯函数与App harness模拟不等于真实模型自然度验收。
- 初版新增9项由实施阶段验证旧码失败；主会复核又发现强制回味/已读尾部指派/空对象凭据残留，3项断言在补修前实际失败。自有表情测试首次误把description当标签，已按现行情绪标签契约修正断言，非业务缺陷。补修后首轮18文件587过/2失败为旧断言未同步（仍期望旧指派、空白对象算来源），修正后589/589通过。再补1项晨间普通开口回归，确认旧的兴趣系统指令仍会逼伙伴贴题；限定普通晨间使用COMMON与可选背景，改掉尾部强制分享/由头，修后最终590/590通过。有种子的晨间用例让生成桩只回“早上好呀”，确认实际能发出。
- 最终定向命令：`node --test --test-concurrency=1 tests/proactive-context-history.test.js tests/compose.test.js tests/proactive.test.js tests/proactive-reasons.test.js tests/proactive-expression.test.js tests/proactive-clarity.test.js tests/video-login-notice-compose.test.js tests/ui.test.js tests/video-share-routes.test.js tests/video-login.test.js tests/awaiting.test.js tests/model.test.js tests/prompt.test.js tests/reply-supersede-routes.test.js tests/conversation-grounding.test.js tests/memory.test.js tests/poke.test.js tests/reply-action-target.test.js`，**590/590通过，0失败/取消/跳过**，约20.39秒。相关4份JS语法及定向diff空白检查通过。只跑直接相关测试，未跑全量，未调用真实/付费模型。
- 保留的边界：24条仍受既有4000字符预算限制，长消息时少于24条；日期标注复用普通聊天的时间格式，不为每条重复写时间。跨日连续感不硬切，原有末轮场景只作由头资格依据，12小时资格门未改。出站晨间资格重新读取当前lastSentAt；用例覆盖已有联系状态，不冒称模拟了生成中的并发更新。夜间/睡前/被叫醒等共用出口也会收到历史，专项真实表现未测。素材使用记账仍沿用既有“提供给本轮即消费”逻辑，晨间选择只招呼时也可能消耗所提供的种子/发现；本轮未引入新的意图协议或素材使用分类调用。
- 独立只读交叉审查完成，无已确认硬阻断。补充未测边界：有电脑近况时LINKUP_DISCIPLINE仍在；晨间有种子/发现仍经过既有清楚度复核，自动返回send的桩不能证明真实模型必然放行问候。普通utility生成中撤回/线程变化未增加出站新鲜度复核；硬撤回用例只覆盖构造前已撤回，不能宣称覆盖生成中撤回。字符污染重试已有带历史行为证明，utility空回复加预算重试虽静态复用messages，尚无带历史专项集成回归。审查为静态，590项最终结果由主会实际运行核对。
- 真实聊天表现和说话人归属仍待观察，不能把接线测试通过当作模型不再读串。正式加载状态见PROJECT_LOG。

## 表情包网格缩略图（2026-10-18 起，2026-10-19 补 JPEG 与通用性）

- 基线（实机数据）：茶话会图库 205 张，原图合计 314.9 MB，平均 1.5 MB，最大单张 6 MB；网格一打开就把全部原图经 `hana.api.fetch` 一次并发 4 张拉进 webview。她的截图表现为“一堆空格子 + 破图图标”，实际是请求还在排队。
- 改动：`lib/png-codec.js`（PNG 编解码 + 框面积缩放）、`lib/jpeg-codec.js`（基线 JPEG 解码）、`lib/sticker-thumb.js`（按内容哈希缓存到 `sticker-thumbs/`，最长边 256）；`index.js` 新增 `/sticker-thumb/:agentId/:id` 与 `/source-sticker-thumb/:id`；`ui/panel.html` 网格改取缩略图、加 IntersectionObserver 懒加载、失败不再永久缓存；`lib/gif-frames.js` 改用共用编码器。
- 第一轮翻车：缩略图失败时兜底掉去查来源快照（自己图库里的图不在那儿），JPEG 全库 404。已改为就地退回这张自己的原图。
- 解码器正确性取证：PNG 解码与 .NET `System.Drawing` 对同一张图取 5 个采样点逐像素一致；JPEG 取图库 25 张真 JPEG（23 基线 + 2 渐进），与 .NET 对同一坐标 **828 个通道采样最大差 3**（IDCT 舍入），2 张渐进式正确返回 null 退回原图。修掉三个真 bug：量化表之字序反向（DC 恰蒙对、AC 全错）、RGB 直接写 Buffer 按 256 回绕（255.6→0）、YCbCr 色度改双线性上采样。
- 测试夹具：项目无 JPEG 编码器，`tests/helpers/sample-jpeg.js` 按规范手工拼最小基线 JPEG（灰度 16×8、两 MCU），另经 .NET 核对（左右 128 / 129 一致）才当基准。
- 修前实测一个自造 bug：pending 为空时 async 任务同步跑完，`warming.delete(slot)` 先于 `warming.add(slot)`，槽位永久卡住，“以后新加的图也补上”实际不成立。已改为无待办直接返回、先 add 后建任务，并有专门用例锁住。
- 定向测试：`node --test --test-concurrency=1 tests/jpeg-codec.test.js tests/sticker-thumb.test.js tests/ui.test.js tests/ui-loading.test.js tests/sticker-library.test.js tests/stickers.test.js tests/sticker-usage.test.js tests/gif-frames.test.js tests/vision.test.js`，**242/242 通过，0 失败/取消/跳过**。新文件 17 项（JPEG 4、缩略图 13），UI 新增“网格只取缩略图、屏幕外等露脸、缩不出来退回自己原图”断言。
- 实机数据（2026-10-19 补齐后）：图库 205 张中 **202 张有缩略图**，剩 3 张走原图（2 渐进式 JPEG + 1 头部无法识别），合计 211 KB；整库 314.9 MB → 49.5 MB。来源库 330 张中 303 张有缩略图（72 张基线 JPEG 中已含大部分，26 张渐进 + 1 未知走原图）。
- 已知边界：只支持基线/扩展顺序 JPEG（SOF0/SOF1）、PNG、GIF；**渐进式 JPEG（实测 26/98）和 WebP 不缩**，直接走原图，行为不变但不享受优化。像素上限 8 MP（同时是内存红线）；单图超过就退回原图。缩略图缓存不主动清理已删图片的孤儿文件。
- 通用性自查：第一版只认 PNG/GIF 是被本机图库数据（164 PNG / 36 JPEG）掩盖的，对多数以 JPEG 为主的用户等于没优化；已补 JPEG 解码并按文件头（magic bytes）认格式，不信后缀（本机图库实测有后缀 jpeg 内容 PNG 4 张、后缀 gif 内容 WebP 1 张）。
- 未跑全量测试（发布时再跑）；未调用真实/付费模型；未改 manifest 版本/简介/README，未提交或发布。正式 reload 返回成功。

## 表情包图库按新到旧排列（2026-10-19）

- 需求：图库列表改按新入库在前。加完图第一件事就是看一眼刚加的那几张。
- 改动：`listStickerLibrary` 在返回给界面前 `.reverse()`；`readStickerLibrary` 的存储顺序不动（`removeSticker` / `removeStickerGroup` / `renameStickerGroup` 都从它读，反转只发生在给界面看的那一层，避免把存储顺序也带偏）。
- **范围是整个逻辑，不是只改「全部」那一页**：顺序在筛选之前就定好了，`rowsForGroup` 只筛不排，所以每个自定义分组里的图同样是新到旧。为防止以后被人“顺手整理”掉，加了行为回归：`ui-loading.test.js` 用 `panelHarness(["rowsForGroup"])` 跑真实函数，三个分组断言新到旧；并在 `rowsForGroup` 上写明「只筛不排」。
- 测试：`tests/sticker-library.test.js` 新增「新入库的排最前」，同时断言盘上顺序仍是导入顺序；`node --test --test-concurrency=1 tests/sticker-library.test.js tests/stickers.test.js tests/ui.test.js tests/ui-loading.test.js` **205/205 通过**；`tests/ui-loading.test.js` 单跑 **26/26 通过**。
- 实机数据核对（只读）：存储顺序最后 3 张与界面顺序最前 3 张正好逆序；分组「古装小圆子」里也是新到旧。未写入生产数据。
- 未跑全量测试；未调用真实/付费模型；未改 manifest 版本/简介/README，未提交或发布。正式 reload 返回成功。

## 表情包抽屉「刚打开一片空白、分组不出来」（2026-10-19）

- 现象：刚点开表情包时有一段空白，自己建的分组也不显示，过一会儿才齐。
- 根因：图库和来源用 `Promise.all` 绑成一个请求。分组 tab 和网格只靠图库，却要陪着等那份三百多张的来源清单；另外图库没到之前，`renderStickerRows` 先摆了一句「图库还空着，去挑几张你喜欢的」和一个「添加」按钮——她看到的不是空库，是还没到。
- 改动：`loadStickerLibrary` 与新的 `loadStickerSource` 拆开（来源在飞行中去重 `sourceTask`，拉完 `sourceReady` 记一笔）；打开聊天时 `void ensureStickerLibrary().catch()` 预热图库，点笑脸时已是现成；未拉到时显示「正在读图库…」并藏掉「添加」按钮；来源清单不进聊天预热（跟伙伴无关），改在「添加」页现读现用并显示「正在读来源图库…」，读不出来时先清掉那句再摆解释。
- 修测试夹具：`ui-loading.test.js` 的 `openHarness` 按名字注入函数，新加的两个预热函数不在名单里，`openPartner` 一调就 ReferenceError，整条打开流程断掉。已补两个返回 Promise 的替身（返回 undefined 也不行，`openPartner` 后面接的是 `.catch()`）。
- 测试：`node --test --test-concurrency=1 tests/ui.test.js tests/ui-loading.test.js tests/sticker-thumb.test.js tests/jpeg-codec.test.js tests/sticker-library.test.js tests/stickers.test.js tests/sticker-usage.test.js tests/gif-frames.test.js tests/vision.test.js`，**243/243 通过**。新增断言：两个请求不再绑成一个、来源飞行中去重、聊天打开即预热、未拉到说「正在读」、添加页现读现用。
- 语法：panel.html 内联主脚本 `node --check` 通过（注意该文件有两个 script 块，取第二个，块 0 是 380 字节的中文注释片段）。
- 未跑全量测试；未调用真实/付费模型；未改 manifest 版本/简介/README，未提交或发布。正式 reload 返回成功；打开抽屉的实际观感仍待她在实机上看一眼。

## 专属节日回应引导（2026-10-18）

- 基线：重载前App Manager运行清单显示0.8.0、磁盘manifest为0.9.0。正式reload后运行清单为`app:chahuahui on / 0.9.0`。没有保存的实际茶话会生成请求，不能把提示词测试当作模型已自然说出口。
- 改动：普通节日背景不再一概要求“别主动报”。仅拾光记现有带专属引导的12个节日添加轻回应提示；个人纪念日、普通事件和未配置专属引导的节日不升级。节日提示独立于日常背景的按天去重，避免本日首次注入被记账后，后续回合没有回应机会；同一聊天已祝福时要求不重复。
- 语法：`node --check lib/daybook.js index.js tests/daybook.test.js tests/daybook-app.test.js`，4份通过。
- 定向测试：`node --test --test-concurrency=1 tests/daybook.test.js tests/daybook-app.test.js`，**34/34通过，0失败/取消/跳过**。覆盖节日响应文案、动态称呼、事件/个人纪念日不升级、未配置节日不触发，以及独立于日常去重的注入接线。
- 全量发布验证：`release.ps1 -Phase verify`，97 个测试文件，**1816/1816 通过，0 失败 / 取消 / 跳过**，约 36.4 秒；`TZ=Asia/Shanghai`，HANA_HOME、HOME、USERPROFILE 使用隔离临时目录，TEMP/TMP 使用系统默认临时目录。日志：`_test_runs/chahuahui_release_v0.10.0_20261018/release-verify-system-temp.log`。
- 环境异常记录：首次把 TEMP/TMP 指到工作台临时目录时，`store.test.js` 的原子 JSON 替换报 `EPERM`；检查后源码树、版本与测试目标文件均完整。切回系统临时目录后，同一边界用例 1/1 通过，全量发布验证也通过。没有看到安全软件告警；根因未能进一步证实，不将它归为应用逻辑缺陷，后续测试继续让 TEMP/TMP 使用系统默认临时目录。
- 未调用真实/付费模型；节日回应在自然对话中的表现仍未验证，不把提示词和自动化测试通过等同于实机聊天验收。

## 内部时间/主动来由标记泄漏（2026-10-17）

- 修复前样本：两条普通回复中的时间标题与主动来由说明已落入 assistant `text`/`bubbles`。第一轮与交叉复核补漏前各留了一份修复前快照（10 份、9 份文件），均逐份 SHA-256 核对一致。
- 第一轮新回归在旧实现上3/3按预期失败。只读交叉复核随后发现来由原文换行、标记同行回显、装饰性时间括号误删及空正文注入幽灵消息；追加括号嵌套/转义边界后，补修前共6项失败。
- 最终 `node --test --test-concurrency=1 tests/split.test.js tests/compose.test.js tests/prompt.test.js` **102/102通过**；`node --test --test-concurrency=1 tests/reply.test.js tests/proactive.test.js tests/proactive-expression.test.js tests/focus-companion.test.js` **106/106通过**。六份相关JS文件 `node --check` 均通过，指定源码/测试/记录的 `git diff --check` 无输出。
- `awaiting nudge` 不走 `cleanVoice`，但实际进入 `splitReply`；本次在该边界也接入同一窄清理，无需扩大为其余残片规则。只运行直接相关的局部测试，没有跑全量测试；未调用真实/付费模型。
- 最终补修后 `extension_manager` 正式reload从当前磁盘重载成功，列表为 `app:chahuahui on / 0.8.0`。代码已保存并加载，模型自然复现仍待后续聊天观察。

## B站参与名单与合计上限集中设置（2026-10-17）

- 开工前已读取当日《B站登录状态为何失效》会话及当前源码/项目记录，以最新加密持久登录和二维码倒计时为基线，不沿用旧内存登录方案。快照位于本机工作台 `_chahuahui-backups/video-participants_2026-10-17_110633_current_login`，10文件逐份SHA-256核对；未读取真实配置或凭据。
- 缺失videoSharingEnabled默认false，仅严格true参与，明确旧true/false保留。集中PUT `/settings/video-sharing`必填 `{maxPerDay,partnerIds}`：额度0～5整数、名单严格字符串/合法ID，范围与GET设置相同的可见伙伴列表；未知或隐藏ID拒绝、去重。原子写入次数及原伙伴布尔字段，写成功才替换运行内存；隐藏/暂时不可见伙伴及其他偏好不改，不另存名单。0暂停不清选择，旧伙伴PUT仍写同一字段。
- UI同一块编辑名单和合计次数，明确保存按钮，加载前/保存中锁定，错误或不完整回包保留草稿和原状态。伙伴页只读并跳转集中卡片。恢复伙伴时按服务端值初始化新增可见项、旧项保留草稿；非B站伙伴保存慢回包不盖参与字段；列表GET与集中PUT共用现有队列，payload在出队后构造，覆盖恢复伙伴期间立即保存的边界。
- 新存储6用例在改前全部失败，修后通过；后端首轮32项31过1失败由新测试错误使用初始化fixture store而非App运行实例造成，改用真实模拟HTTP设置/隐藏路由后两项新路由测试通过，未为测试改业务。独立只读审查反馈的刷新/慢回包遗漏均有定向回归补齐，最后构造时点由主会复核并扩写并发用例。
- 最终命令：`node --test --test-concurrency=1 --test-reporter=tap tests/video-settings-store.test.js tests/video-settings-ui.test.js tests/video-share-routes.test.js tests/video-login.test.js tests/video-source.test.js`，TEMP/TMP使用系统临时目录。**220/220通过，0失败/取消/跳过，约20.87秒**；最终TAP在本机工作台 `_test_runs/chahuahui_video_participants_final_verified_20261017.log`。UI32项含内联脚本解析/DOM监听、保存失败/不完整回显、并发名单保护、原倒计时和按钮稳定态；相关JS语法及定向diff空白检查通过。仅局部验证，没有真实网络或付费模型调用。
- 最终源码对比开工快照：`lib/video-login.js`、`lib/video-source.js`逐份SHA一致；index中的createVideoLogin持久接线、UI完整扫码/倒计时块逐字一致。因此没有覆盖另一个窗口的新登录修复。未修改manifest版本/简介/README，未提交、推送或发布。
- 正式reload返回从当前磁盘重载成功，inspect为host=on/agent=on。已保存且已加载，设置页实机视觉/实际名单操作和自动分享仍待验，不能用模拟测试代表实际分享。未重启Hana、未代改生产参与选择或要求重扫账号。

## B站二维码按钮闪烁与有效期倒计时（2026-10-17，本地完成，已重载）

- 根因：二维码轮询每2秒执行；每轮开始与结束都调用`videoButtons()`，把两个按钮的`disabled`在真/假间切换。`ui/assets/settings.css`中`button:disabled`会把透明度降到`.52`，所以按钮周期性变灰再恢复。轮询锁`videoRequestBusy`本身仍需保留以防并发。
- 修复：轮询仍持有内部并发锁，但不再刷新按钮禁用态；显式生成/刷新操作仍保留原有即时禁用反馈。慢轮询时按钮不闪，点击刷新仍不会发起并行请求。
- 倒计时：复用API给出的同一`expiresAt`，显示`二维码剩余有效期：MM:SS`并每秒更新；数字使用等宽数字，倒计时单独放在`aria-live=off`区域，避免屏幕阅读器每秒重复播报。计时到0时立即清二维码并停轮询；成功、B站过期、异常、刷新、离页或隐藏都会清掉倒计时。
- 验证：改前UI定向测试 **24/24通过**；新按钮稳定态回归在旧实现上按预期 **1/1失败**（慢轮询中`disabled`为true）。修后命令`node --test --test-concurrency=1 --test-reporter=tap tests/video-settings-ui.test.js` **26/26通过**，覆盖每秒递减、已扫码状态、到期清理、离页/隐藏清理、慢轮询不并发及内联脚本语法/DOM监听目标。结果分别留在`_test_runs/chahuahui_qr_ui_countdown_baseline_20261017.log`、`_test_runs/chahuahui_qr_buttons_red_20261017.log`、`_test_runs/chahuahui_qr_ui_countdown_final_20261017.log`。
- 仅跑直接相关UI测试，未跑全量应用测试；合成时钟验证通过，真实设置页显示待界面复验。当前代码已通过正式 App reload，未重启Hana或改简介/README。

## B站二维码登录跨重载持久化（2026-10-17，本地完成，实机待验）

- 基线：改前定向命令 `node --test --test-concurrency=1 --test-reporter=tap tests/video-login.test.js tests/video-source.test.js tests/video-share-routes.test.js tests/video-settings-ui.test.js`，**199/199通过**。
- 原因与改动：扫码确认及nav验证成功后，旧实现只把SESSDATA留在进程内，Hana/App重载便会丢失。现复用Windows DPAPI `CurrentUser`保护，只把nav验证通过的SESSDATA原子写入既有凭据文件；应用新实例读取后仍先以B站nav复验，不凭文件存在就报已登录。
- 清除边界：仅B站明确返回`code=-101`或`data.isLogin=false`时清除当前内存凭据及对应DPAPI文件。网络、HTTP、JSON错误和未知响应均保留凭据；状态缓存仍为5分钟。DPAPI保存失败时登录仅限本次运行，设置页如实显示。
- 手动兼容入口`/video/login`继续要求`persist:false`，只替换本次运行内存，不覆盖或清除已有扫码登录文件；若手动临时登录另一账号，重载后仍会恢复原先保存的扫码账号。设置页不调用此入口。
- 最终局部验证：同一四文件命令 **204/204通过，0失败/取消/跳过**；包含二维码扫码存储、未知状态保留、明确过期清除、DPAPI文件拒绝明文、主路由读取、设置文案以及父进程写入、子Node进程新建登录管理器并重新nav验证。跨进程测试只向stdout输出状态和布尔值；另静态断言DPAPI Protect/Unprotect均固定为`CurrentUser`。
- `node --check`：7份JS通过；`git diff --check`指定源码/测试/UI文件通过。最终TAP：`_test_runs/chahuahui_video_persistent_login_20261017_final.log`。中间两轮发现的语法/旧文案断言与3条过时严格期望均已修复后完整复跑；第二轮记录保留于`_test_runs/chahuahui_video_persistent_login_20261017.log`。
- 本轮未跑全量测试、未真实扫码/联网验证B站账号、未调真实模型、未读写生产凭据；仅用合成凭据验证DPAPI跨Node进程解密。extension_manager已从当前磁盘代码正式reload，应用仍为`on / 0.8.0`；未重启Hana、未改版本/简介/README或发布状态。

## 重启后嵌入小窗输入框偏大（2026-10-17，待实机复验）

- 基线：嵌入小窗在 Hana 重启后输入框偶尔变高，关闭并重开小窗可恢复。当前源码路径只在打开伙伴、输入等场景调用 `autosizeInput()`；此前没有页面加载完成或宿主窗口尺寸恢复后的重测。根因仍是代码线索推断，实际重启布局尚未取到运行时测量。
- 修复：页面 `load` 与 `resize` 后等待两帧，再走原有输入框自适应高度逻辑；高度上限继续由 CSS 控制。
- 新增回归断言改前失败。命令 `node --test --test-name-pattern="输入框：|首次打开及|并排小卡要给宿主|并排输入栏柔和收边" tests/ui.test.js`：4/4 通过。`node --test --test-concurrency=1 tests/ui-loading.test.js`：25/25 通过。`panel.html` 两段内联脚本语法解析通过，`git diff --check -- ui/panel.html tests/ui.test.js` 通过。
- 较宽的 `node --test --test-concurrency=1 tests/ui.test.js tests/ui-loading.test.js`：159/164，5 条与本次输入框无关的应用断言失败（设置接口字段、起跑线痕迹、醒睡门控、等回音硬门、安静收尾）。因此不宣称整组通过。
- App 已正式 reload 并 inspect 到 `host=on / agent=on`；Hana 重启后的实际小窗外观仍待人工复验。

## 扫码登录实机验收通过（2026-10-16 21:56，UTC+8）

- 页面显示已登录；安全诊断13:56:49.992Z记录最终poll确认回包存在SESSDATA字段且提取成功，sessionCookieInResponse=true，sessionCookieFromEarlierPoll=false；13:56:50.113Z进入logged-in阶段。该阶段只在nav返回code=0、isLogin=true并通过二维码有效性与代次检查后提交，实机扫码登录已通过。
- 本次使用最终确认响应头中的凭据，未依赖早期poll候选，也未进入跨域换票；不可将成功归因于跨poll暂存。本轮同时包含星号兼容与请求来源对齐，未隔离变量验证，之前失败的单一根因仍不能确认。
- 仅验收设置内扫码登录及真实nav验证，不代表字幕读取/伙伴自动分享整链已实机通过。未读取凭据内容、未调用额外模型或对外写接口。

## 旧成功路线对齐：请求来源与跨轮询候选（2026-10-16）

- 正式会话《茶话会趣味内容分享功能探讨》turn8记录：当天09:13:58扫码守护已取得SESSDATA，之后字幕探针记录nav isLogin=true。旧`qr-keeper.mjs`从每次poll的getSetCookie累积Map，本身无nav；后续`probe8-subtitle-auth.mjs`用原生fetch做真实nav验证。此处不重读凭据文件、不运行旧脚本、不复述账号资料。
- 对照静态差异并最小对齐：显式Referer为登录接口passport /login、nav www根地址；同二维码跨合法poll仅暂存SESSDATA，明确确认前不更新登录态、不发nav；最终确认后验证才提交。刷新、过期、新登录清空候选，空/无效值及Max-Age<=0或过去Expires清除候选，有效Max-Age优先。候选不进入UI、模型或诊断，仍只用ctx.network.fetch，不引入完整Cookie jar/后台调度器/磁盘保存。
- 新请求来源/跨poll场景修复前2/2失败，证明与旧脚本的可复现行为差异，不等于复现了真实账号的失败根因。独立审查指出非空值+删除属性遗漏，新增3负例修前失败，再补最小属性判断与1优先级正例；刷新/过期隔离及明确空值覆盖。
- 最终验证命令：`node --test --test-concurrency=1 --test-reporter=tap tests/video-login.test.js tests/video-settings-ui.test.js tests/video-share-routes.test.js`（TEMP/TMP为系统目录）。**147/147通过，0失败/取消/跳过，约5.69秒**；模块99、UI24、路由24项。TAP本机工作台 `_test_runs/chahuahui_qr_success_baseline_final_20261016.log`。语法和diff空白检查通过，没有真实扫码、网络或付费模型调用。
- 必须保留的首轮异常：补属性处理前同组三文件143项中142过、1失败，`tests/video-share-routes.test.js:310`普通回复视频记忆召回断言模型调用次数2!==1；该用例未走扫码请求，最终相同场景通过，但原因与归属未定位。未改该用例/记忆业务、不能用最后通过声称偶发问题已修；首轮TAP `_test_runs/chahuahui_qr_success_baseline_20261016.log`保留。
- 独立只读核查当前安装artifact：未找到ctx.network.fetch主动过滤Set-Cookie证据；headers用entries键值对往返并重建Response，显式Referer/Cookie被转发，未有自动Cookie jar。仅最终响应可读，中间重定向头没有保证；此限制不证明本次确有Cookie丢失。此次GET未使用请求体或宿主缓存，不处理无关SDK问题。
- 独立静态复核未见本轮阻断问题；正式reload成功，manifest仍0.8.0，简介/README未改。待实机扫码与新安全诊断，不能宣称本次真实登录故障已解决。

## 合法星号凭据与字段存在性诊断（2026-10-16）

- 实机记录确认：扫码成功进入passport.biligame.com固定HTTPS换票路径，HTTP200、Cookie头存在，但没有有效SESSDATA；尚不知是未返回该字段还是其值被拒。没有读取或记录真实凭据，不据此归因宿主。
- 静态发现sessionCookie额外字符白名单误拒Cookie合法字符星号；新增带星号的合成换票回归，修改前明确失败。最小修正仅允许星号，保留其他格式/请求头注入限制和nav验证；增加SESSDATA字段存在布尔诊断，与值通过校验的布尔值分开，不记录内容。合法性参考RFC6265 cookie-octet中%x23-2B包含星号，此依据不证明真实凭据中含星号。
- 同三文件局部 **138/138通过，0失败/取消/跳过，约5.53秒**，模块90、UI24、路由24项；TAP为本机工作台 `_test_runs/chahuahui_qr_cookie_star_20261016.log`。模块语法与diff空白检查通过，未真实联网/扫码或调模型。
- 正式reload成功。已修的是可复现格式兼容缺陷；其是否解释本次实机失败、实际登录是否成功仍待下一次扫码验证。

## 扫码按钮稳定布局与确认阶段诊断（2026-10-16）

- 实机已能生成二维码，安全记录stage=ready；截图确认后显示未取到凭据的受控提示。原文“需要宿主支持”缺乏本次换票响应证据，已改中性表述，不将旧跳转能力限制当本次已知根因。
- 按明确布局反馈仅调整刷新在左、扫码固定右侧、按钮38px同高，沿用现有按钮样式；DOM顺序/局部CSS及中性受控文案有回归。未做最终页面视觉验收。
- 确认阶段增加安全记录：已知域名类别、HTTPS/固定路径/参数存在性、HTTP码、Cookie头及SESSDATA存在布尔值、nav状态；不记录原URL、ticket、key、Cookie、账号资料或异常文本。支持官方poll确认响应直接带SESSDATA，仍必须nav验证才提交，不带则走原URL/换票路径。
- 同三个直接相关文件 **137/137通过，0失败/取消/跳过，约5.07秒**，模块89、UI24、路由24项；新增直接Cookie验证、无Cookie换票阶段与未知地址安全拒绝验证。命令同后文三文件组，系统TEMP/TMP；TAP在本机工作台 `_test_runs/chahuahui_qr_confirm_buttons_20261016.log`。语法及diff空白检查通过，没有真实网络/扫码或模型调用。
- 正式reload成功。本轮取凭据故障仍待再次扫码后的实际阶段记录，不能用模拟通过宣称登录已解决。

## 官方account二维码内容域兼容（2026-10-16）

- 实机诊断：HTTP200，url/key均为string，officialUrl=false，属于本地地址校验拒绝。一次不带账号凭据的公开生成接口探测只输出安全形状：HTTP200、业务码0、HTTPS、host为account.bilibili.com，无fragment/凭据/端口，唯一qrcode_key与独立字段匹配；没有输出、落盘或向模型提供二维码key/原URL，也未扫码登录。此探测不是宿主网络路线实机验收。
- 旧代码只认passport.bilibili.com；新增合成account域回归，修改前1项明确失败。最小修改仅将account.bilibili.com加入二维码内容精确白名单；不请求该地址，不改manifest网络域名，不放宽key绑定及其他URL规则。
- 修正后同三文件模拟组 **132/132通过，0失败/取消/跳过，约4.66秒**；含passport/account合法内容与伪装子域拒绝。命令同下一节，TAP在本机工作台 `_test_runs/chahuahui_qr_account_host_20261016.log`。语法及diff空白检查通过；无真实模型调用。
- 正式reload成功，修正已加载；仍需重新点击生成、实际扫码及最终nav登录验证。此前无全局URL的VM假说只在人工缺URL环境可复现，没有当前App缺URL的直接证据，未据此修改其他模块或声称是实际根因。

## 二维码生成失败安全诊断（2026-10-16，实机反馈后）

- 实机基线0.8.0：设置按钮下显示“二维码暂时生成失败，请检查连接后重试。”；宿主日志确认20:16新版已装载，不能直接归因未重载。旧代码将网络、HTTP/业务拒绝、JSON/字段校验与本地编码合并为同一句提示，没有足够记录确认根因。修改前相关模块/index/测试已另存本地时间戳备份并核哈希。
- 改动只加安全诊断与精确提示，不放宽二维码URL/key绑定、不绕宿主网络、不更换二维码编码器。诊断仅含阶段、HTTP/业务码、字段类型和布尔校验、允许清单错误码/类型，不含URL、key、ticket、Cookie、原始响应或异常文本。
- 命令：`node --test --test-concurrency=1 --test-reporter=tap tests/video-login.test.js tests/video-settings-ui.test.js tests/video-share-routes.test.js`。**3文件131/131通过，0失败/取消/跳过，约4.79秒**，系统TEMP/TMP；TAP在本机工作台 `_test_runs/chahuahui_qr_diagnostics_20261016.log`。本轮只跑直接相关局部，不与前轮201相加。
- 模块85项（含新增网络/HTTP/业务/JSON/格式/编码六类安全诊断），UI22项（四条精确安全提示及近似/私密异常不透传），路由24项。index和登录模块语法、diff空白检查通过。没有真实网络/登录或模型调用。
- 正式extension_manager reload回包成功，说明本轮磁盘代码已重载。**二维码实机故障根因仍未知，等待再次点击生成后读取安全诊断；不能把诊断能力落地当作已解决登录。**

## 戳一戳/小动作误触发文字回复（2026-10-16）

- 基线：0.8.0，不升版本；只动本轮回复目标与恢复链，新增 `tests/reply-action-target.test.js`，不改 manifest/简介/README，不跑全量、不调真实模型、不读写生产账本。
- 最终命令：`node --test --test-concurrency=1 tests/reply-action-target.test.js tests/reply-supersede-routes.test.js tests/reply-supersede.test.js tests/reply.test.js tests/poke.test.js tests/prompt.test.js tests/awaiting.test.js tests/actions.test.js`，TEMP/TMP/HOME/USERPROFILE/HANA_HOME 全指新建系统临时根。
- 初轮8文件142/142通过；主线匿名化用例并补齐动作两种kind、旧待办仅动作、伙伴动作不遮真文字，以及真正生成中的动作时序后，**最终8文件144/144通过，0失败/取消/跳过**（新文件7项）。最终日志在本机工作台 `_test_runs/chahuahui_action_review_20261016.log`；初轮基线及修后日志保留在 `_test_runs/2026-10-16_2012_baseline/`。主线复验五项环境变量指向系统临时根，index/turn-window语法检查通过。
- 修前基线：5 条中 2 条真实复现失败——末尾只剩未读用户戳一戳仍发出 1 次模型请求；真文字后夹戳一戳时回复目标被戳一戳夺走（拿到 poke 的 id 而非真文字 id）。另两条修前已过，属防回归：旧待办指向动作时靠 `tail.find` 偶然取到真文字；生成期间的 poke 因 `deliveringReplies` 守卫没排出第二轮。两处已被显式判定取代，不再靠巧合。
- 覆盖：末尾只有未读poke/action→重载不生成且不盖已读；旧pendingReply只有动作→清待办且不调模型、不盖读；旧动作待办后有真文字→恢复文字且上下文末端是该文字；真文字后夹用户及伙伴动作→目标仍是真文字；模型挂起期间来poke→不排第二轮文字、动作仍落线程；`canAnswerPoke` 连戳规则未变。
- 来源核对：本地实机宿主用量账与茶话会diagnostics、线程交叉核对；恢复轮由未读动作触发，线程过滤动作后末端为伙伴自己的主动文字。原始请求编号与私人原话仅留本地原证据，不复制进项目。
- 交叉复核补修：手动重新生成拒绝动作目标、引用目标只取真实发言；待办/搜索/兴趣判断的latestUser也排除动作。补修前新增2项均失败（动作重生成误返回200；辅助语义接线缺过滤），补修后同一8文件最终**146/146通过，0失败/取消/跳过，约12.04秒**；新文件共9项，其中辅助语义项为静态接线断言，不冒充搜索自然度测试。补修前日志`_test_runs/chahuahui_action_extra_baseline_20261016.log`，最终日志`_test_runs/chahuahui_action_final_20261016.log`。补修前命令的管道退出码未可靠透传，以日志2项失败为基线；最终命令先保存node退出码再打印日志，退出0且非空146项通过。
- 未覆盖：随机回戳定时器未实机，只验了`canAnswerPoke`判定与动作落线程；没有调用真实模型检验聊天自然度。正式加载状态以PROJECT_LOG最后记录为准，不把加载成功等同实机验收。已撤回占位在异常持久化旧pending中可能反复恢复的窄风险另记待查，本轮未改撤回语义。

## B站扫码与逐伙伴开关、实际失效提醒（2026-10-16）

- 基线：0.8.0，不升开发版本；原有长期记忆与表达改动保留。只验证本轮登录、设置、Store及主动表达直接相关范围，不全量、不调用真实模型、不真实扫码、不读写生产账本。
- 最终命令：`node --test --test-concurrency=1 --test-reporter=tap tests/video-login.test.js tests/video-share-routes.test.js tests/video-login-notice-compose.test.js tests/video-settings-ui.test.js tests/proactive-expression.test.js tests/store.test.js tests/video-sharing.test.js`，TEMP/TMP为系统临时目录。
- **最终7文件201/201通过，0失败/取消/跳过，约8.77秒**。TAP在本机工作台 `_test_runs/chahuahui_qr_partner_reviewed_20261016.log`。此前193、198项通过后，按独立复核补三条时序/旧凭据回归并修正主接线，再跑最终组，不将多轮数目相加。
- 登录模块79项：本地二维码生成、旧URL和crossDomain票据、只提SESSDATA、Cookie头Expires逗号、验证成功才提交、网络未知不假报过期、五分钟缓存与合并、旧nav/扫码/票据在途回包代次隔离、2秒节流和180秒TTL、刷新/失败安全终止、凭据不进入公开回包或磁盘。
- 真实apply模拟路由24项：保留原字幕/额度/认知链；增加伙伴开关兼容、持久化、隔离及非法类型、生成中关闭、过期提醒不混视频且计主动总额、重新登录后旧提醒作废、同事件每日去重/拒绝退避、扫码start/poll/status整路和安全失败回包。
- 设置UI17项：本地SVG在img隔离显示，轮询串行、离页/刷新/终态停止、迟到回包不恢复；伙伴开关失败保留真实状态；start12秒、poll30秒覆盖后端多段请求，普通API仍8秒。只精确匹配受控取凭据失败显示宿主限制，其余原始异常泛化。
- 独立静态复核发现的阶段开关、出站await、失效事件和sceneEcho冲突均已修正；第二轮复核又发现线程基线保存太晚及旧磁盘账号复活风险，已改为探索/提醒入口任何await前取基线，并停止主流程自动载入旧账号文件（文件原样保留）。新增实测覆盖utility等待时线程变化不搜索、人格读取等待时线程变化不发提醒/不记额、旧文件不读取也不删除覆盖。审查伙伴静态确认三处闭环；utility等待时开启专注的动态分支未单独实测，仅源码确认门禁存在。正式reload已申请，但新增域名authority仍须用户审核，不能宣称已加载。
- 已做index、登录模块、compose、store及新增路由测试语法检查和diff空白检查；vendor与UI脚本另有局部语法验证。
- **待实机**：新增Passport域名权限正式生效，真实二维码可扫与登录确认，当前宿主是否能取得新ticket的最终Cookie，真实模型自然提醒/分享及页面视觉。凭据目前仅本次运行内存，重载需重扫；不能将198项模拟通过当作真实登录成功。

## B站字幕视频分享整路接入（2026-10-16，本地开发）

- 范围：视频材料三层、分享条目纯逻辑、真实apply模拟路由、设置UI、搜索隐私、既有探索/主动/记忆/Store的直接相关部分。共18个文件，非全量回归；模型和网络均为模拟，没有真实付费模型调用、B站账号动作或生产账本读写。
- 最终命令：`node --test --test-concurrency=1 --test-reporter=tap tests/video-source.test.js tests/video-material.test.js tests/video-materials.test.js tests/video-sharing.test.js tests/video-share-routes.test.js tests/video-settings-ui.test.js tests/topic-search.test.js tests/interest-exploration.test.js tests/split.test.js tests/compose.test.js tests/proactive.test.js tests/proactive-reasons.test.js tests/memory.test.js tests/store.test.js tests/store-durability.test.js tests/longterm.test.js tests/longterm-store.test.js tests/longterm-routes.test.js`。
- **460/460通过，0失败/取消/跳过，约23.84秒**。HANA_HOME/HOME/USERPROFILE/TEMP/TMP全部指向新建的系统临时测试根。完整TAP留在本机工作台 `_test_runs/chahuahui_video_systemtemp_20261016_152343.tap.log`；之后仅补一条video-stale诊断，另行定点复验路由14/14通过、17份JS语法及diff空白检查通过，不重跑无关全量。
- 视频材料124项：固定两轮成功且同中文轨/全段文本和时间一致、逐段时间合法、分P取自身cid/时长、P2不误拿顶层P1的cid拒绝、时长先过闸，无字幕不自动拿弹幕替代；加密失败拒绝明文落盘、读取也拒明文与伪加密标记（2026-10-17 修订：系统锁拿不到时改退本机锁，两种锁都拿不到才拒绝落盘，本机锁也是 AES-256-GCM 密文）。材料节选明示、外部内容不作为指令、【字幕资料】与头部规则分隔。
- 14个真实apply模拟路由：设置0～5及非法值、无登录不出网、已登录只搜索B站并存字幕候选、Cookie不送字幕CDN、内存登录不写文件/设置/回包；当前伙伴模型实际生成、完整链接落消息后才建条目并记视频额/主动总额；[不回]冷却，缺链接不发；生成中关闭视频/主动总闸/伙伴开关或降低总额度时旧稿不发且不白白冷却；普通回复召回字幕资料、静默认知反馈与具体用户再提续期、删除来源失效；明确停止优先于情绪归因，普通单条/某类不喜欢不误关。
- 分条修复：通用HTTP(S) URL的`?p=2`、`&`参数、英文标点及长网址不再被拆坏，旁边中文句号仍可分句；split局部18项通过。分享额外在实际气泡文本中再验完整链接，未送出不扣额度。
- 中间失败如实保留：第一轮458/460，新增memory.videoSharing默认形状未补进reset测试断言，已补；另一项为工作台临时目录连续写650条时renameSync EPERM。暂停后核源码、版本、git diff和备份存在；persistence.js无改动，失败临时目标JSON完整、临时写入文件已按既有catch清除。两失败用例在系统默认临时目录定点2/2通过。第二次把整组临时根仍放工作台时459/460，仍仅同项EPERM；之后改用独立系统临时根、日志仍留工作台，整组460/460通过。未改持久化逻辑、未加绕过权限重试、未关闭安全软件/加白名单；具体占用来源未证明，不能断言是安全软件。
- 宿主网络只读源码核查：当前1.1.7-beta的IPC不传redirect、底层默认跟随；不同源会删Cookie，allowedHosts不逐跳检查。manifest仅新增当前实际请求的api.bilibili.com、aisubtitle.hdslb.com并设2MB上限；Referer/分享链接不是额外网络请求。没有声称禁止所有跨域跳转。
- **待实机**：域名权限的正式生效、真实账号字幕返回、所选模型是否自然决定分享/拒绝、后续聊天的语义理解与自然度、实际费用及设置页面视觉。未把模拟绿当真实视频归属证明；仅查源码不算带凭据重定向验证。正式加载状态另记PROJECT_LOG：正式reload要求用户审核新增authority，未代批准；inspect仅证明host/agent仍启用，不能声称本轮已加载。

## B站视频材料续接核查（2026-10-16）

- 基线：manifest 0.8.0，三份 video 测试 68/68 通过；尚未接入主动消息、设置与记忆链路，宿主域名授权也未配置。
- 复现：模拟第一次取得正常字幕、第二次播放器接口 HTTP 503，旧 fetchSubtitle 仍返回 ok:true。新增回归先失败，补显式复核成功标记后通过；同时补存所选字幕 URL，避免校验辅助信息一直为空。
- 验证：`node --check lib/video-source.js`；`node --test tests/video-material.test.js tests/video-materials.test.js tests/video-source.test.js`，69/69 通过。仅视频材料相关测试，未全量、未调用真实模型、未重载宿主。
- 真实只读探测：同一视频、aid/cid 与分P不变，前两轮播放器字幕清单的中文轨道 ID 不同；所选中文字幕分别为55段（2.92～275.18秒）和223段（0.1～536.5秒），视频537秒。证明本轮返回确有变化，尚不能证明具体风控机制。第三轮所选地址未命中探针限定域名，未取正文。
- 待核：全文一致性、字幕轨道固定、正文预算截断与来源边界、凭据在宿主沙箱中的真实加密失败处理。弹幕可读不代表知道视频内容，不能用两者合并的成功率充当视频阅读覆盖率。

## 人类式长期记忆（2026-10-15 开工，2026-10-16 局部验证）

- 基线：manifest 0.8.0 / HEAD `16a94f2`，工作区干净，10份原文件已在本机专项备份目录核对SHA-256。此项是已授权的新能力，不是已复现的旧实机故障。
- 语法：`node --check` 通过 index、facts、memory、store、summarize、longterm，以及 store/longterm/longterm-store/longterm-routes 四份测试，共10份JS；`git diff --check` 通过。README、manifest版本/简介未改。
- 最终命令：`node --test --test-concurrency=1 --test-reporter=tap tests/longterm.test.js tests/longterm-store.test.js tests/longterm-routes.test.js tests/memory.test.js tests/facts.test.js tests/summarize.test.js tests/store.test.js tests/store-durability.test.js tests/prompt.test.js tests/compose.test.js tests/conversation-grounding.test.js tests/recall.test.js tests/reply-rules-compact.test.js tests/reply-supersede-routes.test.js tests/fact-migration.test.js`。
- **15个相关测试文件，292/292通过，0失败/取消/跳过，约8.50秒**。仅相关局部测试，未跑全量。完整TAP日志在本机工作台 `_test_runs/chahuahui_memory_verified_20261016_073715.tap.log`。临时Store与真apply均用独立临时目录，宿主模型/语音/网络出口为模拟；最终合跑另把HANA_HOME/HOME/USERPROFILE/TEMP/TMP指向本轮独立临时根，不接生产模型或读写生产账本。
- 新的3个测试文件共56例：纯逻辑31、Store8、真实apply模拟17。覆盖长期条目不随650条历史或注入预算FIFO删除、141条落盘重开/清聊天保留；旧事实早于最后12条仍能按原文对象唤起、无关不注入；无效来源不在召回层二次投影；已读软撤回保留既有认知，不随来源移出窗口忽隐忽现；硬撤回/删除依赖失效。
- 反馈覆盖hold/doubt/revise、嘴上让步但保留判断、逐字quote与来源id/预期快照、并发迟到和幂等、已作废旧稿不落账；完整/畸形/未闭合/孤立闭合协议先于气泡/徽章/表情/语音处理剥离，语音请求无协议或条目id。撤回当前回复目标后stale、不落回复/记忆且无wav残留；因真实路由在processing时阻止撤回，此项在合成等待期间用Store补丁模拟状态，不能当成界面撤回验收。
- 整理覆盖原摘要与原事实整理两次utility，不额外加第三次；有效entries写入与水位推进；JSON损坏、非空旧facts或在途源撤回时不写条目/摘要、不推进水位，同场景重试成功且不重复；未被接话的主动独白两份材料均排除。批末主动消息在完整线程已被近期窗口回应时，两份材料均保留且可作逐字证据；资格在等待期间改变则放弃本次提交。
- 过程中修正：reset测试预期补新增longterm；旧两字对象的事实缺少显式触发词，补原文主语/引号名/英文对象提取而不任意二字切词；该正则初次误写u模式下非法转义，已修并重验语法。交叉审查与整路用例另发现并修正facts无证据旧通道、目标撤回旧稿、批次资格变化、截断后再次误删批末主动消息、下游二次投影与非空旧数组被过滤成成功空结果。没有为了跑绿削弱这些业务断言。
- **尚未验收**：真实模型的提取重要性、语义关联、是否自然hold/doubt/revise、长期相处自然度及实际费用。本轮没有真实付费模型调用，没有自动全历史回填、向量检索、人格改写或新界面。旧事若已彻底丢失，不能凭空恢复。正式加载状态单列在PROJECT_LOG，不以源码/模拟测试替代运行时证据。


## 联动吐槽的事情坐标（2026-10-14，本地开发）

- `node --check lib/compose.js` 与 `node --check tests/conversation-grounding.test.js` 通过。
- `node --test --test-concurrency=1 tests/conversation-grounding.test.js tests/compose.test.js`：54/54通过，0失败/取消/跳过，约0.54秒；覆盖已有背景归属/事实/日期与模型拼装，追加新题对象坐标、本来知晓/非刚获知、同题不重复以及不复述工作结论的静态契约。
- `git diff --check -- lib/compose.js tests/conversation-grounding.test.js` 通过。未全量、未真实模型调用；静态规则在场不代表实际措辞合格，真实主动表达待观察。

## 跨夜专注不是缺陷：暂停态不结算（2026-10-14 排查结论）

- 现象：`09ac5d4b`（读书，10-13 19:44:43 开始，15 分钟）于 10-14 07:36:51 才结算，`status=interrupted`、`durationMs=477590`（7.96 分钟），一度被当成“过夜卡住未结算”。
- 结论：**不是缺陷，是暂停**。两条证据：① 茶话会认领记录为 start 19:44:46 / distracted-1 19:48:19 / distracted-2 19:50:20 / end 07:36:52，而 20:01、20:08、20:12 她在茶话会说过三次话（“不理我了？”“人捏”），若那段仍在跑必触发 distracted 或 reply 陪读，实际一条没有——`focusRunning()` 遇 `pausedAt` 即为 false，暂停中不认人、不提醒、不结算。② 时长反推：全程 11.87 小时若未暂停会被 15 分钟封顶为 900000ms，实际 477590 ≠ 900000，说明 `activeSince` 被重置；而 `activeSince` 只在 `startFocusSession` 与 `resumeFocusSession` 两处写入，反推恢复时刻为 07:28:53，距结束仅 8 分钟。即暂停 11.74 小时后恢复、跑 8 分钟、结束。
- 处置：**不改代码**。暂停就该冻结结算，该行为正确。若日后要做“暂停跨夜给个提示”，属新需求而非修 bug，需先经她拍板。
- 教训：看到专注时间跨度异常长，先查暂停/恢复证据（茶话会认领时间戳 + durationMs 是否被 plannedMinutes 封顶），再谈结算故障。本轮因先入为主误判，白查一轮。

## 整组结束与单轮结束分开（2026-10-14 实机验收，本地开发）

- 验收记录（一整组 3 轮跑完，`45cced4e` r1/3、`4f501178` r2/3、`2986044b` r3/3 均 `status=completed` `planStatus=completed`）：中段开场/收尾都带轮次与剩余轮数（seq1069/1070/1071），气泡已切条，上一轮的话不再被重提，开场不再接上一轮客套——这几项实机均已生效。**唯一仍不对的是最后一条 seq1072**：原文「时间到了哈，书合上噻。/ 歇一会儿嘛，眼睛也该松口气了。**下一轮再说。**」整组已经跑完，不该再提下一轮。
- 根因：`focusReminderSpec` 的 end 场景只有两个分支——中途轮（报还剩几轮）与“单轮结束”。多轮计划的最后一轮落进了后者，场景里只写“简短收尾，让对方自行决定休息或继续”，没有任何“整组已结束”的事实，模型就把上一轮的习惯（还有下一轮）顺着接了下去。
- 改法：新增 `finalRound`（completed 且多轮且无剩余）与 `finalCut`（interrupted 且多轮且无剩余）两个判定。completed 场景拆成三分支，整组终点那一支明写“没有下一轮了，这段约定已经完整走完”，并要求回头看一眼这一组走过的几轮 + 关心她现在的状态（累不累、要不要起来、眼睛肩颈、要不要吃点东西，按性格与关系选一两样，不列清单）；interrupted 的最后一轮明写“整组到此为止”但不得当成做完。system 里给整组终点单独一段口径：比中间任何一轮都该多说两句，先收住整段、让她知道一路陪到了这里，再说状态；禁“下一轮/下次再/休息完再来一轮”；并把尾部的“只给一两句短话”改成这一次可以多说几句、其余仍一两句。
- 未动：中途轮次、单轮结束的两条旧口径、起始与回复提醒、拾光记任何文件。
- 语法：`node --check` 通过 lib/focus-companion.js 与 tests/focus-companion.test.js。
- `node --test --test-concurrency=1 --test-reporter=tap tests/focus-companion.test.js tests/focus-routes.test.js` → **28/28 通过**（新增“整组结束与单轮结束是两件事”一组用例，含中途轮与单轮不受影响的反向断言）。`tests/conversation-grounding.test.js tests/compose.test.js tests/proactive.test.js tests/prompt.test.js tests/ui.test.js tests/model.test.js tests/awaiting.test.js tests/split.test.js tests/clock.test.js` → **374/374 通过**。未跑全量、未用真实付费 API。
- 一次失败：新用例把 system 里的“让你知道你一路陪到了这里”写成了“让对方”，与实际文案不符；改断言而非改文案（文案里的“对方”与 spec 内部人称一致）。
- 待验证：整组终点那条是否真的不再提下一轮、是否真能说出带关怀的两三句——需重载后实机观察，本节不宣称已解决。

## 主动消息去小作文与来处锚定（2026-10-14，本地开发）

- 触发来源：实机 seq1064（`proactiveKind=proactive`、`context.kind=affection`，经 workfeed 拿到电脑那边对话背景）。原文 88 字两泡：「我觉得最值得借的是把“我是谁”和“我怎么做”分开：…其实我也想你了，就来找你说一声」——一开头就抛结论，读的人得往回翻才知道说的是电脑那边；同时是典型的“论点+论证”两段。
- 改了两处，分属不同层：`lib/compose.js` 的 `LINKUP_DISCIPLINE` 第一条（原来只写“需要区分场合时可以顺口说”，是可选的，模型直接跳过）改成硬要求“开头半句就把来处点一下”，并钉死“半句是坐标不是开场白、写完就进正题、别复述别汇报”；`PROACTIVE_COMMON_SYSTEM` 新增两条不论证、不展开“问题—分析—结论”，并禁止末尾用“我还没想好”“你觉得呢”擑长。
- 选型：她选了 B 档（只留观点+反应，连“因为”都不给），不是只砍到两段。关系式由头（contact/affection/已读未回）与普通问候未动。
- 数据依据（09-25 起 173 条主动消息实拉）：1 个气泡 124 条中位 17 字，2 个气泡 43 条中位 69 字，3 个气泡 6 条中位 92 字；按由头分组 `plain` 中位 22/均值 40 共 159 条，`reason/contact` 中位 27、`read-followup` 中位 23、`reason/affection` 中位 89。关系式都短、只有兴趣长，确认是兴趣路径的系统性问题。
- 为何 c78269d 的精简档没管住：那笔只替换 `lib/prompt.js` 的四块纪律（立场/查证/喜好/放肆），而 `proactiveSpec` 走的是 `lib/compose.js` 的 `PROACTIVE_COMMON_SYSTEM`，两套提示词互不覆盖。
- 语法：`node --check` 通过 lib/compose.js 与 tests/conversation-grounding.test.js。
- `node --test --test-concurrency=1 --test-reporter=tap tests/conversation-grounding.test.js` → **15/15 通过**（新增“来处锚定”与“不论证”两组用例）。`tests/compose.test.js tests/proactive.test.js tests/proactive-clarity.test.js tests/proactive-reasons.test.js tests/prompt.test.js` → **172/172 通过**。`tests/focus-companion.test.js tests/focus-routes.test.js tests/ui.test.js tests/model.test.js tests/awaiting.test.js tests/split.test.js tests/clock.test.js` → **249/249 通过**。未跑全量、未用真实付费 API。
- 一次失败：编辑时把同一条旧规则截断成了 `...",不要拿…"`，引号提前闭合，`node --check` 直接报 `Invalid or unexpected token`；改回完整原句后通过。业务与用例未因此让步。
- 待验证：真实模型下主动消息是否真的不再论证、来自电脑那边的话是否真会在开头点一下来处——两处都是提示词层约束，需重载后实机观察，本节不宣称已解决。

## 陪读格式与只讲一件事（2026-10-14，本地开发）

- 触发来源：实机。1053–1056 四条陪读提醒 `bubbleCount` 全为 1，而同线程普通主动消息 1051 为 2；1053 是第 2 轮开场却先接了上一句「好诶，贴心小花~」；1054（end）与 1055（start）开头几乎同构（"哦豁…问都不答"/"哦豁…转移话题"）且两次都说「行嘛，不拷问你咯」；1050 顶着【2026年10月14日 7:58】但实际 07:53 发出——它拿提示词里的钟点脑补时刻。1053–1056 无一句提到轮次，说明改动未重载或多轮字段未进来（待实机复验）。
- 轮次进度感（2026-10-14 上午追加）：一轮完成后 5 分钟休息结束重开时，只说「我在这守到，你安心读你的」，没有轮次、时长、休息与剩余轮数——她要的是「5 分钟休息结束，继续读书，第 2 轮」这类信息，但不能报菜名。`focusReminderSpec` 的 start 场景加入「第 N 轮 / 这轮 M 分钟 / 还剩 K 轮 / 最后一轮」，并在上一轮是休息（`previous.phase === 'break'` 且编号不同）时改写成「刚才的 N 分钟休息结束了，现在开始第 N 轮」；end 场景按 `breakKindAfter` 区分短休与长休的分钟数（长休不拿短休的数冒充）。system 里把「轮次只是背景，不必报数字」改成「让她清楚第几轮、还剩几轮是需要的进度感，但要挑自然的地方提一两句，别把轮数、时长、休息分钟数排成一串念出来」。
- 轮间休息与主动消息（2026-10-14 上午，一次修正后回退）：曾观察到第 2 轮结束进 15 分钟长休后第 4 分钟发出主动消息，一度把闸门从 `focusRunning()` 改为新增的 `focusOngoing()`（含休息段），改完她自己说“休息的时候倒是可以主动找我聊天”——休息是她自己留的空，不该一并堵掉。**该改动已全部回退**，index.js 与 lib/focus-companion.js 恢复为只认 `focusRunning()`，`focusOngoing` 已删除，测试钉回 `focusRunning({phase:'break'}) === false`。本节保留这段是因为它解释了一个容易被当成 bug 的现象：多轮计划里休息段发主动消息是当前的预期行为。
- 范围：`sendFocusReminder` 陪读消息改走 `splitReply` 切条；开场/收尾/走神三种提醒一律不带上一轮聊天正文（`HISTORY_LIMIT` 三个都置 0），只有 `reply`（带 ownMessageId）才按那条往回给全；`focusReminderSpec` 的 system 补“不拿钟点编时间、开场不接上一轮客套”，user 末尾追加“只说眼前这一件事、不重复上一轮、不把没答的问题换个说法再问”。钟点表、多轮口径、午休边界均未改。
- 收尾重提旧话题（09:0x 实机，`focus:end` seq 1061）：她在专注里说了「知道了知道了」，自己已用 `reply` 接过（seq 1060），计时一到收尾又把同一句捡起来打趣一遍。原因就是收尾仍带最近两条正文——收尾只该收计时，不该重开刚聊完的话题。开场同理（接上一轮客套），走神提醒的场景话本就声明“不知道聊天内容”，喂正文自相矛盾。
- 休息字段来源：拾光记 `RECORD_FIELDS` 放行 `breakKindAfter/shortBreakMinutes/longBreakMinutes`（此前只放行轮次与 planStatus），否则茶话会收尾时不知道该歇多久。
- 语法：`node --check` 通过 index.js、lib/focus-companion.js、tests/focus-companion.test.js、tests/focus-routes.test.js 四份 JS。
- `node --test --test-concurrency=1 --test-reporter=tap tests/focus-companion.test.js tests/focus-routes.test.js` → **28/28 通过**。`tests/proactive.test.js tests/awaiting.test.js tests/ui.test.js tests/compose.test.js tests/model.test.js tests/prompt.test.js tests/awaiting-routes.test.js tests/partner-feed.test.js` → **354/354 通过**。`tests/split.test.js tests/clock.test.js tests/reply-supersede-routes.test.js tests/avatar.test.js tests/memory.test.js tests/relationship.test.js tests/focus-companion.test.js tests/focus-routes.test.js` → **131/131 通过**。未跑全量、未用真实付费 API。
- 四次修正均在模拟环境，不绕门禁：一次失败是把旧用例里钉死 `focusCompanion.active()` 的断言改成 `ongoing()`，随后回退时改回；另一处 `indexOf('autonomousGateNow')` 命中调用点而非定义点，已随回退一并删除该用例。
- 拾光记侧：`tests/focus-companion.test.js` **7/7 通过**（多轮投影用例含长短休分钟数）。`tests/focus-routes.test.js` 与 `tests/focus-reminder.test.js` 各有 **1 个失败，均为本次改动之前就已存在**，与轮次字段投影无关：① `focus-routes` 的实 apply 子进程用 `spawnSync(node, ['--input-type=module','-e', childCode])` 跑一段内联代码，该代码里 `/第 1\/1 轮开始/` 的正则被模板字符串里的反斜杠吃掉，在 eval 时抛 `SyntaxError: Invalid regular expression flags`；② `focus-reminder` 的通知断言写死 `/第 1\/4 轮开始/`，而当前轮次文案是「第 1/1 轮开始」。把本次改动临时回退后两处仍同样失败，已复现对照，未在本次修（属另两个测试自身的转义与断言口径，不属本改动范围）。合计 20 例中 18 通过。
- 三次修正都在模拟环境，不绕门禁：① 新增“只讲一件事”断言后旧用例仍写 `主动招呼对方进入状态`，改断言为 `招呼对方进入新一轮的状态`；② focus-routes 实 apply 用例仍断言开场带最近 6 条（7 条消息），按新口径改为 1 条，隐私断言原样保留；③ 历史条数取 0 时 `slice(0)` 是“从头给全”正好相反，改为 `count > 0 ? slice(-count) : []` 并钉进用例。收尾重提旧话题那次修正同样落在模拟环境：走神提醒断言由 3 条改为 1 条，并删去已不成立的“留两条语境”断言。
- 待验证：陪读消息切条后的界面观感、开场是否不再接上一轮客套、收尾与走神是否不再自我复读、多轮口径是否真的露出来——均需重载后实机观察，本节不宣称已解决。

## 陪读拿钟点与多轮口径（2026-10-14，本地开发）

- 范围：`sendFocusReminder` 注入 `timeBlock`（与普通回复同一份，不另造）并对生成正文补 `stripTimeHeader`；`lib/focus-companion.js` 的 FIELDS 放行轮次字段、`focusReminderSpec` 按轮次出话。拾光记 `focus/state` 投影同步放行轮次字段。人格、计分、权限、manifest 版本、README 与简介未改。
- 触发来源：2026-10-14 实机。早上 07:36 收到 `focusReminder.kind=end` 却说「晚安，好梦哟~」，07:38 收到 `kind=start` 的陪读开场却是「【2026年10月14日 7:36】早哦~醒了没得嘛…」并整段复述前一晚的对话。两条的 sessionId 与拾光记 `focus-sessions.dat` 完全对得上，确属陪读提醒，不是普通主动消息；标题前缀是模型照抄 `threadToMessages` 给隔夜消息加的 `【年月日 时:分】`，而这条路径不经过 `splitReply`，没人剥。
- 语法：`node --check` 检查 index.js、lib/focus-companion.js、tests/focus-companion.test.js 及拾光记 lib/focus-companion.js、tests/focus-companion.test.js 五份 JS，全部通过。
- 茶话会局部：`node --test --test-concurrency=1 --test-reporter=tap tests/focus-companion.test.js` → **22/22 通过**（新增多轮口径与钟点两组断言）。`tests/focus-routes.test.js tests/split.test.js tests/clock.test.js` → **32/32 通过**。`tests/compose.test.js tests/prompt.test.js tests/model.test.js tests/proactive.test.js tests/awaiting.test.js tests/reply-supersede-routes.test.js tests/avatar.test.js` → **220/220 通过**。`tests/ui.test.js tests/clock.test.js tests/split.test.js tests/focus-companion.test.js tests/focus-routes.test.js` → **191/191 通过**。未跑全量、未用真实付费 API。
- 拾光记局部：`tests/focus-companion.test.js` 首轮 6/7 通过，新增多轮投影用例里 `longBreakEvery` 期望值写错（该字段刻意不投影）→ 改为断言 `undefined` 并写明理由，**7/7 通过**；`tests/focus-routes.test.js tests/focus-reminder.test.js` → **11/11 通过**。未跑全量。
- 边界：轮次字段读不到时按单轮处理，不报错也不编数字；休息阶段仍不算进行中，不打断既有安静口径；`stripTimeHeader` 只认死形状，`【小声】`一类情绪方括号不动。真实语气自然度仍待实机观察，未在此宣称解决。

## 自然陪读开场与自身回应（2026-10-13，本地开发）

- 范围：focusReminderSpec分阶段自然表达；sendFocusReminder仅读自身6条/每条300字的role/text/at投影，背景通知与真话分开；/turns传自身消息ID；合并、冷却边界及旧稿检查。人格、计分、权限、manifest版本和其他伙伴知情破例口径不改。
- 语法：`node --check`检查index.js、lib/focus-companion.js、tests/focus-companion.test.js、tests/focus-routes.test.js四份JS。局部命令：`node --test --test-concurrency=1 --test-reporter=tap tests/focus-companion.test.js tests/focus-routes.test.js`。PowerShell7，HANA_HOME/HOME/USERPROFILE/TEMP/TMP隔离到C盘系统临时根，所有模型/网络为模拟；未用真实付费API、未全量回归。
- 首轮19/19通过；审查后增加外部阵次、自己排队过期和撤回场景，第一次22例中21通过/1失败：新撤回fixture未初始化已入住性格，因此0次模型调用（isSettled门禁），补真实入住前提及断言。单独复验再失败一次：错要求readAt必为空，实际既有主动查看可已读；改为撤回后旧稿不得新增已读标记，不抹去合法既有已读。两次失败均发生在模拟环境，不改业务绕过门禁或既有查看流程，最终同范围结果追加于下。
- 正常对照与护栏：开始无接下约定、时间目标只作背景；自身确认冷却内仍接住、连发只读最新ID；自身确认30秒后首次外部闲聊仍提醒、持续外部聊天不重复；新自身话/撤回/暂停/换段/超过90秒让旧稿stale。归档流水计数非次数额度，不加上限、不放宽迟到窗口、不重试/换模型。
- 真apply：实际模型请求带自身最多6条并截断原文到300字，不带附件/引用元数据或其他伙伴私聊；成功own回应绑定repliedTo并补已读；撤回旧稿无落盘回应、无新增已读、不亮failed；结束后普通聊天专注背景移除。模拟预置正文只证明接线和边界，开场/确认自然度仍待真实使用观察。
- 只读交叉审查复核：修补自身污染外部水位及撤回语义后，无具体阻断；保留从入队算90秒的既定过期原则。该新增阵次边界未保留修补前失败回放，仅静态发现与修后场景验证，不倒推旧实机曾发生。
- 最终同两文件 **22/22通过**，0失败/取消/跳过，约40.3秒；四份JS语法通过。正式extension_manager reload后inspect为host=on/agent=on；已加载不代表真实生成自然度已验收。

## 专注知情与自主破例口径（2026-10-13，本地开发）

- 仅替换focusChatText现有场景块与相应文字断言：无论劝回还是愿意陪聊都显出对专注约定知情，短聊可知情破例，性格与关系决定态度，不统一宠溺/纵容、不每轮机械劝或报状态。未改陪读主动提醒、隐私接线、队列和其他逻辑。
- 两份改动JS语法通过；命令 `node --test --test-reporter=tap --test-name-pattern='其他伙伴只获当下目标|真apply联动' tests/focus-companion.test.js tests/focus-routes.test.js`，本次 **2/2通过**，0失败/取消/跳过，约2秒。PowerShell7，HANA_HOME/HOME/USERPROFILE/TEMP/TMP隔离到系统临时根；模型/网络是模拟。
- 场景断言覆盖知情、可选破例、不统一性格与私聊边界；真apply验证新块进普通回复请求、陪读请求仍无对象/正文及结束后背景移除。未跑其他用例/全量或真实付费模型，旧231项不冒充本轮数量；真实感觉仍待实机观察。

## 专注回应与quote出口（2026-10-13，本地修复）

- 基线：匿名输入 `hello\n[/quote]\ncome back` 在修改前cleanVoice保留残片，隔离临时副本加载旧compose确认；属于输出后处理复现，不是真实模型重新生成。原实机回包及旧请求未完整留存，状态有效不等于证实旧请求含背景。
- 命令：`node --test --test-concurrency=1 --test-reporter=tap tests/focus-companion.test.js tests/focus-routes.test.js tests/compose.test.js tests/prompt.test.js tests/split.test.js tests/model.test.js tests/proactive.test.js tests/awaiting.test.js tests/reply-supersede-routes.test.js`，最终 **231/231通过**，0失败/取消/跳过，约25.4秒；9份改动JS语法通过。PowerShell7，HANA_HOME/HOME/USERPROFILE/TEMP/TMP隔离到系统临时根，模型/网络为模拟。
- 保留首轮：230/231通过，1失败是focusChatText旧字面断言仍要求“熟悉程度与关系”，新版已改为“性格与关系”；核实既有人格关系块未删后同步该断言，同范围复验231通过。首轮与最终TAP均在工作台 `_test_runs/chahuahui_focus_quote_20261013*.tap.log`，不抹掉首轮失败。
- 覆盖：quote配对外壳/作者属性/独立残片去除且保留正文；[ok]/[img]/[不回]/字面讲解/普通符号不误伤；历史仅清伙伴模型副本，用户文本及原对象不变；真apply模拟从带quote回包到落盘无残片；专注场景状态参与、性格关系与未知私聊边界仍在。没有修改splitReply断句行为。
- 交叉静态复核：无导入循环、不吞表情与安静出口；不添加其他标签族的泛化清洗。收尾移除一条过度针对样本的问话禁令，仅保留状态参与要求；对应单条场景断言1/1与模块语法复验通过。已提醒判断仍来自既有近期对话，不新增阵次追踪；窗口滚动后可能再次提醒，不宣称跨窗口强去重。
- reply.focus.context只证明应用在调用前拼入与否，不证明provider实际收到或生成已遵循，重试可能有多条记录。未跑全量、真实付费模型/API或新的人工语气验收；旧账本与已显示异常气泡没有改写，运行态见PROJECT_LOG。

## 专注期间闲聊感知与连续聊天合并（2026-10-13，本地开发）

- 修改范围：`index.js` 普通回复调用模型前动态追加有效专注目标；`lib/focus-companion.js` 的闲聊提醒口径、连续聊天阵次和在途时效。拾光记现有受管状态服务已足够，未改其源码、共享快照、manifest、权限或两边版本。
- 两个专注文件先验 **15/15通过**；四个改动JS的 `node --check` 通过。
- 相关命令：`node --test --test-concurrency=1 --test-reporter=tap tests/focus-companion.test.js tests/focus-routes.test.js tests/model.test.js tests/prompt.test.js tests/proactive.test.js tests/awaiting.test.js tests/reply-supersede-routes.test.js`，首轮 **177/177通过**，0失败/取消/跳过，约22.8秒。审查补充开场暂停恢复、排队过期以及结束后第五次失败保留断言后，最终 **178/178通过**，0失败/取消/跳过，约25.5秒。四个最终JS语法检查通过。首轮、审查轮与最终完整TAP均保留，本机工作台 `_test_runs/chahuahui_focus_20261013_final.tap.log` 为最终结果。PowerShell 7执行，`HANA_HOME/HOME/USERPROFILE/TEMP/TMP` 均隔离到本机系统临时根，模型与网络为模拟出口。
- 验证：每60秒发言持续超过旧冷却仍只提醒一次；发言间隔恰满90秒算新阵；超过旧三次上限仍能招呼新阵；重载保留合并、旧账本升级保守合并、新专注段重置。生成中暂停再恢复与超过90秒旧稿均判stale，不算模型失败、不自动重试；旧开场不补发、排队过期不调用模型。第五次提醒失败及结束后该失败仍可见有断言；保存结束阵次数，旧已结束账本兼容原三次状态。
- 真apply/真实临时磁盘模拟：其他伙伴请求含目标与ta的配置性格/关系，私聊正文只进ta自己的messages；陪读请求不含另一位伙伴名字或私聊关键词且要求主动招呼。陪读普通闲聊抑制、普通主动暂停、结束后普通回复不带专注背景均覆盖。
- 未跑全量回归、真实付费模型/API或人工实机语气验收。178条只代表本次直接相关范围，不代表全应用全绿或真实表达已自然；运行重载证据另见PROJECT_LOG。

## 实机目录合并后全量回归（2026-10-13）

- 使用 Windows PowerShell 7.5.1；串行枚举并运行 `tests/` 下全部 85 个 `*.test.js` 文件：`$tests = Get-ChildItem tests -Filter '*.test.js' -File | ForEach-Object FullName; node --test --test-concurrency=1 --test-reporter=tap @tests`。
- `HANA_HOME`、`HOME`、`USERPROFILE`、`TEMP`、`TMP` 隔离到本机系统临时目录的独立测试根；没有调用真实付费模型/API。
- **最终 1417/1417 通过**，0 失败、取消、跳过，耗时约 34.2 秒。完整 TAP：工作台 `_test_runs` 目录下的 `chahuahui_full_retry_20261013_151617.tap.log`。
- 诊断记录：首次把测试临时根放在工作台 `L:` 时 1413/1417 通过，4 个失败中有两项是临时账本 `renameSync` 的 `EPERM`，另有一项模型等待超时和一项数量上限断言失败；将这四个文件单独移到本机系统临时目录复验后 101/101 通过，再在同一临时目录完成全量 1417/1417。证据指向首轮临时路径/环境差异，但底层原因未单独证实，不据此归因于应用或安全软件。
- 首轮与专项 TAP 保留在工作台 `_test_runs`；测试隔离目录已清理。源码、未提交工作区内容及 `manifest.version=0.7.533` 未因测试改变。

## 陪读头像尺寸闸抬高（2026-10-13，本地开发）

- `lib/focus-companion.js` 的 `MAX_AVATAR_BYTES` 512KB→6MB：宿主伙伴头像实为 1~2MB，旧闸把真图全挡掉、拾光记只剩首字。头像判定仍共用 `resolvePartnerAvatar`（自己的头像优先，没有的走按「缘」默认脸）。
- 命令：`node --test --test-reporter=tap tests/focus-companion.test.js tests/avatar.test.js`，**29/29 通过**，零失败/取消/跳过；两个修改JS语法通过。
- 断言调整：尺寸用例新增 1~2MB 正例（必须过）、7MB 超限负例（仍空），并将 `huge` 加入名单使超限闸真正被测到。
- **实机验收（2026-10-13）**：拾光记重载后专注页伙伴头像正常显示，本 App 诊断日志同步印证八位伙伴头像均读到（真图 + 默认脸）。bus 承载 ~3MB base64 载荷已实机确认。

## 拾光记头像选人服务（2026-10-13，本地开发）

- 仅新增focus/avatar受管服务接线，头像规则提取为resolvePartnerAvatar，原页面头像路由与服务共用；本地角色只取本地导入图，宿主伙伴沿用头像/按缘默认脸。不读私聊正文，不修改提示词、关系、权限或版本。
- 仅允许拾光记调用、合法id且处于陪读名单；512KB限制，空图返回null。拾光记代理另验证图魔数/MIME匹配、no-store及不透传路径错误。
- 主会话命令：`node --test --test-reporter=tap tests/focus-companion.test.js tests/focus-routes.test.js tests/avatar.test.js`。最终 **30/30通过**，0失败/取消/跳过，3个修改JS语法检查通过。
- 无全量回归、真实模型/API或宿主跨App头像验收；版本保留0.7.533。正式重新加载结果见PROJECT_LOG。

## 专注陪伴联动（2026-10-12，本地开发，不升版本）

- 依赖拾光记的限定调用方服务；不读取其他伙伴私聊正文，只接收本段目标/所选伙伴/时间，以及茶话会发言事件。独立场景提示保留性格；普通主动、等回音、投喂及伙伴主动动作在最终写入点受专注门约束，不覆盖既有设置。
- 命令：`node --test --test-reporter=tap tests/focus-routes.test.js tests/focus-companion.test.js tests/model.test.js tests/proactive.test.js tests/awaiting.test.js tests/reply-supersede-routes.test.js tests/ui.test.js`；最终 **271/271通过**，0失败/取消/跳过。此前268通过，随后新增跨实例认领、结束失败状态及生成迟到拦截三项。迟到守卫后首轮270通过/1失败：旧用例仍将生成中结束判为failed，而当前正确语义为stale；核实场景后更新旧断言，相关范围复验271通过。相关6个JS语法检查通过。
- 新控制器测试覆盖开始/暂停/继续/结束、1.5秒合并、90秒冷却/最多三次、持久防重复、跨实例排他文件认领、结束失败在无active时仍可见、旧开始不补发、调用方隔离。真apply模拟集成覆盖伙伴既有人格/所选模型、其他私聊关键词不进提醒请求、选中伙伴普通回复抑制、其他伙伴正常回复、普通主动暂停。最终投喂/戳写入门与戳阻断不记额度另有源码接线断言；并非所有异步竞态都做了行为注入。
- 保留首轮失败：模拟模型调用对象误读 `.systemPrompt/messages`，实际应为 `.request.systemPrompt/messages`；主动tick返回需读 `.body.result.reason`，均为测试接线修正。首次较宽相关范围reply-supersede出现“3 !== 2”；无专注时避免多一次跨App等待后，窄与相关范围复验通过，但没有修改前稳定复现证据，不将首轮失败根因宣称已证实。
- 模型提醒关闭自动重试与utility fallback，保留原模型；成功/失败/未知送达状态独立保存，不用自动重投增加费用。跨实例claim使用本App数据目录内哈希文件排他创建，无正文；历史claim不主动删除。超时/停机后的pending只代表未确认送达。
- 两App官方静态校验均0错误/1警告（动态依赖/运行时加载未证明）；初次调用校验器漏 `--dir`，按其Usage修正后通过。一次遗漏显式TAP导致输出筛选为空，未据退出0报告数量，重新显式TAP取到上述有效计数。
- 未做全量回归、真实付费模型/API、实际MiniMax短输出与两App实机互调/视觉验收。仅静态与模拟通过，不宣称真实提醒自然度或整个应用全绿。运行态另见PROJECT_LOG。

## v0.7.532–533 · 主动由头与新对象轻介绍（2026-10-12傍晚）

- 范围：主动理由选择、关系双轨/性格权重、独立联系表达、实际已介绍记录、兴趣既有clarity入口、发送接线与直接相关回归。普通回复、频率/限额/静默、关系记账算法和模型预算未改。
- 修改前新增六条表达契约：2通过/4失败，构造输入定位独立理由、库存污染、首次介绍要求和轻联系拦截缺口，不是历史真实模型复现。
- 主会话合并命令：`node --test --test-reporter=tap tests/proactive-reasons.test.js tests/proactive-expression.test.js tests/proactive.test.js tests/compose.test.js tests/proactive-clarity.test.js tests/topic-seeds.test.js tests/conversation-grounding.test.js tests/workfeed.test.js tests/relationship.test.js tests/awaiting.test.js tests/ui.test.js tests/reply-supersede-routes.test.js`，最后一轮 **365/365**，0失败/取消/跳过。
- **保留首轮失败**：首轮同范围364通过/1失败，终端只保留最后12行，失败名称/堆栈被裁掉。之后用 `Select-String -Pattern 'not ok|error:|expected:|actual:|# tests|# pass|# fail' -Context 0,7` 保留失败段再运行，同范围365/365。未定位第一次失败的用例及原因，标测试波动待查；不声称修复、也不拿后一次通过反推首轮没有问题。以后测试不只裁末尾输出。
- 核心范围额外命令：`node --test --test-reporter=tap tests/proactive-reasons.test.js tests/proactive-expression.test.js tests/compose.test.js tests/proactive-clarity.test.js tests/ui.test.js`，**219/219**，0失败/取消/跳过。没有扩大到所有test文件。
- 语法：index.js、lib/compose.js、lib/proactive-reasons.js、lib/proactive-clarity.js及四个修改测试文件共8个JS通过node --check。与目录基线核对：lib/proactive.js / relationship.js哈希一致，nextDueFor / autonomousGateNow源码逐字相同。
- 新reason 24条：20个纯逻辑/来源/预算题，4个真apply路由编排题。宿主模型和clarity回包为桩，临时真实store重开验证：contact不注入/消耗种子；未回应仍走unread-followup；interest成功才记usedAt；shared真实原文进请求且不消耗种子。整轮完成后恢复Math.random，不把提前看见append当巡检结束。
- 新表达9条：独立搭话/想念不被兴趣约束污染；shared/tease要来源；无效reason不启用；首次/实际已介绍；纯联系放行仅限指定出口；特殊理由优先；空followup；保留待答问题优先级；关系由头也要解释新对象。
- 来源竞态：候选有workfeed、出站变空时会返回preserveIntent，失败分支保留暂存。只有enrichReasonContext单测与源码接线断言；真路由竞态注入未成功（harness与apply各自store），明确未有行为级证明。
- 权重为初始实现；不把单测当最优比例。实际已介绍记录有12条/1800字符证据窗口，缺记录保守介绍，不宣称从未聊过。
- 无全量、真实模型/API或网络测试；没有对照真实MiniMax聊天，没有用mock证明自然度或整个应用全绿。运行态另见PROJECT_LOG。

## v0.7.531 · 内测开关护栏与部分真实配对证据（2026-10-12下午）

- 实际模型测试发生在v0.7.530：同一openai-codex/gpt-6-luna、同一当前资料快照、同一场景消息，只切legacy/compact-v1。授权最多8次；**实际3次，2成功/1失败**，只完成ownership配对，search-result新档第三次渠道错误即停，后5次未发。不重试、不换模型、不提高预算。
- ownership两版消息hash相同，系统字符16213→15433，输入token12599→11979（少620，约4.9%），输出40→38、cacheRead均0。成功两次合计输入24578/输出78；失败usage=null，费用不能按0补齐或可靠换算。原始结果与逐请求账本一致。
- 两版都把主动性收回伙伴，没有继续推给对方；严格“明确蘸碟/香菜是谁先提”只部分符合，旧版本次也没有重现历史错误。新句醋蒜有测试前记忆和更早用户原话依据。独立只读复核建议保留单伙伴试点、不推广；不称语义等价。
- /probe/reply-rules是新本地独立测试入口，不与仍恒legacy的taste混用。固定4题、最多8次严格stream；无utility/重试、empty/error/未done/坏协议/模型报告超预算即停；首await前占位、重复runId与已有磁盘结果不重发，同一装载只1批。真实结果只写独立测试文件，两条成功正文在真实线程内命中数均0。
- 真实返回usage.output为数值，补齐超预算检测对此SDK形状的兼容，仅模拟验证，未追加真实调用。另修复compactReplyPilotId同时受DEV_TOOLS控制：公开源码即使只关总开关、未剥哨兵，也走legacy；私有DEV=true仍只有小花普通回复试点。此护栏修复与manifest/PENDING_CHANGES绑定升至0.7.531。
- 相关四文件命令：`node --test --test-reporter=tap tests/reply-rule-probe.test.js tests/reply-rules-compact.test.js tests/model.test.js tests/prompt.test.js`，**102/102通过**，0失败/取消/跳过。真实请求前版本为100/100；事后新增SDK形状及DEV=false模拟护栏到102。未跑全量，未调用真实MiniMax；普通回复文本规则未再次调整。
- 私有测试支持及报告按PUBLISHING本地排除项处理，不能将其带进公开仓库或zip。没有上传/发布；未用补测填满剩余请求。
- 当前运行态以PROJECT_LOG为准；本地单测与部分真实请求不代表所有伙伴、全部提示词或四场景均已验收。


## v0.7.530 · 有来处的普通回复规则精简试点（2026-10-12）

- 范围：四块固定纪律（查证、立场、喜好、互损）的 opt-in 精简档；只在本地小花普通回复接入。CHAT 风格、解释纪律、回应出口、关系档位、所有人格/记忆/动态块和主动路径不变。
- 修改前：v0.7.529 相关七文件目录备份，逐文件 SHA-256 与源一致。原 prompt / conversation-grounding / clock 三文件基线通过；新增试点断言在旧版确认会失败（规则减少及档位尚未接入），不是宣称旧版聊天语义重现。
- 定向命令：`node --test --test-reporter=tap tests/reply-rules-compact.test.js tests/prompt.test.js tests/conversation-grounding.test.js tests/clock.test.js tests/model.test.js tests/reply-supersede-routes.test.js`，**129/129** 通过，0 失败/取消/跳过。没有跑全量。
- 覆盖：证据确实缺失与讨好式认错分开；喜好/查证/互损的关键边界在场；原动态资料不截断；默认与未知档位仍旧版；本地试点/非试点各走真实 apply + 假宿主路由，不串伙伴、不增加生成请求；发布哨兵剥离后试点目标为空；十个匿名验收题结构有效。mock 回包不是语义验收。
- MiniMax：本次仅运行已有 model.test.js 的兼容模拟回归；未调用真实 MiniMax 或任何真实 provider，不能宣称新版提示词已通过 MiniMax 真实聊天测试。未改输出预算、协议参数、后台辅助模型或重试策略。
- 旧版保真：内存加载修改前备份模块，bare / 带回应与关系档位 / 带动态资料三组输入，当前 legacy 拼装结果与旧模块逐字一致。
- 字符口径：`partnerName=小花`、`userName=阿舟`、`replyText=replyChoiceBlock({userName:阿舟})`、`teaseText=buildTeaseText({stage:1})`，其余动态资料为空，分别不传档位 / 传 `ruleProfile=compact-v1`。固定提示词（含回复选择、关系说明）从 **4993 → 4213 字符**，少 780、约 **15.6%**；只含规则骨架时 4238 → 3458。这是固定提示词字符，不是全输入 token 比例，也不是账单费用下降。
- 真正评判题：`tests/reply-rule-cases.json` 十题，区分历史匿名节选、日志改编、人工正常对照。原始私有证据留本机、不进入公开包。题目尚未用于真实模型调用，十题不能写为“十题语义全绿”。
- 现有 `/probe/taste` 与 `chahuahui_taste_probe` 仍只拼 legacy；它们的结果不得给 compact-v1 背书。小花是线上真实常用伙伴，未实机验收前不得推广；固定模型与同一输入的配对验证和日常试聊是两种证据等级。
- 运行状态：源码已保存，真实模型对照尚未授权/执行。是否重新加载及是否确认运行档位，见 PROJECT_LOG 当前条目；没有凭源文件推断已经生效。


## v0.7.529 · 首条主动联系生活日与深夜睡眠追问护栏（2026-10-12）

- 范围：只改主动联系首条判定、晨间纯招呼分流、深夜睡眠追问检查及其相关测试。
- 定向命令：`node --test tests/clock.test.js tests/compose.test.js tests/proactive.test.js tests/proactive-clarity.test.js tests/conversation-grounding.test.js tests/ui.test.js`，**274/274** 通过。
- 全量：递归枚举 `tests/` 下全部 **79 个 `*.test.js`** 一次运行，**1346/1346** 通过，0 失败/取消/跳过。PowerShell 跑法：先用 `Get-ChildItem -LiteralPath .\tests -Recurse -File -Filter '*.test.js'` 得到完整文件列表，再与 `--test --test-reporter=tap` 一起传给 `node`。
- 相关 JS 与测试文件 `node --check` 全通过。App 静态校验：`validate-app.mjs --dir <茶话会目录> --json` 为 `ok:true`、0 errors、1 条既有 `DYNAMIC_DEPENDENCIES_NOT_PROVEN` warning。
- 覆盖：自然日配额不变，首条联系用 04:00 生活日；只有确实没有待办、回声、等回音或兴趣素材时才抽晨间纯招呼概率；首条有兴趣素材时仍正常注入并核查；深夜 23:00–04:59 普通主动消息拦截睡眠质量追问，到点待办不被整条丢弃；换行、语气词、引号、表情及第一人称自述都有边界用例。
- 未调用真实模型、未做实机验收或重载。全量单测与静态校验不能证明真实生成和运行态，仍需后续实际观察。

## v0.7.526 · 提示音等首条短消息显示后播放（2026-10-11）

- 范围：只改聊天页提示音接线与对应 UI 契约测试，没有扩大到全量。
- 命令：`node --test tests/ui.test.js`，**137/137** 通过，0 失败/取消/跳过。
- `ui/panel.html` 的内联 module 用 `vm.SourceTextModule` 语法检查通过（1 段）；`validate-app.mjs --dir <茶话会目录> --json` 为 `ok:true`、0 errors、1 条动态依赖静态检查 warning。
- 覆盖：到达事件先等消息渲染、首帧绘制后再播放、同一条分成多段只响一次；语音消息也走同一显示时机。
- 未跑全量测试，也未做实机听感验收；重载茶话会后还需确认屏幕先出现首条短消息、随后才响一声。

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

---

## 2026-10-16 · 主动联系的表情固化（CHF-20261016-01）

**改前基线**：manifest 0.8.0、HEAD `16a94f2`，`lib/compose.js` 已在本机专项备份目录保留并核 SHA-256。工作区另有未提交的长期记忆工作，本轮不碰。

**改了什么**：只动 `lib/compose.js` 的三处提示词——affection 由头落点、contact 由头落点、`greetingOnly` 早安招呼块；另把 `introducedText` 那块说明从「仅核对是否介绍过」扩为兼顾「哪些动作和开头刚用过」。选择权重、`isRepeatedPhrasing` 去重、间隔、配额、静默、已读未回护栏一律未动。

**本轮自动测试**：`node --test tests/compose.test.js tests/proactive.test.js tests/proactive-reasons.test.js tests/proactive-expression.test.js tests/proactive-clarity.test.js`，**143/143**，0 失败。语法检查 `node --check` 过。

**改测试的地方**：`tests/proactive-expression.test.js` 里「想念可以直接说」一条原本守 `/落点自己挑/` 和 `/别每回想念都落成同一个样子/`，这两句随提示词改写换成了新表述（意图不变：绕着说的路子要留、直说是正路不是让步、不补解释、软话与撒娇不一刀切），并新增身体落点、非身体落点、contact 换路三条在场断言。

**未测 / 待验证**：

- 真实自然度**未验证**——没有调用付费模型，也没触发真实主动消息。提示词文本在场只证明它被送到了模型，不证明模型会照做。
- `isRepeatedPhrasing` 的整句 0.86 / 6 小时窄口径**未改**。这是根因之一，但这轮不动：要判「同一类动作」得从中文里抽身体动作与句式，容易误伤，且属新模块。先看提示词改完实机还固不固化。
- 由头记账偏差（一条内容型思考被记成 affection）不在本轮范围。
- 其余测试文件未跑，属相关范围之外的相邻回归，未申报全应用结果。

**回退**：从本机专项备份的基线恢复 `lib/compose.js` 与该测试文件，正式重新加载；不删聊天、不改人格、不重置关系。
