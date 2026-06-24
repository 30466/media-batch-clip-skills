---
name: media-batch-clip
description: Batch clip/trim media files using ffmpeg with intelligent codec compatibility detection. Supports natural-language cutlist input and various cutlist file formats.
---

# Media Batch Clip（批量音视频剪切）

## Overview

批量剪切音视频文件，支持任意 ffmpeg 支持的输入/输出格式。根据预设的切片信息（自然语言描述 或 导入切片本文件），自动检测源文件编码，决定使用 stream copy 还是重编码，并生成切片本记录文件。

## Prerequisites

- **ffmpeg + ffprobe**：脚本依赖命令行工具
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: 从 https://ffmpeg.org 下载并加入 PATH

## Script Reference

脚本路径: `scripts/batch_clip.mjs`

```bash
node <skill_dir>/scripts/batch_clip.mjs '<JSON>'
```

### 输入格式

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `input` | string | ✅ | 源文件绝对路径 |
| `defaultFormat` | string | | 默认输出格式，默认 `mp4` |
| `videoCodec` | string | | 视频重编码编码器，默认 `libx264`（用户提 H265 时切 `libx265`） |
| `clips` | array | ✅ | 切片列表 |
| `clips[].name` | string | | 切片名称，默认 `clip_N` |
| `clips[].start` | string | ✅ | 开始时间，格式 `HH:MM:SS` 或 `MM:SS` |
| `clips[].end` | string | ✅ | 结束时间 |
| `clips[].format` | string | | 覆盖该切片的输出格式 |
| `clips[].accurate` | bool | | `true` 时启用帧精确剪切（重编码，更慢但更准） |

### 输出结构

源文件同目录下生成：

```
/path/to/source/
├── audio/              # 纯音频 clip
│   └── 片段名.mp3
├── video/              # 视频 clip
│   └── 片段名.mp4
└── _clip_record.txt    # 切片本
```

## Workflow

### Step 0: 加载 Skill

阅读本 SKILL.md 获取完整工作流指令。

### Step 0.5: 检查环境

先确认用户的系统环境是否满足运行条件，依次执行以下检查：

**1. Node.js**

```bash
node --version
```

| 结果 | 操作 |
|------|------|
| 输出版本号如 `v18.0.0` | ✅ 继续下一步 |
| `command not found: node` | ❌ 引导用户安装 |

安装指引：
- **macOS**: `brew install node`
- **Linux**: `apt install nodejs` 或 `dnf install nodejs`
- **Windows**: 从 https://nodejs.org 下载 LTS 版本安装

安装后再次运行 `node --version` 确认。

**2. ffmpeg + ffprobe**

```bash
ffmpeg -version
ffprobe -version
```

| 结果 | 操作 |
|------|------|
| 输出版本号 | ✅ 继续下一步 |
| `command not found` | ❌ 引导用户安装 |

安装指引：
- **macOS**: `brew install ffmpeg`
- **Linux (Ubuntu/Debian)**: `sudo apt install ffmpeg`
- **Linux (Fedora)**: `sudo dnf install ffmpeg`
- **Windows**: 从 https://ffmpeg.org/download.html 下载 → 解压 → 将 `bin` 目录加入系统 PATH → 重启终端

安装后运行 `ffmpeg -version` 确认。

两个环境都确认正常后进入下一步。

### Step 1: 用户提供源文件 + 输出格式

用户必须指定源文件路径。可选指定默认输出格式、视频编码器。

> "把 /path/to/xxx.mp4 按以下切片剪成 MP3"

或

> "把 /path/to/xxx.ts 剪成 MP4，视频用 H265 压缩"

### Step 2: 获取切片信息（二选一）

#### 方式 A：自然语言描述

用户直接用自然语言描述每个切片：

> - 片段A：00:01:30 ~ 00:02:45
> - 片段B：00:05:00 ~ 00:07:15，要精确剪切
> - 片段C：00:10:00 ~ 00:12:00，单独输出 MP3

LLM 理解并结构化。语义相近的词均可识别，如"从…到…"、"开始…结束…"等。

#### 方式 B：导入切片本文件

用户提供切片本文件路径，LLM 用 bash 读取文件内容，理解其中的格式：

> "导入 /path/to/cutlist.txt 这个切片本"

无论切片本格式是：

```
名称: 片段A
开始: 00:01:30
结束: 00:02:45
```

还是：

