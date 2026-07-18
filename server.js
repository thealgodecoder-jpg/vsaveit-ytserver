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
  const cmd = `yt-dlp --dump-json --no-playlist --no-warnings ${extraArgs} "${safeUrl}"`;
  const { stdout } = await execAsync(cmd, { timeout: 28000, maxBuffer: 1024 * 1024 * 20 });
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

    const progressive = formats.filter(
      (f) =>
        f.vcodec && f.vcodec !== "none" &&
        f.acodec && f.acodec !== "none" &&
        f.url &&
        f.ext !== "3gp"
    );

    progressive.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

    const seen = new Set();
    const deduped = progressive.filter((f) => {
      const key = `${f.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const medias = deduped.map((f) => ({
      url: f.url,
      quality: f.height ? `${f.height}p` : (f.format_note ?? "Video"),
      extension: f.ext ?? "mp4",
      type: "video",
      formattedSize: f.filesize
        ? `${Math.round(f.filesize / 1024 / 1024)}MB`
        : f.filesize_approx
        ? `~${Math.round(f.filesize_approx / 1024 / 1024)}MB`
        : "",
    }));

    if (medias.length === 0) {
      return res.status(404).json({ error: "No downloadable formats found." });
    }

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
