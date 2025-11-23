import express from "express";
import cors from "cors";
import fs from "fs-extra";
import path from "path";

const app = express();
app.use(cors());

// =========================
// RAW BINARY BODY HANDLER
// =========================
app.use(express.raw({ type: "application/octet-stream", limit: "1mb" }));

// Create template storage folder
const templateDir = "./templates";
await fs.ensureDir(templateDir);

function templatePath(id) {
  return path.join(templateDir, `${id}.bin`);
}

// =========================
// UPLOAD TEMPLATE
// =========================
app.post("/upload/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body;

    if (!data || data.length !== 512) {
      return res.status(400).json({ error: "Invalid template length" });
    }

    await fs.writeFile(templatePath(id), data);

    console.log(`Saved template ${id} (${data.length} bytes)`);

    res.json({ success: true, message: `Template ${id} saved` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save template" });
  }
});

// =========================
// DOWNLOAD TEMPLATE
// =========================
app.get("/get/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!await fs.pathExists(templatePath(id))) {
      return res.status(404).json({ error: "Template not found" });
    }

    const file = await fs.readFile(templatePath(id));

    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": file.length
    });

    res.send(file);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read template" });
  }
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
