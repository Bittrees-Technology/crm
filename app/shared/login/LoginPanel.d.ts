import type { ReactNode, ReactElement } from 'react';
export type LoginPanelProps = {
  product: string;
  title?: string;
  description?: ReactNode;
  email?: ReactNode;
  wallet?: ReactNode;
  notice?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
};
export function LoginPanel(props: LoginPanelProps): ReactElement;
