const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const os = require("os");
const crypto = require("crypto");

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const SECRET = process.env.VSAVEIT_SECRET || "vsaveit-secret-change-this";
const COOKIES_PATH = path.join(__dirname, "cookies.txt");
const TMP_DIR = os.tmpdir();

// ── Write cookies on startup ──
let hasCookies = false;
if (process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.trim().length > 0) {
  try {
    fs.writeFileSync(COOKIES_PATH, process.env.YTDLP_COOKIES.trim() + "\n");
    hasCookies = true;
    console.log("[ytserver] Cookies loaded ✅");
  } catch (e) {
    console.error("[ytserver] Failed to write cookies:", e.message);
  }
} else {
  console.warn("[ytserver] ⚠️  No YTDLP_COOKIES set");
}

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "VSaveIt YouTube Server", cookiesLoaded: hasCookies });
});

// ── Build cookie args string ──
function cookieArgs() {
  return hasCookies ? `--cookies "${COOKIES_PATH}"` : "";
}

// ── Build extractor args ──
function extractorArgs(withCookies) {
  return withCookies
    ? `--extractor-args "youtube:player_client=web,android"`
    : `--extractor-args "youtube:player_client=android"`;
}

// ── Run yt-dlp --dump-json ──
async function runYtDlpInfo(url, extra) {
  const safe = url.replace(/"/g, "").replace(/`/g, "").replace(/\$/g, "");
  const cmd = `yt-dlp --dump-json --no-playlist --no-warnings --socket-timeout 15 ${extra} "${safe}"`;
  const { stdout } = await execAsync(cmd, { timeout: 55000, maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// ── Fetch info with fallback ──
async function fetchInfo(url) {
  let info = null, lastErr = null;
  try {
    info = await runYtDlpInfo(url, extractorArgs(false));
    console.log("[ytserver] ✅ android client");
  } catch (e) {
    lastErr = e;
    console.warn("[ytserver] android failed:", (e.stderr || e.message || "").toString().slice(0, 120));
    if (hasCookies) {
      try {
        info = await runYtDlpInfo(url, `${cookieArgs()} ${extractorArgs(true)}`);
        console.log("[ytserver] ✅ cookies client");
      } catch (e2) {
        lastErr = e2;
        console.error("[ytserver] cookies failed:", (e2.stderr || e2.message || "").toString().slice(0, 200));
      }
    }
  }
  return { info, lastErr };
}

// ════════════════════════════════════════════════
// /info  — returns format list (no downloading)
// ════════════════════════════════════════════════
app.post("/info", async (req, res) => {
  const { url, secret } = req.body;
  if (secret !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (!url || typeof url !== "string") return res.status(400).json({ error: "Provide a YouTube URL" });
  if (!/(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i.test(url)) {
    return res.status(400).json({ error: "Only YouTube URLs supported" });
  }

  console.log("[ytserver] /info:", url.slice(0, 70));
  const { info, lastErr } = await fetchInfo(url);

  if (!info) {
    const txt = (lastErr?.stderr || lastErr?.message || "").toString();
    if (txt.includes("Sign in to confirm"))
      return res.status(403).json({ error: hasCookies ? "Cookies expired — please refresh them." : "Set YTDLP_COOKIES in Railway." });
    if (txt.includes("Video unavailable") || txt.includes("Private video"))
      return res.status(404).json({ error: "Video is private or unavailable." });
    if (txt.includes("age"))
      return res.status(403).json({ error: "Age-restricted video." });
    if (lastErr?.killed || txt.includes("timeout"))
      return res.status(504).json({ error: "Request timed out. Try again." });
    return res.status(500).json({ error: "Could not fetch video info." });
  }

  try {
    const formats = info.formats || [];

    // Best audio-only stream
    const bestAudio = formats
      .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") && f.url)
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];

    // Progressive (video+audio in one) — usually ≤480p
    const progressive = formats.filter(
      (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url && f.ext !== "3gp"
    );

    // Video-only HD (720p+) — need server-side merge
    const videoOnly = formats.filter(
      (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && f.url && f.ext !== "3gp" && (f.height ?? 0) >= 720
    );

    // Merge and deduplicate
    const all = [...videoOnly, ...progressive].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const seen = new Set();
    const deduped = all.filter((f) => {
      const k = `${f.height}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const medias = deduped.map((f) => {
      const isVideoOnly = !f.acodec || f.acodec === "none";
      const sizeStr = f.filesize ? `${Math.round(f.filesize / 1024 / 1024)}MB`
        : f.filesize_approx ? `~${Math.round(f.filesize_approx / 1024 / 1024)}MB` : "";
      return {
        // For video-only: expose a /download endpoint URL (server merges internally)
        // For progressive: direct CDN URL is fine
        url: isVideoOnly && bestAudio
          ? null   // will be set below
          : f.url,
        quality: f.height ? `${f.height}p` : (f.format_note ?? "Video"),
        extension: "mp4",
        type: "video",
        formattedSize: sizeStr,
        // Pass format IDs so /download can pick the right streams
        needsMerge: isVideoOnly && !!bestAudio,
        ytUrl: url,           // original YouTube URL — /download will re-fetch
        formatId: f.format_id,
        audioFormatId: isVideoOnly && bestAudio ? bestAudio.format_id : undefined,
      };
    });

    // For needsMerge items, replace null url with a /download endpoint call instruction
    // Frontend will POST to /download with ytUrl + formatId + audioFormatId
    const finalMedias = medias.map((m) => {
      if (m.needsMerge) {
        return { ...m, url: "__merge__" }; // signal to frontend
      }
      return m;
    });

    // Audio only
    if (bestAudio) {
      const sizeStr = bestAudio.filesize ? `${Math.round(bestAudio.filesize / 1024 / 1024)}MB`
        : bestAudio.filesize_approx ? `~${Math.round(bestAudio.filesize_approx / 1024 / 1024)}MB` : "";
      finalMedias.push({
        url: bestAudio.url,
        quality: bestAudio.abr ? `${Math.round(bestAudio.abr)}kbps Audio` : "Audio Only",
        extension: bestAudio.ext ?? "m4a",
        type: "audio",
        formattedSize: sizeStr,
        needsMerge: false,
      });
    }

    if (finalMedias.length === 0) return res.status(404).json({ error: "No formats found." });
    console.log("[ytserver] formats:", finalMedias.map((m) => m.quality).join(", "));

    return res.json({
      title: info.title ?? "YouTube Video",
      thumbnail: info.thumbnail ?? `https://img.youtube.com/vi/${info.id}/hqdefault.jpg`,
      duration: info.duration,
      medias: finalMedias,
    });
  } catch (e) {
    console.error("[ytserver] post-process error:", e.message);
    return res.status(500).json({ error: "Could not process video info." });
  }
});

// ════════════════════════════════════════════════
// /download  — yt-dlp downloads + ffmpeg merges → streams MP4
// Body: { ytUrl, formatId, audioFormatId, title, secret }
// ════════════════════════════════════════════════
app.post("/download", async (req, res) => {
  const { ytUrl, formatId, audioFormatId, title, secret } = req.body;

  if (secret !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (!ytUrl || !formatId || !audioFormatId) {
    return res.status(400).json({ error: "ytUrl, formatId, audioFormatId required" });
  }

  const id = crypto.randomBytes(8).toString("hex");
  const outFile = path.join(TMP_DIR, `merged_${id}.mp4`);
  const safeTitle = (title || "video").replace(/[^\w\s-]/g, "").trim().slice(0, 80) || "video";
  const safeUrl = ytUrl.replace(/"/g, "").replace(/`/g, "").replace(/\$/g, "");

  console.log(`[download] ${id} format=${formatId}+${audioFormatId} title="${safeTitle}"`);

  function cleanup() {
    try { fs.unlinkSync(outFile); } catch {}
    // Also clean up any temp files yt-dlp may have left
    try {
      const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(`ytdl_${id}`));
      files.forEach(f => { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch {} });
    } catch {}
  }

  try {
    // yt-dlp downloads both streams and merges them itself via ffmpeg
    const cookies = cookieArgs();
    const extArgs = extractorArgs(hasCookies);
    const cmd = [
      "yt-dlp",
      "--no-warnings",
      "--no-playlist",
      "-f", `${formatId}+${audioFormatId}`,
      "--merge-output-format", "mp4",
      "--socket-timeout", "20",
      cookies,
      extArgs,
      "-o", `"${outFile}"`,
      `"${safeUrl}"`,
    ].filter(Boolean).join(" ");

    console.log(`[download] ${id} running yt-dlp merge...`);
    await execAsync(cmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }); // 5 min budget

    if (!fs.existsSync(outFile)) {
      throw new Error("Output file not created");
    }

    const stat = fs.statSync(outFile);
    console.log(`[download] ${id} done — ${Math.round(stat.size / 1024 / 1024)}MB`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on("close", cleanup);
    stream.on("error", (err) => {
      console.error(`[download] ${id} stream error:`, err.message);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: "Stream error" });
    });
  } catch (e) {
    cleanup();
    console.error(`[download] ${id} FAILED:`, e.message.slice(0, 300));
    if (!res.headersSent) {
      res.status(500).json({ error: "Download/merge failed. Please try again." });
    }
  }
});

app.listen(PORT, () => {
  console.log(`VSaveIt YouTube Server running on port ${PORT}`);
  console.log(`Cookies: ${hasCookies}`);
});
