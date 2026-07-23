const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const os = require("os");
const crypto = require("crypto");

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const SECRET = process.env.VSAVEIT_SECRET || "vsaveit-secret-change-this";
const COOKIES_PATH = path.join(__dirname, "cookies.txt");
const TMP_DIR = os.tmpdir();

// ── Write cookies file on startup if provided ──
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

// ── Helper: run yt-dlp and return parsed JSON info ──
async function runYtDlp(url, extraArgs) {
  const safeUrl = url.replace(/"/g, "").replace(/`/g, "").replace(/\$/g, "");
  const cmd = `yt-dlp --dump-json --no-playlist --no-warnings --socket-timeout 15 ${extraArgs} "${safeUrl}"`;
  const { stdout } = await execAsync(cmd, { timeout: 55000, maxBuffer: 1024 * 1024 * 50 });
  return JSON.parse(stdout);
}

// ── Helper: fetch video info with fallback strategies ──
async function fetchInfo(url) {
  let info = null;
  let lastErr = null;

  // Attempt 1: android client (bypasses bot-check without cookies)
  try {
    info = await runYtDlp(url, `--extractor-args "youtube:player_client=android"`);
    console.log("[ytserver] ✅ android client");
  } catch (err) {
    lastErr = err;
    console.warn("[ytserver] android failed:", (err.stderr || err.message || "").toString().slice(0, 120));

    // Attempt 2: cookies + web client
    if (hasCookies) {
      try {
        info = await runYtDlp(
          url,
          `--cookies "${COOKIES_PATH}" --extractor-args "youtube:player_client=web,android"`
        );
        console.log("[ytserver] ✅ cookies client");
      } catch (err2) {
        lastErr = err2;
        console.error("[ytserver] cookies failed:", (err2.stderr || err2.message || "").toString().slice(0, 200));
      }
    }
  }

  return { info, lastErr };
}

// ── /info endpoint — returns available formats ──
app.post("/info", async (req, res) => {
  const { url, secret } = req.body;

  if (secret !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (!url || typeof url !== "string") return res.status(400).json({ error: "Please provide a YouTube URL" });
  if (!/(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i.test(url)) {
    return res.status(400).json({ error: "Only YouTube URLs supported" });
  }

  console.log("[ytserver] /info:", url.slice(0, 60));

  const { info, lastErr } = await fetchInfo(url);

  if (!info) {
    const stderrText = (lastErr?.stderr || lastErr?.message || "").toString();
    if (stderrText.includes("Sign in to confirm")) {
      return res.status(403).json({
        error: hasCookies
          ? "YouTube is blocking even with cookies. Please refresh your cookies."
          : "YouTube is blocking this server. Set YTDLP_COOKIES in Railway.",
      });
    }
    if (stderrText.includes("Video unavailable") || stderrText.includes("Private video")) {
      return res.status(404).json({ error: "This video is private or unavailable." });
    }
    if (stderrText.includes("age")) return res.status(403).json({ error: "This video is age-restricted." });
    if (lastErr?.killed || stderrText.includes("timeout")) {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }
    return res.status(500).json({ error: "Could not fetch video info. Please try again." });
  }

  try {
    const formats = info.formats || [];

    // Best audio stream
    const bestAudio = formats
      .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") && f.url)
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];

    // Progressive (video+audio combined) — usually ≤480p
    const progressive = formats.filter(
      (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url && f.ext !== "3gp"
    );

    // Video-only (720p, 1080p, 1440p, 4K) — these need merging with audio
    const videoOnly = formats.filter(
      (f) =>
        f.vcodec && f.vcodec !== "none" &&
        (!f.acodec || f.acodec === "none") &&
        f.url &&
        f.ext !== "3gp" &&
        (f.height ?? 0) >= 720
    );

    // Combine, sort, deduplicate
    const allVideo = [...videoOnly, ...progressive];
    allVideo.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
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
        extension: "mp4",
        type: "video",
        formattedSize: f.filesize
          ? `${Math.round(f.filesize / 1024 / 1024)}MB`
          : f.filesize_approx
          ? `~${Math.round(f.filesize_approx / 1024 / 1024)}MB`
          : "",
        // Tell frontend: this needs server-side merging
        needsMerge: isVideoOnly && !!bestAudio,
        audioUrl: isVideoOnly && bestAudio ? bestAudio.url : undefined,
      };
    });

    // Audio only option
    if (bestAudio) {
      medias.push({
        url: bestAudio.url,
        quality: bestAudio.abr ? `${Math.round(bestAudio.abr)}kbps Audio` : "Audio Only",
        extension: bestAudio.ext ?? "m4a",
        type: "audio",
        formattedSize: bestAudio.filesize
          ? `${Math.round(bestAudio.filesize / 1024 / 1024)}MB`
          : bestAudio.filesize_approx
          ? `~${Math.round(bestAudio.filesize_approx / 1024 / 1024)}MB`
          : "",
        needsMerge: false,
      });
    }

    if (medias.length === 0) return res.status(404).json({ error: "No downloadable formats found." });

    console.log("[ytserver] formats:", medias.map((m) => m.quality).join(", "));

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

// ── /merge endpoint — downloads video+audio and merges with ffmpeg, streams result ──
// Called by frontend when needsMerge=true
app.post("/merge", async (req, res) => {
  const { videoUrl, audioUrl, title, secret } = req.body;

  if (secret !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (!videoUrl || !audioUrl) return res.status(400).json({ error: "videoUrl and audioUrl required" });

  const id = crypto.randomBytes(8).toString("hex");
  const videoFile = path.join(TMP_DIR, `v_${id}.mp4`);
  const audioFile = path.join(TMP_DIR, `a_${id}.m4a`);
  const outFile   = path.join(TMP_DIR, `out_${id}.mp4`);

  const safeTitle = (title || "video").replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 80) || "video";

  console.log(`[merge] ${id} starting`);

  function cleanup() {
    for (const f of [videoFile, audioFile, outFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }

  try {
    // Download video stream
    console.log(`[merge] ${id} downloading video...`);
    await execAsync(
      `yt-dlp --no-warnings -o "${videoFile}" "${videoUrl.replace(/"/g, "")}"`,
      { timeout: 120000, maxBuffer: 1024 * 1024 * 10 }
    );

    // Download audio stream
    console.log(`[merge] ${id} downloading audio...`);
    await execAsync(
      `yt-dlp --no-warnings -o "${audioFile}" "${audioUrl.replace(/"/g, "")}"`,
      { timeout: 60000, maxBuffer: 1024 * 1024 * 10 }
    );

    // Merge with ffmpeg
    console.log(`[merge] ${id} merging with ffmpeg...`);
    await execAsync(
      `ffmpeg -y -i "${videoFile}" -i "${audioFile}" -c:v copy -c:a aac -movflags +faststart "${outFile}"`,
      { timeout: 180000, maxBuffer: 1024 * 1024 * 10 }
    );

    const stat = fs.statSync(outFile);
    console.log(`[merge] ${id} done — ${Math.round(stat.size / 1024 / 1024)}MB`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`);
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on("end", cleanup);
    stream.on("error", (err) => {
      console.error(`[merge] ${id} stream error:`, err.message);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: "Stream error" });
    });
  } catch (e) {
    cleanup();
    console.error(`[merge] ${id} failed:`, e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Merge failed. Please try again." });
    }
  }
});

// ── /merge-redirect — GET endpoint so browser <a href> download works directly ──
// Query params: videoUrl, audioUrl, title, secret
app.get("/merge-redirect", async (req, res) => {
  const { videoUrl, audioUrl, title, secret } = req.query;

  if (secret !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (!videoUrl || !audioUrl) return res.status(400).json({ error: "videoUrl and audioUrl required" });

  const id = crypto.randomBytes(8).toString("hex");
  const videoFile = path.join(TMP_DIR, `v_${id}.mp4`);
  const audioFile = path.join(TMP_DIR, `a_${id}.m4a`);
  const outFile   = path.join(TMP_DIR, `out_${id}.mp4`);

  const safeTitle = (title || "video").toString().replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 80) || "video";

  console.log(`[merge] ${id} starting for: ${safeTitle}`);

  function cleanup() {
    for (const f of [videoFile, audioFile, outFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }

  try {
    console.log(`[merge] ${id} downloading video...`);
    await execAsync(
      `yt-dlp --no-warnings -o "${videoFile}" "${videoUrl.toString().replace(/"/g, "")}"`,
      { timeout: 120000, maxBuffer: 1024 * 1024 * 10 }
    );

    console.log(`[merge] ${id} downloading audio...`);
    await execAsync(
      `yt-dlp --no-warnings -o "${audioFile}" "${audioUrl.toString().replace(/"/g, "")}"`,
      { timeout: 60000, maxBuffer: 1024 * 1024 * 10 }
    );

    console.log(`[merge] ${id} merging with ffmpeg...`);
    await execAsync(
      `ffmpeg -y -i "${videoFile}" -i "${audioFile}" -c:v copy -c:a aac -movflags +faststart "${outFile}"`,
      { timeout: 180000, maxBuffer: 1024 * 1024 * 10 }
    );

    const stat = fs.statSync(outFile);
    console.log(`[merge] ${id} done — ${Math.round(stat.size / 1024 / 1024)}MB`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`);
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on("end", cleanup);
    stream.on("error", (err) => {
      console.error(`[merge] ${id} stream error:`, err.message);
      cleanup();
      if (!res.headersSent) res.status(500).send("Stream error");
    });
  } catch (e) {
    cleanup();
    console.error(`[merge] ${id} failed:`, e.message);
    if (!res.headersSent) res.status(500).send("Merge failed. Please try again.");
  }
});

app.listen(PORT, () => {
  console.log(`VSaveIt YouTube Server running on port ${PORT}`);
  console.log(`Cookies loaded: ${hasCookies}`);
});