```
片段A    00:01:30-00:02:45
片段B    00:05:00-00:07:15
```

还是：

```
clip1, 0:01:30, 0:02:45
clip2, 0:05:00, 0:07:15
```

LLM 都能理解并提取 `{name, start, end}` 三元组。字段名可以是"开始时间/结束时间"、"start/end"、"起/止"等任意语义相近的词。

### Step 3: LLM 构造 JSON

LLM 将理解后的信息构造成 JSON。如果是方式 B（导入文件），先确认提取结果后再传给脚本。

```json
{
  "input": "/path/to/source.mp4",
  "defaultFormat": "mp3",
  "clips": [
    { "name": "片段A", "start": "00:01:30", "end": "00:02:45" },
    { "name": "片段B", "start": "00:05:00", "end": "00:07:15", "accurate": true }
  ]
}
```

### Step 4: 执行脚本

```bash
node /path/to/skills/media-batch-clip/scripts/batch_clip.mjs '<JSON>'
```

脚本执行过程：
1. 检查 ffmpeg/ffprobe 是否可用
2. ffprobe 探测源文件音视频编码
3. 根据输出格式 + 编码兼容性 + accurate 标志，为每个 clip 选择最优策略
4. 逐条执行 ffmpeg 命令
5. 生成 `_clip_record.txt` 到源文件同级目录
6. 输出结果汇总

### Step 5: 展示结果

向用户展示输出路径和处理结果，包括成功/失败的切片数。

## FFmpeg 策略说明

### 决策树

```
输出是纯音频 (mp3/aac/wav/flac/opus):
  ├─ 源音频编码 == 目标编码 → -vn -c:a copy
  └─ 否则 → -vn -c:a <编码器> (重编码)

输出是视频:
  ├─ 容器是 MKV → -c copy (MKV 无编码限制)
  ├─ accurate == true → 帧精确重编码 (-c:v libx264 -c:a aac)
  ├─ 音视频均兼容容器 → -c copy
  ├─ 视频兼容但音频不兼容 → -c:v copy -c:a aac
  └─ 均不兼容 → 完整重编码 (-c:v libx264 -c:a aac)
```

### 容器兼容性

| 容器 | 兼容视频编码 | 兼容音频编码 |
|------|-------------|-------------|
| mp4 | h264, hevc, mpeg4, av1, vp9 | aac, mp3, opus |
| mkv | **全部**（无条件 copy） | **全部**（无条件 copy） |
| ts | mpeg2video, h264, hevc | mp2, aac, ac3, eac3 |
| mov | h264, hevc, prores | aac, pcm, alac |
| avi | h264, hevc, mpeg4, mpeg2video | mp3, pcm, ac3 |

### 精确剪切

```
# 快速 copy（I帧对齐，可能不准）
ffmpeg -ss 00:01:30 -i input -to 00:02:45 -c copy out.mp4

# 精确重编码（帧精确）
ffmpeg -ss 00:01:30 -i input -to 00:02:45 -c:v libx264 -c:a aac out.mp4
```

`-ss` 放在 `-i` 前面（input seeking），重编码模式下帧精确；copy 模式下对齐到最近 I 帧。

### 音频编码器映射

| 目标格式 | ffmpeg 编码器 |
|---------|--------------|
| mp3 | libmp3lame |
| m4a | aac |
| aac | aac |
| wav | pcm_s16le |
| flac | flac |
| opus | libopus |

## 切片本格式（`_clip_record.txt`）

```
--- 批量裁剪记录 ---
源文件: source.mp4

名称: 片段A
开始: 00:01:30
结束: 00:02:45

名称: 片段B
开始: 00:05:00
结束: 00:07:15
```

失败片段追加在末尾，带 `错误:` 信息。

## 异常处理

| 异常 | 行为 |
|------|------|
| ffprobe 探测失败 | 终止该批次，打印错误日志 |
| ffmpeg 执行失败 | 跳过该 clip，记录到 _clip_record.txt 失败段 |
| 文件不存在 | 打印错误，跳过 |
| ffmpeg/ffprobe 未安装 | 启动时检查，提示安装 |

## 注意事项

- 每个 clip 独立决定编码策略（copy/encode/partial），互不影响
- 支持同时存在 audio 和 video 输出，脚本自动建 `audio/` 和 `video/` 文件夹
- 混合格式场景下，`_clip_record.txt` 只生成一份，放在源文件同级目录
