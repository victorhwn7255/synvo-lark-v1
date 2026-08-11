import { z } from "zod";

const MAX_INTENT_INPUT_CODE_POINTS = 600;

export const naturalLanguageIntentSchema = z
  .object({
    intent: z.enum([
      "greeting",
      "help",
      "organize_folder",
      "analyze_drive_file",
      "unknown",
    ]),
  })
  .strict();

export type NaturalLanguageIntent = z.infer<
  typeof naturalLanguageIntentSchema
>;

export type NaturalLanguageUnderstanding = NaturalLanguageIntent & {
  links: string[];
  canConfirmApprovedRoot: boolean;
};

type IntentClassifier = {
  classifyIntent(input: { text: string }): Promise<NaturalLanguageIntent>;
};

// Defends Lark links and native identifiers from disclosure to the hosted intent provider.
const URL = /https?:\/\/[^\s<>"']+/giu;
const LARK_IDENTIFIER =
  /\b(?:om_|oc_|ou_|on_|cli_|fldcn|boxcn|doccn|wikcn)[A-Za-z0-9_-]{6,}\b/giu;
const OPAQUE_IDENTIFIER =
  /\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+\b/gu;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

function deterministicIntent(text: string): NaturalLanguageIntent | null {
  const normalized = text
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const asksToOrganize =
    /\b(?:organize|organise|tidy|sort|clean up)\b/u.test(normalized) &&
    /\b(?:folder|files?)\b/u.test(normalized);
  const describesMessyFolder =
    /\b(?:folder|files?)\b/u.test(normalized) &&
    /\b(?:messy|cluttered|disorganized|disorganised)\b/u.test(normalized);
  if (asksToOrganize || describesMessyFolder) {
    return { intent: "organize_folder" };
  }

  if (
    /\b(?:analyze|analyse|summarize|summarise|review|understand|explain)\b/u.test(
      normalized,
    ) &&
    /\b(?:file|document|pdf)\b/u.test(normalized)
  ) {
    return { intent: "analyze_drive_file" };
  }

  if (
    /^(?:hi|hello|hey|good morning|good afternoon|good evening|are you online|anyone there|how are you)$/u.test(
      normalized,
    )
  ) {
    return { intent: "greeting" };
  }

  if (
    /^(?:help|what can you do|what can you help me with|how can you help|show me what you can do)$/u.test(
      normalized,
    )
  ) {
    return { intent: "help" };
  }

  return null;
}

function refersToGenericPilotFolder(text: string): boolean {
  const normalized = text.toLocaleLowerCase("en").replace(/\s+/gu, " ");
  return (
    /\b(?:my|this|the|a|approved|pilot|test|messy|cluttered|disorganized|disorganised) folder\b/u.test(
      normalized,
    ) ||
    /\b(?:organize|organise|tidy|sort|clean up) (?:my )?folder\b/u.test(
      normalized,
    ) ||
    /\bfolder (?:is|looks|has|needs)\b/u.test(normalized)
  );
}

function prepareForClassification(
  text: string,
  mentionKeys: string[],
): { text: string; links: string[] } | null {
  if (Array.from(text).length > MAX_INTENT_INPUT_CODE_POINTS) {
    return null;
  }

  const links: string[] = [];
  let sanitized = text.replace(URL, (match) => {
    const link = match.replace(/[),.;!?]+$/gu, "");
    if (link) {
      links.push(link);
    }
    return " ";
  });
  for (const key of mentionKeys) {
    if (key) {
      sanitized = sanitized.split(key).join(" ");
    }
  }
  sanitized = sanitized
    .replace(/@(?:_user_\d+|[A-Za-z0-9_-]{2,})/gu, " ")
    .replace(LARK_IDENTIFIER, " ")
    .replace(OPAQUE_IDENTIFIER, " ")
    .replace(UUID, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return { text: sanitized, links };
}

export async function understandNaturalLanguage(
  input: { text: string; mentionKeys?: string[] },
  classifier: IntentClassifier,
): Promise<NaturalLanguageUnderstanding> {
  const prepared = prepareForClassification(
    input.text,
    input.mentionKeys ?? [],
  );
  if (!prepared) {
    return {
      intent: "unknown",
      links: [],
      canConfirmApprovedRoot: false,
    };
  }

  const canConfirmApprovedRoot = refersToGenericPilotFolder(prepared.text);
  const local = deterministicIntent(prepared.text);
  if (local) {
    return {
      ...local,
      links: prepared.links,
      canConfirmApprovedRoot,
    };
  }
  if (!prepared.text) {
    return {
      intent: "unknown",
      links: prepared.links,
      canConfirmApprovedRoot,
    };
  }

  try {
    const classified = await classifier.classifyIntent({ text: prepared.text });
    return {
      ...classified,
      links: prepared.links,
      canConfirmApprovedRoot,
    };
  } catch {
    return {
      intent: "unknown",
      links: prepared.links,
      canConfirmApprovedRoot,
    };
  }
}
