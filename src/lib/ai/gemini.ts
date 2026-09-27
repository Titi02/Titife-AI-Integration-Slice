import { GoogleGenAI, Type } from "@google/genai";
import { config } from "../config";
import { EXTRACTOR_SYSTEM_PROMPT } from "./prompts";

export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "placeholder-key",
});

export interface ExtractionCallResult {
  rawOutput: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function extractExpenseData(
  fileBuffer: Buffer,
  mimeType: string,
  options?: {
    maxOutputTokens?: number;
    extraPrompt?: string;
  }
): Promise<ExtractionCallResult> {
  const maxOutput =
    options?.maxOutputTokens ?? config.tokenCaps.extractorMaxOutput;

  const base64Data = fileBuffer.toString("base64");

  const promptText = options?.extraPrompt
    ? `${EXTRACTOR_SYSTEM_PROMPT}\n\nAdditional Corrective Instruction: ${options.extraPrompt}`
    : EXTRACTOR_SYSTEM_PROMPT;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      vendor: { type: Type.STRING, nullable: true },
      transactionDate: { type: Type.STRING, nullable: true },
      currency: { type: Type.STRING, nullable: true },
      total: { type: Type.NUMBER, nullable: true },
      category: {
        type: Type.STRING,
        enum: [
          "meals",
          "travel",
          "office_supplies",
          "software",
          "lodging",
          "transport",
          "uncategorized",
          "other",
        ],
      },
      lineItems: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            description: { type: Type.STRING },
            amount: { type: Type.NUMBER },
          },
          required: ["description", "amount"],
        },
      },
      confidenceNote: { type: Type.STRING, nullable: true },
    },
    required: ["category", "lineItems"],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.timeouts.extractorMs
  );

  try {
    const response = await ai.models.generateContent({
      model: config.models.extractor.model,
      contents: [
        {
          role: "user",
          parts: [
            { text: promptText },
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
          ],
        },
      ],
      config: {
        temperature: config.temperature.extractor,
        maxOutputTokens: maxOutput,
        responseMimeType: config.generation.extractorResponseMimeType,
        responseSchema: responseSchema,
        abortSignal: controller.signal,
      },
    });

    clearTimeout(timeoutId);

    const rawOutput = response.text || "";
    const usage = response.usageMetadata;

    return {
      rawOutput,
      inputTokens: usage?.promptTokenCount,
      outputTokens: usage?.candidatesTokenCount,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}
