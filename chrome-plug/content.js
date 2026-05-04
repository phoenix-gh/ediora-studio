(() => {
  const CONFIG = {
    apiUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    apiKey: "sk-30e50dcfa66546ef99dc84f373d317da"
  };

  const PANEL_ID = "wemedia-studio-float-panel";
  const POS_KEY = "wemedia-x-panel-pos";

  function getVisibleComposerScope() {
    const editors = document.querySelectorAll('div[role="textbox"][data-testid^="tweetTextarea"]');
    for (const ed of editors) {
      const r = ed.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return (
          ed.closest('[role="dialog"]') ||
          ed.closest("form") ||
          ed.closest("article") ||
          document
        );
      }
    }
    return document;
  }

  function getContextText(scope) {
    const article = scope.closest("article") || document.querySelector("article");
    const tweetText = article?.querySelector('[data-testid="tweetText"]');
    return (tweetText?.textContent || "").trim();
  }

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if ((p.edge === "left" || p.edge === "right") && typeof p.top === "number") {
        return { edge: p.edge, top: p.top };
      }
      if (typeof p.left === "number" && typeof p.top === "number") {
        const w = typeof p.width === "number" ? p.width : 280;
        const mid = p.left + w / 2;
        return {
          edge: mid < window.innerWidth / 2 ? "left" : "right",
          top: p.top
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  function savePanelPos(edge, top) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ edge, top }));
    } catch (_) {}
  }

  function clampTopForPanel(panel, top) {
    const h = panel.offsetHeight || 120;
    const m = 8;
    const maxT = Math.max(m, window.innerHeight - h - m);
    return Math.min(Math.max(m, top), maxT);
  }

  function applyPanelDock(panel, edge, top) {
    const t = clampTopForPanel(panel, top);
    if (edge === "right") {
      panel.style.right = "16px";
      panel.style.left = "auto";
    } else {
      panel.style.left = "16px";
      panel.style.right = "auto";
    }
    panel.style.top = `${t}px`;
    return t;
  }

  function showResultDialog(text) {
    const old = document.getElementById("wemedia-studio-result-modal");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "wemedia-studio-result-modal";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000001;display:flex;align-items:center;justify-content:center;";

    const card = document.createElement("div");
    card.style.cssText =
      "width:560px;max-width:90vw;background:#15202b;border:1px solid #38444d;border-radius:12px;padding:14px;color:#e7e9ea;";

    const title = document.createElement("div");
    title.textContent = "生成回复（可编辑后复制）";
    title.style.cssText = "font-weight:700;margin-bottom:10px;";

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText =
      "width:100%;height:160px;border-radius:8px;border:1px solid #38444d;background:#0f1419;color:#e7e9ea;padding:10px;resize:vertical;box-sizing:border-box;";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:10px;";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText =
      "padding:6px 12px;border-radius:9999px;border:1px solid #536471;background:transparent;color:#e7e9ea;cursor:pointer;";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "复制";
    copyBtn.style.cssText =
      "padding:6px 14px;border-radius:9999px;border:none;background:#1d9bf0;color:#fff;cursor:pointer;";

    closeBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    copyBtn.onclick = async () => {
      textarea.select();
      try {
        await navigator.clipboard.writeText(textarea.value);
      } catch (_) {
        document.execCommand("copy");
      }
      copyBtn.textContent = "已复制";
      setTimeout(() => {
        copyBtn.textContent = "复制";
      }, 1000);
    };

    actions.appendChild(closeBtn);
    actions.appendChild(copyBtn);
    card.appendChild(title);
    card.appendChild(textarea);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    textarea.focus();
  }

  async function callHermes(contextText) {
    const prompt = contextText
      ? `请针对这条内容写一条自然、简短、有信息量的中文回复：\n\n${contextText}`
      : "请写一条自然、简短、有信息量的中文回复。";

    const res = await fetch(CONFIG.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CONFIG.apiKey ? { Authorization: `Bearer ${CONFIG.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: CONFIG.model,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "你是社媒运营助手，擅长读懂楼主帖子核心内容、情绪、诉求，给出专业得体、贴合圈层、不生硬、有共情的高质量回复，不灌水、不废话、不抬杠。\
工作规则：\
先精准提炼帖子核心：楼主想问什么、分享什么、吐槽什么、求推荐 / 求解决 / 求共鸣。\
回复风格适配帖子圈层：科技、生活、汽车、理财、编程、情感、数码等自动匹配语气。\
回复结构自然：先共情 / 认可 → 补充专业观点 / 干货 → 给到实用建议 / 延伸思路 → 语气友好接地气。不能有AI味道, 不能有AI的痕迹。\
禁用：生硬机器话术、说教感太强、阴阳怪气、引战、广告、套话流水账。\
可根据帖子氛围灵活调整：偏干货就专业严谨，偏闲聊就轻松随和，偏求助就耐心细致。\
字数适配帖子评论区：不长篇大论，精简有料，符合普通人发帖回复习惯, 一般在30字以内, 最多不超过50字。"
          },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!res.ok) {
      throw new Error(`LLM 请求失败: ${res.status}`);
    }

    const data = await res.json();
    const text =
      data?.choices?.[0]?.message?.content ||
      data?.output_text ||
      "";

    return String(text).trim();
  }

  function ensureFloatingPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "position:fixed;z-index:1000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;user-select:none;";

    const saved = loadPanelPos();
    if (saved) {
      applyPanelDock(panel, saved.edge, saved.top);
    } else {
      applyPanelDock(panel, "right", 16);
    }

    const onResize = () => {
      const p = loadPanelPos();
      if (p) {
        const t = applyPanelDock(panel, p.edge, p.top);
        savePanelPos(p.edge, t);
      } else {
        applyPanelDock(panel, "right", 16);
      }
    };
    window.addEventListener("resize", onResize);

    const card = document.createElement("div");
    card.style.cssText =
      "width:280px;background:rgba(21,32,43,0.96);border:1px solid #38444d;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.45);overflow:hidden;";

    const header = document.createElement("div");
    header.style.cssText =
      "padding:10px 12px;background:#1c2732;border-bottom:1px solid #38444d;color:#e7e9ea;font-weight:700;font-size:13px;cursor:grab;display:flex;align-items:center;justify-content:space-between;";
    header.innerHTML = "<span>WeMedia</span><span style=font-size:11px;font-weight:500;color:#8899a6>拖动</span>";

    const body = document.createElement("div");
    body.style.cssText = "padding:12px;color:#8899a6;font-size:12px;user-select:text;";

    const hint = document.createElement("div");
    hint.textContent = "先打开回复框，再点生成。结果在弹窗里可改、可复制。";
    hint.style.cssText = "margin-bottom:10px;line-height:1.45;";

    const status = document.createElement("div");
    status.style.cssText = "min-height:16px;margin-bottom:10px;color:#536471;font-size:11px;";
    status.textContent = "";

    const genBtn = document.createElement("button");
    genBtn.type = "button";
    genBtn.textContent = "生成回复";
    genBtn.style.cssText =
      "width:100%;padding:8px 12px;border-radius:9999px;border:none;background:#1d9bf0;color:#fff;font-weight:700;font-size:13px;cursor:pointer;";

    genBtn.addEventListener("click", async () => {
      const scope = getVisibleComposerScope();
      const contextText = getContextText(scope);
      if (!contextText) {
        status.textContent = "未检测到帖子正文：请先点开要回复的推文并打开回复框。";
        status.style.color = "#f4212e";
        return;
      }

      genBtn.disabled = true;
      status.style.color = "#8899a6";
      status.textContent = "生成中…";

      try {
        const generated = await callHermes(contextText);
        if (!generated) throw new Error("返回为空");
        showResultDialog(generated);
        status.textContent = "已打开结果弹窗，可编辑后复制。";
        status.style.color = "#00ba7c";
      } catch (err) {
        console.error("[WeMedia]", err);
        status.textContent = err?.message || "生成失败";
        status.style.color = "#f4212e";
      } finally {
        genBtn.disabled = false;
      }
    });

    body.appendChild(hint);
    body.appendChild(status);
    body.appendChild(genBtn);

    card.appendChild(header);
    card.appendChild(body);
    panel.appendChild(card);
    document.body.appendChild(panel);

    let drag = null;
    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top
      };
      header.style.cursor = "grabbing";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let left = drag.origLeft + dx;
      let top = drag.origTop + dy;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const maxL = Math.max(8, window.innerWidth - w - 8);
      const maxT = Math.max(8, window.innerHeight - h - 8);
      left = Math.min(Math.max(8, left), maxL);
      top = Math.min(Math.max(8, top), maxT);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      header.style.cursor = "grab";
      const rect = panel.getBoundingClientRect();
      const edge = rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
      const top = applyPanelDock(panel, edge, rect.top);
      savePanelPos(edge, top);
    });
  }

  ensureFloatingPanel();
})();
