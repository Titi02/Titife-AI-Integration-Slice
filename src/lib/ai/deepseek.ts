import OpenAI from "openai";
import { config } from "../config";
import { withConcurrencyLimit } from "../concurrency";
import { FOLLOWUP_SYSTEM_PROMPT } from "./prompts";
import { ExpenseSummary, ExpenseExtractionType } from "./schemas";

export const deepseekClient = new OpenAI({
  baseURL: config.models.followup.baseUrl,
  apiKey: process.env.DEEPSEEK_API_KEY || "placeholder-key",
});

export interface FollowUpCallResult {
  rawOutput: string;
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function summarizeExpenseData(
  extraction: ExpenseExtractionType,
  options?: { extraPrompt?: string }
): Promise<FollowUpCallResult> {
  return withConcurrencyLimit(config.concurrency.followupCap, async () => {
    const promptText = options?.extraPrompt
      ? `${FOLLOWUP_SYSTEM_PROMPT}\n\nAdditional Instruction: ${options.extraPrompt}`
      : FOLLOWUP_SYSTEM_PROMPT;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      config.timeouts.followupMs
    );

    try {
      const response = await deepseekClient.chat.completions.create(
        {
          model: config.models.followup.model,
          messages: [
            { role: "system", content: promptText },
            {
              role: "user",
              content: `Validated Expense Record:\n${JSON.stringify(extraction, null, 2)}\n\nProvide a JSON object matching schema: {"summary": "2-3 sentence plain language summary"} (max 500 chars).`,
            },
          ],
          temperature: config.temperature.followup,
          max_tokens: config.tokenCaps.followupMaxOutput,
          response_format: { type: config.generation.followupResponseFormat },
        },
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      const rawOutput = response.choices[0]?.message?.content || "";
      const usage = response.usage;

      return {
        rawOutput,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  });
}