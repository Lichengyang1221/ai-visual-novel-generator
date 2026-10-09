# -*- coding: utf-8 -*-
"""全局配置：路径、端口、出图参数。"""
from pathlib import Path

# ---------- 路径 ----------
APP_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = APP_ROOT / "web"
PROJECTS_DIR = APP_ROOT / "projects"
PROJECTS_DIR.mkdir(exist_ok=True)

# ---------- 外部服务 ----------
OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_MODEL = "qwen3:8b"
OLLAMA_EXE = r"C:\Users\35085\AppData\Local\Programs\Ollama\ollama.exe"

COMFY_URL = "http://127.0.0.1:8188"
COMFY_DIR = r"D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI"
COMFY_PY = str(Path(COMFY_DIR) / ".venv" / "Scripts" / "python.exe")
COMFY_EXTRA_PATHS = str(Path(__file__).resolve().parent / "comfy_extra_paths.yaml")

# ---------- 出图参数（NoobAI-XL / SDXL）----------
CKPT_NAME = "NoobAI-XL-v1.1.safetensors"
IMG_WIDTH = 1216
IMG_HEIGHT = 704
STEPS = 28
CFG = 7.0
SAMPLER = "euler_ancestral"
SCHEDULER = "normal"

# 三层画面模型：
#   bg     —— 地点大背景（establishing，一个地点全书一张，广角环境）
#   lens   —— 镜头画面（绝大多数为 close-up：物件/局部身体/局部剪影）
#   insert —— 句级物品特写（即切即回，单品 macro）
BG_TEMPLATE = (
    "{scene}, "
    "wide establishing shot, expansive environment, cinematic scenery, "
    "atmospheric, film still, detailed background, high quality"
)
LENS_TEMPLATE = (
    "{scene}, "
    "intimate close framing, subject filling the frame, tight composition, "
    "pure black silhouette, partial body only, "
    "cinematic film still, shallow depth of field, atmospheric, high quality"
)
# 意识流模板：纯抽象独白段（无角色无物件）使用，生成高级感抽象艺术图
ABSTRACT_TEMPLATE = (
    "{scene}, "
    "abstract conceptual art, surreal dreamscape, flowing colors and forms, "
    "ethereal atmosphere, subconscious imagery, cinematic, high quality, "
    "no people, no objects, pure abstraction"
)
INSERT_TEMPLATE = (
    "{scene}, "
    "close-up product photography, 85mm macro lens, commercial photography, "
    "single object filling the frame, shallow depth of field, "
    "clean simple background, natural lighting, high resolution, "
    "realistic photograph, sharp focus, material texture visible"
)
# 兼容旧引用
PROMPT_TEMPLATE = LENS_TEMPLATE

NEGATIVE_PROMPT = (
    "face, facial features, eyes, looking at viewer, facing viewer, "
    "close-up portrait, detailed face, text, watermark, lowres, blurry, "
    "deformed, bad anatomy, chibi"
)
# 镜头层独立基础负向：允许"半张侧脸/眼部局部"等身体局部特写，只禁完整正脸与肖像感
NEGATIVE_LENS_BASE = (
    "full face, frontal face, symmetrical face, face portrait, portrait shot, "
    "detailed face, full facial features, face filling frame, face close-up, "
    "expressive face staring, looking at viewer, facing viewer, head-to-shoulders portrait, "
    "bad hands, extra fingers, fused fingers, missing fingers, mutated hands, malformed hands, "
    "text, watermark, lowres, blurry, deformed, bad anatomy, chibi"
)
# 镜头层：严禁全身/远景人物（特写叙事只允许局部身体）
NEGATIVE_LENS_ADD = (
    "full body, full body shot, distant figure, tiny person, wide shot, "
    "aerial view, multiple people, crowd"
)
# 物品层：画面主体只能是物件（允许握持的手部局部入镜，由 AI prompt 决定）
# 强化写实 + 防止 NoobAI anime 模型把物品画跑偏（香烟→烧钱、杯子→啤酒杯）
NEGATIVE_INSERT_ADD = (
    "person, people, face, portrait, full body, wide shot, cluttered scene, "
    "extra objects, props not requested, multiple products, duplicate items, "
    "plastic-looking, glossy fake render, CGI, 3d render, cartoon, anime stylization, "
    "bad hands, extra fingers, fused fingers, missing fingers, mutated hands, "
    "text, watermark"
)

# ---------- 情绪体系（与 AI 拆分镜、音乐分析共用）----------
MOODS = ["平静", "温柔", "轻松", "休闲", "甜蜜", "希望", "宿命", "欢快", "悲伤", "紧张", "激昂"]

