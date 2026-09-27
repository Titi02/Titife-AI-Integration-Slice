"use client";

import React, { useEffect, useState } from "react";

export interface FollowUpItem {
  id: string;
  jobId: string;
  status: "pending" | "processing" | "done" | "failed";
  summary?: string | null;
  errorMessage?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  createdAt: string;
}

const FOLLOW_UP_ACTION_LABEL = "Summarize this expense";

export function FollowUpViewShell({ selectedJobId }: { selectedJobId?: string | null }) {
  const [followUp, setFollowUp] = useState<FollowUpItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchFollowUp = async () => {
    if (!selectedJobId) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/jobs/${selectedJobId}/followup`);
      if (res.ok) {
        const data = await res.json();
        setFollowUp(data.followUp || null);
      }
    } catch (err) {
      console.error("Error fetching follow-up status:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedJobId) {
      setFollowUp(null);
      return;
    }
    fetchFollowUp();
  }, [selectedJobId]);

  const handleTriggerFollowUp = async () => {
    if (!selectedJobId) return;
    setTriggering(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/jobs/${selectedJobId}/followup`, {
        method: "POST",
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          setErrorMessage(
            `Rate limit exceeded. Please retry after ${retryAfter || 3600} seconds.`
          );
        } else {
          setErrorMessage(data.error || "Failed to trigger follow-up action.");
        }
        return;
      }

      setFollowUp(data.followUp);
    } catch (err: any) {
      setErrorMessage(err.message || "Network error occurred.");
    } finally {
      setTriggering(false);
    }
  };

  if (!selectedJobId) {
    return (
      <div className="card">
        <div className="view-head">
          <div>
            <p className="eyebrow">Step 4 of 4</p>
            <h2 className="view-title">Expense Summary</h2>
            <p className="view-desc">
              Generate a short, plain-language recap of an extracted receipt using DeepSeek.
            </p>
          </div>
        </div>
        <div className="empty-state">
          <p className="empty-state-title">No receipt selected</p>
          <p className="empty-state-description">
            Select a completed receipt from the Processing step to summarize that expense.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="view-head">
        <div>
          <p className="eyebrow">Step 4 of 4</p>
          <h2 className="view-title">Expense Summary</h2>
          <p className="view-desc">
            The summary below is generated from the validated extraction record only.
          </p>
        </div>
        {followUp && <span className={`badge ${followUp.status}`}>{followUp.status.toUpperCase()}</span>}
      </div>

      {errorMessage && (
        <div className="alert alert-error" role="alert">
          {errorMessage}
        </div>
      )}

      {loading ? (
        <div className="empty-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p className="empty-state-description">Loading summary status…</p>
        </div>
      ) : !followUp ? (
        <div className="trigger">
          <div>
            <h3 className="trigger-title">{FOLLOW_UP_ACTION_LABEL}</h3>
            <p className="trigger-desc">
              Send this receipt's validated expense data to DeepSeek for a concise
              plain-language summary.
            </p>
          </div>
          <button
            type="button"
            className="button button-primary"
            onClick={handleTriggerFollowUp}
            disabled={triggering}
          >
            {triggering ? "Generating…" : "Generate summary"}
          </button>
        </div>
      ) : followUp.status === "done" ? (
        <div className="summary-card">
          <div className="summary-meta">
            <span className="chip">Action: {FOLLOW_UP_ACTION_LABEL}</span>
            <span className="muted">{new Date(followUp.createdAt).toLocaleString()}</span>
          </div>
          <p className="summary-text">"{followUp.summary}"</p>
        </div>
      ) : followUp.status === "failed" ? (
        <div className="alert alert-error" role="alert">
          <h3 className="alert-title">Summary failed</h3>
          <p>{followUp.errorMessage}</p>
          <button
            type="button"
            className="button"
            onClick={handleTriggerFollowUp}
            disabled={triggering}
            style={{ marginTop: "var(--space-medium-spacing)" }}
          >
            {triggering ? "Retrying…" : "Try again"}
          </button>
        </div>
      ) : (
        <div className="empty-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p className="empty-state-title">Writing summary…</p>
          <p className="empty-state-description">
            DeepSeek is summarizing this expense. This can take a few seconds.
          </p>
        </div>
      )}
    </div>
  );
}