import test from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_IMAGE_BODY_ROWS,
  NATIVE_IMAGE_BYTES_PER_TURN,
  NATIVE_IMAGE_PER_TURN,
  hasNativeImageMark,
  rewriteNativeImageMarks,
} from "../lib/native-vision.js";

const MARK = "［附图：";

const imageOf = (ids) => (id) => (ids.includes(id) ? { type: "image", mimeType: "image/png", data: id } : null);

test("没有记号的内容一个字都不动", () => {
  const out = rewriteNativeImageMarks("【2026年10月27日 21:00】\n在干嘛", {});
  assert.equal(out.hit, false);
  assert.equal(out.content, "【2026年10月27日 21:00】\n在干嘛");
  assert.equal(hasNativeImageMark("［附图：img_a］"), true);
  assert.equal(hasNativeImageMark("就是这行字"), false);
});

test("一条里有几个记号就兑几个，别只兑第一个", () => {
  // 她连发两张时那两句会合成一条消息，里面就有两个记号。
  // 只兑第一个的话，剩下那个会原样留给模型当字面文读，那张图等于没发。
  const content = "【2026年10月27日 21:00】\n［附图：img_aaa］\n还有这张\n［附图：img_bbb］";
  const budget = { left: NATIVE_IMAGE_PER_TURN };
  const out = rewriteNativeImageMarks(content, { imageOf: imageOf(["img_aaa", "img_bbb"]), budget });
  assert.equal(out.hit, true);
  assert.equal(out.images, 2);
  assert.ok(Array.isArray(out.content));
  const images = out.content.filter((part) => part.type === "image").map((part) => part.data);
  assert.deepEqual(images, ["img_aaa", "img_bbb"], "两张都要带上，顺序照原样");
  // 她当时说的话一个字都不能丢。
  assert.equal(out.content[0].text, "【2026年10月27日 21:00】");
  assert.equal(out.content[2].text, "还有这张");
});

test("超额的图退成描述，不静悄悄丢掉", () => {
  const content = ["img_1", "img_2", "img_3", "img_4"].map((id) => `［附图：${id}］`).join("");
  const budget = { left: 3 };
  const out = rewriteNativeImageMarks(content, {
    imageOf: imageOf(["img_1", "img_2", "img_3", "img_4"]),
    seenOf: (id) => `${id} 当时看到的东西`,
    budget,
  });
  assert.equal(out.images, 3, "一轮最多三张原图");
  assert.equal(budget.left, 0);
  const tail = out.content.at(-1);
  assert.equal(tail.type, "text");
  assert.match(tail.text, /img_4 当时看到的东西/u);
});

test("没给本体就用当时写下的描述顶上，别只剩一句「她发过一张图」", () => {
  // 这是「下一轮就忘了」那个坑：她追问「图上第二行写的啥」时，
  // 模型手上至少得有当初看下来的那段话。
  const out = rewriteNativeImageMarks(`她：［附图：img_a］`, {
    seenOf: () => "一张报错截图，红字是 ENOENT: no such file",
  });
  assert.equal(out.images, 0);
  assert.match(out.content, /ENOENT/u);
});

test("描述也没有时退到最笼统的那句，让它知道自己少看了一张", () => {
  const out = rewriteNativeImageMarks("［附图：img_a］", {});
  assert.equal(out.content, "［她发过一张图］");
});

test("全是文字时退回字符串，跟原来那条的形状一致", () => {
  const out = rewriteNativeImageMarks("［附图：img_a］", { seenOf: () => "一张猫" });
  assert.equal(typeof out.content, "string");
  assert.match(out.content, /一张猫/u);
});

test("本体和描述混在一起时按原顺序拼，不把话挤到后面", () => {
  const out = rewriteNativeImageMarks("先看这张［附图：img_a］，再看那张［附图：img_b］对吗", {
    imageOf: imageOf(["img_a"]),
    seenOf: () => "一张猫",
    budget: { left: 1 },
  });
  assert.equal(out.content[0].text, "先看这张");
  assert.equal(out.content[1].type, "image");
  const rest = out.content[2].text;
  assert.match(rest, /再看那张/u, "图前后的话都得在");
  assert.match(rest, /一张猫/u);
  assert.match(rest, /对吗/u);
});

test("带本体的最多往前两行 user：她的追问就在第二位", () => {
  assert.equal(NATIVE_IMAGE_BODY_ROWS, 2);
  assert.ok(NATIVE_IMAGE_PER_TURN >= 1);
  assert.ok(NATIVE_IMAGE_BYTES_PER_TURN <= 24 * 1024 * 1024, "一张图最大 13.3MB，总预算得给宿主的 32MB 留余地");
});

test("体积也管着：三张常规图都带得动", () => {
  const MB = 1024 * 1024;
  const data = "x".repeat(2 * MB);
  const content = ["a", "b", "c"].map((id) => `［附图：img_${id}］`).join("");
  const budget = { left: NATIVE_IMAGE_PER_TURN, bytesLeft: NATIVE_IMAGE_BYTES_PER_TURN };
  const out = rewriteNativeImageMarks(content, {
    imageOf: () => ({ type: "image", mimeType: "image/png", data }),
    seenOf: () => "一张截图",
    budget,
  });
  assert.equal(out.images, 3);
  assert.ok(budget.bytesLeft < NATIVE_IMAGE_BYTES_PER_TURN, "体积额度要真的扣");
});

test("第二张太大就退成描述，把额度留给装得下的", () => {
  const MB = 1024 * 1024;
  const sizes = { big: 10 * MB, mid: 8 * MB, small: 1 * MB };
  const content = ["big", "mid", "small"].map((id) => `［附图：img_${id}］`).join("");
  const out = rewriteNativeImageMarks(content, {
    imageOf: (id) => ({ type: "image", mimeType: "image/png", data: "x".repeat(sizes[id.slice(4)]) }),
    seenOf: (id) => `${id} 当时看到的东西`,
    budget: { left: 3, bytesLeft: NATIVE_IMAGE_BYTES_PER_TURN },
  });
  // 10MB 先占掉，只剩 2MB；8MB 装不下退描述，1MB 装得下。
  assert.equal(out.images, 2);
  const text = out.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /img_mid 当时看到的东西/u);
  assert.doesNotMatch(text, /img_small/u);
});

test("单张再大也带这一张：不然十兆的图永远看不见", () => {
  const data = "x".repeat(13 * 1024 * 1024);
  const out = rewriteNativeImageMarks("［附图：img_huge］", {
    imageOf: () => ({ type: "image", mimeType: "image/png", data }),
    seenOf: () => "一张大图",
    budget: { left: 3, bytesLeft: NATIVE_IMAGE_BYTES_PER_TURN },
  });
  assert.equal(out.images, 1);
});

test("预算跨行共用：两行加起来也不超", () => {
  const MB = 1024 * 1024;
  const budget = { left: 3, bytesLeft: NATIVE_IMAGE_BYTES_PER_TURN };
  const imageOf = () => ({ type: "image", mimeType: "image/png", data: "x".repeat(8 * MB) });
  const first = rewriteNativeImageMarks("［附图：img_a］", { imageOf, budget });
  const second = rewriteNativeImageMarks("［附图：img_b］", { imageOf, seenOf: () => "一张图", budget });
  assert.equal(first.images, 1);
  assert.equal(second.images, 0);
  assert.match(String(second.content), /一张图/u);
});
