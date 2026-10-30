/**
 * 设置页「手机接入」这一栏。
 *
 * 只做装配与展示：读状态、改开关/端口、看/重置密码、复制地址。
 * 真正的读写都在 App 自己的 /mobile/* 路由里（只有桌面本机这一页能调），
 * 这一页不猜网关在干什么，只把后端说的画出来。
 */

const REASON_TEXT = {
  disabled: "关着。",
  idle: "网关还没开始起。",
  starting: "正在起。",
  running: "在跑。",
  "no-runtime": "这台机器上找不到能跑网关的 node，起不来",
  "no-password": "密码还没落实，网关不肯启动；重置一次密码再开",
  "config-corrupt": "配置文件读不出来，已经先关掉了",
  "bad-port": "端口不对，网关没起",
};

function reasonText(status) {
  if (!status.enabled) return "现在关着，手机连不进来。";
  if (status.running) return "已开启，网关在跑。";
  // 开了却没在跑：把后端的原话摆出来，不把「存下来了」说成「已启动」
  const reason = String(status.reason ?? "");
  if (REASON_TEXT[reason]) return `已开启，但还没起来：${REASON_TEXT[reason]}（${reason}）`;
  if (/ACCESS_DENIED|EPERM|EACCES/iu.test(reason)) {
    return `已开启，但这边不允许网关进程监听端口，这台机器上起不来（${reason}）。`;
  }
  if (/^exit/iu.test(reason)) return `已开启，网关进程退出来了，正在重试（${reason}）。`;
  if (reason.startsWith("config-unsaved")) return "已开启，但配置没存下来，所以没有启动。先看看磁盘权限，再保存一次。";
  return `已开启，但还没跑起来（${reason || "未知"}）。`;
}

/** 剪贴板按可靠度一层层退：iframe 里 navigator 常年被拦，宿主那条最稳。 */
async function writeClipboard(hana, text) {
  const failures = [];
  try {
    if (hana?.clipboard?.writeText) {
      const result = await hana.clipboard.writeText(text);
      if (result?.written !== false) return "host";
      failures.push("host-not-written");
    }
  } catch (error) { failures.push(error?.code || "host-failed"); }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "navigator";
    }
  } catch (error) { failures.push(error?.name || "navigator-failed"); }
  try {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.top = "0";
    helper.style.left = "0";
    helper.style.width = "1px";
    helper.style.height = "1px";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.focus();
    helper.select();
    helper.setSelectionRange?.(0, helper.value.length);
    const copied = document.execCommand("copy");
    helper.remove();
    if (copied) return "exec";
    failures.push("exec-not-copied");
  } catch (error) { failures.push(error?.name || "exec-failed"); }
  throw new Error(failures.join(",") || "no-clipboard-path");
}

