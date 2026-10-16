"use client";
import { useEffect, useState } from "react";
import type { RecordData } from "@/lib/model";

type Assessment = {
  dataset_id: string;
  dataset_name: string;
  verification: string;
  fit?: {
    status: string;
    rationale: string;
    reviewedAt: string;
    sources: { url: string; quote: string }[];
  };
  qualification?: {
    summary: string;
    reviewedAt: string;
    sources: { url: string; quote: string }[];
  };
  missingEvidence: { key: string; label: string; status: string }[];
};
export function InvestorResearch({
  workspace,
  recordId,
  version,
  data,
  isOwner,
  demo,
}: {
  workspace: string;
  recordId: string;
  version: number;
  data: RecordData;
  isOwner: boolean;
  demo: boolean;
}) {
  const [assessments, setAssessments] = useState<Assessment[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    if (!isOwner || demo) return;
    const controller = new AbortController();
    setAssessments([]);
    setError("");
    fetch(
      `/api/workspaces/${workspace}/records/${recordId}/investor-research`,
      {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      },
    )
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok)
          throw Error(body.error || "Research evidence could not be loaded.");
        return body;
      })
      .then((body) => {
        if (!controller.signal.aborted) setAssessments(body.assessments);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [workspace, recordId, version, isOwner, demo]);
  if (
    !data.investorFit &&
    !data.investorVerification &&
    !assessments.length &&
    !error
  )
    return null;
  return (
    <section
      className="investor-research"
      aria-label="Investor fit and verification"
    >
      <h3>Investor fit and verification</h3>
      <p>
        <strong>Fit:</strong> {data.investorFit || "Not assessed"} ·{" "}
        <strong>Verification:</strong>{" "}
        {data.investorVerification || "Incomplete"}
      </p>
      <p className="muted small">
        Promising fit is a sourced research judgment. Fully verified means every
        research check is supported; neither establishes investment interest or
        legal eligibility.
      </p>
      {error && <p role="alert">{error}</p>}
      {assessments.map((a) => (
        <div key={a.dataset_id}>
          <p className="muted small">
            Your private research · {a.dataset_name}
          </p>
          {a.fit && <p>{a.fit.rationale}</p>}
          <h4>
            {a.missingEvidence.length
              ? "Still to confirm"
              : "Research checks complete"}
          </h4>
          <ul>
            {a.missingEvidence.map((g) => (
              <li key={g.key}>
                {g.label}
                {g.status === "contradicted"
                  ? " — conflicting evidence"
                  : " — not yet established"}
              </li>
            ))}
          </ul>
          <details>
            <summary>Evidence and review dates</summary>
            {a.fit && (
              <p>
                Fit reviewed: {new Date(a.fit.reviewedAt).toLocaleDateString()}
              </p>
            )}
            {a.qualification && (
              <p>
                Verification reviewed:{" "}
                {new Date(a.qualification.reviewedAt).toLocaleDateString()}
              </p>
            )}
            {[
              ...(a.fit?.sources || []),
              ...(a.qualification?.sources || []),
            ].map((s, i) => (
              <p key={i}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {new URL(s.url).hostname}
                </a>
                <br />
                {s.quote}
              </p>
            ))}
          </details>
        </div>
      ))}
    </section>
  );
}
