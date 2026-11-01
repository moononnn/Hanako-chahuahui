// beautify-select · 手帐风自定义下拉组件（plugin-kit）
// 用法：
//   1. 页面引入 beautify-select.css（或服务端内联）
//   2. 页面引入本文件（或服务端内联）
//   3. 对每个原生 <select> 调用 beautifySelect(sel)
// 特性：
//   - 原生 select 只保留值和 change 事件（视觉隐藏），外部改 options/value 经 MutationObserver 自动同步面板
//   - 面板 absolute left/right 0，与触发栏等宽（根治原生下拉面板宽度错位）
//   - 展开时自动提升最近 .card / [data-dd-lift] 容器的层级（.dd-open-card），
//     防止面板溢出容器时被下层内容（开关等）穿模盖住
//   - 主题色全部走 CSS 变量：--card --ink --ink-soft --line --accent --accent-deep --accent-soft
(function () {
  "use strict";

  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function beautifySelect(sel) {
    if (!sel || sel.dataset.ddReady) return;
    sel.dataset.ddReady = "1";
    var wrap = document.createElement("div");
    wrap.className = "dd";
    if (sel.dataset.kind) wrap.dataset.kind = sel.dataset.kind;
    if (sel.dataset.agent) wrap.dataset.agent = sel.dataset.agent;
    var inline = sel.getAttribute("style");
    if (inline) { wrap.setAttribute("style", inline); sel.removeAttribute("style"); }
    sel.classList.add("dd-native");
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dd-trigger";
    trigger.innerHTML = '<span class="dd-label"></span>' +
      '<span class="dd-group-tag" hidden></span>' +
      '<svg class="dd-caret" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.25 5.25 7 9l3.75-3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    wrap.appendChild(trigger);

    var panel = document.createElement("div");
    panel.className = "dd-panel";
    wrap.appendChild(panel);

    var lifted = null;

    // 选中的那条：连同它属于哪个 optgroup 一起（分组用来标模型商）。
    function selectedEntry() {
      var i = sel.selectedIndex;
      if (i < 0) return null;
      var opt = sel.options[i];
      if (!opt) return null;
      var parent = opt.parentNode;
      var group = parent && parent.tagName === "OPTGROUP" ? parent : null;
      return { option: opt, group: group };
    }

    // 只刷新触发栏文字（选中变化后立即调用，避免关闭面板后显示旧值）
    function updateLabel() {
      var entry = selectedEntry();
      var label = entry ? entry.option.textContent : "";
      var labelEl = trigger.querySelector(".dd-label");
      if (labelEl) labelEl.textContent = label;
      // 分组下拉里光看模型名挑不出是哪家：把组名（模型商）挂在触发栏右边。
      var tagEl = trigger.querySelector(".dd-group-tag");
      if (tagEl) {
        var groupLabel = entry && entry.group ? (entry.group.label || "") : "";
        tagEl.textContent = groupLabel;
        if (groupLabel) tagEl.removeAttribute("hidden");
        else tagEl.setAttribute("hidden", "");
      }
      trigger.title = entry && entry.group
        ? label + "（" + (entry.group.label || "") + "）"
        : label;
    }

    function optionHtml(o, index) {
      var on = index === sel.selectedIndex;
      return '<div class="dd-opt' + (on ? " on" : "") + '" data-i="' + index + '">' +
        '<span class="dd-check">✓</span>' +
        '<span class="dd-opt-text">' + escapeText(o.textContent) + "</span></div>";
    }

    function renderPanel() {
      updateLabel();
      var html = "";
      // sel.options 是扁平的（optgroup 里的也算），这里的 index 和选项序号一一对应。
      var index = 0;
      for (var c = 0; c < sel.children.length; c++) {
        var node = sel.children[c];
        if (node.tagName === "OPTGROUP") {
          html += '<div class="dd-group-title" role="presentation">' + escapeText(node.label || "") + "</div>";
          for (var j = 0; j < node.children.length; j++) {
            html += optionHtml(node.children[j], index++);
          }
        } else if (node.tagName === "OPTION") {
          html += optionHtml(node, index++);
        }
      }
      panel.innerHTML = html;
      var cur = panel.querySelector(".dd-opt.on");
      if (cur) {
        var pt = cur.offsetTop;
        var ph = cur.offsetHeight;
        if (pt < panel.scrollTop) panel.scrollTop = pt;
        else if (pt + ph > panel.scrollTop + panel.clientHeight) panel.scrollTop = pt + ph - panel.clientHeight;
      }
    }

    // 面板溢出容器时，提升最近的 .card / [data-dd-lift] 容器层级，防止被下层内容穿模盖住
    function findLiftTarget() {
      var el = wrap.parentElement;
      while (el && el !== document.body) {
        if (el.classList && (el.classList.contains("card") || (el.getAttribute && el.getAttribute("data-dd-lift") !== null))) {
          return el;
        }
        el = el.parentElement;
      }
      return null;
    }
    function lift() {
      if (!lifted) lifted = findLiftTarget();
      if (lifted) lifted.classList.add("dd-open-card");
    }
    function unlift() {
      if (lifted) { lifted.classList.remove("dd-open-card"); lifted = null; }
    }

    function close() {
      wrap.classList.remove("open");
      updateLabel(); // 关闭时同步触发栏，防止选中后仍显示旧值（需再次打开才更新的 bug）
      unlift();
      // 面板收起时它占的那块高度瞬间没了，正在往下看的人会被弹回页首。
      // 页面把视口守卫挂到 window 上，没有就当没这回事。
      if (typeof window !== "undefined" && typeof window.holdViewport === "function") window.holdViewport();
    }
    function open() {
      renderPanel();
      var all = document.querySelectorAll(".dd.open");
      for (var i = 0; i < all.length; i++) {
        if (all[i] !== wrap && all[i]._ddClose) all[i]._ddClose();
      }
      wrap.classList.add("open");
      lift();
    }
    wrap._ddClose = close;
    wrap._ddRefresh = renderPanel; // 外部直接改 select.value 后调用，同步触发栏与面板

    trigger.addEventListener("click", function () {
      if (wrap.classList.contains("open")) close(); else open();
    });
    panel.addEventListener("click", function (e) {
      var opt = e.target && e.target.closest ? e.target.closest(".dd-opt") : null;
      if (!opt) return;
      sel.selectedIndex = Number(opt.dataset.i);
      close();
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    // 外部代码直接改 options/value（如动态塞模型列表）时自动同步面板
    var mo = new MutationObserver(function () {
      renderPanel();
      setTimeout(renderPanel, 0); // value 赋值紧随 innerHTML 时，下一轮事件循环再同步一次
    });
    mo.observe(sel, { childList: true, attributes: true, subtree: true });
    renderPanel();
  }

  if (typeof window !== "undefined") window.beautifySelect = beautifySelect;
  if (typeof globalThis !== "undefined") globalThis.beautifySelect = beautifySelect;
})();
