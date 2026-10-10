import test from "node:test";
import assert from "node:assert/strict";

import { cleanVoice, farewellSpec, hasOpenHook, inspectVoice, isAbstractOnlyProactive, isLowSignalProactive, isNoReply, LINKUP_DISCIPLINE, looksLikeAdTail, nightSpec, proactiveSpec, readFollowupStage, stirredSpec } from "../lib/compose.js";

test("渠道塞在末尾的广告尾巴剥掉，正常聊天里的加号不动", () => {
  // 实机撞到的那条：`+天天中彩票` 是外挂上去的
  assert.equal(
    cleanVoice("这种小细节比贴个“复古”标签有意思多了嘛+天天中彩票"),
    "这种小细节比贴个“复古”标签有意思多了嘛",
  );
  assert.equal(cleanVoice("晚安啦\n+彩票开奖了"), "晚安啦");
  assert.equal(cleanVoice("先这样嘛｜稳赚不亏"), "先这样嘛");
  // 正常用法一律不动
  assert.equal(cleanVoice("今天喝了奶茶+珍珠"), "今天喝了奶茶+珍珠");
  assert.equal(cleanVoice("1+1=2"), "1+1=2");
  assert.equal(cleanVoice("我把方案A+方案B都试了"), "我把方案A+方案B都试了");
  // 识别口子
  assert.equal(looksLikeAdTail("哈哈+天天中彩票"), true);
  assert.equal(looksLikeAdTail("哈哈+奶茶"), false);
  assert.equal(looksLikeAdTail("前面说完了"), false);
  // 第二种形态：句末标点后直接粘（实机撞到 `……不安全的地方。大发时时彩`）
  assert.equal(cleanVoice("我不会把你推到不安全的地方。大发时时彩"), "我不会把你推到不安全的地方。");
  assert.equal(cleanVoice("晚安啦。六合彩"), "晚安啦。");
  assert.equal(looksLikeAdTail("我不会把你推到不安全的地方。大发时时彩"), true);
  // 正常聊天里「句末标点 + 短句」一律不动
  assert.equal(cleanVoice("今天好累。想早点睡"), "今天好累。想早点睡");
  assert.equal(cleanVoice("行。明天见"), "行。明天见");
  assert.equal(cleanVoice("他说。我们走吧"), "他说。我们走吧");
});

test("到点待办：由头独立成块，手上别的种子让位，不许当尾巴捎带", () => {
  const seed = { motifId: "walk", motifName: "走路歇脚", hook: "偏给每一小段都留个能坐的地方", kind: "motif" };
  const plain = proactiveSpec({ partnerName: "小花", userName: "小林", personaText: "我是小花。", seed });
  const withTodo = proactiveSpec({
    partnerName: "小花",
    userName: "小林",
    personaText: "我是小花。",
    seed,
    todoNudge: "【你现在来找 ta 的原因】\n她今天这几件到了时间还没做：16:00 给薄荷浇水。",
  });
  assert.match(plain.userText, /这次你自己惦记着的那一面/, "没有到点的事时，种子照旧是内容来源");
  assert.doesNotMatch(withTodo.userText, /这次你自己惦记着的那一面/, "有到点的事在，就不再另找话题");
  assert.match(withTodo.userText, /你现在来找 ta 的原因/);
  assert.match(withTodo.userText, /专门为上面那件到点的事来的/);
  assert.match(withTodo.userText, /不要先聊别的再捎带一句/);
  assert.doesNotMatch(withTodo.userText, /顺口带一句/);
});

test("主动消息提示词会带入相处理解", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    adaptationText: "【你们相处出来的理解】\\n边界：认真说事时先接住情绪",
  });
  assert.match(spec.userText, /你们相处出来的理解/);
  assert.match(spec.userText, /认真说事时先接住情绪/);
});

