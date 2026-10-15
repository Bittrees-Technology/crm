import React, { useId } from 'react';
import './login.css';

/** Shared presentation only. Each app supplies its own authentication handlers. */
export function LoginPanel({ product, title = 'Sign in', description = 'Use your email address or Ethereum wallet.', email, wallet, notice, footer, children }) {
  const heading = useId();
  return <section className="bt-login-panel" aria-labelledby={heading}>
    <div className="bt-login-brand"><svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M14 24V12m0 7L6 11m8 4 8-8M14 12V4M6 11V5m0 6H2m20-4V3m0 4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg><span>bittrees <strong>{product}</strong></span></div>
    <h2 id={heading} className="bt-login-title">{title}</h2>
    <p className="bt-login-description">{description}</p>
    {children}
    {email && <div className="bt-login-email">{email}</div>}
    {email && wallet && <div className="bt-login-divider"><span>or</span></div>}
    {wallet && <div className="bt-login-wallet">{wallet}</div>}
    {notice && <div className="bt-login-notice">{notice}</div>}
    <div className="bt-login-footer"><p>Wallet sign-in verifies ownership. It does not authorize a transaction.</p>{footer}</div>
  </section>;
}
