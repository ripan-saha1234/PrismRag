import express from "express";
import cors from "cors";
import "./graph/config.js";
import { runAgent } from "./graph/agent.js";
import { ingestKnowledgePdfs } from "./knowledge/vectorstore.js";

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

app.post("/ai", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input?.trim()) {
      return res.status(400).json({ error: "Message input is required." });
    }

    const state = await runAgent(input.trim());

    return res.status(200).json(state);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message ?? "Failed to generate a response.",
    });
  }
});

app.get("/", (req, res) => {
  return res.json({
    message: "Hello World",
  });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  ingestKnowledgePdfs().catch((error) => {
    console.error("Failed to ingest PDFs:", error);
  });
});
