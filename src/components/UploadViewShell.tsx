"use client";

import React, { useEffect, useRef, useState } from "react";
import { config } from "@/lib/config";

const MIME_LABELS: Record<string, string> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "application/pdf": "PDF",
};

export function UploadViewShell({ onUploadSuccess }: { onUploadSuccess?: () => void }) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccessMessage, setUploadSuccessMessage] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Map<File, string>>(new Map());

  const dragDepth = useRef(0);
  const activeObjectUrls = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mimeTypeLabels = config.upload.allowedMimeTypes
    .map((mime) => MIME_LABELS[mime] ?? mime)
    .join(", ");

  // Prevent the browser from opening files dropped anywhere outside the drop zone.
  useEffect(() => {
    const preventDefaultDrop = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", preventDefaultDrop);
    window.addEventListener("drop", preventDefaultDrop);
    return () => {
      window.removeEventListener("dragover", preventDefaultDrop);
      window.removeEventListener("drop", preventDefaultDrop);
    };
  }, []);

  // Revoke any leftover preview object URLs when the component unmounts so
  // they are not leaked in the browser's memory.
  useEffect(() => {
    return () => {
      activeObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      activeObjectUrls.current.clear();
    };
  }, []);

  const isDuplicate = (file: File, existing: File[]) =>
    existing.some(
      (existingFile) =>
        existingFile.name === file.name &&
        existingFile.size === file.size &&
        existingFile.lastModified === file.lastModified
    );

  const isPreviewableImage = (file: File) =>
    file.type === "image/jpeg" || file.type === "image/png";

  const createPreviewUrl = (file: File): string => {
    const url = URL.createObjectURL(file);
    activeObjectUrls.current.add(url);
    return url;
  };

  const revokePreviewUrl = (url: string) => {
    URL.revokeObjectURL(url);
    activeObjectUrls.current.delete(url);
  };

  const addFilesToSelection = (incomingFiles: File[]) => {
    setValidationError(null);
    setUploadSuccessMessage(null);
    if (incomingFiles.length === 0) return;

    const maxBytes = config.upload.maxFileSizeMb * 1024 * 1024;
    const rejectedMessages: string[] = [];
    const validFiles: File[] = [];

    for (const file of incomingFiles) {
      if (!config.upload.allowedMimeTypes.includes(file.type)) {
        rejectedMessages.push(
          `Invalid file type: ${file.name}. Allowed types: ${config.upload.allowedMimeTypes.join(", ")}`
        );
      } else if (file.size > maxBytes) {
        rejectedMessages.push(
          `File exceeds ${config.upload.maxFileSizeMb}MB limit: ${file.name}`
        );
      } else {
        validFiles.push(file);
      }
    }

    const nextSelectedFiles = [...selectedFiles];
    let addedCount = 0;
    for (const file of validFiles) {
      if (isDuplicate(file, nextSelectedFiles)) {
        rejectedMessages.push(`${file.name} was already selected and was not added again.`);
      } else {
        nextSelectedFiles.push(file);
        addedCount += 1;
      }
    }

    if (nextSelectedFiles.length > config.upload.maxFilesPerBatch) {
      setValidationError(
        `You can upload a maximum of ${config.upload.maxFilesPerBatch} files per batch.`
      );
      return;
    }

    const newPreviewUrls = new Map(previewUrls);
    let addedPreview = false;
    for (const file of nextSelectedFiles) {
      if (isPreviewableImage(file) && !newPreviewUrls.has(file)) {
        newPreviewUrls.set(file, createPreviewUrl(file));
        addedPreview = true;
      }
    }
    if (addedPreview) setPreviewUrls(newPreviewUrls);

    setSelectedFiles(nextSelectedFiles);

    if (rejectedMessages.length > 0) {
      const prefix =
        addedCount > 0
          ? `${addedCount} file(s) added. The following file(s) were not added:\n`
          : `No files were added. The following file(s) were not added:\n`;
      setValidationError(prefix + rejectedMessages.join("\n"));
    }
  };

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    addFilesToSelection(Array.from(event.target.files));
    event.target.value = "";
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const removeFile = (index: number) => {
    const removed = selectedFiles[index];
    if (removed) {
      const url = previewUrls.get(removed);
      if (url) revokePreviewUrl(url);
      setPreviewUrls((prev) => {
        const next = new Map(prev);
        next.delete(removed);
        return next;
      });
    }
    setSelectedFiles((prevFiles) =>
      prevFiles.filter((_, fileIndex) => fileIndex !== index)
    );
    setValidationError(null);
    setUploadSuccessMessage(null);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragActive(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setIsDragActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragActive(false);
    addFilesToSelection(Array.from(event.dataTransfer.files));
  };

  const handleUploadSubmit = async () => {
    if (selectedFiles.length === 0) return;

    setIsUploading(true);
    setValidationError(null);
    setUploadSuccessMessage(null);

    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append("files", file));

      const res = await fetch("/api/jobs", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          setValidationError(
            `Rate limit exceeded. Please retry after ${retryAfter || 3600} seconds.`
          );
        } else {
          setValidationError(data.error || "Upload failed.");
        }
        return;
      }

      setUploadSuccessMessage(
        `Successfully queued ${data.jobIds.length} receipt job(s)!`
      );
      previewUrls.forEach((url) => revokePreviewUrl(url));
      setPreviewUrls(new Map());
      setSelectedFiles([]);
      if (onUploadSuccess) onUploadSuccess();
    } catch (err: any) {
      setValidationError(err.message || "Network error occurred.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="card">
      <div className="view-head">
        <div>
          <p className="eyebrow">Step 1 of 4</p>
          <h2 className="view-title">Upload Receipts</h2>
          <p className="view-desc">
            Attach the receipt images or PDFs you want to extract. Each file is checked for
            type and size before it is added to your selection.
          </p>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        id="receipt-file-input"
        multiple
        accept={config.upload.allowedMimeTypes.join(",")}
        onChange={handleFileSelection}
        className="sr-only"
      />

      <div
        className={isDragActive ? "drop-zone is-dragging" : "drop-zone"}
        role="region"
        aria-label="Drop zone for receipt files. Drop files here to add them to your selection, or use the Browse Files button."
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <h3 className="drop-zone-title">
          {isDragActive ? "Release to add files" : "Drag and drop receipt files"}
        </h3>
        <p className="drop-zone-hint">or browse from your device</p>
        <div className="drop-zone-action">
          <button type="button" className="button button-primary" onClick={openFilePicker}>
            Browse Files
          </button>
        </div>
        <p className="drop-zone-meta">
          {mimeTypeLabels} · up to {config.upload.maxFileSizeMb}MB each · max{" "}
          {config.upload.maxFilesPerBatch} per batch
        </p>
      </div>

      {validationError && (
        <div className="alert alert-error" role="alert" style={{ whiteSpace: "pre-line" }}>
          {validationError}
        </div>
      )}

      {uploadSuccessMessage && (
        <div className="alert alert-success" role="status">
          {uploadSuccessMessage}
        </div>
      )}

      {selectedFiles.length > 0 && (
        <div className="file-list">
          <div className="file-list-head">
            <h3 className="file-list-title">
              Selected files ({selectedFiles.length})
            </h3>
            <button
              type="button"
              className="button button-primary"
              onClick={handleUploadSubmit}
              disabled={isUploading}
            >
              {isUploading
                ? "Submitting…"
                : `Submit ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}`}
            </button>
          </div>

          <ul className="file-items">
            {selectedFiles.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`} className="file-item">
                {isPreviewableImage(file) ? (
                  <img
                    src={previewUrls.get(file)}
                    alt={`Preview of ${file.name}`}
                    className="file-item-preview"
                  />
                ) : (
                  <span
                    className="file-item-preview file-item-preview-doc"
                    role="img"
                    aria-label={`${MIME_LABELS[file.type] ?? "Document"} document: ${file.name}`}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                    </svg>
                  </span>
                )}
                <span className="file-item-name">{file.name}</span>
                <span className="file-item-meta">
                  {(file.size / (1024 * 1024)).toFixed(2)} MB
                </span>
                <button
                  type="button"
                  className="file-remove"
                  onClick={() => removeFile(index)}
                  disabled={isUploading}
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selectedFiles.length === 0 && !uploadSuccessMessage && (
        <p className="empty-hint">
          No files selected yet. Adding a receipt here does not upload anything until you
          press the submit button.
        </p>
      )}
    </div>
  );
}