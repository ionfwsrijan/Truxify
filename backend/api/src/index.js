import express from 'express'
import { corsMiddleware } from './middleware/cors.js'
import helmet from 'helmet' // 🔒 ADDED HELMET IMPORT FOR ISSUES #361 & #944
import http from 'http'
import dotenv from 'dotenv'
import hppProtection from './middleware/hppProtection.js';

import { globalLimiter, authLimiter, healthLimiter } from './middleware/rateLimiter.js'
import tripRoutes from './routes/tripRoutes.js'
import deviceRoutes from './routes/deviceRoutes.js'
import documentRoutes from './routes/documentRoutes.js'
import securityHeaderDuplicates from './middleware/securityHeaderDuplicates.js';
import maintenancePhotoRoutes from './routes/maintenancePhotoRoutes.js'

import { closeDbConnections, waitForMongoDb, validateConfig, redisClient } from './config/db.js'
import { orderRepository } from './core/container.js'
import { CacheManager } from './cache/CacheManager.js'
import { closeWebSocketServer, initWebSocketServer, __testing as wsTesting } from './sockets/tracker.js'
import { initLocationServer, closeLocationServer } from './sockets/locationServer.js'
import { startEscrowReleaseReconciliation, stopEscrowReleaseReconciliation } from './services/escrowReleaseReconciliation.js'
import { validateEscrowSetup } from './services/escrow.js'


import {
  requestIdMiddleware,
  requestLogger,
  securityHeaders,
  suspiciousRequests,
  responseSanitizer,
} from "./middleware/index.js";
// Load REST routes
import orderRoutes from './routes/orderRoutes.js'
import driverRoutes from './routes/driverRoutes.js'
import supportRoutes from './routes/supportRoutes.js'
import profileRoutes from './routes/profileRoutes.js'
import loadRoutes from './routes/loadRoutes.js'
import deadheadRoutes from './routes/deadheadRoutes.js'
import truckRoutes from './routes/truckRoutes.js'
import authRoutes from './routes/authRoutes.js'
import routeRoutes from './routes/routeRoutes.js'
import healthRoutes from './routes/healthRoutes.js'
import adminRoutes from './routes/adminRoutes.js'
import lookupRoutes from './routes/lookupRoutes.js'
import { getRoot, notFound } from './controllers/rootController.js'
import webhookRoutes from './routes/webhookRoutes.js'
import auditRoutes from './routes/auditRoutes.js'
import voiceRoutes from './routes/voiceRoutes.js'
import demandRoutes from './routes/demandRoutes.js'

// ============================================================================
// 🆕 MULTI-PROVIDER ORACLE & VERIFICATION ROUTES
// ============================================================================
import verificationRoutes from './routes/verificationRoutes.js'
import oracleRoutes from './routes/oracleRoutes.js'

// ============================================================================
// 🆕 GEOGRAPHIC SHARDING ROUTES
// ============================================================================
import trackingRoutes from './routes/trackingRoutes.js'
import publicTrackingRoutes from './routes/publicTrackingRoutes.js'
import shardRoutes from './routes/shardRoutes.js'
import shardManager from './services/sharding/ShardManager.js'


// ============================================================================
// 🆕 WEBRTC P2P MESH NETWORK ROUTES
// ============================================================================
import webrtcRoutes from './routes/webrtcRoutes.js'

// ============================================================================
// 🆕 ROOT SUBSYSTEM ROUTES (eBPF, WASI, WASM, Snyk, Liquibase)
// ============================================================================
import ebpfRoutes from '../../ebpf/routes.js'
import wasiRoutes from '../../wasi/routes.js'
import wasmRoutes from '../../wasm/routes.js'
import snykRoutes from '../../snyk/routes.js'
import liquibaseRoutes from '../../database/liquibase/routes.js'
import { initWebRTCSignaling, closeWebRTCSignaling } from './sockets/webrtc.js'

