/** 伙伴照片设置；候选、当前照和付费生成分开操作。 */
const TIERS = [["off", "关闭"], ["less", "少一些"], ["normal", "适中"], ["more", "多一些"]];
function node(tag, className = "", text = "") {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function button(text, action, className = "soft-button") {
  const el = node("button", className, text); el.type = "button"; el.addEventListener("click", action); return el;
}
export function mountPartnerImageSettings(host, { agentId, api, apiWith, fetchImage, saveTier, isCurrent, confirmCost = text => window.confirm(text) }) {
  let disposed = false, busy = false, data = null, selectedId = null, style = "";
  let generation = 0;
  let historyLimit = 8;
  const urls = new Set();
  const alive = () => !disposed && isCurrent();
  const encoded = encodeURIComponent(agentId);
  const tiers = node("div", "seg image-tier-options");
  const tierHint = node("small", "detail-field-note", "关闭／每天最多1张／2张／4张，本地时间零点更新；同时受全局总上限限制。图片生成成功后即记次数，等待期间新话使照片作废也会计入。");
  const usage = node("p", "detail-field-note", "正在读取照片设置…");
  const note = node("p", "detail-field-note image-operation-note"); note.setAttribute("role", "status");
  const preview = node("div", "reference-preview");
  const history = node("div", "reference-history");
  const description = node("textarea"); description.maxLength = 4000;
  description.placeholder = "不填会参考伙伴已有的外貌；调整时可以说：头发长一点、眼睛偏绿一些…";
  description.setAttribute("aria-label", "外貌描述或本次调整");
  const styles = node("div", "seg reference-style-options");
  const customStyle = node("input"); customStyle.type = "text"; customStyle.maxLength = 500;
  customStyle.placeholder = "想要的画风，比如清透的二次元水彩"; customStyle.hidden = true;
  customStyle.setAttribute("aria-label", "自定义画风");
  for (const [value, label] of [["", "跟随设定"], ["二次元插画", "二次元"], ["写实摄影", "写实"], ["custom", "自定义"]]) {
    const pick = button(label, () => {
      style = value; customStyle.hidden = value !== "custom";
      for (const child of styles.children) child.classList.toggle("on", child === pick);
    }, value === "" ? "on" : "");
    styles.append(pick);
  }
  const input = node("input"); input.type = "file"; input.accept = "image/png,image/jpeg,image/gif,image/webp"; input.hidden = true;
  const controls = node("div", "detail-actions reference-actions");
  const upload = button("上传参考照", () => input.click());
  const fresh = button("生成新参考照", () => generate(false));
  const adjust = button("按这张调整", () => generate(true));
  const choose = button("用这张作为参考", select, "primary-button");
  controls.append(upload, fresh, adjust, choose);
  const cost = node("p", "detail-field-note", "上传或生成的图片先留作候选，点「用这张作为参考」才会选定。每次生成与调整都会消耗 Hana 生图额度，需单独确认，不占聊天每日次数。");
  const heading = node("h4", "", "伙伴参考照");
  host.append(tiers, tierHint, usage, heading, preview, history, styles, customStyle, description, controls, input, cost, note);
  for (const [value, label] of TIERS) {
    const pick = button(label, async () => {
      if (busy || !alive()) return;
      setBusy(true); note.textContent = "正在保存…";
      try {
        if (await saveTier(value)) { await refresh(); if (alive()) note.textContent = "已保存"; }
        else if (alive()) note.textContent = "没能保存，原来的档位未变。";
      } catch (error) { if (alive()) note.textContent = error.message; }
      finally { if (alive()) setBusy(false); }
    });
    pick.dataset.tier = value; tiers.append(pick);
  }
  function setBusy(value) {
    busy = value;
    for (const el of [...controls.querySelectorAll("button"), ...tiers.querySelectorAll("button")]) el.disabled = value;
    if (!value) { adjust.disabled = !selectedId; choose.disabled = !selectedId || selectedId === data?.reference?.currentId; }
    fresh.textContent = value ? "请稍等…" : "生成新参考照";
  }
  function clearUrls() { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
  async function imageInto(img, id, version) {
    try {
      const response = await fetchImage(`image/reference/${encoded}/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error("图片没能读取");
      const blob = await response.blob();
      if (!alive() || generation !== version) return;
      const url = URL.createObjectURL(blob); urls.add(url); img.src = url;
    } catch { if (alive() && generation === version) img.alt = "参考照暂时没能读取"; }
  }
  function paint() {
    if (!alive()) return;
    const version = ++generation;
    clearUrls(); preview.replaceChildren(); history.replaceChildren();
    for (const child of tiers.children) { const on = child.dataset.tier === (data?.tier || "off"); child.classList.toggle("on", on); child.setAttribute("aria-pressed", String(on)); }
    const u = data?.usage;
    usage.textContent = data?.quotaError ? `${data.quotaError}。参考照仍可管理，聊天生图暂不执行，请联系维护处理。` : data?.globalTier === "off" ? "全局聊天生图已关闭，这位伙伴的档位仍会保留。" : `今天这位伙伴已出${u?.partnerUsed ?? 0}张，等待结果${u?.partnerPending ?? 0}张，上限${u?.partnerLimit ?? 0}张；全部伙伴已出${u?.globalUsed ?? 0}张，等待结果${u?.globalPending ?? 0}张，总上限${u?.globalLimit ?? 0}张。`;
    const rows = data?.reference?.history || [];
    if (!rows.some(row => row.id === selectedId)) selectedId = data?.reference?.currentId || rows[0]?.id || null;
    const selected = rows.find(row => row.id === selectedId);
    if (selected) {
      const image = node("img"); image.alt = "当前查看的参考照候选";
      preview.append(image, node("small", "detail-field-note", selectedId === data.reference.currentId ? "正在使用这张" : "候选，尚未选用"));
      void imageInto(image, selected.id, version);
    } else preview.append(node("p", "detail-field-note", "还没有参考照。没有参考照时，伙伴仍能拍物件和风景，不会生成自己的陌生脸。"));
    for (const row of rows.slice(0, historyLimit)) {
      const thumb = button("", () => { if (!busy) { selectedId = row.id; paint(); } }, `reference-thumb${row.id === selectedId ? " on" : ""}`);
      const image = node("img"); image.alt = row.id === data.reference.currentId ? "当前参考照" : "历史候选";
      thumb.setAttribute("aria-label", `${image.alt}，${row.source === "upload" ? "上传" : "生成"}`);
      thumb.append(image); history.append(thumb); void imageInto(image, row.id, version);
    }
    if (rows.length > historyLimit) history.append(button("查看更多候选", () => { if (!busy) { historyLimit += 8; paint(); } }));
    setBusy(busy);
  }
  async function refresh(next) {
    const result = next || await api("GET", `image/partner/${encoded}`);
    if (alive()) { data = result; paint(); }
  }
  async function operation(action, candidate = false) {
    if (busy || !alive()) return;
    setBusy(true); note.textContent = "正在处理，完成前不要重复点击…";
    try { const result = await action(); if (alive()) { if (candidate) selectedId = result?.reference?.history?.[0]?.id || selectedId; await refresh(result); note.textContent = "已保存，候选不会自动替换当前参考照。"; } }
    catch (error) { if (alive()) note.textContent = `没能完成：${error.message}。未自动重试。`; }
    finally { if (alive()) setBusy(false); }
  }
  async function generate(useBase) {
    if (busy || (useBase && !selectedId) || !alive()) return;
    if (!await confirmCost("这次生成会消耗 Hana 的生图额度，不占聊天每日次数。要继续吗？")) return;
    if (!alive()) return;
    await operation(() => apiWith("POST", `image/reference/${encoded}/generate`, { prompt: description.value.trim(), style: style === "custom" ? customStyle.value.trim() : style, ...(useBase ? { baseId: selectedId } : {}), confirm: true }, 340000), true);
  }
  async function select() {
    if (!selectedId) return;
    await operation(() => api("PUT", `image/reference/${encoded}`, { referenceId: selectedId }));
  }
  input.addEventListener("change", () => {
    const file = input.files?.[0]; input.value = "";
    if (!file || busy) return;
    if (file.size > 10 * 1024 * 1024) { note.textContent = "单张图片上限10MB。"; return; }
    void operation(async () => {
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(file); });
      return api("POST", `image/reference/${encoded}`, { image: { name: file.name, mimeType: file.type, data: dataUrl } });
    }, true);
  });
  setBusy(true);
  void refresh().catch(error => { if (alive()) note.textContent = `照片设置没读出来：${error.message}`; }).finally(() => { if (alive()) setBusy(false); });
  const dispose = () => { disposed = true; generation++; clearUrls(); window.removeEventListener("pagehide", dispose); };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