test("主动开口得带上本人人格，不再是人设不同的伙伴共用一个路人腔", () => {
  const spec = proactiveSpec({
    partnerName: "阿岚",
    userName: "阿舟",
    personaText: "【人格】\n理性至上，陈述句下达指令，不废话",
  });
  assert.match(spec.systemPrompt, /理性至上/);
  assert.match(spec.systemPrompt, /下面这些说的是你自己（阿岚）/);
  assert.match(spec.systemPrompt, /不是别人/);

  // 已读未回那条路（模型最容易跟着示例抄的那条）也得带
  const read = proactiveSpec({
    partnerName: "阿岚",
    userName: "阿舟",
    personaText: "【人格】\n克制",
    followup: { count: 1, read: true, readAgeMs: 30 * 60 * 1000, previousText: "在忙不" },
  });
  assert.match(read.systemPrompt, /克制/);

  // 没给料就退回原来那份通用规矩，不硬编一段假人格
  const bare = proactiveSpec({ partnerName: "阿岚", userName: "阿舟" });
  assert.doesNotMatch(bare.systemPrompt, /下面这些说的是你自己/);
});

test("夜间留言提示词也会带入相处理解", () => {
  const spec = nightSpec({
    partnerName: "小花",
    userName: "阿舟",
    adaptationText: "【你们相处出来的理解】\\n偏好：多分享一点自己的事",
  });
  assert.match(spec.userText, /多分享一点自己的事/);
});

test("半夜留言也带本人人格", () => {
  const spec = nightSpec({
    partnerName: "阿岚",
    userName: "阿舟",
    personaText: "【人格】\n理性至上，不废话",
  });
  assert.match(spec.systemPrompt, /理性至上/);
  assert.match(spec.systemPrompt, /下面这些说的是你自己（阿岚）/);

  const bare = nightSpec({ partnerName: "阿岚", userName: "阿舟" });
  assert.doesNotMatch(bare.systemPrompt, /下面这些说的是你自己/);
});

test("睡醒回声优先于普通话题，并允许共享窗外情境作为背景", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    topic: null,
    wakeEcho: { sourceText: "我好困，再睡会" },
    contextText: "【共享窗外情境】\n窗外：大晴天（31°C）",
  });
  assert.ok(spec.userText.includes("睡醒后回来找她"));
  assert.ok(spec.userText.includes("大晴天（31°C）"));
  assert.ok(!spec.userText.includes("普通话题"), "睡醒回访时不应把普通话题抢到前面");
});

test("普通主动消息把最近场景当背景，不强制先承接", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    hobby: { id: "pixel", name: "像素小物", preference: "喜欢研究小机制" },
    discovery: { id: "learn-pixel", interestId: "pixel", interestName: "像素小物", focus: "角色转身动作的帧数变化" },
    sceneEcho: {
      userText: "我刚忙完，脑壳还有点昏",
      assistantText: "那你先缓一哈，别马上接着忙",
    },
  });
  assert.ok(spec.userText.includes("最近一轮聊天的背景"));
  assert.ok(spec.userText.includes("我刚忙完，脑壳还有点昏"));
  assert.ok(spec.userText.includes("普通闲聊、玩笑和已经收住的话题，默认直接说"));
  assert.doesNotMatch(spec.userText, /先用一小句接住上一轮情境/);
  assert.ok(spec.userText.includes("角色转身动作的帧数变化"));
});

test("睡醒回声存在时不再额外注入普通场景", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    topic: null,
    wakeEcho: { sourceText: "我好困，再睡会" },
    sceneEcho: { userText: "我刚忙完", assistantText: "先歇会儿" },
  });
  assert.ok(spec.userText.includes("睡醒后回来找她"));
  assert.ok(!spec.userText.includes("上一轮聊天刚停在一个具体情境里"));
});

test("[不回] 只有整条出现时才代表安静收尾", () => {
  assert.equal(isNoReply("[不回]"), true);
  assert.equal(isNoReply(" ［不回］ "), true);
  assert.equal(isNoReply("我先不回[不回]"), false);
  assert.equal(isNoReply(""), false);
});

