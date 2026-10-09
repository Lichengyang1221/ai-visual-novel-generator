# -*- coding: utf-8 -*-
"""音乐库：扫描 -> librosa 特征 -> 五维情绪打分（带缓存）-> 按场景选曲。"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

from . import config

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma"}
CACHE_FILE = config.APP_ROOT / "audio_cache.json"
# 分析算法版本：特征提取/打分规则变更时 +1，使旧缓存整体失效
ANALYSIS_VER = 5

# 5 大情绪大类，与 config.MOOD_CATEGORIES 对齐：静思 沉郁 紧绷 激荡 舒展


def _init_ffmpeg() -> None:
    """让 librosa/audioread 能找到 imageio-ffmpeg 内置的 ffmpeg.exe（解码 MP3/m4a）。"""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        os.environ["PATH"] = str(Path(exe).parent) + os.pathsep + os.environ.get("PATH", "")
        # audioread 通过名为 ffmpeg 的程序调用
        alias = Path(exe).parent / "ffmpeg.exe"
        if Path(exe) != alias and not alias.exists():
            try:
                alias.symlink_to(exe)
            except Exception:
                import shutil
                shutil.copy2(exe, alias)
    except Exception:
        pass


def load_cache() -> dict:
    if CACHE_FILE.exists():
        try:
            return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_cache(cache: dict) -> None:
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


def scan_folder(folder: str) -> list[str]:
    root = Path(folder)
    if not root.is_dir():
        return []
    return sorted(str(p) for p in root.rglob("*") if p.suffix.lower() in AUDIO_EXTS)


def _sig(x: float) -> float:
    return float(1 / (1 + np.exp(-x)))


def _features_to_scores(feat: dict) -> dict:
    """规则模型：把声学特征映射到五大情绪大类分数（每维 0~1，softmax 归一）。

    声学变量：
      tempo_n  速度（0=极慢 1=极快）    energy_n 响度（0=极弱 1=极强）
      bright_n 明亮度（0=暗 1=亮）       zcr_n 高频摩擦（0=圆润 1=尖锐）
      dyn_n   动态起伏（0=平稳 1=剧烈）   fast  快板门控（0=慢 1=快）
      major   大调(+1)/不确定(0)/小调(-1)
    """
    tempo_n = _sig((feat["tempo"] - 100) / 28.0)
    energy_n = _sig((feat["rms"] - 0.05) / 0.04)
    bright_n = _sig((feat["centroid"] - 1200) / 700.0)
    zcr_n = _sig((feat["zcr"] - 0.06) / 0.03)
    dyn_n = _sig((feat["rms_std"] - 0.03) / 0.02)
    fast = _sig((feat["tempo"] - 90) / 8.0)
    major = feat["mode"]
    minor = -major

    scores = {
        # 静思类（安宁）：慢/弱/圆润/大调偏暖 或 中性
        "静思": 1.8 * (1 - tempo_n) + 1.4 * (1 - energy_n) + 1.0 * bright_n
                + 1.0 * major + 0.8 * (1 - zcr_n) + 0.6 * (1 - dyn_n),
        # 沉郁类（哀伤）：慢/弱/暗/小调
        "沉郁": 1.6 * (1 - tempo_n) + 1.8 * (1 - energy_n) + 1.2 * minor
                + 0.8 * (1 - bright_n) + 0.4 * (1 - zcr_n) - 1.0 * fast,
        # 紧绷类（危机）：小调/高 zcr/中快/动态大
        "紧绷": 1.4 * minor + 1.2 * zcr_n + 0.8 * tempo_n + 0.8 * dyn_n
                + 0.5 * fast - 0.6 * (1 - fast),
        # 激荡类（冲突）：高能/大动态/快/高 zcr
        "激荡": 2.2 * energy_n + 1.4 * dyn_n + 1.0 * tempo_n + 0.6 * zcr_n + 0.6 * minor,
        # 舒展类（释然）：中高亮度/大调/中能量/不过快
        "舒展": 1.2 * bright_n + 1.0 * major + 0.8 * energy_n + 0.6 * tempo_n
                + 0.4 * (1 - zcr_n) - 0.5 * fast,
    }
    vals = np.array([scores[c] for c in config.MOOD_CATEGORIES], dtype=float)
    vals = vals - vals.max()
    e = np.exp(vals)
    e /= e.sum()
    return {c: round(float(p), 4) for c, p in zip(config.MOOD_CATEGORIES, e)}


def analyze_file(path: str) -> dict:
    """分析单个音频，返回特征+情绪分数。"""
    _init_ffmpeg()
    import librosa

    # 完整文件时长（只读元数据，不加载波形）；情绪特征取前 100 秒
    duration = float(librosa.get_duration(path=path))
    y, sr = librosa.load(path, sr=22050, mono=True, duration=100)
    if y.size < sr * 3:
        raise ValueError("音频过短")

    rms = librosa.feature.rms(y=y)[0]
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    zcr = librosa.feature.zero_crossing_rate(y=y)[0]
    tempo = float(librosa.beat.beat_track(y=y, sr=sr)[0])
    if tempo > 200:  # 倍速误判修正
        tempo /= 2

    # 大小调判定：Krumhansl-Kessler 音阶模板相关（比三和弦掩码稳得多）
    chroma = librosa.feature.chroma_stft(y=y, sr=sr)
    profile = chroma.mean(axis=1)
    kk_major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    kk_minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    best_maj = max(np.corrcoef(profile, np.roll(kk_major, k))[0, 1] for k in range(12))
    best_min = max(np.corrcoef(profile, np.roll(kk_minor, k))[0, 1] for k in range(12))
    diff = best_maj - best_min
    mode = 1.0 if diff > 0.05 else (-1.0 if diff < -0.05 else 0.0)  # 不确定给中性

    feat = {
        "tempo": round(tempo, 1),
        "duration": round(duration, 1),
        "rms": round(float(rms.mean()), 5),
        "rms_std": round(float(rms.std()), 5),
        "centroid": round(float(centroid.mean()), 1),
        "zcr": round(float(zcr.mean()), 4),
        "mode": round(float(np.sign(mode)), 0),
    }
    scores = _features_to_scores(feat)
    return {"features": feat, "scores": scores,
            "mood": max(scores, key=scores.get)}  # mood = 大类名


def _key(path: str) -> str:
    st = Path(path).stat()
    return f"v{ANALYSIS_VER}|{path}|{st.st_mtime_ns}|{st.st_size}"


def load_overrides(folder: str) -> dict:
    """读取音乐文件夹内可选的 moods_override.json：{文件名: {五维分数}}，人工校准优先于规则模型。"""
    p = Path(folder) / "moods_override.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def analyze_library(folder: str, progress_cb=None) -> list[dict]:
    """扫描并分析整个音乐库（增量缓存）。返回曲目信息列表。"""
    files = scan_folder(folder)
    cache = load_cache()
    overrides = load_overrides(folder)
    results = []
    for i, f in enumerate(files):
        key = _key(f)
        if key in cache:
            info = cache[key]
        else:
            try:
                info = analyze_file(f)
                info["path"] = f
                cache[key] = info
                if (i + 1) % 5 == 0:
                    save_cache(cache)
            except Exception as e:
                info = {"path": f, "error": str(e)[:100]}
                cache[key] = info
        ov = overrides.get(Path(f).name)
        if ov and "scores" in info:
            info = {**info, "scores": ov, "mood": max(ov, key=ov.get), "override": True}
        results.append(info)
        if progress_cb:
            progress_cb(i + 1, len(files), f)
    save_cache(cache)
    return results


def select_track(category: str, library: list[dict],
                 exclude: str | None = None, genre: str | None = None) -> str | None:
    """按大类选最合适的一首；支持多情绪标签（moods 字段）优先匹配。
    若指定 genre 且不为"通用"，优先从带该 genre 标签的曲子里挑；
    若 genre 筛后为空则回退到全部曲目。
    分数相同时优先长曲（减少循环频率）。"""
    base = [t for t in library if "scores" in t and t["path"] != exclude]
    if not base:
        base = [t for t in library if "scores" in t]
    if not base:
        return None
    # 作品类型筛选：优先匹配该类型，不足回退"通用"再回退全部
    if genre and genre != "通用":
        typed = [t for t in base if genre in (t.get("genres") or [])]
        if not typed:
            typed = [t for t in base if "通用" in (t.get("genres") or [])]
        if typed:
            base = typed
    base.sort(key=lambda t: (-t["scores"].get(category, 0),
                             -(t.get("features", {}) or {}).get("duration", 0),
                             t["path"]))
    return base[0]["path"]


def get_play_info(track_path: str, library: list[dict], category: str) -> dict:
    """获取某曲目在指定大类下的播放信息：起播比例、音量。
    如果该曲有 segments 且包含匹配大类的段落，用该段落；否则默认 35%~60% 起播。"""
    for t in library:
        if t["path"] != track_path:
            continue
        volume = t.get("volume", 1.0)
        # 查找匹配大类的段落（段落情绪可能存的是细情绪，归一化到大类比较）
        segs = t.get("segments") or []
        matching = [s for s in segs
                    if config.mood_to_cat(str(s.get("mood", ""))) == category]
        if matching:
            seg = matching[0]
            return {"start": float(seg.get("start", 0.35)),
                    "end": float(seg.get("end", 0.95)) if seg.get("end") else None,
                    "volume": volume}
        # 无匹配段落，有 moods 标签但无 segment → 用默认中段起播
        return {"start": 0.35, "end": None, "volume": volume}
    return {"start": 0.35, "end": None, "volume": 1.0}


def assign_tracks(moods: list[str], library: list[dict],
                  start_track: str | None = None,
                  genre: str | None = None) -> list[str | None]:
    """按大类配曲——同类不换曲，跨大类才切歌。
    moods 为细情绪列表，先映射到大类再配曲。
    start_track：上一章结尾的曲子，同类则直接沿用。
    genre：作品类型，优先从带该类型标签的曲子里挑（不足回退"通用"再回退全部）。
    返回与 moods 等长的曲目路径列表。"""
    good = [t for t in library if "scores" in t]
    by_path = {t["path"]: t for t in good}
    out: list[str | None] = []
    cur: str | None = start_track if start_track in by_path else None
    prev: str | None = None
    cur_cat = None
    for mood in moods:
        cat = config.MOOD_TO_CAT.get(mood, "静思")
        # 同大类 → 沿用当前曲
        if cur is not None and cat == cur_cat:
            out.append(cur)
            continue
        # 跨大类 → 换新曲
        prev = cur
        cur = select_track(cat, good, exclude=prev, genre=genre)
        cur_cat = cat if cur else None
        out.append(cur)
    return out
