import { z } from "zod";

export const ExpenseExtraction = z.object({
  vendor: z.string().min(1).nullable(),
  transactionDate: z.string().date().nullable(),
  currency: z.string().length(3).nullable(),
  total: z.number().nonnegative().nullable(),
  category: z.enum([
    "meals",
    "travel",
    "office_supplies",
    "software",
    "lodging",
    "transport",
    "uncategorized",
    "other",
  ]),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        amount: z.number().nonnegative(),
      })
    )
    .max(50),
  confidenceNote: z.string().max(280).nullable(),
});

export type ExpenseExtractionType = z.infer<typeof ExpenseExtraction>;

export const ExpenseSummary = z.object({
  summary: z.string().min(1).max(500),
});

export type ExpenseSummaryType = z.infer<typeof ExpenseSummary>;
