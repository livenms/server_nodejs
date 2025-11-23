import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// Accept plain hex string
app.use(bodyParser.text({ type: "*/*" }));

// Folder for templates
const TEMPLATE_DIR = "./templates";
if (!fs.existsSync(TEMPLATE_DIR)) fs.mkdirSync(TEMPLATE_DIR);

// Save fingerprint template
app.post("/finger/save", (req, res) => {
  try {
    const hex = req.body.replace(/[\s\r\n]+/g, " ").trim();
    const bytes = hex.split(" ").map(h => parseInt(h, 16));
    const buffer = Buffer.from(bytes);

    if (buffer.length !== 512) {
      return res.status(400).json({
        status: "error",
        msg: `Template size must be 512 bytes, got ${buffer.length}`
      });
    }

    const id = Date.now();
    const filename = `${TEMPLATE_DIR}/${id}.bin`;

    fs.writeFileSync(filename, buffer);

    res.json({
      status: "ok",
      id,
      size: buffer.length,
      message: "Template saved successfully"
    });

  } catch (err) {
    res.status(400).json({ status: "error", msg: err.message });
  }
});

// List all templates
app.get("/finger/list", (req, res) => {
  const files = fs.readdirSync(TEMPLATE_DIR)
    .map(f => ({
      id: f.replace(".bin", ""),
      filename: f
    }));

  res.json(files);
});

// Download a template for ESP32
app.get("/finger/get/:id", (req, res) => {
  const id = req.params.id;
  const filepath = path.join(TEMPLATE_DIR, `${id}.bin`);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ status: "error", msg: "Template not found" });
  }

  res.download(filepath);
});

// Server root
app.get("/", (req, res) => {
  res.send("Fingerprint Template Server Running");
});

app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