// ============================================================================
// 🆕 FRAUD DETECTION ROUTES
// ============================================================================
import fraudRoutes from './routes/fraudRoutes.js'
import { fraudDetectionMiddleware, networkAnalysisMiddleware } from './middleware/fraudMiddleware.js'
import fraudDetection from './services/fraud/FraudDetectionService.js'
import headerSizeMonitor from './middleware/headerSizeMonitor.js';

// ============================================================================
// 🆕 ZK-PROOFS FOR DRIVER KYC
// ============================================================================
import zkpRoutes from './routes/zkp.routes.js'


// ============================================================================
// 🆕 MULTI-CLOUD DISASTER RECOVERY
// ============================================================================
import drRoutes from '../../dr/routes.js'
import multiCloudService from '../../dr/multi-cloud.service.js'

// ============================================================================
// 🆕 OPENTELEMETRY DISTRIBUTED TRACING
// ============================================================================
import tracing from './tracing/tracing.js'
import { tracingMiddleware } from './middleware/tracingMiddleware.js'
import logger from './middleware/logger.js'
import { errorHandler } from './middleware/errorHandler.js'
import { setupSwagger } from './config/swagger.js'
import { correlationIdMiddleware } from './middleware/correlationId.js'
import { requestCacheMiddleware } from './middleware/requestCacheMiddleware.js'
import { requireJsonContent } from './middleware/contentType.js'
import { initSentry, flushSentry, sentryErrorHandler } from './middleware/sentry.js'
import {
  startEscrowRefundReconciliation,
  stopEscrowRefundReconciliation
} from './services/escrowRefundReconciliation.js'
import {
  startEscrowFundingReconciliation,
  stopEscrowFundingReconciliation
} from './services/escrowFundingReconciliation.js'
import {
  startReputationReconciliation,
  stopReputationReconciliation,
} from './services/reputationReconciliation.js'
import {
  startDocumentExpiryWorker,
  stopDocumentExpiryWorker,
} from './services/documentExpiryService.js'
import {
  startDlqWorker,
  stopDlqWorker,
} from './workers/dlqWorker.js'
import { startStaleOrderWorker } from './workers/staleOrderWorker.js'
import './subscribers/reputationSubscriber.js'

// Configuration load from root folder is handled in db.js

// ============================================================================
// 🆕 INITIALIZE OPENTELEMETRY TRACING
// ============================================================================
tracing.initialize('truxify-api')

initSentry()

// Validate required env vars at startup
try {
  validateConfig()
} catch (err) {
  logger.fatal(err.message)
  process.exit(1)
}

// ============================================================================
// INITIALIZE DISTRIBUTED CACHE MANAGER
// ============================================================================
CacheManager.init(redisClient)

// ============================================================================
// STARTUP VALIDATION — crash fast, not at request time
// ============================================================================
if (process.env.BYPASS_AUTH === 'true' && process.env.NODE_ENV !== 'development') {
  logger.fatal('BYPASS_AUTH is enabled outside development. This is a severe security misconfiguration. Set BYPASS_AUTH=false (or unset it), and set NODE_ENV=development if you need local testing.')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && !process.env.ML_API_KEY) {
  logger.fatal('ML_API_KEY is not set. ML engine calls will fail with 401 errors. Set ML_API_KEY and restart.')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && (!process.env.POLYGON_RPC_URL || !process.env.ESCROW_CONTRACT_ADDRESS || !process.env.RELAYER_WALLET_PRIVATE_KEY)) {
  logger.fatal('Escrow environment variables (POLYGON_RPC_URL, ESCROW_CONTRACT_ADDRESS, RELAYER_WALLET_PRIVATE_KEY) are not set. These are required in production for on-chain escrow protection. Set all three and restart.')
  process.exit(1)
}
if (!process.env.DRIVER_LOGIN_OTP) {
  logger.warn('DRIVER_LOGIN_OTP is not set. Driver OTP login will be disabled until it is configured in production.')
}

