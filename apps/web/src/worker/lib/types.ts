import type { AuthCoordinator } from '../index';

declare global {
  type CloudflareEnv = Env & {
    SESSION_SECRET: string;
    SESSION_SECRET_PREV?: string;
    ENROLL_SECRET: string;
    AUTH_COORDINATOR: DurableObjectNamespace<AuthCoordinator>;
  };
}

export {};

export interface SessionPayload {
  sub: string;
  label: string;
  sid: string;
  epoch: number;
  iat: number;
  exp: number;
}

export interface UserRow {
  id: string;
  label: string;
  mutation_epoch: number;
  created_at: number;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string | null;
  device_label: string | null;
  name: string | null;
  last_used_at: number | null;
  created_at: number;
}

export interface PasskeyInsert {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string | null;
  deviceLabel: string | null;
  name: string | null;
  createdAt: number;
}

export interface AuditInsert {
  actor: string | null;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface AuthVars {
  session?: SessionPayload;
  enrolMethod?: 'session' | 'bootstrap';
  requestId?: string;
  desktopBearer?: string;
}

export interface RegistrationResponseShape {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string };
  clientExtensionResults: {
    appid?: boolean;
    credProps?: { rk?: boolean };
    hmacCreateSecret?: boolean;
  };
}

export interface AuthenticationResponseShape {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: {
    appid?: boolean;
    credProps?: { rk?: boolean };
    hmacCreateSecret?: boolean;
  };
}
