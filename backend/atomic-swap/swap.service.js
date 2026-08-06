import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import logger from '../api/src/middleware/logger.js';
import { supabase } from '../api/src/config/db.js';

class AtomicSwapService {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
        this.swapAddress = process.env.ATOMIC_SWAP_ADDRESS;

        this.swapABI = [
            'function openSwap(bytes32 swapId, address payable recipient, bytes32 hashLock, uint256 lockDuration) external payable returns (bytes32)',
            'function claimSwap(bytes32 swapId, bytes calldata preimage) external',
            'function refundSwap(bytes32 swapId) external',
            'function swaps(bytes32) external view returns (tuple(address,address,uint256,bytes32,uint256,bool,bool,bool))',
            'function getUserSwaps(address user) external view returns (tuple(bytes32,bool)[])'
        ];

        this.swap = new ethers.Contract(this.swapAddress, this.swapABI, this.wallet);

        logger.info('✅ Atomic Swap Service initialized');
    }

    // ============ Hash Lock Generation ============

    // Generate a unique bytes32 swap id for the caller-provided swapId
    // parameter of openSwap(). The previously used getSwapCount()/
    // getCrossChainSwapCount() are not part of the ABI.
    generateSwapId(secret) {
        return ethers.keccak256(ethers.toUtf8Bytes(`${secret}:${uuidv4()}`));
    }

    generateHashLock(secret) {
        return ethers.keccak256(ethers.toUtf8Bytes(secret));
    }

    generateSecret() {
        return '0x' + crypto.randomBytes(32).toString('hex');
    }

    // ============ Swap Operations ============

    async createSwap(counterparty, tokenAddress, amount, secret) {
        try {
            const hashLock = this.generateHashLock(secret);
            const parsedAmount = ethers.parseEther(amount.toString());
            const swapId = this.generateSwapId(secret);
            const lockDuration = Number(process.env.ATOMIC_SWAP_LOCK_DURATION) || 86400;

            const tx = await this.swap.openSwap(
                swapId,
                counterparty,
                hashLock,
                lockDuration,
                {
                    value: parsedAmount,
                    gasLimit: 300000
                }
            );
            const receipt = await tx.wait();

            await this.storeSwap({
                swapId,
                initiator: this.wallet.address,
                counterparty,
                tokenAddress,
                amount,
                hashLock,
                secret,
                txHash: receipt.hash
            });

            logger.info(`✅ Swap created: ${swapId}`);
            return {
                success: true,
                swapId: swapId.toString(),
                hashLock,
                secret,
                txHash: receipt.hash
            };
        } catch (error) {
            logger.error('Swap creation failed:', error);
            throw error;
        }
    }

    async executeSwap(swapId, secret) {
    try {
        const tx = await this.swap.claimSwap(swapId, ethers.toUtf8Bytes(secret), {
            gasLimit: 150000
        });
            const receipt = await tx.wait();

            await this.updateSwapStatus(swapId, 'executed', receipt.hash);

            logger.info(`✅ Swap executed: ${swapId}`);
            return {
                success: true,
                swapId,
                txHash: receipt.hash
            };
        } catch (error) {
            logger.error('Swap execution failed:', error);
            throw error;
        }
    }

    async refundSwap(swapId) {
        try {
            const tx = await this.swap.refundSwap(swapId, {
                gasLimit: 150000
            });
            const receipt = await tx.wait();

            await this.updateSwapStatus(swapId, 'refunded', receipt.hash);

            logger.info(`✅ Swap refunded: ${swapId}`);
            return {
                success: true,
                swapId,
                txHash: receipt.hash
            };
        } catch (error) {
            logger.error('Swap refund failed:', error);
            throw error;
        }
    }

    // ============ View Functions ============

    async getSwap(swapId) {
        try {
            const swap = await this.swap.swaps(swapId);
            return {
                id: swapId,
                initiator: swap[0],
                counterparty: swap[1],
                amount: ethers.formatEther(swap[2]),
                hashLock: swap[3],
                timelock: swap[4].toString(),
                claimed: swap[5],
                refunded: swap[6],
                isCrossChain: swap[7]
            };
        } catch (error) {
            logger.error('Swap fetch failed:', error);
            return null;
        }
    }

    // ============ Database Operations ============

    async storeSwap(data) {
        const { error } = await supabase
            .from('atomic_swaps')
            .insert([{
                swap_id: data.swapId,
                initiator: data.initiator,
                counterparty: data.counterparty,
                token_address: data.tokenAddress,
                amount: data.amount,
                hash_lock: data.hashLock,
                secret: data.secret,
                tx_hash: data.txHash,
                status: 'pending',
                created_at: new Date().toISOString()
            }]);
        if (error) throw error;
    }

    async updateSwapStatus(swapId, status, txHash) {
        const { error } = await supabase
            .from('atomic_swaps')
            .update({
                status,
                executed_tx_hash: txHash,
                executed_at: new Date().toISOString()
            })
            .eq('swap_id', swapId);
        if (error) throw error;
    }

    // ============ Statistics ============

    async getSwapStats() {
        try {
            const { data: swaps } = await supabase
                .from('atomic_swaps')
                .select('*');

            return {
                totalSwaps: swaps?.length || 0,
                executedSwaps: swaps?.filter(s => s.status === 'executed').length || 0,
                pendingSwaps: swaps?.filter(s => s.status === 'pending').length || 0,
                refundedSwaps: swaps?.filter(s => s.status === 'refunded').length || 0,
                totalVolume: swaps?.reduce((sum, s) => sum + parseFloat(s.amount || 0), 0) || 0,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            logger.error('Stats fetch failed:', error);
            return null;
        }
    }
}

export default new AtomicSwapService();