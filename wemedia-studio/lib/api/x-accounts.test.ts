import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createXCredentialAccount,
  deleteXCredentialAccount,
  listXCredentialAccounts,
  patchXCredentialAccount,
  testXCredentialAccount,
  type XCredentialAccount,
  type XCredentialPool,
} from './x-accounts'

const poolFixture: XCredentialPool = {
  accounts: [{
    id: 7,
    name: '采集账号 A',
    enabled: true,
    auth_token_preview: '…auth',
    ct0_preview: '…csrf',
    test_status: 'untested',
    last_tested_at: null,
    last_test_error: '',
    created_at: '2026-07-25T13:00:00Z',
    updated_at: '2026-07-25T13:00:00Z',
  }],
  external_sessions: ['twitter.json'],
  managed_enabled: 1,
  total_accounts: 2,
  available_accounts: 2,
}

const jsonResponse = (value: unknown) => new Response(
  JSON.stringify(value),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)

describe('X credential account API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the X credential account pool', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(poolFixture))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listXCredentialAccounts()).resolves.toEqual(poolFixture)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/x/accounts',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('creates, updates, tests, and deletes X credential accounts', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(poolFixture))
    vi.stubGlobal('fetch', fetchMock)

    await createXCredentialAccount({
      name: '采集账号 A',
      auth_token: 'auth',
      ct0: 'csrf',
      enabled: true,
    })
    await patchXCredentialAccount(7, { enabled: false })
    await testXCredentialAccount(7)
    await deleteXCredentialAccount(7)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8000/api/x/accounts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '采集账号 A',
          auth_token: 'auth',
          ct0: 'csrf',
          enabled: true,
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000/api/x/accounts/7',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:8000/api/x/accounts/7/test',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://localhost:8000/api/x/accounts/7',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('does not define raw credentials or credential slots on returned accounts', () => {
    const account: XCredentialAccount = poolFixture.accounts[0]

    expect('auth_token' in account).toBe(false)
    expect('ct0' in account).toBe(false)
    expect('credential_slot' in account).toBe(false)
  })
})
