"use client";

import React, { useState } from "react";
import { UploadViewShell } from "@/components/UploadViewShell";
import { ProcessingViewShell } from "@/components/ProcessingViewShell";
import { ResultViewShell } from "@/components/ResultViewShell";
import { FollowUpViewShell } from "@/components/FollowUpViewShell";

type StepId = "upload" | "processing" | "result" | "followup";

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "upload", label: "Upload" },
  { id: "processing", label: "Processing" },
  { id: "result", label: "Result" },
  { id: "followup", label: "Follow-Up" },
];

export default function HomePage() {
  const [activeStep, setActiveStep] = useState<StepId>("upload");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const handleSelectJob = (jobId: string) => {
    setSelectedJobId(jobId);
    setActiveStep("result");
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Receipt Expense AI</h1>
        <p>
          Upload your receipts, turn them into structured expense data, and get a simple,
          easy-to-understand summary.
        </p>

        <ol className="step-nav" aria-label="Receipt processing flow">
          {STEPS.map((step, index) => {
            const isActive = activeStep === step.id;
            const isDone =
              (step.id === "result" || step.id === "followup") && selectedJobId !== null;

            return (
              <li
                key={step.id}
                className={
                  [
                    "step",
                    isActive ? "is-active" : "",
                    isDone ? "is-done" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
              >
                <button
                  type="button"
                  className="step-button"
                  onClick={() => setActiveStep(step.id)}
                  aria-current={isActive ? "step" : undefined}
                >
                  <span className="step-index" aria-hidden="true">
                    {isDone ? "✓" : index + 1}
                  </span>
                  <span>{step.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      <section className="app-view">
        {activeStep === "upload" && (
          <UploadViewShell onUploadSuccess={() => setActiveStep("processing")} />
        )}
        {activeStep === "processing" && <ProcessingViewShell onSelectJob={handleSelectJob} />}
        {activeStep === "result" && <ResultViewShell selectedJobId={selectedJobId} />}
        {activeStep === "followup" && <FollowUpViewShell selectedJobId={selectedJobId} />}
      </section>
    </div>
  );
}