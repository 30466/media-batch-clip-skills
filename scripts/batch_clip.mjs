#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, basename, extname, join } from 'path';
import { tmpdir } from 'os';

// ─── Helpers ────────────────────────────────────────────────────────────────

const AUDIO_FORMATS = new Set(['mp3', 'aac', 'wav', 'flac', 'opus', 'm4a']);

function isAudioFormat(fmt) {
  return AUDIO_FORMATS.has(fmt);
}

function getExt(fmt) {
  return '.' + fmt;
}

function safeName(name, idx) {
  return (name || `clip_${idx}`).replace(/[\\/*?:"<>|]/g, '_');
}

// ─── Codec compatibility table ──────────────────────────────────────────────

const COMPAT = {
  mp4: {
    video: new Set(['h264', 'hevc', 'mpeg4', 'av1', 'vp9']),
    audio: new Set(['aac', 'mp3', 'opus']),
  },
  mkv: { video: null, audio: null }, // null = everything allowed
  ts: {
    video: new Set(['mpeg2video', 'h264', 'hevc']),
    audio: new Set(['mp2', 'aac', 'ac3', 'eac3']),
  },
  mov: {
    video: new Set(['h264', 'hevc', 'prores']),
    audio: new Set(['aac', 'pcm', 'alac']),
  },
  avi: {
    video: new Set(['mpeg4', 'h264', 'hevc', 'mpeg2video']),
    audio: new Set(['mp3', 'pcm', 'ac3']),
  },
};

function isCompat(container, kind, codec) {
  if (!codec) return true;
  const rules = COMPAT[container];
  if (!rules) return false;
  if (rules[kind] === null) return true; // MKV wildcard
  return rules[kind].has(codec);
}

// ─── Audio encoder map ──────────────────────────────────────────────────────

const AUDIO_ENCODER = {
  mp3: 'libmp3lame',
  m4a: 'aac',
  aac: 'aac',
  wav: 'pcm_s16le',
  flac: 'flac',
  opus: 'libopus',
};

// ─── M3U8 helpers ──────────────────────────────────────────────

function timeToSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0]) || 0;
}

function formatTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fetchM3U8Sync(url) {
  const text = execSync(`curl -sL ${JSON.stringify(url)}`, {
    encoding: 'utf-8', timeout: 30000,
  });
  return text;
}

function parseM3U8(text) {
  const headerLines = [];
  const segments = [];
  let currentDuration = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const m = trimmed.match(/^#EXTINF:([\d.]+)/);
      if (m) currentDuration = parseFloat(m[1]);
      if (!trimmed.startsWith('#EXTINF') && trimmed !== '#EXTM3U') headerLines.push(trimmed);
    } else {
      segments.push({ url: trimmed, duration: currentDuration });
      currentDuration = 0;
    }
  }
  return { headerLines, segments };
}

// ─── ffprobe ────────────────────────────────────────────────────────────────

function probe(file) {
  try {
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_streams ${JSON.stringify(file)}`,
      { encoding: 'utf-8', timeout: 20000 }
    );
    const data = JSON.parse(raw);
    const vs = (data.streams || []).find(s => s.codec_type === 'video');
    const as = (data.streams || []).find(s => s.codec_type === 'audio');
    return {
      videoCodec: vs?.codec_name || null,
      audioCodec: as?.codec_name || null,
      hasVideo: !!vs,
      hasAudio: !!as,
    };
  } catch (e) {
    return { error: `ffprobe failed: ${e.message}` };
  }
}

// ─── Tool check ─────────────────────────────────────────────────────────────

function checkTools() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      execSync(`${tool} -version`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    } catch {
      console.error(`Required tool not found: ${tool}`);
      console.error('Install ffmpeg first: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)');
      process.exit(1);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  checkTools();

  // ── Parse input ────────────────────────────────────────────────────────

  const raw = process.argv[2];
  if (!raw) {
    console.error('Usage: node batch_clip.mjs \'<JSON>\'');
    process.exit(1);
  }

  let jobs;
  try {
    const parsed = JSON.parse(raw);
    jobs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    console.error('Invalid JSON input');
    process.exit(1);
  }

  let totalOk = 0;
  let totalFail = 0;

  for (const job of jobs) {
    if (!job.input || (!job.isM3U8 && !existsSync(job.input))) {
      console.error(`\nInput file not found: ${job.input}`);
      totalFail += (job.clips || []).length;
      continue;
    }
    if (!job.clips || job.clips.length === 0) {
      console.error(`\nNo clips specified for: ${job.input}`);
      continue;
    }

    runJob(job);
    const okCount = job.clips.filter(c => c._ok).length;
    totalOk += okCount;
    totalFail += job.clips.length - okCount;
  }

  console.log(`\n=== 全部完成: ${totalOk} 成功, ${totalFail} 失败 ===`);
  if (totalFail > 0) process.exit(1);
}

function runJob(job) {
  const src = job.input;
  const isM3U8 = job.isM3U8 === true;
  const srcBase = basename(job.input);
  const defaultFormat = job.defaultFormat || 'mp4';
  const videoCodec = job.videoCodec || 'libx264';
  const clips = job.clips;

  const member = job.member || null;
  const broadcastTime = job.broadcastTime || null;
  const outDir = job.outDir || null;

  // ── Output base directory ───────────────────────────────────────────────
  let srcDir;
  if (member && broadcastTime) {
    srcDir = join(outDir || process.cwd(), member, broadcastTime);
    if (!existsSync(srcDir)) mkdirSync(srcDir, { recursive: true });
  } else {
    srcDir = dirname(job.input);
  }

  // ── M3U8: fetch + parse once ────────────────────────────────
  let m3u8Segments = null;
  let m3u8BaseUrl = null;
  let m3u8Origin = null;

  if (isM3U8) {
    console.log(`\n━━━ ${srcBase} ━━━\n  解析M3U8分片列表…`);
    const text = fetchM3U8Sync(src);
    const parsed = parseM3U8(text);
    m3u8Segments = parsed.segments;
    const u = new URL(src);
    m3u8Origin = u.origin;
    m3u8BaseUrl = src.substring(0, src.lastIndexOf('/') + 1);
    console.log(`  共 ${m3u8Segments.length} 个分片`);
  }

  console.log(`\n━━━ ${srcBase} ━━━`);

  // ── Probe source ───────────────────────────────────────────────────────

  const info = probe(src);
  if (info.error) {
    if (isM3U8) {
      console.log(`  ffprobe探测失败，默认H.264+AAC`);
      info.videoCodec = 'h264';
      info.audioCodec = 'aac';
      info.hasVideo = true;
      info.hasAudio = true;
    } else {
      console.error(`  ${info.error}`);
      for (const c of clips) c._ok = false;
      return;
    }
  }
  console.log(`  视频编码: ${info.videoCodec || '—'}  音频编码: ${info.audioCodec || '—'}`);

  // ── Determine output folders ───────────────────────────────────────────

  const needAudio = clips.some(c => isAudioFormat(c.format || defaultFormat));
  const needVideo = clips.some(c => !isAudioFormat(c.format || defaultFormat));

  let audioDir = null;
  let videoDir = null;

  if (needAudio) {
    audioDir = join(srcDir, 'audio');
    if (!existsSync(audioDir)) mkdirSync(audioDir, { recursive: true });
  }
  if (needVideo) {
    videoDir = join(srcDir, 'video');
    if (!existsSync(videoDir)) mkdirSync(videoDir, { recursive: true });
  }

  // ── Process clips ──────────────────────────────────────────────────────

  const results = [];
  const failures = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const fmt = clip.format || defaultFormat;
    const isAudio = isAudioFormat(fmt);
    const name = safeName(clip.name, i);
    const outDir = isAudio ? audioDir : videoDir;
    const outPath = join(outDir, `${name}${getExt(fmt)}`);
    const accurate = clip.accurate === true;

    const tag = `[${i + 1}/${clips.length}] ${clip.name || `clip_${i}`}`;
    process.stdout.write(`  ${tag} (${fmt}) … `);

    // ── Per-clip source ───────────────────────────────────────────────
    let clipSrc = src;
    let clipStart = clip.start;
    let clipEnd = clip.end;
    let clipProtoWhitelist = '';

    if (isM3U8 && m3u8Segments) {
      const padding = 10;
      const globalStart = Math.max(0, timeToSeconds(clip.start) - padding);
      const globalEnd = timeToSeconds(clip.end) + padding;

      let cum = 0;
      const selected = [];
      for (const seg of m3u8Segments) {
        const segEnd = cum + seg.duration;
        if (segEnd > globalStart && cum < globalEnd) selected.push(seg);
        cum = segEnd;
        if (cum > globalEnd) break;
      }

      let output = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGET-DURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n';
      for (const seg of selected) {
        let segUrl;
        if (seg.url.startsWith('http')) {
          segUrl = seg.url;
        } else if (seg.url.startsWith('/')) {
          segUrl = m3u8Origin + seg.url;
        } else {
          segUrl = m3u8BaseUrl + seg.url;
        }
        output += `#EXTINF:${seg.duration.toFixed(3)},\n${segUrl}\n`;
      }
      output += '#EXT-X-ENDLIST\n';

      const tmpFile = join(tmpdir(), `sub_m3u8_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.m3u8`);
      writeFileSync(tmpFile, output, 'utf-8');

      clipSrc = tmpFile;
      clipStart = formatTime(timeToSeconds(clip.start) - globalStart);
      clipEnd = formatTime(timeToSeconds(clip.end) - globalStart);
      clipProtoWhitelist = '-protocol_whitelist file,crypto,data,https,tls,tcp,http ';
    }

    try {
      const args = buildArgs(clipSrc, fmt, info, videoCodec, clipStart, clipEnd, accurate);
      args.push(JSON.stringify(outPath));

      execSync(`ffmpeg -y ${clipProtoWhitelist}${args.join(' ')}`, {
        encoding: 'utf-8',
        timeout: 600_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      console.log('✅');
      clip._ok = true;
      results.push({ name: clip.name || `clip_${i}`, start: clip.start, end: clip.end, format: fmt, output: outPath });
    } catch (e) {
      console.log(`❌`);
      clip._ok = false;
      const errMsg = e.stderr?.toString() || '';
      const shortErr = errMsg.length > 500 ? '...' + errMsg.slice(-500) : errMsg;
      failures.push({ name: clip.name || `clip_${i}`, start: clip.start, end: clip.end, format: fmt, error: shortErr || e.message });
    } finally {
      if (isM3U8 && clipSrc !== src) {
        rmSync(clipSrc);
      }
    }
  }

  // ── Generate _clip_record.txt ──────────────────────────────────────────

  const recordPath = join(srcDir, '_clip_record.txt');
  const recordSrc = (member && broadcastTime) ? `[口袋48录播] ${member} ${broadcastTime}` : srcBase;
  let record = `--- 批量裁剪记录 ---\n源文件: ${recordSrc}\n\n`;

  for (const r of results) {
    record += `名称: ${r.name}\n开始: ${r.start}\n结束: ${r.end}\n\n`;
  }

  if (failures.length > 0) {
    record += `--- 失败片段 ---\n`;
    for (const f of failures) {
      record += `名称: ${f.name}\n开始: ${f.start}\n结束: ${f.end}\n错误: ${f.error}\n\n`;
    }
  }

  writeFileSync(recordPath, record, 'utf-8');
  console.log(`  📝 切片本: ${recordPath}`);
}

// ─── FFmpeg argument builder ────────────────────────────────────────────────

function buildArgs(src, fmt, info, videoCodec, start, end, accurate) {
  const args = [];

  if (isAudioFormat(fmt)) {
    // ─── Audio output ──────────────────────────────────────────────────
    args.push('-i', JSON.stringify(src));
    args.push('-ss', start);
    args.push('-to', end);
    args.push('-vn'); // always strip video for audio output

    const srcAC = info.audioCodec;
    const canCopy =
      (srcAC === fmt) ||
      (srcAC === 'aac' && fmt === 'm4a');

    if (canCopy && !accurate) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', AUDIO_ENCODER[fmt] || 'aac');
    }
  } else {
    // ─── Video output ──────────────────────────────────────────────────
    const container = fmt;

    if (container === 'mkv') {
      // MKV: everything is compatible
      args.push('-i', JSON.stringify(src));
      args.push('-ss', start);
      args.push('-to', end);
      args.push('-c', 'copy');
    } else if (accurate) {
      // Frame-accurate: full re-encode
      args.push('-i', JSON.stringify(src));
      args.push('-ss', start);
      args.push('-to', end);
      args.push('-c:v', videoCodec);
      args.push('-c:a', 'aac');
    } else {
      // Check container compatibility
      const vOk = isCompat(container, 'video', info.videoCodec);
      const aOk = isCompat(container, 'audio', info.audioCodec);

      args.push('-i', JSON.stringify(src));
      args.push('-ss', start);
      args.push('-to', end);

      if (vOk && aOk) {
        args.push('-c', 'copy');
      } else if (vOk && !aOk) {
        args.push('-c:v', 'copy');
        args.push('-c:a', 'aac'); // re-encode audio only
      } else {
        args.push('-c:v', videoCodec);
        args.push('-c:a', 'aac');
      }
    }
  }

  return args;
}

main();
