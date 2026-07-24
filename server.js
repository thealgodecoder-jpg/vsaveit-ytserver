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
  res.json({ status: "ok", cookiesLoaded: hasCookies });
});

function cookieArgs() {
  return hasCookies ? `--cookies "${COOKIES_PATH}"` : "";
}

async function runYtDlpInfo(url, extra) {
  const safe = url.replace(/"/g, "").replace(/`/g, "").replace(/\$/g, "");
  const cmd = `yt-dlp --dump-json --no-playlist --no-warnings --socket-timeout 15 ${extra} "${safe}"`;
  const { stdout } = await execAsync(cmd, { timeout: 55000, maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function fetchInfo(url) {
  let info = null, lastErr = null;
  // Try 1: android client (no cookies needed)
  try {
    info = await runYtDlpInfo(url, `--extractor-args "youtube:player_client=android"`);
    console.log("[ytserver] ✅ android client");
  } catch (e) {
    lastErr = e;
    console.warn("[ytserver] android failed:", (e.stderr || e.message || "").toString().slice(0, 120));
    // Try 2: cookies + web
    if (hasCookies) {
      try {
        info = await runYtDlpInfo(url, `${cookieArgs()} --extractor-args "youtube:player_client=web,android"`);
        console.log("[ytserver] ✅ cookies client");
      } catch (e2) {
        lastErr = e2;
        console.error("[ytserver] cookies failed:", (e2.stderr || e2.message || "").toString().slice(0, 200));
      }
    }
  }
  return { info, lastErr };
}

// ══════════════════════════════════════════════
// POST /info  — returns format list
// ══════════════════════════════════════════════
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
      return res.status(403).json({ error: hasCookies ? "Cookies expired — please refresh." : "Set YTDLP_COOKIES in Railway." });
    if (txt.includes("Video unavailable") || txt.includes("Private video"))
      return res.status(404).json({ error: "Video is private or unavailable." });
    if (txt.includes("age"))
      return res.status(403).json({ error: "Age-restricted video." });
    if (lastErr?.killed || txt.includes("timeout"))
      return res.status(504).json({ error: "Timed out. Try again." });
    return res.status(500).json({ error: "Could not fetch video info." });
  }

  try {
    const formats = info.formats || [];

    // Best audio-only stream
    const bestAudio = formats
      .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") && f.url)
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];

    console.log("[ytserver] bestAudio:", bestAudio ? `${bestAudio.format_id} (${bestAudio.abr}kbps)` : "NONE");

    // Progressive formats (video+audio together) — usually ≤480p
    const progressive = formats.filter(
      (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url && f.ext !== "3gp"
    );

    // Video-only HD — YouTube sends 720p+ as video-only (acodec=none)
    const videoOnly = formats.filter(
      (f) => f.vcodec && f.vcodec !== "none" &&
             (!f.acodec || f.acodec === "none") &&
             f.url && f.ext !== "3gp" &&
             (f.height ?? 0) >= 720
    );

    console.log(`[ytserver] progressive: ${progressive.length}, videoOnly: ${videoOnly.length}`);

    // Merge, sort, deduplicate by height
    const all = [...videoOnly, ...progressive].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const seen = new Set();
    const deduped = all.filter((f) => {
      const k = `${f.height}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.SELF_URL || "";

    const medias = deduped.map((f) => {
      const isVideoOnly = !f.acodec || f.acodec === "none";
      const needsMerge  = isVideoOnly && !!bestAudio;
      const sizeStr = f.filesize ? `${Math.round(f.filesize / 1024 / 1024)}MB`
        : f.filesize_approx ? `~${Math.round(f.filesize_approx / 1024 / 1024)}MB` : "";

      // For needsMerge: give frontend a /download endpoint URL
      // This is a GET URL the browser can directly use as <a href> download
      const downloadUrl = needsMerge && SELF_URL
        ? `${SELF_URL}/download?ytUrl=${encodeURIComponent(url)}&fv=${encodeURIComponent(f.format_id)}&fa=${encodeURIComponent(bestAudio.format_id)}&title=${encodeURIComponent(info.title ?? "video")}&secret=${encodeURIComponent(SECRET)}`
        : f.url; // progressive: direct CDN url works fine

      return {
        url: downloadUrl,
        quality: f.height ? `${f.height}p` : (f.format_note ?? "Video"),
        extension: "mp4",
        type: "video",
        formattedSize: sizeStr,
        needsMerge,
        // Debug info
        _debug: { formatId: f.format_id, audioFormatId: bestAudio?.format_id, isVideoOnly, hasSelfUrl: !!SELF_URL },
      };
    });

    // Audio only options
    const audioFormats = formats
      .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") && f.url)
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))
      .slice(0, 2);

    audioFormats.forEach((af) => {
      const sizeStr = af.filesize ? `${Math.round(af.filesize / 1024 / 1024)}MB`
        : af.filesize_approx ? `~${Math.round(af.filesize_approx / 1024 / 1024)}MB` : "";
      medias.push({
        url: af.url,
        quality: af.abr ? `${Math.round(af.abr)}kbps Audio` : "Audio Only",
        extension: af.ext ?? "m4a",
        type: "audio",
        formattedSize: sizeStr,
        needsMerge: false,
        _debug: { formatId: af.format_id, isVideoOnly: false, hasSelfUrl: !!SELF_URL },
      });
    });

    if (medias.length === 0) return res.status(404).json({ error: "No formats found." });

    console.log("[ytserver] SELF_URL:", SELF_URL || "(NOT SET — merge won't work!)");
    console.log("[ytserver] formats:", medias.map((m) => `${m.quality}${m.needsMerge ? "[MERGE]" : ""}`).join(", "));

    return res.json({
      title: info.title ?? "YouTube Video",
      thumbnail: info.thumbnail ?? `https://img.youtube.com/vi/${info.id}/hqdefault.jpg`,
      duration: info.duration,
      medias,
    });
  } catch (e) {
    console.error("[ytserver] error:", e.message);
    return res.status(500).json({ error: "Could not process video info." });
  }
});

// ══════════════════════════════════════════════
// GET /download — yt-dlp merge → stream MP4
// Params: ytUrl, fv (video formatId), fa (audio formatId), title, secret
// ══════════════════════════════════════════════
app.get("/download", async (req, res) => {
  const { ytUrl, fv, fa, title, secret } = req.query;

  if (secret !== SECRET) return res.status(401).send("Unauthorized");
  if (!ytUrl || !fv || !fa) return res.status(400).send("Missing params: ytUrl, fv, fa required");

  const id = crypto.randomBytes(8).toString("hex");
  const outFile = path.join(TMP_DIR, `merged_${id}.mp4`);
  const safeTitle = (title || "video").toString().replace(/[^\w\s-]/g, "").trim().slice(0, 80) || "video";
  const safeUrl = ytUrl.toString().replace(/"/g, "").replace(/`/g, "").replace(/\$/g, "");

  console.log(`[download] ${id} fv=${fv} fa=${fa} title="${safeTitle}"`);

  function cleanup() {
    try { fs.unlinkSync(outFile); } catch {}
  }

  try {
    const cookies = cookieArgs();
    const extArgs = hasCookies
      ? `--extractor-args "youtube:player_client=web,android"`
      : `--extractor-args "youtube:player_client=android"`;

    const cmd = [
      "yt-dlp",
      "--no-warnings",
      "--no-playlist",
      `-f "${fv}+${fa}"`,
      "--merge-output-format mp4",
      "--socket-timeout 20",
      cookies,
      extArgs,
      `-o "${outFile}"`,
      `"${safeUrl}"`,
    ].filter(Boolean).join(" ");

    console.log(`[download] ${id} running: yt-dlp -f "${fv}+${fa}" ...`);
    await execAsync(cmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });

    if (!fs.existsSync(outFile)) throw new Error("Output file not created after yt-dlp");

    const stat = fs.statSync(outFile);
    console.log(`[download] ${id} ✅ done — ${Math.round(stat.size / 1024 / 1024)}MB`);

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
      if (!res.headersSent) res.status(500).send("Stream error");
    });
  } catch (e) {
    cleanup();
    console.error(`[download] ${id} FAILED:`, e.message.slice(0, 300));
    if (!res.headersSent) res.status(500).send(`Merge failed: ${e.message.slice(0, 100)}`);
  }
});

app.listen(PORT, () => {
  console.log(`VSaveIt YouTube Server on port ${PORT} | cookies=${hasCookies}`);
});
