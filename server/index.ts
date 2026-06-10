import path from "node:path";
import fs from "node:fs";
import express from "express";
import { getTrains, startPolling } from "./mta.js";

const ROOT = path.join(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 4000);

const app = express();

app.get("/api/trains", (_req, res) => {
  res.json(getTrains());
});

app.use("/data", express.static(path.join(ROOT, "data"), { maxAge: "1h" }));

const webDist = path.join(ROOT, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
}

startPolling();

app.listen(PORT, () => {
  console.log(`subway_simulator server on http://localhost:${PORT}`);
});
