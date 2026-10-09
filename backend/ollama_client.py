# -*- coding: utf-8 -*-
"""Ollama 客户端：服务检测/拉起 + 小说文本拆分镜。"""
from __future__ import annotations

import json
import logging
import re
import subprocess
import time

logger = logging.getLogger("vn.split")

import httpx

from . import config

SYSTEM_PROMPT = f"""你是一个视觉小说分镜导演，擅长用电影镜头语言讲故事。用户会给你一段中文小说文本，你要把它改写成可播放的分镜脚本。

★ 最重要的两个概念：地点（不动的大背景）与镜头（灵活切换的画面）必须分开。

一、地点 loc——故事发生的空间
- 每个镜头都必须标注它所在的地点：loc_id（英文 snake_case 稳定标识，如 dorm_desk、j_bar、subway_platform）+ loc_name（中文短名，如"宿舍书桌前""杰氏酒吧吧台"）。
- loc 只标注"故事当下真正发生动作"的空间；在回忆、转述、想象里仅仅被提到、但没有角色此刻在那里行动的地方，不要新开 loc（用 close 特写呈现回忆里的物件/意象即可，地点仍锚定在当下空间）。一章通常只有 1~3 个 loc，切分要克制。
- 【抽象段落的特殊处理·重点】如果整段是回忆、议论、转述、心理活动，没有任何句子表明角色"此刻"正处在某个具体空间（本书有大量这样的段落），严禁根据书名、章节标题或你对这本书的背景知识去臆造宿舍、酒吧、街道等地点！此时必须：
  · 全段统一使用 loc_id = "abstract_space"、loc_name = "思绪空间"，整段只许这一个 loc；
  · bg_prompt_en 用中性的氛围空镜，例："wide establishing shot of a dim undefined interior at dusk, empty, no people, faint window light dissolving into shadow, a plain table edge lost in darkness, muted grey tones, deep negative space, dreamlike contemplative mood"，不要放任何具体剧情物件；
  · 每个 close 镜头直接拍该句比喻或回忆中浮现的具体意象/物件：必须先从本镜头 lines 的中文句子里找出实际出现的名词，再把它具象化地写成英文特写（写清材质、颜色、形状、所处位置与正在发生的动作），物件可超现实地浮现在暗背景或虚空中；
  · 只有正文明确写出角色此刻的动作与所处空间（如"我坐在吧台前喝酒""回到宿舍躺到床上"）时，才允许使用具体 loc_id。比喻句里的空间（"像往枯井里扔石子"的井、"放归草原"的草原）是意象而不是 loc，不许据此新开地点。
- 同一个地点在所有镜头（甚至跨章节）里必须使用完全相同的 loc_id，一个词都不许改——系统据此让全书共用同一张大背景图。只有故事真正换了空间（房间→街道、酒吧→车内）才换 loc_id。
- bg_prompt_en 是这个地点的"环境全景"英文绘画提示词（50~110 词）：必须写成角色走进该空间第一眼看到的广角空镜，句式固定为 "wide establishing shot of <与 loc_name 字面一致的具体空间>, empty, no people, <家具陈设与地面的布局>, <时间与光源方向>, <整体色调>, <窗外/门外的天气与纵深感>, deep perspective"。
  · 尖括号 < > 里的内容必须按当前正文真实地点替换填写（例如正文是学校走廊就写教学楼走廊的窗、长椅、地面砖；是酒吧就写吧台、酒架、酒瓶），严禁照抄本句式或任何示例里出现的房间与物件。
  · 严禁反例：任何身体部位（eyes/hand/fingers/shoulders/silhouette）、close-up/macro/low-angle 之类取景词、只写单件物品或天花板细节、抽象比喻意象——那些只能写进 scene_prompt_en；bg 里出现身体或特写词属于严重错误。
  · bg 描绘的空间必须与 loc_name、loc_id 字面一致：地点是山谷草甸就不许出现室内/天花板，是酒吧就不许画成街道。
- 【节省输出】bg_prompt_en 只在每个 loc_id 第一次出现的那个镜头里完整填写一次；同一 loc_id 之后的所有镜头，bg_prompt_en 一律填空字符串 ""（系统会自动传播同一张背景，你不需要重复抄写）。

二、镜头 shot——摄像机此刻对准什么
- 一个镜头 = 摄像机的一次取景，承载连续发生的几句话。镜头时长完全跟着剧情节奏走，不要定死：普通叙述、描写、连续对话一般 3~6 句一个镜头；只有动作骤起、情绪爆发、台词短句密集对撞时才用 1~2 句的快切。
- 【硬规则】每个镜头最多 6 句话，超过 6 句就是错误。宁可多切镜头，绝不能把一大段话塞进一个镜头。
- 镜头要跟住意象流动：哪怕整段都是旁白、回忆、议论、心理活动，也要按意象和话题切块——每出现一个新的比喻、画面、物件或话题，就是一个新镜头，并为它找一个此刻可拍的视觉落点（空椅、桌面、窗玻璃、烟灰、手指、背影、天花板……）。绝对禁止"一镜到底讲完一整段回忆"。但反过来，没有视觉变化的相邻句子不要为切而切。
- 地点不变也要频繁切镜头：同一个房间里，视线从烟蒂移到窗外、从手移到门、从背影移到酒杯，就是不同镜头。
- 每个镜头必须给 shot 字段，只有两个值：
  · "close"——近景/特写/大特写/中近景。这是绝对主力，95% 以上的镜头都必须是 close：画面被主体填满，例如一只夹烟的手、握着啤酒杯的手指、垂下的眼睛局部、肩膀与后颈的剪影、桌沿的烟灰缸、雨水中的电线杆、半张被阴影切开的脸侧。
  · "wide"——大全景/远景。数量必须很少：全章一般 1~2 个、不超过镜头总数的 20%。只允许两种情况：(a) 本章主地点第一次亮相，用一个 wide 让观众看清"这是哪里"，随后立刻切回 close；(b) 广阔的自然风景（山野、海、天空、长街、旷野）。一个地点若只在本章短暂出现，直接用 close 进入即可，不必给 wide；不要给每个地点都配 wide。其余情况一律 close。
- scene_prompt_en 是该镜头的具体画面英文提示词（40~100 词，逗号分隔），只写镜头里真正看得到的东西。不同镜头即使在同一地点，画面也必须反映此刻独有的动作/物件/角度（wide 镜头可留空字符串）。
  · 【取材步骤·最高优先级】写每个镜头前，先逐字通读它 lines 里的中文 text，圈出其中真实出现的具体名词与动作（器物、动植物、身体动作、衣着、空间陈设、天气光线），scene_prompt_en 的主体只能从这些词里挑选并翻译成英文。本镜头 text 里没有写到的物件、动作，一律不许出现在 prompt 里；严禁从其他镜头、章节标题、书名或本说明书的任何英文/中文例子中借用物件。
  · 句式固定为 "close-up of <主体（必须带 2~3 个可见属性：材质/颜色/形状/表面纹理）>, <主体正在发生的动作或状态>, <所在位置与旁边的一两件东西>, <光线与色调>"。主体必须是画面中清晰可辨、被镜头填满的东西；禁止只给一个孤立、多义或抽象的名词——属性不足会导致画出错误物体。
  · 若本镜头句子纯为议论、附和、沉默、心理活动、没有任何物件，就拍此刻人物的一个局部动作（手部、肩背、后颈、半张没入阴影的侧脸）或当下空间里的一个中性细节（桌面、窗光、门沿、天花板一角）；相邻镜头必须选择不同的局部或细节，不许重复。
  · 【去重硬规则】本章内任意两个镜头的 scene_prompt_en 严禁逐字相同或仅差一两个词（系统虽会自动给重复画面追加机位变化，但你必须先做到每镜主体不同）。想写的画面若上一镜已写过，本镜必须改拍当前句子里的另一个新意象。
  · 【严禁完整面部】完整正脸、完整表情、双眼直视镜头的写法是严重错误；有人物的镜头只能出现手、肩背、后颈、半张没入阴影的侧脸等局部（见第三节）。

三、人物的表现方式（极其重要，每张有人物的图都要遵守）
- 【人物剪影优先·核心】当句子的 text 里出现人物（"我""他""她""人名" + 动作或姿态），scene_prompt_en 必须优先写"人物剪影的局部身体 + 此刻的动作"作为画面主体。频率参考第五节物品 insert：有就要给，不绝对，但角色出场且有明显动作/姿态时一定要给；只有纯议论段（无人物无物件）才退回意识流。特别是 text 有画面感细节描写（笑、转身、抬头、垂手、皱眉、姿势、手势、低头、仰头、侧身、凝视等），剪影的部位和动作必须逐字参照原文写出，例：原文"她笑着转身"→ "close-up of a girl's silhouette from behind, solid black silhouette, partial body only, turning around, head slightly tilted as if smiling, no face visible"；原文"他低头看着手心里的石子"→ "close-up of a lowered head and open hand silhouette, solid black silhouette, partial body only, looking down at pebbles in palm, no face visible"。
- 除 wide 镜头外，人物永远只能以"纯黑剪影的局部身体"出现：只露一只手、几根手指、一段肩背、后颈、后脑勺、膝部、衣角、站在逆光里的躯干剪影。必须是纯黑剪影（solid black silhouette），看不到五官、看不到表情、看不到肤色。
- 提示词句式为 "close-up of <纯黑剪影的部位> <手/肩/后颈/半身>, solid black silhouette, partial body only, <本句 text 里的真实动作>, no face visible"。其中手在握什么、碰什么，必须取自本句 text 真实出现的物品。可直接使用的纯身体短语如 "close-up of a hand, solid black silhouette, partial body only"、"close-up of shoulders and back of neck, solid black silhouette"。
- 绝不允许全身入镜、绝不允许远景小人、绝不允许完整正脸、绝不允许有肤色/五官/表情细节。人物只能是一块黑色的形状。
- 同一角色在所有镜头中使用逐字一致的形象短语（发型/服装/身形），如 "long black hair, dark sweater, slim wrist"，每次出现该角色都照抄。
- 如果整段台词是纯独白、议论、心理活动，没有具体物件也没有角色动作，scene_prompt_en 就写该段情绪的抽象意象（如流动的暗色、模糊的光斑、虚化的空间感），系统会自动用意识流模板出图。

四、lines 台词规则
1. 每句 text 控制在 12~60 字，保留原文质感，可轻度口语化，不要把几句话揉成一句。
   - 严禁编造原文没有的内容、情节或句子；每一句都必须能在原文中找到出处。原文没写完就结束，绝不自己补结局。
   - 原文同一句话拆成的几个分句必须放在同一个镜头里，不得跨镜头断开。
2. speaker 为说话人名字；纯旁白/心理描写用 "旁白"。
   - 原文中带引号（“”或""）的句子是角色对白，必须单独拆成一句，speaker 填说话角色的名字（从上下文推断，如"方""林晚"；无名角色可填"女生""老人"等）；引号外的叙述部分另算一句旁白。
   - 叙述、描写、心理活动一律 "旁白"，即使句子里出现角色名字。
   - 示例：原文「她笑着说："明天见。"」→ 两句：{{"speaker": "旁白", "text": "她笑着说。"}} 和 {{"speaker": "她", "text": "明天见。"}}；原文「他转身离开了。」→ {{"speaker": "旁白", "text": "他转身离开了。"}}
   - 一段分镜里旁白句通常多于对白句，但只要有引号对白就绝不能全部标成旁白。
3. mood 是该镜头的主导情绪，必须且只能从以下中选一个：{'、'.join(config.MOODS)}。
   - 客观叙述、过渡段落、无明显情绪色彩的内容一律标 "平静"；同一场戏相邻镜头通常情绪一致，不要频繁切换。

五、closeup_prompt_en——物品插入镜头（insert shot）
- 当某一句台词或旁白中出现了被角色注视、拿起、讨论、或推动情节的具体实体物件时，就给这一句填写物品特写英文提示词。句式为 "macro shot of <该物品的英文，带材质/颜色/形状/表面纹理等 2~3 个可见属性>, <物品当下的状态或动作>, <所在表面/背景虚化>, cinematic lighting"，单件物品占满整个画面，不出现人物全身与杂乱背景。
- 判定要积极：句子里出现了任何可以独立成像的具体物品名词——日用器物、工具机器、动植物、食物、自然物、文字纸片等——都应给 insert，宁可多给，不可漏给；但物品必须是本句 text 里真实出现的那一件，严禁用任何示例或其他镜头里的物品顶替；纯议论段要靠句子比喻中真实提到的物品让画面落地。
- 数量跟着剧情走，不要定死：连续几句都围绕同一个物件就连续给；平平无奇的过场段落可以一个都没有。同一物件在不同句子重复出现时，提示词措辞保持一致（系统会复用同一张图）。
- 以下情况填 null：纯情绪/心理描写、抽象概念（影子、命运、梦）、只有身体动作而无独立物件（揉眼睛、抬头、转身）、纯环境描写。

六、title 是给整段故事起的短标题（10 字以内）。

只输出 JSON，不要输出任何解释或 markdown 代码块。JSON 结构：
{{"title": string, "scenes": [{{"loc_id": string, "loc_name": string, "shot": "close" | "wide",
  "bg_prompt_en": string, "mood": string, "scene_prompt_en": string,
  "lines": [{{"speaker": string, "text": string, "closeup_prompt_en": string | null}}]}}]}}"""


