export { inventorySource, dependencyGraph, MigrationError, KIT_VERSION } from './inventory.js';
export type { MigrationInventory, SourceFile, Package, Dependency, Finding } from './inventory.js';
export { runMigrationCommand } from './cli.js';
export { INVENTORY_SCHEMA } from './schema.js';
export { VERIFICATION_SCHEMAS, EVIDENCE_REVIEW_SCHEMA } from './schema.js';
export { analyzeVerificationPlan, verifyMigration, compareBehavior, comparatorHealthy, behaviorFingerprint, byteFingerprint, VERIFIER_VERSION, VERIFICATION_ADAPTER } from './verification.js';
export type { VerificationPlan, VerificationOptions, BehaviorFingerprint, ExpectedBehavior } from './verification.js';
export { migrationExample } from './example.js';
export { analyzeVerificationEvidence } from './evidence.js';
