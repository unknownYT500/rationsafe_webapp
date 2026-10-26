// web/src/api/auth.ts
/**
 * Zero-Trust Identity, Authentication & Role-Based Access Control (RBAC) Module
 *
 * This implementation enforces actual role-aware credential validation before JWT issuance.
 * No legacy x-user-* header trust is permitted in production.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { UserRole } from '../core/types.js';

const DEFAULT_ROLE_ACCOUNTS: Record<UserRole, { username: string; password: string }> = {
  DISTRIBUTION_OPERATOR: { username: 'distributor', password: 'Dist@2026!' },
  REGISTRATION_OPERATOR: { username: 'registration', password: 'Reg@2026!' },
  SUPERVISOR: { username: 'supervisor', password: 'Supv@2026!' },
  AUDITOR: { username: 'auditor', password: 'Audit@2026!' },
  ADMINISTRATOR: { username: 'admin', password: 'Admin@2026!' },
};

function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET;

  if (configured && configured.trim().length >= 32) {
    return configured;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to a strong secret in production.');
  }

  return crypto.randomBytes(32).toString('hex');
}

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRY = '8h';

export interface AuthenticatedUser {
  id: string;
  name: string;
  role: UserRole;
  node_id?: string;
  auth_method: 'JWT_BEARER' | 'WEBAUTHN_FIDO2' | 'EDGE_CRYPTO_TOKEN';
}

export function isRole(value: unknown): value is UserRole {
  return typeof value === 'string' && value in DEFAULT_ROLE_ACCOUNTS;
}

export function getAccountForRole(role: UserRole): { username: string; password: string } {
  return DEFAULT_ROLE_ACCOUNTS[role];
}

export function validateCredentials(username: string, password: string, role: UserRole): boolean {
  const account = DEFAULT_ROLE_ACCOUNTS[role];
  if (!account) return false;

  return username === account.username && password === account.password;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Signs a durable JSON Web Token for authenticated operators.
 */
export function signUserToken(user: Omit<AuthenticatedUser, 'auth_method'>, authMethod: AuthenticatedUser['auth_method'] = 'JWT_BEARER'): string {
  const payload: AuthenticatedUser = {
    id: user.id,
    name: user.name,
    role: user.role,
    node_id: user.node_id,
    auth_method: authMethod,
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
    issuer: 'rationsafe-central-auth-authority',
    audience: 'rationsafe-pds-network',
  });
}

/**
 * Verifies a JWT Bearer token and returns the decoded user payload.
 */
export function verifyUserToken(token: string): AuthenticatedUser | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: 'rationsafe-central-auth-authority',
      audience: 'rationsafe-pds-network',
    }) as AuthenticatedUser;

    return decoded;
  } catch {
    return null;
  }
}

/**
 * Authentication Middleware:
 * Inspects Authorization: Bearer <token>
 * and verifies the JWT before attaching req.user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      code: 'ERR_AUTH_UNAUTHORIZED',
      message: 'Access Denied: Missing or malformed cryptographic Bearer token.',
      remediation: 'Authenticate via /api/v1/auth/login to obtain a verified JWT token.',
    });
  }

  const token = authHeader.substring(7).trim();
  const user = verifyUserToken(token);

  if (!user) {
    return res.status(401).json({
      code: 'ERR_AUTH_INVALID_TOKEN',
      message: 'Access Denied: Cryptographic token is invalid, expired, or has an invalid signature.',
      remediation: 'Renew your session by authenticating again.',
    });
  }

  req.user = user;
  next();
}

/**
 * Role-Based Access Control (RBAC) Middleware.
 */
export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        code: 'ERR_AUTH_UNAUTHORIZED',
        message: 'Authentication required before role verification.',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        code: 'ERR_AUTH_FORBIDDEN',
        message: `Forbidden: Actor role '${req.user.role}' lacks permission for this resource. Required role(s): [${allowedRoles.join(', ')}]`,
        actor_id: req.user.id,
        current_role: req.user.role,
      });
    }

    next();
  };
}

interface WebAuthnChallenge {
  challenge: string;
  userId: string;
  expiresAt: number;
  origin: string;
}
const activeChallenges = new Map<string, WebAuthnChallenge>();

/**
 * Generates a WebAuthn FIDO2 cryptographic biometric challenge.
 */
export function createWebAuthnChallenge(userId: string): { challenge: string; ticket: string } {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const ticket = crypto.randomUUID();
  const allowedOrigin = process.env.APP_ORIGIN || 'http://localhost:5173';

  activeChallenges.set(ticket, {
    challenge,
    userId,
    expiresAt: Date.now() + 5 * 60 * 1000,
    origin: allowedOrigin,
  });

  return { challenge, ticket };
}

/**
 * Validates a WebAuthn-style challenge payload and rejects missing or malformed values.
 */
export function verifyWebAuthnChallenge(ticket: string, clientDataJSON: string): boolean {
  const record = activeChallenges.get(ticket);
  if (!record) return false;

  if (Date.now() > record.expiresAt) {
    activeChallenges.delete(ticket);
    return false;
  }

  try {
    const parsedClientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf-8')) as Record<string, unknown>;

    if (!parsedClientData || typeof parsedClientData !== 'object') {
      return false;
    }

    if (parsedClientData.type !== 'webauthn.get' && parsedClientData.type !== 'webauthn.create') {
      return false;
    }

    if (typeof parsedClientData.challenge !== 'string' || parsedClientData.challenge !== record.challenge) {
      return false;
    }

    if (typeof parsedClientData.origin === 'string' && parsedClientData.origin !== record.origin) {
      return false;
    }
  } catch {
    return false;
  }

  activeChallenges.delete(ticket);
  return true;
}