# 书本自带章节标记：第一章 / 第12章 / 第X回 / Chapter 3 / 序章 / 楔子 / 尾声 等
CHAPTER_MARK = re.compile(
    r"^[ \t　]*("
    r"第[0-9０-９一二三四五六七八九十百千零两]+[章回节卷部][^\n]{0,30}"
    r"|(?:Chapter|CHAPTER)\s+\d+[^\n]{0,40}"
    r"|序章|楔子|序曲|尾声|终章|番外篇?[^\n]{0,20}"
    r"|Prologue|Epilogue"
    r")\s*$",
    re.MULTILINE)

# 无章节标记时自动分章的目标长度（字），以及单章送 AI 的硬上限
AUTO_CHAPTER_CHARS = 1400
MAX_CHAPTER_CHARS = 3200


def _paragraphs(text: str, limit: int) -> list[str]:
    """切分段落：优先按空行分段；单段超过 limit 时退化为按单行切
    （网文/聊天记录常见只有单换行、没有空行的文本）。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n|\r\n\s*\r\n", text) if p.strip()]
    out: list[str] = []
    for p in paras:
        if len(p) > limit:
            lines = [ln.strip() for ln in p.splitlines() if ln.strip()]
            out.extend(lines or [p])
        else:
            out.append(p)
    return out


def split_chapters(text: str) -> list[dict]:
    """把整本小说切成章节列表 [{title, text}]。
    优先按书本自身章节标记；无标记时按段落聚合成约 AUTO_CHAPTER_CHARS 字的块。
    title 为 None 表示由 AI 在拆分镜时拟名。"""
    text = text.strip()
    chapters: list[dict] = []
    marks = list(CHAPTER_MARK.finditer(text))
    if marks:
        head = text[:marks[0].start()].strip()
        if len(head) >= 80:
            chapters.append({"title": "开篇", "text": head})
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            body = text[m.end():end].strip()
            if body:
                chapters.append({"title": m.group(1).strip()[:20], "text": body})
    else:
        buf: list[str] = []
        size = 0
        for p in _paragraphs(text, AUTO_CHAPTER_CHARS):
            if size + len(p) > AUTO_CHAPTER_CHARS and buf:
                chapters.append({"title": None, "text": "\n\n".join(buf)})
                buf, size = [], 0
            buf.append(p)
            size += len(p)
        if buf:
            chapters.append({"title": None, "text": "\n\n".join(buf)})

    # 超长章节再按段落细分，避免超出模型上下文
    final: list[dict] = []
    for ch in chapters or [{"title": None, "text": text}]:
        if len(ch["text"]) <= MAX_CHAPTER_CHARS:
            final.append(ch)
            continue
        buf, size, part = [], 0, 1
        for p in _paragraphs(ch["text"], MAX_CHAPTER_CHARS):
            if size + len(p) > MAX_CHAPTER_CHARS and buf:
                final.append({"title": (ch["title"] or "") + f"（{part}）" if ch["title"] else None,
                              "text": "\n\n".join(buf)})
                buf, size, part = [], 0, part + 1
            buf.append(p)
            size += len(p)
        if buf:
            final.append({"title": (ch["title"] or "") + f"（{part}）" if ch["title"] else None,
                          "text": "\n\n".join(buf)})
    return final


def is_running() -> bool:
    try:
        r = httpx.get(f"{config.OLLAMA_URL}/api/tags", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def ensure_running() -> bool:
    """确保 Ollama 服务可用；不可达时尝试拉起。"""
    if is_running():
        return True
    try:
        subprocess.Popen(
            [config.OLLAMA_EXE, "serve"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass
    for _ in range(15):
        time.sleep(1)
        if is_running():
            return True
    return False


def _extract_json(text: str) -> dict:
    """容错提取模型返回的 JSON。"""
    text = text.strip()
    # 去掉可能的 markdown 围栏
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    # 截取第一个 { 到最后一个 }
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError(f"无法解析模型返回为 JSON: {text[:200]}")


# 判定"原文被完整拆分"的阈值
MIN_SENTENCE_COVERAGE = 0.75   # 原文字数≥5 的句子中，至少 75% 能在分镜里找到
MIN_CHAR_RATIO = 0.60          # 分镜总字数（去标点）不少于原文的 60%
_PUNCT_RE = re.compile(r"[\s，。！？、…“”\"'（）()《》〈〉—\-·?!,.;:：；~～]+")
_SENT_SPLIT_RE = re.compile(r"[。！？!?…\n；;]+")


def _coverage(orig: str, lines: list[str]) -> tuple[float, float]:
    """计算拆分结果对原文的覆盖情况，返回 (句子覆盖率, 去标点字数保留率)。

    模型允许轻度口语化改写、也可能把一句话拆成两行，因此不能做整句精确匹配：
    对原文每个句子，用 SequenceMatcher 的匹配块在"全部输出拼接"中找字符覆盖，
    匹配字符占该句 70% 以上且存在≥4字连续匹配块，就算该句被保留。
    """
    from difflib import SequenceMatcher
    joined = "\n".join(lines)
    sents = [s.strip() for s in _SENT_SPLIT_RE.split(orig) if len(s.strip()) >= 5]
    covered = 0
    for s in sents:
        sm = SequenceMatcher(None, s, joined, autojunk=False)
        blocks = sm.get_matching_blocks()
        matched = sum(b.size for b in blocks)
        longest = max((b.size for b in blocks), default=0)
        if longest >= 4 and matched / len(s) >= 0.7:
            covered += 1
    cov = covered / len(sents) if sents else 1.0
    o_chars = _PUNCT_RE.sub("", orig)
    l_chars = _PUNCT_RE.sub("", joined)
    ratio = len(l_chars) / len(o_chars) if o_chars else 1.0
    return cov, min(ratio, 1.0)


def _structure_issues(scenes: list[dict], orig_chars: int) -> tuple[list[str], list[str]]:
    """分镜结构校验（区别于文本覆盖率）。返回 (hard, soft)：
    hard（触发重试/兜底）：
    - 任何镜头超过 6 句（硬上限，模型最常见的偷懒是"一镜一大段"）；
    - 镜头总数过少（约每 230 字应至少 1 镜，纯叙述段也必须按意象切分）。
    soft 目前为空（wide 缺失由 _build_scenes 直接兜底，不必重试）。"""
    hard: list[str] = []
    soft: list[str] = []
    if not scenes:
        return ["没有任何镜头"], soft
    longest = max(len(s["lines"]) for s in scenes)
    if longest > 6:
        hard.append(f"有镜头长达 {longest} 句，但每个镜头硬上限是 6 句，"
                    "请把超长镜头按内容拆成多个 3~6 句的镜头")
    expect = max(4, round(orig_chars / 230))
    if len(scenes) < expect:
        hard.append(f"镜头总数只有 {len(scenes)} 个（本段 {orig_chars} 字，至少需要 {expect} 个左右），"
                    "回忆、议论、旁白段落也要按意象/比喻/话题切镜，平均每 3~6 句一个镜头")
    return hard, soft


# 同一主体画面在多个非相邻/切块镜头重复时，给第 2+ 次出现轮换追加的机位变化短语，
# 让 hash 与构图都不同（首现保持原样以利书级复用）
ANGLE_VARIANTS = (
    ", extreme tight macro, different camera angle",
    ", side angle close framing, changed viewpoint",
    ", low angle close-up, alternate camera position",
    ", slightly wider close framing, another perspective",
    ", oblique overhead close shot, shifted angle",
)

# ── 后处理：scene_prompt_en 去诗意化 + 禁脸兜底 ──
_SIMILE_RE = re.compile(
    r',?\s*(?:like|resembling|as if|echoing|fading into|dissolving into|'
    r'its echo|its ember|its flame flickering)\b[^,]*', re.IGNORECASE)
_FACE_WORDS_RE = re.compile(
    r'\b(face|eyes|eye|gaze|staring|expression|smile|frown|'
    r'facial|visage|visibly emotional|looking at)\b', re.IGNORECASE)

def _cleanup_scene_prompts(scenes: list[dict]) -> list[dict]:
    """去除 scene_prompt_en 中的比喻/抽象短语（AI 画不出），禁正脸词。
    纯独白段（无物品无角色动作）标记为 is_abstract，由出图管线用意识流模板。"""
    for sc in scenes:
        p = (sc.get("scene_prompt_en") or "").strip()
        if not p:
            continue
        p = _SIMILE_RE.sub("", p).strip(" ,")
        if _FACE_WORDS_RE.search(p):
            p = _FACE_WORDS_RE.sub("hand", p)
        p = re.sub(r'\s+,', ',', p)
        p = re.sub(r',\s*,', ', ', p)
        sc["scene_prompt_en"] = p

        # 检测纯抽象独白段：close 镜头 + 无 insert + 无角色身体词 → 意识流
        if sc.get("shot") == "close":
            has_insert = any(ln.get("closeup_prompt_en") for ln in sc.get("lines", []))
            has_body = bool(_BODY_RE.search(p)) if p else False
            if not has_insert and not has_body:
                sc["is_abstract"] = True
    return scenes


# 角色身体/动作关键词——出现说明镜头有人物，不标 abstract
_BODY_RE = re.compile(
    r'\b(hand|fingers|shoulder|neck|back|wrist|arm|leg|knee|foot|silhouette|'
    r'figure|person|man|woman|boy|girl|body|palm|fist|'
    r'knuckle|thumb|elbow|nape|profile)\b', re.IGNORECASE)


# ── 后处理：wide 比例控制（≤20%） ──
def _clamp_wide_ratio(scenes: list[dict]) -> list[dict]:
    """wide 镜头超过总数 20% 时，多余的降级为 close。"""
    total = len(scenes)
    if total < 3:
        return scenes
    wide_idx = [i for i, s in enumerate(scenes) if s.get("shot") == "wide"]
    max_wide = max(1, int(total * 0.2))
    if len(wide_idx) > max_wide:
        for i in wide_idx[max_wide:]:
            scenes[i]["shot"] = "close"
    return scenes


# ── 后处理：insert 后处理——扫描台词物品名词自动补 closeup_prompt_en ──
# 常见物品中英文映射（按类别），模型不输出时自动兜底
_ITEM_MAP: dict[str, str] = {
    # 日用器物
    "火柴": "macro shot of a small matchbox with red phosphor strip, worn cardboard edges, cinematic lighting",
    "火柴盒": "macro shot of a small matchbox with red phosphor strip, worn cardboard edges, cinematic lighting",
    "香烟": "macro shot of a lit cigarette resting on a ceramic ashtray, curling smoke, grey ash tip, cinematic lighting",
    "烟头": "macro shot of a cigarette butt crushed in a glass ashtray, faint ember, grey ash, cinematic lighting",
    "烟灰": "macro shot of cigarette ash in a glass ashtray, fine grey powder, cinematic lighting",
    "烟灰缸": "macro shot of a glass ashtray with cigarette butts and grey ash, cinematic lighting",
    "信": "macro shot of a folded letter on a wooden desk, yellowed paper, ink stains, cinematic lighting",
    "信件": "macro shot of a folded letter on a wooden desk, yellowed paper, ink stains, cinematic lighting",
    "信封": "macro shot of a white envelope on a wooden desk, slightly creased, cinematic lighting",
    "纸杯": "macro shot of a paper cup filled with cigarette butts and ash on a plastic table, cinematic lighting",
    "杯子": "macro shot of a glass cup on a wooden counter, water condensation, cinematic lighting",
    "玻璃杯": "macro shot of a half-empty glass on a wooden counter, condensation droplets, cinematic lighting",
    "啤酒": "macro shot of a glass of golden beer on a wooden table, foam head, condensation, cinematic lighting",
    "电话": "macro shot of a black rotary telephone on a wooden desk, coiled cord, dusty dial, cinematic lighting",
    "唱片": "macro shot of a black vinyl record on a turntable, grooves catching light, dust specks, cinematic lighting",
    "冷却器": "macro shot of a white water cooler with a paper cup beneath the spout, plastic drip tray, cinematic lighting",
    "饮水": "macro shot of a white water cooler, paper cup, condensation, cinematic lighting",
    # 自然物
    "石子": "macro shot of small grey pebbles in a dusty palm, rough texture, cinematic lighting",
    "井": "macro shot of dark stone well opening, mossy edges, deep shadow within, cinematic lighting",
    "枯井": "macro shot of a dry stone well, crumbling mossy edges, darkness below, cinematic lighting",
    "纸箱": "macro shot of a brown cardboard box, dusty flaps, tape residue, cinematic lighting",
    "纸壳箱": "macro shot of a brown cardboard box, dusty flaps, tape residue, cinematic lighting",
    "橡树子": "macro shot of brown acorns scattered on dark soil, glossy shells, textured caps, cinematic lighting",
    "唱片": "macro shot of a black vinyl record on a turntable, grooves catching light, dust specks, cinematic lighting",
    # 动植物
    "猴": "macro shot of a small monkey peeking from a cardboard box, dusty fur, wide eyes, cinematic lighting",
    "猫": "macro shot of a cat curled on a windowsill, soft fur, half-closed eyes, cinematic lighting",
    "狗": "macro shot of a dog sitting on dirt ground, alert ears, dusty coat, cinematic lighting",
    "鸟": "macro shot of a small bird on a wire against grey sky, ruffled feathers, cinematic lighting",
    # 工具/机器
    "弹子球": "macro shot of a shiny steel pinball resting on a playfield, colorful bumpers blurred behind, cinematic lighting",
    "弹子球机": "macro shot of a pinball machine playfield, chrome flippers, colorful lights, steel ball, cinematic lighting",
    "机器": "macro shot of a machine control panel, metal buttons, worn labels, cinematic lighting",
    # 衣物/个人
    "鞋": "macro shot of leather shoes on a wooden floor, scuffed toes, polished leather, cinematic lighting",
    "皮鞋": "macro shot of polished leather shoes on a wooden floor, scuffed toes, cinematic lighting",
    "表": "macro shot of a wristwatch on a wrist, scratched glass face, leather band, cinematic lighting",
    "手表": "macro shot of a wristwatch, scratched glass face, leather band, cinematic lighting",
    # 食物
    "面包": "macro shot of sliced bread on a cutting board, golden crust, soft interior, cinematic lighting",
    "苹果": "macro shot of a red apple on a wooden table, glossy skin, water droplet, cinematic lighting",
    # 家具
    "椅子": "macro shot of a wooden chair back, carved top rail, dust on seat, cinematic lighting",
    "桌子": "macro shot of a wooden desk edge, scratched surface, ink stains, cinematic lighting",
    "灯": "macro shot of a bare light bulb hanging from a cord, warm filament glow, cinematic lighting",
    "灯泡": "macro shot of a bare light bulb, warm filament glow, dust on glass, cinematic lighting",
    # 其他
    "书": "macro shot of an open book on a desk, yellowed pages, spine cracked, cinematic lighting",
    "本": "macro shot of a notebook on a desk, blue cover, bent corners, cinematic lighting",
    "笔": "macro shot of a fountain pen on a desk, gold nib, ink residue, cinematic lighting",
    "钥匙": "macro shot of brass keys on a ring, scratched metal, leather fob, cinematic lighting",
    "窗": "macro shot of a rain-streaked windowpane, blurred city lights beyond, cinematic lighting",
    "门": "macro shot of a wooden door edge, brass handle, peeling paint, cinematic lighting",
    "收音机": "macro shot of a portable radio, leather case, dial indicator, antenna, cinematic lighting",
    "报纸": "macro shot of a folded newspaper on a table, smudged print, coffee ring stain, cinematic lighting",
    "地图": "macro shot of a folded paper map, creased lines, coffee stain, cinematic lighting",
    "硬币": "macro shot of coins scattered on a wooden table, tarnished metal, engraved faces, cinematic lighting",
    "吉他": "macro shot of an acoustic guitar body, wood grain, steel strings, fret dust, cinematic lighting",
    "吉他弦": "macro shot of steel guitar strings stretched along a fretboard, fret markers, cinematic lighting",
}

def _backfill_inserts(scenes: list[dict]) -> list[dict]:
    """模型不给 closeup_prompt_en 时，扫描台词中文物品名词自动补。"""
    for sc in scenes:
        for ln in sc.get("lines", []):
            if ln.get("closeup_prompt_en"):
                continue
            text = ln.get("text", "")
            for cn, en in _ITEM_MAP.items():
                if cn in text:
                    ln["closeup_prompt_en"] = en
                    break
    return scenes


def _split_long_scenes(scenes: list[dict], max_lines: int = 6) -> list[dict]:
    """最终兜底：把仍超过 6 句的镜头机械切成 ≤6 句的小块。
    仅在模型多轮重试仍不遵守硬规则时触发；小块继承同一 loc/bg，但 close 小块从
    第 2 块起轮换追加机位短语（否则连续多块共用同一张图，观感像画面卡住）。"""
    import math
    fixed: list[dict] = []
    for sc in scenes:
        n = len(sc["lines"])
        if n <= max_lines:
            fixed.append(sc)
            continue
        parts_n = math.ceil(n / 5)
        size = math.ceil(n / parts_n)
        vi = 0
        for k in range(0, n, size):
            chunk = dict(sc)
            chunk["lines"] = sc["lines"][k:k + size]
            chunk["narration"] = "\n".join(ln["text"] for ln in chunk["lines"])
            if k > 0 and chunk.get("shot") == "close":
                base = (chunk.get("scene_prompt_en") or "").strip().rstrip(".")
                if base:
                    chunk["scene_prompt_en"] = base + ANGLE_VARIANTS[vi % len(ANGLE_VARIANTS)]
                    vi += 1
            fixed.append(chunk)
    for i, sc in enumerate(fixed):
        sc["id"] = i
    return fixed


def _norm_speaker(s: str) -> str:
    """说话人归一化：模型偶发 '旁,白'/'旁，' 等错形，含'旁'或为空一律归 '旁白'。"""
    s = re.sub(r"[，,、\s.。:：]", "", str(s or ""))
    if not s or "旁" in s:
        return "旁白"
    return s[:12]


def _pnorm(p: str) -> str:
    return re.sub(r"\s+", " ", p.strip().lower().rstrip("."))


def _psim(a: str, b: str) -> float:
    """两个 prompt 的词集合 Jaccard 相似度（模型同场景复述时会有小幅措辞波动；
    词按标点清洗后再比对）。"""
    def _words(p: str) -> set:
        return {w.strip(".,;:'\"()") for w in _pnorm(p).split() if w.strip(".,;:'\"()")}
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def _norm_locid(s: str, fallback: str) -> str:
    """loc_id 归一化为安全的英文 snake_case 文件名片段；模型乱填时用兜底值。"""
    s = re.sub(r"[^a-z0-9]+", "_", str(s or "").strip().lower())
    s = re.sub(r"_+", "_", s).strip("_")[:40]
    return s or fallback


# bg_prompt 里出现这些词，说明模型把镜头特写措辞误塞进了环境背景字段
_BG_BAD = re.compile(
    r"\b(close[- ]?up|macro|extreme close|low[- ]?angle|over[- ]?the[- ]?shoulder|"
    r"eyes?|gazing?|staring|hands?|fingers?|wrist|shoulders?|neck|silhouette|"
    r"face|facial|portrait|ceiling detail)\b", re.IGNORECASE)


def _valid_bg(p: str) -> bool:
    p = (p or "").strip()
    return len(p) >= 20 and not _BG_BAD.search(p)


def _fallback_bg(lid: str) -> str:
    """模型完全没给可用的环境描述时，按 loc_id 拼一个中性的广角空镜（保证 L1 不是特写）。"""
    if lid == "abstract_space":
        return (
            "wide establishing shot of a dim undefined interior at dusk, empty, no people, "
            "faint window light dissolving into shadow, a plain table edge lost in darkness, "
            "muted grey tones, deep negative space, dreamlike contemplative mood, "
            "detailed anime background art"
        )
    place = lid.replace("_", " ")
    return (
        f"wide establishing shot of {place}, empty, no people, spacious environment, "
        f"clear spatial layout and deep perspective, natural ambient light, "
        f"muted cinematic color grading, detailed anime background art"
    )


# 抽象/回忆段落里模型给中性空间起的各种名字，统一归并到 abstract_space（全书共用一张氛围背景）
_ABSTRACT_LOC_ALIASES = {
    "empty_room", "dark_room", "dim_room", "silent_room", "quiet_room",
    "shadow_room", "void_room", "bare_room", "empty_space", "dark_space",
    "mind_space", "memory_room", "thought_space",
}
_ABSTRACT_LOC_RE = re.compile(r"abstract|mindscape|undefined|the_void|^void$")


def _canon_locid(lid: str) -> str:
    if lid in _ABSTRACT_LOC_ALIASES or _ABSTRACT_LOC_RE.search(lid):
        return "abstract_space"
    return lid


def _build_scenes(raw: str, title: str | None) -> dict:
    """解析模型 JSON → 清洗 → 地点(loc)归一化 → 合并相邻逐字重复镜头，返回 {title, scenes}。"""
    data = _extract_json(raw)
    scenes = data.get("scenes", [])

    # 兼容模型偶尔返回 dict 形态（{"1": {...}}）或 JSON 字符串
    if isinstance(scenes, str):
        try:
            scenes = json.loads(scenes)
        except Exception:
            scenes = []
    if isinstance(scenes, dict):
        scenes = list(scenes.values())
    if not isinstance(scenes, list):
        scenes = []

    norm = []
    for sc in scenes:
        if isinstance(sc, str):
            try:
                sc = json.loads(sc)
            except Exception:
                continue
        if isinstance(sc, dict):
            norm.append(sc)
    scenes = norm
    if not scenes:
        raise ValueError("模型未返回任何分镜")

    clean = []
    for i, sc in enumerate(scenes):
        mood = str(sc.get("mood", "平静")).strip()
        if mood not in config.MOODS:
            mood = "平静"

        # lines：同一镜头下依次播放的多句话；兼容模型偶尔仍返回旧格式 speaker/narration
        lines = []
        raw_lines = sc.get("lines")
        if isinstance(raw_lines, list):
            for ln in raw_lines:
                if isinstance(ln, dict):
                    ln_text = str(ln.get("text", "")).strip()
                    spk = _norm_speaker(ln.get("speaker"))
                elif isinstance(ln, str):
                    ln_text, spk = ln.strip(), "旁白"
                else:
                    continue
                if ln_text:
                    closeup = str(ln.get("closeup_prompt_en", "") or "").strip()
                    # 模型偶尔把 null 写成字符串 "null"/"none"/"nil"，视同无 insert
                    if closeup.lower() in ("null", "none", "nil"):
                        closeup = ""
                    lines.append({"speaker": spk, "text": ln_text,
                                  "closeup_prompt_en": closeup or None})
        if not lines:
            narration = str(sc.get("narration", "")).strip()
            if narration:
                lines.append({"speaker": _norm_speaker(sc.get("speaker")),
                              "text": narration,
                              "closeup_prompt_en": None})
        if not lines:
            continue

        # shot：只认 close/wide；模型若回 medium/extreme close-up 等一律按 close 处理
        shot_raw = str(sc.get("shot", "close")).strip().lower()
        if shot_raw not in ("close", "wide"):
            shot = "wide" if ("wide" in shot_raw or "panoramic" in shot_raw
                              or "establish" in shot_raw) else "close"
        else:
            shot = shot_raw

        clean.append({
            "id": i,
            "mood": mood,
            "lines": lines,
            # narration 仅作兼容字段（书签默认名等），播放器统一读 lines
            "narration": "\n".join(ln["text"] for ln in lines),
            "loc_id": str(sc.get("loc_id", "")).strip(),
            "loc_name": str(sc.get("loc_name", "")).strip()[:20],
            "shot": shot,
            "bg_prompt_en": str(sc.get("bg_prompt_en", "")).strip(),
            "scene_prompt_en": str(sc.get("scene_prompt_en", "")).strip(),
            "image_file": None,
            "music_track": None,
        })

    # 地点归一化：
    #  (1) loc_id 清洗为安全 slug；(2) 不同 slug 但环境描述高度一致（模型对同一地点
    #  起了微差别名）归并为同一地点；(3) bg_prompt_en 只在 loc 首次出现时给出，
    #  其余镜头为空，这里把权威 bg 传播给同 loc 的每个镜头。
    authority: dict[str, str] = {}   # loc_id → 权威 bg_prompt 原文
    loc_names: dict[str, str] = {}   # loc_id → 首个中文名
    for i, sc in enumerate(clean):
        lid = _canon_locid(_norm_locid(sc["loc_id"], f"loc_{i:02d}"))
        real_bg = sc["bg_prompt_en"].strip()   # 可能为空（同 loc 后续镜头）
        # 模型偶尔把镜头特写措辞误填进 bg 字段：含身体部位/特写景别词的一律判无效，
        # 否则 L1 大背景会变成一只眼睛或一块天花板
        if not _valid_bg(real_bg):
            real_bg = ""
        if lid not in authority:
            # slug 是新的，但可能与已登记地点"异名同地"：只用真正的环境描述做相似度归并
            if real_bg:
                for known_id, known_bg in authority.items():
                    if known_bg and _psim(known_bg, real_bg) >= 0.75:
                        lid = known_id
                        break
            if lid not in authority:
                authority[lid] = real_bg
        elif not authority[lid] and real_bg:
            authority[lid] = real_bg
        if sc["loc_name"] and lid not in loc_names:
            loc_names[lid] = sc["loc_name"]
        sc["loc_id"] = lid
        if authority[lid]:
            sc["bg_prompt_en"] = authority[lid]
        else:
            # 兜底：整个 loc 都没有有效环境描述（模型失误），按 loc_id 拼一个广角空镜，
            # 绝不能用首镜的特写 prompt 顶替（那会让大背景变成局部特写）
            authority[lid] = _fallback_bg(lid)
            sc["bg_prompt_en"] = authority[lid]
        if not sc["loc_name"]:
            sc["loc_name"] = loc_names.get(lid, lid)

    # 合并：仅合并"同地点、同是 close 特写、画面 prompt 逐字重复"的相邻镜头
    # （模型机械复述时会产生）。不同取景的特写即使同地点也绝不合并。
    merged: list[dict] = []
    for sc in clean:
        prev = merged[-1] if merged else None
        same = (prev is not None and prev["loc_id"] == sc["loc_id"]
                and prev["shot"] == "close" and sc["shot"] == "close"
                and _pnorm(prev["scene_prompt_en"])
                and _psim(prev["scene_prompt_en"], sc["scene_prompt_en"]) >= 0.85)
        if same:
            prev["lines"].extend(sc["lines"])
            prev["narration"] += sc["narration"]
        else:
            merged.append(sc)

    # 非相邻镜头的画面 prompt 逐字重复 = 模型偷懒复制（相邻的上面已合并）。
    # 不为此整轮重拆（会丢失已达标的原文覆盖率），而是给第 2+ 次出现的镜头追加不同
    # 机位/景别短语：既保证 hash 不同、各自出图，又让同主体画面有镜头变化。
    prompt_seen: dict[str, int] = {}
    for sc in merged:
        if sc["shot"] != "close":
            continue
        p = (sc.get("scene_prompt_en") or "").strip()
        if not p:
            continue
        k = _pnorm(p)
        n = prompt_seen.get(k, 0)
        if n >= 1:
            sc["scene_prompt_en"] = p.rstrip(".") + ANGLE_VARIANTS[(n - 1) % len(ANGLE_VARIANTS)]
        prompt_seen[k] = n + 1

    # insert 轻去重：同镜头内高度重复（≥0.9）的物品提示词只保留第一条；
    # 书级精确复用（同 prompt 只出一张图）在出图管线按归一化 hash 完成。
    for sc in merged:
        seen_ins: list[str] = []
        for ln in sc["lines"]:
            cp = ln.get("closeup_prompt_en")
            if not cp:
                continue
            if any(_psim(cp, p) >= 0.9 for p in seen_ins):
                ln["closeup_prompt_en"] = None
            else:
                seen_ins.append(cp)

    # mood 轻平滑：模型偶尔给相邻镜头乱序标注情绪（A-B-A 抖动）。
    # 只修"前后两镜情绪相同、中间一镜突兀不同"的 V 形孤立点（真实转折不会瞬间弹回）。
    for i in range(1, len(merged) - 1):
        if (merged[i - 1]["mood"] == merged[i + 1]["mood"]
                and merged[i]["mood"] != merged[i - 1]["mood"]):
            merged[i]["mood"] = merged[i - 1]["mood"]

    # 兜底：模型若仍给出 >6 句的超长镜头，机械切块后重排 id
    merged = _split_long_scenes(merged)

    # ── 后处理 1：scene_prompt_en 去诗意化 + 禁脸兜底 ──
    merged = _cleanup_scene_prompts(merged)

    # ── 后处理 2：wide 比例控制（≤20%） ──
    merged = _clamp_wide_ratio(merged)

    # ── 后处理 3：insert 后处理——扫描台词中的物品名词自动补 closeup_prompt_en ──
    merged = _backfill_inserts(merged)

    # wide 建立镜头兜底：特写必须占绝大多数，wide 全章只要 1~2 个。
    # 仅当模型一个 wide 都没给时，把全章第一个镜头改为 wide（绑定地点大背景），
    # 保证章节开场有一次环境亮相；模型给了 wide（哪怕只给主地点）就完全尊重，不追加。
    if not any(sc["shot"] == "wide" for sc in merged):
        merged[0]["shot"] = "wide"
    return {"title": title or str(data.get("title", "未命名章节")).strip()[:20],
            "scenes": merged}


def analyze_art_style(text: str) -> str:
    """全书内容基调分析。取前/中/后各一段送 Ollama 判断，返回 ART_STYLES 的 key。
    现实主义文学 → realistic；科幻小说 → scifi；奇幻 → fantasy；历史/古风 → historical；
    水彩风/童话 → watercolor；无法判定 → generic。失败时兜底 DEFAULT_ART_STYLE。
    """
    if not ensure_running():
        return config.DEFAULT_ART_STYLE
    # 取前 1500 + 中间 800 + 末尾 800，控制输入长度加快分析
    t = text.strip()
    n = len(t)
    if n <= 3100:
        sample = t
    else:
        sample = t[:1500] + "\n…（中略）…\n" + t[n // 2 - 400:n // 2 + 400] + "\n…（中略）…\n" + t[-800:]
    valid = list(config.ART_STYLES.keys())
    inst = (
        "判断下面这段小说文本的整体内容基调，只输出一个小写英文 key，不要任何解释：\n"
        "- realistic：现实主义、当代日常、都市生活、纯文学、当代背景的真实故事\n"
        "- scifi：科幻、未来、太空、赛博朋克、人工智能、机器人\n"
        "- fantasy：奇幻、魔法、神话、异世界、超自然\n"
        "- historical：历史、古代、古风、民国、年代文、传统背景\n"
        "- watercolor：童话、绘本、水彩感、儿童文学、淡彩梦幻\n"
        "- generic：无法归入以上任何一类\n"
        f"只能从这 {len(valid)} 个里选：{', '.join(valid)}"
    )
    payload = {
        "model": config.OLLAMA_MODEL,
        "stream": False,
        "keep_alive": 0,
        "format": "json",
        "options": {"temperature": 0.2, "num_ctx": 4096, "num_predict": 64},
        "messages": [
            {"role": "system", "content": inst},
            {"role": "user", "content": sample[:4000]},
        ],
    }
    try:
        with httpx.Client(timeout=httpx.Timeout(120.0)) as cli:
            r = cli.post(f"{config.OLLAMA_URL}/api/chat", json=payload)
            r.raise_for_status()
            content = r.json()["message"]["content"].strip().lower()
        # 提取第一个匹配的 key
        for k in valid:
            if k in content:
                logger.info("analyze_art_style -> %s (raw: %s)", k, content[:50])
                return k
        # JSON 格式返回时尝试解析
        try:
            j = json.loads(content)
            for v in j.values():
                v = str(v).strip().lower()
                for k in valid:
                    if k in v:
                        return k
        except Exception:
            pass
    except Exception as e:
        logger.warning("analyze_art_style 失败，兜底默认值：%s", e)
    return config.DEFAULT_ART_STYLE


def split_story(text: str, title: str | None = None) -> dict:
    """把小说文本拆成分镜。返回 {title, scenes:[...]}。

    带"原文覆盖率"校验：模型可能偷懒概括、漏掉大量句子，
    覆盖率不达标时追加警告重试，最多 3 轮；仍不达标则抛错（该章标 error，不静默接受残缺）。
    """
    if not ensure_running():
        raise RuntimeError("Ollama 服务无法启动，请确认已安装 Ollama。")

    base_user = f"标题：{title or '（由你拟定）'}\n\n正文：\n{text.strip()}"
    warn = ""
    last_metrics: tuple[float, float] = (0.0, 0.0)
    result: dict | None = None
    orig_chars = len(_PUNCT_RE.sub("", text))

    # 内容完整性 + 分镜结构重试：最多 3 轮（每轮内部对网络/500 错误再重试 3 次）
    for content_attempt in range(3):
        payload = {
            "model": config.OLLAMA_MODEL,
            "stream": False,
            "keep_alive": 0,  # 用完立即释放显存，给 ComfyUI 让路
            "format": "json",
            # 10240：长章输入约 2.5k token + 密集镜头 JSON 输出 ≤6k；比 16k 的 KV cache
            # 小 37%，在 8GB 显存上减少 offload，decode 明显更快
            # 重试轮次递增温度：偶发"只吐 1 个镜头"的坏采样在同温度下会重复，升温跳出
            "options": {"temperature": (0.4, 0.6, 0.8)[content_attempt],
                        "num_ctx": 10240, "num_predict": 6144},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": warn + base_user},
            ],
        }
        # Ollama 偶发 500（模型装卸载竞态等），重试 3 次、指数退避
        raw = None
        last_err: Exception | None = None
        t_call = time.time()
        for attempt in range(3):
            try:
                with httpx.Client(timeout=httpx.Timeout(600.0)) as cli:
                    r = cli.post(f"{config.OLLAMA_URL}/api/chat", json=payload)
                    r.raise_for_status()
                    j = r.json()
                    raw = j["message"]["content"]
                    ndone = (j.get("eval_count") or 0)
                    ndur = (j.get("eval_duration") or 0) / 1e9
                    spd = ndone / ndur if ndur else 0
                break
            except Exception as e:
                last_err = e
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))
        if raw is None:
            raise RuntimeError(f"Ollama 调用连续失败：{last_err}")

        result = _build_scenes(raw, title)
        lines_all = [ln["text"] for sc in result["scenes"] for ln in sc["lines"]]
        cov, ratio = _coverage(text, lines_all)
        last_metrics = (cov, ratio)
        hard_issues, soft_issues = _structure_issues(result["scenes"], orig_chars)
        note = "；".join(hard_issues) or "结构OK"
        if soft_issues:
            note += "（仅建议：" + "；".join(soft_issues) + "）"
        logger.info("split 第%d轮 %.0fs 输出%d字符 %d镜 %d句 cov=%.2f ratio=%.2f %.1ftok/s | %s",
                    content_attempt + 1, time.time() - t_call, len(raw),
                    len(result["scenes"]), len(lines_all), cov, ratio, spd, note)
        # wide 缺失等 soft 建议不触发重试（避免把合格结果重拆成更差结果）；
        # 最后一轮即使仍有 hard 问题，覆盖率达标也放行（机械拆分兜底结构）
        if (cov >= MIN_SENTENCE_COVERAGE and ratio >= MIN_CHAR_RATIO
                and (not hard_issues or content_attempt == 2)):
            return result
        # 不达标：下一轮在正文前加针对性警告
        msg_parts = ["【严重警告】你上一次的分镜不合格，必须修正："]
        if cov < MIN_SENTENCE_COVERAGE or ratio < MIN_CHAR_RATIO:
            msg_parts.append(
                f"1) 原文被大量遗漏（句子覆盖率仅 {cov:.0%}、字数保留仅 {ratio:.0%}），"
                "必须把正文里每一句话都拆进 lines，严禁概括、缩写、省略；")
        if hard_issues:
            msg_parts.append("2) 镜头结构问题：" + "；".join(hard_issues) + "。")
        msg_parts.append("\n这次请严格按每个镜头 2~6 句、按意象频繁切镜，重拆全部正文。\n\n")
        warn = "".join(msg_parts)

    # 3 轮后：覆盖率仍不达标则失败；仅结构不达标时，_build_scenes 的机械拆分
    # 已保证无超长镜头（同时增加镜头数量），可放行进入配图
    if last_metrics[0] >= MIN_SENTENCE_COVERAGE and last_metrics[1] >= MIN_CHAR_RATIO:
        return result
    raise RuntimeError(
        f"AI 连续 3 次拆分镜均丢失原文内容（句子覆盖率 {last_metrics[0]:.0%}、"
        f"字数保留仅 {last_metrics[1]:.0%}，要求均不低于 {MIN_SENTENCE_COVERAGE:.0%}/{MIN_CHAR_RATIO:.0%}），"
        "请稍后重试本章")