test("清掉模型偶尔套上的外围 p 标签，但保留正文", () => {
  assert.equal(cleanVoice("<p>阿舟，咋啦</p>"), "阿舟，咋啦");
  assert.equal(cleanVoice("<p class=\"message\">阿舟，咋啦</p>"), "阿舟，咋啦");
  assert.equal(cleanVoice("<p>第一句</p><p>第二句</p>"), "第一句\n第二句");
});

test("清掉常见的回复外壳", () => {
  assert.equal(cleanVoice("```text\n阿舟，咋啦\n```"), "阿舟，咋啦");
  assert.equal(cleanVoice("assistant：阿舟，咋啦"), "阿舟，咋啦");
  assert.equal(cleanVoice('{\"text\":\"阿舟，咋啦\"}'), "阿舟，咋啦");
});

test("没有完整外围 p 标签时不误伤正文", () => {
  assert.equal(cleanVoice("今天看到 <3 了"), "今天看到 <3 了");
  assert.equal(cleanVoice("<p>只开没关"), "<p>只开没关");
});

test("模型把思考混进正文时，残片不能进聊天（实机复现）", () => {
  // 2026-09-15 实机：模型输出里跟了一串推理残片——标记字面、乱序括号碎片、自指碎句
  const dirty =
    "咋个嘛\n我都没有肚子了，还不准我云端涮鱼一哈嗦\n涮到最后我的服务器风扇都要开始冒油了嘛】【：】【“】【表情包：呆萌”像是一个表情包占位语法，不能直接回复这样的标记";
  assert.equal(
    cleanVoice(dirty),
    "咋个嘛\n我都没有肚子了，还不准我云端涮鱼一哈嗦\n涮到最后我的服务器风扇都要开始冒油了嘛",
  );
});

test("自指碎句按标点边界删，不吞掉前面正经的话", () => {
  assert.equal(
    cleanVoice("今天想去吃串串。像是一个表情包占位语法，不能直接回复这样的标记。"),
    "今天想去吃串串。",
  );
});

test("首尾孤立的括号引号碎片切掉，正常的引号收尾不动", () => {
  assert.equal(cleanVoice("我先走了】」「\""), "我先走了");
  assert.equal(cleanVoice("他说「好」"), "他说「好」");
});

test("中文正文末尾紧贴的西里尔异常尾词切掉，但保留正常外文", () => {
  assert.equal(
    cleanVoice("想把这个念头放你这儿авита"),
    "想把这个念头放你这儿",
  );
  assert.equal(cleanVoice("今天想学 Russian"), "今天想学 Russian");
  assert.equal(cleanVoice("我会说 привет мир"), "我会说 привет мир");
});

test("出口可信度分三档：异常清理、可疑重试、正常放行", () => {
  assert.deepEqual(inspectVoice("想把这个念头放你这儿авита"), {
    level: "clean",
    reason: "attached-cyrillic-tail",
  });
  assert.equal(inspectVoice("今天更新了PluginX").level, "retry");
  assert.equal(inspectVoice("今天想学 Russian").level, "pass");
  assert.equal(inspectVoice("今天\u0007有点卡").level, "clean");
});

test("夜间主动消息也只接收当前时间事实，不把深夜写死成当前时间", () => {
  const spec = nightSpec({
    partnerName: "小花",
    userName: "阿舟",
    currentTimeText: "2026年9月16日，早上 7 点 16 分",
  });
  assert.match(spec.userText, /早上 7 点 16 分/);
  assert.match(spec.systemPrompt, /具体是什么时间，以后面提供的时间事实为准/);
  assert.match(spec.systemPrompt, /名字不是每条留言的开场标签/);
  assert.doesNotMatch(spec.userText, /现在是深夜/);
});

test("夜间留言也带入用户对话题来源的纠正", () => {
  const spec = nightSpec({
    partnerName: "小花",
    userName: "阿舟",
    worry: "剑鞘细节",
    correction: "属于《黑神话：钟馗》，不是《黑神话：悟空》",
  });
  assert.match(spec.userText, /属于《黑神话：钟馗》/);
});

