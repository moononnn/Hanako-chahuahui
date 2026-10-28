import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { catalogRowSupportsImage } from "../lib/model.js";
import { threadToMessages } from "../lib/prompt.js";
import { rewriteNativeImageMarks } from "../lib/native-vision.js";

const app = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");

test("查一个模型收不收图：按引用在目录里找，找不到就当不收", () => {
  const catalog = {
    models: [
      { provider: "deepseek", model: "deepseek-flash", input: ["text", "image"] },
      { provider: "deepseek", model: "deepseek-v4-pro", input: ["text"] },
    ],
  };
  assert.equal(catalogRowSupportsImage(catalog, { provider: "deepseek", model: "deepseek-flash" }), true);
  assert.equal(catalogRowSupportsImage(catalog, { provider: "deepseek", model: "deepseek-v4-pro" }), false);
  assert.equal(catalogRowSupportsImage(catalog, { provider: "nope", model: "x" }), false);
  assert.equal(catalogRowSupportsImage(catalog, null), false);
  assert.equal(catalogRowSupportsImage(null, { provider: "deepseek", model: "deepseek-flash" }), false);
});

test("原生看的图在上下文里只留记号，不再写成一段图片说明", () => {
  const messages = threadToMessages([
    { role: "user", at: "2026-10-27T21:00:00", text: "你看这个", attachment: { id: "img_a", nativeVision: true } },
  ], 10, { userName: "阿满" });
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /［附图：img_a］/u);
  assert.doesNotMatch(messages[0].content, /图片说明/u);
});

test("走转述的那张还是老样子，写图片说明", () => {
  const messages = threadToMessages([
    { role: "user", at: "2026-10-27T21:00:00", text: "你看这个", attachment: { id: "img_b" }, visionNote: "一段报错堆栈" },
  ], 10, { userName: "阿满" });
  assert.match(messages[0].content, /［图片说明：一段报错堆栈］/u);
  assert.doesNotMatch(messages[0].content, /附图/u);
});

test("这一轮不重发本体时，就算 imageOf 传成 null 也不能炸", () => {
  const done = rewriteNativeImageMarks("你看这张［附图：img_old］", {
    imageOf: null,
    seenOf: () => "白底黑字的三项安全限制",
  });
  assert.equal(done.hit, true);
  assert.equal(done.images, 0);
  assert.match(String(done.content), /白底黑字的三项安全限制/);
});

test("收图这条路先问聊天模型收不收图，能收就直给、不用识图模型转述", () => {
  assert.match(app, /async function chatModelSeesImages\(agentId\)/);
  assert.match(app, /const nativeVision = attachment\.mimeType !== "image\/gif" && await chatModelSeesImages\(agentId\)/);
  assert.match(app, /else if \(nativeVision\) \{[\s\S]{0,200}?attachment\.nativeVision = true;/, "能看的就直接标成原生看");
  // 描述不能因为走了原生就永远不写：不写的话，三十天后清图时这张一个字都没留下。
  assert.match(app, /function backfillDescriptionLater\(agentId, attachmentId, said\)/);
  assert.match(app, /backfillDescriptionLater\(agentId, attachment\.id, text\)/);
});

test("原生看图把图片本体真的塞进请求，一条里有几个就兑几个", () => {
  assert.match(app, /function attachNativeImage\(messages, agentId\)/);
  // 逐个兑付，而不是一条只认第一个记号：她连发两张时只兑第一个，第二张就成了字面文。
  assert.match(app, /const done = rewriteNativeImageMarks\(row\.content, \{ imageOf, seenOf, budget \}\)/);
  assert.match(app, /hasNativeImageMark\(row\.content\)/);
  assert.match(app, /\{ type: "image", mimeType: stored\.mimeType, data: stored\.data\.toString\("base64"\) \}/);
  // 没带本体的那些得拿当时写下的描述顶上，不然下一轮她追问图里写了什么就没东西。
  assert.match(app, /readAttachmentMeta\(id\)\?\.description/);
  // 两条路线都要塞：正常回复和 ta 主动开口。
  assert.match(app, /attachNativeImage\(messages, agentId\)/);
  assert.match(app, /attachNativeImage\(historyMessages, agentId\)/);
});

test("图片按钮不再只认识图模型：自己的模型能看图也算数", () => {
  assert.match(app, /allowed: Boolean\(\(vision\.model && vision\.status === "verified"\) \|\| nativeVisionIds\.has\(row\.id\)\)/);
  assert.match(app, /native: nativeVisionIds\.has\(row\.id\)/);
  assert.match(panel, /partner\?\.imageCapability\?\.native \? "发送图片（ta 自己的模型就能看）"/);
});
