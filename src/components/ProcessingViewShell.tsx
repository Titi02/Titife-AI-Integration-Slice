"use client";

import React, { useEffect, useState } from "react";

export interface JobItem {
  id: string;
  fileName: string;
  mimeType: string;
  status: "pending" | "processing" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
  errorMessage?: string | null;
  attempts: number;
}

export function ProcessingViewShell({ onSelectJob }: { onSelectJob?: (jobId: string) => void }) {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/jobs");
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
      }
    } catch (err) {
      console.error("Error fetching jobs:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="card">
      <div className="view-head">
        <div>
          <p className="eyebrow">Step 2 of 4</p>
          <h2 className="view-title">Processing Receipts</h2>
          <p className="view-desc">
            Every receipt below shows its real job status. The list refreshes automatically
            every few seconds.
          </p>
        </div>
        <button type="button" className="button button-small" onClick={fetchJobs}>
          Refresh
        </button>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="empty-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p className="empty-state-description">Loading receipts…</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No receipts yet</p>
          <p className="empty-state-description">
            Upload receipt files in Step 1 and they will appear here while the background
            worker processes them.
          </p>
        </div>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => (
            <li key={job.id} className="job-row">
              <div className="job-row-main">
                <p className="job-row-file">{job.fileName}</p>
                <p className="job-row-meta">
                  Submitted {new Date(job.createdAt).toLocaleString()}
                  {job.attempts > 0
                    ? ` · ${job.attempts} attempt${job.attempts === 1 ? "" : "s"}`
                    : ""}
                </p>
                {job.errorMessage && <p className="job-row-error">{job.errorMessage}</p>}
              </div>
              <div className="job-row-side">
                <span className={`badge ${job.status}`}>
                  {job.status === "processing" && (
                    <span className="spinner spinner-tiny" aria-hidden="true" />
                  )}
                  {job.status.toUpperCase()}
                </span>
                {onSelectJob && (
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => onSelectJob(job.id)}
                  >
                    View Result
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}