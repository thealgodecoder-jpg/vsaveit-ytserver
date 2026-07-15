const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const SECRET = process.env.VSAVEIT_SECRET || "vsaveit-secret-change-this";

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "VSaveIt YouTube Server" });
});

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

  try {
    console.log("[ytserver] Fetching:", url.slice(0, 60));

    const safeUrl = url.replace(/"/g, "").replace(/`/g, "").replace(/\$/g, "");
    const cmd = `yt-dlp --dump-json --no-playlist --no-warnings "${safeUrl}"`;
    const { stdout } = await execAsync(cmd, { timeout: 25000 });
    const info = JSON.parse(stdout);

    const formats = info.formats || [];

    // Progressive = video+audio already merged — ready to download with sound
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
  } catch (err) {
    const msg = (err.message ?? "").slice(0, 300);
    console.error("[ytserver] Error:", msg);

    if (msg.includes("Video unavailable") || msg.includes("Private video")) {
      return res.status(404).json({ error: "This video is private or unavailable." });
    }
    if (msg.includes("Sign in") || msg.includes("age")) {
      return res.status(403).json({ error: "This video requires sign-in or is age-restricted." });
    }
    if (msg.includes("timeout")) {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }

    return res.status(500).json({ error: "Could not fetch video info. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`VSaveIt YouTube Server running on port ${PORT}`);
});
