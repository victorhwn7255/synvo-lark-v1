export const organizeFolderPilotPolicy = {
  rootName: "Test_Synvo_AI_Assistant",
  destinationNames: ["Product", "Research"],
  classifications: [
    {
      label: "product",
      prefix: "[product] - ",
      destinationName: "Product",
    },
    {
      label: "research",
      prefix: "[research] - ",
      destinationName: "Research",
    },
  ],
  rootFileNames: [
    "[research] - Agentic Context Engineering Research.pdf",
    "[research] - Anthropic Agentic Engineering.pdf",
    "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
    "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
  ],
  maxRootItems: 200,
} as const;
