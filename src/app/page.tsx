"use client";

import { useState, useCallback } from "react";

interface Caption {
  start: string;
  dur: string;
  text: string;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [lang, setLang] = useState("zh-TW");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [videoId, setVideoId] = useState("");
  const [copied, setCopied] = useState("");

  const fetchSubtitles = useCallback(
    async (overrideLang?: string) => {
      if (!url.trim()) return;

      const useLang = overrideLang || lang;
      setLang(useLang);
      setLoading(true);
      setError("");
      setCaptions([]);
      setVideoId("");

      try {
        const res = await fetch("/api/subtitles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim(), lang: useLang }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "發生錯誤");
          return;
        }

        setCaptions(data.captions);
        setVideoId(data.videoId);
      } catch {
        setError("網路錯誤，請稍後再試");
      } finally {
        setLoading(false);
      }
    },
    [url, lang]
  );

  const fullText = captions.map((c) => c.text).join("\n");

  const showCopied = useCallback((label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(""), 1500);
  }, []);

  const copyWithPrompt = useCallback(async () => {
    const textWithPrompt = `請幫我整理下面文字重點：\n\n${fullText}`;
    await navigator.clipboard.writeText(textWithPrompt);
    showCopied("ai");
  }, [fullText, showCopied]);

  const copyToClipboard = useCallback(async () => {
    await navigator.clipboard.writeText(fullText);
    showCopied("all");
  }, [fullText, showCopied]);

  const downloadText = useCallback(() => {
    const blob = new Blob([fullText], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `subtitle-${videoId || "export"}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [fullText, videoId]);

  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-center mb-8">
        YouTube 字幕擷取器
      </h1>

      <div className="flex flex-col gap-4 mb-6">
        <input
          type="text"
          placeholder="貼上 YouTube 連結..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchSubtitles()}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <div className="flex gap-3">
          <button
            onClick={() => fetchSubtitles("zh-TW")}
            disabled={loading || !url.trim()}
            className={`flex-1 px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              lang === "zh-TW" && captions.length > 0
                ? "bg-blue-600 text-white"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {loading && lang === "zh-TW" ? "擷取中..." : "中文字幕"}
          </button>
          <button
            onClick={() => fetchSubtitles("en")}
            disabled={loading || !url.trim()}
            className={`flex-1 px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              lang === "en" && captions.length > 0
                ? "bg-indigo-600 text-white"
                : "bg-indigo-600 text-white hover:bg-indigo-700"
            }`}
          >
            {loading && lang === "en" ? "Fetching..." : "English"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 mb-6 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {captions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">
              共 {captions.length} 段字幕
            </p>
            <div className="flex gap-2">
              <button
                onClick={copyWithPrompt}
                className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                {copied === "ai" ? "已複製 ✓" : "複製給 AI 整理"}
              </button>
              <button
                onClick={copyToClipboard}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                {copied === "all" ? "已複製 ✓" : "複製全部"}
              </button>
              <button
                onClick={downloadText}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                下載 .txt
              </button>
            </div>
          </div>

          <div className="border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700 max-h-[600px] overflow-y-auto">
            {captions.map((caption, i) => (
              <div
                key={i}
                className="flex gap-3 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-900/50"
              >
                <span className="text-xs text-gray-400 font-mono pt-0.5 shrink-0">
                  {formatTime(parseFloat(caption.start))}
                </span>
                <span className="text-sm">{caption.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
