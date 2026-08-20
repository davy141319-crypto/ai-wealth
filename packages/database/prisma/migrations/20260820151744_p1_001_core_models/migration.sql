-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('ETH', 'BSC', 'TRON', 'POLYGON', 'ARBITRUM');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "IdentityType" AS ENUM ('SIWE', 'MESSAGE_SIGNATURE');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SystemConfigValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "address" VARCHAR(64) NOT NULL,
    "chain" "Chain" NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "status" "WalletStatus" NOT NULL DEFAULT 'CONNECTED',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_identities" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "identity_type" "IdentityType" NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_nonces" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "nonce" VARCHAR(64) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" VARCHAR(128) NOT NULL,
    "resource" VARCHAR(128) NOT NULL,
    "request_id" VARCHAR(64),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "request_hash" VARCHAR(64),
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PENDING',
    "response_code" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_configs" (
    "id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "SystemConfigValueType" NOT NULL DEFAULT 'STRING',
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_user_id_idx" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_address_chain_network_uq" ON "wallets"("address", "chain", "network");

-- CreateIndex
CREATE INDEX "wallet_identity_wallet_idx" ON "wallet_identities"("wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_identity_wallet_type_uq" ON "wallet_identities"("wallet_id", "identity_type");

-- CreateIndex
CREATE UNIQUE INDEX "auth_nonce_nonce_uq" ON "auth_nonces"("nonce");

-- CreateIndex
CREATE INDEX "auth_nonce_wallet_idx" ON "auth_nonces"("wallet_id");

-- CreateIndex
CREATE INDEX "auth_nonce_expires_idx" ON "auth_nonces"("expires_at");

-- CreateIndex
CREATE INDEX "auth_nonce_used_idx" ON "auth_nonces"("used_at");

-- CreateIndex
CREATE INDEX "audit_actor_idx" ON "audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_resource_idx" ON "audit_logs"("resource");

-- CreateIndex
CREATE INDEX "audit_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_request_id_idx" ON "audit_logs"("request_id");

-- CreateIndex
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_status_idx" ON "idempotency_keys"("status");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_scope_key_uq" ON "idempotency_keys"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_key_uq" ON "system_configs"("key");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_identities" ADD CONSTRAINT "wallet_identities_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_nonces" ADD CONSTRAINT "auth_nonces_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