# 5 大情绪大类（BGM 按大类切换，同类不换曲）
MOOD_CATEGORIES = ["静思", "沉郁", "紧绷", "激荡", "舒展"]
# 细情绪 → 大类映射
MOOD_TO_CAT = {
    "平静": "静思", "温柔": "静思", "轻松": "静思", "休闲": "静思", "甜蜜": "静思",
    "悲伤": "沉郁",
    "紧张": "紧绷", "宿命": "紧绷",
    "激昂": "激荡",
    "希望": "舒展", "欢快": "舒展",
}
CAT_COLORS = {"静思": "#6ea8fe", "沉郁": "#5f86d8", "紧绷": "#f06c75", "激荡": "#b48cff", "舒展": "#ffd44d"}
# 大类 → 默认细情绪（自动分析只得出大类时，用它落成细情绪标签）
CAT_DEFAULT_MOOD = {"静思": "平静", "沉郁": "悲伤", "紧绷": "紧张", "激荡": "激昂", "舒展": "希望"}

# ---------- 作品类型（音乐库按作品类型筛选；配曲时优先匹配，不足从"通用"补）----------
GENRES = ["中国玄幻", "西方奇幻", "轻小说", "严肃文学", "悬疑推理", "古风言情", "科幻", "都市日常", "通用"]
DEFAULT_GENRE = "通用"


def mood_to_cat(mood: str) -> str:
    """细情绪→大类；若传入的已是大类则原样返回；未知兜底静思。"""
    return MOOD_TO_CAT.get(mood, mood if mood in MOOD_CATEGORIES else "静思")

# ---------- 画风体系（整本书选一种，可逐章覆盖）----------
STYLES = {
    "shinkai": {
        "name": "新海诚",
        "suffix": "by makoto shinkai, anime scenery style, highly detailed",
        "neg_add": "",
    },
    "ghibli": {
        "name": "吉卜力",
        "suffix": "studio ghibli style, hand-painted anime background, hayao miyazaki",
        "neg_add": "",
    },
    "kyoani": {
        "name": "京阿尼",
        "suffix": "kyoto animation style, anime background art",
        "neg_add": "",
    },
    "shaft": {
        "name": "物语·新房风",
        "suffix": "shaft studio style, monogatari series aesthetic, avant-garde framing",
        "neg_add": "",
    },
    "noir": {
        "name": "黑白电影",
        "suffix": "black and white film noir, monochrome, high contrast, film grain",
        "neg_add": "color, colorful, vibrant colors, saturated",
    },
    "watercolor": {
        "name": "水彩",
        "suffix": "watercolor illustration, soft washes of color, visible paper texture",
        "neg_add": "",
    },
}
DEFAULT_STYLE = "shinkai"

# ---------- 内容基调体系（全书自动分析一次，所有 prompt 加基调前缀）----------
# 与视觉画风（STYLES）正交：视觉画风控制笔触/色彩，内容基调控制场景元素的写实程度
# 例如现实主义文学 → realistic，避免 NoobAI 把日常场景画成科幻
ART_STYLES = {
    "realistic": {
        "name": "写实现实",
        "suffix": "realistic photograph, contemporary real-world setting, everyday mundane environment, "
                  "photographic, natural lighting, 85mm lens, "
                  "no sci-fi, no fantasy, no anime stylization",
        "neg_add": "sci-fi, futuristic, cyberpunk, neon, space, spaceship, robot, mecha, alien, monster, "
                   "fantasy, magic, medieval, historical costume, surreal, dreamlike fantasy",
    },
    "scifi": {
        "name": "科幻未来",
        "suffix": "science fiction setting, futuristic environment, advanced technology, "
                  "cyberpunk atmosphere, cinematic",
        "neg_add": "medieval, fantasy, magic, historical, ancient, traditional costume",
    },
    "fantasy": {
        "name": "奇幻魔幻",
        "suffix": "fantasy setting, magical atmosphere, mystical environment, ethereal, cinematic",
        "neg_add": "sci-fi, futuristic, cyberpunk, modern city, contemporary",
    },
    "historical": {
        "name": "历史古风",
        "suffix": "historical period setting, traditional architecture, period-accurate props, "
                  "classical atmosphere, cinematic",
        "neg_add": "sci-fi, futuristic, cyberpunk, modern, contemporary, smartphone, modern electronics",
    },
    "watercolor": {
        "name": "水彩淡彩",
        "suffix": "watercolor illustration, soft washes of color, visible paper texture, painterly",
        "neg_add": "",
    },
    "generic": {
        "name": "通用",
        "suffix": "",
        "neg_add": "",
    },
}
DEFAULT_ART_STYLE = "realistic"

# ---------- 背景动画变种（播放器 CSS 类，按情绪自动选或分镜手动指定）----------
ANIMS = ["kenburns-in", "kenburns-out", "pan-left", "pan-right",
         "drift-up", "drift-down", "zoom-punch", "sway", "shake"]

SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8765
