"use client";
import { useId } from "react";
import {
  contactTypes,
  contactHref,
  type ContactMethod,
  type ContactType,
} from "@/lib/contact-methods";

export function ContactMethodsEditor({
  value = [],
  onChange,
}: {
  value?: ContactMethod[];
  onChange: (value: ContactMethod[]) => void;
}) {
  const id = useId();
  const update = (index: number, change: Partial<ContactMethod>) =>
    onChange(
      value.map((contact, i) =>
        i === index ? { ...contact, ...change } : contact,
      ),
    );
  return (
    <section className="record-section contact-methods">
      <div className="contact-methods-heading">
        <div>
          <h3>Additional contact details</h3>
          <p className="muted small">
            Add work or personal contact details, social profiles, and postal
            addresses.
          </p>
        </div>
        <button
          className="button"
          type="button"
          disabled={value.length >= 20}
          onClick={() =>
            onChange([...value, { type: "phone", label: "", value: "" }])
          }
        >
          Add contact field
        </button>
      </div>
      {value.map((contact, index) => (
        <div
          className="contact-method-row"
          key={index}
          role="group"
          aria-label={`Contact field ${index + 1}`}
        >
          <label htmlFor={`${id}-${index}-type`}>
            Contact type
            <select
              aria-label="Contact type"
              id={`${id}-${index}-type`}
              value={contact.type}
              onChange={(e) =>
                update(index, { type: e.target.value as ContactType })
              }
            >
              {Object.entries(contactTypes).map(([type, label]) => (
                <option value={type} key={type}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-${index}-label`}>
            <span>
              Label <span className="muted">(optional)</span>
            </span>
            <input
              id={`${id}-${index}-label`}
              maxLength={80}
              placeholder="e.g. Work, Personal"
              value={contact.label}
              onChange={(e) => update(index, { label: e.target.value })}
            />
          </label>
          <label
            className="contact-method-value"
            htmlFor={`${id}-${index}-value`}
          >
            {contactTypes[contact.type]}
            {contact.type === "address" ? (
              <textarea
                id={`${id}-${index}-value`}
                required
                maxLength={1000}
                rows={3}
                value={contact.value}
                onChange={(e) => update(index, { value: e.target.value })}
              />
            ) : (
              <input
                id={`${id}-${index}-value`}
                required
                maxLength={contact.type === "phone" ? 80 : 1000}
                type={
                  contact.type === "email"
                    ? "email"
                    : contact.type === "phone"
                      ? "tel"
                      : "url"
                }
                placeholder={
                  contact.type === "linkedin"
                    ? "https://www.linkedin.com/in/…"
                    : contact.type === "x"
                      ? "https://x.com/…"
                      : undefined
                }
                value={contact.value}
                onChange={(e) => update(index, { value: e.target.value })}
              />
            )}
          </label>
          <button
            className="button contact-method-remove"
            type="button"
            aria-label={`Remove contact field ${index + 1}`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      {value.length >= 20 && (
        <p className="muted small">Maximum of 20 additional contact fields.</p>
      )}
    </section>
  );
}
export function ContactMethodsProfile({ value }: { value?: ContactMethod[] }) {
  if (!value?.length) return null;
  return (
    <section className="record-section">
      <h3>Additional contact details</h3>
      <dl className="record-profile">
        {value.map((contact, index) => {
          const href = contactHref(contact);
          const external = href?.startsWith("http");
          return (
            <div key={index}>
              <dt>
                {contactTypes[contact.type]}
                {contact.label ? ` · ${contact.label}` : ""}
              </dt>
              <dd className="contact-method-display">
                {href ? (
                  <a
                    href={href}
                    target={external ? "_blank" : undefined}
                    rel={external ? "noopener noreferrer" : undefined}
                  >
                    {contact.value}
                  </a>
                ) : (
                  contact.value
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
