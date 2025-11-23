import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

const TEMPLATE_DIR = "./templates";
if (!fs.existsSync(TEMPLATE_DIR)) fs.mkdirSync(TEMPLATE_DIR);

app.use(bodyParser.text({ type: "*/*" }));

// Extract template from a raw fingerprint packet dump
function extractTemplate(hexString) {
  const clean = hexString.replace(/[\s\r\n]+/g, " ").trim();
  const bytes = clean.split(" ").map(v => parseInt(v, 16));

  // Template detection: find two 256-byte blocks of non-zero data
  let pages = [];
  let current = [];

  for (let i = 0; i < bytes.length; i++) {
    current.push(bytes[i]);

    if (current.length === 256) {
      const nonZeroCount = current.filter(b => b !== 0).length;

      if (nonZeroCount > 40) {
        pages.push([...current]);
      }
      current = [];
    }
  }

  if (pages.length < 2) {
    throw new Error("Could not find two 256-byte template pages.");
  }

  // Return first 2 pages as the template
  return Buffer.from(pages[0].concat(pages[1]));
}

// Save full dump → extract → store clean template
app.post("/finger/save", (req, res) => {
  try {
    const template = extractTemplate(req.body);

    if (template.length !== 512) {
      return res.status(500).json({
        status: "error",
        msg: "Extracted template size != 512 bytes."
      });
    }

    const id = Date.now();
    const filename = `${TEMPLATE_DIR}/${id}.bin`;

    fs.writeFileSync(filename, template);

    res.json({
      status: "ok",
      id,
      size: template.length,
      msg: "Template extracted and saved."
    });
  } catch (err) {
    res.status(400).json({ status: "error", msg: err.message });
  }
});

// List templates
app.get("/finger/list", (req, res) => {
  const files = fs.readdirSync(TEMPLATE_DIR)
    .map(f => ({
      id: f.replace(".bin", ""),
      file: f
    }));
  res.json(files);
});

// Download clean 512-byte template
app.get("/finger/get/:id", (req, res) => {
  const filepath = path.join(TEMPLATE_DIR, `${req.params.id}.bin`);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ status: "error", msg: "Template not found" });
  }

  res.download(filepath);
});

app.get("/", (req, res) => {
  res.send("Fingerprint Server Ready");
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
