// Runtime schemas for every Cloudways API response CloudwaysSync
// consumes. Validated with zod at the ApiClient boundary so the rest
// of the code can work with fully-typed structures.
//
// NOTE on field coercion: Cloudways v2 frequently returns numeric IDs
// as strings (e.g. `"server_id": "12345"`). We coerce to number on the
// way in so the app-layer types stay clean.

import { z } from 'zod';

// ---- OAuth ----
export const OAuthTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
  token_type: z.string().default('Bearer'),
});
export type OAuthToken = z.infer<typeof OAuthTokenSchema>;

// ---- Apps nested in a server ----
export const AppSchema = z.object({
  id: z.coerce.number().int().positive(),
  label: z.string(),
  application: z.string(), // e.g. 'wordpress', 'phpstack'
  app_version: z.string().optional(),
  app_fqdn: z.string().optional(),
  app_user: z.string().optional(),
  sys_user: z.string().optional(),
  cname: z.string().nullish(),
  mysql_db_name: z.string().optional(),
  mysql_user: z.string().optional(),
  created_at: z.string().optional(),
});
export type App = z.infer<typeof AppSchema>;

// ---- Server ----
export const ServerSchema = z.object({
  id: z.coerce.number().int().positive(),
  label: z.string(),
  cloud: z.string(), // 'do', 'vultr', 'aws', 'linode', 'gce'
  region: z.string().optional(),
  size: z.string().optional(),
  public_ip: z.string().optional(),
  server_fqdn: z.string().optional(),
  master_user: z.string().optional(),
  status: z.string().optional(),
  platform: z.string().optional(),
  apps: z.array(AppSchema).default([]),
});
export type Server = z.infer<typeof ServerSchema>;

export const ServersResponseSchema = z.object({
  servers: z.array(ServerSchema),
});
export type ServersResponse = z.infer<typeof ServersResponseSchema>;

// ---- App credentials (SFTP + DB) ----
// Cloudways exposes app credentials via `GET /app/creds`. The API
// returns the system password as `sys_password`; we normalize it to
// `password` at the boundary so the rest of the app has one shape.
export const AppCredentialSchema = z
  .object({
    id: z.coerce.number().int(),
    sys_user: z.string(),
    ssh_keys: z.array(z.unknown()).optional(),
    sys_password: z.string().optional(),
    password: z.string().optional(),
  })
  .transform(({ sys_password, password, ...rest }) => ({
    ...rest,
    password: password ?? sys_password,
  }));
export type AppCredential = z.infer<typeof AppCredentialSchema>;

export const AppCredsResponseSchema = z.object({
  app_creds: z.array(AppCredentialSchema),
});
export type AppCredsResponse = z.infer<typeof AppCredsResponseSchema>;

// ---- Operation polling ----
// Cloudways async endpoints return `{ operation_id }`, which we then
// poll via `GET /operation/<operation_id>`. Some completed operations
// omit `status` and only return `is_completed`.
export const OperationTriggerResponseSchema = z.object({
  status: z.boolean().optional(),
  operation_id: z.coerce.number().int().positive(),
});
export type OperationTriggerResponse = z.infer<typeof OperationTriggerResponseSchema>;

export const OperationStatusSchema = z.enum([
  'Process Queued',
  'Processing',
  'Completed',
  'Failed',
  'Cancelled',
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationSchema = z.object({
  id: z.coerce.number().int(),
  type: z.string().optional(),
  status: OperationStatusSchema.or(z.string()).optional(), // tolerate unseen values and missing completed status
  is_completed: z.union([z.boolean(), z.coerce.number()]).optional(),
  message: z.string().optional(),
  parameters: z.string().optional(),
  estimated_time_remaining: z.coerce.number().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

export const OperationResponseSchema = z.object({
  operation: OperationSchema,
});
export type OperationResponse = z.infer<typeof OperationResponseSchema>;

// A trigger response may embed the operation inline instead of a bare id.
export const BackupTriggerResponseSchema = z.union([
  OperationTriggerResponseSchema,
  z.object({ operation: OperationSchema }),
]);
export type BackupTriggerResponse = z.infer<typeof BackupTriggerResponseSchema>;

// ---- Useful narrow helpers ----
export function isTerminalOperation(op: Operation): boolean {
  return op.status === 'Completed' || op.status === 'Failed' || op.status === 'Cancelled' || op.is_completed === true || op.is_completed === 1;
}

export function isSuccessfulOperation(op: Operation): boolean {
  if (op.status === 'Failed' || op.status === 'Cancelled') return false;
  return op.status === 'Completed' || op.is_completed === true || op.is_completed === 1;
}
