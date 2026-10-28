import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const app = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");

/** 从 index.js 里抠出 purgeExpiredImages 的函数体：断言只该盯这一段。 */
function purgeBody() {
  const start = app.indexOf("function purgeExpiredImages(");
  assert.ok(start > 0, "清理函数得在");
  const end = app.indexOf("\n  /** 这一轮该由哪个聊天模型开口", start);
  assert.ok(end > start);
  return app.slice(start, end);
}

test("清理是纯本地活：不调任何模型、不分批、也不会跑过页面超时", () => {
  // 上一版会为了「删之前先留句话」在清理时补一次识图，一次清理能叫出几十次调用。
  // 那段描述本来就写在消息的 visionNote 上，补的那份只给翻旧图的工具看，不值这个钱。
  const body = purgeBody();
  assert.doesNotMatch(body, /describeImage/);
  assert.doesNotMatch(body, /chatModelRefOf/);
  assert.doesNotMatch(body, /await /, "纯同步删除，不该再有 await");
  // 路由也别再挂着长超时。
  assert.match(app, /app\.post\("\/images\/cleanup", \(c\) => \{/);
  assert.match(settings, /apiWith\("POST", "images\/cleanup", \{\}, 20000\)/);
});

test("孤儿要跟着一起清：没有消息认领的图不等到期", () => {
  assert.match(app, /planCleanup\(listAttachmentMetas\(\), \{ days, referencedIds: store\.referencedAttachmentIds\(\) \}, now\)/);
  assert.match(app, /orphanCount: plan\.orphanCount/);
  // 引用名单从聊天账里现数，不在附件元数据里另存一份（那份迟早会忘）。
  assert.match(app, /referencedAttachmentIds\(\)/);
});

test("两个文件成对处理：只删 .bin 会让占用报假，只删 .json 会留下永久孤儿", () => {
  assert.match(app, /function dropAttachmentBytes\(meta, now = new Date\(\)\.toISOString\(\)\)/);
  assert.match(app, /purgedAt: now/);
});

test("设置页把孤儿那一项说清楚，别混进「过期」", () => {
  assert.match(settings, /orphanCount \? `，其中 \$\{orphanCount\} 张已不在聊天记录里`/);
  assert.match(settings, /storage\.cleanupCount/);
  // 永久模式下不能说清得掉。
  assert.match(settings, /if \(storage\.keepsForever\) \{[\s\S]{0,120}?永久保留中/);
});
