import express from "express";
import cors from "cors";
import fs from "fs-extra";
import path from "path";

const app = express();
app.use(cors());
app.use(express.raw({ type: "application/octet-stream", limit: "1mb" }));

const templateDir = "./templates";
await fs.ensureDir(templateDir);

const attendanceFile = "./attendance.json";
await fs.ensureFile(attendanceFile);

// Save template
app.post("/upload/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body;
    if (!data || data.length !== 512)
      return res.status(400).json({ error: "Template must be 512 bytes" });

    await fs.writeFile(path.join(templateDir, `${id}.bin`), data);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save template" });
  }
});

// Match template
app.post("/match", async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || incoming.length !== 512)
      return res.status(400).json({ error: "Template must be 512 bytes" });

    const files = await fs.readdir(templateDir);
    for (const file of files) {
      const stored = await fs.readFile(path.join(templateDir, file));
      if (stored.equals(incoming)) {
        // Record attendance
        const id = path.parse(file).name;
        let attendance = await fs.readJson(attendanceFile).catch(() => ({}));
        attendance[id] = attendance[id] || [];
        attendance[id].push({ timestamp: new Date().toISOString() });
        await fs.writeJson(attendanceFile, attendance, { spaces: 2 });

        return res.json({ match: true, id });
      }
    }

    res.json({ match: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Match failed" });
  }
});

// Get attendance record
app.get("/attendance/:id", async (req, res) => {
  const id = req.params.id;
  const attendance = await fs.readJson(attendanceFile).catch(() => ({}));
  res.json({ id, attendance: attendance[id] || [] });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Attendance server running on port ${PORT}`));
