const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const SECRET = process.env.VSAVEIT_SECRET || "vsaveit-secret-change-this";
const COOKIES_PATH = path.join(__dirname, "cookies.txt");

// ── Write cookies file on startup if provided ──
// Paste the raw cookies.txt (Netscape format) content directly into the
// Railway env var YTDLP_COOKIES — no base64 encoding needed, multi-line is fine.
let hasCookies = false;
if (process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.trim().length > 0) {
  try {
    fs.writeFileSync(COOKIES_PATH, process.env.YTDLP_COOKIES.trim() + "\n");
    hasCookies = true;
    console.log("[ytserver] Cookies file loaded ✅");
  } catch (e) {
    console.error("[ytserver] Failed to write cookies file:", e.message);
  }
} else {
  console.warn("[ytserver] ⚠️  No YTDLP_COOKIES env var set — bot-detection may block requests");
}

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "VSaveIt YouTube Server", cookiesLoaded: hasCookies });
});

/**
 * Runs yt-dlp with given extra args, returns parsed JSON info.
 * Throws with err.stderr containing the actual yt-dlp error text.
 */
async function runYtDlp(url, extraArgs) {
  const safeUrl = url.replace(/"/g, "").replace(/`/g, "").replace(/\$/g, "");
  // --socket-timeout 15: each network read must complete within 15s (prevents hanging on slow CDN)
  // timeout: 55000: total process budget (long videos have big JSON manifests)
  const cmd = `yt-dlp --dump-json --no-playlist --no-warnings --socket-timeout 15 ${extraArgs} "${safeUrl}"`;
  const { stdout } = await execAsync(cmd, { timeout: 55000, maxBuffer: 1024 * 1024 * 50 });
  return JSON.parse(stdout);
}

app.post("/info", async (req, res) => {
  const { url, secret } = req.body;

  if (secret !== SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Please provide a YouTube URL" });
  }
  if (!/(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i.test(url)) {
    return res.status(400).json({ error: "Only YouTube URLs supported" });
  }

  console.log("[ytserver] Fetching:", url.slice(0, 60));

  let info;
  let lastErr;

  // ── Attempt 1: android client (often bypasses bot-check without cookies) ──
  try {
    info = await runYtDlp(url, `--extractor-args "youtube:player_client=android"`);
    console.log("[ytserver] ✅ succeeded via android client (no cookies needed)");
  } catch (err) {
    lastErr = err;
    const stderr = (err.stderr || err.message || "").toString();
    console.warn("[ytserver] android client failed:", stderr.slice(0, 150));

    // ── Attempt 2: cookies + web client (if cookies available) ──
    if (hasCookies) {
      try {
        info = await runYtDlp(
          url,
          `--cookies "${COOKIES_PATH}" --extractor-args "youtube:player_client=web,android"`
        );
        console.log("[ytserver] ✅ succeeded via cookies");
      } catch (err2) {
        lastErr = err2;
        console.error("[ytserver] cookies attempt also failed:", (err2.stderr || err2.message || "").toString().slice(0, 200));
      }
    }
  }

  if (!info) {
    const stderrText = (lastErr?.stderr || lastErr?.message || "").toString();

    if (stderrText.includes("Sign in to confirm")) {
      return res.status(403).json({
        error: hasCookies
          ? "YouTube is blocking this request even with cookies. The cookies may have expired — please refresh them."
          : "YouTube is blocking requests from this server. Cookie authentication needs to be set up (YTDLP_COOKIES).",
      });
    }
    if (stderrText.includes("Video unavailable") || stderrText.includes("Private video")) {
      return res.status(404).json({ error: "This video is private or unavailable." });
    }
    if (stderrText.includes("age")) {
      return res.status(403).json({ error: "This video is age-restricted." });
    }
    if (lastErr?.killed || stderrText.includes("timeout")) {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }

    console.error("[ytserver] Unhandled failure:", stderrText.slice(0, 300));
    return res.status(500).json({ error: "Could not fetch video info. Please try again." });
  }

  try {
    const formats = info.formats || [];

    // ── Step 1: Progressive formats (video+audio combined) — typically ≤480p on YouTube ──
    const progressive = formats.filter(
      (f) =>
        f.vcodec && f.vcodec !== "none" &&
        f.acodec && f.acodec !== "none" &&
        f.url &&
        f.ext !== "3gp"
    );

    // ── Step 2: Video-only formats (1080p, 720p+) — YouTube separates these ──
    // These are the real HD formats. acodec is "none" so the old code was throwing them away!
    const videoOnly = formats.filter(
      (f) =>
        f.vcodec && f.vcodec !== "none" &&
        (!f.acodec || f.acodec === "none") &&
        f.url &&
        f.ext !== "3gp" &&
        (f.height ?? 0) >= 720
    );

    // ── Step 3: Best audio stream (for pairing hint) ──
    const bestAudio = formats
      .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") && f.url)
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];

    // Merge all video formats and sort by height descending
    const allVideo = [...videoOnly, ...progressive];
    allVideo.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

    // Deduplicate by height (keep first = best codec)
    const seen = new Set();
    const deduped = allVideo.filter((f) => {
      const key = `${f.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const medias = deduped.map((f) => {
      const isVideoOnly = !f.acodec || f.acodec === "none";
      return {
        url: f.url,
        quality: f.height ? `${f.height}p` : (f.format_note ?? "Video"),
        extension: f.ext ?? "mp4",
        type: "video",
        formattedSize: f.filesize
          ? `${Math.round(f.filesize / 1024 / 1024)}MB`
          : f.filesize_approx
          ? `~${Math.round(f.filesize_approx / 1024 / 1024)}MB`
          : "",
        // Flag video-only so frontend can show a note
        videoOnly: isVideoOnly || undefined,
        // Include best audio URL alongside so advanced users can mux
        audioUrl: isVideoOnly && bestAudio ? bestAudio.url : undefined,
      };
    });

    // ── Step 4: Add best audio-only option ──
    const audioFormats = formats.filter(
      (f) =>
        f.acodec && f.acodec !== "none" &&
        (!f.vcodec || f.vcodec === "none") &&
        f.url
    );
    audioFormats.sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0));
    if (audioFormats.length > 0) {
      const af = audioFormats[0];
      medias.push({
        url: af.url,
        quality: af.abr ? `${Math.round(af.abr)}kbps Audio` : "Audio Only",
        extension: af.ext ?? "m4a",
        type: "audio",
        formattedSize: af.filesize
          ? `${Math.round(af.filesize / 1024 / 1024)}MB`
          : af.filesize_approx
          ? `~${Math.round(af.filesize_approx / 1024 / 1024)}MB`
          : "",
      });
    }

    if (medias.length === 0) {
      return res.status(404).json({ error: "No downloadable formats found." });
    }

    console.log("[ytserver] Returning", medias.length, "formats:", medias.map((m) => m.quality).join(", "));

    return res.json({
      title: info.title ?? "YouTube Video",
      thumbnail: info.thumbnail ?? `https://img.youtube.com/vi/${info.id}/hqdefault.jpg`,
      duration: info.duration,
      medias,
    });
  } catch (e) {
    console.error("[ytserver] Post-processing error:", e.message);
    return res.status(500).json({ error: "Could not process video info." });
  }
});

app.listen(PORT, () => {
  console.log(`VSaveIt YouTube Server running on port ${PORT}`);
  console.log(`Cookies loaded: ${hasCookies}`);
});
