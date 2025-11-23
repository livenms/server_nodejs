import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

const TEMPLATE_DIR = "./templates";
if (!fs.existsSync(TEMPLATE_DIR)) fs.mkdirSync(TEMPLATE_DIR);

app.use(bodyParser.text({ type: "*/*" }));

// Extract AS608 512-byte template from full packet dump
function extractAS608Template(hexString) {
  const clean = hexString.replace(/[\s\r\n]+/g, " ").trim();
  const bytes = clean.split(" ").map(v => parseInt(v, 16));

  const pages = [];
  let block = [];

  for (let b of bytes) {
    block.push(b);

    if (block.length === 256) {
      const nonZero = block.filter(x => x !== 0).length;

      // AS608 template pages are mostly non-zero
      if (nonZero > 150) {
        pages.push([...block]);
      }

      block = [];
    }
  }

  if (pages.length < 2) {
    throw new Error("AS608: Could not detect two template pages in the dump.");
  }

  // Take first two detected template blocks
  const template = pages[0].concat(pages[1]);

  return Buffer.from(template);
}

// Save full dump → extract AS608 template → store 512 bytes
app.post("/finger/save", (req, res) => {
  try {
    const template = extractAS608Template(req.body);

    if (template.length !== 512) {
      return res.status(500).json({
        status: "error",
        msg: "Extracted AS608 template size is not 512 bytes."
      });
    }

    const id = Date.now();
    const file = `${TEMPLATE_DIR}/${id}.bin`;
    fs.writeFileSync(file, template);

    res.json({
      status: "ok",
      id,
      size: template.length,
      msg: "AS608 template extracted and saved."
    });
  } catch (err) {
    res.status(400).json({ status: "error", msg: err.message });
  }
});

// List saved templates
app.get("/finger/list", (req, res) => {
  const list = fs.readdirSync(TEMPLATE_DIR)
    .map(f => ({ id: f.replace(".bin", ""), file: f }));
  res.json(list);
});

// Download 512-byte template
app.get("/finger/get/:id", (req, res) => {
  const file = path.join(TEMPLATE_DIR, `${req.params.id}.bin`);
  if (!fs.existsSync(file))
    return res.status(404).json({ status: "error", msg: "Not found" });
  res.download(file);
});

app.get("/", (req, res) => {
  res.send("AS608 Fingerprint Server Ready");
});

app.listen(PORT, () => console.log("Server running on port", PORT));
