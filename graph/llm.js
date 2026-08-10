import "./config.js";
import { ChatGroq } from "@langchain/groq";

export const llm = new ChatGroq({
  model: "openai/gpt-oss-120b",
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0.5,
});
