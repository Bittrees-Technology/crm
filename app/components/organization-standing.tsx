import type { CrmRecord } from "@/lib/model";
import { standingFor, standingLabels } from "@/lib/organization-standing-model";
export function OrganizationStandingProfile({
  record,
  records,
  onOpen,
}: {
  record: CrmRecord;
  records: CrmRecord[];
  onOpen?: (record: CrmRecord) => void;
}) {
  const review = standingFor(record, records);
  if (!review) return null;
  const { organization, assessment: a } = review;
  return (
    <section
      className="record-section organization-standing"
      aria-label="Organization standing"
    >
      <h3>Organization standing</h3>
      {record.kind === "people" && (
        <p>
          Assessment of the linked organization:{" "}
          <button
            className="text-button"
            onClick={() => onOpen?.(organization)}
          >
            {organization.data.name}
          </button>
          . This does not rate the person.
        </p>
      )}
      <p>
        <strong>
          {a.tier} · {standingLabels[a.tier]}
        </strong>{" "}
        · {a.confidence} confidence
      </p>
      <p className="muted small">
        Provisional analyst judgment · Reviewed{" "}
        {new Date(a.reviewedAt).toLocaleDateString()}. Unrated does not mean
        poor quality. Investment performance, available capital and eligibility
        are unverified.
      </p>
      <p>{a.rationale}</p>
      <p>
        <strong>Bittrees theme fit:</strong> {a.themeFit}. {a.fitBasis}
      </p>
      <p className="muted small">{a.fitStatus}</p>
      <p>
        <strong>Review queue:</strong> {a.reviewQueue}
      </p>
      {!!a.flags.length && (
        <ul>
          {a.flags.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>Sources and evidence dates ({a.sources.length})</summary>
        {!a.sources.length && (
          <p>No adequate sources retained; further research required.</p>
        )}
        {a.sources.map((s, i) => (
          <p key={i}>
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.url}
            </a>
            <br />
            Retrieved{" "}
            {s.retrievedAt
              ? new Date(s.retrievedAt).toLocaleDateString()
              : "date unavailable"}{" "}
            · {s.basis}
            {s.claim && (
              <>
                <br />
                {s.claim}
              </>
            )}
          </p>
        ))}
      </details>
    </section>
  );
}