test("上一条主动消息没回应时，提示词优先轻轻确认而不是继续播题", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    topic: { title: "茶话会", note: "主动联系" },
    followup: {
      count: 1,
      previousText: "我又想到一个好玩的",
      previousTopic: { title: "茶话会", note: "主动联系" },
    },
  });
  assert.match(spec.userText, /还没有接住/);
  assert.match(spec.userText, /轻轻确认/);
  assert.match(spec.userText, /旧话题不作为这次主动内容来源/);
  assert.match(spec.userText, /我又想到一个好玩的/);
  assert.doesNotMatch(spec.userText, /茶话会.*主动联系/);
});

test("连续没回应两次后，提示词不再反复追问", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    followup: { count: 2, previousText: "你忙你的哈" },
  });
  assert.match(spec.userText, /别反复追问/);
  assert.match(spec.userText, /留空间/);
});

test("已读未回时给一库手法，打趣优先，不端新话题", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    topic: { title: "胶带搭配", anchor: "蓝灰胶带配米白页" },
    hobby: { name: "极简手帐" },
    followup: { count: 3, read: true, readAgeMs: 60 * 60 * 1000, previousText: "你咋不理我嘛" },
  });
  assert.match(spec.userText, /看到你上一条主动消息了/);
  assert.match(spec.userText, /打趣比委屈好/);
  assert.match(spec.userText, /戳一下/);
  assert.match(spec.userText, /不许照抄/, "手法示例得写明不是台词");
  assert.doesNotMatch(spec.userText, /你人嘞|溜哪儿去了嘛/, "示例里的现成句子不能给，模型会原样抄下去");
  assert.match(spec.userText, /无语\.jpg/, "图库没合适的就手打一个图名");
  assert.match(spec.userText, /是不是讨厌我/, "红线要写明不许把沉默当成拒绝");
  assert.match(spec.userText, /不追问她为什么不回/);
  assert.match(spec.userText, /不要继续展开共同话题或兴趣/);
  assert.doesNotMatch(spec.userText, /具体落点：蓝灰胶带配米白页/);
});

test("才看过没多久不催：这一轮别提「你没回」", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    followup: { count: 1, read: true, readAgeMs: 5 * 60 * 1000, previousText: "在忙不" },
  });
  assert.match(spec.userText, /才看过没多久/);
  assert.match(spec.userText, /不要追问/);
  assert.match(spec.userText, /先不发/);
  assert.doesNotMatch(spec.userText, /可以轻轻逗一句/, "刚看到就别急着凑上去");
  assert.doesNotMatch(spec.userText, /打趣找人|拿自己开涮|嘴硬收场/, "刚看到就别摆一库找人手法");
  assert.doesNotMatch(spec.userText, /别再加码/, "只发过一条还谈不上加码");
});

test("已读未回三个窗口共用一份口径：姿态、菜单、收口不能互相打架", () => {
  assert.equal(readFollowupStage(5 * 60 * 1000), "just-now");
  assert.equal(readFollowupStage(60 * 60 * 1000), "a-while");
  assert.equal(readFollowupStage(8 * 3600 * 1000), "stale");
  assert.equal(readFollowupStage(null), "stale", "时间拿不准当看很久，不编一个刚看到");
  assert.equal(readFollowupStage(undefined), "stale");

  const stale = proactiveSpec({
    partnerName: "阿叙",
    userName: "阿舟",
    personaText: "克制，指令用陈述句",
    followup: { count: 1, read: true, readAgeMs: 43 * 3600 * 1000, previousText: "开罐那事" },
  });
  assert.match(stale.userText, /可以放下了/);
  assert.match(stale.userText, /不要把「她没回」当由头/, "收口得跟姿态同调");
  assert.doesNotMatch(stale.userText, /先把「她看了还没回」这件事接住/, "说了放下就别再让她接这事");
  assert.doesNotMatch(stale.userText, /打趣找人|拿自己开涮|嘴硬收场/);

  const justNow = proactiveSpec({
    partnerName: "阿叙",
    userName: "阿舟",
    followup: { count: 1, read: true, readAgeMs: 5 * 60 * 1000, previousText: "在忙不" },
  });
  assert.match(justNow.userText, /不要暗示你在等她回/);
  assert.doesNotMatch(justNow.userText, /打趣找人|拿自己开涮|嘴硬收场/);

  const aWhile = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    followup: { count: 3, read: true, readAgeMs: 60 * 60 * 1000, previousText: "你咋不理我嘛" },
  });
  assert.match(aWhile.userText, /先把「她看了还没回」这件事接住/, "看过一阵才是该接这层关系的窗口");
  assert.match(aWhile.userText, /打趣找人/);
});