// ============================================================================
// 🆕 WEBHOOK VALIDATION
// ============================================================================
if (!process.env.WEBHOOK_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('WEBHOOK_SECRET is not set. POST /api/webhooks/escrow would fail closed and reject all incoming webhooks. Set WEBHOOK_SECRET and restart.')
    process.exit(1)
  } else {
    logger.warn('⚠️ WEBHOOK_SECRET is not set. Webhook requests will be rejected (fail-closed) until it is configured.')
  }
}

// ============================================================================
// 🆕 OTEL VALIDATION
// ============================================================================
if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  logger.warn('⚠️ OTEL_EXPORTER_OTLP_ENDPOINT not set. Using default: http://localhost:4317')
}

// ============================================================================
// 🆕 ORACLE VALIDATION
// ============================================================================
if (!process.env.ORACLE_CONSENSUS_THRESHOLD) {
  logger.warn('ORACLE_CONSENSUS_THRESHOLD not set, using default: 2')
}
if (!process.env.CHAINLINK_ENABLED && !process.env.BACKUP_ORACLE_ENABLED) {
  logger.warn('No oracle providers enabled. Set CHAINLINK_ENABLED=true or BACKUP_ORACLE_ENABLED=true')
}

// ============================================================================
// 🆕 SHARDING VALIDATION
// ============================================================================
if (!process.env.SHARD_NORTH_HOST || !process.env.SHARD_SOUTH_HOST || 
    !process.env.SHARD_EAST_HOST || !process.env.SHARD_WEST_HOST) {
  logger.warn('⚠️ Shard hosts not fully configured. Using localhost defaults.')
}

if (!process.env.SHARD_NORTH_PASSWORD || !process.env.SHARD_SOUTH_PASSWORD || 
    !process.env.SHARD_EAST_PASSWORD || !process.env.SHARD_WEST_PASSWORD) {
  logger.warn('⚠️ Shard passwords not fully configured. Ensure all SHARD_*_PASSWORD env vars are set.')
}


// ============================================================================
// 🆕 WEBRTC VALIDATION
// ============================================================================
if (!process.env.WEBRTC_ENABLED) {
  logger.info('WebRTC signaling server will start by default')
}

// ============================================================================
// 🆕 FRAUD DETECTION VALIDATION
// ============================================================================
if (!process.env.FRAUD_THRESHOLD) {
  logger.warn('FRAUD_THRESHOLD not set, using default: 0.7')
}
if (!process.env.BEHAVIORAL_ANALYTICS_ENABLED) {
  logger.info('Behavioral analytics enabled by default')
}


// ============================================================================
// 🆕 ZK-PROOFS VALIDATION
// ============================================================================
if (!process.env.KYC_VERIFIER_CONTRACT) {
  logger.warn('⚠️ KYC_VERIFIER_CONTRACT not set. ZK proof verification will not work.')
}
if (!process.env.PRIVATE_KEY) {
  logger.warn('⚠️ PRIVATE_KEY not set. Cannot sign ZK proof transactions.')
}



// ============================================================================
// 🆕 MULTI-CLOUD DR VALIDATION
// ============================================================================
if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_KEY) {
  logger.warn('⚠️ AWS credentials not set. Multi-cloud DR may not work.')
}
if (!process.env.AZURE_CONNECTION_STRING) {
  logger.warn('⚠️ Azure connection string not set. Multi-cloud DR may not work.')
}
if (!process.env.GCP_PROJECT_ID) {
  logger.warn('⚠️ GCP credentials not set. Multi-cloud DR may not work.')
}
if (!process.env.ACTIVE_CLOUD) {
  logger.warn('⚠️ ACTIVE_CLOUD not set. Using default: aws')
}


// Validate escrow contract deployment — log warning if validation fails,
// but don't crash (non-escrow functionality should still work).
validateEscrowSetup().then((valid) => {
  if (!valid) {
    logger.warn('⚠️ Escrow setup validation failed. On-chain escrow features may not work correctly.')
  }
}).catch(err => console.error(err))