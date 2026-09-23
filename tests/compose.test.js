import test from "node:test";
import assert from "node:assert/strict";

import { cleanVoice, inspectVoice, isAbstractOnlyProactive, isLowSignalProactive, isNoReply, looksLikeAdTail, nightSpec, proactiveSpec } from "../lib/compose.js";

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

test("夜间留言提示词也会带入相处理解", () => {
  const spec = nightSpec({
    partnerName: "小花",
    userName: "阿舟",
    adaptationText: "【你们相处出来的理解】\\n偏好：多分享一点自己的事",
  });
  assert.match(spec.userText, /多分享一点自己的事/);
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
    topic: { title: "像素小物" },
    sceneEcho: {
      userText: "我刚忙完，脑壳还有点昏",
      assistantText: "那你先缓一哈，别马上接着忙",
    },
  });
  assert.ok(spec.userText.includes("最近一轮聊天的背景"));
  assert.ok(spec.userText.includes("我刚忙完，脑壳还有点昏"));
  assert.ok(spec.userText.includes("普通闲聊、玩笑和已经收住的话题，默认直接说"));
  assert.doesNotMatch(spec.userText, /先用一小句接住上一轮情境/);
  assert.ok(spec.userText.includes("像素小物"));
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
  assert.match(spec.userText, /只能作为顺手想起的新联想/);
  assert.match(spec.userText, /我又想到一个好玩的/);
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
  assert.match(spec.userText, /你人嘞/);
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
  assert.doesNotMatch(spec.userText, /别再加码/, "只发过一条还谈不上加码");
});

test("看过很久了就放下这事，不再提她没回", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    followup: { count: 2, read: true, readAgeMs: 8 * 60 * 60 * 1000, previousText: "在忙不" },
  });
  assert.match(spec.userText, /可以放下了/);
  assert.match(spec.userText, /别再加码/);
  assert.doesNotMatch(spec.userText, /可以轻轻逗一句/);

  // 时间拿不准（老数据没有看过的时刻）也当「看很久了」处理，不编一个「刚看到」
  const unknown = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    followup: { count: 1, read: true, previousText: "在忙不" },
  });
  assert.match(unknown.userText, /可以放下了/);
});

test("主动消息没有共同话题时会带入伙伴自己的具体兴趣包", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    hobby: {
      name: "纸袋封口",
      object: "纸袋的封口方式",
      preference: "喜欢歪一点但不能散",
      ritual: "看到就比较两下",
      friction: "贴得太正像流水线",
      reason: "喜欢从小地方看出人的手感",
    },
    currentTimeText: "2026年9月16日，早上 7 点 16 分",
  });
  assert.match(spec.userText, /纸袋封口/);
  assert.match(spec.userText, /落点：纸袋的封口方式/);
  assert.match(spec.userText, /个人偏好：喜欢歪一点/);
  assert.match(spec.userText, /平时会做：看到就比较两下/);
  assert.match(spec.userText, /小别扭：贴得太正/);
  assert.match(spec.userText, /这些是你自己的落点/);
  assert.match(spec.userText, /属于你自己的兴趣/);
  assert.match(spec.userText, /2026年9月16日/);
  assert.match(spec.systemPrompt, /原生兴趣不是用户话题的回声/);
  assert.match(spec.systemPrompt, /不要凭空编造现实经历/);
  assert.match(spec.systemPrompt, /日常聊天里用‘我’指代自己/);
  assert.match(spec.systemPrompt, /别把自己的名字当第三人称反复自称/);
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

test("主动消息先确认来由链，不把话题当成采访题目", () => {
  const spec = proactiveSpec({
    partnerName: "小花",
    userName: "阿舟",
    topic: { title: "胶带搭配", anchor: "蓝灰色纸胶带配米白页", note: "她想聊手帐搭配", correction: "这条话题要归到手帐搭配" },
  });
  assert.match(spec.userText, /具体落点：蓝灰色纸胶带配米白页/);
  assert.match(spec.userText, /用户纠正：/);
  assert.match(spec.systemPrompt, /为什么让你想找她/);
  assert.match(spec.systemPrompt, /真实素材.*你自己的联想/);
  assert.match(spec.systemPrompt, /话题只是素材，不是要完成的题目/);
  assert.match(spec.systemPrompt, /具体可指认的对象、动作、款式、颜色、搭配、场景或选择/);
  assert.match(spec.systemPrompt, /具体细节不能单独撑起一条主动消息/);
  assert.match(spec.systemPrompt, /自己的感受、偏好、判断、玩笑或一点小别扭/);
  assert.match(spec.systemPrompt, /不等于每条都要提问/);
  assert.match(spec.systemPrompt, /具体到能想象，轻松到不用答/);
  assert.match(spec.systemPrompt, /直接从那件事本身说起/);
  assert.match(spec.systemPrompt, /万能问句开场/);
  assert.match(spec.systemPrompt, /不必每条都提问/);
  assert.match(spec.systemPrompt, /不必暗示她马上回复/);
  assert.match(spec.systemPrompt, /日常聊天里用‘我’指代自己/);
  assert.match(spec.systemPrompt, /不是每条消息的开场标签/);
  assert.match(spec.systemPrompt, /不要无缘无故用她的名字起句/);
  assert.match(spec.systemPrompt, /自然落地/);
  assert.match(spec.systemPrompt, /这道筛子在心里，不在嘴上/, "来处是心里的筛子，不是要说给她听的话");
  assert.match(spec.systemPrompt, /来处要像你本来就带着它/);
  assert.match(spec.systemPrompt, /也不必每条末尾都加一句邀请/);
  assert.doesNotMatch(spec.systemPrompt, /突然想到/, "提示词里不许再出现具体的前摇例句");
});

test("手打的图名是话，不是混进来的外文残片", () => {
  assert.equal(inspectVoice("无语.jpg").level, "pass");
  assert.equal(inspectVoice("无语jpg").level, "pass", "漏了个点也不该被当成乱码重试");
  assert.equal(inspectVoice("无语abc").level, "retry", "真外文残片还是要拦");
  assert.equal(cleanVoice("笑死\n装死.jpg"), "笑死\n装死.jpg", "洗的时候别把图名洗掉");
});
