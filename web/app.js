// ============ 通用 ============
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};
const esc = s => (s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- 画风 / 动画元数据 ----------
let STYLES = [];
const ANIM_NAMES = {
  "": "跟随情绪", "kenburns-in": "缓慢推近", "kenburns-out": "缓慢拉远",
  "pan-left": "向左平移", "pan-right": "向右平移", "drift-up": "向上飘",
  "drift-down": "缓缓下降", "zoom-punch": "跳出震动", "sway": "轻轻摇摆", "shake": "震动",
};
const MOOD_ANIM = {
  "平静": ["kenburns-out", "drift-up", "pan-right"],
  "欢快": ["kenburns-in", "pan-left", "sway"],
  "悲伤": ["drift-down", "kenburns-out"],
  "紧张": ["zoom-punch", "pan-left", "shake"],
  "激昂": ["kenburns-in", "zoom-punch"],
};

async function loadStyles() {
  const s = await api("/api/styles");
  STYLES = s.styles;
  $("#story-style").innerHTML = STYLES.map(x =>
    `<option value="${x.id}" ${x.id === s.default ? "selected" : ""}>${x.name}</option>`).join("");
  // 作品类型下拉（同步初始化，常量在前端定义）
  if ($("#story-genre")) {
    $("#story-genre").innerHTML = GENRES.map(g =>
      `<option value="${g}" ${g === "通用" ? "selected" : ""}>${g}</option>`).join("");
  }
}

// ---------- Tab 切换 ----------
$$(".tab").forEach(t => t.onclick = () => {
  $$(".tab").forEach(x => x.classList.remove("active"));
  $$(".panel").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  $("#tab-" + t.dataset.tab).classList.add("active");
  if (t.dataset.tab === "play") refreshPlayList();
});

// ---------- 服务状态灯 ----------
async function refreshStatus() {
  try {
    const s = await api("/api/status");
    $("#dot-ollama").classList.toggle("on", s.ollama);
    $("#dot-comfy").classList.toggle("on", s.comfy);
  } catch {}
}
setInterval(refreshStatus, 5000);
refreshStatus();

// ---------- SSE 作业进度（带预计剩余时间） ----------
function _fmtEta(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `约 ${sec} 秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60), s = Math.round((sec % 60) / 10) * 10;
    return s ? `约 ${m} 分 ${s} 秒` : `约 ${m} 分钟`;
  }
  return `约 ${Math.floor(sec / 3600)} 小时 ${Math.round(sec % 3600 / 60)} 分`;
}

function watchJob(jobId, bar, fill, textEl, onDone, onEvent) {
  bar.classList.remove("hidden");
  fill.style.width = "0%";
  // ETA 统计：拆分速率(字/秒)、每张图耗时、每章耗时
  let chapStart = 0, lastT = 0, lastPhase = null, pendingSplit = null;
  let splitRate = 0, imgSecs = [], chapSecs = [];
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const es = new EventSource(`/api/job/${jobId}`);
  es.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.msg) {
      const now = d.t || Date.now() / 1000;
      // split 结束（下一个事件到来）→ 更新拆分速率
      if (pendingSplit && d.phase !== "split") {
        const secs = now - pendingSplit.t;
        if (secs > 3) splitRate = pendingSplit.chars / secs;
        pendingSplit = null;
      }
      let chapRemain = 0, totalRemain = 0;
      if (d.phase === "split") {
        chapStart = now;
        pendingSplit = { t: now, chars: d.split_chars || 2000 };
        chapRemain = (d.split_chars || 2000) / (splitRate || 22) + (imgSecs.length ? avg(imgSecs) * 5 : 300);
      } else if (d.phase === "imaging") {
        if (!chapStart) chapStart = now;
        if (lastT && lastPhase === "imaging") imgSecs.push(now - lastT);
        const avgImg = imgSecs.length ? avg(imgSecs) : 60;
        chapRemain = Math.max(0, (d.img_total ?? 1) - (d.img_cur ?? 0)) * avgImg;
      } else if (d.phase === "chapter_ready") {
        if (lastT && lastPhase === "imaging") imgSecs.push(now - lastT);
        if (chapStart) { chapSecs.push(now - chapStart); chapStart = 0; }
      } else if (d.phase === "genimg") {
        if (lastT && lastPhase === "genimg") imgSecs.push(now - lastT);
        const avgImg = imgSecs.length ? avg(imgSecs) : 60;
        totalRemain = Math.max(0, (d.total ?? 1) - (d.cur ?? 0)) * avgImg;
      }
      // 章节管线：总体剩余 = 本章剩余 + 后续章 × 平均章耗时
      if (d.phase && d.phase !== "genimg" && d.total) {
        const remainChaps = Math.max(0, d.total - (d.cur ?? 0) - (d.phase === "chapter_ready" ? 0 : 1));
        const estChap = chapSecs.length ? avg(chapSecs)
          : (chapStart ? (now - chapStart) + chapRemain : 600);
        totalRemain = chapRemain + remainChaps * estChap;
      }
      lastT = now;
      lastPhase = d.phase || lastPhase;
      let eta = "";
      if (d.phase === "genimg") {
        if (totalRemain > 5) eta = `　—— 全程约剩 ${_fmtEta(totalRemain)}`;
      } else if (d.phase && d.phase !== "chapter_ready" && totalRemain > 5) {
        eta = `　—— 本章约剩 ${_fmtEta(chapRemain)} · 全程约剩 ${_fmtEta(totalRemain)}`;
      }
      textEl.textContent = d.msg + eta;
      if (d.total) fill.style.width = Math.round((d.cur / d.total) * 100) + "%";
      onEvent && onEvent(d);
    }
    if (d.done) {
      es.close();
      fill.style.width = d.ok ? "100%" : "0%";
      setTimeout(() => bar.classList.add("hidden"), 2500);
      onDone && onDone(d.ok);
    }
  };
  return es;
}

// ============ 创作 ============
let current = null;

async function refreshProjectList() {
  const list = await api("/api/project/list");
  $("#project-list").innerHTML = list.length ? "" : '<p class="hint">还没有作品。</p>';
  const sel = $("#play-project");
  const keep = sel.value;
  sel.innerHTML = "";
  for (const p of list) {
    const div = document.createElement("div");
    div.className = "project-item" + (current && p.id === current.id ? " active" : "");
    div.innerHTML = `<span>${esc(p.title)}</span>
      <span class="meta">${p.ready}/${p.chapters} 章 · ${p.images}/${p.scenes} 图</span>
      <button class="del" title="删除（不可恢复）">🗑</button>`;
    div.querySelector(".del").onclick = async e => {
      e.stopPropagation();
      if (!confirm(`确定删除《${p.title}》？\n图片、分镜、书签全部删除，不可恢复。`)) return;
      await api(`/api/project/${p.id}`, { method: "DELETE" });
      if (current && current.id === p.id) {
        current = null;
        $("#scenes").innerHTML = '<p class="hint">生成分镜后在这里检查和修改。</p>';
        $("#scenes-title").textContent = "分镜表";
        ["#btn-gen-all", "#btn-go-play", "#btn-assign-music"].forEach(s => $(s).disabled = true);
        $("#btn-resume").classList.add("hidden");
      }
      refreshProjectList();
    };
    div.onclick = () => loadProject(p.id);
    $("#project-list").appendChild(div);
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.title}（${p.ready}/${p.chapters}章 ${p.images}/${p.scenes}图）`;
    sel.appendChild(o);
  }
  if (keep) sel.value = keep;
  else if (current) sel.value = current.id;
  updatePlayNote();
}

async function loadProject(pid) {
  current = await api(`/api/project/${pid}`);
  $("#scenes-title").textContent = `分镜表 · ${current.title}`;
  ["#btn-gen-all", "#btn-go-play", "#btn-assign-music"].forEach(s => $(s).disabled = false);
  renderScenes();
  refreshProjectList();
}

function chapterSignature(m) {
  return m.chapters.map(c =>
    `${c.status}:${c.scenes.length}:${c.scenes.filter(s => s.image_file).length}`).join("|");
}

// 多句台词 <-> 文本框（每行一句；行首"人名："为对白）
function linesToRaw(lines) {
  return (lines || []).map(l => l.speaker === "旁白" ? l.text : `${l.speaker}：${l.text}`).join("\n");
}
function parseLines(raw, oldLines) {
  const old = oldLines || [];
  return raw.split(/\n+/).map(s => s.trim()).filter(Boolean).map((line, i) => {
    const m = line.match(/^([^\s，。！？、,.!?：:]{1,8})[：:](.+)$/);
    const parsed = m ? { speaker: m[1].trim(), text: m[2].trim() } : { speaker: "旁白", text: line };
    // 保留旧行的 closeup 字段（按行号对齐，行数变化时尽力保留）
    if (old[i] && old[i].closeup_prompt_en) parsed.closeup_prompt_en = old[i].closeup_prompt_en;
    return parsed;
  }).filter(l => l.text);
}

