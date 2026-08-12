export const workspaceOrganizationPolicy = {
  maxEligiblePdfs: 99,
  minimumDestinations: 2,
  maximumDestinations: 6,
  targetDestinations: { minimum: 3, maximum: 4 },
  maximumDestinationNameCodePoints: 64,
  maximumDocumentProfileSummaryCodePoints: 800,
  maximumDocumentProfileThemes: 8,
  maximumDocumentProfileThemeCodePoints: 80,
  maximumRationaleCodePoints: 240,
  maximumProfileBatchSize: 8,
  maximumClassificationBatchSize: 12,
  maximumEvidenceChunksPerPdf: 2,
  maximumEvidenceCodePointsPerPdf: 6_000,
  proposalDetailPageSize: 8,
  consentTtlMs: 10 * 60_000,
  proposalTtlMs: 60 * 60_000,
} as const;

export function normalizeDestinationName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

export function isSafeDestinationName(value: string): boolean {
  const name = value.normalize("NFKC").trim();
  return (
    name === value &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\u0000-\u001f\u007f]/u.test(name) &&
    Array.from(name).length > 0 &&
    Array.from(name).length <=
      workspaceOrganizationPolicy.maximumDestinationNameCodePoints
  );
}
