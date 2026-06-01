import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, unlink } from "fs/promises";
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

function parseSrt(srt: string): Caption[] {
  const captions: Caption[] = [];
  const blocks = srt.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;

    const timeMatch = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
    );
    if (!timeMatch) continue;

    const startSec =
      parseInt(timeMatch[1]) * 3600 +
      parseInt(timeMatch[2]) * 60 +
      parseInt(timeMatch[3]) +
      parseInt(timeMatch[4]) / 1000;

    const endSec =
      parseInt(timeMatch[5]) * 3600 +
      parseInt(timeMatch[6]) * 60 +
      parseInt(timeMatch[7]) +
      parseInt(timeMatch[8]) / 1000;

    const text = lines.slice(2).join(" ").trim();
    if (!text) continue;

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
    let inAutoSection = false;
    let inManualSection = false;

    for (const line of lines) {
      if (line.includes("Available automatic captions")) {
        inAutoSection = true;
        inManualSection = false;
        continue;
      }
      if (line.includes("Available subtitles")) {
        inManualSection = true;
        inAutoSection = false;
        continue;
      }
      if (line.startsWith("Language")) continue;

      if ((inAutoSection || inManualSection) && line.trim()) {
        const langMatch = line.match(/^(\S+)/);
        if (langMatch && !langMatch[1].includes("-en")) {
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
        "--sub-format", "srt",
        "--skip-download",
        "-o", tempPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: 30000 });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr || "";
      if (stderr.includes("No video formats found") || stderr.includes("unavailable")) {
        return NextResponse.json({ error: "影片不存在或無法存取" }, { status: 404 });
      }
    }

    const possibleFiles = [
      `${tempPath}.${subLang}.srt`,
      `${tempPath}.${subLang.split("-")[0]}.srt`,
    ];

    let srtContent = "";
    let usedFile = "";

    for (const file of possibleFiles) {
      try {
        srtContent = await readFile(file, "utf-8");
        usedFile = file;
        break;
      } catch {
        continue;
      }
    }

    if (!srtContent) {
      const availableLangs = await listAvailableLangs(videoId);
      return NextResponse.json(
        {
          error: `找不到「${subLang}」的字幕`,
          availableLangs,
        },
        { status: 404 }
      );
    }

    if (usedFile) {
      unlink(usedFile).catch(() => {});
    }

    const captions = parseSrt(srtContent);
    const availableLangs = await listAvailableLangs(videoId);

    return NextResponse.json({ videoId, captions, availableLangs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "無法取得字幕";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
