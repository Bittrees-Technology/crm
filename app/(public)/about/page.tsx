import type { Metadata } from "next";
import styles from "./page.module.css";
export const metadata: Metadata = {
  title: "Bittrees CRM | Contacts, projects and follow-ups",
  alternates: { canonical: "/about" },
  robots: { index: process.env.VERCEL_ENV !== "preview", follow: true },
};
export default function About() {
  return (
    <main className={styles.page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "Bittrees CRM",
            url: "https://crm.bittrees.org/about",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            description:
              "Manage contacts, organizations, opportunities, projects, tasks, and notes with scoped sharing.",
            license:
              "https://github.com/Bittrees-Technology/crm/blob/main/LICENSE",
          }),
        }}
      />
      <header className={styles.header}>
        <a className={styles.brand} href="/about">
          <img src="/favicon.svg" alt="" width="36" height="36" />
          Bittrees CRM
        </a>
        <a href="/">Sign in</a>
      </header>
      <section className={styles.hero}>
        <h1>Keep relationships and work connected.</h1>
        <p>
          Manage contacts, organizations, opportunities, projects, tasks, and
          notes in a shared workspace.
        </p>
        <a className={styles.action} href="/">
          Open CRM
        </a>
        <p className={styles.caption}>
          Sign in with your email address or Ethereum wallet.
        </p>
      </section>
      <section className={styles.details} aria-label="CRM features">
        <article>
          <h2>Relationships and opportunities</h2>
          <p>
            Keep people and organizations alongside their opportunities,
            projects, tasks, and notes. Track opportunity stages, values, and
            next steps.
          </p>
        </article>
        <article>
          <h2>Sharing with clear access</h2>
          <p>
            Invite collaborators, scope their access, and inspect who can see
            records. Keep private notes alongside shared information.
          </p>
        </article>
        <article>
          <h2>Follow-ups and daily work</h2>
          <p>
            Review tasks and relationship activity. Configure daily email
            follow-ups around assigned work, accessible records, and upcoming
            dates.
          </p>
        </article>
      </section>
      <section className={styles.identity}>
        <h2>One account, linked sign-in methods</h2>
        <p>
          Link a verified email address and Ethereum wallet to the same account.
          Wallet sign-in uses a signed message and does not request a
          transaction.
        </p>
      </section>
      <footer className={styles.footer}>
        <span>Bittrees CRM</span>
        <a href="https://github.com/Bittrees-Technology/crm">
          Source code · MIT license
        </a>
        <a href="https://bittrees.org">Bittrees</a>
      </footer>
    </main>
  );
}