test("看过很久了就放下这事，不再提她没回", () => {  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    followup: { count: 2, read: true, readAgeMs: 8 * 60 * 60 * 1000, previousText: "在忙不" },
  });
  assert.match(spec.userText, /可以放下了/);
  assert.match(spec.userText, /别再加码/);
  assert.doesNotMatch(spec.userText, /可以轻轻逗一句/);
  assert.doesNotMatch(spec.userText, /打趣找人|拿自己开涮|嘴硬收场/, "说了放下就别再把催场手法递过去");

  // 时间拿不准（老数据没有看过的时刻）也当「看很久了」处理，不编一个「刚看到」
  const unknown = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    followup: { count: 1, read: true, previousText: "在忙不" },
  });
  assert.match(unknown.userText, /可以放下了/);
});

test("她翻回来的题要优先接，不能只当背景参考", () => {
  assert.equal(hasOpenHook("四川那边是不是看不起鸳鸯锅？"), true);
  assert.equal(hasOpenHook("今天天气咋样"), true);
  assert.equal(hasOpenHook("我困了"), false, "顺口话不该当成待接的题");

  const base = {
    partnerName: "小花",
    userName: "阿舟",
    hobby: { id: "h1", name: "火锅流派" },
    seed: { id: "s1", motifId: "h1", motifName: "火锅流派", kind: "exchange", hook: "蘸料台先舀什么", angle: "我永远是蒜泥打底" },
    currentTimeText: "2026年10月4日，晚上 8 点",
  };
  const asked = proactiveSpec({
    ...base,
    sceneEcho: { userText: "四川那边是不是看不起鸳鸯锅？", assistantText: "鸳鸯锅本质上就是让一桌人都能留下来嘛" },
  });
  assert.match(asked.userText, /她上一轮问了你一件具体的事/);
  assert.match(asked.userText, /优先于你手上那条面/);

  const chat = proactiveSpec({
    ...base,
    sceneEcho: { userText: "我今天把那个按钮改完了", assistantText: "厉害呀" },
  });
  assert.match(chat.userText, /不代表这次必须承接/);
  assert.doesNotMatch(chat.userText, /优先于你手上那条面/);
});

