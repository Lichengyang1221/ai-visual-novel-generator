# -*- coding: utf-8 -*-
"""ComfyUI 客户端：健康检查/拉起、构造 NoobAI 工作流、排队、取图。"""
from __future__ import annotations

import random
import subprocess
import time
import uuid

import httpx

from . import config


def is_running() -> bool:
    try:
        r = httpx.get(f"{config.COMFY_URL}/system_stats", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def ensure_running(timeout_sec: int = 240) -> bool:
    if is_running():
        return True
    try:
        subprocess.Popen(
            [config.COMFY_PY, "main.py", "--port", "8188",
             "--extra-model-paths-config", config.COMFY_EXTRA_PATHS],
            cwd=config.COMFY_DIR,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        time.sleep(3)
        if is_running():
            return True
    return False


def build_workflow(prompt: str, negative: str, seed: int) -> dict:
    """NoobAI-XL（SDXL 架构）标准文生图工作流。"""
    return {
        "4": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": config.CKPT_NAME}},
        "6": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode",
              "inputs": {"text": negative, "clip": ["4", 1]}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": config.IMG_WIDTH, "height": config.IMG_HEIGHT, "batch_size": 1}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": config.STEPS, "cfg": config.CFG,
                         "sampler_name": config.SAMPLER, "scheduler": config.SCHEDULER,
                         "denoise": 1.0, "model": ["4", 0],
                         "positive": ["6", 0], "negative": ["7", 0],
                         "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode",
              "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"images": ["8", 0], "filename_prefix": "vn_generator"}},
    }


def full_prompt(scene_prompt_en: str, style: str | None = None,
                kind: str = "lens", art_style: str | None = None) -> str:
    st = config.STYLES.get(style or config.DEFAULT_STYLE, config.STYLES[config.DEFAULT_STYLE])
    ast = config.ART_STYLES.get(art_style or config.DEFAULT_ART_STYLE,
                                config.ART_STYLES[config.DEFAULT_ART_STYLE])
    tpl = {"bg": config.BG_TEMPLATE,
           "lens": config.LENS_TEMPLATE,
           "insert": config.INSERT_TEMPLATE,
           "abstract": config.ABSTRACT_TEMPLATE}.get(kind, config.LENS_TEMPLATE)
    parts = [tpl.format(scene=scene_prompt_en), st["suffix"]]
    if ast["suffix"]:
        parts.append(ast["suffix"])
    return ", ".join(p for p in parts if p)


def negative_prompt(style: str | None = None, kind: str = "lens",
                    art_style: str | None = None) -> str:
    st = config.STYLES.get(style or config.DEFAULT_STYLE, config.STYLES[config.DEFAULT_STYLE])
    ast = config.ART_STYLES.get(art_style or config.DEFAULT_ART_STYLE,
                                config.ART_STYLES[config.DEFAULT_ART_STYLE])
    if kind == "lens":
        # 镜头特写允许半脸/眼部局部，使用独立负向集
        neg = config.NEGATIVE_LENS_BASE + ", " + config.NEGATIVE_LENS_ADD
    elif kind == "abstract":
        # 意识流抽象图：禁止任何人物/物件/文字，只要纯抽象
        neg = ("person, people, face, portrait, full body, character, animal, "
               "text, watermark, lowres, blurry, deformed")
    else:
        neg = config.NEGATIVE_PROMPT
        if kind == "insert":
            neg += ", " + config.NEGATIVE_INSERT_ADD
    if st.get("neg_add"):
        neg += ", " + st["neg_add"]
    if ast.get("neg_add"):
        neg += ", " + ast["neg_add"]
    return neg


def generate_image(scene_prompt_en: str, out_path, seed: int | None = None,
                   style: str | None = None, progress_cb=None,
                   kind: str = "lens", art_style: str | None = None) -> str:
    """生成一张图并保存到 out_path，返回文件路径。
    kind: bg（地点全景）/ lens（镜头特写）/ insert（物品特写）。
    art_style: 内容基调（realistic/scifi/...），全书统一，控制场景写实程度。"""
    if not ensure_running():
        raise RuntimeError("ComfyUI 无法启动，请先用 ComfyUI 桌面版手动启动一次。")

    seed = seed if seed is not None else random.randint(1, 2**31 - 1)
    client_id = str(uuid.uuid4())
    workflow = build_workflow(full_prompt(scene_prompt_en, style, kind, art_style),
                              negative_prompt(style, kind, art_style), seed)

    with httpx.Client(timeout=httpx.Timeout(600.0)) as cli:
        r = cli.post(f"{config.COMFY_URL}/prompt",
                     json={"prompt": workflow, "client_id": client_id})
        if r.status_code != 200:
            raise RuntimeError(f"ComfyUI 拒绝任务: {r.text[:300]}")
        prompt_id = r.json()["prompt_id"]

        # 轮询历史
        t0 = time.time()
        while time.time() - t0 < 480:
            time.sleep(2)
            h = cli.get(f"{config.COMFY_URL}/history/{prompt_id}").json()
            if prompt_id in h:
                outputs = h[prompt_id].get("outputs", {})
                status = h[prompt_id].get("status", {})
                if status.get("status_str") == "error" or not outputs:
                    raise RuntimeError(f"ComfyUI 执行出错: {status}")
                imgs = outputs.get("9", {}).get("images", [])
                if not imgs:
                    raise RuntimeError("ComfyUI 未返回图片")
                img = imgs[0]
                ir = cli.get(f"{config.COMFY_URL}/view",
                             params={"filename": img["filename"],
                                     "subfolder": img.get("subfolder", ""),
                                     "type": img.get("type", "output")})
                if ir.status_code != 200:
                    raise RuntimeError("下载生成图片失败")
                with open(out_path, "wb") as f:
                    f.write(ir.content)
                return str(out_path)
            if progress_cb:
                try:
                    q = cli.get(f"{config.COMFY_URL}/queue").json()
                    running = len(q.get("queue_running", []))
                    pending = len(q.get("queue_pending", []))
                    progress_cb(running, pending)
                except Exception:
                    pass
        # 超时后主动中断卡住的任务，避免它堵在队列里拖死后续章节
        try:
            cli.post(f"{config.COMFY_URL}/interrupt")
        except Exception:
            pass
        raise TimeoutError("等待 ComfyUI 出图超时（已中断该任务）")