function renderScenes() {
  const box = $("#scenes");
  box.innerHTML = "";
  const hasPending = current.chapters.some(c => c.status !== "ready");
  $("#btn-resume").classList.toggle("hidden", !hasPending);

  current.chapters.forEach((ch, cidx) => {
    const head = document.createElement("div");
    head.className = "chapter-head";
    const stMap = { ready: ["✓ 就绪", "st-ok"], imaging: ["配图中…", "st-run"], pending: ["排队中…", "st-run"], error: ["生成失败", "st-err"] };
    const [stTxt, stCls] = stMap[ch.status] || [ch.status, "st-run"];
    head.innerHTML = `
      <b>第${cidx + 1}章 · ${esc(ch.title)}</b>
      <span class="tag ${stCls}">${stTxt}</span>
      <span class="hint">${ch.scenes.length} 幕 · ${ch.scenes.filter(s => s.image_file).length} 图</span>
      <label class="hint" style="margin-left:auto">本章画风</label>
      <select>${['<option value="">跟随全书</option>'].concat(
        STYLES.map(s => `<option value="${s.id}" ${s.id === ch.style ? "selected" : ""}>${s.name}</option>`)).join("")}</select>`;
    head.querySelector("select").onchange = async e => {
      await api(`/api/project/${current.id}/chapter/${ch.id}/style`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style: e.target.value || null })
      });
      ch.style = e.target.value || null;
    };
    box.appendChild(head);

    ch.scenes.forEach((sc, i) => {
      const div = document.createElement("div");
      div.className = "scene";
      const imgUrl = sc.image_file ? `/projects/${current.id}/${sc.image_file}?t=${Date.now()}` : "";
      const shotTag = sc.shot === "wide" ? '<span class="tag" style="background:#27402e;color:#88e0a0">全景建立</span>'
        : sc.shot === "close" ? '<span class="tag" style="background:#3d2b52;color:#cdafff">特写镜头</span>'
        : '<span class="tag" style="background:#333c4e;color:#9aa3b2">旧版</span>';
      const regenTxt = sc.shot === "wide" ? "🔄 重出地点图" : "🔄 重新出图";
      div.innerHTML = `
        <div>
          ${imgUrl ? `<img src="${imgUrl}">` : '<div class="noimg">未生成</div>'}
          <div class="tools">
            <button class="ghost mini" data-act="regen">${regenTxt}</button>
            <span class="spin" data-role="busy"></span>
          </div>
        </div>
        <div>
          <div style="display:flex;gap:10px;align-items:center">
            <b>#${i + 1}</b>
            ${shotTag}
            <span class="tag mood-cat" style="background:${CAT_COLORS[MOOD_TO_CAT[sc.mood] || "静思"]}33;color:${CAT_COLORS[MOOD_TO_CAT[sc.mood] || "静思"]}">${MOOD_TO_CAT[sc.mood] || "静思"}</span>
            <span class="tag mood-sub">${sc.mood}</span>
            <span class="hint">${sc.loc_name ? "📍" + esc(sc.loc_name) : ""}</span>
            <span class="hint">${sc.music_track ? "🎵 " + esc(sc.music_track.split(/[\\/]/).pop()) : "未配乐"}</span>
          </div>
          <label>本镜头台词（每行一句；行首「人名：」为对白，不写为旁白）</label>
          <textarea rows="4" data-f="lines" placeholder="林晚：你来了。&#10;她没有回答，只是望着海面。">${esc(linesToRaw(sc.lines))}</textarea>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label>景别（特写为主；全景仅用于新地点/广阔风景）</label>
              <select data-f="shot">
                <option value="" ${!sc.shot ? "selected" : ""}>旧版·整幕图</option>
                <option value="close" ${sc.shot === "close" ? "selected" : ""}>close 特写</option>
                <option value="wide" ${sc.shot === "wide" ? "selected" : ""}>wide 全景建立</option>
              </select>
            </div>
            <div>
              <label>地点（同地点共用一张大背景）</label>
              <input type="text" data-f="loc_name" value="${esc(sc.loc_name || "")}" placeholder="如：杰氏酒吧吧台">
            </div>
          </div>
          <label>情绪</label>
          <select data-f="mood">${MOOD_CATS.map(cat => {
            const subs = MOODS.filter(m => MOOD_TO_CAT[m] === cat);
            return `<optgroup label="${cat}">${subs.map(m =>
              `<option ${m === sc.mood ? "selected" : ""}>${m}</option>`).join("")}</optgroup>`;
          }).join("")}</select>
          <label>背景动画</label>
          <select data-f="anim">${Object.entries(ANIM_NAMES).map(([k, v]) =>
            `<option value="${k}" ${k === (sc.anim || "") ? "selected" : ""}>${v}</option>`).join("")}</select>
          <label>${sc.shot === "wide" ? "地点全景提示词（英文，同一地点全书一致）" : "镜头画面提示词（英文，特写构图；不露脸/禁全身约束自动追加）"}</label>
          <textarea rows="2" data-f="scene_prompt_en">${esc(sc.scene_prompt_en)}</textarea>
          <details style="margin-top:6px">
            <summary class="hint" style="cursor:pointer">物品特写提示词（提到关键道具时填，播放时即切即回）</summary>
            ${(sc.lines || []).map((ln, li) => `
              <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
                <span class="hint" style="min-width:60px">${esc((ln.speaker || "").slice(0,4))}：${esc((ln.text || "").slice(0,16))}</span>
                <input type="text" data-li="${li}" data-f="closeup_prompt_en"
                  placeholder="如：extreme close-up of a pinball machine steel ball"
                  value="${esc(ln.closeup_prompt_en || "")}"
                  style="flex:1;font-size:12px;padding:3px 6px;background:#1a2030;border:1px solid #3a4258;border-radius:4px;color:#cfd6e4">
              </div>`).join("")}
          </details>
          <details style="margin-top:6px">
            <summary class="hint" style="cursor:pointer">高级：地点标识与全景提示词（一般无需手改）</summary>
            <label>loc_id（英文标识；改了会被当作新地点另出背景图）</label>
            <input type="text" data-f="loc_id" value="${esc(sc.loc_id || "")}" placeholder="如：j_bar"
              style="font-size:12px;padding:5px 8px;background:#1a2030;border:1px solid #3a4258;border-radius:4px;color:#cfd6e4">
            <label>bg_prompt_en（地点环境全景，同 loc_id 需逐字一致）</label>
            <textarea rows="2" data-f="bg_prompt_en">${esc(sc.bg_prompt_en || "")}</textarea>
          </details>
        </div>`;
      div.querySelectorAll("[data-f]").forEach(inp => {
        inp.onchange = async () => {
          let body = {};
          if (inp.dataset.f === "lines") {
            const lines = parseLines(inp.value, sc.lines);
            if (!lines.length) { alert("至少保留一句话"); inp.value = linesToRaw(sc.lines); return; }
            body = { lines };
          } else if (inp.dataset.f === "closeup_prompt_en") {
            // 更新某行的 closeup_prompt_en
            const li = parseInt(inp.dataset.li);
            const lines = [...(sc.lines || [])];
            if (lines[li]) {
              lines[li] = { ...lines[li], closeup_prompt_en: inp.value.trim() || null };
              body = { lines };
            }
          } else {
            // 景别占位项（旧版整幕图）不提交；loc 字段允许清空（提交 null）
            if (inp.dataset.f === "shot" && !inp.value) return;
            body[inp.dataset.f] = inp.value.trim ? inp.value.trim() : inp.value;
          }
          try {
            const updated = await api(`/api/project/${current.id}/chapter/${ch.id}/scene/${sc.id}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            Object.assign(sc, updated);
          } catch (e) {
            alert(e.message);
            inp.value = linesToRaw(sc.lines);
            return;
          }
          if (inp.dataset.f === "mood") renderScenes();
        };
      });
      div.querySelector('[data-act="regen"]').onclick = async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        div.querySelector('[data-role="busy"]').textContent = "出图中…（约1分钟）";
        try {
          await api(`/api/project/${current.id}/chapter/${ch.id}/scene/${sc.id}/regen`, { method: "POST" });
          await loadProject(current.id);
        } catch (e) {
          div.querySelector('[data-role="busy"]').innerHTML = '<span class="err">' + esc(e.message) + "</span>";
          btn.disabled = false;
        }
      };
      box.appendChild(div);
    });
  });
}

// ---------- 文档上传（.docx / .txt） ----------
async function uploadStoryFile(file) {
  if (!file) return;
  if (!/\.(txt|docx)$/i.test(file.name)) return alert("仅支持 .txt 和 .docx 文件（旧版 .doc 请先用 Word/WPS 另存为 .docx）");
  if (file.size > 32 * 1024 * 1024) return alert("文件过大（上限 32MB）");
  const btn = $("#btn-upload");
  btn.disabled = true;
  $("#upload-hint").textContent = `正在读取「${file.name}」…`;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const resp = await fetch("/api/text/extract", { method: "POST", body: fd });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || resp.statusText);
    const r = await resp.json();
    $("#story-text").value = r.text;
    if (!$("#story-title").value.trim()) $("#story-title").value = r.title;
    $("#upload-hint").textContent = `✅ 已导入「${file.name}」，共 ${r.chars} 字，可在下方检查修改后再生成分镜`;
  } catch (e) {
    $("#upload-hint").textContent = "";
    alert("导入失败：" + e.message);
  } finally {
    btn.disabled = false;
    $("#file-input").value = "";
  }
}
$("#btn-upload").onclick = () => $("#file-input").click();
$("#file-input").onchange = e => uploadStoryFile(e.target.files[0]);

// 拖拽文件到文本框
const storyTa = $("#story-text");
["dragenter", "dragover"].forEach(ev =>
  storyTa.addEventListener(ev, e => { e.preventDefault(); storyTa.classList.add("dragover"); }));
storyTa.addEventListener("dragleave", e => { e.preventDefault(); storyTa.classList.remove("dragover"); });
storyTa.addEventListener("drop", e => {
  e.preventDefault();
  storyTa.classList.remove("dragover");
  if (e.dataTransfer.files[0]) uploadStoryFile(e.dataTransfer.files[0]);
});

$("#btn-split").onclick = async () => {
  const text = $("#story-text").value.trim();
  if (text.length < 20) return alert("请先粘贴至少 20 字的正文");
  const btn = $("#btn-split");
  btn.disabled = true;
  $("#split-hint").textContent = "AI 正在分章并拆第一章分镜（qwen3:8b，约 30~90 秒）…";
  try {
    const r = await api("/api/project/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        title: $("#story-title").value.trim() || null,
        style: $("#story-style").value,
        genre: $("#story-genre") ? $("#story-genre").value : "通用",
      })
    });
    current = r.manifest;
    $("#split-hint").textContent =
      `共 ${current.chapters.length} 章，第一章已拆出 ${current.chapters[0].scenes.length} 幕，后续章节边玩边生成`;
    await loadProject(current.id);
    // 监控整书生成管线：逐章就绪时刷新界面
    let lastSig = chapterSignature(current);
    let reloading = false;
    watchJob(r.job_id, $("#create-job-bar"), $("#create-job-bar .job-fill"), $("#create-job-text"),
      async () => { await loadProject(current.id); },
      async () => {
        if (reloading) return;
        reloading = true;
        try {
          const fresh = await api(`/api/project/${current.id}`);
          if (chapterSignature(fresh) !== lastSig) {
            lastSig = chapterSignature(fresh);
            current = fresh;
            renderScenes();
            refreshProjectList();
          }
        } finally { reloading = false; }
      });
  } catch (e) {
    $("#split-hint").innerHTML = '<span style="color:var(--err)">' + esc(e.message) + "</span>";
  } finally {
    btn.disabled = false;
  }
};

$("#btn-gen-all").onclick = async () => {
  const { job_id } = await api(`/api/project/${current.id}/generate-images?only_missing=true`, { method: "POST" });
  watchJob(job_id, $("#job-bar"), $("#job-bar .job-fill"), $("#job-text"), async ok => {
    if (ok) await loadProject(current.id);
  });
};

$("#btn-resume").onclick = async () => {
  const r = await api(`/api/project/${current.id}/resume`, { method: "POST" });
  if (!r.job_id) return alert(r.msg);
  let lastSig = chapterSignature(current);
  let reloading = false;
  watchJob(r.job_id, $("#job-bar"), $("#job-bar .job-fill"), $("#job-text"),
    async () => { await loadProject(current.id); },
    async () => {
      if (reloading) return;
      reloading = true;
      try {
        const fresh = await api(`/api/project/${current.id}`);
        if (chapterSignature(fresh) !== lastSig) {
          lastSig = chapterSignature(fresh);
          current = fresh;
          renderScenes();
        }
      } finally { reloading = false; }
    });
};

$("#btn-assign-music").onclick = async () => {
  try {
    const r = await api(`/api/project/${current.id}/assign-music`, { method: "POST" });
    await loadProject(current.id);
    alert(`已为 ${r.assigned} 个场景按情绪配好音乐`);
  } catch (e) { alert(e.message); }
};

$("#btn-go-play").onclick = async () => {
  await refreshPlayList();
  $("#play-project").value = current.id;
  $$(".tab").find(x => x.dataset.tab === "play").click();
};

// ============ 音乐库 ============
const MOODS = ["平静", "温柔", "轻松", "休闲", "甜蜜", "希望", "宿命", "欢快", "悲伤", "紧张", "激昂"];
const MOOD_CATS = ["静思", "沉郁", "紧绷", "激荡", "舒展"];
const MOOD_TO_CAT = {
  "平静": "静思", "温柔": "静思", "轻松": "静思", "休闲": "静思", "甜蜜": "静思",
  "悲伤": "沉郁", "紧张": "紧绷", "宿命": "紧绷", "激昂": "激荡", "希望": "舒展", "欢快": "舒展"
};
const CAT_COLORS = {"静思": "#6ea8fe", "沉郁": "#5f86d8", "紧绷": "#f06c75", "激荡": "#b48cff", "舒展": "#ffd44d"};
const MOOD_COLORS = CAT_COLORS;  // 兼容旧引用
let previewAudio = null;  // 音乐库试听播放器

// 作品类型：音乐库按类型筛选，配曲时优先匹配该类型，不足从"通用"补
const GENRES = ["中国玄幻", "西方奇幻", "轻小说", "严肃文学", "悬疑推理", "古风言情", "科幻", "都市日常", "通用"];
function genreOptions(selected) {
  return GENRES.map(g => `<option value="${g}" ${g === selected ? "selected" : ""}>${g}</option>`).join("");
}
// 多选复选框
function genreChecks(selected) {
  return GENRES.map(g =>
    `<label style="font-size:12px;margin-right:8px;cursor:pointer"><input type="checkbox" value="${g}" ${selected.includes(g) ? "checked" : ""}> ${g}</label>`
  ).join("");
}

// 细情绪→大类（兼容旧数据里直接存大类的情况）
function catOf(mood) { return MOOD_TO_CAT[mood] || (MOOD_CATS.includes(mood) ? mood : "静思"); }
// 按大类分组的细情绪 <option>
function moodOptions(selected) {
  return MOOD_CATS.map(cat => {
    const subs = MOODS.filter(m => MOOD_TO_CAT[m] === cat);
    return `<optgroup label="${cat}">${subs.map(m =>
      `<option value="${m}" ${m === selected ? "selected" : ""}>${m}</option>`).join("")}</optgroup>`;
  }).join("");
}
// 按大类分组的细情绪复选框
function moodChecks(selected) {
  return MOOD_CATS.map(cat => {
    const subs = MOODS.filter(m => MOOD_TO_CAT[m] === cat);
    return `<span style="margin-right:10px"><b style="color:${CAT_COLORS[cat]};font-size:11px">${cat}</b>：` +
      subs.map(m => `<label style="font-size:12px;margin-right:6px;cursor:pointer"><input type="checkbox" value="${m}" ${selected.includes(m) ? "checked" : ""}> ${m}</label>`).join("") +
      `</span>`;
  }).join("");
}

function segRow(s, i, dur) {
  const startLbl = dur ? `${Math.round((s.start||0)*dur)}s` : "";
  const endLbl = (s.end && dur) ? `${Math.round(s.end*dur)}s` : "";
  return `<div class="seg-item" data-i="${i}" style="display:flex;gap:6px;align-items:center;margin:4px 0">
    <select class="seg-mood">${moodOptions(s.mood || "平静")}</select>
    <input type="number" class="seg-start" min="0" max="1" step="0.01" value="${s.start||0.35}" style="width:60px" title="起播比例">
    <span style="font-size:11px;color:#6a7080">→</span>
    <input type="number" class="seg-end" min="0" max="1" step="0.01" value="${s.end||0.6}" style="width:60px" title="结束比例">
    <span class="hint" style="min-width:80px">${startLbl}→${endLbl}</span>
    <button class="ghost btn-del-seg" style="padding:2px 6px">✕</button>
  </div>`;
}

async function renderMusic() {
  const lib = await api("/api/music/library");
  const tbody = $("#music-table tbody");
  tbody.innerHTML = "";
  const counts = {};       // 细情绪计数
  const catCounts = {};    // 大类计数
  for (const t of lib) {
    counts[t.mood] = (counts[t.mood] || 0) + 1;
    const cat = catOf(t.mood);
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    const tr = document.createElement("tr");
    const bars = MOOD_CATS.map(c => {
      const v = Math.round((t.scores[c] || 0) * 100);
      const isPeak = c === cat;
      return `<i class="${isPeak ? "peak" : ""}" style="height:${Math.max(6, v)}%;background:${isPeak ? CAT_COLORS[c] : ""}" title="${c} ${v}"></i>`;
    }).join("");
    const vol = t.volume != null ? t.volume : 1.0;
    const segs = t.segments || [];
    const moods = t.moods || [t.mood];
    const genres = t.genres || ["通用"];
    const dur = (t.features || {}).duration || 0;
    const cc = CAT_COLORS[cat] || "#333";
    tr.innerHTML = `
      <td><input type="checkbox" class="row-sel" data-path="${esc(t.path)}"></td>
      <td>
        <div style="display:flex;flex-direction:column;gap:2px">
          <span class="tag mood-cat" style="background:${cc}22;color:${cc};align-self:flex-start">${cat}</span>
          <select class="input mood-sel" data-path="${esc(t.path)}" style="background:${cc}22;color:${cc};border-color:${cc}55">${moodOptions(t.mood)}</select>
        </div>
      </td>
      <td class="genre-cell" data-path="${esc(t.path)}">
        <div style="display:flex;flex-wrap:wrap;gap:3px;max-width:160px">
          ${genres.map(g => `<span class="tag genre-tag" style="background:#3a3f4e22;color:#9aa3b2;align-self:flex-start">${esc(g)}</span>`).join("") || `<span style="color:#6a7080">—</span>`}
        </div>
      </td>
      <td title="${esc(t.path)}">${esc(t.path.split(/[\\/]/).pop())}</td>
      <td>${t.features.tempo}</td>
      <td><div class="bars">${bars}</div></td>
      <td class="music-ops">
        <button class="ghost btn-preview" data-path="${esc(t.path)}">试听</button>
        <button class="ghost btn-edit" data-path="${esc(t.path)}">编辑</button>
        <button class="ghost btn-del" data-path="${esc(t.path)}" data-name="${esc(t.path.split(/[\\/]/).pop())}">删除</button>
      </td>`;
    tbody.appendChild(tr);

    // 展开式编辑行（默认隐藏）
    const editTr = document.createElement("tr");
    editTr.className = "music-edit-row hidden";
    editTr.innerHTML = `<td colspan="7">
      <div style="display:flex;gap:16px;flex-wrap:wrap;padding:8px 4px">
        <div>
          <label style="font-size:11px;color:#9aa3b2">音量</label>
          <input type="range" class="track-vol" data-path="${esc(t.path)}"
            min="0" max="1" step="0.05" value="${vol}"
            style="width:120px;vertical-align:middle">
          <span class="track-vol-val" style="font-size:11px;color:#9aa3b2">${Math.round(vol*100)}%</span>
        </div>
        <div style="flex:1;min-width:300px">
          <label style="font-size:11px;color:#9aa3b2">多情绪标签（勾选多个细情绪，同大类内共用 BGM）</label>
          <div class="mood-checks" data-path="${esc(t.path)}" style="line-height:1.9">
            ${moodChecks(moods)}
          </div>
        </div>
        <div style="flex:1;min-width:300px">
          <label style="font-size:11px;color:#9aa3b2">作品类型（勾选多个，配曲时按作品类型优先匹配该类型曲目）</label>
          <div class="genre-checks" data-path="${esc(t.path)}" style="line-height:1.9">
            ${genreChecks(genres)}
          </div>
        </div>
      </div>
      <div style="margin-top:8px">
        <label style="font-size:11px;color:#9aa3b2">播放段落（可指定多个，每个段落关联一个细情绪，起止用比例 0~1）</label>
        <div class="seg-list" data-path="${esc(t.path)}">
          ${segs.length ? segs.map((s, i) => segRow(s, i, dur)).join("") : segRow({start: 0.35, end: 0.6, mood: t.mood}, 0, dur)}
        </div>
        <button class="ghost btn-add-seg" data-path="${esc(t.path)}" style="margin-top:4px">+ 添加段落</button>
      </div>
    </td>`;
    tbody.appendChild(editTr);
  }
  $("#music-summary").innerHTML = lib.length
    ? `<b>共 ${lib.length} 首</b>　` + MOOD_CATS.map(c =>
        `<span style="color:${CAT_COLORS[c]}">${c} ${catCounts[c] || 0}</span>`).join("　")
      + `<div style="margin-top:4px;font-size:11px;color:#9aa3b2">` +
        MOOD_CATS.map(cat => {
          const subs = MOODS.filter(m => MOOD_TO_CAT[m] === cat);
          return `<span style="color:${CAT_COLORS[cat]}">${cat}</span>：` +
            subs.map(m => `${m} ${counts[m] || 0}`).join("/");
        }).join("　") + `</div>`
    : "尚未建立音乐库。";

  // 情绪下拉修改
  tbody.querySelectorAll(".mood-sel").forEach(sel => {
    sel.onchange = async () => {
      sel.disabled = true;
      try {
        await api("/api/music/track", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sel.dataset.path, mood: sel.value })
        });
      } catch (e) { alert(e.message); }
      sel.disabled = false;
    };
  });
  // 试听
  tbody.querySelectorAll(".btn-preview").forEach(btn => {
    btn.onclick = () => {
      const path = btn.dataset.path;
      if (previewAudio && !previewAudio.paused) {
        previewAudio.pause();
        if (btn.dataset.playing === "1") {
          btn.dataset.playing = "";
          btn.textContent = "试听";
          return;
        }
      }
      tbody.querySelectorAll(".btn-preview").forEach(b => {
        b.dataset.playing = ""; b.textContent = "试听";
      });
      if (!previewAudio) previewAudio = new Audio();
      previewAudio.src = "/audio?path=" + encodeURIComponent(path);
      previewAudio.play().catch(() => alert("无法播放该文件"));
      btn.dataset.playing = "1";
      btn.textContent = "停止";
      previewAudio.onended = () => { btn.dataset.playing = ""; btn.textContent = "试听"; };
    };
  });
  // 删除
  tbody.querySelectorAll(".btn-del").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm(`确认从曲库移除「${btn.dataset.name}」？\n（不会删除硬盘上的文件）`)) return;
      try {
        await api("/api/music/track?path=" + encodeURIComponent(btn.dataset.path), { method: "DELETE" });
        renderMusic();
      } catch (e) { alert(e.message); }
    };
  });
  // 编辑面板展开/收起
  tbody.querySelectorAll(".btn-edit").forEach(btn => {
    btn.onclick = () => {
      const tr = btn.closest("tr");
      const editTr = tr.nextElementSibling;
      const isHidden = editTr.classList.contains("hidden");
      editTr.classList.toggle("hidden");
      btn.textContent = isHidden ? "收起" : "编辑";
    };
  });
  // 音量滑块
  tbody.querySelectorAll(".track-vol").forEach(slider => {
    slider.onchange = async () => {
      const val = parseFloat(slider.value);
      slider.parentElement.querySelector(".track-vol-val").textContent = Math.round(val*100) + "%";
      try {
        await api("/api/music/track", { method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: slider.dataset.path, volume: val }) });
      } catch (e) { alert(e.message); }
    };
  });
  // 多情绪标签
  tbody.querySelectorAll(".mood-checks").forEach(box => {
    box.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.onchange = async () => {
        const moods = [...box.querySelectorAll('input:checked')].map(x => x.value);
        try {
          await api("/api/music/track", { method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: box.dataset.path, moods }) });
        } catch (e) { alert(e.message); }
      };
    });
  });
  // 作品类型多选
  tbody.querySelectorAll(".genre-checks").forEach(box => {
    box.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.onchange = async () => {
        const genres = [...box.querySelectorAll('input:checked')].map(x => x.value);
        try {
          await api("/api/music/track", { method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: box.dataset.path, genres }) });
          // 局部刷新该行的类型标签显示
          const cell = tbody.querySelector(`.genre-cell[data-path="${box.dataset.path}"]`);
          if (cell) {
            const tags = (genres.length ? genres : ["通用"]);
            cell.querySelector("div").innerHTML = tags.map(g =>
              `<span class="tag genre-tag" style="background:#3a3f4e22;color:#9aa3b2;align-self:flex-start">${esc(g)}</span>`).join("");
          }
        } catch (e) { alert(e.message); }
      };
    });
  });
  // 段落：添加
  tbody.querySelectorAll(".btn-add-seg").forEach(btn => {
    btn.onclick = async () => {
      const list = btn.parentElement.querySelector(".seg-list");
      const idx = list.children.length;
      const dur = 0; // 不知时长时标签留空
      list.insertAdjacentHTML("beforeend", segRow({start:0.35,end:0.6,mood:"静思"}, idx, dur));
      bindSegEvents(list);
    };
  });
  // 段落：初始绑定
  tbody.querySelectorAll(".seg-list").forEach(list => bindSegEvents(list));
  // 段落保存
  function bindSegEvents(list) {
    list.querySelectorAll(".seg-item").forEach(item => {
      item.querySelectorAll("input,select").forEach(inp => {
        inp.onchange = () => saveSegs(list);
      });
      item.querySelector(".btn-del-seg")?.addEventListener("click", () => {
        if (list.children.length <= 1) return alert("至少保留一个段落");
        item.remove();
        saveSegs(list);
      });
    });
  }
  async function saveSegs(list) {
    const segs = [...list.querySelectorAll(".seg-item")].map(item => ({
      mood: item.querySelector(".seg-mood").value,
      start: parseFloat(item.querySelector(".seg-start").value) || 0.35,
      end: parseFloat(item.querySelector(".seg-end").value) || 0.6,
    }));
    try {
      await api("/api/music/track", { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: list.dataset.path, segments: segs }) });
    } catch (e) { alert(e.message); }
  }
  // 行复选框 → 更新计数和按钮状态
  updateSelState();
}

// ============ 批量操作 ============
function selectedPaths() {
  return $$(".row-sel:checked").map(cb => cb.dataset.path);
}
function updateSelState() {
  const n = selectedPaths().length;
  $("#sel-count").textContent = `已选 ${n} 首`;
  $("#btn-batch-edit").disabled = n === 0;
  $("#btn-batch-del").disabled = n === 0;
  const all = $("#chk-all");
  const boxes = $$(".row-sel");
  if (all) all.checked = boxes.length > 0 && n === boxes.length;
}
// 初始化批量编辑面板的选项（首次进入音乐库时填充）
function initBatchPanel() {
  if (!$("#be-mood").innerHTML) {
    // 情绪大类下拉（带"请选择"占位）
    $("#be-mood").innerHTML = MOOD_CATS.map(c =>
      `<option value="${c}">${c}</option>`).join("");
  }
  if (!$(".genre-batch-checks").innerHTML) {
    $(".genre-batch-checks").innerHTML = GENRES.map(g =>
      `<label style="font-size:12px;margin-right:8px;cursor:pointer"><input type="checkbox" value="${g}"> ${g}</label>`
    ).join("");
  }
}
// 委托：行复选框变化
document.addEventListener("change", e => {
  if (e.target.classList.contains("row-sel")) updateSelState();
});
$("#chk-all").onchange = () => {
  $$(".row-sel").forEach(cb => cb.checked = $("#chk-all").checked);
  updateSelState();
};
$("#btn-inv").onclick = () => {
  $$(".row-sel").forEach(cb => cb.checked = !cb.checked);
  updateSelState();
};
$("#btn-clr").onclick = () => {
  $$(".row-sel").forEach(cb => cb.checked = false);
  updateSelState();
};
$("#btn-batch-edit").onclick = () => {
  initBatchPanel();
  $("#batch-edit-panel").classList.remove("hidden");
};
$("#btn-be-cancel").onclick = () => $("#batch-edit-panel").classList.add("hidden");
$("#btn-be-apply").onclick = async () => {
  const paths = selectedPaths();
  if (!paths.length) return alert("请先勾选曲目");
  const applyGenre = $("#be-apply-genre").checked;
  const applyMood = $("#be-apply-mood").checked;
  if (!applyGenre && !applyMood) return alert("至少勾选一个要应用的字段");
  const body = { paths };
  if (applyGenre) {
    body.genres = $$(".genre-batch-checks input:checked").map(x => x.value);
    if (!body.genres.length) return alert("至少勾选一个作品类型");
  }
  if (applyMood) body.mood = $("#be-mood").value;
  try {
    const r = await api("/api/music/batch-edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    alert(`已批量修改 ${r.updated} 首曲目`);
    $("#batch-edit-panel").classList.add("hidden");
    renderMusic();
  } catch (e) { alert(e.message); }
};
$("#btn-batch-del").onclick = async () => {
  const paths = selectedPaths();
  if (!paths.length) return alert("请先勾选曲目");
  if (!confirm(`确认从曲库移除选中的 ${paths.length} 首曲目？\n（不会删除硬盘上的文件，但会记住已删除防止重扫恢复）`)) return;
  try {
    const r = await api("/api/music/batch-delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths })
    });
    alert(`已删除 ${r.deleted} 首，曲库剩余 ${r.remaining} 首`);
    renderMusic();
  } catch (e) { alert(e.message); }
};

$("#btn-scan").onclick = async () => {
  const folder = $("#music-folder").value.trim();
  if (!folder) return alert("请粘贴音乐文件夹路径");
  $("#btn-scan").disabled = true;
  try {
    const { job_id } = await api("/api/music/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder })
    });
    watchJob(job_id, $("#music-job-bar"), $("#music-job-bar .job-fill"), $("#music-job-text"), ok => {
      $("#btn-scan").disabled = false;
      if (ok) renderMusic();
    });
  } catch (e) {
    alert(e.message);
    $("#btn-scan").disabled = false;
  }
};

// ============ 播放器 ============
async function refreshPlayList() {
  const list = await api("/api/project/list");
  const sel = $("#play-project");
  const keep = sel.value;
  sel.innerHTML = list.map(p =>
    `<option value="${p.id}">${esc(p.title)}（${p.ready}/${p.chapters}章 ${p.images}/${p.scenes}图）</option>`).join("");
  if (keep) sel.value = keep;
  updatePlayNote();
}

function updatePlayNote() {
  const el = $("#play-gen-note");
  const sel = $("#play-project");
  const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
  el.textContent = opt ? `已选：${opt.textContent}（章节若仍在生成，可边玩边等）` : "";
}
$("#play-project").addEventListener("change", updatePlayNote);

const player = {
  manifest: null, flat: [], idx: 0, li: 0, typing: false, autoT: null, pollT: null,
  muted: false, audio: [new Audio(), new Audio()], cur: 0, currentTrack: null,
  trackStartedAt: 0, trackVolume: 1.0,
  autoplay: localStorage.getItem("vn_autoplay") === "1",
  speed: parseFloat(localStorage.getItem("vn_auto_speed") || "1"),
  saveT: null,
  backlog: [],          // 已播放句子历史 [{speaker,text,chTitle,flatIdx,li}]
  readKeys: new Set(),  // 已读句键集合（按作品持久化）
  skipping: false, skipT: null,
  prevCat: null,        // 上一场景情绪大类（用于骤停判定）
  curLoc: null,         // 当前地点 key（同地点不换 L1 大背景）
  bgToken: 0, lensToken: 0,  // 背景/镜头层连切竞态令牌
};

// 通用播放设置（任意作品通用，存 localStorage）
const SETTINGS = {
  fontSize: parseInt(localStorage.getItem("vn_font_size") || "20"),
  textSpeed: parseFloat(localStorage.getItem("vn_text_speed") || "1"),
  autoSpeed: parseFloat(localStorage.getItem("vn_auto_speed") || localStorage.getItem("vn_speed") || "1"),
  bgmVol: parseFloat(localStorage.getItem("vn_bgm_vol") ?? "1"),
};
player.speed = SETTINGS.autoSpeed;

function applySettings() {
  $("#narration").style.setProperty("--vn-fs", SETTINGS.fontSize + "px");
  $("#sel-speed").value = String(SETTINGS.autoSpeed);
  $("#st-fontsize").value = String(SETTINGS.fontSize);
  $("#st-textspeed").value = String(SETTINGS.textSpeed);
  $("#st-autospeed").value = String(SETTINGS.autoSpeed);
  $("#st-bgmvol").value = String(Math.round(SETTINGS.bgmVol * 100));
  $("#st-bgmvol-val").textContent = Math.round(SETTINGS.bgmVol * 100) + "%";
  refreshVolumes();
}
// 按当前设置重算正在播放的音频音量（淡变过程由 fadeAudio 每帧自行处理）
function refreshVolumes() {
  player.audio.forEach((a, i) => {
    if (a.paused) return;
    const base = (i === player.cur ? (player.trackVolume ?? 1) : 1) * SETTINGS.bgmVol;
    a.volume = player.muted ? 0 : base;
  });
}
const MIN_BGM_SECONDS = 45;          // 一首曲子最少播这么久才允许切换（旧作品逐幕配曲的保护）
player.audio.forEach(a => {
  a.preload = "auto"; a.loop = false;
  // 播完一遍后回到歌曲中段继续，不回安静的开头
  a.addEventListener("ended", () => {
    a.currentTime = Number.isFinite(a.duration) && a.duration > 20 ? a.duration * 0.4 : 30;
    a.play().catch(() => {});
  });
});
$("#sel-speed").value = String(player.speed);

function activeAudio() { return player.audio[player.cur]; }
function idleAudio() { return player.audio[1 - player.cur]; }

// 新曲子从约 35%~60% 处开始放（跳过开头铺垫，避免"还没声音就切歌"）
function startAtMiddle(a) {
  const set = () => {
    if (Number.isFinite(a.duration) && a.duration > 20) {
      a.currentTime = a.duration * (0.35 + Math.random() * 0.25);
    } else {
      a.currentTime = 30;
    }
  };
  if (a.readyState >= 1) set();
  else a.addEventListener("loadedmetadata", set, { once: true });
}

function fadeAudio(a, from, to, ms = 2500) {
  const maxVol = (a === activeAudio() ? (player.trackVolume ?? 1.0) : 1.0) * SETTINGS.bgmVol;
  const t0 = performance.now();
  a.volume = from * maxVol * (player.muted ? 0 : 1);
  (function step() {
    const k = Math.min(1, (performance.now() - t0) / ms);
    a.volume = (from + (to - from) * k) * maxVol * (player.muted ? 0 : 1);
    if (k < 1) requestAnimationFrame(step);
    else if (to === 0) { a.pause(); a.currentTime = 0; }
  })();
}

async function switchBGM(track, abrupt = false, force = false) {
  if (!track || track === player.currentTrack) return;
  // 最短停留保护（情绪骤然紧张的骤停切歌、快进结束后的补切除外）
  if (!abrupt && !force && player.currentTrack && (performance.now() - player.trackStartedAt) / 1000 < MIN_BGM_SECONDS) return;
  // 获取播放参数（起播比例、音量、段落）
  const sc = player.flat[player.idx]?.sc;
  const mood = sc?.mood || "平静";
  let info = { start: 0.35, volume: 1.0 };
  try {
    info = await api(`/api/music/play-info?path=${encodeURIComponent(track)}&mood=${encodeURIComponent(mood)}`);
  } catch {}
  player.currentTrack = track;
  player.trackStartedAt = performance.now();
  player.trackVolume = info.volume ?? 1.0;
  const old = activeAudio();
  const next = idleAudio();
  player.cur = 1 - player.cur;
  // 快速连跳/快进时该轨道可能还有上一曲未完成的下载：先彻底中止，
  // 避免挂起的媒体请求占满同域连接池（会把镜头图片请求一并饿死）
  next.pause();
  next.removeAttribute("src");
  next.load();
  next.src = "/audio?path=" + encodeURIComponent(track);
  next.volume = 0;
  // 按段落起播
  const setStart = () => {
    if (Number.isFinite(next.duration) && next.duration > 10) {
      next.currentTime = next.duration * (info.start ?? 0.35);
    }
  };
  if (next.readyState >= 1) setStart();
  else next.addEventListener("loadedmetadata", setStart, { once: true });
  if (abrupt) {
    // 骤停：旧曲瞬间掐断 → 约 0.7 秒静默 → 新曲急促淡入（"空气突然安静"手法）
    fadeAudio(old, old.volume, 0, 220);
    await new Promise(r => setTimeout(r, 700));
    if (player.currentTrack !== track) return;  // 期间又切走了
    next.play().catch(() => {});
    fadeAudio(next, 0, info.volume ?? 1.0, 1600);
  } else {
    next.play().catch(() => {});
    fadeAudio(next, 0, info.volume ?? 1.0);
    fadeAudio(old, old.volume, 0);
  }
}

function buildFlat() {
  const out = [];
  player.manifest.chapters.forEach((ch, cidx) => {
    if (ch.status !== "ready") return;
    ch.scenes.forEach((sc, si) => out.push({
      cidx, cid: ch.id, sid: sc.id, si, chLen: ch.scenes.length, chTitle: ch.title, sc,
    }));
  });
  player.flat = out;
}

function pickAnim(sc) {
  if (sc.anim) return sc.anim;
  const pool = MOOD_ANIM[sc.mood] || ["kenburns-in"];
  return pool[Math.floor(Math.random() * pool.length)];
}

function dwellMs(text) {
  return (1600 + text.length * 130) / SETTINGS.autoSpeed;
}

// ---------- 已读标记（按作品持久化，供"快进已读"使用） ----------
function readStorageKey() { return `vn_read_${player.manifest?.id || "_"}`; }
function loadReadSet() {
  try { player.readKeys = new Set(JSON.parse(localStorage.getItem(readStorageKey()) || "[]")); }
  catch { player.readKeys = new Set(); }
}
let readSaveT = null;
function saveReadSet() {
  clearTimeout(readSaveT);
  readSaveT = setTimeout(() => {
    try { localStorage.setItem(readStorageKey(), JSON.stringify([...player.readKeys].slice(-4000))); } catch {}
  }, 400);
}
function curReadKey() {
  const e = player.flat[player.idx];
  return e ? `${e.cid}:${e.sid}:${player.li}` : null;
}
function markCurrentRead() {
  const k = curReadKey();
  if (k && !player.readKeys.has(k)) { player.readKeys.add(k); saveReadSet(); }
}
function isCurrentRead() {
  const k = curReadKey();
  return k ? player.readKeys.has(k) : false;
}

function armAuto(ms) {
  clearTimeout(player.autoT);
  if (player.skipping) return;
  if (!player.autoplay || $("#stage").classList.contains("hidden")) return;
  player.autoT = setTimeout(() => nextStep(), ms);
}

const OLD_LINES_KEEP = 3;   // 屏幕上最多保留的旧句数

function showLine(i) {
  const sc = player.flat[player.idx].sc;
  const line = sc.lines[i];
  if (!line) return;
  const e = player.flat[player.idx];
  player.li = i;
  clearTimeout(player.autoT);
  markCurrentRead();

  // 记入历史记录（回跳重看同一句不重复记）
  const lastBl = player.backlog[player.backlog.length - 1];
  if (!lastBl || lastBl.flatIdx !== player.idx || lastBl.li !== i) {
    player.backlog.push({
      speaker: line.speaker, text: line.text,
      chTitle: e.chTitle, flatIdx: player.idx, li: i,
    });
    if (player.backlog.length > 1000) player.backlog.shift();
  }

  // 特写图切换（防频闪）：连续 insert 句之间不切回背景，直接换图；
  // 只有当前句无 closeup 且下一句也无 closeup 时，才淡出回背景。
  const cu = $("#closeup-img");
  if (line.closeup_image) {
    cu.src = `/projects/${player.manifest.id}/${line.closeup_image}`;
    cu.classList.remove("hidden");
    requestAnimationFrame(() => cu.classList.add("show"));
  } else {
    // 检查下一句（同 scene 下一行 / 下一 scene 第一行）是否有 closeup
    const e = player.flat[player.idx];
    let nextHasCloseup = false;
    if (e) {
      if (player.li < e.sc.lines.length - 1) {
        nextHasCloseup = !!e.sc.lines[player.li + 1]?.closeup_image;
      } else {
        const next = player.flat[player.idx + 1];
        nextHasCloseup = !!next?.sc.lines[0]?.closeup_image;
      }
    }
    if (nextHasCloseup) {
      // 下一句有 closeup：保持当前 closeup 层状态（不淡出），避免物品→背景→物品频闪
      // closeup 层若是 show 则保持 show（显示上一个物品图），若是 hidden 则保持 hidden
    } else {
      // 下一句也无 closeup：淡出回背景
      cu.classList.remove("show");
      setTimeout(() => { if (!sc.lines[player.li]?.closeup_image) cu.classList.add("hidden"); }, 720);
    }
  }

  const nar = $("#narration");
  // 当前正在打字/已完整的那一行转为旧句
  const curEl = nar.querySelector(".vline.cur");
  if (curEl) {
    curEl.classList.remove("cur");
    curEl.classList.add("old");
  }
  // 旧句超出上限（转旧后 >3 条，即屏幕将超过"3旧+1当前"）：最旧的淡出移除
  if (nar.querySelectorAll(".vline.old").length > OLD_LINES_KEEP) {
    const el = nar.querySelectorAll(".vline.old")[0];
    el.classList.add("drop");
    setTimeout(() => el.remove(), 420);
  }

  // 说话人：对白显示名字，旁白留空
  const sp = $("#speaker");
  const isNar = line.speaker === "旁白";
  sp.textContent = isNar ? "" : line.speaker;
  sp.classList.toggle("nar", isNar);

  // 新行打字机
  const row = document.createElement("div");
  row.className = "vline cur";
  if (!isNar) {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = line.speaker + "：";
    row.appendChild(who);
  }
  const txt = document.createElement("span");
  txt.className = "txt";
  row.appendChild(txt);
  nar.appendChild(row);

  player.typing = true;
  let n = 0;
  const full = line.text;
  clearInterval(player.typingTimer);
  player.typingTimer = setInterval(() => {
    txt.textContent = full.slice(0, ++n);
    if (n >= full.length) {
      clearInterval(player.typingTimer);
      player.typing = false;
      armAuto(dwellMs(full));
    }
  }, Math.max(2, 34 / SETTINGS.textSpeed));
}

function completeTyping() {
  if (!player.typing) return;
  clearInterval(player.typingTimer);
  const sc = player.flat[player.idx].sc;
  const line = sc.lines[player.li];
  $("#narration").querySelectorAll(".vline.cur .txt").forEach(e => e.textContent = line.text);
  player.typing = false;
  armAuto(dwellMs(line.text));
}

function nextStep() {
  const e = player.flat[player.idx];
  if (!e) return;
  if (player.typing) { completeTyping(); return; }
  if (player.li < e.sc.lines.length - 1) { showLine(player.li + 1); return; }
  if (player.idx < player.flat.length - 1) showScene(player.idx + 1);
  else onFlatEnd();
}

function scheduleAuto(delay) { armAuto(delay); }  // 兼容轮询续播调用

function onFlatEnd() {
  const hasPending = player.manifest.chapters.some(c => c.status !== "ready");
  const toast = $("#gen-toast");
  if (hasPending) {
    toast.textContent = "后续章节仍在生成中，就绪后自动继续…";
    toast.classList.remove("hidden");
    startPoll();
  } else {
    toast.textContent = "— 全文完 —";
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 4000);
  }
}

function startPoll() {
  if (player.pollT) return;
  player.pollT = setInterval(async () => {
    if ($("#stage").classList.contains("hidden")) { stopPoll(); return; }
    try {
      const fresh = await api(`/api/project/${player.manifest.id}`);
      const hadPending = player.manifest.chapters.some(c => c.status !== "ready");
      player.manifest = fresh;
      const cur = player.flat[player.idx];
      buildFlat();
      if (cur) {
        const k = player.flat.findIndex(e => e.cid === cur.cid && e.sid === cur.sid);
        if (k >= 0) player.idx = k;
      }
      const stillPending = fresh.chapters.some(c => c.status !== "ready");
      if (hadPending && !stillPending) {
        $("#gen-toast").textContent = "后续章节已就绪";
        setTimeout(() => $("#gen-toast").classList.add("hidden"), 3000);
        stopPoll();
        if (player.autoplay) scheduleAuto(1200);
      }
      updateCounter();
    } catch {}
  }, 8000);
}
function stopPoll() { clearInterval(player.pollT); player.pollT = null; }

function updateCounter() {
  const e = player.flat[player.idx];
  if (e) {
    const cat = MOOD_TO_CAT[e.sc.mood] || "静思";
    const cc = CAT_COLORS[cat] || "#888";
    $("#scene-counter").innerHTML =
      `第${e.cidx + 1}章 ${e.si + 1}/${e.chLen} · 总 ${player.idx + 1}/${player.flat.length}` +
      ` <span style="background:${cc}22;color:${cc};padding:2px 6px;border-radius:4px;font-size:11px">${cat}</span>` +
      `<span style="color:#9aa3b2;font-size:11px;margin-left:2px">${e.sc.mood}</span>`;
  }
}

function saveProgress() {
  clearTimeout(player.saveT);
  player.saveT = setTimeout(() => {
    const e = player.flat[player.idx];
    if (!e) return;
    api(`/api/project/${player.manifest.id}/progress`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter: e.cid, scene: e.sid })
    }).catch(() => {});
  }, 700);
}

// ---------- 转场：按情绪大类自动选（对任意文本通用） ----------
// 静思/舒展→淡入；沉郁→黑场；紧绷→硬切；激荡→闪白
const CAT_TRANSITION = { "静思": "fade", "舒展": "fade", "沉郁": "black", "紧绷": "cut", "激荡": "white" };
const TRANSITION_TEXT_DELAY = { fade: 450, black: 950, cut: 120, white: 520 };

function retriggerFx(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;  // 强制重排以重启动画
  el.classList.add(cls);
  // 播完即摘掉类，避免长期挂在元素上；下次 retrigger 才能重新播放
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

// ---------- 三层画面：L1 地点大背景（同地点不动）/ L2 镜头特写 / L3 物品 insert ----------
function pidUrl(rel) { return rel ? `/projects/${player.manifest.id}/${rel}` : null; }

// 地点复用 key：新数据按 loc_id，旧数据退化为每幕独立
function sceneLocKey(sc) {
  return sc.loc_id ? `loc:${sc.loc_id}` : `scene:${sc.id}`;
}
// L1 当前地点应显示的图（优先书级 locations 缓存）
function sceneBgRel(sc) {
  if (sc.loc_id) {
    const rec = (player.manifest.locations || {})[sc.loc_id];
    if (rec && rec.image_file) return rec.image_file;
  }
  return sc.image_file || null;
}
// L2 仅 close 镜头有独立特写图；wide 建立镜头/旧数据返回 null（露出 L1）
function sceneLensRel(sc) {
  return sc.shot === "close" && sc.image_file ? sc.image_file : null;
}

function applyBg(sc, kind, url) {
  const a = $("#bg-a"), b = $("#bg-b");
  const shown = a.classList.contains("active") ? a : b;
  const hidden2 = shown === a ? b : a;
  const anim = pickAnim(sc);
  // 清掉上一幕的运镜动画类和硬切类，保留 active/nophoto
  [a, b].forEach(x => {
    x.className = x.className.replace(/anim-\S+|cut/g, "").trim();
  });
  // 令牌：快速连切（skip / backlog 跳转 / 连点）时，迟到的旧回调一律作废
  const token = (player.bgToken = (player.bgToken || 0) + 1);
  const swap = () => {
    if (token !== player.bgToken) return;
    if (kind === "cut" || kind === "white" || kind === "black") {
      [a, b].forEach(x => x.classList.add("cut"));
      hidden2.classList.add("active");
      shown.classList.remove("active");
      requestAnimationFrame(() => requestAnimationFrame(() =>
        [a, b].forEach(x => x.classList.remove("cut"))));
    } else {
      hidden2.classList.add("active");
      shown.classList.remove("active");
    }
  };
  if (!url) {
    [a, b].forEach(x => x.classList.add("nophoto"));
    if (kind === "black") retriggerFx($("#fx-black"), "run");
    if (kind === "white") retriggerFx($("#fx-white"), "run");
    return;
  }
  hidden2.classList.add("anim-" + anim);
  hidden2.classList.remove("nophoto");
  // 注意：必须先挂监听再赋 src；相同 URL 浏览器不会重发 load 事件
  const readyNow = hidden2.getAttribute("src") === url &&
                   hidden2.complete && hidden2.naturalWidth > 0;
  if (kind === "black") {
    // 黑幕合拢到全黑（约 380ms）且新图就绪后换图，观众看不见切换
    retriggerFx($("#fx-black"), "run");
    let imgReady = readyNow;
    let blackReady = false;
    const trySwap = () => { if (token === player.bgToken && imgReady && blackReady) swap(); };
    if (!readyNow) {
      hidden2.addEventListener("load", () => { imgReady = true; trySwap(); }, { once: true });
      // 图片出错也放行，避免黑幕永远合着；该层会显示坏图占位，不阻塞播放
      hidden2.addEventListener("error", () => { imgReady = true; trySwap(); }, { once: true });
      hidden2.src = url;
    }
    setTimeout(() => { blackReady = true; trySwap(); }, 380);
  } else {
    const doSwap = () => {
      if (token !== player.bgToken) return;
      swap();
      if (kind === "white") retriggerFx($("#fx-white"), "run");
    };
    if (readyNow) {
      doSwap();
    } else {
      hidden2.addEventListener("load", doSwap, { once: true });
      hidden2.addEventListener("error", doSwap, { once: true });
      hidden2.src = url;
      // 兜底：加载异常或卡住时也不能让背景永远停在旧幕
      setTimeout(() => { if (token === player.bgToken) doSwap(); }, 1500);
    }
  }
}

// L2 镜头层：双缓冲轻切。同地点内每次切镜头都走这里（0.45s 淡切/紧绷硬切）
function applyLens(sc, kind) {
  const a = $("#lens-a"), b = $("#lens-b");
  const shown = a.classList.contains("active") ? a : b;
  const hidden2 = shown === a ? b : a;
  [a, b].forEach(x => { x.className = x.className.replace(/anim-\S+|cut/g, "").trim(); });
  const token = (player.lensToken = (player.lensToken || 0) + 1);
  const url = pidUrl(sceneLensRel(sc));
  const swap = () => {
    if (token !== player.lensToken) return;
    const hard = kind === "cut" || kind === "white" || kind === "black";
    if (hard) [a, b].forEach(x => x.classList.add("cut"));
    if (url) {
      hidden2.classList.add("active");
      shown.classList.remove("active");
    } else {
      // wide 建立镜头：镜头层撤下，完整露出 L1 大背景
      a.classList.remove("active");
      b.classList.remove("active");
    }
    requestAnimationFrame(() => requestAnimationFrame(() =>
      [a, b].forEach(x => x.classList.remove("cut"))));
  };
  if (!url) { swap(); return; }
  hidden2.classList.add("anim-" + pickAnim(sc));
  const readyNow = hidden2.getAttribute("src") === url &&
                   hidden2.complete && hidden2.naturalWidth > 0;
  if (readyNow) { swap(); return; }
  hidden2.addEventListener("load", () => { if (token === player.lensToken) swap(); }, { once: true });
  hidden2.addEventListener("error", () => { if (token === player.lensToken) swap(); }, { once: true });
  hidden2.src = url;
  setTimeout(() => { if (token === player.lensToken) swap(); }, 1200);
}

// ---------- 氛围粒子：解析背景提示词里的天气（无匹配则不出现，纯通用） ----------
function applyWeather(promptEn) {
  const box = $("#fx-particles");
  const p = (promptEn || "").toLowerCase();
  let kind = null;
  if (/\b(rain|rainy|raining|drizzle|downpour|shower|storm)\b/.test(p)) kind = "rain";
  else if (/\b(snow|snowy|snowing|blizzard)\b/.test(p)) kind = "snow";
  else if (/\b(dust particles|floating dust|light rays|god rays|fireflies|firefly|embers|floating spores|pollen)\b/.test(p)) kind = "dust";
  box.className = "fx-particles";
  box.innerHTML = "";
  if (!kind) return;
  box.classList.add("p-" + kind);
  const N = kind === "rain" ? 48 : kind === "snow" ? 46 : 24;
  for (let i = 0; i < N; i++) {
    const s = document.createElement("span");
    s.style.left = (Math.random() * 100).toFixed(2) + "%";
    if (kind === "rain") {
      s.style.animationDuration = (0.42 + Math.random() * 0.4).toFixed(2) + "s";
      s.style.animationDelay = (-Math.random() * 1.2).toFixed(2) + "s";
      s.style.opacity = (0.35 + Math.random() * 0.4).toFixed(2);
    } else if (kind === "snow") {
      s.style.animationDuration = (6 + Math.random() * 7).toFixed(2) + "s";
      s.style.animationDelay = (-Math.random() * 10).toFixed(2) + "s";
      const sz = 3 + Math.random() * 4;
      s.style.width = s.style.height = sz.toFixed(1) + "px";
      s.style.opacity = (0.5 + Math.random() * 0.5).toFixed(2);
    } else {
      s.style.top = (Math.random() * 100).toFixed(2) + "%";
      s.style.animationDuration = (10 + Math.random() * 10).toFixed(2) + "s";
      s.style.animationDelay = (-Math.random() * 8).toFixed(2) + "s";
    }
    box.appendChild(s);
  }
}

function showScene(i, startLi = 0) {
  if (!player.flat.length) return;
  player.idx = Math.max(0, Math.min(player.flat.length - 1, i));
  const { sc } = player.flat[player.idx];
  const newCat = catOf(sc.mood);
  const kind = CAT_TRANSITION[newCat] || "fade";
  // 情绪骤然转入紧绷/激荡：BGM 骤停后再起
  const abruptBGM = !!player.currentTrack && player.prevCat &&
    player.prevCat !== newCat && (newCat === "紧绷" || newCat === "激荡");
  $("#gen-toast").classList.add("hidden");
  clearTimeout(player.autoT);
  clearTimeout(player.startTimer);
  clearInterval(player.typingTimer);
  player.typing = false;
  player.li = startLi;

  // L1 大背景：只有地点变化才换（走情绪转场）；同地点纹丝不动，靠 L2 特写切镜头
  const locKey = sceneLocKey(sc);
  const locChanged = locKey !== player.curLoc;
  player.curLoc = locKey;
  if (locChanged) applyBg(sc, kind, pidUrl(sceneBgRel(sc)));
  // L2 镜头层：每个镜头都切；同地点内轻快淡切，换地点随情绪转场
  const lensKind = locChanged ? kind
    : (kind === "cut" || kind === "white" || kind === "black" ? kind : "fade");
  applyLens(sc, lensKind);
  // 天气是地点属性：同地点不重刷粒子（避免闪烁）
  if (locChanged) applyWeather(sc.bg_prompt_en || sc.scene_prompt_en);
  $("#narration").classList.toggle("mood-tense", newCat === "紧绷");

  // 背景先现：清空文字，稍后再逐句播放（黑场等得久一些；同地点轻切节奏更快）
  $("#speaker").textContent = "";
  $("#narration").innerHTML = "";
  // 重置物品 insert 图层
  $("#closeup-img").classList.remove("show");
  $("#closeup-img").classList.add("hidden");
  const startLi0 = Math.max(0, Math.min(startLi, (sc.lines || []).length - 1));
  const textDelay = locChanged
    ? (TRANSITION_TEXT_DELAY[kind] ?? 450)
    : (kind === "cut" ? 110 : kind === "white" ? 320 : 230);
  player.lineReady = false;
  player.startTimer = setTimeout(() => {
    player.lineReady = true;
    if ((sc.lines || []).length) showLine(startLi0);
  }, textDelay);

  updateCounter();
  // 快进中不随镜头切歌（80ms 一跳，切歌毫无意义且会堆积媒体请求）；停下时补切到当前曲
  if (!player.skipping) switchBGM(sc.music_track, abruptBGM);
  player.prevCat = newCat;
  saveProgress();
}

function nextScene() {
  // 背景先现等待期：点击立即开始第一句
  if (player.lineReady === false) {
    clearTimeout(player.startTimer);
    player.lineReady = true;
    const sc = player.flat[player.idx].sc;
    if ((sc.lines || []).length) showLine(0);
    return;
  }
  nextStep();
}

async function startPlay(resume) {
  const pid = $("#play-project").value;
  if (!pid) return alert("请先创作一个作品");
  player.manifest = await api(`/api/project/${pid}`);
  buildFlat();
  if (!player.flat.length) return alert("还没有已就绪的章节，请等第一章生成完成");
  let start = 0;
  if (resume) {
    const p = player.manifest.progress || { chapter: 0, scene: 0 };
    const k = player.flat.findIndex(e => e.cid === p.chapter && e.sid === p.scene);
    if (k > 0) start = k;
  }
  $("#stage").classList.remove("hidden");
  player.audio.forEach(a => { a.pause(); a.currentTime = 0; });
  player.currentTrack = null;
  player.prevCat = null;
  player.curLoc = null;
  // 镜头层复位（大背景由首次 showScene 加载）
  ["#lens-a", "#lens-b"].forEach(s => {
    const el = $(s);
    el.className = "lens";
    el.removeAttribute("src");
  });
  $("#closeup-img").className = "closeup-img hidden";
  player.backlog = [];
  loadReadSet();
  stopSkip();
  $("#backlog-panel").classList.add("hidden");
  $("#settings-panel").classList.add("hidden");
  applySettings();
  updateAutoplayBtn();
  pokeUI();
  showScene(start);
  if (player.manifest.chapters.some(c => c.status !== "ready")) startPoll();
}

$("#btn-start-play").onclick = () => startPlay(true);
$("#btn-restart-play").onclick = () => startPlay(false);

$("#btn-exit").onclick = () => {
  $("#stage").classList.add("hidden");
  clearTimeout(player.autoT);
  clearTimeout(player.startTimer);
  clearInterval(player.typingTimer);
  stopSkip();
  stopPoll();
  $("#bookmark-panel").classList.add("hidden");
  $("#backlog-panel").classList.add("hidden");
  $("#settings-panel").classList.add("hidden");
  $("#fx-particles").className = "fx-particles";
  $("#fx-particles").innerHTML = "";
  player.audio.forEach(a => { a.pause(); });
};
$("#btn-next").onclick = nextScene;
$("#btn-prev").onclick = () => showScene(player.idx - 1);
$("#btn-mute").onclick = () => {
  player.muted = !player.muted;
  $("#btn-mute").textContent = player.muted ? "🔇" : "🔊";
  refreshVolumes();
};

// ---------- 自动播放 & 速度 ----------
function updateAutoplayBtn() {
  $("#btn-autoplay").textContent = player.autoplay ? "⏸" : "▶";
  $("#btn-autoplay").title = player.autoplay ? "自动播放中（点击暂停）(A)" : "自动播放（点击开启）(A)";
}
$("#btn-autoplay").onclick = () => {
  player.autoplay = !player.autoplay;
  localStorage.setItem("vn_autoplay", player.autoplay ? "1" : "0");
  updateAutoplayBtn();
  if (player.autoplay) {
    // 正在打字时，打字结束会自动排程；当前句已播完则按该句字数补排停留
    if (!player.typing && player.lineReady) {
      const e = player.flat[player.idx];
      const line = e && e.sc.lines[player.li];
      if (line) armAuto(dwellMs(line.text));
    }
  } else clearTimeout(player.autoT);
};
$("#sel-speed").onchange = e => {
  SETTINGS.autoSpeed = parseFloat(e.target.value);
  player.speed = SETTINGS.autoSpeed;
  localStorage.setItem("vn_auto_speed", e.target.value);
  $("#st-autospeed").value = e.target.value;
  if (player.autoplay && !player.typing && player.lineReady && player.flat[player.idx]) {
    const line = player.flat[player.idx].sc.lines[player.li];
    if (line) scheduleAuto(dwellMs(line.text));
  }
};
updateAutoplayBtn();

// ---------- 书签 ----------
async function renderBookmarks() {
  const list = await api(`/api/project/${player.manifest.id}/bookmarks`);
  const box = $("#bm-list");
  box.innerHTML = list.length ? "" : '<p class="hint">还没有书签。</p>';
  for (const b of [...list].reverse()) {
    const div = document.createElement("div");
    div.className = "bm-item";
    div.innerHTML = `<span class="nm" title="点击跳转">${esc(b.name)}</span>
      <span class="meta">章${b.chapter + 1}·幕${b.scene + 1}</span>
      <button title="删除">✕</button>`;
    div.querySelector(".nm").onclick = () => {
      const k = player.flat.findIndex(e => e.cid === b.chapter && e.sid === b.scene);
      if (k < 0) return alert("该书签所在章节尚未生成完成");
      showScene(k);
      $("#bookmark-panel").classList.add("hidden");
    };
    div.querySelector("button").onclick = async () => {
      await api(`/api/project/${player.manifest.id}/bookmarks/${b.id}`, { method: "DELETE" });
      renderBookmarks();
    };
    box.appendChild(div);
  }
}

$("#btn-bookmark").onclick = () => {
  const p = $("#bookmark-panel");
  p.classList.toggle("hidden");
  if (!p.classList.contains("hidden")) renderBookmarks();
};
$("#bm-close").onclick = () => $("#bookmark-panel").classList.add("hidden");
$("#bm-save").onclick = async () => {
  const e = player.flat[player.idx];
  if (!e) return;
  const nm = $("#bm-name").value.trim() ||
    `第${e.cidx + 1}章·第${e.si + 1}幕 ${(e.sc.lines[0]?.text || e.sc.narration || "").slice(0, 12)}`;
  await api(`/api/project/${player.manifest.id}/bookmarks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nm, chapter: e.cid, scene: e.sid })
  });
  $("#bm-name").value = "";
  renderBookmarks();
};

// ---------- 历史记录 / 快进 / 设置 ----------
function anyOverlayOpen() {
  return !$("#backlog-panel").classList.contains("hidden")
      || !$("#settings-panel").classList.contains("hidden")
      || !$("#bookmark-panel").classList.contains("hidden");
}

function openBacklog() {
  if (!player.flat.length) return;
  $("#settings-panel").classList.add("hidden");
  $("#bookmark-panel").classList.add("hidden");
  stopSkip();
  const panel = $("#backlog-panel");
  panel.classList.remove("hidden");
  const list = $("#bl-list");
  list.innerHTML = "";
  player.backlog.forEach(b => {
    const div = document.createElement("div");
    div.className = "bl-item" + (b.flatIdx === player.idx && b.li === player.li ? " cur" : "");
    const who = b.speaker === "旁白" ? "" : `<span class="bl-who">${esc(b.speaker)}</span>`;
    div.innerHTML = `<div class="bl-meta">${esc(b.chTitle || "")}</div>` +
      `<div class="bl-text">${who}${esc(b.text)}</div>`;
    div.onclick = () => { panel.classList.add("hidden"); showScene(b.flatIdx, b.li); };
    list.appendChild(div);
  });
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}
function closeBacklog() { $("#backlog-panel").classList.add("hidden"); }

function startSkip() {
  if (player.skipping || !player.flat.length || anyOverlayOpen()) return;
  player.skipping = true;
  $("#skip-toast").classList.remove("hidden");
  clearTimeout(player.autoT);
  skipTick();
}
function stopSkip() {
  player.skipping = false;
  clearTimeout(player.skipT);
  const t = $("#skip-toast");
  if (t) t.classList.add("hidden");
  // 停下后若自动播放开着，按当前句继续排程
  if ($("#stage") && !$("#stage").classList.contains("hidden")
      && player.autoplay && player.lineReady && !player.typing && player.flat[player.idx]) {
    const line = player.flat[player.idx].sc.lines[player.li];
    if (line) armAuto(dwellMs(line.text));
  }
  // 快进期间跳过了切歌，停下后同步到当前镜头的曲目
  if ($("#stage") && !$("#stage").classList.contains("hidden") && player.flat[player.idx]) {
    switchBGM(player.flat[player.idx].sc.music_track, false, true);
  }
}
function skipTick() {
  if (!player.skipping) return;
  if (anyOverlayOpen()) { stopSkip(); return; }
  const e = player.flat[player.idx];
  if (!e) { stopSkip(); return; }
  // 到未读句：停下让玩家正常看
  if (!isCurrentRead()) { stopSkip(); return; }
  // 已到全文末尾
  if (player.idx >= player.flat.length - 1 && !player.typing
      && player.li >= e.sc.lines.length - 1) { stopSkip(); onFlatEnd(); return; }
  // 背景先现等待期立即出第一句；否则推进一步（打字中先补全）
  if (player.lineReady === false) nextScene();
  else nextStep();
  player.skipT = setTimeout(skipTick, 80);
}

$("#btn-backlog").onclick = () =>
  $("#backlog-panel").classList.contains("hidden") ? openBacklog() : closeBacklog();
$("#bl-close").onclick = closeBacklog;
$("#btn-skip").onclick = () => player.skipping ? stopSkip() : startSkip();

$("#btn-settings").onclick = () => {
  closeBacklog();
  $("#bookmark-panel").classList.add("hidden");
  stopSkip();
  $("#settings-panel").classList.toggle("hidden");
};
$("#st-close").onclick = () => $("#settings-panel").classList.add("hidden");
$("#st-fontsize").onchange = e => {
  SETTINGS.fontSize = parseInt(e.target.value);
  localStorage.setItem("vn_font_size", e.target.value);
  $("#narration").style.setProperty("--vn-fs", SETTINGS.fontSize + "px");
};
$("#st-textspeed").onchange = e => {
  SETTINGS.textSpeed = parseFloat(e.target.value);
  localStorage.setItem("vn_text_speed", e.target.value);
};
$("#st-autospeed").onchange = e => {
  SETTINGS.autoSpeed = parseFloat(e.target.value);
  player.speed = SETTINGS.autoSpeed;
  localStorage.setItem("vn_auto_speed", e.target.value);
  $("#sel-speed").value = e.target.value;
  if (player.autoplay && !player.typing && player.lineReady && player.flat[player.idx]) {
    const line = player.flat[player.idx].sc.lines[player.li];
    if (line) scheduleAuto(dwellMs(line.text));
  }
};
$("#st-bgmvol").addEventListener("input", e => {
  SETTINGS.bgmVol = parseInt(e.target.value) / 100;
  localStorage.setItem("vn_bgm_vol", String(SETTINGS.bgmVol));
  $("#st-bgmvol-val").textContent = e.target.value + "%";
  refreshVolumes();
});

// 点击画面任意位置推进（点到控件/面板时不触发；快进中点击=停止快进）
$("#stage").addEventListener("click", ev => {
  if (ev.target.closest(".stage-ui, .bm-panel, .overlay-panel")) return;
  pokeUI();
  if (player.skipping) { stopSkip(); return; }
  nextScene();
});
// UI 静止 2.6 秒自动隐去，移动鼠标/点击即恢复（面板打开时不隐藏）
let uiIdleT = null;
function pokeUI() {
  const stage = $("#stage");
  if (stage.classList.contains("hidden")) return;
  stage.classList.remove("ui-idle");
  clearTimeout(uiIdleT);
  uiIdleT = setTimeout(() => {
    if (anyOverlayOpen()) { pokeUI(); return; }
    stage.classList.add("ui-idle");
  }, 2600);
}
$("#stage").addEventListener("mousemove", pokeUI);

// 滚轮：上滑呼出历史记录；历史列表滚到底后下滑关闭
$("#stage").addEventListener("wheel", e => {
  if ($("#stage").classList.contains("hidden")) return;
  pokeUI();
  const bl = $("#backlog-panel");
  if (!bl.classList.contains("hidden")) {
    const list = $("#bl-list");
    if (e.deltaY > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 8) {
      closeBacklog();
    }
    return;
  }
  if (anyOverlayOpen()) return;
  if (e.deltaY < 0) { e.preventDefault(); openBacklog(); }
}, { passive: false });

document.addEventListener("keydown", e => {
  if ($("#stage").classList.contains("hidden")) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  pokeUI();
  // Esc：关闭打开的面板
  if (e.key === "Escape") {
    closeBacklog();
    $("#settings-panel").classList.add("hidden");
    $("#bookmark-panel").classList.add("hidden");
    return;
  }
  if (anyOverlayOpen()) return;
  if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); nextScene(); }
  if (e.code === "ArrowRight") nextScene();
  if (e.code === "ArrowLeft") showScene(player.idx - 1);
  if (e.code === "PageUp") { e.preventDefault(); openBacklog(); }
  if (e.key.toLowerCase() === "m") $("#btn-mute").click();
  if (e.key.toLowerCase() === "a") $("#btn-autoplay").click();
  if (e.key.toLowerCase() === "h") openBacklog();
  if (e.key === "Control" && !e.repeat) startSkip();
});
document.addEventListener("keyup", e => {
  if ($("#stage").classList.contains("hidden")) return;
  if (e.key === "Control") stopSkip();
});

// ============ 启动 ============
applySettings();
loadStyles();
renderMusic();
refreshProjectList();
