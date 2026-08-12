import { ANALYZE_ATTACHMENT_MAX_TEXT_CODE_POINTS } from "../analyze-attachment/policy.js";

export const KNOWLEDGE_EMBEDDING_MODEL = "voyage-4";
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1_024;

export const KNOWLEDGE_CHUNK_TARGET_CODE_POINTS = 3_200;
export const KNOWLEDGE_CHUNK_MAX_CODE_POINTS = 4_000;
export const KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS = 320;
export const KNOWLEDGE_MAX_CHUNKS_PER_FILE = 100;
// Includes the bounded extracted source text plus the maximum stored overlap.
export const KNOWLEDGE_MAX_INDEXED_CODE_POINTS =
  ANALYZE_ATTACHMENT_MAX_TEXT_CODE_POINTS +
  KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS *
    (KNOWLEDGE_MAX_CHUNKS_PER_FILE - 1);

// Voyage accounts without billing have a 3 RPM / 10K TPM allowance. Three
// bounded chunks keep one request comfortably below that token budget.
export const KNOWLEDGE_EMBEDDING_BATCH_SIZE = 3;
export const KNOWLEDGE_EMBEDDING_MIN_REQUEST_INTERVAL_MS = 21_000;
export const KNOWLEDGE_PROVIDER_TIMEOUT_MS = 45_000;
export const KNOWLEDGE_MAX_PROVIDER_RESPONSE_BYTES = 4_000_000;
export const KNOWLEDGE_JOB_TTL_MS = 30 * 60_000;

export const KNOWLEDGE_MAX_DESCENDANT_DEPTH = 4;
export const KNOWLEDGE_MAX_VISITED_FOLDERS = 50;
export const KNOWLEDGE_MAX_DISCOVERED_PDFS = 200;
export const KNOWLEDGE_MAX_RELATIVE_PATH_CODE_POINTS = 512;
export const KNOWLEDGE_REFRESH_SNAPSHOT_MAX_CODE_UNITS = 8_000;

export const KNOWLEDGE_SEARCH_TOP_K = 10;
// Phase 14 live cross-folder evidence scored 0.2805 for the second relevant
// source. Keep a small margin while the grounded-answer model still rejects
// unsupported questions from the retrieved evidence.
export const KNOWLEDGE_SEARCH_MIN_SIMILARITY = 0.25;
export const KNOWLEDGE_MAX_EVIDENCE_CODE_POINTS = 24_000;
export const KNOWLEDGE_MAX_QUESTION_CODE_POINTS = 1_000;
