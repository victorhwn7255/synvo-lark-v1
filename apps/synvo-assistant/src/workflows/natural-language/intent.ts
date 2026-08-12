import { z } from "zod";

const MAX_INTENT_INPUT_CODE_POINTS = 600;

const GREETING_WORDS = new Set([
  "afternoon",
  "assistant",
  "evening",
  "everyone",
  "good",
  "greetings",
  "hello",
  "hey",
  "hi",
  "howdy",
  "morning",
  "synvo",
  "team",
  "there",
]);
const GREETING_SIGNALS = new Set([
  "afternoon",
  "evening",
  "greetings",
  "hello",
  "hey",
  "hi",
  "howdy",
  "morning",
]);

export const naturalLanguageIntentSchema = z
  .object({
    intent: z.enum([
      "greeting",
      "acknowledgement",
      "help",
      "current_workspace",
      "refresh_workspace",
      "remove_knowledge_source",
      "ask_workspace",
      "organize_workspace",
      "analyze_drive_file",
      "unknown",
    ]),
    folder_reference: z.enum([
      "active_workspace",
      "named_or_other_folder",
      "none",
    ]),
  })
  .strict();

export type NaturalLanguageIntent = z.infer<
  typeof naturalLanguageIntentSchema
>;

export type NaturalLanguageUnderstanding = NaturalLanguageIntent & {
  links: string[];
  sanitizedText: string;
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

function isClearSocialGreeting(text: string): boolean {
  const words = text.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
  return (
    words.length > 0 &&
    words.length <= 5 &&
    words.some((word) => GREETING_SIGNALS.has(word)) &&
    words.every((word) => GREETING_WORDS.has(word))
  );
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
      folder_reference: "none",
      links: [],
      sanitizedText: "",
    };
  }

  if (!prepared.text) {
    return {
      intent: "unknown",
      folder_reference: "none",
      links: prepared.links,
      sanitizedText: "",
    };
  }

  if (isClearSocialGreeting(prepared.text)) {
    return {
      intent: "greeting",
      folder_reference: "none",
      links: prepared.links,
      sanitizedText: prepared.text,
    };
  }

  try {
    const classified = await classifier.classifyIntent({ text: prepared.text });
    return {
      ...classified,
      links: prepared.links,
      sanitizedText: prepared.text,
    };
  } catch {
    return {
      intent: "unknown",
      folder_reference: "none",
      links: prepared.links,
      sanitizedText: prepared.text,
    };
  }
}
