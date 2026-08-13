/**
 * Unit tests for verifyOnChainEscrowBalance() exact-equality semantics
 * in backend/api/src/services/escrow.js — covers issue #11217.
 *
 * The balance check must agree with recordDepositTx/escrowRelease, which
 * reject any deposit that differs from the expected escrow amount (exact
 * match). A booking whose on-chain amount is greater than expected must
 * therefore report valid: false.
 *
 * Mocks ethers so escrowContract is initialised, letting us reach the
 * on-chain balance branch inside verifyOnChainEscrowBalance().
 *
 * Run with: npm test -- test/unit/escrowBalanceVerification.test.js
 */
import { describe, it, expect, vi, afterAll } from 'vitest'

const mockBookings = vi.fn()

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: vi.fn(function () { return {} }),
      Wallet: vi.fn(function () { return {} }),
      Contract: vi.fn(function () {
        return {
          bookings: mockBookings,
        }
      }),
    },
  }
})

const CONTRACT_ADDRESS = '0x' + 'c'.repeat(40)
const oldRpc = process.env.POLYGON_RPC_URL
const oldAddr = process.env.ESCROW_CONTRACT_ADDRESS
const oldKey = process.env.RELAYER_WALLET_PRIVATE_KEY

process.env.POLYGON_RPC_URL = 'http://localhost:8545'
process.env.ESCROW_CONTRACT_ADDRESS = CONTRACT_ADDRESS
process.env.RELAYER_WALLET_PRIVATE_KEY = '0x' + '1'.repeat(64)

const { verifyOnChainEscrowBalance } = await import('../../src/services/escrow.js')

afterAll(() => {
  if (oldRpc !== undefined) process.env.POLYGON_RPC_URL = oldRpc
  else delete process.env.POLYGON_RPC_URL
  if (oldAddr !== undefined) process.env.ESCROW_CONTRACT_ADDRESS = oldAddr
  else delete process.env.ESCROW_CONTRACT_ADDRESS
  if (oldKey !== undefined) process.env.RELAYER_WALLET_PRIVATE_KEY = oldKey
  else delete process.env.RELAYER_WALLET_PRIVATE_KEY
})

describe('verifyOnChainEscrowBalance() — exact equality', () => {
  const bookingId = 42n

  beforeEach(() => {
    mockBookings.mockReset()
  })

  it('returns valid:true when the on-chain amount equals the expected amount', async () => {
    mockBookings.mockResolvedValue({ amount: 100n })
    const result = await verifyOnChainEscrowBalance(bookingId, '100')
    expect(result.valid).toBe(true)
    expect(result.onChainAmount).toBe('100')
    expect(result.expectedAmount).toBe('100')
  })

  it('returns valid:false when the on-chain amount is greater than expected (over-deposit)', async () => {
    mockBookings.mockResolvedValue({ amount: 1000n })
    const result = await verifyOnChainEscrowBalance(bookingId, '100')
    expect(result.valid).toBe(false)
    expect(result.onChainAmount).toBe('1000')
    expect(result.expectedAmount).toBe('100')
  })

  it('returns valid:false when the on-chain amount is less than expected (under-deposit)', async () => {
    mockBookings.mockResolvedValue({ amount: 1n })
    const result = await verifyOnChainEscrowBalance(bookingId, '100')
    expect(result.valid).toBe(false)
    expect(result.onChainAmount).toBe('1')
    expect(result.expectedAmount).toBe('100')
  })
})
