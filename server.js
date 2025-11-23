import express from "express";
import fs from "fs";

const app = express();
app.use(express.raw({ type: "*/*", limit: "1mb" }));

// ========= STORAGE DIR =========
const DIR = "./templates";
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);

// ========= SAVE TEMPLATE (ESP32 → server) =========
app.post("/save", (req, res) => {
  if (req.body.length !== 512) {
    return res.status(400).json({
      status: "error",
      msg: "Invalid template size. Expected exactly 512 bytes."
    });
  }

  const id = Date.now();
  const file = `${DIR}/${id}.bin`;

  fs.writeFileSync(file, req.body);

  return res.json({
    status: "ok",
    id,
    size: req.body.length
  });
});

// ========= DOWNLOAD TEMPLATE (ESP32 ← server) =========
app.get("/get/:id", (req, res) => {
  const file = `${DIR}/${req.params.id}.bin`;
  if (!fs.existsSync(file)) {
    return res.status(404).json({ status: "error", msg: "Not found" });
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.send(fs.readFileSync(file));
});

// ========= LIST TEMPLATES =========
app.get("/list", (req, res) => {
  const files = fs.readdirSync(DIR).map(f => f.replace(".bin", ""));
  res.json(files);
});

app.listen(5000, () => console.log("AS608 server running on port 5000"));
