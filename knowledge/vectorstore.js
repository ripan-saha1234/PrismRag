import "../graph/config.js";
import fs from "fs";
import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";

export const COLLECTION_NAME = "companyknow";
const PDF_PATH = "./knowledge/companyknow.pdf";

export function env(name) {
  return process.env[name]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

export function getQdrantClient() {
  const url = env("QDRANT_URL");
  const apiKey = env("QDRANT_API_KEY");

  if (!url || !apiKey) {
    throw new Error(
      "Missing Qdrant credentials. Add QDRANT_URL and QDRANT_API_KEY to .env."
    );
  }

  return new QdrantClient({
    url: url.replace(/:6333$/, ""),
    apiKey,
    port: 443,
    checkCompatibility: false,
  });
}

function getEmbeddings(taskType) {
  return new GoogleGenerativeAIEmbeddings({
    model: "gemini-embedding-001",
    apiKey: env("GOOGLE_API_KEY"),
    taskType,
  });
}

export async function getVectorStore(taskType = "RETRIEVAL_QUERY") {
  return QdrantVectorStore.fromExistingCollection(getEmbeddings(taskType), {
    client: getQdrantClient(),
    collectionName: COLLECTION_NAME,
  });
}

export async function getCollectionPointCount() {
  const info = await getQdrantClient().getCollection(COLLECTION_NAME);
  return info.points_count ?? 0;
}

export async function searchCompanyKnowledge(query, k = 5) {
  if (!query?.trim()) return [];

  const store = await getVectorStore("RETRIEVAL_QUERY");
  const results = await store.similaritySearchWithScore(query.trim(), k);

  return results.map(([doc, score]) => ({
    content: doc.pageContent?.trim() ?? "",
    score,
    source: doc.metadata?.source ?? COLLECTION_NAME,
  })).filter((hit) => hit.content);
}

export function formatRetrievedContext(hits) {
  if (!hits.length) return "";

  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] (score: ${Number(hit.score).toFixed(3)})\n${hit.content}`
    )
    .join("\n\n");
}

export async function ingestCompanyPdf() {
  const count = await getCollectionPointCount().catch(() => 0);
  if (count > 0) {
    console.log(
      `Qdrant collection "${COLLECTION_NAME}" already has ${count} points, skipping ingest.`
    );
    return count;
  }

  const store = await getVectorStore("RETRIEVAL_DOCUMENT");
  const buffer = fs.readFileSync(PDF_PATH);
  const parser = new PDFParse({ data: buffer });
  const pdfResult = await parser.getText();
  await parser.destroy();

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const docs = await textSplitter.createDocuments([pdfResult.text], [
    { source: "companyknow.pdf" },
  ]);

  await store.addDocuments(docs);
  console.log(`Documents added to vector store: ${docs.length} chunks`);
  return docs.length;
}
