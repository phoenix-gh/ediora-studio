import { apiFetch } from './client'

export type XCredentialTestStatus =
  | 'untested'
  | 'available'
  | 'expired'
  | 'rate_limited'
  | 'failed'

export interface XCredentialAccount {
  id: number
  name: string
  enabled: boolean
  auth_token_preview: string
  ct0_preview: string
  test_status: XCredentialTestStatus
  last_tested_at: string | null
  last_test_error: string
  created_at: string
  updated_at: string
}

export interface XCredentialPool {
  accounts: XCredentialAccount[]
  external_sessions: string[]
  managed_enabled: number
  total_accounts: number
  available_accounts: number
}

export interface CreateXCredentialAccountInput {
  name: string
  auth_token: string
  ct0: string
  enabled?: boolean
}

export interface PatchXCredentialAccountInput {
  name?: string
  enabled?: boolean
  auth_token?: string
  ct0?: string
}

export function listXCredentialAccounts(): Promise<XCredentialPool> {
  return apiFetch<XCredentialPool>('/x/accounts')
}

export function createXCredentialAccount(
  input: CreateXCredentialAccountInput,
): Promise<XCredentialPool> {
  return apiFetch<XCredentialPool>('/x/accounts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function patchXCredentialAccount(
  id: number,
  input: PatchXCredentialAccountInput,
): Promise<XCredentialPool> {
  return apiFetch<XCredentialPool>(`/x/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function deleteXCredentialAccount(id: number): Promise<XCredentialPool> {
  return apiFetch<XCredentialPool>(`/x/accounts/${id}`, { method: 'DELETE' })
}

export function testXCredentialAccount(id: number): Promise<XCredentialPool> {
  return apiFetch<XCredentialPool>(`/x/accounts/${id}/test`, { method: 'POST' })
}