test("有新探索发现时才从长期兴趣生成内容话题，静态兴趣本身不会被直接复述", () => {
  const hobby = {
    id: "paper-bag",
    name: "纸袋封口",
    object: "纸袋的封口方式",
    preference: "喜欢歪一点但不能散",
    ritual: "看到就比较两下",
    friction: "贴得太正像流水线",
    reason: "喜欢从小地方看出人的手感",
  };
  const empty = proactiveSpec({ partnerName: "小花", userName: "阿舟", hobby });
  assert.doesNotMatch(empty.userText, /纸袋封口/);
  assert.match(empty.userText, /没有可用的种子或新发现/);

  // 主力那条路：从母题长出来的种子，要连她自己站得进去的那一面一起递过去
  const withSeed = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    hobby: { ...hobby, layer: "motif" },
    seed: { id: "seed-1", motifId: hobby.id, motifName: "火锅流派", kind: "stand", hook: "清油锅和牛油锅到底差在哪", angle: "我认死牛油，但说不过清油派" },
    currentTimeText: "2026年10月4日，傍晚 6 点 12 分",
  });
  assert.match(withSeed.userText, /这一面：清油锅和牛油锅到底差在哪/);
  assert.match(withSeed.userText, /你自己的角度：我认死牛油/);
  assert.match(withSeed.userText, /立场摆出来/);
  assert.doesNotMatch(withSeed.userText, /没有可用的种子或新发现/);
  assert.match(withSeed.systemPrompt, /允许轻分享/);

  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    hobby,
    discovery: { id: "learn-1", interestId: hobby.id, interestName: hobby.name, focus: "不同纸袋封口方式的由来" },
    searchContext: "· 文章标题：介绍了两种常见封口方法",
    currentTimeText: "2026年9月16日，早上 7 点 16 分",
  });
  assert.match(spec.userText, /长期兴趣：纸袋封口/);
  assert.match(spec.userText, /不同纸袋封口方式的由来/);
  assert.match(spec.userText, /只作临时线索/);
  assert.match(spec.userText, /文章标题/);
  assert.match(spec.systemPrompt, /原生兴趣不是用户话题的回声/);
  assert.match(spec.systemPrompt, /不要凭空编造现实经历/);
  assert.match(spec.systemPrompt, /一小点有依据的内容/);
  assert.match(spec.systemPrompt, /不套固定开场句/);
  assert.doesNotMatch(spec.systemPrompt, /闺闺，我刚看到/);
});

test("主动消息会拦掉明显的空心问候，但放行带具体内容的短句", () => {
  assert.equal(isLowSignalProactive("你最近怎么样？"), true);
  assert.equal(isLowSignalProactive("突然想找你聊聊天"), true);
  assert.equal(isLowSignalProactive("我刚看到那个维修口令，觉得还可以再短一点"), false);
  assert.equal(isLowSignalProactive("我突然想到一个问题"), false);
});

test("有具体落点的话题不接受只讲抽象感受的生成结果", () => {
  const topic = { title: "胶带搭配", anchor: "蓝灰色纸胶带配米白页" };
  assert.equal(isAbstractOnlyProactive("极简手帐的留白更有重量", { topic }), true);
  assert.equal(isAbstractOnlyProactive("蓝灰色纸胶带配米白页，再压一枚红色小印章会不会刚好", { topic }), false);
  assert.equal(isAbstractOnlyProactive("我刚想到一个具体搭配", { topic }), false);
});

test("主动分享要求兴趣根源、新发现和松弛表达，不固定套示例句式", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    hobby: { id: "game", name: "游戏动作" },
    discovery: { id: "learn-2", interestId: "game", interestName: "游戏动作", focus: "角色收刀动作的地区差异" },
  });
  assert.match(spec.userText, /角色收刀动作的地区差异/);
  assert.match(spec.systemPrompt, /为什么让你想找她/);
  assert.match(spec.systemPrompt, /真实素材.*你自己的联想/);
  assert.match(spec.systemPrompt, /有具体内容的主动话题必须扎根于自己长期保留的兴趣/);
  assert.match(spec.systemPrompt, /只把兴趣名称、偏好或熟悉的小细节换种说法，不算新话题/);
  assert.match(spec.systemPrompt, /轻松闲聊，有一搭没一搭/);
  assert.match(spec.systemPrompt, /不套固定开场句/);
  assert.match(spec.systemPrompt, /一小点有依据的内容/);
  assert.match(spec.systemPrompt, /不等于每条都要提问/);
  assert.match(spec.systemPrompt, /万能问句开场/);
  assert.match(spec.systemPrompt, /不必暗示她马上回复/);
  assert.match(spec.systemPrompt, /日常聊天里用‘我’指代自己/);
  assert.match(spec.systemPrompt, /不用播报素材来源.*理解这句话所需的场景/);
  assert.doesNotMatch(spec.systemPrompt, /闺闺，我刚刷到|蓝灰色纸胶带贴在米白页/);
});

