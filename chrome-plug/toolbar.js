(() => {
  const API = "http://localhost:8000";
  const TOOLBAR_ID = "wemedia-toolbar";
  if (document.getElementById(TOOLBAR_ID)) return;

  let topicTree = [];

  // ── Load topics ─────────────────────────────────────────────────────────────

  async function loadTopics() {
    try {
      const res = await fetch(`${API}/api/content-topics`);
      if (!res.ok) throw new Error(res.status);
      topicTree = await res.json();
    } catch (e) {
      console.warn("[WeMedia] 主题加载失败:", e);
      topicTree = [];
    }
  }

  function isStatusPage() {
    return /x\.com\/.+\/status\//.test(location.href);
  }

  function detectPlatform(url) {
    if (!url) return "manual";
    if (/x\.com|twitter\.com/.test(url)) return "x";
    if (/github\.com/.test(url)) return "github";
    if (/mp\.weixin\.qq\.com/.test(url)) return "wechat";
    return "manual";
  }

  // ── Custom topic picker ──────────────────────────────────────────────────────
  // Returns { el, getValue } — el is the DOM node to insert, getValue() returns selected id or ""

  function createTopicPicker(placeholder = "不关联主题") {
    let selectedId = "";
    let selectedLabel = "";
    let open = false;

    const wrap = document.createElement("div");
    wrap.className = "wm-picker";

    const trigger = document.createElement("div");
    trigger.className = "wm-picker-trigger";
    trigger.innerHTML = `<span class="wm-picker-label">${placeholder}</span><span class="wm-picker-arrow">▾</span>`;

    const dropdown = document.createElement("div");
    dropdown.className = "wm-picker-dropdown";

    wrap.appendChild(trigger);
    wrap.appendChild(dropdown);

    function renderDropdown() {
      dropdown.innerHTML = "";

      // "不关联主题" option
      const none = document.createElement("div");
      none.className = "wm-picker-item" + (selectedId === "" ? " selected" : "");
      none.dataset.id = "";
      none.textContent = placeholder;
      none.addEventListener("click", () => select("", placeholder));
      dropdown.appendChild(none);

      function renderNodes(nodes, depth) {
        for (const t of nodes) {
          const item = document.createElement("div");
          item.className = "wm-picker-item depth-" + depth + (selectedId === String(t.id) ? " selected" : "");
          item.dataset.id = t.id;

          const indent = document.createElement("span");
          indent.className = "wm-picker-indent";
          if (depth === 1) indent.textContent = "└ ";
          if (depth === 2) indent.textContent = "└ ";

          const icon = document.createElement("span");
          icon.className = "wm-picker-icon";
          icon.textContent = depth === 0 ? "📁 " : "";

          const label = document.createElement("span");
          label.textContent = t.title;

          item.appendChild(indent);
          item.appendChild(icon);
          item.appendChild(label);
          item.addEventListener("click", () => select(String(t.id), t.title));
          dropdown.appendChild(item);

          if (t.children?.length) renderNodes(t.children, depth + 1);
        }
      }

      renderNodes(topicTree, 0);
    }

    function select(id, label) {
      selectedId = id;
      selectedLabel = label;
      trigger.querySelector(".wm-picker-label").textContent = label || placeholder;
      trigger.classList.toggle("has-value", !!id);
      closeDropdown();
    }

    function openDropdown() {
      renderDropdown();
      open = true;
      dropdown.style.display = "block";
      trigger.classList.add("open");
      // close on outside click
      setTimeout(() => document.addEventListener("click", outsideClick), 0);
    }

    function closeDropdown() {
      open = false;
      dropdown.style.display = "none";
      trigger.classList.remove("open");
      document.removeEventListener("click", outsideClick);
    }

    function outsideClick(e) {
      if (!wrap.contains(e.target)) closeDropdown();
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      open ? closeDropdown() : openDropdown();
    });

    return {
      el: wrap,
      getValue: () => selectedId,
      reset: () => select("", placeholder),
      refresh: () => { if (open) renderDropdown(); },
    };
  }

  // ── CSS ──────────────────────────────────────────────────────────────────────

  const style = document.createElement("style");
  style.textContent = `
    #wemedia-toolbar {
      position: fixed; right: 0; top: 50%; transform: translateY(-50%);
      z-index: 999999; display: flex; flex-direction: row; align-items: flex-start;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #wemedia-toolbar .wm-panel {
      width: 290px; background: #15202b; border: 1px solid #38444d;
      border-right: none; border-radius: 12px 0 0 12px;
      box-shadow: -4px 0 24px rgba(0,0,0,.4); overflow: visible; display: none;
    }
    #wemedia-toolbar .wm-panel.open { display: block; }

    .wm-panel-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #1e2d3d; border-bottom: 1px solid #38444d;
      border-radius: 12px 0 0 0;
    }
    .wm-panel-title { font-size: 13px; font-weight: 600; color: #e7e9ea; }
    .wm-panel-close { background: none; border: none; color: #8899a6; cursor: pointer; font-size: 16px; padding: 0; }
    .wm-panel-close:hover { color: #e7e9ea; }
    .wm-panel-body { padding: 12px 14px; }

    #wemedia-toolbar .wm-icons {
      display: flex; flex-direction: column; background: #15202b;
      border: 1px solid #38444d; border-radius: 10px 0 0 10px;
      overflow: hidden; box-shadow: -2px 0 12px rgba(0,0,0,.3);
    }
    .wm-icon-btn {
      width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
      cursor: pointer; border: none; background: transparent; color: #8899a6;
      font-size: 17px; transition: background .15s, color .15s; position: relative;
    }
    .wm-icon-btn:hover { background: #1e2d3d; color: #1d9bf0; }
    .wm-icon-btn.active { background: #1e2d3d; color: #1d9bf0; }
    .wm-icon-btn + .wm-icon-btn { border-top: 1px solid #253341; }
    .wm-icon-btn::before {
      content: attr(data-tip); position: absolute; right: 48px;
      background: #253341; color: #e7e9ea; font-size: 11px; padding: 3px 8px;
      border-radius: 4px; white-space: nowrap; pointer-events: none;
      opacity: 0; transition: opacity .15s;
    }
    .wm-icon-btn:hover::before { opacity: 1; }

    .wm-panel input, .wm-panel textarea, .wm-panel select {
      width: 100%; box-sizing: border-box; background: #253341; border: 1px solid #38444d;
      border-radius: 6px; color: #e7e9ea; font-size: 12px; padding: 6px 8px;
      margin-bottom: 7px; outline: none; font-family: inherit;
    }
    .wm-panel input:focus, .wm-panel textarea:focus, .wm-panel select:focus { border-color: #1d9bf0; }
    .wm-panel textarea { resize: vertical; min-height: 60px; }

    .wm-label {
      font-size: 10px; color: #8899a6; text-transform: uppercase;
      letter-spacing: .5px; margin-bottom: 4px; display: block;
    }
    .wm-btn {
      width: 100%; padding: 7px; background: #1d9bf0; color: white; border: none;
      border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
      margin-top: 4px; font-family: inherit;
    }
    .wm-btn:hover { background: #1a8cd8; }
    .wm-btn:disabled { background: #38444d; cursor: default; }
    .wm-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
    .wm-tag {
      font-size: 10px; padding: 2px 8px; border-radius: 9999px;
      border: 1px solid #38444d; color: #8899a6; cursor: pointer;
      background: transparent; font-family: inherit;
    }
    .wm-tag.on { background: #1d9bf0; border-color: #1d9bf0; color: white; }
    .wm-msg { font-size: 11px; margin-top: 6px; min-height: 14px; text-align: center; }
    .wm-ok { color: #00ba7c; }
    .wm-err { color: #f4212e; }

    /* ── Custom topic picker ── */
    .wm-picker { position: relative; margin-bottom: 7px; }

    .wm-picker-trigger {
      display: flex; align-items: center; justify-content: space-between;
      background: #253341; border: 1px solid #38444d; border-radius: 6px;
      color: #8899a6; font-size: 12px; padding: 6px 8px; cursor: pointer;
      user-select: none;
    }
    .wm-picker-trigger.has-value { color: #e7e9ea; }
    .wm-picker-trigger.open { border-color: #1d9bf0; }
    .wm-picker-trigger:hover { border-color: #536471; }
    .wm-picker-arrow { font-size: 10px; color: #536471; flex-shrink: 0; }

    .wm-picker-dropdown {
      display: none; position: absolute; bottom: calc(100% + 4px); left: 0; right: 0;
      background: #1e2d3d; border: 1px solid #38444d; border-radius: 8px;
      max-height: 200px; overflow-y: auto; z-index: 10;
      box-shadow: 0 -4px 16px rgba(0,0,0,.4);
    }

    .wm-picker-item {
      display: flex; align-items: center; padding: 6px 10px;
      font-size: 12px; color: #8899a6; cursor: pointer; white-space: nowrap;
    }
    .wm-picker-item:hover { background: #253341; color: #e7e9ea; }
    .wm-picker-item.selected { color: #1d9bf0; }
    .wm-picker-item.depth-0 { font-weight: 600; color: #e7e9ea; border-top: 1px solid #253341; }
    .wm-picker-item.depth-0:first-child { border-top: none; }
    .wm-picker-item.depth-1 { padding-left: 14px; }
    .wm-picker-item.depth-2 { padding-left: 22px; }
    .wm-picker-indent { color: #536471; font-size: 11px; margin-right: 2px; flex-shrink: 0; }
    .wm-picker-icon { flex-shrink: 0; }
  `;
  document.head.appendChild(style);

  // ── Build toolbar HTML ───────────────────────────────────────────────────────

  const SCENE_TAGS = [
    { value: "opener",    label: "开头" },
    { value: "closer",    label: "收尾" },
    { value: "argument",  label: "论据" },
    { value: "twist",     label: "反转" },
    { value: "resonance", label: "共鸣" },
    { value: "warning",   label: "警示" },
  ];

  const toolbar = document.createElement("div");
  toolbar.id = TOOLBAR_ID;

  // Panels skeleton
  toolbar.innerHTML = `
    <div class="wm-panel" id="wm-panel-source">
      <div class="wm-panel-header">
        <span class="wm-panel-title">存入主题线索</span>
        <button class="wm-panel-close" data-close="wm-panel-source">✕</button>
      </div>
      <div class="wm-panel-body">
        <span class="wm-label">关联主题</span>
        <div id="wm-source-picker-wrap"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span class="wm-label" style="margin-bottom:0">线索内容</span>
          <button id="wm-refetch-content" style="background:none;border:none;color:#1d9bf0;font-size:11px;cursor:pointer;padding:0;font-family:inherit">重新提取</button>
        </div>
        <textarea id="wm-source-content" placeholder="自动提取或手动粘贴…" style="min-height:80px"></textarea>
        <span class="wm-label">备注</span>
        <input id="wm-source-note" placeholder="方法有效？来源可信度…" />
        <button class="wm-btn" id="wm-source-save">保存当前页面</button>
        <div class="wm-msg" id="wm-source-msg"></div>
      </div>
    </div>

    <div class="wm-panel" id="wm-panel-quote">
      <div class="wm-panel-header">
        <span class="wm-panel-title">存入金句库</span>
        <button class="wm-panel-close" data-close="wm-panel-quote">✕</button>
      </div>
      <div class="wm-panel-body">
        <span class="wm-label">金句原文</span>
        <textarea id="wm-quote-text" placeholder="粘贴或输入金句…"></textarea>
        <span class="wm-label">作者（可选）</span>
        <input id="wm-quote-author" placeholder="作者" />
        <span class="wm-label">使用场景</span>
        <div class="wm-tags" id="wm-quote-tags">
          ${SCENE_TAGS.map(t => `<button class="wm-tag" data-tag="${t.value}">${t.label}</button>`).join("")}
        </div>
        <button class="wm-btn" id="wm-quote-save">保存金句</button>
        <div class="wm-msg" id="wm-quote-msg"></div>
      </div>
    </div>

    <div class="wm-panel" id="wm-panel-synthesize" ${isStatusPage() ? "" : 'style="display:none!important"'}>
      <div class="wm-panel-header">
        <span class="wm-panel-title">提炼成文</span>
        <button class="wm-panel-close" data-close="wm-panel-synthesize">✕</button>
      </div>
      <div class="wm-panel-body">
        <span class="wm-label">角度</span>
        <select id="wm-syn-angle">
          <option value="tutorial">教程向 — 整理成操作步骤</option>
          <option value="opinion">观点向 — 归纳观点加判断</option>
          <option value="resource">资源向 — 提取工具清单</option>
        </select>
        <span class="wm-label">关联主题（可选）</span>
        <div id="wm-syn-picker-wrap"></div>
        <button class="wm-btn" id="wm-syn-btn">一键提炼成草稿</button>
        <div class="wm-msg" id="wm-syn-msg"></div>
      </div>
    </div>

    <div class="wm-icons">
      <button class="wm-icon-btn" id="wm-btn-source" data-tip="存线索">📌</button>
      <button class="wm-icon-btn" id="wm-btn-quote"  data-tip="存金句">💬</button>
      ${isStatusPage() ? `<button class="wm-icon-btn" id="wm-btn-synthesize" data-tip="提炼成文">✨</button>` : ""}
    </div>
  `;
  document.body.appendChild(toolbar);

  // ── Mount topic pickers ──────────────────────────────────────────────────────

  const sourcePicker = createTopicPicker("选择主题…");
  const synPicker    = createTopicPicker("不关联主题");

  document.getElementById("wm-source-picker-wrap").appendChild(sourcePicker.el);
  document.getElementById("wm-syn-picker-wrap").appendChild(synPicker.el);

  async function refreshTopics() {
    await loadTopics();
    sourcePicker.refresh();
    synPicker.refresh();
  }

  // ── Panel toggle ─────────────────────────────────────────────────────────────

  let activePanel = null;

  function openPanel(id) {
    document.querySelectorAll(".wm-panel").forEach(p => p.classList.remove("open"));
    document.querySelectorAll(".wm-icon-btn").forEach(b => b.classList.remove("active"));
    if (activePanel === id) { activePanel = null; return; }
    document.getElementById(id)?.classList.add("open");
    document.getElementById("wm-btn-" + id.replace("wm-panel-", ""))?.classList.add("active");
    activePanel = id;
    loadTopics(); // refresh tree data each time panel opens
  }

  function fillSourceContent(force = false) {
    const contentEl = document.getElementById("wm-source-content");
    if (!contentEl) return;
    if (!force && contentEl.value) return;  // don't overwrite unless forced

    // Priority 1: selected text
    const sel = window.getSelection()?.toString().trim();
    if (sel) { contentEl.value = sel; return; }

    // Priority 2: X page content
    if (!/x\.com|twitter\.com/.test(location.href)) return;
    const r = extractXPageContent();
    const text = r.body ? (r.title ? `${r.title}\n\n${r.body}` : r.body) : "";
    if (text) {
      contentEl.value = text;
    } else {
      // Page may still be loading — retry once after 800ms
      contentEl.placeholder = "提取中…";
      setTimeout(() => {
        const r2 = extractXPageContent();
        const t2 = r2.body ? (r2.title ? `${r2.title}\n\n${r2.body}` : r2.body) : "";
        contentEl.value = t2;
        contentEl.placeholder = "自动提取或手动粘贴…";
      }, 800);
    }
  }

  document.getElementById("wm-btn-source")?.addEventListener("click", () => {
    openPanel("wm-panel-source");
    fillSourceContent(false);
  });

  document.getElementById("wm-refetch-content")?.addEventListener("click", () => {
    fillSourceContent(true);
  });
  document.getElementById("wm-btn-quote")?.addEventListener("click", () => {
    const sel = window.getSelection()?.toString().trim();
    if (sel) document.getElementById("wm-quote-text").value = sel;
    openPanel("wm-panel-quote");
  });
  document.getElementById("wm-btn-synthesize")?.addEventListener("click", () => openPanel("wm-panel-synthesize"));

  toolbar.querySelectorAll(".wm-panel-close").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.close)?.classList.remove("open");
      document.querySelectorAll(".wm-icon-btn").forEach(b => b.classList.remove("active"));
      activePanel = null;
    });
  });

  // ── Scene tags ────────────────────────────────────────────────────────────────

  document.querySelectorAll("#wm-quote-tags .wm-tag").forEach(t =>
    t.addEventListener("click", () => t.classList.toggle("on")));

  function selectedTags() {
    return Array.from(document.querySelectorAll("#wm-quote-tags .wm-tag.on")).map(t => t.dataset.tag);
  }

  // ── Save source ───────────────────────────────────────────────────────────────

  document.getElementById("wm-source-save").addEventListener("click", async () => {
    const btn = document.getElementById("wm-source-save");
    const msg = document.getElementById("wm-source-msg");
    const topicId = sourcePicker.getValue();
    if (!topicId) { msg.textContent = "请先选择主题"; msg.className = "wm-msg wm-err"; return; }

    btn.disabled = true; msg.textContent = "";
    try {
      const res = await fetch(`${API}/api/content-topics/sources/quick-save`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic_id: parseInt(topicId), url: location.href,
          title: document.title || "",
          content: document.getElementById("wm-source-content").value.trim(),
          note: document.getElementById("wm-source-note").value.trim(),
          platform: detectPlatform(location.href),
        }),
      });
      if (res.ok) {
        msg.textContent = "已保存 ✓"; msg.className = "wm-msg wm-ok";
        document.getElementById("wm-source-content").value = "";
        document.getElementById("wm-source-note").value = "";
      } else { msg.textContent = "保存失败"; msg.className = "wm-msg wm-err"; }
    } catch { msg.textContent = "无法连接后端"; msg.className = "wm-msg wm-err"; }
    finally { btn.disabled = false; }
  });

  // ── Save quote ────────────────────────────────────────────────────────────────

  document.getElementById("wm-quote-save").addEventListener("click", async () => {
    const btn = document.getElementById("wm-quote-save");
    const msg = document.getElementById("wm-quote-msg");
    const text = document.getElementById("wm-quote-text").value.trim();
    if (!text) { msg.textContent = "请输入金句内容"; msg.className = "wm-msg wm-err"; return; }

    btn.disabled = true; msg.textContent = "";
    try {
      const res = await fetch(`${API}/api/quotes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text, author: document.getElementById("wm-quote-author").value.trim(),
          source_url: location.href, source: document.title || "",
          scene_tags: selectedTags(), platform: detectPlatform(location.href),
        }),
      });
      if (res.ok) {
        msg.textContent = "已存入金句库 ✓"; msg.className = "wm-msg wm-ok";
        document.getElementById("wm-quote-text").value = "";
        document.getElementById("wm-quote-author").value = "";
        document.querySelectorAll("#wm-quote-tags .wm-tag").forEach(t => t.classList.remove("on"));
      } else { msg.textContent = "保存失败"; msg.className = "wm-msg wm-err"; }
    } catch { msg.textContent = "无法连接后端"; msg.className = "wm-msg wm-err"; }
    finally { btn.disabled = false; }
  });

  // ── Synthesize ────────────────────────────────────────────────────────────────

  document.getElementById("wm-syn-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("wm-syn-btn");
    const msg = document.getElementById("wm-syn-msg");
    btn.disabled = true; msg.textContent = "提取内容中…"; msg.className = "wm-msg";

    const thread = extractThread();
    if (!thread.post) {
      msg.textContent = "未检测到帖子，请滚动到帖子位置"; msg.className = "wm-msg wm-err";
      btn.disabled = false; return;
    }
    msg.textContent = `已提取原帖 + ${thread.replies.length} 条评论，生成中…`;
    try {
      const topicId = synPicker.getValue();
      const res = await fetch(`${API}/api/x/synthesize`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post: thread.post, replies: thread.replies,
          angle: document.getElementById("wm-syn-angle").value,
          content_topic_id: topicId ? parseInt(topicId) : null,
          source_url: location.href,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        msg.textContent = `✓ 草稿已生成：${data.title}`; msg.className = "wm-msg wm-ok";
      } else {
        const err = await res.json().catch(() => ({}));
        msg.textContent = err.detail || "生成失败"; msg.className = "wm-msg wm-err";
      }
    } catch { msg.textContent = "无法连接后端"; msg.className = "wm-msg wm-err"; }
    finally { btn.disabled = false; }
  });

  // ── HTML → Markdown converter ────────────────────────────────────────────────

  function isEmojiImg(el) {
    const src = el.getAttribute('src') || '';
    return /twemoji|abs\.twimg\.com\/emoji|emoji\.twimg\.com/.test(src)
      || (el.getAttribute('draggable') === 'false' && parseInt(el.getAttribute('width') || '99') < 32);
  }

  function nodeToMd(node) {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script','style','noscript','svg'].includes(tag)) return '';
    const kids = () => Array.from(node.childNodes).map(nodeToMd).join('');

    switch (tag) {
      case 'h1': return `\n# ${kids().trim()}\n\n`;
      case 'h2': return `\n## ${kids().trim()}\n\n`;
      case 'h3': return `\n### ${kids().trim()}\n\n`;
      case 'h4': case 'h5': case 'h6': return `\n#### ${kids().trim()}\n\n`;
      case 'p':  return `${kids().trim()}\n\n`;
      case 'br': return '\n';
      case 'hr': return '\n---\n\n';
      case 'strong': case 'b': { const t = kids(); return t ? `**${t}**` : ''; }
      case 'em':     case 'i': { const t = kids(); return t ? `*${t}*`  : ''; }
      case 'del':    case 's': { const t = kids(); return t ? `~~${t}~~`: ''; }
      case 'code': return node.closest('pre') ? kids() : `\`${kids()}\``;
      case 'pre':  return `\`\`\`\n${kids().trim()}\n\`\`\`\n\n`;
      case 'blockquote': return `> ${kids().trim().replace(/\n/g, '\n> ')}\n\n`;
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = kids().trim();
        // X-internal paths (mentions, hashtags) → plain text
        if (!href || href.startsWith('/')) return text;
        return text && text !== href ? `[${text}](${href})` : href;
      }
      case 'img': {
        if (isEmojiImg(node)) return node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        if (!src) return '';
        // Skip tiny icons / avatars
        const w = parseInt(node.getAttribute('width') || '999');
        if (w > 0 && w < 48) return node.getAttribute('alt') || '';
        const alt = node.getAttribute('alt') || '';
        return `\n\n![${alt}](${src})\n\n`;
      }
      case 'ul': return '\n' + Array.from(node.children)
        .filter(c => c.tagName === 'LI')
        .map(li => `- ${nodeToMd(li).trim()}`).join('\n') + '\n\n';
      case 'ol': return '\n' + Array.from(node.children)
        .filter(c => c.tagName === 'LI')
        .map((li, i) => `${i + 1}. ${nodeToMd(li).trim()}`).join('\n') + '\n\n';
      case 'li': return kids();
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (!rows.length) return kids();
        const cells = r => Array.from(r.querySelectorAll('th,td')).map(c => c.innerText.trim());
        const hdr = cells(rows[0]);
        return [
          '| ' + hdr.join(' | ') + ' |',
          '| ' + hdr.map(() => '---').join(' | ') + ' |',
          ...rows.slice(1).map(r => '| ' + cells(r).join(' | ') + ' |'),
        ].join('\n') + '\n\n';
      }
      default: return kids();
    }
  }

  function elToMd(el) {
    if (!el) return '';
    const raw = nodeToMd(el);
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ── Collect attached tweet photos (outside tweetText) ────────────────────────

  function tweetPhotos(tweetArticle) {
    const imgs = Array.from(tweetArticle.querySelectorAll(
      '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img'
    )).filter(img => !isEmojiImg(img));
    if (!imgs.length) return '';
    return '\n\n' + imgs.map(img => {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      return src ? `![${alt}](${src})` : '';
    }).filter(Boolean).join('\n\n');
  }

  // ── X content extraction (tweet + article) ───────────────────────────────────

  function extractXPageContent() {
    // ── Strategy 1: known data-testid for X long-form articles ─────────────────
    const ARTICLE_SELECTORS = [
      '[data-testid="longformBody"]',
      '[data-testid="longformContent"]',
      '[data-testid="articleBody"]',
      '[data-testid="article-body"]',
      '[data-testid="scrollableArticleBody"]',
    ];
    for (const sel of ARTICLE_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 80) {
        const titleEl = document.querySelector('[data-testid="articleTitle"]')
          || document.querySelector('[data-testid="longformTitle"]')
          || el.querySelector('h1,h2');
        const title = titleEl ? elToMd(titleEl) : '';
        return { type: "article", title, body: elToMd(el) };
      }
    }

    // ── Strategy 2: wildcard data-testid containing "longform" / "Article" ─────
    const wildcard = document.querySelector(
      '[data-testid*="longform"]:not([data-testid*="Nav"]):not([data-testid*="Sidebar"]),' +
      '[data-testid*="Article"]:not([data-testid*="Nav"]):not([data-testid*="Sidebar"])'
    );
    if (wildcard && wildcard.innerText.trim().length > 100) {
      return { type: "article", title: elToMd(document.querySelector('h1')), body: elToMd(wildcard) };
    }

    // ── Strategy 3: role="article" ─────────────────────────────────────────────
    const roleArticle = document.querySelector('[role="article"]');
    if (roleArticle && roleArticle.innerText.trim().length > 200) {
      const h1 = roleArticle.querySelector('h1') || document.querySelector('h1');
      return { type: "article", title: elToMd(h1), body: elToMd(roleArticle) };
    }

    // ── Strategy 4: h1 + ≥2 paragraphs in primary column ──────────────────────
    const primaryCol = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
    if (primaryCol) {
      const h1 = primaryCol.querySelector('h1');
      const paras = Array.from(primaryCol.querySelectorAll('p')).filter(p => p.innerText.trim().length > 30);
      if (h1 && paras.length >= 2) {
        const body = paras.map(elToMd).join('\n\n');
        return { type: "article", title: elToMd(h1), body };
      }
    }

    // ── Strategy 5: regular tweet ──────────────────────────────────────────────
    const firstTweet = document.querySelector('article[data-testid="tweet"]');
    if (firstTweet) {
      const tweetTextEl = firstTweet.querySelector('[data-testid="tweetText"]');
      const body = elToMd(tweetTextEl) + tweetPhotos(firstTweet);
      // collect reply tweets
      const replies = Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
        .slice(1).map(a => {
          const t = a.querySelector('[data-testid="tweetText"]');
          return t ? elToMd(t) + tweetPhotos(a) : '';
        }).filter(Boolean).slice(0, 20);
      return { type: "tweet", title: "", body, replies };
    }

    // ── Strategy 6: largest data-testid block ──────────────────────────────────
    const SKIP = /nav|sidebar|header|footer|timeline|trending|whoToFollow/i;
    let richest = null, richestLen = 0;
    document.querySelectorAll('[data-testid]').forEach(el => {
      if (SKIP.test(el.getAttribute('data-testid') || '')) return;
      const len = el.innerText.trim().length;
      if (len > richestLen && len > 150) { richestLen = len; richest = el; }
    });
    if (richest) {
      return { type: "article", title: elToMd(document.querySelector('h1')), body: elToMd(richest) };
    }

    return { type: "tweet", title: "", body: "" };
  }

  function extractThread() {
    const r = extractXPageContent();
    if (r.type === "article") {
      // For synthesize: treat title as "post", body paragraphs as "replies"
      const paragraphs = r.body.split(/\n{2,}/).filter(Boolean);
      return {
        post: r.title ? `${r.title}\n\n${paragraphs[0] || ""}` : paragraphs[0] || "",
        replies: paragraphs.slice(1, 21),
      };
    }
    return { post: r.body, replies: r.replies || [] };
  }

  // Preload
  loadTopics();

})();
