import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

interface Caption {
  start: string;
  dur: string;
  text: string;
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  return null;
}

function parseTimestamp(ts: string): number {
  // 支援 SRT "00:01:23,456" 和 VTT "00:01:23.456"
  const match = ts.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  return (
    parseInt(match[1]) * 3600 +
    parseInt(match[2]) * 60 +
    parseInt(match[3]) +
    parseInt(match[4]) / 1000
  );
}

function parseSubtitle(content: string): Caption[] {
  const captions: Caption[] = [];
  const seen = new Set<string>();

  // 移除 VTT header 和 metadata
  const cleaned = content
    .replace(/^WEBVTT[\s\S]*?\n\n/, "")
    .replace(/^Kind:.*\n/gm, "")
    .replace(/^Language:.*\n/gm, "")
    .replace(/<[^>]+>/g, ""); // 移除 HTML 標籤如 <c>, </c>

  const blocks = cleaned.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.length < 2) continue;

    // 找到時間軸那一行
    let timeLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        timeLineIdx = i;
        break;
      }
    }
    if (timeLineIdx === -1) continue;

    const timeParts = lines[timeLineIdx].split("-->");
    if (timeParts.length !== 2) continue;

    const startSec = parseTimestamp(timeParts[0].trim());
    const endSec = parseTimestamp(timeParts[1].trim().split(" ")[0]);

    const textLines = lines.slice(timeLineIdx + 1);
    const text = textLines.join(" ").trim();
    if (!text) continue;

    // 去重（VTT 自動字幕常有重複行）
    if (seen.has(text)) continue;
    seen.add(text);

    captions.push({
      start: startSec.toFixed(3),
      dur: (endSec - startSec).toFixed(3),
      text,
    });
  }

  return captions;
}

async function listAvailableLangs(videoId: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--list-subs",
      "--skip-download",
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 30000 });

    const langs: string[] = [];
    const lines = stdout.split("\n");
    let inSection = false;

    for (const line of lines) {
      if (line.includes("Available automatic captions") || line.includes("Available subtitles")) {
        inSection = true;
        continue;
      }
      if (line.startsWith("Language")) continue;

      if (inSection && line.trim()) {
        const langMatch = line.match(/^(\S+)/);
        if (langMatch && !langMatch[1].includes("-")) {
          langs.push(langMatch[1]);
        }
      }
    }

    return [...new Set(langs)];
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    const { url, lang } = await request.json();

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "請提供 YouTube 連結" }, { status: 400 });
    }

    const videoId = extractVideoId(url.trim());
    if (!videoId) {
      return NextResponse.json({ error: "無效的 YouTube 連結" }, { status: 400 });
    }

    const subLang = lang || "zh-TW";
    const tempId = randomUUID();
    const tempPath = join(tmpdir(), `yt-sub-${tempId}`);

    try {
      await execFileAsync("yt-dlp", [
        "--write-sub",
        "--write-auto-sub",
        "--sub-lang", subLang,
        "--sub-format", "srt/vtt/best",
        "--skip-download",
        "-o", tempPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: 60000 });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr || "";
      if (stderr.includes("No video formats found") || stderr.includes("unavailable")) {
        return NextResponse.json({ error: "影片不存在或無法存取" }, { status: 404 });
      }
    }

    // 搜尋所有可能的輸出檔案（srt 或 vtt）
    const dir = tmpdir();
    const prefix = `yt-sub-${tempId}`;
    const allFiles = await readdir(dir);
    const matchedFiles = allFiles.filter(
      (f) => f.startsWith(prefix) && (f.endsWith(".srt") || f.endsWith(".vtt"))
    );

    let subContent = "";

    for (const file of matchedFiles) {
      const fullPath = join(dir, file);
      try {
        subContent = await readFile(fullPath, "utf-8");
        break;
      } catch {
        continue;
      }
    }

    if (!subContent) {
      const availableLangs = await listAvailableLangs(videoId);
      return NextResponse.json(
        {
          error: `找不到「${subLang}」的字幕`,
          availableLangs,
        },
        { status: 404 }
      );
    }

    // 清理暫存檔
    for (const file of matchedFiles) {
      unlink(join(dir, file)).catch(() => {});
    }

    const captions = parseSubtitle(subContent);
    const availableLangs = await listAvailableLangs(videoId);

    return NextResponse.json({ videoId, captions, availableLangs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "無法取得字幕";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
