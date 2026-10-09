# AI 视觉小说生成器

把任意小说文本变成可播放的视觉小说：AI 自动拆分镜、ComfyUI 出图、按情绪配曲，生成带背景/特写/物品插入/音乐/转场的沉浸式阅读体验。第一章生成完即可游玩，后续章节边玩边生成。

## 功能特性

### AI 分镜与出图
- **AI 拆分镜**：基于 Ollama（qwen3:8b）把小说文本拆成"镜头—台词"分镜脚本，每镜头 2~6 句，含原文覆盖率校验（≥75% 句子覆盖 + ≥60% 字数保留），不达标自动重试
- **三层画面架构**：
  - L1 地点大背景（wide establishing，一个地点全书复用一张）
  - L2 镜头特写（95% close-up：物件/局部身体/剪影，按画面 prompt 书级复用）
  - L3 物品 insert（句级 macro 单品特写，即切即回，书级复用）
- **全书画风基调分析**：拆分镜前先分析全书文本，自动判断内容基调（写实/科幻/奇幻/历史/水彩/通用），所有 prompt 加基调前缀，避免现实主义小说被画成科幻场景
- **多种视觉画风**：新海诚 / 吉卜力 / 京阿尼 / 物语·新房风 / 黑白电影 / 水彩，可全书统一或逐章覆盖
- **人物剪影**：文字出现人物时生成纯黑剪影局部身体（手/肩/后颈/半身），有画面感细节（笑、姿势、手势）时参照原文逐字写动作
- **意识流抽象图**：纯独白/议论/心理活动段（无人物无物件）自动用抽象艺术模板出图
- **物品防频闪**：连续 insert 句之间不切回背景，直接换图，最后一句后才淡出回背景

### 音乐库
- 本地扫描音乐文件，自动分析音频特征（BPM、调性）判定情绪
- 11 种细情绪归为 5 大类（静思/沉郁/紧绷/激荡/舒展），播放时**同大类内不换曲，跨大类才切换**
- 每首曲子可独立设置默认音量、多情绪标签、多播放段落（起播/结束比例 + 关联大类）
- 作品类型分类（中国玄幻/西方奇幻/轻小说/严肃文学/悬疑推理/古风言情/科幻/都市日常/通用），配曲优先匹配类型，不足回退通用
- 批量编辑（作品类型 + 情绪大类）、批量删除、增量扫描（重复扫描不重复添加）
- BGM 骤停：情绪转折时旧曲 220ms 掐断，0.7s 静默后新曲 1.6s 淡入

### 播放器
- 文字从画面上方约 9% 处居中向下铺，无底部对话框，仅顶部极淡渐变承托
- 当前句白色亮显，最近 3 句旧句半透明灰色留上方，更早自动淡出
- **历史记录**：☰/滚轮上滑/PageUp/H 键打开已读对话全屏列表，对白说话人蓝色，当前位置高亮，点击精确跳回
- **快进已读**：按住 Ctrl 快速跳过已读文本（按作品存 localStorage），遇未读或结尾自动停止
- **键盘快捷键**：空格/回车/→ 推进、← 回上幕、H/PageUp 历史记录、Esc 关闭、M 静音、A 自动播放
- **设置面板**：字号、打字速度、自动停留时间、BGM 音量，调整即时生效且刷新保留
- **情绪转场**：静思→淡入、紧绷→硬切、沉郁→黑场、激荡→闪白
- **紧张文字抖动**：紧绷场景当前句叠加轻微抖动
- **天气粒子**：根据英文 prompt 自动解析天气标签，匹配雨/雪/萤火/光束/浮尘全屏叠层
- **书签**：自动记住最后阅读位置 + 手动命名保存书签
- **副本管理**：保留用户已创建的视觉小说，可自行删除（物理删除，不进回收站）

### 文档导入
- 支持 .docx 和 .txt 上传，文件上限 32MB
- TXT 自动识别编码（UTF-8 + GBK/ANSI）
- DOCX 提取正文段落和表格文字，自动清理多余空行
- 文件名自动填入标题（标题已有内容则不覆盖）
- 分章优先按书中章节标记（第X章/Chapter X/序章等），无标记时 AI 自动分章（约 1400 字/章）

## 技术栈
- **后端**：Python + FastAPI + Uvicorn（端口 8765）
- **前端**：原生 HTML/CSS/JavaScript（无构建步骤）
- **AI 文本**：Ollama（qwen3:8b 模型，本地运行）
- **AI 出图**：ComfyUI + NoobAI-XL-v1.1（SDXL 架构，1216×704，euler_ancestral，CFG 7，28 步）
- **音乐分析**：librosa（BPM、Krumhansl-Kessler 调性判定）+ moods_override.json 人工校准

## 安装步骤

### 1. 克隆仓库
```bash
git clone https://github.com/<你的用户名>/ai-visual-novel-generator.git
cd ai-visual-novel-generator
```

### 2. 创建 Python 虚拟环境
```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. 安装 Ollama 并拉取模型
- 从 https://ollama.com 安装 Ollama
- 拉取模型：`ollama pull qwen3:8b`

### 4. 安装 ComfyUI 并下载模型
- 从 https://github.com/comfyanonymous/ComfyUI 安装 ComfyUI
- 下载 NoobAI-XL-v1.1.safetensors 放入 ComfyUI 的 models/checkpoints/ 目录
- 启动 ComfyUI（默认端口 8188）

### 5. 准备音乐（可选）
- 在项目根目录创建 `music_library/` 文件夹
- 放入 MP3 文件（古典纯音乐、无人声 BGM 最佳）
- 启动后在"音乐库"页面扫描添加

## 使用方法

1. 启动后端：
   ```bash
   .venv\Scripts\python.exe -X utf8 -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
   ```
2. 浏览器打开 http://127.0.0.1:8765
3. 在"创作分镜"页面：
   - 粘贴小说文本或上传 .docx/.txt
   - 选择全书画风和作品类型
   - 点击"AI 生成分镜"
4. 第一章生成完成后，切到"播放"页面开始游玩
5. 后续章节在后台边生成边玩

## 配置

后端配置在 `backend/config.py`：
- `OLLAMA_URL` / `OLLAMA_MODEL`：Ollama 服务地址和模型
- `COMFY_URL` / `COMFY_DIR`：ComfyUI 地址和安装目录
- `CKPT_NAME` / `IMG_WIDTH` / `IMG_HEIGHT` / `STEPS` / `CFG`：出图参数
- `STYLES`：视觉画风字典（可扩展）
- `ART_STYLES`：内容基调字典（realistic/scifi/fantasy/historical/watercolor/generic）
- `MOODS` / `MOOD_CATEGORIES`：情绪体系

## 项目结构
```
ai-visual-novel-generator/
├── backend/
│   ├── config.py          # 配置（路径、出图参数、画风、情绪）
│   ├── comfyui_client.py  # ComfyUI 客户端（出图工作流）
│   ├── ollama_client.py   # Ollama 客户端（分镜、画风分析）
│   ├── audio_lib.py       # 音乐库分析（BPM、调性、情绪）
│   └── main.py            # FastAPI 服务 + 生成管线
├── web/
│   ├── index.html         # 前端页面
│   ├── style.css          # 样式
│   └── app.js             # 前端逻辑（三层播放、音乐、播放器）
├── requirements.txt
├── 启动.bat                # Windows 启动脚本
└── README.md
```

## 开源协议
MIT License
