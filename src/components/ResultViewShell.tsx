"use client";

import React, { useEffect, useState } from "react";
import { ExpenseExtractionType } from "@/lib/ai/schemas";

export interface JobDetails {
  id: string;
  fileName: string;
  status: "pending" | "processing" | "done" | "failed";
  errorMessage?: string | null;
  extraction?: ExpenseExtractionType | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  createdAt: string;
}

export function ResultViewShell({ selectedJobId }: { selectedJobId?: string | null }) {
  const [job, setJob] = useState<JobDetails | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedJobId) {
      setJob(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchJobDetails = async () => {
      try {
        const res = await fetch(`/api/jobs/${selectedJobId}`);
        if (!res.ok) return;

        const data = await res.json();
        const fetchedJob: JobDetails = data.job;

        if (cancelled) return;
        setJob(fetchedJob);

        // Stop polling once the job reaches a terminal state: done displays the
        // validated result, failed displays the failure state.
        if (fetchedJob.status === "done" || fetchedJob.status === "failed") {
          if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch (err) {
        console.error("Error fetching job details:", err);
      }
    };

    fetchJobDetails().finally(() => {
      if (!cancelled) setLoading(false);
    });

    // Poll every 3s only while the job is pending/processing; the response
    // handler above clears the interval once done/failed is observed.
    intervalId = setInterval(fetchJobDetails, 3000);

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [selectedJobId]);

  if (!selectedJobId) {
    return (
      <div className="card">
        <div className="view-head">
          <div>
            <p className="eyebrow">Step 3 of 4</p>
            <h2 className="view-title">Extraction Result</h2>
            <p className="view-desc">
              Review the validated, structured expense data extracted from a receipt.
            </p>
          </div>
        </div>
        <div className="empty-state">
          <p className="empty-state-title">No result selected</p>
          <p className="empty-state-description">
            Select a receipt from the Processing step to review its extracted data.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card">
        <div className="empty-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p className="empty-state-description">Loading result…</p>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="card">
        <div className="empty-state">
          <p className="empty-state-title">Receipt not found</p>
          <p className="empty-state-description">
            This receipt could not be loaded. Go back to the Processing step and try again.
          </p>
        </div>
      </div>
    );
  }

  // Remaining job statuses show honest states: no guessed data is ever displayed.
  if (job.status !== "done") {
    const inProgress = job.status === "pending" || job.status === "processing";
    return (
      <div className="card">
        <div className="view-head">
          <div>
            <p className="eyebrow">Step 3 of 4</p>
            <h2 className="view-title">Extraction Result</h2>
            <p className="view-desc">{job.fileName}</p>
          </div>
          <span className={`badge ${job.status}`}>{job.status.toUpperCase()}</span>
        </div>

        {inProgress ? (
          <div className="empty-state" role="status">
            <span className="spinner" aria-hidden="true" />
            <p className="empty-state-title">Extraction in progress</p>
            <p className="empty-state-description">
              The background worker is still processing this receipt. Check back shortly.
            </p>
          </div>
        ) : (
          <>
            <div className="alert alert-error" role="alert">
              <h3 className="alert-title">
                {job.errorMessage?.includes("[provider_unavailable]")
                  ? "The AI provider was unavailable"
                  : job.errorMessage?.includes("[invalid_output]")
                    ? "The AI output failed validation"
                    : "Extraction failed"}
              </h3>
              <p>{job.errorMessage}</p>
            </div>
            <p className="muted">
              No partial or guessed data is shown for failed receipts. Upload a clearer copy
              from Step 1 to try again.
            </p>
          </>
        )}
      </div>
    );
  }

  const ext = job.extraction;

  // FR10a: Partial extraction notice — key field null, or a confidence note is present.
  const isVendorNull = ext ? ext.vendor === null : false;
  const isTotalNull = ext ? ext.total === null : false;
  const isConfidenceNotePresent = ext ? Boolean(ext.confidenceNote) : false;
  const isPartialExtraction = isVendorNull || isTotalNull || isConfidenceNotePresent;

  return (
    <div className="card">
      <div className="view-head">
        <div>
          <p className="eyebrow">Step 3 of 4</p>
          <h2 className="view-title">Extraction Result</h2>
          <p className="view-desc">{job.fileName}</p>
        </div>
        <span className="badge done">Done</span>
      </div>

      {isPartialExtraction && (
        <div className="notice">
          <strong>Partial extraction.</strong>{" "}
          {isVendorNull || isTotalNull
            ? "One or more key fields could not be read from the image."
            : "The model attached a confidence note."}
          {ext?.confidenceNote && <p className="notice-note">"{ext.confidenceNote}"</p>}
        </div>
      )}

      <div className="field-grid">
        <div className="field">
          <p className="field-label">Vendor</p>
          <p className={ext?.vendor ? "field-value" : "field-value is-missing"}>
            {ext?.vendor ?? "Not detected"}
          </p>
        </div>

        <div className="field">
          <p className="field-label">Transaction Date</p>
          <p className={ext?.transactionDate ? "field-value" : "field-value is-missing"}>
            {ext?.transactionDate ?? "Not detected"}
          </p>
        </div>

        <div className="field">
          <p className="field-label">Currency</p>
          <p className={ext?.currency ? "field-value" : "field-value is-missing"}>
            {ext?.currency ?? "Not detected"}
          </p>
        </div>

        <div className="field">
          <p className="field-label">Total</p>
          <p
            className={
              ext?.total !== null && ext?.total !== undefined
                ? "field-value"
                : "field-value is-missing"
            }
          >
            {ext?.total !== null && ext?.total !== undefined
              ? `${ext.currency ? `${ext.currency} ` : ""}${ext.total.toFixed(2)}`
              : "Not detected"}
          </p>
        </div>

        <div className="field">
          <p className="field-label">Category</p>
          <p className="field-value field-value-category">
            {ext?.category || "uncategorized"}
          </p>
        </div>
      </div>

      <h3 className="view-subtitle">
        Line Items ({ext?.lineItems?.length ?? 0})
      </h3>

      {ext?.lineItems && ext.lineItems.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {ext.lineItems.map((item, idx) => (
                <tr key={idx}>
                  <td>{item.description}</td>
                  <td className="num">
                    {(ext.currency ? `${ext.currency} ` : "$ ")}
                    {item.amount.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No itemized line items detected on this receipt.</p>
      )}

      </div>
  );
}