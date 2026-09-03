import "../graph/config.js";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";

export const COLLECTION_NAME = "companyknow";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = __dirname;
export const UPLOADS_DIR = join(KNOWLEDGE_DIR, "uploads");

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

function sanitizeFilename(name) {
  const base = (name || "document.pdf").split(/[/\\]/).pop() ?? "document.pdf";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

async function scrollAllPoints() {
  const client = getQdrantClient();
  const points = [];
  let offset = null;

  while (true) {
    const page = await client.scroll(COLLECTION_NAME, {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });

    points.push(...(page.points ?? []));

    if (!page.next_page_offset) break;
    offset = page.next_page_offset;
  }

  return points;
}

async function getIngestedSources() {
  const sources = new Set();

  for (const point of await scrollAllPoints()) {
    const source = point.payload?.metadata?.source;
    if (typeof source === "string" && source) {
      sources.add(source);
    }
  }

  return sources;
}

function listKnowledgePdfs() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];

  return fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((file) => file.toLowerCase().endsWith(".pdf"))
    .sort();
}

async function ingestPdfBuffer(store, buffer, source) {
  const parser = new PDFParse({ data: buffer });
  const pdfResult = await parser.getText();
  await parser.destroy();

  if (!pdfResult.text?.trim()) {
    throw new Error("No extractable text found in the PDF.");
  }

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const docs = await textSplitter.createDocuments([pdfResult.text], [{ source }]);

  await store.addDocuments(docs);
  return docs.length;
}

async function ingestPdfFile(store, fileName) {
  const pdfPath = join(KNOWLEDGE_DIR, fileName);
  const buffer = fs.readFileSync(pdfPath);
  const chunks = await ingestPdfBuffer(store, buffer, fileName);
  console.log(`Ingested ${fileName}: ${chunks} chunks`);
  return chunks;
}

export async function deleteKnowledgeDocument(source) {
  if (!source?.trim()) {
    throw new Error("Document source is required.");
  }

  const client = getQdrantClient();
  const points = await scrollAllPoints();
  const idsToDelete = points
    .filter((point) => point.payload?.metadata?.source === source)
    .map((point) => point.id);

  if (idsToDelete.length > 0) {
    await client.delete(COLLECTION_NAME, {
      wait: true,
      points: idsToDelete,
    });
  }

  if (source.startsWith("uploads/")) {
    const filePath = join(KNOWLEDGE_DIR, source);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  return { source, deleted: idsToDelete.length };
}

export async function listKnowledgeDocuments() {
  const grouped = new Map();

  for (const point of await scrollAllPoints()) {
    const source = point.payload?.metadata?.source;
    if (typeof source !== "string" || !source) continue;

    const entry = grouped.get(source) ?? {
      source,
      fileName: source.split("/").pop(),
      chunks: 0,
      origin: source.startsWith("uploads/") ? "upload" : "folder",
    };
    entry.chunks += 1;
    grouped.set(source, entry);
  }

  return [...grouped.values()].sort((a, b) => a.source.localeCompare(b.source));
}

export async function ingestUploadedPdf(buffer, originalName) {
  if (!buffer?.length) {
    throw new Error("Uploaded file is empty.");
  }

  ensureUploadsDir();

  const fileName = sanitizeFilename(originalName);
  const source = `uploads/${fileName}`;
  const filePath = join(UPLOADS_DIR, fileName);

  await deleteKnowledgeDocument(source).catch(() => {});

  fs.writeFileSync(filePath, buffer);

  const store = await getVectorStore("RETRIEVAL_DOCUMENT");
  const chunks = await ingestPdfBuffer(store, buffer, source);

  console.log(`Uploaded and ingested ${source}: ${chunks} chunks`);
  return { source, fileName, chunks, origin: "upload" };
}

export async function searchCompanyKnowledge(query, k = 5) {
  if (!query?.trim()) return [];

  const store = await getVectorStore("RETRIEVAL_QUERY");
  const results = await store.similaritySearchWithScore(query.trim(), k);

  return results
    .map(([doc, score]) => ({
      content: doc.pageContent?.trim() ?? "",
      score,
      source: doc.metadata?.source ?? COLLECTION_NAME,
    }))
    .filter((hit) => hit.content);
}

export function formatRetrievedContext(hits) {
  if (!hits.length) return "";

  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] source: ${hit.source} (score: ${Number(hit.score).toFixed(3)})\n${hit.content}`
    )
    .join("\n\n");
}

export async function ingestKnowledgePdfs() {
  const pdfs = listKnowledgePdfs();
  if (!pdfs.length) {
    console.log(`No PDF files found in ${KNOWLEDGE_DIR}`);
    return 0;
  }

  const ingestedSources = await getIngestedSources();
  const pending = pdfs.filter((file) => !ingestedSources.has(file));

  if (!pending.length) {
    console.log(
      `All ${pdfs.length} knowledge PDFs are already in Qdrant. Skipping ingest.`
    );
    return 0;
  }

  const store = await getVectorStore("RETRIEVAL_DOCUMENT");
  let added = 0;

  for (const file of pending) {
    added += await ingestPdfFile(store, file);
  }

  console.log(`Ingest complete. New chunks: ${added}`);
  return added;
}

export const ingestCompanyPdf = ingestKnowledgePdfs;