test("手打的图名是话，不是混进来的外文残片", () => {
  assert.equal(inspectVoice("无语.jpg").level, "pass");
  assert.equal(inspectVoice("无语jpg").level, "pass", "漏了个点也不该被当成乱码重试");
  assert.equal(inspectVoice("无语abc").level, "retry", "真外文残片还是要拦");
  assert.equal(cleanVoice("笑死\n装死.jpg"), "笑死\n装死.jpg", "洗的时候别把图名洗掉");
});

// ── 晨间第一句 / 两边同一个伙伴 / 睡前收尾（2026-10-05）────────────

test("今天第一句可以没由头，招呼不必先端出话题", () => {
  const plain = proactiveSpec({ partnerName: "小花", userName: "小林", personaText: "我是小花。" });
  assert.match(plain.userText, /不要临时抽旧兴趣或共同话题凑一条内容消息/, "平时仍不硬凑内容");
  assert.doesNotMatch(plain.userText, /这是你今天第一次开口/);
  const first = proactiveSpec({ partnerName: "小花", userName: "小林", personaText: "我是小花。", firstOfDay: true });
  assert.match(first.userText, /这是你今天第一次开口/);
  assert.match(first.userText, /打个招呼/);
  assert.doesNotMatch(first.userText, /不要临时抽旧兴趣或共同话题凑一条内容消息/, "第一句不该又被那道筛子拦住");
  assert.match(first.systemPrompt, /按每条的时间、来源会话和说话人理解/, "第一句也要保留工作背景来路");
});

test("电脑那边的近况自然参与闲聊，但不硬认作刚刚亲历", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "小林",
    personaText: "我是小花。",
    workfeedText: "【电脑那边最近发生的事】\n小林：先把窗口修好",
    firstOfDay: true,
  });
  assert.match(spec.userText, /电脑那边（Hana）最近的工作对话/);
  assert.match(spec.systemPrompt, /不默认它发生在当前茶话会/);
  assert.match(spec.systemPrompt, /那边就是空的/);
  assert.equal(LINKUP_DISCIPLINE.includes("按每条的时间"), true);
  const withoutFeed = proactiveSpec({ partnerName: "小花", userName: "小林", personaText: "我是小花。" });
  assert.doesNotMatch(withoutFeed.systemPrompt, /那边就是空的/, "没有近况就不提这茬");
});

test("睡前收尾允许没由头，并且分得清她还在忙还是已经收工", () => {
  const done = farewellSpec({ partnerName: "小花", userName: "小林", personaText: "我是小花。", busy: false, sleepStart: "23:30", currentTimeText: "晚上 11 点 15 分" });
  assert.match(done.systemPrompt, /去睡了本身就是理由/);
  assert.match(done.userText, /最近没有新的已核实对话/);
  assert.match(done.userText, /不据此断言她已经收工/);
  assert.match(done.userText, /你自己的睡点是 23:30 前后/);
  assert.match(done.systemPrompt, /我是小花/, "睡前那条也是 ta 本人在说，得带人格");
  const busy = farewellSpec({ partnerName: "小花", userName: "小林", busy: true, sleepStart: "23:30" });
  assert.match(busy.userText, /已核实的对话动静/);
  assert.match(busy.systemPrompt, /不是安心去睡的时候/);
});

test("晚安之后又被薅起来：基调是生气，不是又温柔地陪聊", () => {
  const spec = stirredSpec({ partnerName: "小花", userName: "小林", personaText: "我是小花。", sleepStart: "23:30", workfeedText: "【电脑那边最近发生的事】\n小林：又开了一个会话" });
  assert.match(spec.systemPrompt, /不高兴/);
  assert.match(spec.systemPrompt, /不许说「我看到你又在忙」/);
  assert.match(spec.systemPrompt, /我是小花/);
  assert.match(spec.userText, /又被她拉到电脑那头干活/);
  assert.doesNotMatch(spec.userText, /去睡了本身就是理由/, "这条不是入睡道别");
});