export function mountMobileSettings({ root, api, hana, say = () => {} } = {}) {
  if (!root) return { refresh: async () => null };
  const el = {
    toggle: root.querySelector("#mobile-switch"),
    toggleLabel: root.querySelector("#mobile-switch-label"),
    port: root.querySelector("#mobile-port"),
    save: root.querySelector("#mobile-save"),
    refresh: root.querySelector("#mobile-refresh"),
    status: root.querySelector("#mobile-status"),
    notice: root.querySelector("#mobile-notice"),
    addresses: root.querySelector("#mobile-addresses"),
    passwordShow: root.querySelector("#mobile-password-show"),
    passwordCopy: root.querySelector("#mobile-password-copy"),
    passwordReset: root.querySelector("#mobile-password-reset"),
    passwordNote: root.querySelector("#mobile-password-note"),
    password: root.querySelector("#mobile-password"),
  };

  let status = null;
  let busy = false;
  let resetArmedAt = 0;

  /**
   * 没有可信状态时一律禁用写入口。
   *
   * 不能把「没读到」当成「关着」：那样点一下开关就会盲发 enabled=true，
   * 也可能把本来开着的网关盲停。
   */
  function setWritable(allowed) {
    for (const node of [el.toggle, el.save, el.port, el.passwordReset]) {
      if (node) node.disabled = !allowed;
    }
  }

  function resetDisplay() {
    if (el.toggle) {
      el.toggle.classList.remove("on");
      el.toggle.setAttribute("aria-checked", "false");
    }
    if (el.toggleLabel) el.toggleLabel.textContent = "未知";
    if (el.notice) {
      el.notice.textContent = "";
      el.notice.hidden = true;
    }
    if (el.addresses) {
      el.addresses.textContent = "";
      const hint = document.createElement("p");
      hint.className = "mobile-address-empty";
      hint.textContent = "状态没读到，先点「刷新状态」再看。";
      el.addresses.append(hint);
    }
    if (el.password) el.password.textContent = "";
    renderPassword();
  }

  function renderStatus() {
    if (!el.status) return;
    if (!status) return;
    const parts = [];
    if (status.configFile?.status === "corrupt") {
      parts.push(`配置文件读不出来（${status.configFile.error}），已经先关掉了。改一下端口再保存，会按这份设置重写。`);
    } else {
      parts.push(reasonText(status));
    }
    if (status.enabled) parts.push(`端口 ${status.port}`);
    parts.push(status.hasPassword ? `密码 ${status.passwordLength} 位` : "还没设过密码");
    el.status.textContent = parts.join(" · ");
  }

  function renderAddresses() {
    if (!el.addresses) return;
    el.addresses.textContent = "";
    const rows = Array.isArray(status?.addresses) ? status.addresses : [];
    if (!status?.enabled) {
      const hint = document.createElement("p");
      hint.className = "mobile-address-empty";
      hint.textContent = "打开之后这里会列出手机能连的地址。";
      el.addresses.append(hint);
      return;
    }
    if (!rows.length) {
      const hint = document.createElement("p");
      hint.className = "mobile-address-empty";
      hint.textContent = "没找到局域网地址。先确认这台电脑连着 Wi-Fi 或者网线。";
      el.addresses.append(hint);
      return;
    }
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "mobile-address";
      const url = document.createElement("code");
      url.textContent = row.url;
      const where = document.createElement("span");
      where.className = "mobile-address-net";
      where.textContent = row.name || "";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "soft-button";
      copy.textContent = "复制地址";
      copy.addEventListener("click", () => { void copyText(row.url, "地址"); });
      line.append(url, where, copy);
      el.addresses.append(line);
    }
  }

  function renderPassword() {
    if (el.password) {
      el.password.hidden = !el.password.textContent;
    }
  }

  function render(next) {
    if (next) status = next;
    // 没拿到可信状态就什么都不画：宁可看着空，也不拿默认值冒充真状态
    if (!status) return;
    if (el.toggle) {
      el.toggle.classList.toggle("on", Boolean(status.enabled));
      el.toggle.setAttribute("aria-checked", String(Boolean(status.enabled)));
    }
    if (el.toggleLabel) el.toggleLabel.textContent = status.enabled ? "已开启" : "关闭";
    if (el.port && document.activeElement !== el.port) el.port.value = String(status.port);
    if (el.notice) {
      const notice = String(status.notice ?? "").trim();
      el.notice.textContent = notice;
      el.notice.hidden = !notice;
    }
    renderStatus();
    renderAddresses();
    renderPassword();
    setWritable(true);
  }

  async function copyText(text, what) {
    try {
      await writeClipboard(hana, text);
      say(`${what}复制好了`);
    } catch {
      say(`${what}没复制上，手动选一下文本吧`, "err");
    }
  }

  /** 读一次状态。成功回 true，失败回 false（同时把旧状态作废）。 */
  async function load() {
    try {
      const data = await api("GET", "/mobile/status");
      if (!data || data.ok === false) throw new Error(data?.error?.message || "宿主没回状态");
      render(data);
      return true;
    } catch (error) {
      // 读失败时旧状态已经不可信：清掉、禁用写入口、画回空样子，只把错误写进状态行
      status = null;
      setWritable(false);
      resetDisplay();
      if (el.status) el.status.textContent = `读不到手机接入的状态：${error.message}`;
      return false;
    }
  }

  async function saveConfig(body) {
    if (busy) return null;
    busy = true;
    try {
      const data = await api("POST", "/mobile/config", body);
      render(data);
      if (data.notice) say(data.notice, "err");
      return data;
    } catch (error) {
      // 失败时也要把最新的状态拿回来：没存下去的那次不能画成改好了
      await load();
      say(error.message, "err");
      return null;
    } finally {
      busy = false;
    }
  }

  function currentPort() {
    const value = String(el.port?.value ?? "").trim();
    if (!value) return undefined;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      say("端口得是 1-65535 之间的整数", "err");
      return null;
    }
    return port;
  }

  el.toggle?.addEventListener("click", async () => {
    // 没读到可信状态就不猜：先读一次，绝不让 Boolean(undefined) 冒充「关着」
    if (!status) { await load(); return; }
    const next = !status.enabled;
    const port = currentPort();
    if (port === null) { render(); return; }
    await saveConfig({ enabled: next, ...(port === undefined ? {} : { port }) });
  });

  el.save?.addEventListener("click", async () => {
    if (!status) { await load(); return; }
    const port = currentPort();
    if (port === null) return;
    await saveConfig({ enabled: Boolean(status.enabled), ...(port === undefined ? {} : { port }) });
  });

  el.refresh?.addEventListener("click", async () => {
    // 只有真读到了才说刷新好；失败不报成功
    if (await load()) say("状态刷新好了");
  });

  el.passwordShow?.addEventListener("click", async () => {
    try {
      const data = await api("POST", "/mobile/password", { action: "show" });
      render(data);
      if (el.password) el.password.textContent = data.password;
      if (el.passwordNote) el.passwordNote.textContent = "这是这台电脑上记着的密码，只在这一页显示。";
      renderPassword();
    } catch (error) {
      say(error.message, "err");
    }
  });

  el.passwordCopy?.addEventListener("click", async () => {
    try {
      const data = await api("POST", "/mobile/password", { action: "show" });
      render(data);
      if (el.passwordNote) el.passwordNote.textContent = "密码不显示也能直接复制。";
      await copyText(data.password, "密码");
    } catch (error) {
      say(error.message, "err");
    }
  });

  el.passwordReset?.addEventListener("click", async () => {
    // 没读到可信状态就不去动密码（尤其不能拿默认值去覆盖配置）
    if (!status) { await load(); return; }
    // 这一步会让所有手机重新解锁，所以要按两下：第一下调成确认态，五秒内再点才真重置。
    if (Date.now() - resetArmedAt > 5000) {
      resetArmedAt = Date.now();
      el.passwordReset.textContent = "再点一次：会让所有手机重新解锁";
      if (el.passwordNote) el.passwordNote.textContent = "重置会让所有手机重新解锁。确定的话，五秒内再点一次。";
      setTimeout(() => {
        if (Date.now() - resetArmedAt < 5000) return;
        el.passwordReset.textContent = "重置密码";
        if (el.passwordNote && el.passwordNote.textContent.includes("五秒内")) el.passwordNote.textContent = "";
      }, 5200);
      return;
    }
    resetArmedAt = 0;
    el.passwordReset.textContent = "重置密码";
    try {
      const data = await api("POST", "/mobile/password", { action: "reset" });
      render(data);
      if (el.password) el.password.textContent = data.password;
      if (el.passwordNote) {
        el.passwordNote.textContent = data.restarted
          ? "密码换好了，网关已经重起，之前解锁过的手机都要重新输入。"
          : "密码换好了，下次打开手机接入就用这个。";
      }
      renderPassword();
      say("密码换好了");
    } catch (error) {
      say(error.message, "err");
    }
  });

  // 挂上就先锁住写入口：第一次 load 成功才放开，失败就继续锁着
  setWritable(false);

  return {
    refresh: load,
    render,
    get status() { return status; },
  };
}
